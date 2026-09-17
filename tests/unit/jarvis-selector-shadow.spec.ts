/**
 * Guard for the Jarvis tool-selector shadow step.
 *
 * WHY THIS EXISTS: a shadow step has exactly one way to be a disaster, and it is the reason it was
 * asked for in the first place. If the candidate selector ever reaches the model, the "safe"
 * experiment has silently shipped a cut the bench corpus rejected - and it would look like a Jarvis
 * that quietly stopped being able to do things. So the load-bearing assertion here is NOT that the
 * measurement is pretty; it is that the block the model receives is byte-for-byte the block it
 * received before this step existed, while the shadow is on and its candidate is as destructive as
 * a candidate can be (`top-k:1` throws away every tool but one).
 *
 * That assertion is made at the boundary that would actually fail: the REAL authenticated
 * `/api/jarvis/ask` route, the REAL `createJarvisRoutes`, the REAL `buildToolsBlock` reading the
 * REAL jarvis-tools.yaml and the REAL mounted scripts directory, with the prompt read off the model
 * call the route made. Only persistence, model execution and the test identity rail are doubles -
 * the same seam tests/unit/jarvis-artifact-routing.spec.ts uses.
 *
 * The rest is the harness's no-fabrication rule carried into core: a candidate that cannot be
 * computed must record `not-run` with a reason, never a zero-byte saving, and must still return the
 * real block.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - proves the model receives the unchanged block through the real /ask route while the shadow measures a destructive candidate, that the measurement is taken off the real selector's own tool lines, and that an uncomputable candidate reports not-run instead of a number.
 *
 * @module tests/unit/jarvis-selector-shadow
 */

import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executeBot = vi.hoisted(() => vi.fn());
const logged = vi.hoisted(() => [] as { level: string; record: Record<string, unknown>; message: string }[]);

vi.mock('@/app/routes/inline-bot-execution', () => ({ executeBotOrInline: executeBot }));
vi.mock('@/app/routes/connector-token-broker', () => ({ resolveBotCreds: vi.fn().mockResolvedValue({}) }));
vi.mock('@/app/routes/free-tier-rotation', () => ({
  resolveUserLlmConnection: vi.fn().mockResolvedValue(null), reportResolvedLlmFailure: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/features/user-model', () => ({
  withHavenContext: vi.fn(async (_pool: unknown, _sub: string, prompt: string) => prompt),
  learnFromExchange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/shared/services/database', async (importOriginal) => ({
  ...await importOriginal<object>(),
  runRuntimeSchemaBootstrap: vi.fn().mockResolvedValue(undefined), buildOwnerRlsPolicyStatements: vi.fn().mockReturnValue([]),
}));
// The log SINK is the one collaborator doubled outside the boundary under test: the shadow's whole
// output is a log record, and pino ships it through a worker transport that a spec cannot read back
// synchronously. Everything the record describes is still measured off the real selector.
vi.mock('@/shared/logger', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const capture = (level: string) => (record: unknown, message?: string) =>
    logged.push({ level, record: (record ?? {}) as Record<string, unknown>, message: message ?? '' });
  const child = { trace: capture('trace'), debug: capture('debug'), info: capture('info'), warn: capture('warn'), error: capture('error'), fatal: capture('fatal') };
  return { ...actual, createChildLogger: () => ({ ...child, child: () => child }) };
});

import { buildToolsBlock } from '@/app/routes/jarvis-tool-catalog';
import { buildToolsBlockWithShadow, measureSelectorShadow } from '@/app/routes/jarvis-selector-shadow';
import { createJarvisRoutes, purgeJarvisAskJobsForOwner } from '@/app/routes/jarvis-routes';
import { createMemoryOnlyTaskStore } from '../helpers/jarvis-session-task-store';

const OWNER = 'auth0|selector-shadow-owner';
// Model-owned by construction: detectProviderBoundHandoff returns null for it, so the turn
// really builds a tool block instead of taking the deterministic fast lane.
const ASK = 'put on some jazz while I finish this report';
const SURFACE = 'jarvis';
const shadowRecords = () => logged.filter((entry) => entry.message.startsWith('jarvis: selector shadow'));

beforeEach(() => {
  logged.length = 0;
  executeBot.mockReset();
  delete process.env.JARVIS_SELECTOR_SHADOW;
});
afterEach(() => {
  delete process.env.JARVIS_SELECTOR_SHADOW;
  purgeJarvisAskJobsForOwner(OWNER);
  vi.restoreAllMocks();
});

describe('the shadow step measures a candidate and sends the baseline', () => {
  it('is inert when no candidate is named', () => {
    const block = buildToolsBlockWithShadow({ message: ASK, surface: SURFACE });
    expect(block).toBe(buildToolsBlock({ message: ASK, surface: SURFACE }));
    expect(shadowRecords()).toHaveLength(0);
  });

  it('returns the real block untouched while measuring the most destructive candidate there is', () => {
    process.env.JARVIS_SELECTOR_SHADOW = 'top-k:1';
    const baseline = buildToolsBlock({ message: ASK, surface: SURFACE });
    expect(buildToolsBlockWithShadow({ message: ASK, surface: SURFACE }, { correlation: 'turn-1' })).toBe(baseline);

    const [entry] = shadowRecords();
    expect(entry.level).toBe('info');
    const record = entry.record as Record<string, unknown>;
    expect(record.status).toBe('measured');
    expect(record.candidate).toBe('top-k:1');
    expect(record.correlation).toBe('turn-1');
    expect(record.unit).toBe('bytes');
    // Measured off the REAL block: its exact byte length, and the tool count the YAML really advertises.
    expect(record.baselineBytes).toBe(Buffer.byteLength(baseline, 'utf8'));
    expect(record.baselineTools as number).toBeGreaterThanOrEqual(10);
    expect(record.candidateTools).toBe(1);
    expect(record.deltaBytes as number).toBeLessThan(0);
    expect((record.dropped as string[]).length).toBe((record.baselineTools as number) - 1);
    for (const script of record.dropped as string[]) expect(baseline).toContain(`-> node /app/scripts/${script} |`);
    // The user's words never reach the log; only their length and the surface do.
    expect(record.messageChars).toBe(ASK.length);
    expect(record.surface).toBe(SURFACE);
    expect(JSON.stringify(record)).not.toContain('jazz');
  });

  it('reports not-run with a reason instead of inventing a saving', () => {
    for (const spec of ['top-k', 'widen-everything', 'top-k:', 'scored-floor:x']) {
      logged.length = 0;
      process.env.JARVIS_SELECTOR_SHADOW = spec;
      const baseline = buildToolsBlock({ message: ASK, surface: SURFACE });
      expect(buildToolsBlockWithShadow({ message: ASK, surface: SURFACE })).toBe(baseline);
      const [entry] = shadowRecords();
      expect(entry.level).toBe('warn');
      expect(entry.record.status).toBe('not-run');
      expect(entry.record.reason).toMatch(/unknown candidate spec/);
      expect(entry.record.candidateBytes).toBeNull();
      expect(entry.record.deltaBytes).toBeNull();
      expect(entry.record.candidateTools).toBeNull();
    }
  });

  it('cuts by the shipped scorer, not by an invented one', () => {
    const block = buildToolsBlock({ message: 'play something on spotify', surface: SURFACE });
    const scored = measureSelectorShadow('scored-floor:1', block, { message: 'play something on spotify', surface: SURFACE });
    expect(scored.status).toBe('measured');
    expect(scored.candidateTools as number).toBeGreaterThanOrEqual(1);
    expect(scored.dropped).not.toContain('oshal-spotify.js');
    // A block with no advertised tools is a not-run, never a 100% saving.
    const empty = measureSelectorShadow('top-k:1', 'YOUR TOOLS: none today.', { message: ASK });
    expect(empty.status).toBe('not-run');
    expect(empty.reason).toMatch(/no tool lines/);
    expect(empty.deltaBytes).toBeNull();
  });
});

describe('the real /api/jarvis/ask route with the shadow armed', () => {
  it('hands the model the same prompt it would have sent with the shadow off', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const ctx = {
      pool: { query }, orchestrator: { processMessage: vi.fn() },
      taskStore: createMemoryOnlyTaskStore(),
      messageStore: { save: vi.fn(), getByTask: vi.fn().mockResolvedValue([]) },
      ticketService: {
        listTickets: vi.fn().mockResolvedValue([]), openChatTicket: vi.fn().mockResolvedValue({ ticketId: 'shadow-chat' }),
        createTicket: vi.fn(), updateStatus: vi.fn(),
      },
    };
    const auth: RequestHandler = (request, response, next) => {
      const sub = request.header('x-test-sub');
      if (!sub) { response.sendStatus(401); return; }
      (request as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub } };
      next();
    };
    executeBot.mockResolvedValue({ response: 'Playing something.' });
    const app = express();
    app.use(express.json());
    app.use('/api/jarvis', auth, createJarvisRoutes(ctx as never, process.cwd(), async () => new Map()));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jarvis`;
    const headers = { 'Content-Type': 'application/json', 'x-test-sub': OWNER };

    const turn = async (sessionId: string): Promise<string> => {
      const response = await fetch(base + '/ask', { method: 'POST', headers, body: JSON.stringify({ message: ASK, sessionId }) });
      expect(response.status).toBe(202);
      const { jobId } = await response.json() as { jobId: string };
      for (let attempt = 0; attempt < 200; attempt++) {
        const body = await (await fetch(base + `/ask/result?jobId=${jobId}`, { headers })).json() as Record<string, unknown>;
        if (body.status !== 'pending') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return executeBot.mock.calls[executeBot.mock.calls.length - 1][3].text as string;
    };

    try {
      const withoutShadow = await turn('selector-shadow-off');
      const advertised = buildToolsBlock({ message: ASK, surface: undefined })
        .split('\n').filter(line => line.includes('-> node /app/scripts/')).length;
      expect(advertised).toBeGreaterThanOrEqual(10);

      logged.length = 0;
      process.env.JARVIS_SELECTOR_SHADOW = 'top-k:1';
      const withShadow = await turn('selector-shadow-on');

      // THE assertion: arming the shadow changed nothing the model can see.
      expect(withShadow).toBe(withoutShadow);
      expect(withShadow.split('\n').filter(line => line.includes('-> node /app/scripts/')).length).toBe(advertised);

      const [entry] = shadowRecords();
      expect(entry.record.status).toBe('measured');
      expect(entry.record.candidateTools).toBe(1);
      expect(entry.record.correlation).toEqual(expect.any(String));
      expect(entry.record.deltaBytes as number).toBeLessThan(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
