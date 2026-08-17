/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Add the opt-in Entra-to-local identity bridge used during LOCAL_AUTH migration: tenant-bound verified OIDC identities link once to an existing active/invited local account by asserted email, then every request retains the canonical local subject and issuer. Includes a hybrid pilot flag with combined local/Microsoft sign-in and fail-closed configuration.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import {
  ensureLocalUserSchema,
  looksLikeEmail,
  normalizeEmail,
} from '@/features/local-auth';
import { createChildLogger } from '@/shared/logger';
import { LOCAL_AUTH_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { requireExactUserSubject } from '@/shared/security/exact-user-subject';
import {
  buildOwnerRlsPolicyStatements,
  runRuntimeSchemaBootstrap,
} from '@/shared/services/database';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';

const logger = createChildLogger({ module: 'entra-local-identity-bridge' });

const BRIDGE_TABLE = 'oshal_external_identity_links';
const ENTRA_ISSUER_HOST = 'login.microsoftonline.com';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTITY_CACHE_TTL_MS = 30_000;

type OidcUser = Record<string, unknown> & {
  iss?: unknown;
  sub?: unknown;
  tid?: unknown;
  oid?: unknown;
  email?: unknown;
  preferred_username?: unknown;
};

type OidcContext = {
  isAuthenticated?: () => boolean;
  user?: OidcUser;
  idTokenClaims?: OidcUser;
  [key: string]: unknown;
};

type BridgeRequest = Request & { oidc?: OidcContext };

export type CanonicalLocalIdentity = {
  userSub: string;
  email: string;
  displayName: string | null;
};

export type EntraIdentityBridgeDependencies = {
  ensureSchema?: () => Promise<void>;
  resolveIdentity?: (
    issuer: string,
    externalSub: string,
    assertedEmail: string | null,
    entraTenantId: string,
    entraObjectId: string,
  ) => Promise<CanonicalLocalIdentity | null>;
};

/** True only for an explicit opt-in; migration behavior is never inferred from credentials. */
export function isEntraLocalIdentityBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env.ENTRA_LOCAL_IDENTITY_BRIDGE) || envFlag(env.ENTRA_LOCAL_AUTH_HYBRID);
}

/**
 * Hybrid pilot: the local credential page remains `/login` (and `/login/local`) and offers an
 * explicit `/login/microsoft` option. The flag implies the durable identity bridge; it is
 * deliberately separate from LOCAL_AUTH.
 */
export function isEntraLocalAuthHybridEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env.ENTRA_LOCAL_AUTH_HYBRID);
}

function envFlag(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

/**
 * Resolves the one tenant this bridge will trust. `common`, `organizations`, and personal MSA
 * endpoints are intentionally unsupported: an identity migration needs a single accountable
 * directory, not a multi-tenant issuer whose membership boundary can change under it.
 */
export function requireBridgeTenantId(env: NodeJS.ProcessEnv = process.env): string {
  const tenant = (env.MICROSOFT_TENANT_ID ?? '').trim().toLowerCase();
  if (!UUID_PATTERN.test(tenant)) {
    throw new Error(
      'Entra local identity bridge requires MICROSOFT_TENANT_ID as a tenant-specific UUID; common/organizations/consumers are not accepted.',
    );
  }
  return tenant;
}

/**
 * Explicit pilot/rollout gate for first-time links. Removing an address later does not invalidate
 * its durable issuer+subject link; it only prevents a different, not-yet-linked Entra principal
 * from claiming that local account. Empty/malformed lists fail at construction.
 */
export function requireBridgeFirstLinkEmails(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = env.ENTRA_LOCAL_IDENTITY_EMAILS ?? '';
  if (raw.trim().length === 0 || raw.length > 16_384) {
    throw new Error('Entra local identity bridge requires a nonempty ENTRA_LOCAL_IDENTITY_EMAILS first-link allowlist.');
  }
  const emails = new Set<string>();
  for (const entry of raw.split(',')) {
    const email = normalizeEmail(entry);
    if (!entry.trim() || !looksLikeEmail(email)) {
      throw new Error('ENTRA_LOCAL_IDENTITY_EMAILS contains an empty or malformed email address.');
    }
    emails.add(email);
  }
  if (emails.size === 0) {
    throw new Error('Entra local identity bridge requires a nonempty ENTRA_LOCAL_IDENTITY_EMAILS first-link allowlist.');
  }
  return emails;
}

function requireEntraObjectId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error('Verified Entra identity is missing a valid oid claim.');
  }
  return value.toLowerCase();
}

export function expectedEntraIssuer(tenantId: string): string {
  return `https://${ENTRA_ISSUER_HOST}/${tenantId.toLowerCase()}/v2.0`;
}

/**
 * Accepts only the exact tenant-specific Entra issuer shape used by the verified OIDC middleware.
 * URL parsing rejects user-info, query, fragment, non-HTTPS, alternate hosts, and path aliases.
 */
export function normalizeEntraIssuer(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname.toLowerCase() !== ENTRA_ISSUER_HOST ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.search ||
      parsed.hash
    ) return null;
    const match = /^\/([0-9a-f-]+)\/v2\.0\/?$/i.exec(parsed.pathname);
    if (!match || !UUID_PATTERN.test(match[1])) return null;
    return expectedEntraIssuer(match[1]);
  } catch {
    return null;
  }
}

/** Schema is additive and inert while the bridge flag is off, which makes env rollback bounded. */
export async function ensureEntraIdentityBridgeSchema(pool: Pool): Promise<void> {
  await ensureLocalUserSchema(pool);
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'Entra local identity bridge',
    statements: [
      `CREATE TABLE IF NOT EXISTS ${BRIDGE_TABLE} (
        issuer          TEXT NOT NULL,
        external_sub    TEXT NOT NULL,
        entra_tenant_id TEXT NOT NULL,
        entra_object_id TEXT NOT NULL,
        local_user_sub  TEXT NOT NULL REFERENCES oshal_local_users(user_sub) ON DELETE RESTRICT,
        email_at_link   TEXT NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (issuer, external_sub),
        UNIQUE (entra_tenant_id, entra_object_id),
        UNIQUE (issuer, local_user_sub)
      )`,
      ...buildOwnerRlsPolicyStatements(BRIDGE_TABLE, 'local_user_sub'),
    ],
    requirements: [{
      table: BRIDGE_TABLE,
      columns: [
        'issuer', 'external_sub', 'entra_tenant_id', 'entra_object_id',
        'local_user_sub', 'email_at_link', 'created_at', 'last_seen_at',
      ],
    }],
  });
}

type IdentityRow = {
  local_user_sub: unknown;
  email: unknown;
  display_name: unknown;
  status: unknown;
};

function canonicalIdentityFromRow(row: IdentityRow | undefined): CanonicalLocalIdentity | null {
  if (!row || row.status !== 'active') return null;
  const userSub = requireExactUserSubject(row.local_user_sub, 'linked local user subject');
  if (!userSub.startsWith('local-')) return null;
  const email = normalizeEmail(String(row.email ?? ''));
  if (!looksLikeEmail(email)) return null;
  return {
    userSub,
    email,
    displayName: typeof row.display_name === 'string' && row.display_name.length > 0
      ? row.display_name
      : null,
  };
}

/**
 * Resolves a stable link first. Only an unlinked Entra principal may bootstrap by email, and only
 * to an admin-preprovisioned active/invited local account. An invited account is atomically accepted
 * by the verified SSO login while its bounded one-time password invite remains available as the
 * rollback rail; disabled accounts remain denied.
 * The unique constraints make concurrent/conflicting claims fail closed; no account or CRM-owned
 * row is ever created or rewritten here.
 */
export async function resolveCanonicalLocalIdentity(
  pool: Pool,
  issuer: string,
  externalSub: string,
  assertedEmail: string | null,
  entraTenantId: string,
  entraObjectId: string,
): Promise<CanonicalLocalIdentity | null> {
  return runWithSystemIdentity(async () => {
    const existing = await pool.query<IdentityRow>(
      `UPDATE ${BRIDGE_TABLE} l SET last_seen_at = NOW()
         FROM oshal_local_users u
        WHERE l.local_user_sub = u.user_sub
          AND l.issuer = $1 AND l.external_sub = $2
          AND l.entra_tenant_id = $3 AND l.entra_object_id = $4
      RETURNING l.local_user_sub, u.email, u.display_name, u.status`,
      [issuer, externalSub, entraTenantId, entraObjectId],
    );
    const linked = canonicalIdentityFromRow(existing.rows[0]);
    if (linked) return linked;
    // A link to a disabled/malformed/missing local account must never be rebound by email.
    if (existing.rows.length > 0 || !assertedEmail) return null;

    let inserted: { rows: IdentityRow[] };
    try {
      inserted = await pool.query<IdentityRow>(
        `WITH candidate AS (
           SELECT user_sub, email, display_name, status
             FROM oshal_local_users
            WHERE email = $3 AND status IN ('active', 'invited')
            LIMIT 1
            FOR UPDATE
         ), linked AS (
           INSERT INTO ${BRIDGE_TABLE}
             (issuer, external_sub, entra_tenant_id, entra_object_id, local_user_sub, email_at_link)
           SELECT $1, $2, $4, $5, user_sub, email FROM candidate
           ON CONFLICT (issuer, external_sub) DO NOTHING
           RETURNING local_user_sub
         ), accepted AS (
           UPDATE oshal_local_users u SET
             status = 'active',
             activated_at = COALESCE(u.activated_at, NOW())
           FROM linked l
           WHERE u.user_sub = l.local_user_sub AND u.status IN ('active', 'invited')
           RETURNING u.user_sub AS local_user_sub, u.email, u.display_name, u.status
         )
         SELECT local_user_sub, email, display_name, status FROM accepted`,
        [issuer, externalSub, assertedEmail, entraTenantId, entraObjectId],
      );
    } catch (error) {
      // Another Entra principal is already linked to this local account. That is an authorization
      // conflict, not an invitation to rebind; suppress database detail and fail as unprovisioned.
      if ((error as { code?: unknown } | null)?.code === '23505') return null;
      throw error;
    }
    const created = canonicalIdentityFromRow(inserted.rows[0]);
    if (created) return created;

    // A concurrent request may have inserted the same stable link. Re-read it; any collision
    // onto another principal/local account remains null (or raises unique_violation above).
    const raced = await pool.query<IdentityRow>(
      `UPDATE ${BRIDGE_TABLE} l SET last_seen_at = NOW()
         FROM oshal_local_users u
        WHERE l.local_user_sub = u.user_sub
          AND l.issuer = $1 AND l.external_sub = $2
          AND l.entra_tenant_id = $3 AND l.entra_object_id = $4
      RETURNING l.local_user_sub, u.email, u.display_name, u.status`,
      [issuer, externalSub, entraTenantId, entraObjectId],
    );
    return canonicalIdentityFromRow(raced.rows[0]);
  });
}

function assertedAccountEmail(user: OidcUser): string | null {
  const raw = typeof user.email === 'string'
    ? user.email
    : typeof user.preferred_username === 'string'
      ? user.preferred_username
      : '';
  const normalized = normalizeEmail(raw);
  return looksLikeEmail(normalized) ? normalized : null;
}

function replaceOidcIdentity(req: BridgeRequest, identity: CanonicalLocalIdentity): void {
  const original = req.oidc;
  if (!original) return;
  const externalUser = original.user ?? {};
  const externalClaims = original.idTokenClaims ?? externalUser;
  const mappedUser = {
    ...externalUser,
    iss: LOCAL_AUTH_PRINCIPAL_ISSUER,
    sub: identity.userSub,
    email: identity.email,
    preferred_username: identity.email,
    name: identity.displayName || identity.email,
  };
  const mappedClaims = {
    ...externalClaims,
    iss: LOCAL_AUTH_PRINCIPAL_ISSUER,
    sub: identity.userSub,
    email: identity.email,
    preferred_username: identity.email,
    name: identity.displayName || identity.email,
  };
  // express-openid-connect exposes `user` and `idTokenClaims` as getters returning clones.
  // A Proxy keeps token refresh/logout methods bound to the library's opaque RequestContext while
  // presenting the canonical platform principal to every authorization/data boundary downstream.
  req.oidc = new Proxy(original, {
    get(target, property) {
      if (property === 'user') return mappedUser;
      if (property === 'idTokenClaims') return mappedClaims;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function rejectUnlinked(res: Response, localFallback: boolean): void {
  res.status(403).json({
    authenticated: false,
    error: 'identity_not_provisioned',
    message: 'This Microsoft account is not provisioned for this deployment. Contact an administrator.',
    ...(localFallback ? { localLoginPath: '/login/local' } : {}),
  });
}

/**
 * Post-OIDC trust-boundary mapper. It never trusts headers/body/query and it never accepts a token
 * itself: the only input is the cryptographically verified `req.oidc` session produced upstream.
 */
export function createEntraLocalIdentityBridgeMiddleware(
  pool: Pool,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: EntraIdentityBridgeDependencies = {},
): RequestHandler {
  if (!isEntraLocalIdentityBridgeEnabled(env)) {
    throw new Error('createEntraLocalIdentityBridgeMiddleware called while the bridge is disabled.');
  }
  if (envFlag(env.LOCAL_AUTH) && !isEntraLocalAuthHybridEnabled(env)) {
    throw new Error('Entra identity bridge with LOCAL_AUTH=true requires ENTRA_LOCAL_AUTH_HYBRID=true; standalone LOCAL_AUTH must not invoke external identity mapping.');
  }
  if (envFlag(env.MOCK_OIDC)) {
    throw new Error('Entra identity bridge refuses MOCK_OIDC; it requires a cryptographically verified Entra session.');
  }
  const tenantId = requireBridgeTenantId(env);
  const trustedIssuer = expectedEntraIssuer(tenantId);
  const firstLinkEmails = requireBridgeFirstLinkEmails(env);
  const localFallback = isEntraLocalAuthHybridEnabled(env);
  const ensureSchema = dependencies.ensureSchema ?? (() => ensureEntraIdentityBridgeSchema(pool));
  const resolveIdentity = dependencies.resolveIdentity
    ?? ((issuer, sub, email, tid, oid) => resolveCanonicalLocalIdentity(pool, issuer, sub, email, tid, oid));
  const identityCache = new Map<string, { identity: CanonicalLocalIdentity; at: number }>();
  let schemaReady: Promise<void> | null = null;
  const ready = (): Promise<void> => {
    if (!schemaReady) {
      schemaReady = ensureSchema().catch((error) => {
        schemaReady = null;
        throw error;
      });
    }
    return schemaReady;
  };
  void ready().catch((error) => logger.error({ err: error }, 'Entra identity bridge schema bootstrap failed'));

  return async (rawReq: Request, res: Response, next: NextFunction) => {
    const req = rawReq as BridgeRequest;
    const oidc = req.oidc;
    if (!oidc?.isAuthenticated?.()) {
      next();
      return;
    }
    const user = oidc.user;
    try {
      const issuer = normalizeEntraIssuer(user?.iss);
      const tokenTenant = typeof user?.tid === 'string' ? user.tid.toLowerCase() : '';
      if (issuer !== trustedIssuer || tokenTenant !== tenantId) {
        logger.warn('Authenticated non-tenant identity rejected by Entra local identity bridge');
        rejectUnlinked(res, localFallback);
        return;
      }
      let externalSub: string;
      let entraObjectId: string;
      try {
        externalSub = requireExactUserSubject(user?.sub, 'Entra subject');
        entraObjectId = requireEntraObjectId(user?.oid);
      } catch {
        logger.warn('Authenticated Entra identity with invalid stable claims rejected');
        rejectUnlinked(res, localFallback);
        return;
      }
      await ready();
      const cacheKey = `${issuer}\u0000${externalSub}\u0000${entraObjectId}`;
      const cached = identityCache.get(cacheKey);
      const assertedEmail = assertedAccountEmail(user ?? {});
      const firstLinkEmail = assertedEmail && firstLinkEmails.has(assertedEmail) ? assertedEmail : null;
      const identity = cached && Date.now() - cached.at < IDENTITY_CACHE_TTL_MS
        ? cached.identity
        : await resolveIdentity(issuer, externalSub, firstLinkEmail, tokenTenant, entraObjectId);
      if (!identity) {
        identityCache.delete(cacheKey);
        logger.warn({ issuer }, 'Entra identity has no active canonical local account link');
        rejectUnlinked(res, localFallback);
        return;
      }
      identityCache.set(cacheKey, { identity, at: Date.now() });
      replaceOidcIdentity(req, identity);
      next();
    } catch (error) {
      logger.error({ err: error }, 'Entra local identity bridge failed closed');
      res.status(503).json({
        authenticated: false,
        error: 'identity_bridge_unavailable',
        message: localFallback
          ? 'Sign-in could not be completed safely. Try again or use the local fallback.'
          : 'Sign-in could not be completed safely. Try again or contact an administrator.',
        ...(localFallback ? { localLoginPath: '/login/local' } : {}),
      });
    }
  };
}
