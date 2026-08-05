/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Video Series dispatch: render episodes on the remote Vids node ONE AT A TIME, then assemble. Serialized because the node drives a single Chrome; resumable because a re-render is real money.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Node package dir + exe resolve through vids-node-availability (the old default was a controller-side path that has never existed on the node), and the storyboarded-render dispatch now checks the node is FREE before enqueueing — the reconciler sweeps every 20s and would otherwise dispatch straight into the nightly recap's window.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY: render-node selection is owner-scoped. findShellWorker/findVidsWorker picked on LIVENESS ALONE, so on a multi-user swarm one user's series rendered on whatever desktop happened to be connected — driving another person's logged-in Chrome and Google account with the requester's Drive token exported into that shell. The owner now comes from the SERIES ROW (video_series.user_sub, NOT NULL), never from the caller, and candidates run through filterUsableDevices BEFORE the preference order so a foreign VIDS_RENDER_CLIENT_ID pin resolves to null instead of executing. Guard: tests/unit/series-dispatch-device-ownership.spec.ts.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Await all journal-backed render, storyboarding, and assembly enqueues under trusted controller identity before persisting dispatch success.
 */
/**
 * @description Video Series — remote-node render dispatch.
 *
 * The `video-series` graph workflow hands off through the `video_series` / `video_episodes`
 * tables (the execution engine discards each bot's reply, so it cannot pass data between
 * stages). This module is what the render and assemble stages actually do:
 *
 *   1. Read the next episode of a series that is `scripted` but not yet `rendered`.
 *   2. Enqueue ONE `content.produce` task on the registered Vids worker.
 *   3. Record the taskId and mark the episode `rendering`.
 *
 * Two properties matter more than throughput here, and both were learned the expensive way:
 *
 *   SERIALIZED. The node drives a single logged-in Chrome. Two render chains against one
 *   browser re-open the same scene forever and finish nothing, while every retry is a paid
 *   generation. We dispatch episode N+1 only after N settles.
 *
 *   RESUMABLE. Every episode's state lives in Postgres, keyed by ticket. A retried or
 *   resumed run skips what is already `rendered` instead of re-rendering it.
 *
 * The character image is threaded through on every episode: it is the anchor that keeps a
 * cast from drifting between episodes, and it is the one argument a series cannot lose.
 *
 * @module app/series-dispatch
 */

import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { remoteClientRegistry } from '@/app/routes/remote-client-routes';
import { buildRenderPlan, SCREENPLAY_WRITER_AGENT_ID, type CastMember, type Scene } from '@/app/series-pipeline';
import { nodePkgDir, nodeExe, checkVidsNodeAvailability } from '@/app/vids-node-availability';
import { filterUsableDevices, type DeviceRequester } from '@/features/remote-client';

const logger = createChildLogger({ module: 'series-dispatch' });

export { SCREENPLAY_WRITER_AGENT_ID };

/** How many scene clips an episode is expected to yield (intro is prepended at assembly). */
const DEFAULT_SCENES = 4;

// Where the vids-operator package lives ON THE RENDER NODE, and the node binary that runs it. Both
// resolve through vids-node-availability so the availability probe and the render dispatch can never
// disagree about which directory the node's package is in. The old default here pointed at the
// controller's own legacy checkout path — a directory that has never existed on the node, so every
// dispatch shelled into nothing unless VIDS_NODE_PKG_DIR happened to be set.

/** True when a remote client can run a shell command (the render transport, as in lora-train-dispatch). */
function isShellWorker(c: { capabilities?: unknown }): boolean {
  const caps = Array.isArray(c.capabilities) ? (c.capabilities as string[]) : [];
  return caps.includes('shell.exec');
}

/** A registered node as these selectors read it. `ownerSub` is what makes the pick a privilege
 *  decision rather than a load-balancing one — it is the person whose desktop this is. */
interface CandidateNode {
  clientId: string;
  agentId?: string;
  status?: string;
  healthy?: boolean;
  capabilities?: unknown;
  tags?: unknown;
  ownerSub?: string | null;
}

/** Every connected node, or an empty list when the registry is unavailable. */
function connectedNodes(): CandidateNode[] {
  try { return remoteClientRegistry.listClients() as CandidateNode[]; } catch { return []; }
}

/**
 * @description Pick an online worker that can run the node-side renderer, restricted to the
 * machines this requester is allowed to drive.
 *
 * OWNERSHIP IS PART OF THE FILTER, not a check bolted on afterwards: a render node is somebody's
 * real desktop with their Google session open, and the render shells out with the requester's Drive
 * access token in its environment. Narrowing the candidates BEFORE the preference order is what
 * stops `VIDS_RENDER_CLIENT_ID` — a deployment-wide pin — from parking every user's render on one
 * person's box; a pin the requester may not use now resolves to null (clean "no node" error).
 * @param requester - The identity the render runs on behalf of (the series owner).
 * @returns {{clientId:string, agentId?:string} | null} the worker, or null when none is usable
 */
function findShellWorker(requester: DeviceRequester): { clientId: string; agentId?: string } | null {
  const candidates = filterUsableDevices(requester, connectedNodes().filter(isShellWorker));
  if (!candidates.length) return null;
  const preferred = (process.env.VIDS_RENDER_CLIENT_ID || '').trim();
  if (preferred) return candidates.find((c) => c.clientId === preferred) ?? null;
  return candidates.find((c) => (c.status ?? 'online') === 'online' && (c.healthy ?? true)) ?? candidates[0];
}

/** @description One episode row, as the render stage needs it. */
export interface EpisodeRow {
  episodeId: string;
  seriesId: string;
  ordinal: number;
  title: string;
  scriptMd: string | null;
  animationMd: string | null;
  imagePromptsMd: string | null;
}

/** @description Result of trying to push one episode at the node. */
export interface DispatchResult {
  ok: boolean;
  episodeId?: string;
  taskId?: string;
  clientId?: string;
  error?: string;
}

/** True when a remote client advertises the Vids tools. Mirrors vids-routes.isVidsWorker. */
function isVidsWorker(c: { capabilities?: unknown; tags?: unknown }): boolean {
  const caps = Array.isArray(c.capabilities) ? (c.capabilities as string[]) : [];
  const tags = Array.isArray(c.tags) ? (c.tags as string[]) : [];
  return caps.includes('content.produce') || caps.includes('vids.generate') || caps.includes('content.next')
    || tags.includes('vids') || tags.includes('creative');
}

/**
 * @description Pick an online Vids worker this requester may drive, or null when none is usable.
 * Same ownership rule as findShellWorker: the node runs a logged-in Google Vids session belonging to
 * a person, so liveness alone is not a licence to render somebody else's episode on it.
 * @param requester - The identity the render runs on behalf of (the series owner).
 * @returns {{clientId: string, agentId?: string} | null} the worker, or null
 */
function findVidsWorker(requester: DeviceRequester): { clientId: string; agentId?: string } | null {
  const candidates = filterUsableDevices(requester, connectedNodes().filter(isVidsWorker));
  if (!candidates.length) return null;
  const online = candidates.find((c) => (c.status ?? 'online') === 'online' && (c.healthy ?? true));
  return online ?? candidates[0];
}

/**
 * @description The identity a render for this series runs as: the series' OWN owner row.
 *
 * Deliberately read from `video_series.user_sub` (NOT NULL) rather than accepted as an argument.
 * Every caller of these dispatchers is internal — the orchestrator, the reconciler on its 20s timer,
 * an operator clicking render — and a sub that travels as a parameter through three layers is a sub
 * that can arrive wrong. The row is the one place that cannot disagree with who owns the series.
 * @param pool - Database pool.
 * @param seriesId - The series being rendered.
 * @returns The owner's OIDC sub, or null when the series is gone (then nothing may be dispatched).
 */
async function seriesOwnerSub(pool: Pool, seriesId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT user_sub FROM video_series WHERE series_id = $1`, [seriesId]);
  const sub = (rows[0] as { user_sub?: string | null } | undefined)?.user_sub;
  return sub ? String(sub) : null;
}

/** The message an owner-scoped miss returns. Same wording whichever selector missed, because the
 *  operator-visible fact is identical: no node this series' owner may drive is available. */
const NO_USABLE_NODE = 'No render node is available to this series\' owner. Connect a node on that '
  + 'account (`oshal-vids worker`), or have an operator bind an existing node to it.';

/**
 * @description True while any episode of this series is still occupying the node. The node
 * drives one Chrome; a second concurrent render is the failure mode that burned a night of
 * credits, so the caller must never dispatch past a `rendering` episode.
 * @param {Pool} pool database pool
 * @param {string} seriesId the series
 * @returns {Promise<boolean>} whether a render is in flight
 */
export async function isRenderInFlight(pool: Pool, seriesId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM video_episodes WHERE series_id = $1 AND status = 'rendering' LIMIT 1`,
    [seriesId],
  );
  return rows.length > 0;
}

/**
 * @description The next episode to render: the lowest-ordinal one that has a script and has
 * not been rendered. Returns null when the series is fully rendered.
 * @param {Pool} pool database pool
 * @param {string} seriesId the series
 * @returns {Promise<EpisodeRow | null>} the episode, or null when none remain
 */
export async function nextEpisodeToRender(pool: Pool, seriesId: string): Promise<EpisodeRow | null> {
  const { rows } = await pool.query(
    `SELECT episode_id, series_id, ordinal, title, script_md, animation_md, image_prompts_md
       FROM video_episodes
      WHERE series_id = $1 AND status = 'scripted'
      ORDER BY ordinal ASC
      LIMIT 1`,
    [seriesId],
  );
  const r = rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    episodeId: String(r.episode_id),
    seriesId: String(r.series_id),
    ordinal: Number(r.ordinal),
    title: String(r.title),
    scriptMd: (r.script_md as string | null) ?? null,
    animationMd: (r.animation_md as string | null) ?? null,
    imagePromptsMd: (r.image_prompts_md as string | null) ?? null,
  };
}

/**
 * @description Enqueue ONE episode on the Vids worker and mark it `rendering`.
 *
 * Nothing is marked rendering unless the enqueue actually succeeded — a phantom `rendering`
 * row would block the whole series behind an episode the node never received.
 *
 * @param {Pool} pool database pool
 * @param {EpisodeRow} episode the episode to render
 * @param {{orientation?: string, scenes?: number, characterImagePath?: string | null, ticketId?: string}} opts series-level render options
 * @returns {Promise<DispatchResult>} the enqueue outcome, never throwing
 */
export async function dispatchEpisode(
  pool: Pool,
  episode: EpisodeRow,
  opts: { orientation?: string; scenes?: number; characterImagePath?: string | null; ticketId?: string } = {},
): Promise<DispatchResult> {
  if (!episode.scriptMd) {
    return { ok: false, episodeId: episode.episodeId, error: 'episode has no script — the screenplay-writer stage has not run' };
  }
  // Same gate as the storyboarded path: nothing reaches the node while something else owns it.
  const free = await checkVidsNodeAvailability(pool, { skipProbe: true });
  if (!free.available) return { ok: false, episodeId: episode.episodeId, error: `the render node is not free: ${free.reason}` };

  const ownerSub = await seriesOwnerSub(pool, episode.seriesId);
  if (!ownerSub) return { ok: false, episodeId: episode.episodeId, error: 'series not found — refusing to render work with no owner' };

  const worker = findVidsWorker({ sub: ownerSub });
  if (!worker) {
    return { ok: false, episodeId: episode.episodeId, error: NO_USABLE_NODE };
  }

  const taskId = randomUUID();
  const envelope = {
    taskId,
    correlationId: opts.ticketId || taskId,
    fromAgentId: SCREENPLAY_WRITER_AGENT_ID,
    toAgentId: worker.agentId ?? worker.clientId,
    intent: 'mcp.call-tool' as const,
    input: {
      name: 'content.produce',
      arguments: {
        title: episode.title,
        script: episode.scriptMd,
        beats: opts.scenes ?? DEFAULT_SCENES,
        orientation: opts.orientation ?? 'Landscape',
        // The character-consistency anchor. `POST /api/vids/story` drops this; we do not.
        ...(opts.characterImagePath ? { characterImage: opts.characterImagePath } : {}),
      },
    },
    createdAt: new Date().toISOString(),
  };

  try {
    const task = await runWithSystemIdentity(() => remoteClientRegistry.enqueueTask(worker.clientId, envelope));
    await pool.query(
      `UPDATE video_episodes
          SET status = 'rendering', vids_job_id = $2, error = NULL, updated_at = now()
        WHERE episode_id = $1`,
      [episode.episodeId, task.taskId],
    );
    logger.info(
      { episodeId: episode.episodeId, ordinal: episode.ordinal, taskId: task.taskId, clientId: worker.clientId },
      'series episode dispatched to the Vids node',
    );
    return { ok: true, episodeId: episode.episodeId, taskId: task.taskId, clientId: worker.clientId };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'enqueue failed';
    logger.error({ err, episodeId: episode.episodeId, clientId: worker.clientId }, 'series episode dispatch failed');
    await pool.query(
      `UPDATE video_episodes SET status = 'failed', error = $2, updated_at = now() WHERE episode_id = $1`,
      [episode.episodeId, error],
    ).catch(() => { /* the dispatch error is what matters */ });
    return { ok: false, episodeId: episode.episodeId, error };
  }
}

/**
 * @description Advance a series by at most ONE episode. Idempotent and safe to call on every
 * poll: it dispatches nothing while a render is in flight, and nothing when the series is done.
 * @param {Pool} pool database pool
 * @param {string} seriesId the series to advance
 * @returns {Promise<{state: 'in_flight'|'dispatched'|'complete'|'blocked', detail?: DispatchResult}>} what happened
 */
export async function advanceSeries(
  pool: Pool,
  seriesId: string,
): Promise<{ state: 'in_flight' | 'dispatched' | 'complete' | 'blocked'; detail?: DispatchResult }> {
  if (await isRenderInFlight(pool, seriesId)) return { state: 'in_flight' };

  const episode = await nextEpisodeToRender(pool, seriesId);
  if (!episode) return { state: 'complete' };

  const { rows } = await pool.query(
    `SELECT ticket_id, orientation, scenes_per_episode, character_image_path FROM video_series WHERE series_id = $1`,
    [seriesId],
  );
  const s = rows[0] as Record<string, unknown> | undefined;
  const detail = await dispatchEpisode(pool, episode, {
    ticketId: (s?.ticket_id as string | null) ?? undefined,
    orientation: (s?.orientation as string | undefined) ?? 'Landscape',
    scenes: Number(s?.scenes_per_episode ?? DEFAULT_SCENES),
    characterImagePath: (s?.character_image_path as string | null) ?? null,
  });
  return detail.ok ? { state: 'dispatched', detail } : { state: 'blocked', detail };
}

/**
 * @description RENDER — hand one storyboarded episode to the node: its stills (by Drive id) and the
 * animation prompt for each. The node downloads the stills, animates each in Google Vids, stitches
 * them, and saves the episode.
 *
 * Transport is `shell.exec` on the connected worker, the same gated path the LoRA studio uses to
 * drive its GPU box (lora-train-dispatch.ts). The Vids worker's `content.produce` cannot be used
 * here: it splits PROSE into beats and has no way to accept one still per scene, which is exactly
 * what a storyboarded episode is.
 *
 * @param {Pool} pool database pool
 * @param {string} episodeId a storyboarded episode
 * @param {{driveToken: string, ticketId?: string}} opts the caller's Drive token (frame fetch + upload)
 * @returns {Promise<DispatchResult>} the enqueue outcome
 */
export async function dispatchStoryboardedEpisode(
  pool: Pool,
  episodeId: string,
  opts: { driveToken: string; ticketId?: string },
): Promise<DispatchResult> {
  const { rows } = await pool.query(
    `SELECT e.episode_id, e.title, e.ordinal, e.scenes, e.frame_ids, e.status,
            s.title AS series_title, s.cast_bible, s.orientation, s.intro_clip, s.user_sub
       FROM video_episodes e JOIN video_series s ON s.series_id = e.series_id
      WHERE e.episode_id = $1`, [episodeId],
  );
  const e = rows[0] as Record<string, unknown> | undefined;
  if (!e) return { ok: false, error: `episode ${episodeId} not found` };
  if (e.status !== 'storyboarded') return { ok: false, episodeId, error: `episode is '${String(e.status)}', not 'storyboarded'` };

  const scenes = (Array.isArray(e.scenes) ? e.scenes : []) as Scene[];
  const frameIds = (Array.isArray(e.frame_ids) ? e.frame_ids : []) as string[];
  if (!scenes.length || scenes.length !== frameIds.length) {
    return { ok: false, episodeId, error: `scene/frame mismatch: ${scenes.length} scenes, ${frameIds.length} frames` };
  }

  // The node gate belongs HERE, not only in the pump. Everything that renders comes through this
  // function — the pump, the reconciler advancing a series on its own timer, and an operator
  // clicking render — and the reconciler is the one nobody is watching: it sweeps every 20s and will
  // happily dispatch a storyboarded episode into the middle of the nightly recap. `skipProbe` keeps
  // this instant (registry + database + the clock, no round trip to the node) so a 20s sweep never
  // blocks on it; the pump's own full probe is what additionally catches a recap running LATE.
  const free = await checkVidsNodeAvailability(pool, { skipProbe: true });
  if (!free.available) return { ok: false, episodeId, error: `the render node is not free: ${free.reason}` };

  // The owner comes off the joined series row. This dispatch exports the caller's Drive access
  // token into a PowerShell environment on the chosen box, so picking a box the owner does not own
  // hands their Google token to somebody else's machine — the reason selection is identity-scoped.
  const ownerSub = (e.user_sub as string | null) ?? null;
  if (!ownerSub) return { ok: false, episodeId, error: 'series has no owner — refusing to render' };

  const worker = findShellWorker({ sub: ownerSub });
  if (!worker) return { ok: false, episodeId, error: NO_USABLE_NODE };

  const plan = buildRenderPlan(scenes, frameIds, (Array.isArray(e.cast_bible) ? e.cast_bible : []) as CastMember[]);
  // The plan travels as base64 JSON so no quoting on either side can corrupt a prompt.
  const planB64 = Buffer.from(JSON.stringify({
    episodeId,
    title: String(e.title),
    series: String(e.series_title),
    orientation: String(e.orientation ?? 'Landscape'),
    // The show's cached title sequence, prepended at the stitch. Every episode of a show opens with
    // the same one — it is rendered once and reused forever, which is the Breakfast Crew shape.
    introClip: (e.intro_clip as string | null) ?? null,
    scenes: plan,
  }), 'utf8').toString('base64');

  const command = [
    `$p='${nodePkgDir()}'`,
    'Set-Location $p',
    `$env:VIDS_DRIVE_ACCESS_TOKEN='${opts.driveToken}'`,
    '$env:VIDS_RENDER_TIMEOUT_MS=\'600000\'',
    '$env:VIDS_SCENE_ATTEMPTS=\'3\'',
    `& '${nodeExe()}' episode-render.js '${planB64}'`,
  ].join('; ');

  const taskId = randomUUID();
  try {
    const task = await runWithSystemIdentity(() => remoteClientRegistry.enqueueTask(worker.clientId, {
      taskId,
      correlationId: opts.ticketId || taskId,
      fromAgentId: SCREENPLAY_WRITER_AGENT_ID,
      toAgentId: worker.agentId ?? worker.clientId,
      intent: 'mcp.call-tool' as const,
      input: { name: 'shell.exec', arguments: { command } },
      createdAt: new Date().toISOString(),
    }));
    await pool.query(
      `UPDATE video_episodes SET status='rendering', vids_job_id=$2, error=NULL, updated_at=now() WHERE episode_id=$1`,
      [episodeId, task.taskId],
    );
    logger.info({ episodeId, taskId: task.taskId, scenes: plan.length, clientId: worker.clientId }, 'storyboarded episode dispatched');
    return { ok: true, episodeId, taskId: task.taskId, clientId: worker.clientId };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'enqueue failed';
    logger.error({ err, episodeId }, 'storyboarded episode dispatch failed');
    return { ok: false, episodeId, error };
  }
}

/**
 * @description Post-production: ask the node to assemble one rendered episode. Assembly runs
 * where the media already is — the scene clips live in the node's content folder, and shipping
 * them to the controller just to stitch them would be a needless round-trip.
 * @param {Pool} pool database pool
 * @param {string} episodeId the rendered episode
 * @param {{ticketId?: string, introClip?: string}} opts assembly options
 * @returns {Promise<DispatchResult>} the enqueue outcome
 */
export async function dispatchAssembly(
  pool: Pool,
  episodeId: string,
  opts: { ticketId?: string; introClip?: string } = {},
): Promise<DispatchResult> {
  const { rows } = await pool.query(
    `SELECT e.episode_id, e.title, e.clip_paths, e.status, s.title AS series_title, s.user_sub
       FROM video_episodes e JOIN video_series s ON s.series_id = e.series_id
      WHERE e.episode_id = $1`,
    [episodeId],
  );
  const e = rows[0] as Record<string, unknown> | undefined;
  if (!e) return { ok: false, error: `episode ${episodeId} not found` };
  if (e.status !== 'rendered') return { ok: false, episodeId, error: `episode is '${String(e.status)}', not 'rendered'` };

  const clips = Array.isArray(e.clip_paths) ? (e.clip_paths as string[]) : [];
  if (!clips.length) return { ok: false, episodeId, error: 'no clip paths recorded — nothing to assemble' };

  // Assembly reads this owner's clips out of the node's content folder and writes the finished
  // episode back there, so it is owner-scoped for the same reason the render is.
  const ownerSub = (e.user_sub as string | null) ?? null;
  if (!ownerSub) return { ok: false, episodeId, error: 'series has no owner — refusing to assemble' };

  const worker = findVidsWorker({ sub: ownerSub });
  if (!worker) return { ok: false, episodeId, error: NO_USABLE_NODE };

  const taskId = randomUUID();
  try {
    const task = await runWithSystemIdentity(() => remoteClientRegistry.enqueueTask(worker.clientId, {
      taskId,
      correlationId: opts.ticketId || taskId,
      fromAgentId: SCREENPLAY_WRITER_AGENT_ID,
      toAgentId: worker.agentId ?? worker.clientId,
      intent: 'mcp.call-tool' as const,
      input: {
        name: 'episode.assemble',
        arguments: {
          episodeId,
          title: String(e.title),
          series: String(e.series_title),
          clips,
          ...(opts.introClip ? { introClip: opts.introClip } : {}),
        },
      },
      createdAt: new Date().toISOString(),
    }));
    logger.info({ episodeId, taskId: task.taskId, clips: clips.length }, 'episode assembly dispatched');
    return { ok: true, episodeId, taskId: task.taskId, clientId: worker.clientId };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'enqueue failed';
    logger.error({ err, episodeId }, 'episode assembly dispatch failed');
    return { ok: false, episodeId, error };
  }
}
