/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Build application authorization actors from verified sessions/delegation and current local account state.
 */
import type { Request } from 'express';
import type { Pool } from 'pg';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { getSessionSnapshot } from '@/features/local-auth';
import { getRole } from '@/features/swarm-roles';
import { getVerifiedWorkloadDelegation } from '@/features/security';
import { getCaller } from '@/shared/middleware/authz';
import { getAuthenticatedPrincipalIssuer, GUEST_PRINCIPAL_ISSUER, LOCAL_AUTH_PRINCIPAL_ISSUER, MOCK_OIDC_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { getPreservedDirectoryClaims } from '@/shared/middleware/verified-directory-claims';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';

type Claims = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ApplicationActorResolverOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  localSnapshot?: (sub: string) => Promise<{ status: string } | null>;
  tenantIds?: (sub: string, issuer: string) => Promise<string[]>;
  management?: (sub: string, issuer: string, email: string | null) => boolean | Promise<boolean>;
}

/** Normalize source-qualified Entra group evidence; protocol claims have already been authenticated. */
export function directoryEvidence(claims: Readonly<Claims> | undefined, now: number): AuthorizationActor['directory'] {
  if (!claims || typeof claims.iss !== 'string' || typeof claims.tid !== 'string' || !UUID.test(claims.tid)
    || typeof claims.oid !== 'string' || !UUID.test(claims.oid)) return [];
  const tenantId = claims.tid.toLowerCase();
  if (claims.iss !== `https://login.microsoftonline.com/${tenantId}/v2.0`) return [];
  const issued = typeof claims.iat === 'number' && Number.isFinite(claims.iat) ? claims.iat * 1000 : 0;
  const expires = typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp * 1000 : 0;
  const groups = Array.isArray(claims.groups) && claims.groups.length <= 200
    && claims.groups.every((g) => typeof g === 'string' && UUID.test(g)) ? claims.groups as string[] : null;
  const overage = Boolean(claims.hasgroups || claims.groupOverage || (claims._claim_names as Claims | undefined)?.groups);
  return [{ issuer: claims.iss, tenantId, objectId: claims.oid,
    ...(typeof claims.aud === 'string' ? { audience: claims.aud } : {}), groups: groups?.map((g) => g.toLowerCase()) ?? [],
    observedAt: new Date(issued).toISOString(),
    complete: Boolean(groups && !overage && issued > 0 && issued <= now && now - issued <= 300_000 && expires > now) }];
}

/** Resolve one current actor. Neither arbitrary body values nor the shared service secret supply a user. */
export function createApplicationAuthorizationActorResolver(pool: Pool, options: ApplicationActorResolverOptions = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const snapshot = options.localSnapshot ?? ((sub: string) => getSessionSnapshot(pool, sub));
  const tenants = options.tenantIds ?? (async (sub: string, issuer: string) => {
    if (issuer !== LOCAL_AUTH_PRINCIPAL_ISSUER) return [];
    const result = await runWithSystemIdentity(() => pool.query<{ tenant_id: string }>(
      'SELECT tenant_id::text FROM oshal_tenant_memberships WHERE user_sub = $1', [sub],
    ));
    return result.rows.map((row) => row.tenant_id);
  });
  return async (req: Request): Promise<AuthorizationActor> => {
    const delegated = getVerifiedWorkloadDelegation(req);
    const sub = delegated?.sub ?? getCaller(req).sub;
    const issuer = delegated?.principal_iss ?? getAuthenticatedPrincipalIssuer(req);
    if (!sub || !issuer || issuer === GUEST_PRINCIPAL_ISSUER) {
      throw Object.assign(new Error('A verified user identity is required for application authorization'), { status: 401 });
    }
    const email = delegated ? null : getCaller(req).email;
    let isActive = true;
    if (issuer === LOCAL_AUTH_PRINCIPAL_ISSUER) isActive = (await snapshot(sub))?.status === 'active';
    if (issuer === MOCK_OIDC_PRINCIPAL_ISSUER && env.MOCK_OIDC !== 'true') isActive = false;
    const trustedAdminIssuers = new Set((env.OSHAL_AUTHORIZATION_ADMIN_ISSUERS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    trustedAdminIssuers.add(LOCAL_AUTH_PRINCIPAL_ISSUER);
    if (env.MOCK_OIDC === 'true') trustedAdminIssuers.add(MOCK_OIDC_PRINCIPAL_ISSUER);
    // External management adoption must name its issuer. Subject/email-only legacy roles cannot
    // become cross-provider privileges merely because a second provider was configured.
    const management = async () => {
      if (!trustedAdminIssuers.has(issuer)) return false;
      const subjects = new Set((env.OSHAL_OPERATOR_SUBS ?? '').split(',').map(value => value.trim()).filter(Boolean));
      const emails = new Set((env.OSHAL_OPERATOR_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
      if (subjects.has(sub) || ((issuer === LOCAL_AUTH_PRINCIPAL_ISSUER || issuer === MOCK_OIDC_PRINCIPAL_ISSUER)
        && email && emails.has(email.toLowerCase()))) return true;
      const role = await getRole(pool, sub); // Current rights, including revocations, on every invocation.
      return role?.role === 'root' || role?.role === 'admin';
    };
    const isSwarmAdmin = isActive && !delegated && (options.management
      ? await options.management(sub, issuer, email) : await management());
    const oidc = req.oidc as unknown as { idTokenClaims?: Claims } | undefined;
    return { sub, issuer, isActive, isSwarmAdmin, tenantIds: isActive ? await tenants(sub, issuer) : [],
      directory: delegated ? [] : directoryEvidence(getPreservedDirectoryClaims(req) ?? oidc?.idTokenClaims, now()),
      ...(delegated ? { allowedPermissions: delegated.scope.filter((scope) => scope.startsWith('app:')).map((scope) => scope.slice(4)) } : {}) };
  };
}
