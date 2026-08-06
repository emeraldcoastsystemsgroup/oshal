/**
 * Notification preference center — routes + the concrete per-user senders.
 *
 * The app-layer half of the preference center: builds the real `UserChannelSender`s the
 * feature-layer NotificationRouter dispatches through (each wraps an EXISTING delivery
 * path — the user's own Gmail via getValidAccessToken+sendGmail, the user's own Twilio via
 * a fixed in-process server operation, Telegram via the slice's TelegramTransport which WARN-no-ops
 * until the BotFather token lands) and mounts the self-scoped routes:
 *
 *   GET  /api/notify/prefs     — the caller's saved per-topic routing + their default channel
 *   POST /api/notify/prefs     — save one topic card (full replace)
 *   POST /api/notify/test      — confirm-gated real send over the caller's resolved channel
 *   POST /api/notify/operator  — OPERATOR-only, confirm-gated ad-hoc alert over the deployment
 *                                operator transport (notifyOperator) — the ops-rails "page a human"
 *                                rail; distinct from /test, which is the caller's own channel.
 *
 * The self-scoped routes are scoped to the OIDC caller (callerSub) — no cross-user read/send.
 * /operator fires the DEPLOYMENT-level transport harness (Telegram/Twilio env) and is therefore
 * requiresOperator + confirm-gated (it can page a human). A channel with missing creds is a clean
 * logged skip, never fabricated success.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — per-user email/sms/telegram senders over the existing transports, buildNotificationRouter(ctx) for producers, and the requiresAuth-gated prefs/test routes (test is confirm-gated like digest send-now: outward-facing).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix: topics are normalized to lowercase before validation/persist (TOPIC_RE was /i while producers readUserPref with an exact-match WHERE — a mixed-case topic saved fine but was a silent no-op pref that never suppressed anything).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Ops-rails notify surface: POST /api/notify/operator — requiresOperator + confirm:true-gated ad-hoc alert through the deployment operator transport (notifyOperator). It can page a human, so it is confirm-gated (428 without confirm) and operator-only; 200 on delivery, 502 with the transport result when the send was skipped/failed (an operator paging rail must fail loud when nothing went out).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added buildOperatorEmailRail (operator Gmail via the connector broker → NOTIFY_EMAIL_TO; undefined => email transport no-ops) and POST /api/notify/alert — operator + confirm:true-gated severity-routed alert via notifyBySeverity, injecting the email rail so critical/error levels can reach an inbox. Fails loud (502) when no configured transport delivered.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Welcome-wizard notifications opt-in support: (1) smsSender falls back to the DEPLOYMENT's Twilio (env SID/token/from via TwilioSmsTransport, destination overridden to pref.phone — the same env-injection trick telegramSender uses) when the user has no personal Twilio connection, so a family user who just types their number can get texts; the user's own connected Twilio still wins. (2) NEW voiceSender — the per-user 'voice' channel (migration 099): TwilioVoiceTransport over env creds with TWILIO_TO_NUMBER overridden to pref.phone. (3) Sender factories exported for the unit specs.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: replace the per-user Twilio child-process/whole-environment carrier with the fixed server-side SMS operation, and pass only each deployment transport's exact credential fields instead of cloning process.env.
 *
 * @module notify-routes
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { requiresOperator } from '@/shared/middleware/authz';
import type { AppContext } from '@/app/composition/app-context';
import { getValidAccessToken } from './connectors-routes';
import { sendGmail } from './email-routes';
import { sendUserTwilioSms } from './twilio-sms-operation';
import { callerSub } from './caller-sub';
import {
  NotificationRouter,
  TelegramTransport,
  TwilioSmsTransport,
  TwilioVoiceTransport,
  NOTIFY_CHANNELS,
  NOTIFY_SEVERITIES,
  listUserPrefs,
  upsertUserPref,
  notifyOperator,
  notifyBySeverity,
  type NotifyChannel,
  type NotifySeverity,
  type EmailTransportRail,
  type UserChannelSender,
  type UserNotificationPref,
} from '@/features/notifications';

const logger = createChildLogger({ module: 'notify-routes' });

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
// Case-SENSITIVE on purpose: producers call readUserPref with an exact-match WHERE, so a
// stored "Career-Digest" would be a silent no-op pref. Input is lowercased before this test.
const TOPIC_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const E164_RE = /^\+[1-9]\d{6,14}$/;

/** True when the user has a connected Google account that requested gmail.send (mirrors career-digest). */
async function gmailReady(pool: AppContext['pool'], userSub: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT scopes FROM oshal_connections WHERE user_sub=$1 AND provider='google' AND status='connected'`,
    [userSub]);
  return r.rows.some((c: { scopes?: string }) => /gmail\.send/.test(String(c.scopes || '')));
}

/** True when the user has a connected Twilio account (their own SID/token, brokered per-user). */
async function twilioReady(pool: AppContext['pool'], userSub: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM oshal_connections WHERE user_sub=$1 AND provider='twilio' AND status='connected'`,
    [userSub]);
  return r.rows.length > 0;
}

/** Email sender: the user's OWN Gmail, to their own address (token via the connector broker). */
function emailSender(pool: AppContext['pool']): UserChannelSender {
  return {
    channel: 'email',
    async available(userSub) { return gmailReady(pool, userSub); },
    async send(userSub, _pref, message) {
      const token = await getValidAccessToken(pool, userSub, 'google');
      if (!token) { logger.info({ userSub }, 'notify email skipped — no valid google token'); return { delivered: false, error: 'no-google-token' }; }
      const prof = await fetch(`${GMAIL}/profile`, { headers: { Authorization: `Bearer ${token}` } });
      if (!prof.ok) { logger.warn({ userSub, status: prof.status }, 'notify email: gmail profile lookup failed'); return { delivered: false, error: `gmail_profile_${prof.status}` }; }
      const to = String(((await prof.json()) as { emailAddress?: string }).emailAddress || '');
      if (!to) return { delivered: false, error: 'no-gmail-address' };
      try {
        const sent = await sendGmail(token, { to, subject: message.subject, body: message.body });
        return { delivered: true, id: sent.id };
      } catch (err) {
        // A connection whose gmail.send consent was declined 403s here — logged skip, never a throw.
        logger.warn({ userSub, err: (err as Error).message }, 'notify email: gmail send failed');
        return { delivered: false, error: 'gmail-send-failed' };
      }
    },
  };
}

/** True when the deployment's own Twilio env credentials can carry a send (SID + token + from). */
export function envTwilioConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean((env.TWILIO_ACCOUNT_SID || '').trim() && (env.TWILIO_AUTH_TOKEN || '').trim() && (env.TWILIO_FROM_NUMBER || '').trim());
}

/** Build the minimum deployment-Twilio environment accepted by notification transports. */
function deploymentTwilioEnv(to: string): NodeJS.ProcessEnv {
  return {
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER,
    TWILIO_TO_NUMBER: to,
  };
}

/**
 * SMS sender. The user's OWN connected Twilio (via a fixed server operation) wins when present;
 * otherwise the DEPLOYMENT's env Twilio carries the text to pref.phone — the destination is
 * injected as TWILIO_TO_NUMBER over a TwilioSmsTransport, the same sanctioned env-override
 * trick telegramSender uses for the chat id. Without the fallback a family user had to
 * register their own Twilio account just to get a text.
 */
export function smsSender(pool: AppContext['pool']): UserChannelSender {
  return {
    channel: 'sms',
    async available(userSub, pref) {
      if (!pref?.phone) { logger.info({ userSub }, 'notify sms skipped — no destination phone saved in prefs'); return false; }
      if (await twilioReady(pool, userSub)) return true;
      if (envTwilioConfigured()) return true;
      logger.info({ userSub }, 'notify sms skipped — no connected Twilio account and no deployment Twilio env (clean skip, nothing spawned)');
      return false;
    },
    async send(userSub, pref, message) {
      const body = (message.shortText || message.subject).slice(0, 640);
      if (!(await twilioReady(pool, userSub))) {
        // Deployment-Twilio fallback: env creds, per-user destination.
        const t = new TwilioSmsTransport({ env: deploymentTwilioEnv(pref?.phone || '') });
        const r = await t.send({ text: body });
        logger.info({ userSub, delivered: r.delivered }, 'notify sms sent via deployment Twilio (env fallback)');
        return { delivered: r.delivered, ...(r.id ? { id: r.id } : {}), ...(r.error ? { error: r.error } : {}) };
      }
      const result = await sendUserTwilioSms(pool, userSub, pref?.phone || '', body);
      logger.info({ userSub, delivered: result.delivered }, 'notify sms attempted via user Twilio');
      return result;
    },
  };
}

/**
 * Voice sender — the per-user 'voice' channel (migration 099): the deployment's Twilio
 * calls pref.phone and SPEAKS the message (TwiML <Say>). Voice has no per-user-account
 * tier (nobody registers a personal Twilio to receive a call), so this is env-creds-only
 * with the destination injected per user, mirroring the telegram chat-id override.
 */
export function voiceSender(): UserChannelSender {
  return {
    channel: 'voice',
    async available(userSub, pref) {
      if (!pref?.phone) { logger.info({ userSub }, 'notify voice skipped — no destination phone saved in prefs'); return false; }
      if (!envTwilioConfigured()) { logger.info({ userSub }, 'notify voice skipped — deployment Twilio env not configured'); return false; }
      return true;
    },
    async send(userSub, pref, message) {
      const t = new TwilioVoiceTransport({ env: deploymentTwilioEnv(pref?.phone || '') });
      const r = await t.send({ text: (message.shortText || message.subject).slice(0, 640) });
      logger.info({ userSub, delivered: r.delivered }, 'notify voice call attempted via deployment Twilio');
      return { delivered: r.delivered, ...(r.id ? { id: r.id } : {}), ...(r.error ? { error: r.error } : {}) };
    },
  };
}

/** Telegram sender: registered now, WARN-no-op until TELEGRAM_BOT_TOKEN lands (per plan of record). */
function telegramSender(): UserChannelSender {
  return {
    channel: 'telegram',
    async available(userSub, pref) {
      if (!(process.env.TELEGRAM_BOT_TOKEN || '').trim()) {
        logger.warn({ userSub }, 'telegram channel selected but TELEGRAM_BOT_TOKEN is not configured (BotFather token pending) — no-op');
        return false;
      }
      if (!pref?.telegramChatId) {
        logger.warn({ userSub }, 'telegram channel selected but no telegram_chat_id saved in prefs — no-op');
        return false;
      }
      return true;
    },
    async send(_userSub, pref, message) {
      // Per-user destination: override only the chat id; the bot token stays env-owned.
      const t = new TelegramTransport({
        env: {
          TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
          TELEGRAM_CHAT_ID: pref?.telegramChatId || '',
        },
      });
      const r = await t.send({ text: `${message.subject}\n\n${message.body}` });
      return { delivered: r.delivered, ...(r.id ? { id: r.id } : {}), ...(r.error ? { error: r.error } : {}) };
    },
  };
}

/**
 * @description Build the production NotificationRouter over this app context: the three
 * per-user senders + the spec default channel (email when the user has a Gmail-send
 * connection, else none). Producers (career digest siblings, alerts) call this once and
 * reuse the instance.
 * @param ctx - App context (pool).
 * @returns A ready NotificationRouter.
 */
export function buildNotificationRouter(ctx: AppContext): NotificationRouter {
  const pool = ctx.pool;
  return new NotificationRouter({
    pool,
    senders: { email: emailSender(pool), sms: smsSender(pool), voice: voiceSender(), telegram: telegramSender() },
    defaultChannel: async (userSub) => ((await gmailReady(pool, userSub)) ? 'email' : 'none'),
  });
}

/**
 * @description Build the DEPLOYMENT-level email rail for the operator `email` NotificationTransport:
 * The operator's own Gmail (token brokered per-user, never an SMTP secret) delivering to
 * NOTIFY_EMAIL_TO. The sending identity is NOTIFY_EMAIL_SENDER_SUB, else the first OSHAL_OPERATOR_SUBS
 * entry. Returns undefined when the destination or a sending identity is unset, so the email transport
 * cleanly no-ops on a deployment that hasn't wired it (graceful degrade, never a throw).
 * @param pool - App context pool (for the connector token broker).
 * @returns The injectable email rail, or undefined when not configured.
 */
export function buildOperatorEmailRail(pool: AppContext['pool']): EmailTransportRail | undefined {
  const to = (process.env.NOTIFY_EMAIL_TO || '').trim();
  const senderSub = (process.env.NOTIFY_EMAIL_SENDER_SUB || (process.env.OSHAL_OPERATOR_SUBS || '').split(',')[0] || '').trim();
  if (!to || !senderSub) return undefined;
  return {
    to,
    getAccessToken: () => getValidAccessToken(pool, senderSub, 'google'),
    sendEmail: (token, m) => sendGmail(token, m),
  };
}

/** Validate + normalize a POST /prefs body into a persistable pref; string = the 400 message. */
function parsePrefBody(userSub: string, body: Record<string, unknown>): Omit<UserNotificationPref, 'updatedAt'> | string {
  // Lowercase before validating: producers match topics exactly, so the canonical stored
  // form must be the lowercase one they look up ('career-digest', never 'Career-Digest').
  const topic = String(body.topic || '').trim().toLowerCase();
  if (!TOPIC_RE.test(topic)) return 'topic must be 1-64 chars of [a-z0-9_-]';
  const channel = String(body.channel || '').trim() as NotifyChannel;
  if (!(NOTIFY_CHANNELS as readonly string[]).includes(channel)) return `channel must be one of ${NOTIFY_CHANNELS.join('|')}`;
  const hour = (v: unknown): number | null | undefined => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : undefined;
  };
  const qStart = hour(body.quietHoursStart);
  const qEnd = hour(body.quietHoursEnd);
  if (qStart === undefined || qEnd === undefined) return 'quietHoursStart/quietHoursEnd must be integers 0-23 or null';
  if ((qStart === null) !== (qEnd === null)) return 'quiet hours need both a start and an end (or neither)';
  const phone = String(body.phone || '').trim() || null;
  if (phone && !E164_RE.test(phone)) return 'phone must be E.164 (+15551234567)';
  const telegramChatId = String(body.telegramChatId || '').trim() || null;
  return { userSub, topic, channel, enabled: body.enabled !== false, quietHoursStart: qStart, quietHoursEnd: qEnd, phone, telegramChatId };
}

/**
 * @description Create the /api/notify router: self-scoped pref read/save + a confirm-gated
 * test send. Every route sits behind the passed requiresAuth (the sanctioned pattern —
 * routes are anonymous-callable by default in this app, so the guard is explicit).
 * @param ctx - App context (pool).
 * @param requiresAuth - OIDC auth middleware from server.ts.
 * @returns Router to mount at /api/notify.
 */
export function createNotifyRoutes(ctx: AppContext, requiresAuth: RequestHandler): Router {
  const router = Router();
  const pool = ctx.pool;
  const notifier = buildNotificationRouter(ctx);

  router.get('/prefs', requiresAuth, async (req: Request, res: Response) => {
    const userSub = callerSub(req);
    if (!userSub) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const [prefs, emailReady] = await Promise.all([listUserPrefs(pool, userSub), gmailReady(pool, userSub)]);
      res.json({ prefs, defaultChannel: emailReady ? 'email' : 'none', channels: NOTIFY_CHANNELS });
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, userSub }, 'notify prefs read failed');
      res.status(500).json({ error: 'prefs read failed' });
    }
  });

  router.post('/prefs', requiresAuth, async (req: Request, res: Response) => {
    const userSub = callerSub(req);
    if (!userSub) { res.status(401).json({ error: 'unauthorized' }); return; }
    const parsed = parsePrefBody(userSub, req.body || {});
    if (typeof parsed === 'string') { res.status(400).json({ error: parsed }); return; }
    try {
      await upsertUserPref(pool, parsed);
      res.json({ ok: true, pref: parsed });
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, userSub, topic: parsed.topic }, 'notify pref save failed');
      res.status(500).json({ error: 'pref save failed' });
    }
  });

  router.post('/test', requiresAuth, async (req: Request, res: Response) => {
    const userSub = callerSub(req);
    if (!userSub) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (req.body?.confirm !== true) {
      res.status(428).json({ error: 'confirm required', message: 'POST {"confirm":true} to send a real test notification to yourself.' });
      return;
    }
    const rawTopic = String(req.body?.topic || 'test').trim().toLowerCase();
    const topic = TOPIC_RE.test(rawTopic) ? rawTopic : 'test';
    const outcome = await notifier.notify(userSub, topic, {
      subject: `OSHAL notification test (${topic})`,
      body: `This is a test of your OSHAL notification routing for topic "${topic}". If you received this on the channel you expected, your preference is working.`,
      shortText: `OSHAL test notification (${topic}) — your routing works.`,
    });
    res.status(outcome.delivered ? 200 : 409).json(outcome);
  });

  // Operator-only ad-hoc alert over the DEPLOYMENT operator transport (notifyOperator — the
  // env-configured Telegram/Twilio harness, a logged no-op when unconfigured). This is the
  // ops-rails "page a human" rail: requiresOperator + confirm:true-gated (it can reach a phone),
  // and it fails LOUD (502) when the send did not actually go out, so a monitoring operator is
  // never fooled by a silent skip.
  router.post('/operator', requiresAuth, requiresOperator, async (req: Request, res: Response) => {
    const startedAt = Date.now();
    if (req.body?.confirm !== true) {
      res.status(428).json({ error: 'confirm required', message: 'POST {"text":"...","confirm":true} to send a real operator alert (this can page a human).' });
      return;
    }
    const text = String(req.body?.text || '').trim();
    if (!text) { res.status(400).json({ error: 'text required', message: 'Provide a non-empty "text" to send.' }); return; }
    const bounded = text.slice(0, 2000);
    const actor = callerSub(req);
    try {
      const result = await notifyOperator({ text: bounded });
      logger.info({ actor, transport: result.transport, delivered: result.delivered, skipped: result.skipped, durationMs: Date.now() - startedAt }, 'POST /api/notify/operator');
      res.status(result.delivered ? 200 : 502).json({ ok: result.delivered, result });
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, actor }, 'operator notify send failed');
      res.status(500).json({ error: 'operator notify failed' });
    }
  });

  // Operator-only SEVERITY-routed alert: routes the message through the severity→transport policy
  // (notifyBySeverity), injecting the deployment email rail so error/critical levels can reach an
  // inbox alongside Telegram/SMS/voice. Like /operator it can page a human, so it is requiresOperator
  // + confirm:true-gated and fails LOUD (502) when NO configured transport actually delivered.
  router.post('/alert', requiresAuth, requiresOperator, async (req: Request, res: Response) => {
    const startedAt = Date.now();
    if (req.body?.confirm !== true) {
      res.status(428).json({ error: 'confirm required', message: 'POST {"severity":"error","text":"...","confirm":true} to send a real severity-routed alert (this can page a human).' });
      return;
    }
    const severity = String(req.body?.severity || '').trim().toLowerCase();
    if (!(NOTIFY_SEVERITIES as readonly string[]).includes(severity)) {
      res.status(400).json({ error: `severity must be one of ${NOTIFY_SEVERITIES.join('|')}` });
      return;
    }
    const text = String(req.body?.text || '').trim();
    if (!text) { res.status(400).json({ error: 'text required', message: 'Provide a non-empty "text" to send.' }); return; }
    const bounded = text.slice(0, 2000);
    const actor = callerSub(req);
    try {
      const results = await notifyBySeverity(severity as NotifySeverity, { text: bounded }, { deps: { email: buildOperatorEmailRail(pool) } });
      const delivered = results.some((r) => r.delivered);
      logger.info({ actor, severity, attempted: results.length, delivered: results.filter((r) => r.delivered).length, durationMs: Date.now() - startedAt }, 'POST /api/notify/alert');
      res.status(delivered ? 200 : 502).json({ ok: delivered, results });
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, actor, severity }, 'severity alert send failed');
      res.status(500).json({ error: 'severity alert failed' });
    }
  });

  return router;
}
