/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Video Series dispatch: render episodes on the remote Vids node ONE AT A TIME, then assemble. Serialized because the node drives a single Chrome; resumable because a re-render is real money.
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
import { remoteClientRegistry } from '@/app/routes/remote-client-routes';
import { buildRenderPlan, SCREENPLAY_WRITER_AGENT_ID, type CastMember, type Scene } from '@/app/series-pipeline';

const logger = createChildLogger({ module: 'series-dispatch' });

export { SCREENPLAY_WRITER_AGENT_ID };

/** How many scene clips an episode is expected to yield (intro is prepended at assembly). */
const DEFAULT_SCENES = 4;

/** Where the vids-operator package lives on the render node, and the node binary that runs it. */
const NODE_PKG_DIR = process.env.VIDS_NODE_PKG_DIR
  || 'C:\\Projects\\open-shal-swarm-harness-agent-llm\\packages\\oshal-vids-operator';
const NODE_EXE = process.env.VIDS_NODE_EXE || 'C:\\Program Files\\nodejs\\node.exe';

/** True when a remote client can run a shell command (the render transport, as in lora-train-dispatch). */
function isShellWorker(c: { capabilities?: unknown }): boolean {
  const caps = Array.isArray(c.capabilities) ? (c.capabilities as string[]) : [];
  return caps.includes('shell.exec');
}

/** @description Pick an online worker that can run the node-side renderer. @returns {{clientId:string, agentId?:string} | null} the worker */
function findShellWorker(): { clientId: string; agentId?: string } | null {
  let clients: Array<{ clientId: string; agentId?: string; status?: string; healthy?: boolean; capabilities?: unknown }> = [];
  try { clients = remoteClientRegistry.listClients() as typeof clients; } catch { clients = []; }
  const candidates = clients.filter(isShellWorker);
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
 * @description Pick an online Vids worker, or null when none is connected.
 * @returns {{clientId: string, agentId?: string} | null} the worker, or null
 */
function findVidsWorker(): { clientId: string; agentId?: string } | null {
  let clients: Array<{ clientId: string; agentId?: string; status?: string; healthy?: boolean; capabilities?: unknown; tags?: unknown }> = [];
  try { clients = remoteClientRegistry.listClients() as typeof clients; } catch { clients = []; }
  const candidates = clients.filter(isVidsWorker);
  if (!candidates.length) return null;
  const online = candidates.find((c) => (c.status ?? 'online') === 'online' && (c.healthy ?? true));
  return online ?? candidates[0];
}

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
  const worker = findVidsWorker();
  if (!worker) {
    return {
      ok: false,
      episodeId: episode.episodeId,
      error: 'No Vids worker is registered. Start one on a machine with a screen: `oshal-vids worker`.',
    };
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
    const task = remoteClientRegistry.enqueueTask(worker.clientId, envelope);
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
            s.title AS series_title, s.cast_bible, s.orientation
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

  const worker = findShellWorker();
  if (!worker) return { ok: false, episodeId, error: 'No render node is connected (no worker advertising shell.exec).' };

  const plan = buildRenderPlan(scenes, frameIds, (Array.isArray(e.cast_bible) ? e.cast_bible : []) as CastMember[]);
  // The plan travels as base64 JSON so no quoting on either side can corrupt a prompt.
  const planB64 = Buffer.from(JSON.stringify({
    episodeId,
    title: String(e.title),
    series: String(e.series_title),
    orientation: String(e.orientation ?? 'Landscape'),
    scenes: plan,
  }), 'utf8').toString('base64');

  const command = [
    `$p='${NODE_PKG_DIR}'`,
    'Set-Location $p',
    `$env:VIDS_DRIVE_ACCESS_TOKEN='${opts.driveToken}'`,
    '$env:VIDS_RENDER_TIMEOUT_MS=\'600000\'',
    '$env:VIDS_SCENE_ATTEMPTS=\'3\'',
    `& '${NODE_EXE}' episode-render.js '${planB64}'`,
  ].join('; ');

  const taskId = randomUUID();
  try {
    const task = remoteClientRegistry.enqueueTask(worker.clientId, {
      taskId,
      correlationId: opts.ticketId || taskId,
      fromAgentId: SCREENPLAY_WRITER_AGENT_ID,
      toAgentId: worker.agentId ?? worker.clientId,
      intent: 'mcp.call-tool' as const,
      input: { name: 'shell.exec', arguments: { command } },
      createdAt: new Date().toISOString(),
    });
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
    `SELECT e.episode_id, e.title, e.clip_paths, e.status, s.title AS series_title
       FROM video_episodes e JOIN video_series s ON s.series_id = e.series_id
      WHERE e.episode_id = $1`,
    [episodeId],
  );
  const e = rows[0] as Record<string, unknown> | undefined;
  if (!e) return { ok: false, error: `episode ${episodeId} not found` };
  if (e.status !== 'rendered') return { ok: false, episodeId, error: `episode is '${String(e.status)}', not 'rendered'` };

  const clips = Array.isArray(e.clip_paths) ? (e.clip_paths as string[]) : [];
  if (!clips.length) return { ok: false, episodeId, error: 'no clip paths recorded — nothing to assemble' };

  const worker = findVidsWorker();
  if (!worker) return { ok: false, episodeId, error: 'No Vids worker is registered.' };

  const taskId = randomUUID();
  try {
    const task = remoteClientRegistry.enqueueTask(worker.clientId, {
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
    });
    logger.info({ episodeId, taskId: task.taskId, clips: clips.length }, 'episode assembly dispatched');
    return { ok: true, episodeId, taskId: task.taskId, clientId: worker.clientId };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'enqueue failed';
    logger.error({ err, episodeId }, 'episode assembly dispatch failed');
    return { ok: false, episodeId, error };
  }
}
