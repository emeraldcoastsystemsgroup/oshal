/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the guc-strict token-middleware regression: the PAT auth lookup (and its last_used_at telemetry) must run under the SYSTEM identity sentinel — it necessarily precedes any request identity, and oshal_cli_tokens is FORCE-RLS, so an identity-less read under OSHAL_DB_GUC_STRICT=deny rejects every valid PAT ("rejected unknown/revoked CLI token" with a live row present — reproduced live 2026-07-20). Would go red if the runWithSystemIdentity wrapper is ever dropped.
 */

import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { createCliTokenAuthMiddleware, generateCliToken, hashCliToken } from '@/app/routes/cli-token-routes';
import { getRequestIdentity, isSystemIdentity } from '@/shared/services/database/request-identity';

/** Minimal fake pg Pool that records the ambient identity at query time. */
function fakePool(row: Record<string, unknown> | undefined, seenIdentities: boolean[]): Pool {
  return {
    query: async (_sql: string, _params?: unknown[]) => {
      seenIdentities.push(isSystemIdentity(getRequestIdentity()));
      return { rows: row ? [row] : [] };
    },
  } as unknown as Pool;
}

/** Runs the middleware against a Bearer PAT request and returns the mutated req. */
async function runMiddleware(pool: Pool, token: string) {
  const req: Record<string, unknown> = {
    headers: { authorization: `Bearer ${token}` },
    get: (h: string) => (h.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined),
    path: '/api/dnd/state',
  };
  await new Promise<void>((resolve) => {
    void createCliTokenAuthMiddleware(pool)(
      req as never,
      {} as never,
      () => resolve(),
    );
  });
  return req as { oidc?: { isAuthenticated: () => boolean; user: { sub: string } } };
}

describe('token middleware under guc-strict RLS (pre-identity reads need the SYSTEM sentinel)', () => {
  it('runs the PAT lookup under SYSTEM identity and authenticates the token owner', async () => {
    const token = generateCliToken();
    const seen: boolean[] = [];
    const pool = fakePool(
      { id: 'tok-1', user_sub: 'user-sub-123', email: 'player@example.com' },
      seen,
    );
    const req = await runMiddleware(pool, token);

    // The lookup (and the best-effort last_used_at update) must be SYSTEM-stamped: without it,
    // FORCE-RLS oshal_cli_tokens returns zero rows under deny and every PAT dies platform-wide.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);

    expect(req.oidc?.isAuthenticated()).toBe(true);
    expect(req.oidc?.user.sub).toBe('user-sub-123');
  });

  it('leaves the request unauthenticated when the token has no live row (revoked/expired/unknown)', async () => {
    const seen: boolean[] = [];
    const req = await runMiddleware(fakePool(undefined, seen), generateCliToken());
    expect(seen.every(Boolean)).toBe(true);
    expect(req.oidc).toBeUndefined();
  });

  it('hashCliToken is deterministic (lookup key stability)', () => {
    const t = generateCliToken();
    expect(hashCliToken(t)).toBe(hashCliToken(t));
  });
});
