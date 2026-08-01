/**
 * Connector liveness — INSTALLER-GAPS G14 leg 2. The Connections screen's "connected" badge
 * used to mean "a DB row exists"; on the G-Squared box a Testing-mode Google client had
 * silently invalidated the refresh token for gmail.send, "1 connected" stayed green, and the
 * first two real invitations an admin ever sent returned emailSent:false. This module asks
 * the PROVIDER whether it will still honor the grant:
 *
 *   - rows WITH a refresh token → a forced, real token refresh (getValidAccessToken
 *     forceRefresh). A `refresh 4xx` from the provider = the grant is dead → needs_reconnect.
 *   - rows WITHOUT a refresh token (pasted PATs, non-rotating grants) → validate the stored
 *     token against the provider's account endpoint; an identity = ok; anything else is an
 *     honest `unknown` (a network blip must never paint a working connection red).
 *
 * Results are cached ≤15 minutes per (caller, provider) so the Connections screen can call
 * this on every load without hammering token endpoints; `?fresh=1` bypasses the cache.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — GET /api/connect/liveness (auth-gated, caller-scoped): per-provider live grant check with a 15-minute cache, deps-injectable probe for unit guards (no live calls in tests), and statuses ok | needs_reconnect | unknown the utilities surface renders as distinct badges.
 *
 * @module connector-liveness
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { getTrustedServiceUserSub } from '@/shared/middleware/authz';
import type { AppContext } from '@/app/composition/app-context';
import { accessibleConnections, resolveConnectionRow, type ConnectionRow } from './connector-tenancy';
import { getValidAccessToken } from './connectors-routes';
import { fetchAccount } from './connector-account-lookup';

const logger = createChildLogger({ module: 'connector-liveness' });

/** How a probed grant stands with its provider. */
export type LivenessStatus = 'ok' | 'needs_reconnect' | 'unknown';

/** One provider's probe outcome. */
export interface ProviderLiveness {
  provider: string;
  status: LivenessStatus;
  detail?: string;
  /** Epoch ms of the probe that produced this result (cache age is visible to the UI). */
  checkedAt: number;
  cached: boolean;
}

/** Injectable internals so unit guards stub every transport (no live calls in tests). */
export interface LivenessDeps {
  listConnections: (pool: unknown, userSub: string) => Promise<ConnectionRow[]>;
  resolveRow: (pool: unknown, userSub: string, provider: string) => Promise<ConnectionRow | null>;
  getToken: (pool: unknown, userSub: string, provider: string, opts?: { forceRefresh?: boolean; connectionId?: string }) => Promise<string | null>;
  fetchAccount: (provider: string, tok: { access_token?: string }) => Promise<{ email: string | null; id: string | null }>;
}

const defaultDeps: LivenessDeps = {
  listConnections: accessibleConnections,
  resolveRow: (pool, userSub, provider) => resolveConnectionRow(pool, userSub, provider),
  getToken: getValidAccessToken,
  fetchAccount,
};

/** Cache: (sub|provider) → last probe. 15 minutes, per the G14 done-when. */
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { status: LivenessStatus; detail?: string; checkedAt: number }>();

/**
 * @description Clear the probe cache — for unit guards only.
 */
export function resetConnectorLivenessCacheForTesting(): void {
  cache.clear();
}

/**
 * @description Probe whether the provider still honors the caller's grant for one provider.
 * Never throws; every failure mode maps to a status (+ short detail).
 * @param pool - db pool.
 * @param userSub - the caller (connection owner / member).
 * @param provider - provider id (e.g. 'google').
 * @param deps - injectable transports (defaults are the real ones).
 * @returns Probe outcome (uncached — callers layer the cache).
 */
export async function probeProviderLiveness(
  pool: unknown, userSub: string, provider: string, deps: LivenessDeps = defaultDeps,
): Promise<{ status: LivenessStatus; detail?: string }> {
  try {
    const row = await deps.resolveRow(pool, userSub, provider);
    if (!row) return { status: 'unknown', detail: 'no connection found' };
    if (row.refresh_token) {
      // The decisive probe: a real refresh. The provider answers whether the grant is alive.
      const token = await deps.getToken(pool, userSub, provider, { forceRefresh: true, connectionId: row.connection_id });
      return token
        ? { status: 'ok' }
        : { status: 'unknown', detail: 'provider returned no token from refresh' };
    }
    // No refresh token to exercise — validate the stored token against the account endpoint.
    const token = await deps.getToken(pool, userSub, provider, { connectionId: row.connection_id });
    if (!token) return { status: 'unknown', detail: 'no stored token to validate' };
    const acct = await deps.fetchAccount(provider, { access_token: token });
    return (acct.email || acct.id)
      ? { status: 'ok' }
      : { status: 'unknown', detail: 'could not verify the stored token with the provider' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/refresh 4\d\d/.test(message)) {
      // The provider REJECTED the refresh — the grant is dead even though a row exists
      // (Testing-mode Google reauthentication policy on sensitive scopes, G14).
      return {
        status: 'needs_reconnect',
        detail: 'the provider rejected the stored grant (token refresh failed) — reconnect on the Connections screen (~30 seconds)',
      };
    }
    logger.warn({ err, provider, userSub }, 'liveness probe errored — honest unknown');
    return { status: 'unknown', detail: message.slice(0, 200) };
  }
}

/** Caller's sub: OIDC session first, else the trusted-service identity. */
function callerSub(req: Request): string | null {
  const u = (req as { oidc?: { user?: { sub?: string; oid?: string } } }).oidc?.user;
  const sub = u?.sub || u?.oid;
  if (sub) return String(sub);
  return getTrustedServiceUserSub(req);
}

/**
 * @description Router for GET /api/connect/liveness — probes every provider the caller has
 * a connection for (cached ≤15 min; `?fresh=1` re-probes). Mounted at /api/connect behind
 * requiresAuth alongside the main connectors router.
 * @param ctx - app context (db pool).
 * @param deps - injectable transports (unit guards stub these — no live calls in tests).
 * @returns Express router.
 */
export function createConnectorLivenessRoutes(ctx: AppContext, deps: LivenessDeps = defaultDeps): Router {
  const router = Router();

  router.get('/liveness', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not authenticated' }); return; }
    const fresh = String(req.query.fresh || '') === '1';
    try {
      const rows = await deps.listConnections(ctx.pool, sub);
      const providers = Array.from(new Set(rows.map((r) => r.provider)));
      const results: ProviderLiveness[] = [];
      for (const provider of providers) {
        const key = `${sub}|${provider}`;
        const hit = cache.get(key);
        if (!fresh && hit && Date.now() - hit.checkedAt < CACHE_TTL_MS) {
          results.push({ provider, status: hit.status, detail: hit.detail, checkedAt: hit.checkedAt, cached: true });
          continue;
        }
        const probe = await probeProviderLiveness(ctx.pool, sub, provider, deps);
        const entry = { status: probe.status, detail: probe.detail, checkedAt: Date.now() };
        cache.set(key, entry);
        results.push({ provider, ...entry, cached: false });
      }
      logger.info({ sub, providers: results.length, needsReconnect: results.filter((r) => r.status === 'needs_reconnect').length }, 'liveness sweep complete');
      res.json({ providers: results });
    } catch (err) {
      logger.error({ err, sub }, 'liveness sweep failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
