/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 carve-parity regression: a store-carved app declares NO `bots:` (worker is framework-resident, ADR-093), so swarm_applications.agent_ids was silently empty and every consumer that resolves the app's agent from that column (Jarvis catalog/delegate/handoff, mesh BID_REQUEST, selector composition, competency ranking) skipped the app. SwarmAppRepository.upsert now backfills agent_ids from workflow.workerBot. This locks that behaviour.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | P8 locks canonical concierge ID first for Jarvis whether the chatBot is external or a later declared bot, without dropping a distinct workflow.workerBot association; name resolution is duplicate-row deterministic, first-load non-mislabel and same-name monotone preservation remain guarded.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Metadata-only external chatBot references stay out of agent_ids because that association column also feeds execution-ownership claims. Local declared concierges and external workflow workers remain associated; the corrective rollout drops the brief P8 chat association while preserving a distinct worker across transient lookup failure.
 */

import { describe, expect, it, vi } from 'vitest';
import { SwarmAppRepository } from '@/features/swarm-apps/services/swarm-app-repository';
import type { SwarmAppManifest } from '@/features/swarm-apps/types';

/**
 * A minimal Pool stub: answers the workerBot→agentId SELECT (optionally throwing),
 * the previous-row agent_ids preserve-read, and captures the INSERT/UPSERT params
 * so the test can assert what agent_ids was persisted.
 */
function makePool(
  workerAgentId: string | null,
  opts?: {
    resolveThrows?: boolean;
    previousAgentIds?: string[];
    previousManifest?: SwarmAppManifest;
    agentIdsByName?: Record<string, string | null>;
  },
) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/FROM agents WHERE name/i.test(sql)) {
      if (opts?.resolveThrows) throw new Error('simulated transient pg failure');
      const resolved = opts?.agentIdsByName
        ? opts.agentIdsByName[String(params[0])] ?? null
        : workerAgentId;
      return { rows: resolved ? [{ agent_id: resolved }] : [] };
    }
    if (/SELECT agent_ids(?:, manifest)? FROM swarm_applications/i.test(sql)) {
      return {
        rows: opts?.previousAgentIds
          ? [{ agent_ids: opts.previousAgentIds, manifest: opts.previousManifest }]
          : [],
      };
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
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE name = \$1 ORDER BY agent_id LIMIT 1/i),
      ['movies-concierge'],
    );
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
    const { pool } = makePool(null, { resolveThrows: true, previousAgentIds: prev, previousManifest: CARVED });
    const rec = await new SwarmAppRepository(pool).upsert(CARVED, '/deployed-apps/movies/oshal-app.yaml', []);
    expect(rec.agentIds).toEqual(prev);
  });

  it('preserves the previous row agent_ids when the agents row is transiently missing', async () => {
    const prev = ['b00b0000-0000-0000-0000-000000000001'];
    const { pool } = makePool(null, { previousAgentIds: prev, previousManifest: CARVED }); // resolution returns no rows
    const rec = await new SwarmAppRepository(pool).upsert(CARVED, '/deployed-apps/movies/oshal-app.yaml', []);
    expect(rec.agentIds).toEqual(prev);
  });

  it('uses a declared matching concierge without resolving it again', async () => {
    const withBots = {
      ...CARVED,
      bots: [{ agentId: 'aaaa0000-0000-0000-0000-000000000001', name: 'movies-concierge', persona: 'p.yaml' }],
    } as unknown as SwarmAppManifest;
    const { pool, query } = makePool('should-not-be-used');
    const rec = await new SwarmAppRepository(pool).upsert(withBots, '/swarm-apps/x.yaml', []);

    expect(query).not.toHaveBeenCalledWith(expect.stringMatching(/FROM agents WHERE name/i), expect.anything());
    expect(rec.agentIds).toEqual(['aaaa0000-0000-0000-0000-000000000001']);
  });

  it('moves a local chatBot declared at bots[1] into canonical agent_ids[1] position', async () => {
    const firstId = 'aaaa0000-0000-0000-0000-000000000001';
    const chatId = 'aaaa0000-0000-0000-0000-000000000002';
    const manifest = {
      ...CARVED,
      workflow: undefined,
      chatBot: 'second-bot',
      bots: [
        { agentId: firstId, name: 'first-bot', persona: 'first.yaml' },
        { agentId: chatId, name: 'second-bot', persona: 'second.yaml' },
      ],
    } as SwarmAppManifest;
    const { pool } = makePool(null);

    const rec = await new SwarmAppRepository(pool).upsert(manifest, '/swarm-apps/two-bots.yaml', []);

    expect(rec.agentIds).toEqual([chatId, firstId]);
  });

  it('puts a local chat concierge before its external workflow worker and other local bots', async () => {
    const otherId = 'aaaa0000-0000-0000-0000-000000000001';
    const chatId = 'aaaa0000-0000-0000-0000-000000000002';
    const workerId = 'bbbb0000-0000-0000-0000-000000000001';
    const manifest = {
      ...CARVED,
      chatBot: 'local-chat',
      workflow: { ...CARVED.workflow!, workerBot: 'external-worker' },
      bots: [
        { agentId: otherId, name: 'other-local', persona: 'other.yaml' },
        { agentId: chatId, name: 'local-chat', persona: 'chat.yaml' },
      ],
    } as SwarmAppManifest;
    const { pool } = makePool(null, { agentIdsByName: { 'external-worker': workerId } });

    const rec = await new SwarmAppRepository(pool).upsert(manifest, '/swarm-apps/local-chat.yaml', []);

    expect(rec.agentIds).toEqual([chatId, workerId, otherId]);
  });

  it('associates a distinct external workflow worker without persisting the borrowed chatBot', async () => {
    const manifest = { ...CARVED, chatBot: '  shared-advisor  ' } as SwarmAppManifest;
    const chatId = 'bbbb0000-0000-0000-0000-000000000001';
    const workerId = 'cccc0000-0000-0000-0000-000000000001';
    const { pool, calls } = makePool(null, {
      agentIdsByName: {
        'shared-advisor': chatId,
        'movies-concierge': workerId,
      },
    });

    const rec = await new SwarmAppRepository(pool).upsert(manifest, '/deployed-apps/surface/oshal-app.yaml', []);

    expect(calls
      .filter(({ sql }) => /FROM agents WHERE name/i.test(sql))
      .map(({ params }) => params[0]))
      .toEqual(['movies-concierge']);
    expect(rec.agentIds).toEqual([workerId]);
  });

  it('does not persist an external chatBot beside a declared local worker', async () => {
    const localId = 'aaaa0000-0000-0000-0000-000000000001';
    const externalId = 'bbbb0000-0000-0000-0000-000000000001';
    const manifest = {
      ...CARVED,
      workflow: { ...CARVED.workflow!, workerBot: 'local-worker' },
      chatBot: 'shared-advisor',
      bots: [{ agentId: localId, name: 'local-worker', persona: 'p.yaml' }],
    } as SwarmAppManifest;
    const { pool } = makePool(externalId);

    const rec = await new SwarmAppRepository(pool).upsert(manifest, '/deployed-apps/mixed/oshal-app.yaml', []);

    expect(rec.agentIds).toEqual([localId]);
  });

  it('keeps local bot ids but no fake external id when an external chatBot misses on first load', async () => {
    const localId = 'aaaa0000-0000-0000-0000-000000000001';
    const manifest = {
      ...CARVED,
      workflow: { ...CARVED.workflow!, workerBot: 'local-worker' },
      chatBot: 'shared-advisor',
      bots: [{ agentId: localId, name: 'local-worker', persona: 'p.yaml' }],
    } as SwarmAppManifest;
    const { pool } = makePool(null);

    const rec = await new SwarmAppRepository(pool).upsert(manifest, '/deployed-apps/mixed/oshal-app.yaml', []);

    expect(rec.agentIds).toEqual([localId]);
  });

  it('drops a prior borrowed chatBot association while retaining the new local worker', async () => {
    const oldLocalId = 'aaaa0000-0000-0000-0000-000000000001';
    const newLocalId = 'aaaa0000-0000-0000-0000-000000000002';
    const externalId = 'bbbb0000-0000-0000-0000-000000000001';
    const prior = {
      ...CARVED,
      workflow: { ...CARVED.workflow!, workerBot: 'old-local' },
      chatBot: 'shared-advisor',
      bots: [{ agentId: oldLocalId, name: 'old-local', persona: 'old.yaml' }],
    } as SwarmAppManifest;
    const current = {
      ...CARVED,
      workflow: { ...CARVED.workflow!, workerBot: 'new-local' },
      chatBot: 'shared-advisor',
      bots: [{ agentId: newLocalId, name: 'new-local', persona: 'new.yaml' }],
    } as SwarmAppManifest;
    const { pool } = makePool(null, {
      resolveThrows: true,
      previousAgentIds: [externalId, oldLocalId],
      previousManifest: prior,
    });

    const rec = await new SwarmAppRepository(pool).upsert(current, '/deployed-apps/mixed/oshal-app.yaml', []);

    expect(rec.agentIds).toEqual([newLocalId]);
  });

  it('does not preserve an old external id after the selected chatBot name changes', async () => {
    const prior = { ...CARVED, workflow: undefined, chatBot: 'old-advisor' } as SwarmAppManifest;
    const current = { ...CARVED, workflow: undefined, chatBot: 'new-advisor' } as SwarmAppManifest;
    const { pool } = makePool(null, {
      previousAgentIds: ['bbbb0000-0000-0000-0000-000000000001'],
      previousManifest: prior,
    });

    const rec = await new SwarmAppRepository(pool).upsert(current, '/deployed-apps/surface/oshal-app.yaml', []);

    expect(rec.agentIds).toEqual([]);
  });

  it('preserves only the worker from the brief chat-first P8 layout on a transient miss', async () => {
    const chatId = 'bbbb0000-0000-0000-0000-000000000001';
    const workerId = 'cccc0000-0000-0000-0000-000000000001';
    const manifest = { ...CARVED, chatBot: 'shared-advisor' } as SwarmAppManifest;
    const { pool } = makePool(null, {
      resolveThrows: true,
      previousAgentIds: [chatId, workerId],
      previousManifest: manifest,
    });

    const rec = await new SwarmAppRepository(pool).upsert(manifest, '/deployed-apps/surface/oshal-app.yaml', []);

    expect(rec.agentIds).toEqual([workerId]);
  });

  it('does not turn a surface-only framework concierge into an execution-ownership claim', async () => {
    const personModel = {
      name: 'person-model', displayName: 'Ambient Recall', status: 'inactive', version: '1.1.1',
      chatBot: 'general-bot',
      ui: { static: [{ toolName: 'ambient-recall', label: 'Ambient Recall', icon: 'i', iframeUrl: '/ambient' }] },
    } as SwarmAppManifest;
    const { pool, calls } = makePool('a0000000-0000-0000-0000-000000000099');

    const rec = await new SwarmAppRepository(pool).upsert(personModel, '/swarm-apps/person-model.yaml', []);

    expect(calls.filter(({ sql }) => /FROM agents WHERE name/i.test(sql))).toEqual([]);
    expect(rec.agentIds).toEqual([]);
  });
});
