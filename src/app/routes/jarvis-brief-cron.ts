/**
 * Jarvis morning brief — OPT-IN MORNING DELIVERY (cron + per-user send).
 *
 * Product rules:
 *   - OPT-IN, default OFF (the inverse of the career digest): a user gets the morning
 *     delivery ONLY when they saved an enabled 'morning-brief' preference in the
 *     notification center (user_notification_prefs, topic 'morning-brief'). No pref row
 *     = nothing is ever sent; the on-demand routes are unaffected.
 *   - At most once per ~day, guarded PERSISTENTLY (jarvis_brief_deliveries.last_sent_at
 *     in Postgres, same >20h discipline as career_digest_settings.last_digest_at) so a
 *     container recreate can never double-send.
 *   - Delivery is over the user's OWN channel: their Gmail (gmail.send) or their Twilio
 *     SMS — mirroring the career digest's send plumbing (its senders are module-private,
 *     so the minimal send path is reproduced here rather than reaching into it).
 *   - Quiet hours from the same pref row are honored (America/Chicago, wrap-midnight).
 *
 * Scheduling mirrors career-hunter-cron (the sanctioned app-owned gated timer): a 5-min
 * tick, env-gated per deployment (JARVIS_BRIEF_CRON=1), firing in the 07:00–07:09
 * America/Chicago window. Deliberately NO boot catch-up: a brief delivered mid-afternoon
 * is stale by definition — a missed morning just skips to tomorrow (the on-demand
 * /api/jarvis/brief routes cover the gap).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial opt-in morning delivery: notification-center 'morning-brief' pref gate (opt-in default OFF), persistent once/day cursor (jarvis_brief_deliveries), quiet-hours honor, email via the user's own Gmail / SMS via their own Twilio, env-gated 07:00 CT cron mirroring career-hunter-cron.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Ran the morning-brief cron tick under runWithSystemIdentity — a cross-owner background sweep over per-user brief/preference rows; SYSTEM keeps it visible once OSHAL_DB_GUC_STRICT denies the identity-less case.
 *
 * @module jarvis-brief-cron
 */
import * as path from 'path';
import { spawn } from 'child_process';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { readUserPref, hourInTimeZone, isQuietHours } from '@/features/notifications';
import type { AppContext } from '@/app/composition/app-context';
import { dueForDigest } from './digest-resend-guard';
import { getValidAccessToken } from './connectors-routes';
import { sendGmail } from './email-routes';
import { composeMorningBrief, defaultBriefDeps, type MorningBrief } from './jarvis-brief-sections';

const logger = createChildLogger({ module: 'jarvis-brief-cron' });

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOPIC = 'morning-brief';

let started = false;
const lastRun: Record<string, string> = {}; // job -> YYYY-MM-DD it last ran (this process)

/**
 * @description Create the persistent once/day delivery cursor table (jarvis_brief_deliveries)
 * if it is missing. The cursor must survive container recreates so a restart in the delivery
 * window can never double-send a user's morning brief — that is why it lives in Postgres, not
 * process memory. Idempotent via runRuntimeSchemaBootstrap's CREATE-IF-NOT-EXISTS + verify.
 * @param pool - The Postgres pool.
 * @returns Resolves once the table is present and verified.
 */
export async function ensureBriefSchema(pool: AppContext['pool']): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'jarvis brief cron',
    statements: [
      `CREATE TABLE IF NOT EXISTS jarvis_brief_deliveries (
        user_sub TEXT PRIMARY KEY,
        last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    ],
    requirements: [
      { table: 'jarvis_brief_deliveries', columns: ['user_sub', 'last_sent_at'] },
    ],
  });
}

/**
 * @description Render the brief as a plain-text email. Populated sections carry their
 * one-line summaries; skipped sections are rolled into a single honest footnote (never
 * silently dropped — the user should know what their brief can't see yet). Always ends
 * with the opt-out pointer: this is a subscription the user turned on and must always
 * be able to find the off switch for.
 * @param brief - The composed morning brief.
 * @returns subject + body ready for sendGmail.
 */
export function formatBriefEmail(brief: MorningBrief): { subject: string; body: string } {
  const day = brief.generatedAt.slice(0, 10);
  const live = brief.sections.filter((s) => !s.skipped);
  const skipped = brief.sections.filter((s) => s.skipped);
  const subject = `Your OSHAL morning brief — ${day}`;
  const lines: string[] = [`Good morning — here's your brief for ${day}:`, ''];
  for (const s of live) {
    if (!s.skipped) lines.push(`## ${s.title}`, s.summary, '');
  }
  if (skipped.length) {
    lines.push(`Not included today: ${skipped.map((s) => s.title).join(', ')} (no data or connection yet).`, '');
  }
  lines.push(
    '— OSHAL Jarvis (automated morning brief, at most one per day).',
    'You get this because you turned the morning brief ON in Notification preferences — turn it off there any time.',
  );
  return { subject, body: lines.join('\n') };
}

/**
 * @description Render the brief as one SMS-sized text: each populated section's summary
 * truncated, joined. SMS is a nudge — the cockpit brief page is the surface.
 * @param brief - The composed morning brief.
 * @returns A single text message body.
 */
export function formatBriefSms(brief: MorningBrief): string {
  const live = brief.sections.filter((s) => !s.skipped);
  const parts = live.map((s) => (s.skipped ? '' : `${s.title}: ${s.summary.slice(0, 90)}`)).filter(Boolean);
  const gist = parts.length ? parts.join(' | ') : 'Nothing new this morning.';
  return `OSHAL brief: ${gist}`.slice(0, 440) + ' (opt-in; manage in Notification prefs)';
}

/** Every user with an ENABLED morning-brief pref (the opt-in set). Fails open to []. */
async function listOptedInUsers(pool: AppContext['pool']): Promise<string[]> {
  try {
    const r = await pool.query(
      `SELECT user_sub FROM user_notification_prefs WHERE topic=$1 AND enabled=TRUE AND channel <> 'none'`,
      [TOPIC]);
    return r.rows.map((row: { user_sub: string }) => String(row.user_sub));
  } catch (err) {
    logger.error({ err, stack: (err as Error).stack }, 'brief cron: opted-in list failed — delivering to nobody this tick');
    return [];
  }
}

/** The persistent once/day cursor for one user (null = never delivered). */
async function readCursor(pool: AppContext['pool'], userSub: string): Promise<string | null> {
  const r = await pool.query('SELECT last_sent_at FROM jarvis_brief_deliveries WHERE user_sub=$1', [userSub]);
  const at = r.rows[0]?.last_sent_at;
  return at ? new Date(at).toISOString() : null;
}

/** Send via the user's own Gmail (to their own address). False = not sent (token/scope). */
async function sendViaEmail(pool: AppContext['pool'], userSub: string, brief: MorningBrief): Promise<boolean> {
  const token = await getValidAccessToken(pool, userSub, 'google');
  if (!token) return false;
  const prof = await fetch(`${GMAIL}/profile`, { headers: { Authorization: `Bearer ${token}` } });
  if (!prof.ok) { logger.warn({ userSub, status: prof.status }, 'brief: gmail profile read failed'); return false; }
  const to = String(((await prof.json()) as { emailAddress?: string }).emailAddress || '');
  if (!to) return false;
  const { subject, body } = formatBriefEmail(brief);
  try {
    const sent = await sendGmail(token, { to, subject, body });
    logger.info({ userSub, id: sent.id }, 'brief: emailed');
    return true;
  } catch (err) {
    logger.warn({ userSub, err: (err as Error).message }, 'brief: gmail send failed');
    return false;
  }
}

/** Send via the user's own Twilio (scripts/oshal-twilio.js resolves their per-user secret). */
function sendViaText(userSub: string, phone: string, brief: MorningBrief): Promise<boolean> {
  const cli = path.resolve(process.cwd(), 'scripts', 'oshal-twilio.js');
  const body = formatBriefSms(brief);
  return new Promise((resolve) => {
    const proc = spawn('node', [cli, 'sms', phone, body, '--confirm'], {
      env: { ...process.env, OSHAL_USER_SUB: userSub, OSHAL_MESSAGE_SEND_CONFIRM: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    proc.stderr?.on('data', (d) => { err += String(d); });
    proc.on('exit', (code) => {
      if (code === 0) { logger.info({ userSub }, 'brief: texted'); resolve(true); }
      else { logger.warn({ userSub, code, err: err.slice(-300) }, 'brief: sms send failed'); resolve(false); }
    });
    proc.on('error', (e) => { logger.error({ userSub, err: (e as Error).message, stack: (e as Error).stack }, 'brief: sms spawn failed'); resolve(false); });
  });
}

/**
 * @description Deliver one user's morning brief end-to-end: opt-in gate (no enabled
 * 'morning-brief' pref = never send) → quiet-hours honor → persistent once/day guard →
 * compose → send over THEIR channel → advance the cursor. The cursor only advances on a
 * REAL send, so a user whose channel fails still gets their brief once it works.
 * @param ctx - App context (pool for prefs/cursor/connections).
 * @param userSub - The opted-in user to deliver to.
 * @param opts - force bypasses quiet hours + the once/day guard (explicit send-now paths).
 * @returns What happened, for logs.
 */
export async function sendBriefForUser(
  ctx: AppContext, userSub: string, opts: { force?: boolean } = {},
): Promise<{ sent: boolean; channel?: 'email' | 'sms'; reason?: string }> {
  const pref = await readUserPref(ctx.pool, userSub, TOPIC);
  if (!pref || !pref.enabled || pref.channel === 'none') return { sent: false, reason: 'not-opted-in' };
  if (!opts.force && isQuietHours(pref.quietHoursStart, pref.quietHoursEnd, hourInTimeZone(new Date()))) {
    return { sent: false, reason: 'quiet-hours' };
  }
  const lastSentAt = await readCursor(ctx.pool, userSub);
  if (!opts.force && !dueForDigest(lastSentAt)) return { sent: false, reason: 'already-sent-today' };

  const brief = await composeMorningBrief(defaultBriefDeps(ctx), userSub);
  if (brief.sections.every((s) => s.skipped)) {
    logger.info({ userSub }, 'brief: every section skipped — nothing to deliver (cursor untouched)');
    return { sent: false, reason: 'nothing-to-report' };
  }

  let ok = false;
  let channel: 'email' | 'sms' | undefined;
  if (pref.channel === 'email') { ok = await sendViaEmail(ctx.pool, userSub, brief); channel = ok ? 'email' : undefined; }
  else if (pref.channel === 'sms' && pref.phone) { ok = await sendViaText(userSub, pref.phone, brief); channel = ok ? 'sms' : undefined; }
  else if (pref.channel === 'telegram') {
    logger.warn({ userSub }, 'brief: pref channel telegram has no per-user delivery leg yet — skipped (cursor untouched)');
    return { sent: false, reason: 'telegram-unavailable' };
  }
  if (!ok) {
    logger.info({ userSub, channel: pref.channel }, 'brief: opted in but the channel send failed/unusable — skipped (cursor untouched)');
    return { sent: false, reason: 'no-channel' };
  }
  await ctx.pool.query(
    `INSERT INTO jarvis_brief_deliveries (user_sub, last_sent_at) VALUES ($1, NOW())
     ON CONFLICT (user_sub) DO UPDATE SET last_sent_at=NOW()`, [userSub]);
  return { sent: true, channel };
}

/**
 * @description The cron batch: deliver to every opted-in user. Per-user failures are
 * logged and never abort the batch.
 * @param ctx - App context.
 */
export async function sendBriefsForAllUsers(ctx: AppContext): Promise<void> {
  for (const userSub of await listOptedInUsers(ctx.pool)) {
    try {
      const r = await sendBriefForUser(ctx, userSub);
      logger.info({ userSub, ...r }, 'morning brief: user done');
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, userSub }, 'morning brief: user failed');
    }
  }
}

/** One tick: fire the batch inside the 07:00–07:09 America/Chicago window, once/day. */
async function tick(ctx: AppContext): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  if (lastRun.brief === day) return;
  // Hour must be timezone-converted (containers run UTC); minutes are zone-invariant
  // for whole-hour-offset zones like America/Chicago.
  const inWindow = hourInTimeZone(new Date()) === 7 && new Date().getUTCMinutes() < 10;
  if (!inWindow) return;
  lastRun.brief = day;
  await sendBriefsForAllUsers(ctx);
}

/**
 * @description Start the gated morning-delivery timer once. No-op unless
 * JARVIS_BRIEF_CRON is truthy (deployment-level gate; the per-user gate is the opt-in
 * 'morning-brief' notification pref — default OFF). Deliberately no boot catch-up: a
 * missed morning skips to tomorrow rather than delivering a stale afternoon "morning"
 * brief (the persistent cursor would make a catch-up safe, but not sensible).
 * @param ctx - App context.
 */
export function startJarvisBriefCron(ctx: AppContext): void {
  if (started) return;
  started = true;
  if (!['1', 'true', 'yes'].includes((process.env.JARVIS_BRIEF_CRON || '').toLowerCase())) {
    logger.info('jarvis brief cron disabled (set JARVIS_BRIEF_CRON=1 to enable morning delivery)');
    return;
  }
  ensureBriefSchema(ctx.pool).catch((err) => logger.error({ err, stack: (err as Error).stack }, 'brief cron: schema bootstrap failed'));
  logger.info('jarvis brief cron enabled (delivery window 07:00 America/Chicago; per-user opt-in via the morning-brief notification pref)');
  const cronTimer = setInterval(() => { void runWithSystemIdentity(() => tick(ctx)).catch((err) => logger.error({ err, stack: (err as Error).stack }, 'brief cron tick failed')); }, 5 * 60 * 1000);
  cronTimer.unref();
}
