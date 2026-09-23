/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for manifest-declared Jarvis reach mode. Every dynamically discovered app used to be hardcoded mode:'handoff', so an installed app could be correctly selected by the classifier and still never answer — Jarvis could only deep-link to its surface. A manifest may now declare bots[].jarvisMode: delegate, persisted to agents.metadata and read back here. Pins: delegate is honoured, handoff stays the DEFAULT when unset, and an unknown value falls back rather than producing a mode the delegate/handoff branches cannot handle.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard canonical concierge discovery: SQL matches the manifest selector by name among associated agent_ids with deterministic duplicate handling, never blindly routes to agent_ids[1] when an external chatBot is unresolved.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | A metadata-only chatBot is resolved globally by canonical name rather than persisted in agent_ids. The association column also feeds execution ownership, so borrowing a framework/member concierge must not make the referencing app its owner.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Fail closed on name shadows and inactive agents: declared/workflow concierges stay inside executable agent_ids, while a metadata-only external chatBot must have exactly one ACTIVE global row.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Dynamic borrowed-concierge discovery requires grants for both the referencing app key and a distinct bot owner; a shared bot's grant cannot leak or delegate a protected app.
 */

import { describe, it, expect, vi } from 'vitest';
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
  it('binds executable concierges to associations and admits only a unique active metadata concierge', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await loadEffectiveRoutes({ pool: { query } } as never);
    const sql = String(query.mock.calls[0]?.[0] ?? '');

    expect(sql).toMatch(/LEFT JOIN LATERAL/i);
    expect(sql).toMatch(/candidate\.agent_id = ANY\(sa\.agent_ids\)/i);
    expect(sql).toMatch(/candidate\.status = 'active'/i);
    expect(sql).toMatch(/binding\.explicit_chat_is_declared/i);
    expect(sql).toMatch(/associated\.agent_id = ANY\(sa\.agent_ids\)/i);
    expect(sql).toMatch(/SELECT COUNT\(\*\) FROM agents unique_candidate/i);
    expect(sql).toMatch(/unique_candidate\.status = 'active'/i);
    expect(sql).toMatch(/unique_candidate\.name = selected\.concierge_name/i);
    expect(sql).toContain("sa.manifest->>'chatBot'");
    expect(sql).toContain("sa.manifest->'workflow'->>'workerBot'");
    expect(sql).toContain("sa.manifest->'bots'->0->>'name'");
    expect(sql).toMatch(/ORDER BY candidate\.agent_id\s+LIMIT 1/i);
    expect(sql).not.toMatch(/agent_ids\s*\[\s*1\s*\]/i);
  });

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

  it('does not let a borrowed bot owner grant leak a denied referencing app', async () => {
    const canDiscover = vi.fn(async (app: string) => app !== 'private-surface');
    const ctx = {
      pool: { query: async () => ({ rows: [row('private-surface', 'delegate')] }) },
      applicationAuthorization: { owner: () => 'shared-concierge-owner', canDiscover },
    } as never;

    const { byKey } = await loadEffectiveRoutes(ctx);

    expect(byKey.has('private-surface')).toBe(false);
    expect(canDiscover).toHaveBeenCalledWith('private-surface');
  });

  it('requires the distinct borrowed bot owner grant after the app grant passes', async () => {
    const canDiscover = vi.fn(async (app: string) => app !== 'shared-concierge-owner');
    const ctx = {
      pool: { query: async () => ({ rows: [row('public-surface', 'delegate')] }) },
      applicationAuthorization: { owner: () => 'shared-concierge-owner', canDiscover },
    } as never;

    const { byKey } = await loadEffectiveRoutes(ctx);

    expect(byKey.has('public-surface')).toBe(false);
    expect(canDiscover).toHaveBeenCalledWith('public-surface');
    expect(canDiscover).toHaveBeenCalledWith('shared-concierge-owner');
  });

  it('discovers a borrowed-concierge route only when both application grants pass', async () => {
    const canDiscover = vi.fn(async () => true);
    const ctx = {
      pool: { query: async () => ({ rows: [row('granted-surface', 'delegate')] }) },
      applicationAuthorization: { owner: () => 'shared-concierge-owner', canDiscover },
    } as never;

    const { byKey } = await loadEffectiveRoutes(ctx);

    expect(byKey.has('granted-surface')).toBe(true);
    expect(canDiscover).toHaveBeenCalledWith('granted-surface');
    expect(canDiscover).toHaveBeenCalledWith('shared-concierge-owner');
  });

  it('keeps the historical owner-or-key discovery rule for curated routes', async () => {
    const canDiscover = vi.fn(async (app: string) => app === 'curated-owner');
    const ctx = {
      pool: { query: async () => ({ rows: [] }) },
      applicationAuthorization: { owner: () => 'curated-owner', canDiscover },
    } as never;

    const { byKey } = await loadEffectiveRoutes(ctx);

    expect(byKey.has('email')).toBe(true);
    expect(canDiscover).toHaveBeenCalledWith('curated-owner');
  });

  it('survives a discovery failure by falling back to the curated catalog', async () => {
    const ctx = { pool: { query: async () => { throw new Error('db down'); } } } as never;
    const { routes } = await loadEffectiveRoutes(ctx);
    expect(routes.length).toBeGreaterThan(0);
  });
});
