/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for owner-scoped render-node
 *   selection in series dispatch. findShellWorker/findVidsWorker picked on LIVENESS ALONE, so on a
 *   multi-user swarm one user's episode rendered on whatever desktop was connected — driving another
 *   person's logged-in Chrome/Google Vids session with the requester's Drive access token exported
 *   into a PowerShell environment on their box. These cases prove the second user's render cannot
 *   land on the first user's machine, that a deployment-wide VIDS_RENDER_CLIENT_ID pin cannot
 *   override ownership, and that the owner is read from the series row rather than trusted from a
 *   caller. Behavioural: every case asserts what was (or was not) ENQUEUED, not a source substring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

const hoisted = vi.hoisted(() => ({
  enqueued: [] as Array<{ clientId: string; env: Record<string, unknown> }>,
  state: { clients: [] as Array<Record<string, unknown>> },
}));

vi.mock('@/app/routes/remote-client-routes', () => ({
  remoteClientRegistry: {
    listClients: () => hoisted.state.clients,
    enqueueTask: (clientId: string, env: Record<string, unknown>) => {
      hoisted.enqueued.push({ clientId, env });
      return { taskId: env.taskId };
    },
    getCompletedResult: () => null,
  },
}));

vi.mock('@/app/vids-node-availability', () => ({
  checkVidsNodeAvailability: async () => ({ available: true, reason: '' }),
  nodePkgDir: () => 'C:\\oshal-vidsop',
  nodeExe: () => 'C:\\Program Files\\nodejs\\node.exe',
}));

import { dispatchEpisode, dispatchStoryboardedEpisode, dispatchAssembly } from '@/app/series-dispatch';

const OWNER = 'user-a-sub';
const STRANGER = 'user-b-sub';
const SERIES = '11111111-1111-1111-1111-111111111111';
const EPISODE = '22222222-2222-2222-2222-222222222222';

const ENV_KEYS = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_ALLOW_LEGACY_UNOWNED', 'VIDS_RENDER_CLIENT_ID'] as const;
const savedEnv: Record<string, string | undefined> = {};

/** A node that can do everything either selector looks for, owned by whoever is named. */
function node(clientId: string, ownerSub: string | null): Record<string, unknown> {
  return {
    clientId,
    agentId: `agent-${clientId}`,
    status: 'online',
    healthy: true,
    ownerSub,
    capabilities: ['shell.exec', 'content.produce'],
    tags: ['vids'],
  };
}

const SCENES = [
  { n: 1, camera: 'wide', motion: 'push in', dialogue: [{ who: 'Ada', line: 'hello' }] },
  { n: 2, camera: 'close', motion: 'hold', dialogue: [{ who: 'Ada', line: 'goodbye' }] },
];

/** Minimal Postgres stand-in: answers the exact reads these dispatchers make, records writes. */
function fakePool(ownerSub: string | null, opts: { status?: string } = {}): Pool & { writes: string[] } {
  const writes: string[] = [];
  const pool = {
    writes,
    query: async (sql: string) => {
      if (/^\s*UPDATE/i.test(sql)) { writes.push(sql.replace(/\s+/g, ' ').trim()); return { rows: [], rowCount: 1 }; }
      if (/SELECT user_sub FROM video_series/i.test(sql)) {
        return { rows: ownerSub ? [{ user_sub: ownerSub }] : [], rowCount: ownerSub ? 1 : 0 };
      }
      if (/e\.clip_paths/i.test(sql)) {
        return {
          rows: [{
            episode_id: EPISODE, title: 'Ep 1', clip_paths: ['C:/clips/1.mp4'],
            status: opts.status ?? 'rendered', series_title: 'The Show', user_sub: ownerSub,
          }],
          rowCount: 1,
        };
      }
      if (/e\.frame_ids/i.test(sql)) {
        return {
          rows: [{
            episode_id: EPISODE, title: 'Ep 1', ordinal: 1, scenes: SCENES,
            frame_ids: ['frame-1', 'frame-2'], status: opts.status ?? 'storyboarded',
            series_title: 'The Show', cast_bible: [{ name: 'Ada', description: 'an engineer' }],
            orientation: 'Landscape', intro_clip: null, user_sub: ownerSub,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return pool as unknown as Pool & { writes: string[] };
}

const EPISODE_ROW = {
  episodeId: EPISODE, seriesId: SERIES, ordinal: 1, title: 'Ep 1',
  scriptMd: '# script', animationMd: null, imagePromptsMd: null,
};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  hoisted.enqueued.length = 0;
  hoisted.state.clients = [];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('series render dispatch — a render only lands on a node its owner may drive', () => {
  it('renders a storyboarded episode on the owner\'s own node', async () => {
    hoisted.state.clients = [node('box-a', OWNER)];
    const r = await dispatchStoryboardedEpisode(fakePool(OWNER), EPISODE, { driveToken: 'tok-a' });
    expect(r.ok).toBe(true);
    expect(r.clientId).toBe('box-a');
    expect(hoisted.enqueued).toHaveLength(1);
    expect(hoisted.enqueued[0].clientId).toBe('box-a');
  });

  it('REFUSES to render user A\'s episode on user B\'s box', async () => {
    // The only connected render node belongs to somebody else. Before this guard the dispatch
    // enqueued a shell.exec on that box carrying A's Drive token.
    hoisted.state.clients = [node('box-b', STRANGER)];
    const r = await dispatchStoryboardedEpisode(fakePool(OWNER), EPISODE, { driveToken: 'tok-a' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no render node is available/i);
    expect(hoisted.enqueued).toHaveLength(0);
    // And the leaked credential never reached anyone's queue.
    expect(JSON.stringify(hoisted.enqueued)).not.toContain('tok-a');
  });

  it('picks the owner\'s node out of a mixed fleet instead of the first live one', async () => {
    hoisted.state.clients = [node('box-b', STRANGER), node('box-c', STRANGER), node('box-a', OWNER)];
    const r = await dispatchStoryboardedEpisode(fakePool(OWNER), EPISODE, { driveToken: 'tok-a' });
    expect(r.ok).toBe(true);
    expect(r.clientId).toBe('box-a');
  });

  it('does not let a deployment-wide VIDS_RENDER_CLIENT_ID pin override ownership', async () => {
    // The pin is process-wide config, not per-user intent: it must never promote a foreign box.
    process.env.VIDS_RENDER_CLIENT_ID = 'box-b';
    hoisted.state.clients = [node('box-b', STRANGER), node('box-a', OWNER)];
    const r = await dispatchStoryboardedEpisode(fakePool(OWNER), EPISODE, { driveToken: 'tok-a' });
    expect(r.ok).toBe(false);
    expect(hoisted.enqueued).toHaveLength(0);
  });

  it('honours the pin when the pinned box IS the owner\'s', async () => {
    process.env.VIDS_RENDER_CLIENT_ID = 'box-a2';
    hoisted.state.clients = [node('box-a', OWNER), node('box-a2', OWNER)];
    const r = await dispatchStoryboardedEpisode(fakePool(OWNER), EPISODE, { driveToken: 'tok-a' });
    expect(r.ok).toBe(true);
    expect(r.clientId).toBe('box-a2');
  });

  it('leaves an UNOWNED node available only under the explicit legacy opt-in', async () => {
    hoisted.state.clients = [node('box-unowned', null)];
    const denied = await dispatchStoryboardedEpisode(fakePool(OWNER), EPISODE, { driveToken: 'tok-a' });
    expect(denied.ok).toBe(false);          // fail closed by default

    process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'true';
    const allowed = await dispatchStoryboardedEpisode(fakePool(OWNER), EPISODE, { driveToken: 'tok-a' });
    expect(allowed.ok).toBe(true);          // the single-node operator box keeps working
    expect(allowed.clientId).toBe('box-unowned');
  });

  it('refuses when the series row has no owner at all', async () => {
    hoisted.state.clients = [node('box-a', OWNER)];
    const r = await dispatchStoryboardedEpisode(fakePool(null), EPISODE, { driveToken: 'tok-a' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no owner/i);
    expect(hoisted.enqueued).toHaveLength(0);
  });

  it('applies the same rule to the content.produce (Vids) render path', async () => {
    hoisted.state.clients = [node('box-b', STRANGER)];
    const denied = await dispatchEpisode(fakePool(OWNER), EPISODE_ROW, { ticketId: 'T-1' });
    expect(denied.ok).toBe(false);
    expect(hoisted.enqueued).toHaveLength(0);

    hoisted.state.clients = [node('box-a', OWNER)];
    const allowed = await dispatchEpisode(fakePool(OWNER), EPISODE_ROW, { ticketId: 'T-1' });
    expect(allowed.ok).toBe(true);
    expect(allowed.clientId).toBe('box-a');
    expect(hoisted.enqueued[0].env.input).toMatchObject({ name: 'content.produce' });
  });

  it('applies the same rule to episode assembly', async () => {
    hoisted.state.clients = [node('box-b', STRANGER)];
    const denied = await dispatchAssembly(fakePool(OWNER), EPISODE, { ticketId: 'T-1' });
    expect(denied.ok).toBe(false);
    expect(hoisted.enqueued).toHaveLength(0);

    hoisted.state.clients = [node('box-a', OWNER)];
    const allowed = await dispatchAssembly(fakePool(OWNER), EPISODE, { ticketId: 'T-1' });
    expect(allowed.ok).toBe(true);
    expect(allowed.clientId).toBe('box-a');
  });

  it('lets an operator drive any node (the operator identity is unchanged)', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OWNER;
    hoisted.state.clients = [node('box-b', STRANGER)];
    const r = await dispatchStoryboardedEpisode(fakePool(OWNER), EPISODE, { driveToken: 'tok-a' });
    expect(r.ok).toBe(true);
    expect(r.clientId).toBe('box-b');
  });
});
