/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The conductor: one function that walks a video series through write -> approve -> storyboard -> render -> done, one safe step per call. Idempotent, resumable, and it stops dead at the approval gate so nothing an image or a clip costs is spent without the operator's go.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Ran the render reconciler sweep under runWithSystemIdentity — a cross-owner background sweep over the RLS video_episodes table; SYSTEM keeps it visible once OSHAL_DB_GUC_STRICT denies the identity-less case.
 */
/**
 * @description Video Series — the orchestrator.
 *
 * The stage functions each do one thing. This is the conductor that decides which one runs next,
 * from the series' own state. It is the difference between "a set of parts" and "a thing you submit
 * once and watch finish".
 *
 * Two properties are the whole design:
 *
 *   IDEMPOTENT & RESUMABLE. `advanceVideoSeries` does exactly one safe step and returns. Call it
 *   again and it does the next. A crash, a restart, or a retry loses nothing — the series' state
 *   (and each episode's) lives in Postgres, so the conductor always knows where it stopped. This is
 *   also what makes a re-run skip what is already rendered instead of paying to render it twice.
 *
 *   THE GATE IS ABSOLUTE. The one edge the conductor will NOT cross on its own is
 *   awaiting_approval -> storyboarding. That is the last free moment: scripts are written (an LLM
 *   call), but no image and no clip has been paid for. Approval is a human action (`approveSeries`).
 *   After it, everything runs; before it, nothing that costs money does.
 *
 * The stage functions are injectable so the whole state machine can be tested without spending a
 * cent — the defaults are the real ones.
 *
 * @module app/series-orchestrator
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import type { AppContext } from '@/app/composition/app-context';
import { BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import { getValidAccessToken } from '@/app/routes/connectors-routes';
import { getVertexAccessToken } from '@/features/video-generation';
import { writeSeries, storyboardEpisode } from '@/app/series-pipeline';
import { isRenderInFlight, dispatchStoryboardedEpisode } from '@/app/series-dispatch';
import { uploadFrameToDrive } from '@/app/series-drive';
import { remoteClientRegistry } from '@/app/routes/remote-client-routes';

const logger = createChildLogger({ module: 'series-orchestrator' });

/** @description The result of one advance step — what happened, and whether the caller should keep going. */
export interface AdvanceResult {
  /** The series' status after this step. */
  status: string;
  /** The stage this step touched. */
  stage: 'write' | 'approval' | 'storyboard' | 'render' | 'complete' | 'terminal';
  /** True when a step actually happened (so a driver knows to call again immediately). */
  advanced: boolean;
  /** True when the conductor is deliberately parked (approval gate, or a render in flight). */
  waiting: boolean;
  /** True when the series can go no further without intervention (a rejection, no node). */
  blocked: boolean;
  /** One human-readable line. */
  detail: string;
}

/** @description The per-user credentials a paid stage needs. Injected so tests never touch a real account. */
export interface SeriesCredentials {
  /** The caller's Google token — stores frames in their Drive, and (on the node) fetches them. */
  driveToken: string;
  /** A token for the image provider when it is `vertex`; undefined otherwise. */
  vertexToken?: string;
}

/** @description The stage functions, injectable. Defaults are the real ones. */
export interface OrchestratorDeps {
  resolveCredentials: (userSub: string) => Promise<SeriesCredentials>;
  write: (ctx: AppContext, seriesId: string) => Promise<{ ok: boolean; episodes?: number; violations?: unknown[]; error?: string }>;
  storyboard: (pool: Pool, episodeId: string, driveToken: string, vertexToken?: string) => Promise<{ ok: boolean; frameIds?: string[]; duplicates?: string[]; error?: string }>;
  dispatchRender: (pool: Pool, episodeId: string, driveToken: string, ticketId?: string) => Promise<{ ok: boolean; error?: string }>;
}

const botClient = new BotNodeClient(createRegistryEndpointResolver());

/** Drive is stored in the caller's account; images bill per STORYBOARD_IMAGE_PROVIDER (default codex). */
async function realCredentials(pool: Pool, userSub: string): Promise<SeriesCredentials> {
  const driveToken = (await getValidAccessToken(pool, userSub, 'google')) ?? '';
  let vertexToken: string | undefined;
  if ((process.env.STORYBOARD_IMAGE_PROVIDER || 'codex').toLowerCase() === 'vertex') {
    vertexToken = process.env.VEO_ALLOW_SWARM_BILLING === 'true' ? await getVertexAccessToken() : driveToken;
  }
  return { driveToken, vertexToken };
}

/** @description The default (real) stage wiring. @param {AppContext} ctx app context @returns {OrchestratorDeps} deps */
function defaultDeps(ctx: AppContext): OrchestratorDeps {
  return {
    resolveCredentials: (userSub) => realCredentials(ctx.pool, userSub),
    write: (c, seriesId) => writeSeries(c, botClient, seriesId),
    storyboard: (pool, episodeId, driveToken, vertexToken) =>
      // Frames are uploaded to the caller's Drive; the node fetches them by id.
      storyboardEpisode(pool, episodeId, (png, name) => uploadFrameToDrive(png, name, driveToken), { vertexToken }),
    dispatchRender: (pool, episodeId, driveToken, ticketId) =>
      dispatchStoryboardedEpisode(pool, episodeId, { driveToken, ticketId }),
  };
}

/** Load a series' status, owner, ticket, and its episodes' statuses in one shot. */
async function loadSeries(pool: Pool, seriesId: string): Promise<{
  status: string; userSub: string; ticketId: string | null;
  episodes: Array<{ id: string; ordinal: number; status: string }>;
} | null> {
  const s = (await pool.query(
    `SELECT status, user_sub, ticket_id FROM video_series WHERE series_id = $1`, [seriesId],
  )).rows[0] as { status: string; user_sub: string; ticket_id: string | null } | undefined;
  if (!s) return null;
  const eps = (await pool.query(
    `SELECT episode_id, ordinal, status FROM video_episodes WHERE series_id = $1 ORDER BY ordinal`, [seriesId],
  )).rows as Array<{ episode_id: string; ordinal: number; status: string }>;
  return {
    status: s.status, userSub: s.user_sub, ticketId: s.ticket_id,
    episodes: eps.map((e) => ({ id: String(e.episode_id), ordinal: Number(e.ordinal), status: String(e.status) })),
  };
}

/**
 * @description Approve a series' scripts — the one edge the conductor will not cross on its own. Moves
 * awaiting_approval -> storyboarding, after which everything runs automatically.
 * @param {Pool} pool database pool
 * @param {string} seriesId the series
 * @returns {Promise<{ok: boolean, error?: string}>} result
 */
export async function approveSeries(pool: Pool, seriesId: string): Promise<{ ok: boolean; error?: string }> {
  const { rowCount } = await pool.query(
    `UPDATE video_series SET status='storyboarding', updated_at=now()
      WHERE series_id=$1 AND status='awaiting_approval'`, [seriesId],
  );
  if (!rowCount) {
    const cur = (await pool.query(`SELECT status FROM video_series WHERE series_id=$1`, [seriesId])).rows[0] as { status?: string } | undefined;
    return { ok: false, error: cur ? `series is '${cur.status}', not 'awaiting_approval'` : 'series not found' };
  }
  logger.info({ seriesId }, 'series approved — the render budget is now authorized');
  return { ok: true };
}

/**
 * @description Advance a series by exactly ONE safe step. Idempotent; safe to call on any cycle.
 *
 *   scripting          -> WRITE the scripts (LLM), then park at awaiting_approval
 *   awaiting_approval  -> park (the gate — a human must approve; nothing paid runs before this)
 *   storyboarding      -> STORYBOARD the next un-storyboarded episode; when all done, enter rendering
 *   rendering          -> dispatch the next storyboarded episode (one at a time); when all rendered, done
 *   done | failed      -> terminal
 *
 * @param {AppContext} ctx app context
 * @param {string} seriesId the series to advance
 * @param {Partial<OrchestratorDeps>} [overrides] injected stage functions (tests); defaults are real
 * @returns {Promise<AdvanceResult>} what happened
 */
export async function advanceVideoSeries(
  ctx: AppContext,
  seriesId: string,
  overrides: Partial<OrchestratorDeps> = {},
): Promise<AdvanceResult> {
  const deps: OrchestratorDeps = { ...defaultDeps(ctx), ...overrides };
  const pool = ctx.pool;
  const series = await loadSeries(pool, seriesId);
  if (!series) return { status: 'missing', stage: 'terminal', advanced: false, waiting: false, blocked: true, detail: 'series not found' };

  const park = (stage: AdvanceResult['stage'], detail: string, blocked = false): AdvanceResult =>
    ({ status: series.status, stage, advanced: false, waiting: !blocked, blocked, detail });

  switch (series.status) {
    case 'scripting': {
      const r = await deps.write(ctx, seriesId);
      if (r.ok) return { status: 'awaiting_approval', stage: 'write', advanced: true, waiting: false, blocked: false, detail: `${r.episodes} episode(s) drafted — awaiting approval` };
      const why = r.violations?.length ? `${r.violations.length} rule violation(s)` : (r.error ?? 'unknown');
      return { status: 'failed', stage: 'write', advanced: true, waiting: false, blocked: true, detail: `script rejected: ${why}` };
    }

    case 'awaiting_approval':
      // A normal park, not a block: the scripts are written and waiting for a human. `waiting` (not
      // `blocked`) is what stops a driver loop here without flagging an error.
      return park('approval', 'waiting for the operator to approve the scripts before any spend');

    case 'storyboarding': {
      const nextScripted = series.episodes.find((e) => e.status === 'scripted');
      if (nextScripted) {
        const creds = await deps.resolveCredentials(series.userSub);
        if (!creds.driveToken) return park('storyboard', 'no Google token for this user — reconnect Google', true);
        const r = await deps.storyboard(pool, nextScripted.id, creds.driveToken, creds.vertexToken);
        if (r.ok) return { status: 'storyboarding', stage: 'storyboard', advanced: true, waiting: false, blocked: false, detail: `episode ${nextScripted.ordinal} storyboarded (${r.frameIds?.length ?? 0} frames)` };
        const why = r.duplicates?.length ? `duplicate shots: ${r.duplicates.join('; ')}` : (r.error ?? 'unknown');
        return { status: 'storyboarding', stage: 'storyboard', advanced: true, waiting: false, blocked: true, detail: `episode ${nextScripted.ordinal} rejected: ${why}` };
      }
      // All episodes are storyboarded or beyond — enter the render stage.
      await pool.query(`UPDATE video_series SET status='rendering', updated_at=now() WHERE series_id=$1`, [seriesId]);
      return { status: 'rendering', stage: 'storyboard', advanced: true, waiting: false, blocked: false, detail: 'all episodes storyboarded — entering render' };
    }

    case 'rendering': {
      if (await isRenderInFlight(pool, seriesId)) return park('render', 'an episode is rendering on the node — one at a time');
      const nextStoryboarded = series.episodes.find((e) => e.status === 'storyboarded');
      if (nextStoryboarded) {
        const creds = await deps.resolveCredentials(series.userSub);
        if (!creds.driveToken) return park('render', 'no Google token for this user — reconnect Google', true);
        const r = await deps.dispatchRender(pool, nextStoryboarded.id, creds.driveToken, series.ticketId ?? undefined);
        if (r.ok) return { status: 'rendering', stage: 'render', advanced: true, waiting: false, blocked: false, detail: `episode ${nextStoryboarded.ordinal} dispatched to the node` };
        return park('render', `render dispatch failed: ${r.error}`, true);
      }
      // Nothing left to dispatch. Done only when every episode actually landed.
      const allDone = series.episodes.length > 0 && series.episodes.every((e) => e.status === 'rendered' || e.status === 'assembled');
      if (allDone) {
        await pool.query(`UPDATE video_series SET status='done', updated_at=now() WHERE series_id=$1`, [seriesId]);
        return { status: 'done', stage: 'complete', advanced: true, waiting: false, blocked: false, detail: 'every episode rendered — series done' };
      }
      // Some episode failed (not rendered, not renderable) — surface it rather than spin.
      const stuck = series.episodes.filter((e) => e.status === 'failed').map((e) => e.ordinal);
      if (stuck.length) return park('render', `episode(s) ${stuck.join(', ')} failed — series cannot complete`, true);
      return park('render', 'episodes still finishing');
    }

    case 'done':
    case 'failed':
      return { status: series.status, stage: 'terminal', advanced: false, waiting: false, blocked: series.status === 'failed', detail: series.status };

    default:
      return park('terminal', `unknown status '${series.status}'`, true);
  }
}

/**
 * @description Drive a series as far as it will go right now: advance until it parks, blocks, or
 * finishes. Never crosses the approval gate. Bounded so a logic error cannot loop forever.
 * @param {AppContext} ctx app context
 * @param {string} seriesId the series
 * @param {Partial<OrchestratorDeps>} [overrides] injected stage functions (tests)
 * @returns {Promise<AdvanceResult[]>} the steps taken, in order
 */
export async function runVideoSeries(
  ctx: AppContext,
  seriesId: string,
  overrides: Partial<OrchestratorDeps> = {},
): Promise<AdvanceResult[]> {
  const steps: AdvanceResult[] = [];
  for (let i = 0; i < 64; i++) {
    // eslint-disable-next-line no-await-in-loop
    const step = await advanceVideoSeries(ctx, seriesId, overrides);
    steps.push(step);
    if (!step.advanced || step.waiting || step.blocked) break;
  }
  return steps;
}

/**
 * @description Reconcile one finished render into episode state. The node prints `EPISODE_OK {json}`
 * or `EPISODE_ERR message`; this turns that into a `rendered` (with the Drive link) or `failed`
 * episode, so the next `advanceVideoSeries` can move on. Never invents a delivery: only a link the
 * node actually returned is stored.
 * @param {Pool} pool database pool
 * @param {string} episodeId the episode that was rendering
 * @param {string} stdout the node task's stdout
 * @returns {Promise<{ok: boolean, driveUrl?: string | null, error?: string}>} result
 */
export async function reconcileRenderResult(
  pool: Pool,
  episodeId: string,
  stdout: string,
): Promise<{ ok: boolean; driveUrl?: string | null; error?: string }> {
  const okLine = stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('EPISODE_OK'));
  const errLine = stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('EPISODE_ERR'));

  if (okLine) {
    let parsed: { localPath?: string; driveUrl?: string | null } = {};
    try { parsed = JSON.parse(okLine.slice('EPISODE_OK'.length).trim()); } catch { /* fall back to bare success */ }
    await pool.query(
      `UPDATE video_episodes
          SET status='rendered', mp4_path=$2, drive_url=$3, error=NULL, updated_at=now()
        WHERE episode_id=$1`,
      [episodeId, parsed.localPath ?? null, parsed.driveUrl ?? null],
    );
    logger.info({ episodeId, driveUrl: parsed.driveUrl ?? null }, 'render reconciled: episode rendered');
    return { ok: true, driveUrl: parsed.driveUrl ?? null };
  }

  const message = errLine ? errLine.slice('EPISODE_ERR'.length).trim() : 'render produced no terminal line';
  await pool.query(`UPDATE video_episodes SET status='failed', error=$2, updated_at=now() WHERE episode_id=$1`, [episodeId, message]);
  logger.warn({ episodeId, message }, 'render reconciled: episode failed');
  return { ok: false, error: message };
}

/**
 * @description Sweep once for renders that finished on the node: for every episode still marked
 * `rendering`, look up its dispatched task in the remote-client registry; if it settled, reconcile
 * it into episode state and advance its series. This is the glue that turns "dispatch one episode,
 * wait" into "the whole series finishes on its own".
 *
 * Safe to run on a timer: it only ever progresses work that is already past the approval gate. It
 * never crosses the gate, so it can never authorize spend the operator did not.
 *
 * @param {AppContext} ctx app context
 * @returns {Promise<number>} how many episodes it reconciled this sweep
 */
export async function reconcilePendingRenders(ctx: AppContext): Promise<number> {
  const pending = (await ctx.pool.query(
    `SELECT episode_id, series_id, vids_job_id FROM video_episodes WHERE status='rendering' AND vids_job_id IS NOT NULL`,
  )).rows as Array<{ episode_id: string; series_id: string; vids_job_id: string }>;
  if (!pending.length) return 0;

  let clients: Array<{ clientId: string }> = [];
  try { clients = remoteClientRegistry.listClients() as typeof clients; } catch { clients = []; }

  let reconciled = 0;
  for (const p of pending) {
    let result: { status?: string; output?: unknown } | null = null;
    for (const c of clients) {
      const r = remoteClientRegistry.getCompletedResult(c.clientId, p.vids_job_id);
      if (r) { result = r as { status?: string; output?: unknown }; break; }
    }
    if (!result) continue; // still running
    const stdout = String((result.output as { stdout?: string } | undefined)?.stdout ?? '');
    // eslint-disable-next-line no-await-in-loop
    await reconcileRenderResult(ctx.pool, p.episode_id, stdout);
    reconciled += 1;
    // eslint-disable-next-line no-await-in-loop
    await advanceVideoSeries(ctx, p.series_id).catch((err) => logger.warn({ err: (err as Error).message, seriesId: p.series_id }, 'advance after reconcile failed'));
  }
  return reconciled;
}

/**
 * @description Start the render reconciler on a timer. Idempotent per process. Returns a stop handle.
 * @param {AppContext} ctx app context
 * @param {number} [intervalMs] sweep cadence (default 20s)
 * @returns {() => void} stop the reconciler
 */
export function startSeriesReconciler(ctx: AppContext, intervalMs = 20_000): () => void {
  logger.info({ intervalMs }, 'video-series render reconciler started');
  const timer = setInterval(() => {
    void runWithSystemIdentity(() => reconcilePendingRenders(ctx)).then((n) => { if (n) logger.info({ reconciled: n }, 'reconciled finished renders'); })
      .catch((err) => logger.warn({ err: (err as Error).message }, 'render reconcile sweep failed'));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
