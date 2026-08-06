/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the apply-visibility
 *   change. Three regressions this locks down: (1) the desktop worker's narration must be append-only,
 *   path-safe, capped, and must KEEP the caption when the image is unusable — telemetry that throws
 *   away a progress line on a bad frame is worse than none; (2) a story frame must only be readable
 *   via a filename the ticket's own index lists, so a crafted name can neither traverse the workspace
 *   nor read another ticket's screenshots; (3) the queue snapshot must report a worker that heartbeats
 *   but has STOPPED CLAIMING as wedged-and-unavailable, because that is the failure this queue
 *   actually has and it previously rendered as an ordinary empty queue. Also pins the narration
 *   instruction into the dispatch prompt — drop it and every run goes silent again with no test red.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Keep queue reachability aligned with hardened browser dispatch: only exact browser_control plus browser_pilot_consent markers enter the worker picker.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Keep target-selection behavior groups below the repository function-length limit.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The store resolves WORKSPACE_ROOT at MODULE LOAD, and vitest hoists `import` above plain top-level
// statements — so the temp root must be set from inside vi.hoisted or apply-story would bind the
// production default and write real files outside the test sandbox.
const hoisted = vi.hoisted(() => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-story-spec-'));
  process.env.SHARED_WORKSPACE_ROOT = root;
  const state = {
    depth: 0, status: 'online', healthy: true,
    capabilities: ['codex.exec', 'browser_control'] as string[],
    tags: ['browser_pilot_consent'] as string[], extra: [] as Array<Record<string, unknown>>,
  };
  return { root, state };
});

vi.mock('@/app/routes/remote-client-routes', () => ({
  remoteClientRegistry: {
    listClients: () => [{
      clientId: 'oshal-chat-test',
      tailnetHostname: 'edge-node-1',
      status: hoisted.state.status,
      healthy: hoisted.state.healthy,
      capabilities: hoisted.state.capabilities,
      tags: hoisted.state.tags,
      taskQueueDepth: hoisted.state.depth,
      lastSeenAt: '2026-07-23T16:00:00.000Z',
    }, ...hoisted.state.extra],
  },
  taskWorkspaceFolder: (id: string) => require('node:path').join(hoisted.root, id),
}));

import { recordApplyBeat, readApplyStory, resolveApplyShotPath } from '@/app/apply-story';
import { describeApplyWorker, listApplyWorkers } from '@/app/apply-queue-status';

/** A real 1x1 PNG — small, but genuinely decodable bytes rather than a fake string. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

afterAll(() => {
  try { require('node:fs').rmSync(hoisted.root, { recursive: true, force: true }); } catch { /* temp dir */ }
});

beforeEach(() => {
  hoisted.state.depth = 0;
  hoisted.state.status = 'online';
  hoisted.state.healthy = true;
  hoisted.state.capabilities = ['codex.exec', 'browser_control'];
  hoisted.state.tags = ['browser_pilot_consent'];
  hoisted.state.extra = [];
});

describe('apply story — the worker\'s narration of a run', () => {
  it('appends beats in order and persists the frame it was looking at', async () => {
    const ticket = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const first = await recordApplyBeat({ ticketId: ticket, label: 'opened the posting', imageBase64: PNG_1PX });
    const second = await recordApplyBeat({ ticketId: ticket, label: 'uploaded resume', note: 'Resume_ATS.pdf accepted' });

    expect(first?.seq).toBe(1);
    expect(first?.file).toMatch(/^001-opened-the-posting\.png$/);
    expect(second?.seq).toBe(2);
    expect(second?.file).toBeUndefined();      // caption-only beat is legitimate, not a failure

    const beats = await readApplyStory(ticket);
    expect(beats.map((b) => b.label)).toEqual(['opened the posting', 'uploaded resume']);
    expect(beats[1].note).toBe('Resume_ATS.pdf accepted');
  });

  it('keeps the caption when the image is unusable — a bad frame must not lose the progress line', async () => {
    const ticket = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
    const beat = await recordApplyBeat({ ticketId: ticket, label: 'review pass', imageBase64: '!!!not-base64!!!' });
    expect(beat).not.toBeNull();
    expect(beat?.label).toBe('review pass');
    expect(beat?.file).toBeUndefined();
    expect((await readApplyStory(ticket)).length).toBe(1);
  });

  it('refuses a ticket id that is not a single safe path segment', async () => {
    expect(await recordApplyBeat({ ticketId: '../../etc', label: 'traversal' })).toBeNull();
    expect(await readApplyStory('../../etc')).toEqual([]);
  });

  it('caps beats per ticket so a looping worker cannot fill the workspace volume', async () => {
    const ticket = 'cccccccc-3333-4333-8333-cccccccccccc';
    for (let i = 0; i < 62; i++) await recordApplyBeat({ ticketId: ticket, label: `step ${i}` });
    const beats = await readApplyStory(ticket);
    expect(beats.length).toBe(60);
    expect(await recordApplyBeat({ ticketId: ticket, label: 'one too many' })).toBeNull();
  });

  it('serves a frame ONLY under a filename the ticket\'s own index lists', async () => {
    const ticket = 'dddddddd-4444-4444-8444-dddddddddddd';
    await recordApplyBeat({ ticketId: ticket, label: 'confirmation', imageBase64: PNG_1PX });

    expect(await resolveApplyShotPath(ticket, '001-confirmation.png')).toContain('001-confirmation.png');
    // Traversal, and a real-but-unlisted sibling file, are both refused.
    expect(await resolveApplyShotPath(ticket, '../../../etc/passwd')).toBeNull();
    expect(await resolveApplyShotPath(ticket, 'story.json')).toBeNull();
    expect(await resolveApplyShotPath(ticket, 'not-a-frame.png')).toBeNull();
  });
});

/** These blocks exercise REACHABILITY (online / wedged / capability), not ownership, so they ask as
 *  the platform. Owner-scoping has its own guard: tests/unit/device-access-dispatch.spec.ts. */
const PLATFORM = { system: true } as const;

describe('apply queue — desktop worker reachability', () => {
  it('reports an idle, claiming worker as available', () => {
    const w = describeApplyWorker(undefined, PLATFORM);
    expect(w.connected).toBe(true);
    expect(w.available).toBe(true);
    expect(w.wedged).toBe(false);
    expect(w.hostname).toBe('edge-node-1');
  });

  it('names the WEDGED worker instead of showing an ordinary empty queue', () => {
    // Heartbeating and healthy, but tasks are piling up unclaimed — the 2026-07-21 failure. We
    // dispatch one at a time, so a non-empty node queue always means the last hand-off was dropped.
    hoisted.state.depth = 2;
    const w = describeApplyWorker(undefined, PLATFORM);
    expect(w.connected).toBe(true);      // must NOT read as disconnected — it is plainly online
    expect(w.wedged).toBe(true);
    expect(w.available).toBe(false);     // matches pickApplyClient, which would refuse to dispatch
    expect(w.detail).toMatch(/stopped claiming/i);
    expect(w.detail).toMatch(/restart/i); // tells the operator what to actually do
  });

  it('reports no worker when nothing on the box can run a submission', () => {
    hoisted.state.capabilities = [];
    const w = describeApplyWorker(undefined, PLATFORM);
    expect(w.connected).toBe(false);
    expect(w.available).toBe(false);
    expect(w.detail).toMatch(/leaf client/i);
    expect(w.detail).toMatch(/authorized browser-control worker/i);
    expect(w.detail).toMatch(/browser-pilot consent/i);
  });

  it('does not list a browser-capable node until browser-pilot consent is explicit', () => {
    hoisted.state.tags = [];
    const status = describeApplyWorker(undefined, PLATFORM);
    expect(status.connected).toBe(false);
    expect(listApplyWorkers(PLATFORM).workers).toEqual([]);
  });

  it('treats an offline or unhealthy worker as unavailable but still connected', () => {
    hoisted.state.status = 'offline';
    const w = describeApplyWorker(undefined, PLATFORM);
    expect(w.available).toBe(false);
    expect(w.wedged).toBe(false);        // offline is not wedged — different fix for the operator
  });
});

describe('apply target-computer picker — choosing the leaf node', () => {
  it('lists a single connected node and marks it the default', () => {
    const { workers, defaultClientId } = listApplyWorkers(PLATFORM);
    expect(workers).toHaveLength(1);
    expect(workers[0].hostname).toBe('edge-node-1');
    expect(workers[0].isDefault).toBe(true);
    expect(workers[0].available).toBe(true);
    expect(defaultClientId).toBe('oshal-chat-test');
  });

  it('lists BOTH the desktop and a remote leaf node, defaulting to the preferred host', () => {
    hoisted.state.extra = [{
      clientId: 'oshal-chat-remote', tailnetHostname: 'remote-render-box',
      status: 'online', healthy: true, capabilities: ['codex.exec', 'browser_control'],
      tags: ['browser_pilot_consent'], taskQueueDepth: 0,
    }];
    const { workers, defaultClientId } = listApplyWorkers(PLATFORM);
    expect(workers.map((w) => w.hostname).sort()).toEqual(['edge-node-1', 'remote-render-box']);
    // APPLY_EDGE_HOSTNAME defaults to edge-node-1, so it wins the default even with a remote present.
    expect(defaultClientId).toBe('oshal-chat-test');
    expect(workers.find((w) => w.clientId === 'oshal-chat-remote')!.isDefault).toBe(false);
  });
});

describe('apply target-computer picker — refusal and selected-node behavior', () => {
  it('a browser-authorized node without codex/shell execution is NOT a candidate', () => {
    hoisted.state.extra = [{
      clientId: 'oshal-chat-noexec', tailnetHostname: 'viewer-only',
      status: 'online', healthy: true, capabilities: ['chat', 'browser_control'],
      tags: ['browser_pilot_consent'], taskQueueDepth: 0,
    }];
    expect(listApplyWorkers(PLATFORM).workers.map((w) => w.clientId)).toEqual(['oshal-chat-test']);
  });

  it('describeApplyWorker reports the SELECTED node, not just the default', () => {
    hoisted.state.extra = [{
      clientId: 'oshal-chat-remote', tailnetHostname: 'remote-render-box',
      status: 'online', healthy: true, capabilities: ['codex.exec', 'browser_control'],
      tags: ['browser_pilot_consent'], taskQueueDepth: 3, // wedged
    }];
    const chosen = describeApplyWorker('oshal-chat-remote', PLATFORM);
    expect(chosen.hostname).toBe('remote-render-box');
    expect(chosen.wedged).toBe(true);
    expect(chosen.available).toBe(false);
    // The default node (edge-node-1) is still fine — selection must not leak its state.
    expect(describeApplyWorker('oshal-chat-test', PLATFORM).available).toBe(true);
  });

  it('falls back to the default node when the selected id is unknown/offline', () => {
    const chosen = describeApplyWorker('oshal-chat-vanished', PLATFORM);
    expect(chosen.clientId).toBe('oshal-chat-test');
    expect(chosen.available).toBe(true);
  });
});

// The apply-prompt narration guard moved to the career-hunter package with the prompt itself:
// career-hunter/lib/apply-prompt.test.mjs asserts the /api/apply/shot beat instruction, the bound
// ticket id, the "never abort over telemetry" rule, and the anti-fabrication line. Core no longer
// owns buildApplyPrompt (it's loaded via apply-prompt-bridge), so that guard lives with the content.
