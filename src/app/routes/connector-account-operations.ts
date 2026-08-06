/**
 * Connector account and stored-token operations.
 *
 * Owns schema validation, provider revocation, deterministic account selection,
 * access-token decryption, and provider-aware refresh persistence. Route handlers
 * call this module but retain their existing HTTP behavior in connectors-routes.ts.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted connector schema, revocation, and access-token refresh operations from connectors-routes.ts without changing SQL, selection, crypto, or provider refresh behavior.
 * -----------------------------------------------------------------------------
 *
 * @module connector-account-operations
 */

import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import type { AppContext } from '@/app/composition/app-context';
import {
  ensureDekSchema, encryptToken, decryptToken, envelopeEnabled,
} from './connector-token-crypto';
import {
  ensureTenancySchema, resolveConnectionRow, ownerSub, type ConnectionSelector,
} from './connector-tenancy';
import {
  PROVIDERS, SQUARE_VERSION, providerCreds, type ProviderDef,
} from './connector-provider-registry';

const logger = createChildLogger({ module: 'connectors-routes' });

/**
 * @description Create or validate the connector connection and envelope-key stores.
 * @param pool - application database pool
 * @returns nothing after schema validation and tenancy setup complete
 */
export async function ensureConnectionsSchema(pool: AppContext['pool']): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'connector routes',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_connections (
        connection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL,
        user_email TEXT,
        provider VARCHAR(40) NOT NULL,
        account_email TEXT,
        account_id TEXT,
        scopes TEXT,
        access_token TEXT,
        refresh_token TEXT,
        expiry TIMESTAMPTZ,
        status VARCHAR(20) NOT NULL DEFAULT 'connected',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        -- NO UNIQUE (user_sub, provider): a user may hold SEVERAL accounts of one provider
        -- (two Gmails — ADR-113 section 4). Uniqueness is per ACCOUNT and lives in the partial
        -- indexes ensureTenancySchema/migration 101 create (user_sub, provider, account_key).
      )`,
      'ALTER TABLE oshal_connections ADD COLUMN IF NOT EXISTS account_id TEXT',
    ],
    requirements: [
      {
        table: 'oshal_connections',
        columns: [
          'connection_id',
          'user_sub',
          'user_email',
          'provider',
          'account_email',
          'account_id',
          'scopes',
          'access_token',
          'refresh_token',
          'expiry',
          'status',
          'created_at',
          'updated_at',
        ],
      },
    ],
  });
  // Per-user DEK table (envelope encryption). Created regardless of the flag so flipping
  // OSHAL_ENVELOPE_CRYPTO on needs no migration step; unused while the flag is off.
  await ensureDekSchema(pool);
  // Startup posture (envelope crypto is ON by default since 2026-07-20): if SESSION_SECRET is
  // unset, the per-user DEK / master KEK cannot be derived and connector token encrypt/decrypt
  // will THROW at the crypto boundary (connector-token-crypto.kek() fail-loud). Surface it LOUD at
  // boot so the misconfig is caught before the first connect. Break-glass: OSHAL_ENVELOPE_CRYPTO=false.
  if (envelopeEnabled() && !process.env.SESSION_SECRET) {
    logger.error(
      'OSHAL_ENVELOPE_CRYPTO is ON but SESSION_SECRET is unset — connector token crypto will THROW on every encrypt/decrypt. Set SESSION_SECRET (production) or OSHAL_ENVELOPE_CRYPTO=false (legacy/dev).',
    );
  }
  // Tenancy (ADR-042): tenant tables + tenant_id/connected_by_sub on oshal_connections +
  // partial unique indexes. Backward-compatible (tenant_id defaults NULL = personal).
  await ensureTenancySchema(pool);
}

/**
 * @description Best-effort revoke of ONE connection's refresh token at the provider. Extracted so
 * both disconnect paths revoke every account they remove — the per-provider path used to revoke a
 * single arbitrary row while deleting all of them, leaving live grants behind for the others.
 * @param pool - db pool (needed to decrypt with the owner's DEK)
 * @param ownerSubValue - the sub whose DEK encrypted the token
 * @param def - the provider definition (its revokeUrl, when it has one)
 * @param encRefresh - the encrypted refresh token, or null
 * @returns nothing; failures are logged, never thrown (a disconnect must always complete locally)
 */
export async function revokeRefreshToken(
  pool: AppContext['pool'], ownerSubValue: string, def: ProviderDef | undefined, encRefresh: string | null,
): Promise<void> {
  if (!encRefresh || !def?.revokeUrl) return;
  try {
    const refresh = await decryptToken(pool, ownerSubValue, encRefresh);
    await fetch(`${def.revokeUrl}?token=${encodeURIComponent(refresh)}`, { method: 'POST' });
  } catch (err) {
    logger.warn({ err, revokeUrl: def.revokeUrl }, 'Provider token revoke failed (local disconnect proceeds)');
  }
}

/**
 * @description Return a valid access token for a user's connection, refreshing it
 * via the stored refresh token when expired. Exported so in-process bots/tools
 * (e.g. the email summarizer) can act on a connected account without re-consent.
 * `opts.forceRefresh` skips the still-valid early return when a refresh token exists —
 * the G14 liveness probe uses it to ask the PROVIDER whether the grant is still honored
 * (a revoked Testing-mode Google grant throws `refresh 400` here) instead of trusting
 * the DB expiry column.
 * @param pool - db pool
 * @param userSub - the connection owner's OIDC sub
 * @param provider - provider id (e.g. 'google')
 * @param opts - optional account selector and force-refresh liveness flag
 * @returns a usable access token, or null if not connected / unrefreshable
 */
export async function getValidAccessToken(
  pool: any, userSub: string, provider: string, opts?: ConnectionSelector & { forceRefresh?: boolean },
): Promise<string | null> {
  const def = PROVIDERS[provider];
  if (!def) return null;
  // Resolve personal ∪ shared (household-first, or a specific household via opts.tenantId).
  const row = await resolveConnectionRow(pool, userSub, provider, opts);
  if (!row) return null;
  const owner = ownerSub(row); // whose DEK encrypts this row's tokens (grantor for shared)
  // Still-valid access token (>60s headroom)? A liveness probe (forceRefresh) only trusts
  // this shortcut when there is no refresh token to exercise.
  const skipCachedToken = opts?.forceRefresh === true && !!row.refresh_token;
  if (!skipCachedToken && row.access_token && row.expiry && new Date(row.expiry).getTime() - Date.now() > 60_000) {
    return decryptToken(pool, owner, row.access_token);
  }
  if (!row.refresh_token) return row.access_token ? decryptToken(pool, owner, row.access_token) : null;
  const creds = providerCreds(provider);
  const refreshPlain = await decryptToken(pool, owner, row.refresh_token);
  if (def.flavor === 'square') {
    // Square refresh: JSON body + version header; returns a new access_token + expires_at
    // (the refresh_token itself does not rotate).
    const sr = await fetch(def.tokenUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Square-Version': SQUARE_VERSION },
      body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: 'refresh_token', refresh_token: refreshPlain }),
    });
    if (!sr.ok) throw new Error(`square refresh ${sr.status}`);
    const sj = (await sr.json()) as { access_token?: string; expires_at?: string };
    if (!sj.access_token) return null;
    const exp = sj.expires_at ? new Date(sj.expires_at) : null;
    await pool.query('UPDATE oshal_connections SET access_token = $2, expiry = $3, updated_at = NOW() WHERE connection_id = $1',
      [row.connection_id, await encryptToken(pool, owner, sj.access_token), exp]);
    return sj.access_token;
  }
  const body = new URLSearchParams({ refresh_token: refreshPlain, grant_type: 'refresh_token' });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (def.tokenAuth === 'basic') {
    headers.Authorization = 'Basic ' + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    body.set('client_id', creds.clientId);
  } else {
    body.set('client_id', creds.clientId);
    body.set('client_secret', creds.clientSecret);
  }
  const r = await fetch(def.tokenUrl, { method: 'POST', headers, body });
  if (!r.ok) throw new Error(`refresh ${r.status}`);
  const tok = (await r.json()) as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (!tok.access_token) return null;
  // Twitter/SmartThings rotate refresh tokens — persist the new one when present. Key the
  // UPDATE by connection_id so it works for both personal and shared (tenant-owned) rows.
  const newAccess = await encryptToken(pool, owner, tok.access_token);
  const newRefresh = tok.refresh_token ? await encryptToken(pool, owner, tok.refresh_token) : null;
  await pool.query(
    'UPDATE oshal_connections SET access_token = $2, refresh_token = COALESCE($4, refresh_token), expiry = $3, updated_at = NOW() WHERE connection_id = $1',
    [row.connection_id, newAccess, tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null, newRefresh],
  );
  return tok.access_token;
}


