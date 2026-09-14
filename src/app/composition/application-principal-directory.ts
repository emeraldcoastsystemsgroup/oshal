/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Observe verified sessions, retain explicit local links, and expose provider-aware management inventory.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Unite reviewed registrations and assignment targets with account inventory while preserving verified-only authority.
 */
import type { Request, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { PrincipalDirectoryStore, PrincipalRegistrationStore, requireRosterAdmin, historicalPrincipalReferences } from '@/features/principal-directory';
import { getSessionSnapshot, listUsers } from '@/features/local-auth';
import { getVerifiedWorkloadDelegation } from '@/features/security';
import type { AuthorizationActor, AuthorizationInventory } from '@/shared/application-authorization';
import { getAuthenticatedPrincipalIssuer, LOCAL_AUTH_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { getPreservedDirectoryClaims } from '@/shared/middleware/verified-directory-claims';
import { getCaller } from '@/shared/middleware/authz';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { createChildLogger } from '@/shared/logger';
import { configuredPrincipalOperator, principalLoginProviders } from '../middleware/principal-provider-policy';

const logger = createChildLogger({ module: 'application-principal-directory' });
type Claims = Readonly<Record<string, unknown>>;
function label(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 512 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}
/** @description Integrate exact observed identities with existing account stores, without granting or creating accounts.
 * @param pool Control-plane pool. @param ready Schema readiness. @param env Authentication configuration.
 * @returns Verified observer, current native identity resolver, target resolver and scoped inventory.
 */
export function createApplicationPrincipalDirectory(pool: Pool, ready: Promise<unknown>, env: NodeJS.ProcessEnv = process.env) {
  return new ApplicationPrincipalDirectory(pool,ready,env);
}
class ApplicationPrincipalDirectory {
  private readonly store: PrincipalDirectoryStore;
  readonly registrations: PrincipalRegistrationStore;
  private providerSignature = '';
  private configuredProviders: ReturnType<typeof principalLoginProviders> = new Map();
  constructor(private readonly pool: Pool,private readonly ready: Promise<unknown>,private readonly env: NodeJS.ProcessEnv) {
    this.store = new PrincipalDirectoryStore(pool);
    this.registrations = new PrincipalRegistrationStore(pool);
  }
  private providers() {
    const signature = JSON.stringify(['MOCK_OIDC','LOCAL_AUTH','ENTRA_LOCAL_AUTH_HYBRID','ENTRA_LOCAL_IDENTITY_BRIDGE',
      'OIDC_ISSUER_URL','OIDC_CLIENT_ID','OIDC_CLIENT_SECRET','KEYCLOAK_URL','KEYCLOAK_EXTERNAL_URL','KEYCLOAK_REALM',
      'KEYCLOAK_CLIENT_ID','KEYCLOAK_CLIENT_SECRET','GOOGLE_LOGIN','GOOGLE_OIDC_CLIENT_ID','GOOGLE_OIDC_CLIENT_SECRET',
      'MICROSOFT_LOGIN','MICROSOFT_TENANT_ID','MICROSOFT_OIDC_ISSUER_URL','MICROSOFT_OIDC_CLIENT_ID','MICROSOFT_OIDC_CLIENT_SECRET',
      'OUTLOOK_LOGIN','OUTLOOK_OIDC_CLIENT_ID','OUTLOOK_OIDC_CLIENT_SECRET'].map(key => this.env[key]));
    if (signature !== this.providerSignature) { this.configuredProviders = principalLoginProviders(this.env); this.providerSignature = signature; }
    return this.configuredProviders;
  }
  private hasTable = async (table: string): Promise<boolean> => runWithSystemIdentity(async () =>
    (await this.pool.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [table])).rows[0]?.present === true);

  observe = async (req: Request): Promise<void> => {
    if (!req.oidc?.isAuthenticated?.() || getVerifiedWorkloadDelegation(req)) return;
    const claims = getPreservedDirectoryClaims(req) ?? (req.oidc as unknown as { idTokenClaims?: Claims }).idTokenClaims;
    // Local/PAT/guest session shapes carry no cryptographically verified external protocol claims.
    if (!claims || typeof claims.iss !== 'string' || typeof claims.sub !== 'string') return;
    const provider = this.providers().get(claims.iss);
    if (!provider) return;
    // Authentication middleware validates the current app session. Its original ID token can
    // expire before that session; observing identity must not shorten the established login.
    if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || claims.iat <= 0
      || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= claims.iat) throw new Error('Verified principal protocol evidence is invalid');
    const currentIssuer = getAuthenticatedPrincipalIssuer(req); const currentSub = getCaller(req).sub;
    let canonicalLocalSub: string | null = null;
    await this.ready;
    if (currentIssuer === LOCAL_AUTH_PRINCIPAL_ISSUER) {
      if (!currentSub || !getPreservedDirectoryClaims(req) || !await this.hasTable('oshal_external_identity_links')) throw new Error('Verified canonical link unavailable');
      const linked = await runWithSystemIdentity(() => this.pool.query(`SELECT l.local_user_sub FROM oshal_external_identity_links l
        JOIN oshal_local_users u ON u.user_sub=l.local_user_sub
        WHERE l.issuer=$1 AND l.external_sub=$2 AND l.entra_tenant_id=$3 AND l.entra_object_id=$4
          AND l.local_user_sub=$5 AND u.status='active'`, [claims.iss,claims.sub,claims.tid,claims.oid,currentSub]));
      if (linked.rows.length !== 1) throw new Error('Verified canonical link does not match existing account');
      canonicalLocalSub = currentSub;
    } else if (currentIssuer !== claims.iss || currentSub !== claims.sub) throw new Error('Verified principal identity mismatch');
    const email = label(claims.email) ?? label(claims.preferred_username);
    await this.store.observe({ issuer: claims.iss, sub: claims.sub, provider: provider.name, email,
      emailVerified: Boolean(label(claims.email) && claims.email_verified === true), displayName: label(claims.name), canonicalLocalSub });
  };
  observePrincipal: RequestHandler = async (req, res, next) => {
    try { await this.observe(req); next(); }
    catch (error) { logger.warn({ err: error }, 'Verified principal observation unavailable'); res.status(503).json({ error: 'principal_directory_unavailable' }); }
  };
  nativePrincipal = async (sub: string, issuer: string): Promise<{ isActive: boolean; isSwarmAdmin: boolean }> => {
    await this.ready; const row = await this.store.get(issuer,sub); const enabled = this.providers();
    const isActive = Boolean(row && !row.canonicalLocalSub && row.status === 'active' && enabled.has(issuer));
    return { isActive, isSwarmAdmin: Boolean(isActive && row && configuredPrincipalOperator(row,enabled,this.env)) };
  };
  targetActor = async (sub: string, issuer: string): Promise<AuthorizationActor | null> => {
    if (issuer === LOCAL_AUTH_PRINCIPAL_ISSUER) {
      if (!await this.hasTable('oshal_local_users')) return null;
      const account = await getSessionSnapshot(this.pool,sub);
      return account ? { sub,issuer,isActive: account.status === 'active',isSwarmAdmin: false,directory: [] } : null;
    }
    await this.ready; const row = await this.store.get(issuer,sub); if (!row) return null;
    return { sub,issuer,...await this.nativePrincipal(sub,issuer),isSwarmAdmin: false,directory: [] };
  };
  inventory = async (actor: AuthorizationActor): Promise<AuthorizationInventory> => {
    if (!actor.isActive || !actor.isSwarmAdmin) return { users: [], groups: [] };
    await this.ready;
    const [native, locals, registered] = await Promise.all([this.store.list(), this.hasTable('oshal_local_users').then(exists =>
      exists ? runWithSystemIdentity(() => listUsers(this.pool)) : []), this.registrations.list()]);
    const enabled = this.providers();
    const users = locals.map(user => {
      const linked = native.filter(row => row.canonicalLocalSub === user.userSub).map(row => row.provider);
      return { sub: user.userSub, issuer: LOCAL_AUTH_PRINCIPAL_ISSUER,
        label: `${user.displayName || user.email} (local${linked.length ? `; ${[...new Set(linked)].join(', ')} linked` : ''}; ${user.status})` };
    });
    for (const row of native.filter(item => !item.canonicalLocalSub)) users.push({ sub: row.sub,issuer: row.issuer,
      label: `${row.displayName || row.email || row.sub} (${row.provider}; ${enabled.has(row.issuer) ? row.status : 'provider disabled'})` });
    for (const row of registered) {
      if (native.some(item => item.issuer === row.issuer && item.sub === row.sub)) continue;
      users.push({ sub: row.sub, issuer: row.issuer, label: `${row.displayName} (registered; awaiting verified sign-in)` });
    }
    return { users, groups: (actor.directory ?? []).filter(evidence => evidence.complete).flatMap(evidence => evidence.groups.map(id => ({
      issuer: evidence.issuer,tenantId: evidence.tenantId,id,label: id,
    }))) };
  };
  roster = async (actor: AuthorizationActor, assignmentUsers: AuthorizationInventory['users'] = []) => {
    requireRosterAdmin(actor); await this.ready;
    const [inventory, native, registered, historical, revision] = await Promise.all([
      this.inventory(actor), this.store.list(), this.registrations.list(), historicalPrincipalReferences(this.pool), this.registrations.revision(),
    ]);
    const known = new Map([...assignmentUsers, ...inventory.users].map(user => [JSON.stringify([user.issuer, user.sub]), user]));
    const users = [...known.values()].map(user => {
      const observed = native.find(row => row.issuer === user.issuer && row.sub === user.sub);
      const registration = registered.find(row => row.issuer === user.issuer && row.sub === user.sub);
      const local = user.issuer === LOCAL_AUTH_PRINCIPAL_ISSUER && inventory.users.some(item => item.issuer === user.issuer && item.sub === user.sub);
      return { ...user, source: local ? 'local-account' : observed ? 'verified-sign-in' : registration?.source ?? 'access-assignment',
        signIn: local ? 'local-account' : !this.providers().has(user.issuer) ? 'provider-disabled'
          : observed ? observed.status : 'awaiting-sign-in', lastSeenAt: observed?.lastSeenAt ?? null };
    });
    return { revision, users, historical, providers: [...this.providers()].map(([issuer, provider]) => ({ issuer, name: provider.name })),
      explanation: 'Registered identities and historical references do not grant sign-in, ownership or application access.' };
  };
}
