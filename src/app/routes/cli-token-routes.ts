/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — personal access tokens (PATs) for headless CLI auth, the industry-standard replacement for handing humans the machine-wide SWARM_SERVICE_SECRET. `oshal_pat_`-prefixed tokens (greppable by the tier-A secret scanners), sha256-hashed at rest in oshal_cli_tokens (owner RLS at the lazy-DDL chokepoint, mirroring tv-pairing-routes). createCliTokenAuthMiddleware stamps an authenticated req.oidc from `Authorization: Bearer oshal_pat_…` — the same MOCK_OIDC/tv-token session shape — so EVERY requiresAuth route accepts a PAT as its owner with zero per-route changes; an invalid token falls through to the normal 401, never a new rejection path. Routes: POST / mint (session or trusted-service bootstrap), GET / list, DELETE /:id revoke, GET /whoami. Consumed by scripts/swarm-cli.js `login`.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Optional token expiry (enables short-lived phone-pairing tokens for the Spaces mobile ingest, ADR-111). Added a nullable expires_at column (ALTER … ADD COLUMN IF NOT EXISTS — existing PATs stay non-expiring, expires_at IS NULL) and made the auth middleware reject an expired token: the lookup now requires `(expires_at IS NULL OR expires_at > NOW())`, so an elapsed pairing token authenticates on NO route. Extracted the mint path into an exported insertCliToken(pool, {sub,email,label,ttlMs}) helper — single source of the column set now that expiry exists — and pointed POST / at it. Consumed by the auth-gated POST /api/spaces/pair mint endpoint.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | guc-strict fix: the auth middleware's token lookup ran with NO request identity (it IS the identity-stamper — chicken-and-egg), so once OSHAL_DB_GUC_STRICT=deny went live the FORCE-RLS oshal_cli_tokens SELECT returned zero rows and EVERY PAT 401'd on every route. Lookup + the best-effort last_used_at update now run under runWithSystemIdentity — the sanctioned trusted-path sentinel the deny log itself prescribes; safe because the read is proof-of-possession (keyed on the 48-hex token hash) and returns only that row. Guard: tests/unit/token-middleware-rls.spec.ts.
 */
import { Router, type RequestHandler, type Request, type Response } from 'express';
import crypto from 'crypto';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { getCaller, getTrustedServiceUserSub, isOperator } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'cli-tokens' });

/** Token prefix — recognizable (like ghp_) so secret scanners and humans can spot a leak. */
export const CLI_TOKEN_PREFIX = 'oshal_pat_';
/** Random payload size; 24 bytes → 48 hex chars of entropy. */
const TOKEN_BYTES = 24;
/** Labels are operator-facing display strings, not content — keep them short. */
const LABEL_MAX = 80;

/**
 * @description Mints a new personal-access-token string. The plaintext is shown to the
 * caller exactly once at creation; only its sha256 lands in the database.
 * @returns the plaintext token (`oshal_pat_` + 48 hex chars).
 */
export function generateCliToken(): string {
  return `${CLI_TOKEN_PREFIX}${crypto.randomBytes(TOKEN_BYTES).toString('hex')}`;
}

/**
 * @description Hash used for storage and lookup — sha256 hex. Tokens carry 192 bits of
 * entropy, so an unsalted fast hash is the standard trade (GitHub does the same): lookups
 * stay a single indexed equality and brute-forcing the space is infeasible.
 * @param token - plaintext token.
 * @returns hex digest.
 */
export function hashCliToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * @description Creates the PAT store if absent (lazy-DDL chokepoint, mirroring
 * tv_token_revocations) with owner RLS applied at creation so a fresh database
 * enforces isolation immediately. Inert while the runtime connects as a superuser.
 * @param pool - Postgres pool.
 * @returns resolves when the table + policies exist.
 */
export async function ensureCliTokenSchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'cli token routes',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_cli_tokens (
        id           TEXT PRIMARY KEY,
        user_sub     TEXT NOT NULL,
        email        TEXT,
        label        TEXT,
        token_hash   TEXT UNIQUE NOT NULL,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        last_used_at TIMESTAMPTZ,
        revoked_at   TIMESTAMPTZ,
        expires_at   TIMESTAMPTZ
      )`,
      // Additive migration for databases created before expiry existed — a NULL expires_at
      // is a non-expiring PAT, so existing rows are unaffected.
      `ALTER TABLE oshal_cli_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
      ...buildOwnerRlsPolicyStatements('oshal_cli_tokens', 'user_sub'),
    ],
    requirements: [{ table: 'oshal_cli_tokens', columns: ['id', 'user_sub', 'token_hash', 'revoked_at', 'expires_at'] }],
  });
}

/** Caller identity: OIDC session first, else the trusted-service assertion (same order as message-routes). */
function callerSub(req: Request): string | null {
  return getCaller(req).sub ?? getTrustedServiceUserSub(req);
}

/** Extracts a PAT from `Authorization: Bearer oshal_pat_…`; anything else is not ours. */
function patFromReq(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) return undefined;
  const token = auth.slice(7).trim();
  return token.startsWith(CLI_TOKEN_PREFIX) ? token : undefined;
}

/**
 * @description Global middleware that authenticates a request from a personal access
 * token when there is no interactive OIDC session, injecting an authenticated `req.oidc`
 * (the same shape MOCK_OIDC and the TV-token path use) so requiresAuth, getCaller, the
 * RLS identity stamp, and operator checks all resolve the token's OWNER. Only
 * `Authorization: Bearer oshal_pat_…` is intercepted — the remote-client shared-secret
 * Bearer and everything else pass through untouched. An unknown/revoked token is NOT an
 * error here; the request simply stays unauthenticated and hits the normal 401.
 * Mount immediately after the TV-token middleware, before route guards.
 * @param pool - Postgres pool backing the token store.
 * @returns an Express RequestHandler.
 */
export function createCliTokenAuthMiddleware(pool: Pool): RequestHandler {
  return async (req, _res, next) => {
    try {
      const existing = (req as { oidc?: { isAuthenticated?: () => boolean } }).oidc;
      if (existing?.isAuthenticated?.()) return next();
      const token = patFromReq(req);
      if (!token) return next();
      // A revoked OR expired token authenticates on no route — the expiry guard is what makes a
      // short-lived phone-pairing token time out (non-expiring PATs have expires_at IS NULL).
      // SYSTEM identity: this lookup necessarily precedes any request identity (it creates it),
      // and oshal_cli_tokens is FORCE-RLS — without the sentinel, guc-strict deny scopes the
      // read to nothing and every valid PAT is rejected. Proof-of-possession keyed on the hash.
      const { rows } = await runWithSystemIdentity(() =>
        pool.query(
          `SELECT id, user_sub, email FROM oshal_cli_tokens
            WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
            LIMIT 1`,
          [hashCliToken(token)],
        ),
      );
      const row = rows[0] as { id: string; user_sub: string; email: string | null } | undefined;
      if (!row) {
        logger.warn({ path: req.path }, 'rejected unknown/revoked CLI token');
        return next();
      }
      (req as { oidc?: unknown }).oidc = {
        isAuthenticated: () => true,
        user: { sub: row.user_sub, email: row.email || undefined, preferred_username: row.email || undefined },
        idToken: 'cli-token',
        accessToken: 'cli-token',
      };
      // Usage telemetry is best-effort — never in the request's critical path. Runs under the
      // same SYSTEM sentinel: the row belongs to the token's owner, not yet to any request.
      void runWithSystemIdentity(() =>
        pool.query('UPDATE oshal_cli_tokens SET last_used_at = NOW() WHERE id = $1', [row.id]),
      ).catch((err) => logger.warn({ err }, 'cli token last_used_at update failed'));
    } catch (err) {
      logger.error({ err }, 'CLI token middleware failed');
    }
    next();
  };
}

/** Sanitizes a user-supplied token label to a short display string. */
function cleanLabel(raw: unknown): string {
  const label = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return (label || 'cli token').slice(0, LABEL_MAX);
}

/** Input to {@link insertCliToken}. `ttlMs` omitted/≤0 mints a non-expiring PAT. */
export interface CliTokenMintInput {
  sub: string;
  email?: string | null;
  label?: string;
  /** Lifetime in ms; when > 0 the token auto-expires (used by short-lived phone pairing). */
  ttlMs?: number;
}

/** Result of a mint — the plaintext token is present exactly once and is never persisted. */
export interface MintedCliToken {
  id: string;
  token: string;
  label: string;
  createdAt: string;
  /** ISO expiry, or null for a non-expiring PAT. */
  expiresAt: string | null;
}

/**
 * @description Single mint path for the oshal_cli_tokens store — the one place that knows the
 * column set (now that optional expiry exists). Generates a prefixed high-entropy token, stores
 * only its sha256 with an optional expires_at, and returns the plaintext ONCE. Reused by both the
 * PAT mint route and the Spaces phone-pairing endpoint so neither duplicates the INSERT.
 * @param pool - Postgres pool backing the token store.
 * @param input - owner sub, optional email/label, optional ttlMs for a short-lived token.
 * @returns the minted token metadata plus the one-time plaintext.
 */
export async function insertCliToken(pool: Pool, input: CliTokenMintInput): Promise<MintedCliToken> {
  const id = crypto.randomUUID();
  const token = generateCliToken();
  const label = cleanLabel(input.label);
  const expiresAt = input.ttlMs && input.ttlMs > 0 ? new Date(Date.now() + input.ttlMs) : null;
  await pool.query(
    `INSERT INTO oshal_cli_tokens (id, user_sub, email, label, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, input.sub, input.email ?? null, label, hashCliToken(token), expiresAt],
  );
  return {
    id, token, label,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };
}

/**
 * @description Builds the PAT management router (mount at /api/cli-tokens behind
 * serviceSecretOr(requiresAuth) — a browser session manages its own tokens; the
 * trusted-service secret may bootstrap-mint for an asserted sub, which is not an
 * escalation because the secret already implies full impersonation).
 * @param pool - Postgres pool.
 * @returns Express router.
 */
export function createCliTokenRoutes(pool: Pool): Router {
  const router = Router();
  void ensureCliTokenSchema(pool).catch((err) => {
    logger.error({ err }, 'oshal_cli_tokens schema bootstrap failed — PAT auth unavailable until it exists');
  });

  /** GET /whoami — the caller's resolved identity; what `swarm-cli login` verifies against. */
  router.get('/whoami', (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    res.json({ sub, email: getCaller(req).email, operator: isOperator(req) });
  });

  /** POST / — mint a (non-expiring) token for the caller. The plaintext is returned ONCE and never stored. */
  router.post('/', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    try {
      const minted = await insertCliToken(pool, {
        sub, email: getCaller(req).email, label: (req.body as { label?: string } | undefined)?.label,
      });
      logger.info({ id: minted.id, sub, label: minted.label }, 'cli token minted');
      res.status(201).json(minted);
    } catch (err) {
      logger.error({ err }, 'cli token mint failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** GET / — the caller's tokens (metadata only — hashes and plaintext never leave the server). */
  router.get('/', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    try {
      const { rows } = await pool.query(
        `SELECT id, label, created_at, last_used_at, revoked_at
           FROM oshal_cli_tokens WHERE user_sub = $1 ORDER BY created_at DESC`,
        [sub],
      );
      res.json({
        tokens: rows.map((r) => ({
          id: r.id, label: r.label, createdAt: r.created_at,
          lastUsedAt: r.last_used_at, revoked: r.revoked_at !== null,
        })),
      });
    } catch (err) {
      logger.error({ err }, 'cli token list failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** DELETE /:id — revoke one of the CALLER's tokens. Owner-scoped: someone else's id
   *  is indistinguishable from a missing one (revoked:false), so ids are not oracle-able. */
  router.delete('/:id', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    try {
      const result = await pool.query(
        'UPDATE oshal_cli_tokens SET revoked_at = NOW() WHERE id = $1 AND user_sub = $2 AND revoked_at IS NULL',
        [String(req.params.id), sub],
      );
      res.json({ ok: true, revoked: (result.rowCount ?? 0) > 0 });
    } catch (err) {
      logger.error({ err }, 'cli token revoke failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
