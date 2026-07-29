/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the render-node availability gate: the blackout clock (including the wrap-midnight window a naive comparison never fires), fail-closed behaviour on every unreadable signal, the busy/in-flight refusals, and the node package dir no longer defaulting to a path that has never existed on the node.
 */
/**
 * @description The gate decides whether anything is allowed to touch the render node, and every
 * mistake it can make costs money: a false "free" runs a second chain against the one signed-in
 * Chrome, which finishes nothing and pays for every retry. So the properties under test are the
 * refusals, not the happy path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';

/** The registry the gate reads. Mocked so no real remote client is needed. */
const listClients = vi.fn();
vi.mock('@/app/routes/remote-client-routes', () => ({
  remoteClientRegistry: {
    listClients: () => listClients(),
    enqueueTask: vi.fn(() => ({ taskId: 't1' })),
    getCompletedResult: vi.fn(() => null),
  },
}));

import {
  isInBlackout, findRenderNode, nodePkgDir, checkVidsNodeAvailability,
} from '@/app/vids-node-availability';

/** A pool whose `query` answers from a queue of results, in order. */
function fakePool(results: Array<{ rows: unknown[] }>): Pool {
  let i = 0;
  return { query: vi.fn(async () => results[i++] ?? { rows: [] }) } as unknown as Pool;
}

const IDLE_NODE = [{ clientId: 'node-1', status: 'online', healthy: true, capabilities: ['shell.exec'], activeTaskId: null, taskQueueDepth: 0 }];

describe('the blackout clock', () => {
  // 2026-07-29 23:30 UTC is 18:30 in Chicago — inside the recap's window.
  const at = (iso: string) => new Date(iso);

  it('keeps the pump out of the window the nightly recap owns', () => {
    expect(isInBlackout(at('2026-07-29T23:30:00Z'), '16:45-19:45', 'America/Chicago')).toBe(true);
  });

  it('lets it run outside that window', () => {
    // 14:00 UTC = 09:00 Chicago.
    expect(isInBlackout(at('2026-07-29T14:00:00Z'), '16:45-19:45', 'America/Chicago')).toBe(false);
  });

  it('reads the window in the configured zone, not the controller\'s', () => {
    // 23:30 UTC is inside 16:45-19:45 Chicago but NOT inside the same numbers read as UTC.
    expect(isInBlackout(at('2026-07-29T23:30:00Z'), '16:45-19:45', 'UTC')).toBe(false);
  });

  it('fires for a window that wraps midnight (the case a plain from<=x<to misses)', () => {
    // 05:00 UTC = 00:00 Chicago, inside 22:00-06:00.
    expect(isInBlackout(at('2026-07-30T05:00:00Z'), '22:00-06:00', 'America/Chicago')).toBe(true);
    // 12:00 Chicago is outside it.
    expect(isInBlackout(at('2026-07-30T17:00:00Z'), '22:00-06:00', 'America/Chicago')).toBe(false);
  });

  it('honours several windows at once', () => {
    const spec = '06:00-07:00,16:45-19:45';
    expect(isInBlackout(at('2026-07-29T11:30:00Z'), spec, 'America/Chicago')).toBe(true);  // 06:30 CT
    expect(isInBlackout(at('2026-07-29T15:00:00Z'), spec, 'America/Chicago')).toBe(false); // 10:00 CT
  });

  it('treats an empty or unparseable spec as no window at all, not as a whole-day block', () => {
    expect(isInBlackout(at('2026-07-29T23:30:00Z'), '', 'America/Chicago')).toBe(false);
    expect(isInBlackout(at('2026-07-29T23:30:00Z'), 'always', 'America/Chicago')).toBe(false);
  });

  it('fails CLOSED when the clock itself cannot be read', () => {
    // An unusable zone means we cannot tell whether the recap owns the node right now. The gate must
    // answer "blacked out" — never "probably fine".
    expect(isInBlackout(at('2026-07-29T23:30:00Z'), '16:45-19:45', 'Not/AZone')).toBe(true);
  });
});

describe('finding the render node', () => {
  beforeEach(() => { listClients.mockReset(); delete process.env.VIDS_RENDER_CLIENT_ID; });

  it('ignores clients that cannot run a shell command', () => {
    listClients.mockReturnValue([{ clientId: 'chat-only', status: 'online', capabilities: ['chat'] }]);
    expect(findRenderNode()).toBeNull();
  });

  it('ignores an offline node', () => {
    listClients.mockReturnValue([{ clientId: 'n', status: 'offline', capabilities: ['shell.exec'] }]);
    expect(findRenderNode()).toBeNull();
  });

  it('honours the pinned client id', () => {
    process.env.VIDS_RENDER_CLIENT_ID = 'node-2';
    listClients.mockReturnValue([
      { clientId: 'node-1', status: 'online', capabilities: ['shell.exec'] },
      { clientId: 'node-2', status: 'online', capabilities: ['shell.exec'] },
    ]);
    expect(findRenderNode()?.clientId).toBe('node-2');
  });

  it('returns null rather than throwing when the registry is unavailable', () => {
    listClients.mockImplementation(() => { throw new Error('registry down'); });
    expect(findRenderNode()).toBeNull();
  });
});

describe('the node package directory', () => {
  const saved = process.env.VIDS_NODE_PKG_DIR;
  afterEach(() => { if (saved === undefined) delete process.env.VIDS_NODE_PKG_DIR; else process.env.VIDS_NODE_PKG_DIR = saved; });

  it('does not default to the controller\'s own checkout path', () => {
    // The old default pointed at C:\Projects\open-shal-swarm-harness-agent-llm\packages\… — a
    // directory that has never existed on the render node, so every render shelled into nothing.
    delete process.env.VIDS_NODE_PKG_DIR;
    expect(nodePkgDir()).not.toMatch(/open-shal-swarm-harness-agent-llm/);
    expect(nodePkgDir()).toMatch(/oshal-vidsop/);
  });

  it('takes the operator\'s override and strips a trailing separator', () => {
    process.env.VIDS_NODE_PKG_DIR = 'D:\\vids\\';
    expect(nodePkgDir()).toBe('D:\\vids');
  });
});

describe('the availability verdict', () => {
  const savedBlackout = process.env.VIDS_NODE_BLACKOUT;
  beforeEach(() => {
    listClients.mockReset();
    delete process.env.VIDS_RENDER_CLIENT_ID;
    // Neutralize the schedule so these cases test one signal each.
    process.env.VIDS_NODE_BLACKOUT = '';
  });
  afterEach(() => { if (savedBlackout === undefined) delete process.env.VIDS_NODE_BLACKOUT; else process.env.VIDS_NODE_BLACKOUT = savedBlackout; });

  it('refuses when no node is connected', async () => {
    listClients.mockReturnValue([]);
    const v = await checkVidsNodeAvailability(fakePool([]));
    expect(v).toMatchObject({ available: false, check: 'no-worker' });
  });

  it('refuses while the node is running someone else\'s task', async () => {
    listClients.mockReturnValue([{ ...IDLE_NODE[0], activeTaskId: 'abc' }]);
    const v = await checkVidsNodeAvailability(fakePool([]));
    expect(v).toMatchObject({ available: false, check: 'worker-busy' });
    expect(v.reason).toContain('abc');
  });

  it('refuses while a task is merely QUEUED on the node', async () => {
    listClients.mockReturnValue([{ ...IDLE_NODE[0], taskQueueDepth: 2 }]);
    const v = await checkVidsNodeAvailability(fakePool([]));
    expect(v).toMatchObject({ available: false, check: 'worker-busy' });
  });

  it('refuses while ANY episode is rendering — one Chrome, one chain', async () => {
    listClients.mockReturnValue(IDLE_NODE);
    const v = await checkVidsNodeAvailability(fakePool([{ rows: [{ episode_id: 'e1', title: 'Flip Trip' }] }]));
    expect(v).toMatchObject({ available: false, check: 'render-in-flight' });
    expect(v.reason).toContain('Flip Trip');
  });

  it('refuses inside the blackout window before it ever asks the node', async () => {
    process.env.VIDS_NODE_BLACKOUT = '00:00-23:59';
    listClients.mockReturnValue(IDLE_NODE);
    const v = await checkVidsNodeAvailability(fakePool([{ rows: [] }]));
    expect(v).toMatchObject({ available: false, check: 'blackout' });
  });

  it('refuses when the node never answers the probe (fail-closed, not fail-open)', async () => {
    listClients.mockReturnValue(IDLE_NODE);
    // getCompletedResult is mocked to always return null, so the probe times out.
    const v = await checkVidsNodeAvailability(fakePool([{ rows: [] }]), { probeTimeoutMs: 10 });
    expect(v).toMatchObject({ available: false, check: 'probe-failed' });
  });

  it('reports free only when every cheap signal is clear and the probe is deliberately skipped', async () => {
    listClients.mockReturnValue(IDLE_NODE);
    const v = await checkVidsNodeAvailability(fakePool([{ rows: [] }]), { skipProbe: true });
    expect(v).toMatchObject({ available: true, check: 'free', clientId: 'node-1' });
  });
});
