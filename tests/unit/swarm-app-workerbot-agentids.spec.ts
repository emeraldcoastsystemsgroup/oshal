/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 carve-parity regression: a store-carved app declares NO `bots:` (worker is framework-resident, ADR-093), so swarm_applications.agent_ids was silently empty and every consumer that resolves the app's agent from that column (Jarvis catalog/delegate/handoff, mesh BID_REQUEST, selector composition, competency ranking) skipped the app. SwarmAppRepository.upsert now backfills agent_ids from workflow.workerBot. This locks that behaviour.
 */

import { describe, expect, it, vi } from 'vitest';
import { SwarmAppRepository } from '@/features/swarm-apps/services/swarm-app-repository';
import type { SwarmAppManifest } from '@/features/swarm-apps/types';

/**
 * A minimal Pool stub: answers the workerBot→agentId SELECT (optionally throwing),
 * the previous-row agent_ids preserve-read, and captures the INSERT/UPSERT params
 * so the test can assert what agent_ids was persisted.
 */
function makePool(workerAgentId: string | null, opts?: { resolveThrows?: boolean; previousAgentIds?: string[] }) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/FROM agents WHERE name/i.test(sql)) {
      if (opts?.resolveThrows) throw new Error('simulated transient pg failure');
      return { rows: workerAgentId ? [{ agent_id: workerAgentId }] : [] };
    }
    if (/SELECT agent_ids FROM swarm_applications/i.test(sql)) {
      return { rows: opts?.previousAgentIds ? [{ agent_ids: opts.previousAgentIds }] : [] };
    }
    // The upsert RETURNING * — return a plausible row using the bound agent_ids ($7).
    return {
      rows: [{
        app_id: 'app-1', name: params[0], display_name: params[1], description: params[2],
        version: params[3], status: params[4], manifest_path: params[5], agent_ids: params[6],
        tool_names: params[7], manifest: params[8], scope: params[9] ?? 'public',
        owner_sub: params[10], tenant_id: params[11], guest_tier_approved: null,
        loaded_at: new Date(0), updated_at: new Date(0),
      }],
    };
  });
  return { pool: { query } as never, calls, query };
}

const CARVED: SwarmAppManifest = {
  name: 'movies', displayName: 'Movies & TV', version: '1.0.0', status: 'active',
  // No `bots:` — the carve rule (ADR-093): the worker is framework-resident.
  workflow: { name: 'x', workerBot: 'movies-concierge' },
} as unknown as SwarmAppManifest;

describe('SwarmAppRepository.upsert — carved-app agent_ids backfill (ADR-085/ADR-093)', () => {
  it('resolves workflow.workerBot → agentId when the manifest declares no bots', async () => {
    const { pool, query } = makePool('b00b0000-0000-0000-0000-000000000001');
    const rec = await new SwarmAppRepository(pool).upsert(CARVED, '/deployed-apps/movies/oshal-app.yaml', []);

    // The workerBot name was resolved…
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/FROM agents WHERE name/i), ['movies-concierge']);
    // …and its agentId became the app's agent_ids (so Jarvis/mesh/selector/ranker see it).
    expect(rec.agentIds).toEqual(['b00b0000-0000-0000-0000-000000000001']);
  });

  it('leaves agent_ids empty (no worse than before) when the worker is not seeded yet AND no prior row exists', async () => {
    const { pool } = makePool(null); // SELECT finds nothing, no previous row
    const rec = await new SwarmAppRepository(pool).upsert(CARVED, '/deployed-apps/movies/oshal-app.yaml', []);
    expect(rec.agentIds).toEqual([]);
  });

  // THE MONOTONE GUARD. An upsert with [] isn't just a stale catalog entry — the same load
  // pass runs reconcileAgentsTable, which deactivates any manifestApp-stamped agent not
  // referenced by an active app's agent_ids, knocking the framework-resident worker out of
  // mesh fan-out and the Jarvis catalog. A failed resolution must reuse the prior row's ids.
  it('preserves the previous row agent_ids when the workerBot resolution THROWS', async () => {
    const prev = ['b00b0000-0000-0000-0000-000000000001'];
    const { pool } = makePool(null, { resolveThrows: true, previousAgentIds: prev });
    const rec = await new SwarmAppRepository(pool).upsert(CARVED, '/deployed-apps/movies/oshal-app.yaml', []);
    expect(rec.agentIds).toEqual(prev);
  });

  it('preserves the previous row agent_ids when the agents row is transiently missing', async () => {
    const prev = ['b00b0000-0000-0000-0000-000000000001'];
    const { pool } = makePool(null, { previousAgentIds: prev }); // resolution returns no rows
    const rec = await new SwarmAppRepository(pool).upsert(CARVED, '/deployed-apps/movies/oshal-app.yaml', []);
    expect(rec.agentIds).toEqual(prev);
  });

  it('uses the declared bots and does NOT resolve a workerBot when the manifest has bots', async () => {
    const withBots = {
      ...CARVED,
      bots: [{ agentId: 'aaaa0000-0000-0000-0000-000000000001', name: 'x', persona: 'p.yaml' }],
    } as unknown as SwarmAppManifest;
    const { pool, query } = makePool('should-not-be-used');
    const rec = await new SwarmAppRepository(pool).upsert(withBots, '/swarm-apps/x.yaml', []);

    expect(query).not.toHaveBeenCalledWith(expect.stringMatching(/FROM agents WHERE name/i), expect.anything());
    expect(rec.agentIds).toEqual(['aaaa0000-0000-0000-0000-000000000001']);
  });
});
