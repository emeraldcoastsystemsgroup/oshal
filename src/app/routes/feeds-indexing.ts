/**
 * Feeds indexing — the durable data layer under the Feeds app.
 *
 * Decouples INGEST from VIEW (mirrors inbox-ingest):
 *   - a cron pulls each connected user's Slack messages on an interval and upserts them into
 *     feed_messages (deduped), advancing feed_settings.last_synced_at.
 *   - on-view, opening the surface kicks a fresh sync if the index is stale (so the feed is
 *     warm right after login without waiting for the next cron tick).
 *
 * Per-user config lives in feed_settings (poll on/off, interval, caps, sentiment opt-in) with
 * DB defaults, so "poll periodically by default after the user connects" needs no per-user
 * setup. The sentiment_* columns on feed_messages are left for the sentiment team to fill.
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — feed_messages/feed_settings
 *            | ensure + get/update settings + indexUserFeed + indexAllFeeds + cron + on-view sync.
 * ---------------------------------------------------------------------------
 * @module feeds-indexing
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Cron start is now actually idempotent (double-start guard) and the timers are unref-ed and handle-captured (2026-07-05 leak audit)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Ran the feed-indexing sweep under runWithSystemIdentity — a cross-owner background sweep that writes the FORCE-RLS rag_chunks table; SYSTEM keeps it visible once OSHAL_DB_GUC_STRICT denies the identity-less case.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Wrapped the BOOT setTimeout run in runWithSystemIdentity too — the 15:25 change wrapped only the interval tick, so the boot sweep still ran identity-less (surfaced by the hardened guc warn-audit).
 */

import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import type { AppContext } from '@/app/composition/app-context';
import { getValidAccessToken } from './connectors-routes';
import { pullSlackFeed } from './slack-client';

const logger = createChildLogger({ module: 'feeds-indexing' });

export interface FeedSettings {
  pollEnabled: boolean;
  pollIntervalMinutes: number;
  maxChannels: number;
  perChannel: number;
  sentimentEnabled: boolean;
  lastSyncedAt: string | null;
}

const DEFAULTS: FeedSettings = {
  pollEnabled: true, pollIntervalMinutes: 30, maxChannels: 25, perChannel: 15,
  sentimentEnabled: false, lastSyncedAt: null,
};

/** Create the feed tables if missing (defensive — migration 045 is the source of truth). */
export async function ensureFeedsSchema(pool: AppContext['pool']): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'feeds indexing routes',
    statements: [
      `CREATE TABLE IF NOT EXISTS feed_messages (
        user_sub VARCHAR(255) NOT NULL,
        source VARCHAR(32) NOT NULL DEFAULT 'slack',
        channel_id VARCHAR(64) NOT NULL,
        channel_name TEXT,
        channel_type VARCHAR(16),
        author_id VARCHAR(64),
        author_name TEXT,
        text TEXT,
        ts VARCHAR(64) NOT NULL,
        posted_at TIMESTAMPTZ NOT NULL,
        sentiment NUMERIC(4,3),
        sentiment_label VARCHAR(16),
        sentiment_at TIMESTAMPTZ,
        indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_sub, source, channel_id, ts)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_feed_msgs_user_posted ON feed_messages (user_sub, posted_at DESC)',
      `CREATE TABLE IF NOT EXISTS feed_settings (
        user_sub VARCHAR(255) PRIMARY KEY,
        poll_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        poll_interval_minutes INT NOT NULL DEFAULT 30,
        max_channels INT NOT NULL DEFAULT 25,
        per_channel INT NOT NULL DEFAULT 15,
        sentiment_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        last_synced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    ],
    requirements: [
      {
        table: 'feed_messages',
        columns: [
          'user_sub',
          'source',
          'channel_id',
          'channel_name',
          'channel_type',
          'author_id',
          'author_name',
          'text',
          'ts',
          'posted_at',
          'sentiment',
          'sentiment_label',
          'sentiment_at',
          'indexed_at',
        ],
      },
      {
        table: 'feed_settings',
        columns: [
          'user_sub',
          'poll_enabled',
          'poll_interval_minutes',
          'max_channels',
          'per_channel',
          'sentiment_enabled',
          'last_synced_at',
          'created_at',
          'updated_at',
        ],
      },
    ],
  });
}

/** Read a user's settings, falling back to the defaults when no row exists yet. */
export async function getFeedSettings(pool: AppContext['pool'], userSub: string): Promise<FeedSettings> {
  const row = (await pool.query(
    `SELECT poll_enabled, poll_interval_minutes, max_channels, per_channel, sentiment_enabled, last_synced_at
       FROM feed_settings WHERE user_sub = $1`, [userSub],
  )).rows[0];
  if (!row) return { ...DEFAULTS };
  return {
    pollEnabled: row.poll_enabled,
    pollIntervalMinutes: row.poll_interval_minutes,
    maxChannels: row.max_channels,
    perChannel: row.per_channel,
    sentimentEnabled: row.sentiment_enabled,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
  };
}

/** Upsert a user's settings (only the provided fields), clamped to sane bounds. */
export async function updateFeedSettings(
  pool: AppContext['pool'], userSub: string,
  patch: Partial<Pick<FeedSettings, 'pollEnabled' | 'pollIntervalMinutes' | 'maxChannels' | 'perChannel' | 'sentimentEnabled'>>,
): Promise<FeedSettings> {
  const cur = await getFeedSettings(pool, userSub);
  const next: FeedSettings = {
    ...cur,
    pollEnabled: patch.pollEnabled ?? cur.pollEnabled,
    pollIntervalMinutes: clamp(patch.pollIntervalMinutes ?? cur.pollIntervalMinutes, 5, 1440),
    maxChannels: clamp(patch.maxChannels ?? cur.maxChannels, 1, 100),
    perChannel: clamp(patch.perChannel ?? cur.perChannel, 1, 50),
    sentimentEnabled: patch.sentimentEnabled ?? cur.sentimentEnabled,
  };
  await pool.query(
    `INSERT INTO feed_settings (user_sub, poll_enabled, poll_interval_minutes, max_channels, per_channel, sentiment_enabled, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (user_sub) DO UPDATE SET
       poll_enabled = EXCLUDED.poll_enabled, poll_interval_minutes = EXCLUDED.poll_interval_minutes,
       max_channels = EXCLUDED.max_channels, per_channel = EXCLUDED.per_channel,
       sentiment_enabled = EXCLUDED.sentiment_enabled, updated_at = NOW()`,
    [userSub, next.pollEnabled, next.pollIntervalMinutes, next.maxChannels, next.perChannel, next.sentimentEnabled],
  );
  return next;
}

function clamp(n: number, lo: number, hi: number): number {
  n = Math.floor(Number(n));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * @description Pull a user's Slack messages and upsert them into the index. Idempotent
 * (dedup on the message ts). Advances last_synced_at. Returns the count of NEW rows stored.
 */
export async function indexUserFeed(ctx: AppContext, userSub: string): Promise<number> {
  const token = await getValidAccessToken(ctx.pool, userSub, 'slack');
  if (!token) return 0;
  const settings = await getFeedSettings(ctx.pool, userSub);
  const { messages } = await pullSlackFeed(token, { maxChannels: settings.maxChannels, perChannel: settings.perChannel });

  let stored = 0;
  for (const m of messages) {
    const res = await ctx.pool.query(
      `INSERT INTO feed_messages (user_sub, source, channel_id, channel_name, channel_type, author_id, author_name, text, ts, posted_at)
       VALUES ($1,'slack',$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_sub, source, channel_id, ts)
       DO UPDATE SET channel_name = EXCLUDED.channel_name, author_name = EXCLUDED.author_name`,
      [userSub, m.channelId, m.channel.slice(0, 300), m.type, m.userId, (m.user || '').slice(0, 200), m.text.slice(0, 4000), m.ts, m.time],
    );
    // rowCount is 1 for both insert and the (cheap) name-refresh update; count inserts only by
    // checking if it was already present is overkill — treat any write as "seen", report total.
    if (res.rowCount) stored++;
  }
  await ctx.pool.query(
    `INSERT INTO feed_settings (user_sub, last_synced_at, updated_at) VALUES ($1, NOW(), NOW())
     ON CONFLICT (user_sub) DO UPDATE SET last_synced_at = NOW(), updated_at = NOW()`,
    [userSub],
  );
  if (messages.length) logger.info({ userSub, scanned: messages.length }, 'feed indexed');
  return stored;
}

/** Run indexing for every user with a connected Slack account AND polling enabled (default ON). */
async function indexAllFeeds(ctx: AppContext): Promise<void> {
  const users = (await ctx.pool.query(
    `SELECT DISTINCT c.user_sub
       FROM oshal_connections c
       LEFT JOIN feed_settings s ON s.user_sub = c.user_sub
      WHERE c.provider = 'slack' AND c.status = 'connected'
        AND (s.poll_enabled IS NULL OR s.poll_enabled = TRUE)`,
  )).rows as Array<{ user_sub: string }>;
  for (const u of users) {
    try { await indexUserFeed(ctx, u.user_sub); }
    catch (err) { logger.warn({ err, userSub: u.user_sub }, 'feed index failed for user'); }
  }
}

/**
 * @description Kick a sync for one user IF their index is stale (older than their interval, or
 * never synced). Fire-and-forget — safe to call on every surface load. This is the "warm the
 * feed right after the user logs in / opens it" path.
 */
export function maybeSyncOnView(ctx: AppContext, userSub: string): void {
  (async () => {
    try {
      const s = await getFeedSettings(ctx.pool, userSub);
      if (!s.pollEnabled) return;
      const staleMs = s.pollIntervalMinutes * 60_000;
      const last = s.lastSyncedAt ? new Date(s.lastSyncedAt).getTime() : 0;
      if (Date.now() - last < staleMs) return; // fresh enough
      await indexUserFeed(ctx, userSub);
    } catch (err) { logger.warn({ err, userSub }, 'on-view feed sync failed'); }
  })();
}

/**
 * @description Start the feeds-indexing cron: a first run shortly after boot, then every
 * SLACK_INDEX_INTERVAL_MIN minutes (default 30). Configurable + idempotent.
 */
let cronStarted = false;

export function startFeedsIndexingCron(ctx: AppContext): void {
  // Double-start guard — the JSDoc always claimed idempotent; now it is (2026-07-05 leak audit).
  if (cronStarted) { logger.warn('feeds-indexing cron already started — ignoring duplicate start'); return; }
  cronStarted = true;
  const mins = Math.max(parseInt(process.env.SLACK_INDEX_INTERVAL_MIN || '30', 10), 5);
  ensureFeedsSchema(ctx.pool).catch((err) => logger.error({ err }, 'ensureFeedsSchema failed'));
  const bootTimer = setTimeout(() => { runWithSystemIdentity(() => indexAllFeeds(ctx)).catch((err) => logger.error({ err }, 'feed index (boot) failed'));
  bootTimer.unref(); }, 120_000);
  const cronTimer = setInterval(() => { runWithSystemIdentity(() => indexAllFeeds(ctx)).catch((err) => logger.error({ err }, 'feed index (interval) failed'));
  cronTimer.unref(); }, mins * 60_000);
  logger.info({ intervalMin: mins }, 'Feeds-indexing cron started');
}
