/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for manifest-declared Jarvis reach mode. Every dynamically discovered app used to be hardcoded mode:'handoff', so an installed app could be correctly selected by the classifier and still never answer — Jarvis could only deep-link to its surface. A manifest may now declare bots[].jarvisMode: delegate, persisted to agents.metadata and read back here. Pins: delegate is honoured, handoff stays the DEFAULT when unset, and an unknown value falls back rather than producing a mode the delegate/handoff branches cannot handle.
 */

import { describe, it, expect } from 'vitest';
import { loadEffectiveRoutes } from '@/app/routes/jarvis-orchestrator';

/** Minimal AppContext double — loadEffectiveRoutes only reaches for ctx.pool.query. */
function ctxReturning(rows: Array<Record<string, unknown>>): never {
  return { pool: { query: async () => ({ rows }) } } as never;
}

function row(name: string, jarvisMode: string | null) {
  return {
    name,
    display_name: name,
    // Not in the core registry — isBotAccessibleTo returns true for unknown ids (ADR-087),
    // which is what lets a store-installed bot be discovered at all.
    agent_id: '15000000-0000-0000-0000-000000000001',
    selector: 'THIS IS THE USER\'S CRM — pipeline, leads, opportunities, conversion.',
    jarvis_mode: jarvisMode,
  };
}

describe('Jarvis discovery: a manifest decides how Jarvis reaches the app', () => {
  it('honours jarvisMode: delegate so the app can answer inline', async () => {
    const { byKey } = await loadEffectiveRoutes(ctxReturning([row('intelligent-sales', 'delegate')]));
    expect(byKey.get('intelligent-sales')?.mode).toBe('delegate');
  });

  it('DEFAULTS to handoff when the manifest says nothing — the historical behaviour', async () => {
    const { byKey } = await loadEffectiveRoutes(ctxReturning([row('intelligent-sales', null)]));
    expect(byKey.get('intelligent-sales')?.mode).toBe('handoff');
  });

  it('falls back to handoff on an unknown mode rather than inventing one', async () => {
    // A typo must not yield a mode the delegate/handoff branches cannot dispatch on.
    const { byKey } = await loadEffectiveRoutes(ctxReturning([row('intelligent-sales', 'delgate')]));
    expect(byKey.get('intelligent-sales')?.mode).toBe('handoff');
  });

  it('still discovers the app and carries its selector as the routing blurb', async () => {
    const { byKey } = await loadEffectiveRoutes(ctxReturning([row('intelligent-sales', 'delegate')]));
    const r = byKey.get('intelligent-sales');
    expect(r?.deepLink).toBe('/cockpit/?app=intelligent-sales');
    expect(r?.blurb).toContain('CRM');
  });

  it('never lets discovery clobber a curated APP_ROUTES entry', async () => {
    // 'email' is curated with mode:'delegate'; a discovered row of the same key must not win.
    const { byKey } = await loadEffectiveRoutes(ctxReturning([row('email', 'handoff')]));
    expect(byKey.get('email')?.agentId).toBe('b0000000-0000-0000-0000-000000000001');
    expect(byKey.get('email')?.mode).toBe('delegate');
  });

  it('survives a discovery failure by falling back to the curated catalog', async () => {
    const ctx = { pool: { query: async () => { throw new Error('db down'); } } } as never;
    const { routes } = await loadEffectiveRoutes(ctx);
    expect(routes.length).toBeGreaterThan(0);
  });
});
