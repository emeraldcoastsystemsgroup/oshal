/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the chat-channel identity store: maps a messaging identity (Telegram chat/user id, later Discord) to exactly one OSHAL user_sub via a short-lived one-time link code the signed-in user generates in the cockpit and sends to the bot. This is the isolation boundary for the inbound channel surface — a shared demo bot must never leak one user's data into another's DM. Every read/write is user_sub-scoped; a migration should later fold these tables into the RLS policy set (query-level scoping is the v1 guard, matching the jarvis_tasks runtime-table pattern).
 */

import * as crypto from 'crypto';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';

const logger = createChildLogger({ module: 'channel-link-service' });

/** Minimal pool surface this service needs (avoids a hard pg dependency in the type). */
interface QueryablePool {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

/** A resolved channel link: which OSHAL user owns this messaging identity. */
export interface ChannelLink {
  provider: string;
  channelUserId: string;
  chatId: string;
  userSub: string;
  displayName: string | null;
  linkedAt: string;
}

/** How long a freshly-minted link code stays redeemable. */
const LINK_CODE_TTL_MS = 15 * 60 * 1000;

/**
 * @description Stores and resolves the binding between a messaging-channel identity and an OSHAL
 * user. The binding is established by a one-time code: the signed-in user mints a code in the
 * cockpit, sends it to the bot as `/start <code>` (Telegram) — the bot redeems it, permanently
 * linking that channel identity to the user's sub. All lookups are provider+identity scoped so a
 * shared bot routes each inbound message to the correct, isolated user.
 */
export class ChannelLinkService {
  private readonly pool: QueryablePool;
  private schemaReady = false;

  constructor(pool: QueryablePool) {
    this.pool = pool;
  }

  /** @description Idempotently creates the link + link-code tables (once per process). */
  async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    await runRuntimeSchemaBootstrap({
      pool: this.pool as never,
      moduleName: 'chat-channels',
      statements: [
        `CREATE TABLE IF NOT EXISTS channel_links (
          provider TEXT NOT NULL,
          channel_user_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          user_sub TEXT NOT NULL,
          display_name TEXT,
          linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (provider, channel_user_id)
        )`,
        'CREATE INDEX IF NOT EXISTS idx_channel_links_user ON channel_links (user_sub)',
        `CREATE TABLE IF NOT EXISTS channel_link_codes (
          code TEXT PRIMARY KEY,
          user_sub TEXT NOT NULL,
          provider TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          consumed_at TIMESTAMPTZ
        )`,
        'CREATE INDEX IF NOT EXISTS idx_channel_link_codes_user ON channel_link_codes (user_sub)',
      ],
      requirements: [
        { table: 'channel_links', columns: ['provider', 'channel_user_id', 'chat_id', 'user_sub', 'display_name', 'linked_at'] },
        { table: 'channel_link_codes', columns: ['code', 'user_sub', 'provider', 'expires_at', 'consumed_at'] },
      ],
    });
    this.schemaReady = true;
  }

  /**
   * @description Mints a fresh one-time link code for a signed-in user to send to the bot.
   * @param userSub - The authenticated caller's OIDC sub.
   * @param provider - The channel provider (e.g. 'telegram').
   * @returns The code string the user sends to the bot as `/start <code>`.
   */
  async mintLinkCode(userSub: string, provider: string): Promise<string> {
    await this.ensureSchema();
    // 8 hex chars from 4 random bytes — short enough to type, ample entropy for a 15-min TTL.
    const code = crypto.randomBytes(4).toString('hex');
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS).toISOString();
    await this.pool.query(
      `INSERT INTO channel_link_codes (code, user_sub, provider, expires_at) VALUES ($1, $2, $3, $4)`,
      [code, userSub, provider, expiresAt],
    );
    logger.info({ userSub, provider }, 'channel link code minted');
    return code;
  }

  /**
   * @description Redeems a link code sent by a user through the channel, binding that channel
   * identity to the code's owner. Idempotent per identity: re-linking updates chat_id/name.
   * @returns The resolved user_sub on success, or null when the code is unknown/expired/consumed.
   */
  async redeemLinkCode(
    provider: string, code: string, channelUserId: string, chatId: string, displayName: string | null,
  ): Promise<string | null> {
    await this.ensureSchema();
    const claimed = await this.pool.query(
      `UPDATE channel_link_codes SET consumed_at = NOW()
        WHERE code = $1 AND provider = $2 AND consumed_at IS NULL AND expires_at > NOW()
        RETURNING user_sub`,
      [code.trim(), provider],
    );
    const row = claimed.rows[0] as { user_sub?: string } | undefined;
    if (!row?.user_sub) {
      logger.warn({ provider, channelUserId }, 'channel link code invalid/expired/consumed');
      return null;
    }
    const userSub = String(row.user_sub);
    await this.pool.query(
      `INSERT INTO channel_links (provider, channel_user_id, chat_id, user_sub, display_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider, channel_user_id)
       DO UPDATE SET chat_id = EXCLUDED.chat_id, user_sub = EXCLUDED.user_sub,
                     display_name = EXCLUDED.display_name, linked_at = NOW()`,
      [provider, channelUserId, chatId, userSub, displayName],
    );
    logger.info({ provider, channelUserId, userSub }, 'channel identity linked');
    return userSub;
  }

  /**
   * @description Resolves which OSHAL user owns an inbound channel identity.
   * @returns The link, or null when the identity has not been linked yet.
   */
  async resolveLink(provider: string, channelUserId: string): Promise<ChannelLink | null> {
    await this.ensureSchema();
    const res = await this.pool.query(
      `SELECT provider, channel_user_id, chat_id, user_sub, display_name, linked_at
         FROM channel_links WHERE provider = $1 AND channel_user_id = $2`,
      [provider, channelUserId],
    );
    return res.rows[0] ? this.mapRow(res.rows[0]) : null;
  }

  /** @description Lists a signed-in user's linked channels (for the cockpit "Channels" card). */
  async listLinks(userSub: string): Promise<ChannelLink[]> {
    await this.ensureSchema();
    const res = await this.pool.query(
      `SELECT provider, channel_user_id, chat_id, user_sub, display_name, linked_at
         FROM channel_links WHERE user_sub = $1 ORDER BY linked_at DESC`,
      [userSub],
    );
    return res.rows.map((r) => this.mapRow(r));
  }

  /**
   * @description Removes a link — but only if it belongs to the requesting user (owner-scoped so one
   * user can never unlink another's channel).
   * @returns true when a row was removed.
   */
  async unlink(userSub: string, provider: string, channelUserId: string): Promise<boolean> {
    await this.ensureSchema();
    const res = await this.pool.query(
      `DELETE FROM channel_links WHERE user_sub = $1 AND provider = $2 AND channel_user_id = $3`,
      [userSub, provider, channelUserId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  private mapRow(row: unknown): ChannelLink {
    const r = row as Record<string, unknown>;
    return {
      provider: String(r.provider),
      channelUserId: String(r.channel_user_id),
      chatId: String(r.chat_id),
      userSub: String(r.user_sub),
      displayName: r.display_name == null ? null : String(r.display_name),
      linkedAt: String(r.linked_at),
    };
  }
}
