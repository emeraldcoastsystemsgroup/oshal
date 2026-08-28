/**
 * Trading accounts store (ADR-134) — connector-discovered broker accounts, the pool books bind to.
 *
 * Populated ONLY by the deterministic discovery operation: for each of the user's Schwab connector
 * connections (multi-login via oshal_connections.account_key), acquire a token through
 * getValidAccessToken and enumerate GET /accounts/accountNumbers (+ GET /accounts for types).
 * The credential never crosses the model/bot boundary — this is a fixed server operation.
 *
 * Account numbers are GLBA-class NPI and bot nodes connect as a Postgres SUPERUSER (RLS-exempt),
 * so the full number is DEK-ENCRYPTED at rest (connector-token-crypto envelope, per-user keys) and
 * identity for the unique index rides an HMAC digest; routes only ever see last4.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — accounts table (encrypted number + HMAC digest identity + last4, owner-pair unique for the books composite FK, RLS at the DDL chokepoint), discoverBrokerAccounts over every schwab connection with age-out-not-delete semantics, masked list reads.
 */

import crypto from 'crypto';
import type { AppContext } from './composition-root';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'trading-accounts-store' });

/** Schwab Trader API base — same source of truth as connector-account-lookup. */
function schwabTraderBase(): string {
  return String(process.env.SCHWAB_TRADER_BASE_URL || 'https://api.schwabapi.com/trader/v1').replace(/\/$/, '');
}

/**
 * @description Deterministic account identity for the unique index: HMAC-SHA256 over the
 * (sub, number) pair keyed by SESSION_SECRET — AES-GCM ciphertext is non-deterministic, and a plain
 * hash of an 8–9 digit account number is brute-forceable. Fail-loud on a missing secret; never a
 * silent downgrade.
 * @param sub - Owner sub.
 * @param accountNumber - The plaintext account number.
 * @returns Hex digest.
 */
export function accountDigest(sub: string, accountNumber: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('accountDigest: SESSION_SECRET is required to derive account identity');
  return crypto.createHmac('sha256', secret).update(`${sub}:${accountNumber}`).digest('hex');
}

let accountsReady: Promise<void> | null = null;

/**
 * @description Ensure the accounts table exists (RLS'd, owner-pair unique for the composite FK).
 * @param pool - Postgres pool.
 * @returns Resolves when in place.
 */
export async function ensureAccountsSchema(pool: AppContext['pool']): Promise<void> {
  if (!accountsReady) {
    accountsReady = bootstrapAccounts(pool).catch((err) => { accountsReady = null; throw err; });
  }
  return accountsReady;
}

async function bootstrapAccounts(pool: AppContext['pool']): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool, moduleName: 'trading accounts',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_trading_accounts (
        account_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub           TEXT NOT NULL,
        broker             TEXT NOT NULL CHECK (broker IN ('schwab','alpaca')),
        connection_key     TEXT NOT NULL DEFAULT 'default',
        account_number_enc TEXT NOT NULL,
        account_digest     TEXT NOT NULL,
        account_last4      TEXT NOT NULL,
        account_hash       TEXT,
        account_type       TEXT,
        nickname           TEXT,
        discovered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_accounts_identity ON oshal_trading_accounts (user_sub, broker, account_digest)',
      // Non-partial pair uniqueness so oshal_trading_books can carry a COMPOSITE FK — the DB-level
      // wall against binding a book to another user's account (FK validation bypasses RLS).
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_accounts_owner_pair ON oshal_trading_accounts (user_sub, account_id)',
      ...buildOwnerRlsPolicyStatements('oshal_trading_accounts', 'user_sub'),
    ],
    requirements: [{
      table: 'oshal_trading_accounts',
      columns: ['account_id', 'user_sub', 'broker', 'connection_key', 'account_number_enc', 'account_digest', 'account_last4', 'account_hash', 'account_type', 'nickname', 'discovered_at', 'last_seen_at'],
    }],
  });
}

/** A masked discovered-account row — the ONLY shape routes may return. */
export interface DiscoveredAccount {
  accountId: string; broker: string; connectionKey: string; accountMasked: string;
  accountType: string | null; nickname: string | null; discoveredAt: string; lastSeenAt: string;
}

/**
 * @description List the user's discovered accounts, masked (…last4). Never returns the number.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @returns Masked accounts, newest-seen first.
 */
export async function listAccounts(pool: AppContext['pool'], sub: string): Promise<DiscoveredAccount[]> {
  await ensureAccountsSchema(pool);
  const rows = (await pool.query(
    `SELECT account_id, broker, connection_key, account_last4, account_type, nickname,
            discovered_at, last_seen_at
       FROM oshal_trading_accounts WHERE user_sub=$1 ORDER BY last_seen_at DESC`, [sub])).rows;
  return rows.map((r) => ({
    accountId: String(r.account_id), broker: String(r.broker), connectionKey: String(r.connection_key),
    accountMasked: `…${r.account_last4}`, accountType: r.account_type ? String(r.account_type) : null,
    nickname: r.nickname ? String(r.nickname) : null,
    discoveredAt: new Date(r.discovered_at).toISOString(), lastSeenAt: new Date(r.last_seen_at).toISOString(),
  }));
}

/** One enumerated account from the Schwab Trader API. */
interface SchwabEnumeratedAccount { accountNumber: string; hashValue: string; type?: string; nickname?: string }

/** Enumerate accountNumbers (+types where available) for one connection's token. */
async function enumerateSchwabAccounts(token: string): Promise<SchwabEnumeratedAccount[]> {
  const base = schwabTraderBase();
  const res = await fetch(`${base}/accounts/accountNumbers`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`schwab accountNumbers ${res.status}`);
  const pairs = (await res.json()) as Array<{ accountNumber: string; hashValue: string }>;
  const byNumber = new Map<string, SchwabEnumeratedAccount>(
    pairs.map((p) => [p.accountNumber, { accountNumber: p.accountNumber, hashValue: p.hashValue }]));
  // Types/nicknames are best-effort decoration — a failure here never fails discovery.
  try {
    const acc = await fetch(`${base}/accounts`, { headers: { Authorization: `Bearer ${token}` } });
    if (acc.ok) {
      const detail = (await acc.json()) as Array<{ securitiesAccount?: { accountNumber?: string; type?: string } }>;
      for (const d of detail) {
        const num = d.securitiesAccount?.accountNumber;
        const hit = num ? byNumber.get(num) : undefined;
        if (hit && d.securitiesAccount?.type) hit.type = d.securitiesAccount.type;
      }
    }
  } catch (err) {
    logger.warn({ err }, 'schwab GET /accounts decoration failed — numbers/hashes still discovered');
  }
  return [...byNumber.values()];
}

/**
 * @description Discover every broker account visible to the user's Schwab connections and upsert
 * them (deterministic server operation — ADR-134 D5). Accounts absent from an enumeration are
 * NEVER deleted; they age out via last_seen_at and render stale in the UI. Per-connection failures
 * degrade to a logged skip so one dead login cannot hide the others' accounts.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @returns Counts per connection for the caller's surface.
 */
export async function discoverBrokerAccounts(pool: AppContext['pool'], sub: string): Promise<{ connections: number; accounts: number; errors: string[] }> {
  await ensureAccountsSchema(pool);
  const { getValidAccessToken } = await import('./routes/connector-account-operations.js');
  const { encryptToken } = await import('./routes/connector-token-crypto.js');
  const conns = (await pool.query(
    `SELECT connection_id, account_key FROM oshal_connections WHERE user_sub=$1 AND provider='schwab'`, [sub])).rows;
  let accounts = 0; const errors: string[] = [];
  for (const c of conns) {
    const accountKey = String(c.account_key || 'default');
    try {
      // Selection rides connectionId — the ConnectionSelector's exact-row arm — so each LOGIN's
      // token enumerates its own accounts (account_key is recorded as the book-facing key).
      const token = await getValidAccessToken(pool, sub, 'schwab', { connectionId: String(c.connection_id) });
      if (!token) throw new Error('no valid access token for this connection');
      const found = await enumerateSchwabAccounts(token);
      for (const a of found) {
        const enc = await encryptToken(pool, sub, a.accountNumber);
        const row = (await pool.query(
          `INSERT INTO oshal_trading_accounts
             (user_sub, broker, connection_key, account_number_enc, account_digest, account_last4,
              account_hash, account_type, nickname, last_seen_at)
           VALUES ($1,'schwab',$2,$3,$4,$5,$6,$7,$8, now())
           ON CONFLICT (user_sub, broker, account_digest) DO UPDATE SET
             connection_key = EXCLUDED.connection_key,
             account_hash   = EXCLUDED.account_hash,
             account_type   = COALESCE(EXCLUDED.account_type, oshal_trading_accounts.account_type),
             nickname       = COALESCE(EXCLUDED.nickname, oshal_trading_accounts.nickname),
             last_seen_at   = now()
           RETURNING account_id`,
          [sub, accountKey, enc, accountDigest(sub, a.accountNumber), a.accountNumber.slice(-4),
            a.hashValue, a.type ?? null, a.nickname ?? null]).catch((e) => { throw e; })).rows[0];
        accounts += 1;
        // VISIBILITY IS AUTOMATIC (operator doctrine 2026-08-28: "I connected half a million
        // dollars and I don't know what's connected"): every discovered account gets a DISABLED
        // book so the switcher/summary can show its real balances and positions immediately.
        // Disabled = view-only — the engine refuses BUYs on a disabled book, dispatch takes no new
        // risk, and ENABLING (the act that trades) stays an explicit confirm-gated operator step.
        // The legacy live account is skipped: the 'live' legacy book already covers it.
        try {
          const already = (await pool.query(
            `SELECT 1 FROM oshal_trading_books WHERE user_sub=$1 AND account_id=$2`, [sub, String(row.account_id)])).rows.length;
          const isLegacyLive = (process.env.SCHWAB_ACCOUNT_NUMBER || '').trim() === a.accountNumber;
          if (!already && !isLegacyLive) {
            const { createBook } = await import('./trading-books-store.js');
            const label = `${a.type || 'Account'} …${a.accountNumber.slice(-4)}`;
            await createBook(pool, sub, String(row.account_id), label);
            logger.info({ sub, accountLast4: a.accountNumber.slice(-4) }, 'auto-created DISABLED view-only book for discovered account');
          }
        } catch (bookErr) {
          logger.warn({ err: bookErr, sub }, 'auto-book creation failed — account discovered, book can be created from the surface');
        }
      }
    } catch (err) {
      logger.error({ err, sub, accountKey }, 'schwab account discovery failed for connection');
      errors.push(`${accountKey}: ${(err as Error).message}`);
    }
  }
  logger.info({ sub, connections: conns.length, accounts, errors: errors.length }, 'broker account discovery complete');
  return { connections: conns.length, accounts, errors };
}
