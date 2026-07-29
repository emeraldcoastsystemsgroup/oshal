/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The joke-shorts pump: the driver the video-series conductor never had. Rotates enrolled shows, refuses to touch a busy render node, opens a real ticket per episode, and honours the approval gate through per-show standing authorization with a daily cap instead of deleting it.
 */
/**
 * @description The joke-shorts pump — what keeps the engine producing.
 *
 * The conductor (series-orchestrator) can walk ONE series from a premise to a finished MP4. Nothing
 * ever asked it to, which is why the last episode was rendered on 2026-07-08 and the machine has been
 * idle since. This module is the asking.
 *
 * Four properties are the design:
 *
 *   IT NEVER TOUCHES A BUSY NODE. Every cycle starts at the availability gate
 *   (vids-node-availability). The render node is one machine driving one signed-in Chrome, shared with
 *   the nightly trade recap; two chains against one browser finish nothing and every retry is a paid
 *   generation. A "busy" answer is recorded and the cycle ends — the pump never queues behind the
 *   recap, it comes back later.
 *
 *   THE APPROVAL GATE SURVIVES. The conductor will not cross awaiting_approval on its own, and this
 *   does not change that. Instead the operator authorizes A SHOW, once, with a daily cap
 *   (`standing_authorization` + `daily_cap`); the pump may then approve episodes of that show, up to
 *   that cap, and nothing else. A show without standing authorization still gets written — it simply
 *   parks with its scripts ready, which costs nothing.
 *
 *   ONE EPISODE PER CYCLE, ROTATED. Least-recently-started show first, so six shows advance evenly
 *   instead of one show running away with the node.
 *
 *   EVERY CYCLE IS RECORDED, INCLUDING THE QUIET ONES. `video_pump_runs` holds skips with the gate's
 *   reason as well as deliveries. "Nothing was made for six hours because the recap owned the node"
 *   has to be readable in the ledger, or a quiet night is indistinguishable from a broken pump — and
 *   the tuning counters (consecutive failures, auto-pause) come from the same rows.
 *
 * @module app/series-pump
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import type { AppContext } from '@/app/composition/app-context';
import { SCREENPLAY_WRITER_AGENT_ID } from '@/app/series-pipeline';
import { advanceVideoSeries, approveSeries, reconcilePendingRenders } from '@/app/series-orchestrator';
import {
  checkVidsNodeAvailability, acquireVidsNodeLease, releaseVidsNodeLease, findRenderNode,
  type NodeAvailability,
} from '@/app/vids-node-availability';

const logger = createChildLogger({ module: 'series-pump' });

/** Auto-pause a show after this many consecutive failures. A show that cannot render must not keep trying. */
const FAILURE_LIMIT = Number(process.env.VIDEO_PUMP_FAILURE_LIMIT || 3);

/** How long the pump holds the node lease for one episode. */
const LEASE_MINUTES = Number(process.env.VIDS_NODE_LEASE_MINUTES || 45);

/** Don't write a fresh `skipped` row for the same reason more often than this. */
const SKIP_LOG_MINUTES = Number(process.env.VIDEO_PUMP_SKIP_LOG_MIN || 60);

/** @description One enrolled show, as the pump needs it. */
export interface PumpShow {
  showId: string;
  userSub: string;
  slug: string;
  title: string;
  premise: string;
  styleLock: string | null;
  cast: Array<{ name: string; description: string }>;
  jokeSeeds: string[];
  seedCursor: number;
  scenesPerEpisode: number;
  orientation: string;
  standingAuthorization: boolean;
  dailyCap: number;
  minIntervalMinutes: number;
  consecutiveFailures: number;
}

/** @description What one pump cycle did. */
export interface PumpCycle {
  /** `made` only when an episode actually started; every other value is a no-op cycle. */
  action: 'made' | 'skipped' | 'idle' | 'disabled';
  /** The show it worked on, when it picked one. */
  showSlug?: string;
  /** The gate check or the stage that decided the outcome. */
  stage?: string;
  /** One human-readable line. */
  detail: string;
  /** The series it opened, when it opened one. */
  seriesId?: string;
  /** The ticket it opened, when it opened one. */
  ticketId?: string;
}

/** The calendar day in the node's own zone — a cap of "1 per day" means the node's day. */
function nodeLocalDay(now: Date): string {
  const zone = process.env.VIDS_NODE_BLACKOUT_TZ || 'America/Chicago';
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Rotation order: enabled, not auto-paused, min-interval elapsed, least recently started first. */
async function loadCandidateShows(pool: Pool): Promise<PumpShow[]> {
  const { rows } = await pool.query(
    `SELECT show_id, user_sub, slug, title, premise, style_lock, cast_bible, joke_seeds, seed_cursor,
            scenes_per_episode, orientation, standing_authorization, daily_cap, min_interval_minutes,
            consecutive_failures
       FROM video_pump_shows
      WHERE enabled = TRUE
        AND paused_reason IS NULL
        AND daily_cap > 0
        AND (last_started_at IS NULL
             OR last_started_at < now() - (min_interval_minutes * INTERVAL '1 minute'))
      ORDER BY last_started_at ASC NULLS FIRST, created_at ASC`,
  );
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    showId: String(r.show_id),
    userSub: String(r.user_sub),
    slug: String(r.slug),
    title: String(r.title),
    premise: String(r.premise),
    styleLock: (r.style_lock as string | null) ?? null,
    cast: (Array.isArray(r.cast_bible) ? r.cast_bible : []) as Array<{ name: string; description: string }>,
    jokeSeeds: (Array.isArray(r.joke_seeds) ? r.joke_seeds : []) as string[],
    seedCursor: Number(r.seed_cursor ?? 0),
    scenesPerEpisode: Number(r.scenes_per_episode ?? 4),
    orientation: String(r.orientation ?? 'Landscape'),
    standingAuthorization: Boolean(r.standing_authorization),
    dailyCap: Number(r.daily_cap ?? 1),
    minIntervalMinutes: Number(r.min_interval_minutes ?? 240),
    consecutiveFailures: Number(r.consecutive_failures ?? 0),
  }));
}

/**
 * @description How many episodes of this show the pump has STARTED on the node's calendar day.
 * Skips do not count — refusing to render is not production.
 * @param {Pool} pool database pool
 * @param {string} showId the show
 * @param {Date} now the instant defining "today"
 * @returns {Promise<number>} the count
 */
export async function startedTodayCount(pool: Pool, showId: string, now: Date): Promise<number> {
  const zone = process.env.VIDS_NODE_BLACKOUT_TZ || 'America/Chicago';
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM video_pump_runs
      WHERE show_id = $1 AND outcome <> 'skipped'
        AND (created_at AT TIME ZONE $2)::date = ($3)::date`,
    [showId, zone, nodeLocalDay(now)],
  );
  return Number((rows[0] as { n?: number })?.n ?? 0);
}

/**
 * @description The next show due: the first candidate in rotation order that is still under its
 * daily cap.
 * @param {Pool} pool database pool
 * @param {Date} [now] the instant defining "today"
 * @returns {Promise<PumpShow | null>} the show, or null when nothing is due
 */
export async function pickNextShow(pool: Pool, now: Date = new Date()): Promise<PumpShow | null> {
  for (const show of await loadCandidateShows(pool)) {
    // eslint-disable-next-line no-await-in-loop
    const made = await startedTodayCount(pool, show.showId, now);
    if (made < show.dailyCap) return show;
  }
  return null;
}

/**
 * @description The next joke seed in rotation, and the cursor to store. Seeds recycle rather than
 * running out; an empty list returns null, which leaves the premise to the writer.
 * @param {PumpShow} show the show
 * @returns {{seed: string | null, nextCursor: number}} the seed and the cursor after it
 */
export function nextJokeSeed(show: PumpShow): { seed: string | null; nextCursor: number } {
  if (!show.jokeSeeds.length) return { seed: null, nextCursor: 0 };
  const i = ((show.seedCursor % show.jokeSeeds.length) + show.jokeSeeds.length) % show.jokeSeeds.length;
  return { seed: String(show.jokeSeeds[i]), nextCursor: (i + 1) % show.jokeSeeds.length };
}

/**
 * @description May the pump approve THIS episode's render spend? The single place that question is
 * answered, so the answer can be tested directly.
 *
 * Two conditions, both necessary. The operator's standing authorization for the show is what stands
 * in for the human at the approval gate — without it nothing paid may run. The daily cap is
 * re-checked HERE as well as during selection, because selection happens before the episode is
 * written and a concurrent cycle could have used the day's last slot in between.
 *
 * @param {{standingAuthorization: boolean, dailyCap: number}} show the enrolled show
 * @param {number} startedToday episodes of this show already started on the node's calendar day
 * @returns {{approve: boolean, why: string}} the decision and the reason, always populated
 */
export function autoApprovalDecision(
  show: { standingAuthorization: boolean; dailyCap: number },
  startedToday: number,
): { approve: boolean; why: string } {
  if (!show.standingAuthorization) {
    return { approve: false, why: 'written and parked — this show has no standing authorization' };
  }
  if (startedToday > show.dailyCap) {
    return { approve: false, why: `written and parked — this show's daily cap of ${show.dailyCap} is used up` };
  }
  return { approve: true, why: `authorized by standing authorization (${startedToday} of ${show.dailyCap} today)` };
}

/** The episode premise handed to the writer: the show's standing situation plus today's joke. */
function episodePremise(show: PumpShow, seed: string | null): string {
  const lines = [show.premise.trim()];
  if (seed) {
    lines.push('',
      `THIS EPISODE'S JOKE: ${seed.trim()}`,
      'Build the four scenes to land that joke: setup, problem, turn, punchline. The punchline is a',
      'spoken line, not a caption. Keep it kind — nobody is the butt of it.');
  }
  return lines.join('\n');
}

/** Write the ledger row for a cycle. Returns its id so later stages can update it. */
async function recordRun(
  pool: Pool,
  row: {
    userSub: string; showId: string | null; showSlug: string | null; outcome: string;
    stage?: string | null; reason?: string | null; seriesId?: string | null; ticketId?: string | null;
    episodeTitle?: string | null; jokeSeed?: string | null;
  },
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO video_pump_runs
       (user_sub, show_id, show_slug, outcome, outcome_stage, outcome_reason, series_id, ticket_id,
        episode_title, joke_seed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING run_id`,
    [row.userSub, row.showId, row.showSlug, row.outcome, row.stage ?? null, row.reason ?? null,
      row.seriesId ?? null, row.ticketId ?? null, row.episodeTitle ?? null, row.jokeSeed ?? null],
  );
  return String((rows[0] as { run_id: string }).run_id);
}

/**
 * @description Record that the pump declined to run, without filling the ledger with the same line
 * every cycle: an identical recent skip is touched rather than duplicated.
 * @param {Pool} pool database pool
 * @param {NodeAvailability} avail the gate's verdict
 * @param {PumpShow | null} show the show that was due, when one was
 * @returns {Promise<void>} nothing
 */
async function recordSkip(pool: Pool, avail: NodeAvailability, show: PumpShow | null): Promise<void> {
  const userSub = show?.userSub ?? 'system';
  const { rowCount } = await pool.query(
    `UPDATE video_pump_runs SET updated_at = now()
      WHERE run_id = (
        SELECT run_id FROM video_pump_runs
         WHERE outcome = 'skipped' AND outcome_stage = $1 AND user_sub = $2
           AND created_at > now() - ($3 * INTERVAL '1 minute')
         ORDER BY created_at DESC LIMIT 1)`,
    [avail.check, userSub, SKIP_LOG_MINUTES],
  );
  if (rowCount) return;
  await recordRun(pool, {
    userSub, showId: show?.showId ?? null, showSlug: show?.slug ?? null,
    outcome: 'skipped', stage: avail.check, reason: avail.reason,
  });
}

/** Open the ticket and the series row for one episode. The ticket is the swarm's record of the work. */
async function openEpisode(
  ctx: AppContext,
  show: PumpShow,
  seed: string | null,
): Promise<{ seriesId: string; ticketId: string }> {
  const premise = episodePremise(show, seed);
  const ticket = await ctx.ticketService.createTicket({
    title: `${show.title} — new joke short${seed ? `: ${seed.slice(0, 60)}` : ''}`,
    ticketType: 'video-series',
    description: [
      `Series: ${show.title}`, '', `Premise: ${premise}`, '',
      `One episode, ${show.scenesPerEpisode} scenes, ${show.orientation}.`,
      show.styleLock ? `Style lock: ${show.styleLock}` : '',
      `Cast — use EXACTLY these: ${JSON.stringify(show.cast)}`,
      '',
      'Opened by the joke-shorts pump. The video-series conductor drives the stages from here:',
      'the screenplay-writer drafts it, the storyboard stage draws the stills, and the render stage',
      'animates them on the operator\'s Vids node when that node is idle.',
    ].filter(Boolean).join('\n'),
    status: 'backlog',
    priority: 'low',
    labels: ['video', 'series', 'joke-short', 'pump', show.slug],
    workspaceId: null,
    assignedAgentId: SCREENPLAY_WRITER_AGENT_ID,
    parentTicketId: null,
    externalProvider: null,
    externalId: null,
    externalUrl: null,
    ownerSub: show.userSub,
    metadata: { app: 'video', kind: 'joke-short', pump: true, show: show.slug, jokeSeed: seed },
  });

  const { rows } = await ctx.pool.query(
    `INSERT INTO video_series
       (user_sub, ticket_id, title, premise, style_lock, cast_bible, episode_count,
        scenes_per_episode, orientation, status)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,1,$7,$8,'scripting')
     RETURNING series_id`,
    [show.userSub, ticket.ticketId, show.title, premise, show.styleLock,
      JSON.stringify(show.cast), show.scenesPerEpisode, show.orientation],
  );
  return { seriesId: String((rows[0] as { series_id: string }).series_id), ticketId: ticket.ticketId };
}

/** Tuning: a failure counts toward the auto-pause, and the show says why it stopped. */
async function noteFailure(
  pool: Pool,
  show: { showId: string; slug: string; consecutiveFailures: number },
  why: string,
): Promise<void> {
  const next = show.consecutiveFailures + 1;
  const pause = next >= FAILURE_LIMIT
    ? `auto-paused after ${next} consecutive failures — last: ${why}`.slice(0, 500)
    : null;
  await pool.query(
    `UPDATE video_pump_shows
        SET consecutive_failures = $2, paused_reason = $3, updated_at = now()
      WHERE show_id = $1`,
    [show.showId, next, pause],
  );
  if (pause) logger.warn({ showId: show.showId, slug: show.slug, why }, 'show auto-paused by the pump');
}

/**
 * @description Run ONE pump cycle: reconcile what finished, check the node, and start at most one
 * episode. Safe to call on a timer; every failure path is recorded rather than thrown.
 * @param {AppContext} ctx app context
 * @param {{now?: Date, skipProbe?: boolean}} [opts] test seams
 * @returns {Promise<PumpCycle>} what the cycle did
 */
export async function runPumpOnce(
  ctx: AppContext,
  opts: { now?: Date; skipProbe?: boolean } = {},
): Promise<PumpCycle> {
  const pool = ctx.pool;
  const now = opts.now ?? new Date();

  // What finished on the node since last time — this is also what clears `render-in-flight`.
  await reconcilePendingRenders(ctx).catch((err) => logger.warn({ err: (err as Error).message }, 'reconcile sweep failed'));
  await syncPumpRuns(ctx).catch((err) => logger.warn({ err: (err as Error).message }, 'ledger sync failed'));

  const show = await pickNextShow(pool, now);
  if (!show) return { action: 'idle', detail: 'no enrolled show is due' };

  const avail = await checkVidsNodeAvailability(pool, {
    skipProbe: opts.skipProbe, selfLeaseOwner: `joke-pump:${show.slug}`,
  });
  if (!avail.available) {
    await recordSkip(pool, avail, show);
    return { action: 'skipped', showSlug: show.slug, stage: avail.check, detail: avail.reason };
  }

  // Hold the node for the length of one episode so anything else that asks sees it as taken.
  if (avail.clientId) {
    const lease = await acquireVidsNodeLease(avail.clientId, `joke-pump:${show.slug}`, LEASE_MINUTES);
    if (!lease.ok) {
      const verdict: NodeAvailability = { available: false, check: 'leased', reason: lease.error ?? 'could not take the node lease', clientId: avail.clientId };
      await recordSkip(pool, verdict, show);
      return { action: 'skipped', showSlug: show.slug, stage: 'leased', detail: verdict.reason };
    }
  }

  return produceEpisode(ctx, show, avail, now);
}

/** The productive half of a cycle: open the work, write it, and (when authorized) let it render. */
async function produceEpisode(
  ctx: AppContext,
  show: PumpShow,
  avail: NodeAvailability,
  now: Date,
): Promise<PumpCycle> {
  const pool = ctx.pool;
  const { seed, nextCursor } = nextJokeSeed(show);
  const { seriesId, ticketId } = await openEpisode(ctx, show, seed);
  const runId = await recordRun(pool, {
    userSub: show.userSub, showId: show.showId, showSlug: show.slug, outcome: 'started',
    stage: 'write', seriesId, ticketId, jokeSeed: seed,
  });
  await pool.query(
    `UPDATE video_pump_shows SET seed_cursor = $2, last_started_at = $3, updated_at = now() WHERE show_id = $1`,
    [show.showId, nextCursor, now.toISOString()],
  );

  // WRITE. Free — an LLM call, no image and no clip.
  const written = await advanceVideoSeries(ctx, seriesId);
  if (written.blocked || written.status === 'failed') {
    await pool.query(
      `UPDATE video_pump_runs SET outcome='failed', outcome_stage='write', outcome_reason=$2, updated_at=now() WHERE run_id=$1`,
      [runId, written.detail],
    );
    await noteFailure(pool, show, written.detail);
    if (avail.clientId) await releaseVidsNodeLease(avail.clientId, `joke-pump:${show.slug}`).catch(() => { /* the failure is what matters */ });
    return { action: 'skipped', showSlug: show.slug, stage: 'write', detail: `script rejected: ${written.detail}`, seriesId, ticketId };
  }

  const title = await episodeTitle(pool, seriesId);

  // The gate. Without standing authorization — or with the day's cap already used — the episode parks
  // here with its scripts ready, which is the correct free outcome, not a failure.
  const decision = autoApprovalDecision(show, await startedTodayCount(pool, show.showId, now));
  if (!decision.approve) {
    await pool.query(
      `UPDATE video_pump_runs SET outcome='scripted', outcome_stage='approval', episode_title=$2,
              outcome_reason=$3, updated_at=now() WHERE run_id=$1`,
      [runId, title, decision.why],
    );
    if (avail.clientId) await releaseVidsNodeLease(avail.clientId, `joke-pump:${show.slug}`).catch(() => { /* nothing is on the node */ });
    return { action: 'made', showSlug: show.slug, stage: 'approval', seriesId, ticketId, detail: `"${title}" is written and waiting for approval` };
  }

  const approved = await approveSeries(pool, seriesId);
  if (!approved.ok) {
    await pool.query(
      `UPDATE video_pump_runs SET outcome='failed', outcome_stage='approval', outcome_reason=$2, episode_title=$3, updated_at=now() WHERE run_id=$1`,
      [runId, approved.error ?? 'approval failed', title],
    );
    await noteFailure(pool, show, approved.error ?? 'approval failed');
    return { action: 'skipped', showSlug: show.slug, stage: 'approval', detail: approved.error ?? 'approval failed', seriesId, ticketId };
  }

  // STORYBOARD then RENDER, as far as one call goes; the reconciler carries it the rest of the way.
  const steps: string[] = [];
  for (let i = 0; i < 8; i++) {
    // eslint-disable-next-line no-await-in-loop
    const step = await advanceVideoSeries(ctx, seriesId);
    steps.push(`${step.stage}: ${step.detail}`);
    if (!step.advanced || step.waiting || step.blocked) break;
  }
  const last = steps[steps.length - 1] ?? 'no step taken';
  await pool.query(
    `UPDATE video_pump_runs SET outcome='rendering', outcome_stage='render', episode_title=$2,
            outcome_reason=$3, updated_at=now() WHERE run_id=$1`,
    [runId, title, last.slice(0, 500)],
  );
  logger.info({ showSlug: show.slug, seriesId, ticketId, steps }, 'pump started an episode');
  return { action: 'made', showSlug: show.slug, stage: 'render', seriesId, ticketId, detail: `"${title}" — ${last}` };
}

/** The title the writer gave episode 1, for the ledger. */
async function episodeTitle(pool: Pool, seriesId: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT title FROM video_episodes WHERE series_id=$1 ORDER BY ordinal LIMIT 1`, [seriesId],
  );
  return String((rows[0] as { title?: string })?.title ?? 'untitled');
}

/**
 * @description Bring the ledger and the tuning counters up to date with what the conductor did:
 * a run whose episode reached `rendered`/`assembled` becomes `delivered` (with the link the node
 * actually returned), a `failed` episode becomes a failure against its show, and the node lease is
 * released once nothing is rendering.
 * @param {AppContext} ctx app context
 * @returns {Promise<number>} how many run rows changed
 */
export async function syncPumpRuns(ctx: AppContext): Promise<number> {
  const pool = ctx.pool;
  const { rows } = await pool.query(
    `SELECT r.run_id, r.show_id, r.show_slug, r.created_at, e.status AS ep_status, e.drive_url, e.error
       FROM video_pump_runs r
       JOIN video_episodes e ON e.series_id = r.series_id
      WHERE r.outcome IN ('started','rendering') AND r.series_id IS NOT NULL`,
  );
  let changed = 0;
  for (const raw of rows as Array<Record<string, unknown>>) {
    const runId = String(raw.run_id);
    const status = String(raw.ep_status);
    const ms = Date.now() - new Date(String(raw.created_at)).getTime();
    if (status === 'rendered' || status === 'assembled') {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `UPDATE video_pump_runs SET outcome='delivered', outcome_stage=$2, drive_url=$3, duration_ms=$4,
                outcome_reason=NULL, updated_at=now() WHERE run_id=$1`,
        [runId, status, (raw.drive_url as string | null) ?? null, ms],
      );
      if (raw.show_id) {
        // eslint-disable-next-line no-await-in-loop
        await pool.query(
          `UPDATE video_pump_shows SET episodes_made = episodes_made + 1, consecutive_failures = 0,
                  last_success_at = now(), updated_at = now() WHERE show_id = $1`, [raw.show_id],
        );
      }
      changed += 1;
    } else if (status === 'failed') {
      const why = String((raw.error as string | null) ?? 'the episode failed on the node');
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `UPDATE video_pump_runs SET outcome='failed', outcome_stage='render', outcome_reason=$2,
                duration_ms=$3, updated_at=now() WHERE run_id=$1`, [runId, why.slice(0, 500), ms],
      );
      // eslint-disable-next-line no-await-in-loop
      const show = (await pool.query(
        `SELECT show_id, slug, consecutive_failures FROM video_pump_shows WHERE show_id=$1`, [raw.show_id],
      )).rows[0] as { show_id?: string; slug?: string; consecutive_failures?: number } | undefined;
      if (show?.show_id) {
        // eslint-disable-next-line no-await-in-loop
        await noteFailure(pool, {
          showId: show.show_id, slug: String(show.slug), consecutiveFailures: Number(show.consecutive_failures ?? 0),
        }, why);
      }
      changed += 1;
    }
  }
  if (changed) await releaseIdleLease(pool).catch(() => { /* a leaked lease expires on its own */ });
  return changed;
}

/** Give the node back once nothing of ours is rendering. A leaked lease would idle the pump for its TTL. */
async function releaseIdleLease(pool: Pool): Promise<void> {
  const stillRendering = await pool.query(`SELECT 1 FROM video_episodes WHERE status='rendering' LIMIT 1`);
  if (stillRendering.rows.length) return;
  const node = findRenderNode();
  if (!node) return;
  const { rows } = await pool.query(
    `SELECT DISTINCT slug FROM video_pump_shows WHERE last_started_at > now() - INTERVAL '6 hours'`,
  );
  for (const r of rows as Array<{ slug: string }>) {
    // eslint-disable-next-line no-await-in-loop
    await releaseVidsNodeLease(node.clientId, `joke-pump:${r.slug}`).catch(() => { /* not ours */ });
  }
}

/**
 * @description Start the pump on a timer. Off unless VIDEO_PUMP_ENABLED=true — an automated
 * production loop is opt-in, and each show is opt-in again through its own enrollment.
 * @param {AppContext} ctx app context
 * @param {number} [intervalMs] cycle cadence (default VIDEO_PUMP_INTERVAL_MS or 20 minutes)
 * @returns {(() => void) | null} a stop handle, or null when the pump is not enabled
 */
export function startVideoPump(ctx: AppContext, intervalMs?: number): (() => void) | null {
  if ((process.env.VIDEO_PUMP_ENABLED || '').toLowerCase() !== 'true') {
    logger.info('joke-shorts pump is off (set VIDEO_PUMP_ENABLED=true to run it)');
    return null;
  }
  const every = intervalMs ?? Number(process.env.VIDEO_PUMP_INTERVAL_MS || 20 * 60_000);
  logger.info({ intervalMs: every }, 'joke-shorts pump started');
  const timer = setInterval(() => {
    void runWithSystemIdentity(() => runPumpOnce(ctx))
      .then((c) => {
        if (c.action === 'made') logger.info({ cycle: c }, 'pump produced');
        else logger.debug({ cycle: c }, 'pump cycle');
      })
      .catch((err) => logger.warn({ err: (err as Error).message }, 'pump cycle failed'));
  }, every);
  timer.unref?.();
  return () => clearInterval(timer);
}
