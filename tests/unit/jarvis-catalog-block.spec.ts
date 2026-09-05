/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the unified-bot-strategy gap (operator report 2026-09-04): the live Jarvis turn carried NO app catalog, so the persona's baked specialist list was the model's whole world — a CRM-only deployment had a Jarvis that had never heard of its own CRM and answered "I don't have that data" about an app on the same box. Pins: buildCatalogBlock lists a dynamically discovered store app with its deep link, declares its authority over any baked-in list, stays bounded, and the turn assembly + persona actually use it (the two ends the block is useless without).
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildCatalogBlock } from '@/app/routes/jarvis-orchestrator';
import { buildOpenWorkBlock } from '@/app/routes/jarvis-task-store';

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

  it('the live turn assembly actually injects the block (the gap this guard exists for)', async () => {
    // The catalog was fully built (surface chips, plan compiler) while the MODEL never received
    // it — the exact defect. Pin the wiring: the /ask context assembly must call
    // buildCatalogBlock and place it in the context blocks ahead of the plan guidance, whose
    // text refers to "the catalog keys above".
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'app', 'routes', 'jarvis-routes.ts'), 'utf8');
    const assembly = /const ctxBlocks = \[([^\]]*)\]/.exec(src);
    expect(assembly, 'ctxBlocks assembly must exist in jarvis-routes.ts').toBeTruthy();
    const order = (assembly as RegExpExecArray)[1];
    expect(order).toContain('catalog');
    expect(order.indexOf('catalog')).toBeLessThan(order.indexOf('PLAN_DIRECTIVE_GUIDANCE'));
    expect(src).toContain('await buildCatalogBlock(ctx)');
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
