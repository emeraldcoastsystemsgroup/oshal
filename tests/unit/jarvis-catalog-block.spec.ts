/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the unified-bot-strategy gap (operator report 2026-09-04): the live Jarvis turn carried NO app catalog, so the persona's baked specialist list was the model's whole world — a CRM-only deployment had a Jarvis that had never heard of its own CRM and answered "I don't have that data" about an app on the same box. Pins: buildCatalogBlock lists a dynamically discovered store app with its deep link, declares its authority over any baked-in list, stays bounded, and the turn assembly + persona actually use it (the two ends the block is useless without).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The turn-assembly case reads the prompt the MODEL was handed through a real authenticated /api/jarvis/ask turn, instead of regex-matching the router's source. The old form matched the first bracketed group after `const ctxBlocks = `, which stops at the first closing bracket - now an inner array literal in the artifact-selection branch - so it reported the catalog missing while the wiring was correct, and no source change could clear it. The source-text form also never proved the model received anything.
 */

import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Only model execution, the brain-selection reads and persistence are doubles: the context
// assembly under test is the shipped one, reached over real HTTP through the real router.
const executeBot = vi.hoisted(() => vi.fn());
vi.mock('@/app/routes/inline-bot-execution', () => ({ executeBotOrInline: executeBot }));
vi.mock('@/app/routes/connector-token-broker', () => ({ resolveBotCreds: vi.fn().mockResolvedValue({}) }));
vi.mock('@/app/routes/free-tier-rotation', () => ({
  resolveUserLlmConnection: vi.fn().mockResolvedValue(null), reportResolvedLlmFailure: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/features/user-model', () => ({
  withHavenContext: vi.fn(async (_pool: unknown, _sub: string, prompt: string) => prompt),
  learnFromExchange: vi.fn().mockResolvedValue(undefined),
}));
// PARTIAL mock: a factory that LISTS the barrel's exports goes red the moment the barrel grows one
// the spec never asked about.
vi.mock('@/shared/services/database', async (importOriginal) => ({
  ...await importOriginal<object>(),
  runRuntimeSchemaBootstrap: vi.fn().mockResolvedValue(undefined), buildOwnerRlsPolicyStatements: vi.fn().mockReturnValue([]),
}));

import { buildCatalogBlock, PLAN_DIRECTIVE_GUIDANCE } from '@/app/routes/jarvis-orchestrator';
import { buildOpenWorkBlock } from '@/app/routes/jarvis-task-store';
import { createJarvisRoutes, purgeJarvisAskJobsForOwner } from '@/app/routes/jarvis-routes';
import { createMemoryOnlyTaskStore } from '../helpers/jarvis-session-task-store';

const OWNER = 'auth0|catalog-block-owner';

/** Minimal AppContext double — the catalog path only reaches for ctx.pool.query. */
function ctxReturning(rows: Array<Record<string, unknown>>): never {
  return { pool: { query: async () => ({ rows }) } } as never;
}

function storeAppRow(name: string, selector: string, jarvisMode: string | null = null) {
  return {
    name,
    display_name: name,
    agent_id: '15000000-0000-0000-0000-000000000001',
    selector,
    jarvis_mode: jarvisMode,
  };
}

describe('Jarvis catalog block: the model sees the deployment it actually runs on', () => {
  it('lists a dynamically discovered store app with its key and deep link', async () => {
    const block = await buildCatalogBlock(ctxReturning([
      storeAppRow('intelligent-sales', "THIS IS THE USER'S CRM — pipeline, leads, opportunities."),
    ]));
    expect(block).toContain('intelligent-sales');
    expect(block).toContain('/cockpit/?app=intelligent-sales');
    expect(block).toContain('CRM');
  });

  it('declares its authority over any baked-in specialist list', async () => {
    // The persona once hardcoded the platform apps of one deployment. The block must state that
    // IT is the authoritative list, or a stale persona memory quietly wins again.
    const block = await buildCatalogBlock(ctxReturning([]));
    expect(block).toMatch(/supersedes any baked-in/i);
    expect(block).toMatch(/catalog keys/i);
    // Freshness: the first live verification produced confident STALE numbers read out of an old
    // OPEN WORK result. The block must say old task results never stand in for current data.
    expect(block).toMatch(/FRESHNESS/);
    expect(block).toMatch(/fresh handoff/i);
    // Third live iteration: Jarvis knew the app but still asked "need your go-ahead to refresh"
    // and led with the stale number. A read is not outward - the rule must command acting.
    expect(block).toMatch(/never ask permission/i);
  });

  it('tells Jarvis how to reach each mode: delegate = hand work, handoff = point with the link', async () => {
    const block = await buildCatalogBlock(ctxReturning([
      storeAppRow('crm-delegate', 'CRM app.', 'delegate'),
      storeAppRow('crm-handoff', 'CRM app.', null),
    ]));
    const delegateLine = block.split('\n').find((l) => l.includes('crm-delegate:'));
    const handoffLine = block.split('\n').find((l) => l.includes('crm-handoff:'));
    expect(delegateLine).toContain('hand work to it');
    expect(handoffLine).toContain('/cockpit/?app=crm-handoff');
  });

  it('stays bounded: long blurbs are trimmed on every line', async () => {
    const block = await buildCatalogBlock(ctxReturning([
      storeAppRow('wordy', 'X'.repeat(400)),
    ]));
    const line = block.split('\n').find((l) => l.includes('wordy:'));
    expect(line).toBeDefined();
    expect((line as string).length).toBeLessThan(300);
  });

  it('never blocks a turn: total failure degrades to the curated catalog, not a throw', async () => {
    const ctx = { pool: { query: async () => { throw new Error('db down'); } } } as never;
    const block = await buildCatalogBlock(ctx);
    // loadEffectiveRoutes degrades to the curated list on a DB error, so the block still exists.
    expect(typeof block).toBe('string');
    expect(block).toMatch(/ASSISTANT CATALOG/);
  });

  it('the live turn assembly hands the block to the MODEL, ahead of the plan guidance', async () => {
    // The catalog was fully built (surface chips, plan compiler) while the MODEL never received it
    // - the exact defect this guard exists for. So read what the model was actually handed: run a
    // real authenticated turn through the shipped router and assert on the prompt it executed with.
    // The plan directive tells the model to use "the catalog keys above", so order is load-bearing.
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const taskStore = createMemoryOnlyTaskStore();
    const ctx = {
      pool: { query }, orchestrator: { processMessage: vi.fn() }, taskStore,
      messageStore: { save: vi.fn(), getByTask: vi.fn().mockResolvedValue([]) },
      ticketService: {
        listTickets: vi.fn().mockResolvedValue([]), createTicket: vi.fn(), updateStatus: vi.fn(),
        openChatTicket: vi.fn().mockResolvedValue({ ticketId: 'catalog-block-chat' }),
      },
    };
    const auth: RequestHandler = (request, response, next) => {
      const sub = request.header('x-test-sub');
      if (!sub) { response.sendStatus(401); return; }
      (request as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub } };
      next();
    };
    executeBot.mockReset();
    executeBot.mockResolvedValue({ response: 'Hello.' });
    const app = express();
    app.use(express.json());
    app.use('/api/jarvis', auth, createJarvisRoutes(ctx as never, process.cwd()));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jarvis`;
    const headers = { 'Content-Type': 'application/json', 'x-test-sub': OWNER };
    try {
      const response = await fetch(base + '/ask', {
        method: 'POST', headers,
        body: JSON.stringify({ message: 'Say hello.', sessionId: 'catalog-block-session' }),
      });
      expect(response.status).toBe(202);
      const { jobId } = await response.json() as { jobId: string };
      let result: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 200; attempt++) {
        result = await (await fetch(base + '/ask/result?jobId=' + jobId, { headers })).json() as Record<string, unknown>;
        if (result.status !== 'pending') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(result.status).toBe('done');
      // The model turn happened, and this is the text it ran on - not the router's source.
      expect(executeBot).toHaveBeenCalledTimes(1);
      const prompt = executeBot.mock.calls[0][3].text as string;
      expect(prompt).toContain('ASSISTANT CATALOG');
      expect(prompt).toContain(PLAN_DIRECTIVE_GUIDANCE);
      expect(prompt.indexOf('ASSISTANT CATALOG')).toBeLessThan(prompt.indexOf(PLAN_DIRECTIVE_GUIDANCE));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      purgeJarvisAskJobsForOwner(OWNER);
    }
  });

  it('the persona defers to the per-turn catalog instead of hardcoding one deployment\'s apps', async () => {
    const persona = fs.readFileSync(
      path.join(__dirname, '..', '..', 'ai-lab', 'bot-personas', 'oshal-assistant.yaml'), 'utf8');
    expect(persona).toContain('ASSISTANT CATALOG');
    // The old baked list named apps of ONE deployment — including one long since carved to the
    // store. Its return means the persona is authoritative again and store boxes go dark again.
    expect(persona).not.toMatch(/Little Monsters/);
  });
});

describe('OPEN WORK block: results are dated records, not current state', () => {
  const taskRow = (over: Record<string, unknown>) => ({
    id: 't1', title: 'CRM pull', status: 'done', kind: 'complex',
    result: 'stages new/working/won, 4 opportunities', created_at: new Date(Date.now() - 34 * 86400000),
    ...over,
  });

  it('stamps every result with its age so a month-old pull cannot read as fresh', async () => {
    const block = await buildOpenWorkBlock(ctxReturning([taskRow({})]) as never, 'sub-1');
    expect(block).toMatch(/DONE \(34 days ago\)/);
  });

  it('WITHHOLDS a stale result body - numbers the model cannot see cannot be quoted', async () => {
    // Four live iterations proved guidance loses to visible numbers. Deterministic removal wins.
    const block = await buildOpenWorkBlock(ctxReturning([taskRow({})]) as never, 'sub-1');
    expect(block).not.toContain('4 opportunities');
    expect(block).toMatch(/withheld as stale/);
  });

  it('keeps a recent result body - fresh work is still reportable directly', async () => {
    const fresh = taskRow({ created_at: new Date(Date.now() - 2 * 86400000) });
    const block = await buildOpenWorkBlock(ctxReturning([fresh]) as never, 'sub-1');
    expect(block).toContain('4 opportunities');
  });

  it('scopes results to their own task and sends current-state questions to a fresh handoff', async () => {
    const block = await buildOpenWorkBlock(ctxReturning([taskRow({})]) as never, 'sub-1');
    expect(block).toMatch(/NOT the current state/i);
    expect(block).toMatch(/fresh handoff/i);
  });
});
