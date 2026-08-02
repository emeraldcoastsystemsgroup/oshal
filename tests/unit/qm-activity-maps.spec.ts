/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for /api/qm/activity's three
 *   previously-hardcoded maps. The endpoint scanned `qm:cooldown:*` / `qm:lock:*` — prefixes no
 *   writer in this tree uses — and returned `agentTicketMappings: {}` behind a "TODO: implement if
 *   needed", so the ops dashboards showed "no agent owns a ticket / nothing in cooldown / no lock
 *   held" while the queue manager held all three. These cases feed a fake Redis the EXACT keys the
 *   real writers produce (QueuePollingCoordinator.setProcessed / acquireTaskLock, PlaneTicketIO)
 *   and assert the maps come back populated and correctly shaped. Behavioural, not structural: a
 *   revert to `{}` or a drift back to a dead prefix fails these.
 */

import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const requireModule = createRequire(import.meta.url);

interface KeyspaceEntry { id: string; value: string; ttl: number }

const routes = requireModule('../../any-bot/server/app-modules/routes-ops-observability.js') as {
  readQmKeyspace: (redis: unknown, prefix: string, limit?: number) => Promise<KeyspaceEntry[]>;
  buildAgentRegistry: (entries: KeyspaceEntry[]) => Record<string, Record<string, unknown>>;
  buildTicketRecords: (entries: KeyspaceEntry[]) => Array<Record<string, unknown>>;
  buildAgentTicketMappings: (
    phases: Array<Record<string, unknown>>,
    dispatches: Array<Record<string, unknown>>,
  ) => Record<string, string[]>;
  buildTicketTaskMappings: (entries: KeyspaceEntry[]) => Record<string, { taskId: string; ttl: number }>;
  buildCooldowns: (entries: KeyspaceEntry[], now?: number) => Record<string, Record<string, unknown>>;
  buildTaskLocks: (entries: KeyspaceEntry[]) => Record<string, { taskId: string; agentId: string; ttl: number }>;
  QM_KEY_PREFIXES: { ticketTask: string; cooldown: string; taskLock: string };
};

/** A Redis stand-in over a plain map: KEYS/GET/TTL are the only commands these readers use. */
function fakeRedis(store: Record<string, { value: string; ttl: number }>) {
  return {
    keys: async (pattern: string) => {
      const prefix = pattern.replace(/\*$/, '');
      return Object.keys(store).filter((k) => k.startsWith(prefix));
    },
    get: async (key: string) => (key in store ? store[key].value : null),
    ttl: async (key: string) => (key in store ? store[key].ttl : -2),
  };
}

const SAVED_COOLDOWN_ENV = process.env.QUEUE_MANAGER_COOLDOWN;

beforeEach(() => { delete process.env.QUEUE_MANAGER_COOLDOWN; });
afterEach(() => {
  if (SAVED_COOLDOWN_ENV === undefined) delete process.env.QUEUE_MANAGER_COOLDOWN;
  else process.env.QUEUE_MANAGER_COOLDOWN = SAVED_COOLDOWN_ENV;
});

describe('/api/qm/activity — the maps are built from live keys, not hardcoded empty', () => {
  it('reads the key prefixes the queue manager actually WRITES', () => {
    // The bug was a prefix mismatch: nothing writes qm:cooldown: or qm:lock:. These three are the
    // literals in QueuePollingCoordinator.js / PlaneTicketIO.js; drifting from them is the exact
    // regression (the endpoint keeps "working" and shows nothing).
    expect(routes.QM_KEY_PREFIXES.ticketTask).toBe('qm:ticket_task:');
    expect(routes.QM_KEY_PREFIXES.cooldown).toBe('qm:processed:');
    expect(routes.QM_KEY_PREFIXES.taskLock).toBe('qm:task_lock:');
  });

  it('materializes a keyspace into id/value/ttl entries and skips keys that expired mid-scan', async () => {
    const store = {
      'qm:task_lock:task-a': { value: 'agent-1', ttl: 3411 },
      'qm:task_lock:task-b': { value: 'agent-2', ttl: 120 },
      'other:key': { value: 'ignored', ttl: 5 },
    };
    const redis = fakeRedis(store);
    // Simulate the KEYS/GET race: the key is listed, then expires before the GET.
    const racy = { ...redis, get: async (key: string) => (key === 'qm:task_lock:task-b' ? null : store[key]?.value ?? null) };

    const entries = await routes.readQmKeyspace(racy, 'qm:task_lock:');
    expect(entries).toEqual([{ id: 'task-a', value: 'agent-1', ttl: 3411 }]);
  });

  it('honours the scan ceiling so one busy namespace cannot fan out unbounded round-trips', async () => {
    const store: Record<string, { value: string; ttl: number }> = {};
    for (let i = 0; i < 20; i += 1) store[`qm:processed:t${i}`] = { value: '{}', ttl: 3600 };
    const entries = await routes.readQmKeyspace(fakeRedis(store), 'qm:processed:', 5);
    expect(entries).toHaveLength(5);
  });

  it('keys the agent registry by agent id and survives one corrupt agent key', () => {
    const agents = routes.buildAgentRegistry([
      { id: 'agent-alpha', ttl: 45, value: JSON.stringify({ agent_id: 'agent-alpha', status: 'online', last_heartbeat: 1234, port: 3010 }) },
      { id: 'agent-broken', ttl: 45, value: '{not-json' },
      { id: 'fallback-id', ttl: 12, value: JSON.stringify({ status: 'busy' }) }, // no agent_id -> key suffix
    ]);
    expect(agents['agent-alpha']).toMatchObject({ status: 'online', lastHeartbeat: 1234, port: 3010, ttl: 45 });
    expect(agents['fallback-id']).toMatchObject({ status: 'busy', port: null });
    // One corrupt key must not take the other agents (or the whole endpoint) down.
    expect(agents['agent-broken']).toBeUndefined();
    expect(Object.keys(agents)).toHaveLength(2);
  });

  it('parses ticket-keyed records and keeps a malformed payload visible as raw', () => {
    const records = routes.buildTicketRecords([
      { id: 'T-1', ttl: 86_000, value: JSON.stringify({ phase: 3, executingAgent: 'agent-alpha' }) },
      { id: 'T-2', ttl: 10, value: 'half-written' },
    ]);
    expect(records[0]).toMatchObject({ ticketId: 'T-1', phase: 3, executingAgent: 'agent-alpha', ttl: 86_000 });
    expect(records[1]).toEqual({ ticketId: 'T-2', raw: 'half-written', ttl: 10 });
  });

  it('maps agent -> tickets from phase and dispatch records (the map that was always {})', () => {
    const phases = [
      { ticketId: 'T-1', executingAgent: 'agent-alpha', phase: 3 },
      { ticketId: 'T-2', assignedAgent: 'agent-beta', phase: 1 },   // assigned but not yet executing
      { ticketId: 'T-3', phase: 1 },                                 // unowned — must not invent an agent
    ];
    const dispatches = [
      { ticketId: 'T-4', agentId: 'agent-alpha' },
      { ticketId: 'T-1', agentId: 'agent-alpha' },                   // same pair twice -> one entry
    ];

    const mappings = routes.buildAgentTicketMappings(phases, dispatches);
    expect(mappings).toEqual({
      'agent-alpha': ['T-1', 'T-4'],
      'agent-beta': ['T-2'],
    });
    expect(Object.keys(mappings)).not.toContain('undefined');
  });

  it('returns an empty map only when there is genuinely nothing owned', () => {
    expect(routes.buildAgentTicketMappings([], [])).toEqual({});
  });

  it('reports each cooldown with the window its complexity earns and what is left of it', () => {
    const now = 1_700_000_000_000;
    const entries: KeyspaceEntry[] = [
      { id: 'T-hot', ttl: 3500, value: JSON.stringify({ ticket_id: 'T-hot', agent_id: 'queue-manager', processed_at: now - 30_000, complexity: 'low' }) },
      { id: 'T-cold', ttl: 3000, value: JSON.stringify({ ticket_id: 'T-cold', agent_id: 'rca-bot', processed_at: now - 400_000, complexity: 'high' }) },
    ];

    const cooldowns = routes.buildCooldowns(entries, now);

    // low = 60s window, 30s elapsed -> still suppressing this ticket, 30s left.
    expect(cooldowns['T-hot']).toMatchObject({ complexity: 'low', windowMs: 60_000, remainingMs: 30_000, active: true, agentId: 'queue-manager' });
    // high = 300s window, 400s elapsed -> the key is still there (1h TTL) but the ticket is eligible.
    expect(cooldowns['T-cold']).toMatchObject({ complexity: 'high', windowMs: 300_000, remainingMs: 0, active: false });
    expect(cooldowns['T-cold'].ttl).toBe(3000);
  });

  it('falls back to the configured default window for an unknown complexity', () => {
    process.env.QUEUE_MANAGER_COOLDOWN = '90000';
    const now = 1_700_000_000_000;
    const cooldowns = routes.buildCooldowns(
      [{ id: 'T-odd', ttl: 10, value: JSON.stringify({ processed_at: now - 1000, complexity: 'gigantic' }) }],
      now,
    );
    expect(cooldowns['T-odd'].windowMs).toBe(90_000);
    expect(cooldowns['T-odd'].active).toBe(true);
  });

  it('keeps an unparseable cooldown visible instead of dropping it', () => {
    const cooldowns = routes.buildCooldowns([{ id: 'T-bad', ttl: 5, value: 'not json' }]);
    expect(cooldowns['T-bad']).toMatchObject({ ticketId: 'T-bad', raw: 'not json' });
  });

  it('names the agent holding each task lock (the lock VALUE is the holder)', () => {
    const locks = routes.buildTaskLocks([
      { id: 'task-a', value: 'agent-alpha', ttl: 3411 },
      { id: 'task-b', value: 'agent-beta', ttl: 12 },
    ]);
    expect(locks).toEqual({
      'task-a': { taskId: 'task-a', agentId: 'agent-alpha', ttl: 3411 },
      'task-b': { taskId: 'task-b', agentId: 'agent-beta', ttl: 12 },
    });
  });

  it('exposes the ticket -> workspace-task bindings that were fetched and thrown away', () => {
    const mappings = routes.buildTicketTaskMappings([{ id: 'T-1', value: 'task-9f2', ttl: 86_000 }]);
    expect(mappings).toEqual({ 'T-1': { taskId: 'task-9f2', ttl: 86_000 } });
  });

  it('no longer hardcodes an empty map in the response body', () => {
    // The literal that shipped the bug. Structural, and deliberately narrow: it is the one shape
    // that reintroduces "fetched the keys, returned {}" without touching any behaviour above.
    const fs = requireModule('node:fs') as typeof import('node:fs');
    const src = fs.readFileSync(requireModule.resolve('../../any-bot/server/app-modules/routes-ops-observability.js'), 'utf8');
    const responseBlock = src.slice(src.indexOf("res.json({\n          success: true,\n          timestamp"));
    expect(responseBlock).not.toMatch(/agentTicketMappings:\s*\{\s*\}/);
    expect(responseBlock).not.toMatch(/cooldowns:\s*\{\s*\}/);
    expect(responseBlock).not.toMatch(/locks:\s*\{\s*\}/);
  });
});
