/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — personal access tokens (PATs) for headless CLI auth, the industry-standard replacement for handing humans the machine-wide SWARM_SERVICE_SECRET. `oshal_pat_`-prefixed tokens (greppable by the tier-A secret scanners), sha256-hashed at rest in oshal_cli_tokens (owner RLS at the lazy-DDL chokepoint, mirroring tv-pairing-routes). createCliTokenAuthMiddleware stamps an authenticated req.oidc from `Authorization: Bearer oshal_pat_…` — the same MOCK_OIDC/tv-token session shape — so EVERY requiresAuth route accepts a PAT as its owner with zero per-route changes; an invalid token falls through to the normal 401, never a new rejection path. Routes: POST / mint (session or trusted-service bootstrap), GET / list, DELETE /:id revoke, GET /whoami. Consumed by scripts/swarm-cli.js `login`.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Optional token expiry (enables short-lived phone-pairing tokens for the Spaces mobile ingest, ADR-111). Added a nullable expires_at column (ALTER … ADD COLUMN IF NOT EXISTS — existing PATs stay non-expiring, expires_at IS NULL) and made the auth middleware reject an expired token: the lookup now requires `(expires_at IS NULL OR expires_at > NOW())`, so an elapsed pairing token authenticates on NO route. Extracted the mint path into an exported insertCliToken(pool, {sub,email,label,ttlMs}) helper — single source of the column set now that expiry exists — and pointed POST / at it. Consumed by the auth-gated POST /api/spaces/pair mint endpoint.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | guc-strict fix: the auth middleware's token lookup ran with NO request identity (it IS the identity-stamper — chicken-and-egg), so once OSHAL_DB_GUC_STRICT=deny went live the FORCE-RLS oshal_cli_tokens SELECT returned zero rows and EVERY PAT 401'd on every route. Lookup + the best-effort last_used_at update now run under runWithSystemIdentity — the sanctioned trusted-path sentinel the deny log itself prescribes; safe because the read is proof-of-possession (keyed on the 48-hex token hash) and returns only that row. Guard: tests/unit/token-middleware-rls.spec.ts.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Closed the bootstrap-mint escalation. POST / previously accepted the x-oshal-user-sub assertion for ANY sub and minted a NON-EXPIRING PAT, so any holder of the fleet-wide SWARM_SERVICE_SECRET (every bot container carries it) could mint a permanent credential for an arbitrary user and then authenticate as them on every requiresAuth route — including /api/content and /api/linkedin-assistant, which the service secret alone cannot reach. That turned a per-request impersonation into persistent account takeover, which matters because a prompt-injected bot is an untrusted principal holding that secret. Header-asserted (session-less) mints are now (a) operator-only via isOperatorIdentity — fail-closed on an empty allowlist — and (b) time-boxed by OSHAL_CLI_TOKEN_BOOTSTRAP_TTL_DAYS (default 30) using the existing expires_at column, so even the operator bootstrap is no longer a permanent credential. Session-authenticated mints (the cockpit path) are unchanged and still non-expiring. swarm-cli's service-secret login keeps working for the operator. Guard: tests/unit/cli-token-auth.spec.ts.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | PER-NODE WORKER-PLANE TOKENS (docs/backlog/hardening.md #7 - retire the swarm-wide REMOTE_CLIENT_SHARED_SECRET). A token may now be BOUND to one device (node_client_id; migration 102 plus the lazy-DDL ALTER): the auth middleware admits such a token ONLY on the paths decideNodeTokenScope allows (its own /api/remote-clients/<clientId> plane plus the two enrollment-handshake paths) and stamps the binding on the request, so a credential lifted off an edge machine is NOT the account credential an unbound PAT is - it cannot reach /api/content, cannot mint tokens, and cannot touch a sibling device. rotateNodeToken revokes every live token for a device and mints its successor in ONE call (the rotation a compose-file secret structurally cannot offer). Unbound PATs behave identically. Guard: tests/unit/remote-client-node-token.spec.ts.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Preserve the verified principal issuer on newly minted PATs and rotated node credentials. Bearer authentication now replays the original (issuer, subject) namespace; legacy rows remain usable by core routes but carry no invented issuer, so issuer-bound applications fail closed instead of rebinding an old token to a newly configured IdP.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Preserve exact owner subjects during node-token rotation. The required non-empty validation remains, but subject case/whitespace is no longer trimmed before owner-scoped revocation and successor minting.
 */
import { Router, type RequestHandler, type Request, type Response } from 'express';
import crypto from 'crypto';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { getCaller, getTrustedServiceUserSub, isOperator, isOperatorIdentity } from '@/shared/middleware/authz';
import {
  getAuthenticatedPrincipalIssuer,
  normalizePrincipalIssuer,
} from '@/shared/middleware/principal-issuer';
import { decideNodeTokenScope } from '@/features/remote-client';

const logger = createChildLogger({ module: 'cli-tokens' });

/** Default lifetime for a session-less bootstrap mint. Long enough not to nag a CLI user, short
 *  enough that a leaked bootstrap token is not a permanent credential. */
const BOOTSTRAP_TTL_DAYS_DEFAULT = 30;

/**
 * @description Lifetime applied to a bootstrap (service-secret + asserted-sub) mint. Tunable via
 * OSHAL_CLI_TOKEN_BOOTSTRAP_TTL_DAYS; a non-numeric or non-positive value falls back to the default
 * rather than minting a non-expiring token, so a typo cannot silently restore permanence.
 * @returns lifetime in milliseconds, always > 0.
 */
function bootstrapTtlMs(): number {
  const raw = Number(process.env.OSHAL_CLI_TOKEN_BOOTSTRAP_TTL_DAYS ?? BOOTSTRAP_TTL_DAYS_DEFAULT);
  const days = Number.isFinite(raw) && raw > 0 ? raw : BOOTSTRAP_TTL_DAYS_DEFAULT;
  return days * 24 * 60 * 60 * 1000;
}

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
        expires_at   TIMESTAMPTZ,
        node_client_id TEXT,
        principal_issuer TEXT
      )`,
      // Additive migration for databases created before expiry existed — a NULL expires_at
      // is a non-expiring PAT, so existing rows are unaffected.
      `ALTER TABLE oshal_cli_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
      // Per-node binding (hardening #7; recorded form scripts/migrations/102-cli-token-node-binding.sql).
      // NULL = an ordinary account PAT, which every pre-existing row is, so they are unaffected.
      `ALTER TABLE oshal_cli_tokens ADD COLUMN IF NOT EXISTS node_client_id TEXT`,
      // Null is intentionally retained for legacy tokens: guessing the current OIDC issuer
      // would let an old subject value cross into a newly configured provider namespace.
      `ALTER TABLE oshal_cli_tokens ADD COLUMN IF NOT EXISTS principal_issuer TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_oshal_cli_tokens_node_client
         ON oshal_cli_tokens (node_client_id) WHERE node_client_id IS NOT NULL`,
      ...buildOwnerRlsPolicyStatements('oshal_cli_tokens', 'user_sub'),
    ],
    requirements: [{
      table: 'oshal_cli_tokens',
      columns: ['id', 'user_sub', 'token_hash', 'revoked_at', 'expires_at', 'node_client_id', 'principal_issuer'],
    }],
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

interface CliTokenAuthRow {
  id: string;
  user_sub: string;
  email: string | null;
  node_client_id: string | null;
  principal_issuer: string | null;
}

/** Read one live credential under the trusted pre-identity SYSTEM sentinel. */
async function findLiveCliToken(pool: Pool, token: string): Promise<CliTokenAuthRow | undefined> {
  const { rows } = await runWithSystemIdentity(() =>
    pool.query(
      `SELECT id, user_sub, email, node_client_id, principal_issuer FROM oshal_cli_tokens
        WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1`,
      [hashCliToken(token)],
    ),
  );
  return rows[0] as CliTokenAuthRow | undefined;
}

/** Enforce a device-bound token's narrow plane and stamp the verified binding. */
function admitNodeTokenScope(req: Request, row: CliTokenAuthRow): boolean {
  if (!row.node_client_id) return true;
  const scope = decideNodeTokenScope({ boundClientId: row.node_client_id, path: req.path });
  if (!scope.allowed) {
    logger.warn(
      { path: req.path, boundClientId: row.node_client_id, tokenId: row.id, reason: scope.reason },
      'refused node-bound CLI token off its own device plane',
    );
    return false;
  }
  (req as { oshalNodeToken?: NodeTokenBinding }).oshalNodeToken = {
    clientId: row.node_client_id,
    tokenId: row.id,
  };
  return true;
}

/** Restore the owner and only the issuer verified when the token was minted. */
function stampCliTokenPrincipal(req: Request, row: CliTokenAuthRow): void {
  const issuer = normalizePrincipalIssuer(row.principal_issuer);
  (req as { oidc?: unknown }).oidc = {
    isAuthenticated: () => true,
    user: {
      ...(issuer ? { iss: issuer } : {}),
      sub: row.user_sub,
      email: row.email || undefined,
      preferred_username: row.email || undefined,
    },
    idToken: 'cli-token',
    accessToken: 'cli-token',
  };
}

/** Best-effort usage telemetry; authentication never depends on this write. */
function touchCliToken(pool: Pool, tokenId: string): void {
  void runWithSystemIdentity(() =>
    pool.query('UPDATE oshal_cli_tokens SET last_used_at = NOW() WHERE id = $1', [tokenId]),
  ).catch((err) => logger.warn({ err }, 'cli token last_used_at update failed'));
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
      const row = await findLiveCliToken(pool, token);
      if (!row) {
        logger.warn({ path: req.path }, 'rejected unknown/revoked CLI token');
        return next();
      }
      // Per-node confinement (hardening #7): a DEVICE credential is not an ACCOUNT credential.
      // A token bound to a clientId authenticates only on that device's worker plane and the
      // enrollment handshake; anywhere else it leaves the request unauthenticated, so it hits
      // the normal 401 exactly like an unknown token. Unbound PATs skip this entirely.
      if (!admitNodeTokenScope(req, row)) return next();
      stampCliTokenPrincipal(req, row);
      // Usage telemetry is best-effort — never in the request's critical path. Runs under the
      // same SYSTEM sentinel: the row belongs to the token's owner, not yet to any request.
      touchCliToken(pool, row.id);
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
  /** Verified namespace of `sub`; null/omitted deliberately leaves issuer-bound apps closed. */
  principalIssuer?: string | null;
  /** Lifetime in ms; when > 0 the token auto-expires (used by short-lived phone pairing). */
  ttlMs?: number;
  /**
   * Binds the token to ONE remote-client device (hardening #7). A bound token authenticates
   * only on that device's worker plane plus the enrollment handshake - never as a general
   * account credential. Omit for an ordinary PAT.
   */
  nodeClientId?: string | null;
}

/** Result of a mint — the plaintext token is present exactly once and is never persisted. */
export interface MintedCliToken {
  id: string;
  token: string;
  label: string;
  createdAt: string;
  /** ISO expiry, or null for a non-expiring PAT. */
  expiresAt: string | null;
  /** The device this token is confined to, or null for an ordinary account PAT. */
  nodeClientId: string | null;
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
  const nodeClientId = typeof input.nodeClientId === 'string' && input.nodeClientId.trim().length > 0
    ? input.nodeClientId.trim().slice(0, 200)
    : null;
  const principalIssuer = normalizePrincipalIssuer(input.principalIssuer);
  await pool.query(
    `INSERT INTO oshal_cli_tokens
       (id, user_sub, email, label, token_hash, expires_at, node_client_id, principal_issuer)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, input.sub, input.email ?? null, label, hashCliToken(token), expiresAt, nodeClientId, principalIssuer],
  );
  return {
    id, token, label,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    nodeClientId,
  };
}

/** The device binding a request's credential carries, stamped by the auth middleware. */
export interface NodeTokenBinding {
  /** The clientId this credential is confined to. */
  clientId: string;
  /** Token row id (audit + rotation target); never the token itself. */
  tokenId: string;
}

/** Request shape the node-binding stamp lives on. */
type NodeBoundRequest = Request & { oshalNodeToken?: NodeTokenBinding };

/**
 * @description Reads the per-node binding the CLI-token middleware stamped on this request,
 * or null when the caller is a session / service / unbound-PAT caller. Route guards use it to
 * refuse a device credential that names one device and acts on another - the POST /register
 * case, where the device identity travels in the body instead of the URL.
 * @param req - The inbound request.
 * @returns The binding, or null when the caller is not a node-bound token.
 */
export function readNodeTokenBinding(req: Request): NodeTokenBinding | null {
  return (req as NodeBoundRequest).oshalNodeToken ?? null;
}

/**
 * @description Rotates a device's worker-plane credential: revokes EVERY live token bound to
 * that clientId for that owner, then mints its successor - one call, so there is never a
 * window with two valid generations. Owner-scoped in SQL, so rotating on someone's behalf
 * requires naming that owner's sub explicitly.
 * @param pool - Postgres pool backing the token store.
 * @param input - Device clientId, the owner sub the token belongs to, optional label/email/ttl.
 * @returns The minted successor (plaintext present exactly once) plus how many were revoked.
 */
export async function rotateNodeToken(
  pool: Pool,
  input: {
    clientId: string;
    ownerSub: string;
    email?: string | null;
    label?: string;
    ttlMs?: number;
    principalIssuer?: string | null;
  },
): Promise<MintedCliToken & { revokedCount: number }> {
  const clientId = String(input.clientId ?? '').trim();
  const ownerSub = String(input.ownerSub ?? '');
  if (clientId.length === 0 || ownerSub.trim().length === 0) {
    throw new Error('rotateNodeToken requires both clientId and ownerSub');
  }
  const revoked = await pool.query(
    `UPDATE oshal_cli_tokens SET revoked_at = NOW()
       WHERE node_client_id = $1 AND user_sub = $2 AND revoked_at IS NULL`,
    [clientId, ownerSub],
  );
  const minted = await insertCliToken(pool, {
    sub: ownerSub,
    email: input.email ?? null,
    label: input.label ?? `node ${clientId}`,
    ttlMs: input.ttlMs,
    nodeClientId: clientId,
    principalIssuer: input.principalIssuer,
  });
  logger.info(
    { clientId, ownerSub, revokedCount: revoked.rowCount ?? 0, tokenId: minted.id },
    'node token rotated - prior generations revoked',
  );
  return { ...minted, revokedCount: revoked.rowCount ?? 0 };
}

/**
 * @description Builds the PAT management router (mount at /api/cli-tokens behind
 * serviceSecretOr(requiresAuth) — a browser session manages its own tokens; the
 * trusted-service secret may bootstrap-mint, but only for an OPERATOR sub and only as a
 * time-boxed token. The older rationale — "not an escalation, the secret already implies full
 * impersonation" — assumed every secret-holder is trusted. Bots are secret-holders and are
 * prompt-injectable, so an unbounded mint converted per-request impersonation into a permanent
 * cross-user credential; see change-log entry 4.
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

  /**
   * POST / — mint a token for the caller. The plaintext is returned ONCE and never stored.
   *
   * Two paths with deliberately different power:
   *  - SESSION mint (a signed-in cockpit user managing their own tokens) — non-expiring, unchanged.
   *  - BOOTSTRAP mint (no session; identity asserted via x-oshal-user-sub behind the service
   *    secret, i.e. `swarm-cli login --secret`) — operator-only and time-boxed. Every bot container
   *    carries the fleet-wide SWARM_SERVICE_SECRET, so treating the assertion as sufficient let a
   *    single injected bot mint a PERMANENT credential for any user and then act as them on every
   *    requiresAuth route. Bounding it here is what keeps a compromised bot's reach per-request.
   */
  router.post('/', async (req: Request, res: Response) => {
    const sessionSub = getCaller(req).sub ?? null;
    const assertedSub = sessionSub ? null : getTrustedServiceUserSub(req);
    const sub = sessionSub ?? assertedSub;
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    // The asserted value is a sub, but operators may be allowlisted by either sub or email; check
    // it against both lists so an email-only allowlist doesn't silently break the bootstrap.
    if (!sessionSub && !isOperatorIdentity(assertedSub, assertedSub)) {
      logger.warn({ assertedSub }, 'refused bootstrap PAT mint — asserted sub is not an operator');
      res.status(403).json({ error: 'operator_required' });
      return;
    }
    try {
      const minted = await insertCliToken(pool, {
        sub, email: getCaller(req).email, label: (req.body as { label?: string } | undefined)?.label,
        ttlMs: sessionSub ? undefined : bootstrapTtlMs(),
        // A service-secret assertion is not proof of an IdP namespace. Only an authenticated
        // session can delegate its issuer; bootstrap PATs therefore remain app-fail-closed.
        principalIssuer: sessionSub ? getAuthenticatedPrincipalIssuer(req) : null,
      });
      logger.info(
        { id: minted.id, sub, label: minted.label, bootstrap: !sessionSub, expiresAt: minted.expiresAt },
        'cli token minted',
      );
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
