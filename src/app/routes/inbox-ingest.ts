/**
 * Inbox Ingest — durable, timestamped capture of the user's mail (the data layer under the
 * "inbox is the feed" model). Decouples INGEST from ASSESS:
 *   - a configurable cron pulls ALL new Gmail messages since a per-user cursor (PAGINATED — not
 *     a 25-cap live grab), stores each timestamped + categorized (social / promotions / primary),
 *     deduped by message id. So nothing is missed on a busy day — every message is captured once.
 *   - assessment (digest, Social Signals) reads from this store ANYTIME, never re-fetching live.
 *
 * Per ADR-036 this is the cheap data-access half (raw reads); the bot does the reasoning over the
 * store. Mirrors the startTopicsPrewarm cron + the oshal_content_articles persisted-fetch pattern.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — oshal_inbox_messages store (per-user, timestamped, category-tagged, deduped) + per-user cursor + ingestInbox (paginated Gmail delta pull) + startInboxIngestCron (boot + configurable interval). Foundation for reliable digest + Social Signals (assess-over-store).
 *
 * @module inbox-ingest
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Cron start is now actually idempotent (double-start guard) and the timers are unref-ed and handle-captured (2026-07-05 leak audit)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Ran the inbox-ingest sweep under runWithSystemIdentity — a cross-owner background sweep that writes per-user inbox/ticket rows; SYSTEM keeps it visible once OSHAL_DB_GUC_STRICT denies the identity-less case.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Wrapped the BOOT setTimeout run in runWithSystemIdentity too — the 15:26 change wrapped only the interval tick, so the +90s boot sweep still ran identity-less (surfaced by the hardened guc warn-audit).
 */
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import type { AppContext } from '@/app/composition/app-context';
import { getValidAccessToken } from './connectors-routes';

const logger = createChildLogger({ module: 'inbox-ingest' });
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const PAGE_CAP = 8;            // up to 8 pages × 100 = 800 msgs/run (busy-day headroom)
const FIRST_RUN_LOOKBACK_DAYS = 2;

/** Map Gmail labelIds → our coarse category (the Social tab is CATEGORY_SOCIAL). */
function categoryOf(labelIds: string[]): string {
  if (labelIds.includes('CATEGORY_SOCIAL')) return 'social';
  if (labelIds.includes('CATEGORY_PROMOTIONS')) return 'promotions';
  if (labelIds.includes('CATEGORY_UPDATES')) return 'updates';
  if (labelIds.includes('CATEGORY_FORUMS')) return 'forums';
  return 'primary';
}

/** Create the inbox store + per-user cursor. Call at boot. */
export async function ensureInboxSchema(pool: AppContext['pool']): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'inbox ingest routes',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_inbox_messages (
        user_sub TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        thread_id TEXT,
        from_addr TEXT,
        subject TEXT,
        snippet TEXT,
        category TEXT NOT NULL DEFAULT 'primary',
        received_at TIMESTAMPTZ NOT NULL,
        ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source TEXT NOT NULL DEFAULT 'gmail',
        assessed BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (user_sub, msg_id)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_inbox_user_cat_recv ON oshal_inbox_messages (user_sub, category, received_at DESC)',
      `CREATE TABLE IF NOT EXISTS oshal_inbox_cursor (
        user_sub TEXT PRIMARY KEY,
        last_received_at TIMESTAMPTZ,
        last_run TIMESTAMPTZ
      )`,
    ],
    requirements: [
      {
        table: 'oshal_inbox_messages',
        columns: [
          'user_sub',
          'msg_id',
          'thread_id',
          'from_addr',
          'subject',
          'snippet',
          'category',
          'received_at',
          'ingested_at',
          'source',
          'assessed',
        ],
      },
      { table: 'oshal_inbox_cursor', columns: ['user_sub', 'last_received_at', 'last_run'] },
    ],
  });
}

/** Fetch one message's metadata (from/subject/snippet/labels/date). */
async function fetchMeta(token: string, id: string): Promise<{ id: string; threadId: string; from: string; subject: string; snippet: string; category: string; receivedAt: Date } | null> {
  const r = await fetch(`${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const j = (await r.json()) as { id: string; threadId: string; labelIds?: string[]; internalDate?: string; snippet?: string; payload?: { headers?: Array<{ name: string; value: string }> } };
  const hdr = (n: string) => j.payload?.headers?.find((h) => h.name === n)?.value || '';
  return {
    id: j.id, threadId: j.threadId, from: hdr('From'), subject: hdr('Subject'),
    snippet: j.snippet || '', category: categoryOf(j.labelIds || []),
    receivedAt: new Date(Number(j.internalDate || Date.now())),
  };
}

/**
 * @description Pull all new Gmail messages for one user since their cursor (paginated) and store
 * them. Idempotent (dedup by msg_id). Advances the cursor to the newest message seen.
 * @returns number of new messages stored.
 */
export async function ingestInbox(ctx: AppContext, userSub: string): Promise<number> {
  const token = await getValidAccessToken(ctx.pool, userSub, 'google');
  if (!token) return 0;
  const cur = (await ctx.pool.query('SELECT last_received_at FROM oshal_inbox_cursor WHERE user_sub = $1', [userSub])).rows[0] as { last_received_at?: string } | undefined;
  const sinceMs = cur?.last_received_at ? new Date(cur.last_received_at).getTime() : Date.now() - FIRST_RUN_LOOKBACK_DAYS * 86400_000;
  const q = `after:${Math.floor(sinceMs / 1000)}`;

  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < PAGE_CAP; page++) {
    const url = `${GMAIL}/messages?q=${encodeURIComponent(q)}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) { logger.warn({ userSub, status: r.status }, 'inbox list failed'); break; }
    const j = (await r.json()) as { messages?: Array<{ id: string }>; nextPageToken?: string };
    for (const m of j.messages || []) ids.push(m.id);
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  if (!ids.length) { await ctx.pool.query('INSERT INTO oshal_inbox_cursor (user_sub, last_run) VALUES ($1, NOW()) ON CONFLICT (user_sub) DO UPDATE SET last_run = NOW()', [userSub]); return 0; }

  let stored = 0; let newest = sinceMs;
  for (const id of ids) {
    const meta = await fetchMeta(token, id);
    if (!meta) continue;
    const res = await ctx.pool.query(
      `INSERT INTO oshal_inbox_messages (user_sub, msg_id, thread_id, from_addr, subject, snippet, category, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_sub, msg_id) DO NOTHING`,
      [userSub, meta.id, meta.threadId, meta.from.slice(0, 320), meta.subject.slice(0, 500), meta.snippet.slice(0, 1000), meta.category, meta.receivedAt],
    );
    if (res.rowCount) stored++;
    newest = Math.max(newest, meta.receivedAt.getTime());
  }
  await ctx.pool.query(
    `INSERT INTO oshal_inbox_cursor (user_sub, last_received_at, last_run) VALUES ($1, to_timestamp($2), NOW())
     ON CONFLICT (user_sub) DO UPDATE SET last_received_at = to_timestamp($2), last_run = NOW()`,
    [userSub, Math.floor(newest / 1000)],
  );
  if (stored) logger.info({ userSub, stored, scanned: ids.length }, 'inbox ingest stored new messages');
  return stored;
}

/** Run ingest for every user with a connected Google account. */
async function ingestAll(ctx: AppContext): Promise<void> {
  const users = (await ctx.pool.query("SELECT DISTINCT user_sub FROM oshal_connections WHERE provider='google' AND status='connected'")).rows as Array<{ user_sub: string }>;
  for (const u of users) {
    try { await ingestInbox(ctx, u.user_sub); } catch (err) { logger.warn({ err, userSub: u.user_sub }, 'inbox ingest failed for user'); }
  }
}

/**
 * @description Start the inbox-ingest cron: first run shortly after boot, then every
 * INBOX_INGEST_INTERVAL_MIN minutes (default 15). Configurable + idempotent.
 */
let cronStarted = false;

export function startInboxIngestCron(ctx: AppContext): void {
  // Double-start guard — the JSDoc always claimed idempotent; now it is (2026-07-05 leak audit).
  if (cronStarted) { logger.warn('inbox-ingest cron already started — ignoring duplicate start'); return; }
  cronStarted = true;
  const mins = Math.max(parseInt(process.env.INBOX_INGEST_INTERVAL_MIN || '15', 10), 2);
  ensureInboxSchema(ctx.pool).catch((err) => logger.error({ err }, 'ensureInboxSchema failed'));
  const bootTimer = setTimeout(() => { runWithSystemIdentity(() => ingestAll(ctx)).catch((err) => logger.error({ err }, 'inbox ingest (boot) failed'));
  bootTimer.unref(); }, 90_000);
  const cronTimer = setInterval(() => { runWithSystemIdentity(() => ingestAll(ctx)).catch((err) => logger.error({ err }, 'inbox ingest (interval) failed'));
  cronTimer.unref(); }, mins * 60_000);
  logger.info({ intervalMin: mins }, 'Inbox-ingest cron started');
}
