/**
 * Subscription-driven social signals — the owner-scoped watch/notify seam over
 * the durable inbox sensor.
 *
 * The inbox ingest owns capture. This module owns only selector registration,
 * delivery deduplication, and publication to the requesting bot's derived owner
 * lane. No provider token or live social API is used here.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Added bounded owner-scoped social signal selectors, inbox matching, delivery dedupe, and derived owner/bot mesh publication.
 */

import { createHash, randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { MeshCommunicationService } from '@/features/agent-management';
import type { AppContext } from '@/app/composition/app-context';

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

interface PendingDelivery extends CapturedSocialSignal {
  subscriptionId: string;
  botAgentId: string;
  selector: SocialSignalSelector;
}

const MAX_SELECTOR_VALUE = 160;
const MAX_BOT_AGENT_ID = 120;
const MAX_POLL_MATCHES = 200;
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

async function publishDelivery(
  mesh: MeshCommunicationService,
  delivery: PendingDelivery,
): Promise<void> {
  await mesh.send({
    correlationId: randomUUID(),
    fromAgentId: SOCIAL_SENSOR_AGENT_ID,
    toAgentId: delivery.botAgentId,
    channel: socialSignalChannel(delivery.userSub, delivery.botAgentId),
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

/**
 * Poll the durable inbox sensor and publish each owner/bot/ message match once.
 * A failed publish removes its claim so the next poll can retry it; a different
 * owner cannot select or consume another owner's rows through this function.
 */
export async function pollSocialSignalSubscriptions(
  pool: Pool,
  mesh: MeshCommunicationService,
  limit = MAX_POLL_MATCHES,
): Promise<{ matched: number; published: number; failed: number }> {
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
  let matched = 0;
  let published = 0;
  let failed = 0;
  for (const row of rows) {
    const selector = parseSocialSignalSelector(row.selector);
    if (!selector) continue;
    const signal = {
      userSub: String(row.user_sub),
      msgId: String(row.msg_id),
      fromAddr: String(row.from_addr || ''),
      subject: String(row.subject || ''),
      snippet: String(row.snippet || ''),
      receivedAt: new Date(String(row.received_at)).toISOString(),
      source: String(row.source || 'inbox'),
    } satisfies CapturedSocialSignal;
    if (!matchesSocialSignalSelector(selector, signal)) continue;
    matched++;
    const subscriptionId = String(row.subscription_id);
    const botAgentId = String(row.bot_agent_id);
    const claim = await pool.query(
      `INSERT INTO oshal_social_signal_deliveries (subscription_id, msg_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING subscription_id`,
      [subscriptionId, signal.msgId],
    );
    if (!claim.rowCount) continue;
    try {
      await publishDelivery(mesh, { ...signal, subscriptionId, botAgentId, selector });
      await pool.query(
        `UPDATE oshal_social_signal_deliveries SET published_at=now()
          WHERE subscription_id=$1 AND msg_id=$2`,
        [subscriptionId, signal.msgId],
      );
      published++;
    } catch (err) {
      failed++;
      await pool.query(
        `DELETE FROM oshal_social_signal_deliveries WHERE subscription_id=$1 AND msg_id=$2`,
        [subscriptionId, signal.msgId],
      );
    }
  }
  return { matched, published, failed };
}

let cronStarted = false;

/** Start the low-cost inbox-to-mesh poller once per process. */
export function startSocialSignalSubscriptionCron(ctx: AppContext): void {
  if (cronStarted) return;
  cronStarted = true;
  const mins = Math.max(parseInt(process.env.SOCIAL_SIGNAL_POLL_INTERVAL_MIN || '15', 10), 2);
  const run = () => pollSocialSignalSubscriptions(ctx.pool, ctx.swarm.meshCommunicationService)
    .then((result) => { if (result.matched) loggerInfo(result); })
    .catch(() => { /* the next poll retries unclaimed deliveries */ });
  const boot = setTimeout(run, 90_000); boot.unref();
  const timer = setInterval(run, mins * 60_000); timer.unref();
}

function loggerInfo(result: { matched: number; published: number; failed: number }): void {
  // Kept as a tiny indirection so the polling loop never logs message content.
  logger.info(result, 'social signal subscription poll completed');
}
