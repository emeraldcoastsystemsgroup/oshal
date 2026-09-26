/**
 * Subscription-driven social signals — the owner-scoped watch/notify seam over
 * the durable inbox sensor.
 *
 * The inbox ingest owns capture. This module owns only selector registration,
 * bot binding, delivery deduplication and audit, and publication to the
 * requesting bot's derived owner lane. No provider token or live social API is
 * used here.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added bounded owner-scoped social signal selectors, inbox matching, delivery dedupe, and derived owner/bot mesh publication.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The poll now runs under the SYSTEM identity: both cron ticks go through runSocialSignalPollAsSystem. oshal_inbox_messages is FORCE-RLS owner-scoped and the default OSHAL_DB_GUC_STRICT=deny stamps an identity-less query anonymous, so the unwrapped cron joined zero rows and produced no signal. Publish and poll failures now log at ERROR instead of being swallowed. Each delivery claim records user_sub, bot_agent_id, channel and the envelope correlation_id, so a delivery row names its owner and the stream entry it produced; listSocialSignalDeliveries returns those rows for a subscription the caller owns and null otherwise. isRegisteredSocialSignalBot binds a subscription to an agentId in the active bot registry. The poll body was split into helpers to stay under the 50-line function limit.
 */

import { createHash, randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import type { MeshCommunicationService } from '@/features/agent-management';
import type { AppContext } from '@/app/composition/app-context';
import { getActiveRegistry } from '@/app/extensions/swarm/swarm-bot-registry';

export const SOCIAL_SIGNAL_KINDS = ['account', 'keyword', 'topic'] as const;
export type SocialSignalKind = typeof SOCIAL_SIGNAL_KINDS[number];

export interface SocialSignalSelector {
  kind: SocialSignalKind;
  value: string;
}

export interface CapturedSocialSignal {
  userSub: string;
  msgId: string;
  fromAddr: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  source: string;
}

export interface SocialSignalSubscription {
  subscriptionId: string;
  userSub: string;
  botAgentId: string;
  selector: SocialSignalSelector;
  active: boolean;
  createdAt: string;
}

/** One owner-readable delivery audit row: which captured message went to which bot lane. */
export interface SocialSignalDelivery {
  msgId: string;
  botAgentId: string;
  channel: string;
  correlationId: string;
  claimedAt: string;
  publishedAt: string | null;
}

/** Outcome counts of one poll. */
export interface SocialSignalPollResult {
  matched: number;
  published: number;
  failed: number;
}

/** The registry shape bot binding reads; the default is the active swarm bot registry. */
export type SocialSignalBotRegistry = () => ReadonlyArray<{ agentId?: string }>;

interface PendingDelivery extends CapturedSocialSignal {
  subscriptionId: string;
  botAgentId: string;
  selector: SocialSignalSelector;
}

/** A claimed delivery: the pending match plus the lane and correlation it is recorded under. */
interface ClaimedDelivery extends PendingDelivery {
  channel: string;
  correlationId: string;
}

const MAX_SELECTOR_VALUE = 160;
const MAX_BOT_AGENT_ID = 120;
const MAX_POLL_MATCHES = 200;
const MAX_DELIVERY_ROWS = 100;
const SOCIAL_SENSOR_AGENT_ID = 'social-signal-sensor';
const logger = createChildLogger({ module: 'social-signal-subscriptions' });

function normalizeText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Parse and bound the descriptor accepted by the caller-owned subscription route. */
export function parseSocialSignalSelector(input: unknown): SocialSignalSelector | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as { kind?: unknown; value?: unknown };
  const kind = raw.kind;
  if (typeof kind !== 'string' || !SOCIAL_SIGNAL_KINDS.includes(kind as SocialSignalKind)) return null;
  if (typeof raw.value !== 'string' || raw.value.trim().length > MAX_SELECTOR_VALUE) return null;
  const value = normalizeText(raw.value, MAX_SELECTOR_VALUE);
  if (!value) return null;
  return { kind: kind as SocialSignalKind, value };
}

/** Bot IDs are registry identities, not free-form message destinations. */
export function parseSocialSignalBotAgentId(input: unknown): string | null {
  const value = normalizeText(input, MAX_BOT_AGENT_ID);
  return /^[A-Za-z0-9._:-]{1,120}$/.test(value) ? value : null;
}

/**
 * @description Bind a subscription to a real bot. A syntactically valid id is not enough: the
 * signal lane is named after the bot, so an id no registered bot answers to would publish
 * owner data to a lane nothing is accountable for. Matches the exact registry `agentId`
 * (statics plus dynamically registered application bots), never a display name.
 * @param botAgentId - The parsed bot id from the subscription request.
 * @param registry - Registry provider; defaults to the active swarm bot registry.
 * @returns True only when an active registry entry carries exactly this agentId.
 */
export function isRegisteredSocialSignalBot(
  botAgentId: string,
  registry: SocialSignalBotRegistry = getActiveRegistry,
): boolean {
  return registry().some((bot) => bot.agentId === botAgentId);
}

/** Match a captured inbox signal without invoking a model or external provider. */
export function matchesSocialSignalSelector(
  selector: SocialSignalSelector,
  signal: Pick<CapturedSocialSignal, 'fromAddr' | 'subject' | 'snippet'>,
): boolean {
  const needle = selector.value.toLocaleLowerCase();
  const from = signal.fromAddr.toLocaleLowerCase();
  const text = `${signal.subject}\n${signal.snippet}`.toLocaleLowerCase();
  if (selector.kind === 'account') return from.includes(needle) || text.includes(needle);
  if (selector.kind === 'keyword') return text.includes(needle);
  return needle.split(/\s+/).filter(Boolean).every((term) => text.includes(term));
}

/**
 * Keep the owner subject out of the Redis key while making each owner's bot lane
 * distinct. The payload remains auditable for the receiving owner-bound bot.
 */
export function socialSignalChannel(userSub: string, botAgentId: string): string {
  const ownerHash = createHash('sha256').update(userSub, 'utf8').digest('hex').slice(0, 32);
  return `social.signal.${ownerHash}.${botAgentId}`;
}

/**
 * @description Register (or re-activate) the caller's watch for one bot and selector. The
 * (user_sub, bot_agent_id, selector) key makes a repeated registration idempotent.
 * @param pool - GUC-aware pool running under the caller's request identity.
 * @param userSub - The authenticated caller; the row's owner.
 * @param botAgentId - A registry-bound bot id (the route refuses unregistered ids first).
 * @param selector - The bounded selector descriptor.
 * @returns The subscription id.
 */
export async function registerSocialSignalSubscription(
  pool: Pool,
  userSub: string,
  botAgentId: string,
  selector: SocialSignalSelector,
): Promise<string> {
  const subscriptionId = randomUUID();
  await pool.query(
    `INSERT INTO oshal_social_signal_subscriptions
       (subscription_id, user_sub, bot_agent_id, selector)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_sub, bot_agent_id, selector) DO UPDATE
       SET active = TRUE, updated_at = now()`,
    [subscriptionId, userSub, botAgentId, JSON.stringify(selector)],
  );
  const row = (await pool.query(
    `SELECT subscription_id FROM oshal_social_signal_subscriptions
     WHERE user_sub=$1 AND bot_agent_id=$2 AND selector=$3::jsonb`,
    [userSub, botAgentId, JSON.stringify(selector)],
  )).rows[0] as { subscription_id: string } | undefined;
  if (!row?.subscription_id) throw new Error('social signal subscription was not persisted');
  return row.subscription_id;
}

/**
 * @description The caller's own watches, newest first. No captured message content is returned.
 * @param pool - GUC-aware pool running under the caller's request identity.
 * @param userSub - The authenticated caller.
 * @returns The caller's subscriptions.
 */
export async function listSocialSignalSubscriptions(
  pool: Pool,
  userSub: string,
): Promise<SocialSignalSubscription[]> {
  const rows = (await pool.query(
    `SELECT subscription_id, user_sub, bot_agent_id, selector, active, created_at
       FROM oshal_social_signal_subscriptions
      WHERE user_sub=$1
      ORDER BY created_at DESC`,
    [userSub],
  )).rows as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    subscriptionId: String(row.subscription_id),
    userSub: String(row.user_sub),
    botAgentId: String(row.bot_agent_id),
    selector: row.selector as SocialSignalSelector,
    active: row.active === true,
    createdAt: new Date(String(row.created_at)).toISOString(),
  }));
}

/**
 * @description Disable one of the caller's watches. Another owner's id matches no row.
 * @param pool - GUC-aware pool running under the caller's request identity.
 * @param userSub - The authenticated caller.
 * @param subscriptionId - The watch to disable.
 * @returns True when a watch owned by the caller was disabled.
 */
export async function deleteSocialSignalSubscription(
  pool: Pool,
  userSub: string,
  subscriptionId: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE oshal_social_signal_subscriptions
        SET active=FALSE, updated_at=now()
      WHERE subscription_id=$1 AND user_sub=$2`,
    [subscriptionId, userSub],
  );
  return (result.rowCount || 0) > 0;
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(String(value)).toISOString();
}

/**
 * @description The owner's delivery audit trail for one subscription. Ownership is checked
 * first so a subscription the caller does not own is indistinguishable from one that does not
 * exist; the delivery read then filters by the caller as well (row-level security on the table
 * enforces the same boundary underneath).
 * @param pool - GUC-aware pool running under the caller's request identity.
 * @param userSub - The authenticated caller.
 * @param subscriptionId - The subscription whose deliveries are requested.
 * @returns The newest delivery rows (at most 100), or null when the caller does not own it.
 */
export async function listSocialSignalDeliveries(
  pool: Pool,
  userSub: string,
  subscriptionId: string,
): Promise<SocialSignalDelivery[] | null> {
  const owned = await pool.query(
    'SELECT 1 FROM oshal_social_signal_subscriptions WHERE subscription_id=$1 AND user_sub=$2',
    [subscriptionId, userSub],
  );
  if (!owned.rows.length) return null;
  const rows = (await pool.query(
    `SELECT msg_id, bot_agent_id, channel, correlation_id, claimed_at, published_at
       FROM oshal_social_signal_deliveries
      WHERE subscription_id=$1 AND user_sub=$2
      ORDER BY claimed_at DESC
      LIMIT $3`,
    [subscriptionId, userSub, MAX_DELIVERY_ROWS],
  )).rows as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    msgId: String(row.msg_id),
    botAgentId: String(row.bot_agent_id),
    channel: String(row.channel),
    correlationId: String(row.correlation_id),
    claimedAt: new Date(String(row.claimed_at)).toISOString(),
    publishedAt: isoOrNull(row.published_at),
  }));
}

async function publishDelivery(mesh: MeshCommunicationService, delivery: ClaimedDelivery): Promise<void> {
  await mesh.send({
    correlationId: delivery.correlationId,
    fromAgentId: SOCIAL_SENSOR_AGENT_ID,
    toAgentId: delivery.botAgentId,
    channel: delivery.channel,
    messageType: 'event',
    payload: {
      type: 'social_signal',
      subscriptionId: delivery.subscriptionId,
      ownerSub: delivery.userSub,
      selector: delivery.selector,
      signal: {
        msgId: delivery.msgId,
        fromAddr: delivery.fromAddr,
        subject: delivery.subject,
        snippet: delivery.snippet,
        receivedAt: delivery.receivedAt,
        source: delivery.source,
      },
    },
  });
}

/** Insert the dedupe/audit claim; false when another poll already claimed this match. */
async function claimDelivery(pool: Pool, delivery: ClaimedDelivery): Promise<boolean> {
  const claim = await pool.query(
    `INSERT INTO oshal_social_signal_deliveries
       (subscription_id, msg_id, user_sub, bot_agent_id, channel, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING subscription_id`,
    [delivery.subscriptionId, delivery.msgId, delivery.userSub, delivery.botAgentId, delivery.channel, delivery.correlationId],
  );
  return Boolean(claim.rowCount);
}

/**
 * Claim, publish, and stamp one match. A failed publish removes its claim so the next poll can
 * retry it, and the failure is logged with the correlation it would have carried.
 */
async function deliverMatch(
  pool: Pool,
  mesh: MeshCommunicationService,
  pending: PendingDelivery,
): Promise<'published' | 'failed' | 'duplicate'> {
  const delivery: ClaimedDelivery = {
    ...pending,
    channel: socialSignalChannel(pending.userSub, pending.botAgentId),
    correlationId: randomUUID(),
  };
  if (!(await claimDelivery(pool, delivery))) return 'duplicate';
  const key = [delivery.subscriptionId, delivery.msgId];
  try {
    await publishDelivery(mesh, delivery);
    await pool.query(
      'UPDATE oshal_social_signal_deliveries SET published_at=now() WHERE subscription_id=$1 AND msg_id=$2',
      key,
    );
    return 'published';
  } catch (err) {
    logger.error(
      { err, subscriptionId: delivery.subscriptionId, correlationId: delivery.correlationId, channel: delivery.channel },
      'social signal delivery failed; releasing the claim so the next poll retries it',
    );
    await pool.query('DELETE FROM oshal_social_signal_deliveries WHERE subscription_id=$1 AND msg_id=$2', key);
    return 'failed';
  }
}

/** Map one joined subscription/inbox row to a pending delivery, or null for a stored selector that no longer parses. */
function pendingFromRow(row: Record<string, unknown>): PendingDelivery | null {
  const selector = parseSocialSignalSelector(row.selector);
  if (!selector) return null;
  return {
    userSub: String(row.user_sub),
    msgId: String(row.msg_id),
    fromAddr: String(row.from_addr || ''),
    subject: String(row.subject || ''),
    snippet: String(row.snippet || ''),
    receivedAt: new Date(String(row.received_at)).toISOString(),
    source: String(row.source || 'inbox'),
    subscriptionId: String(row.subscription_id),
    botAgentId: String(row.bot_agent_id),
    selector,
  };
}

/**
 * Poll the durable inbox sensor and publish each owner/bot/ message match once.
 * A failed publish removes its claim so the next poll can retry it; a different
 * owner cannot select or consume another owner's rows through this function.
 * The inbox sensor is owner-RLS, so the cron calls this through
 * {@link runSocialSignalPollAsSystem}; a bare call under deny-by-default sees no rows.
 */
export async function pollSocialSignalSubscriptions(
  pool: Pool,
  mesh: MeshCommunicationService,
  limit = MAX_POLL_MATCHES,
): Promise<SocialSignalPollResult> {
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), MAX_POLL_MATCHES));
  const rows = (await pool.query(
    `SELECT s.subscription_id, s.user_sub, s.bot_agent_id, s.selector,
            i.msg_id, i.from_addr, i.subject, i.snippet, i.received_at, i.source
       FROM oshal_social_signal_subscriptions s
       JOIN oshal_inbox_messages i
         ON i.user_sub=s.user_sub AND i.category='social' AND i.received_at >= s.created_at
      WHERE s.active=TRUE
        AND NOT EXISTS (
          SELECT 1 FROM oshal_social_signal_deliveries d
           WHERE d.subscription_id=s.subscription_id AND d.msg_id=i.msg_id
        )
      ORDER BY i.received_at ASC
      LIMIT $1`,
    [boundedLimit],
  )).rows as Array<Record<string, unknown>>;
  const result: SocialSignalPollResult = { matched: 0, published: 0, failed: 0 };
  for (const row of rows) {
    const pending = pendingFromRow(row);
    if (!pending || !matchesSocialSignalSelector(pending.selector, pending)) continue;
    result.matched++;
    const outcome = await deliverMatch(pool, mesh, pending);
    if (outcome === 'published') result.published++;
    if (outcome === 'failed') result.failed++;
  }
  return result;
}

/**
 * @description One poll as trusted background work. The poll joins every owner's subscriptions
 * to the owner-RLS inbox sensor, so it must run under the positive SYSTEM sentinel: with the
 * default OSHAL_DB_GUC_STRICT=deny an identity-less query is stamped anonymous and sees no
 * rows at all. Per-owner scoping is kept by the join (i.user_sub = s.user_sub) and the
 * owner-derived lane, not by the connection identity.
 * @param pool - The GUC-aware application pool.
 * @param mesh - Mesh service whose transport XADDs to `oshal:mesh:<channel>`.
 * @param limit - Maximum joined rows to consider in this poll.
 * @returns Matched, published and failed counts for this poll.
 */
export function runSocialSignalPollAsSystem(
  pool: Pool,
  mesh: MeshCommunicationService,
  limit = MAX_POLL_MATCHES,
): Promise<SocialSignalPollResult> {
  return runWithSystemIdentity(() => pollSocialSignalSubscriptions(pool, mesh, limit));
}

let cronStarted = false;

/**
 * @description Start the low-cost inbox-to-mesh poller once per process: a boot tick after 90
 * seconds, then every SOCIAL_SIGNAL_POLL_INTERVAL_MIN minutes (default 15, minimum 2). Both
 * ticks run under the SYSTEM identity and log a failed poll at ERROR.
 * @param ctx - Application context supplying the pool and the swarm mesh service.
 * @returns Nothing; timers are unref'd so they never hold the process open.
 */
export function startSocialSignalSubscriptionCron(ctx: AppContext): void {
  if (cronStarted) return;
  cronStarted = true;
  const mins = Math.max(parseInt(process.env.SOCIAL_SIGNAL_POLL_INTERVAL_MIN || '15', 10), 2);
  const run = (trigger: 'boot' | 'interval') =>
    runSocialSignalPollAsSystem(ctx.pool, ctx.swarm.meshCommunicationService)
      .then((result) => { if (result.matched) loggerInfo(result); })
      .catch((err) => logger.error({ err, trigger }, 'social signal subscription poll failed; the next tick retries unclaimed deliveries'));
  const boot = setTimeout(() => { void run('boot'); }, 90_000); boot.unref();
  const timer = setInterval(() => { void run('interval'); }, mins * 60_000); timer.unref();
}

function loggerInfo(result: SocialSignalPollResult): void {
  // Kept as a tiny indirection so the polling loop never logs message content.
  logger.info(result, 'social signal subscription poll completed');
}
