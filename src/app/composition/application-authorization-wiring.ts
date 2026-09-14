/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Compose durable policy, current principal resolution, execution guards and registered management tools.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Adopt existing local and verified provider accounts without conflating subjects or granting new operator roles.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Compose durable remote execution and scoped result authority behind schema readiness.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Compose reviewed roster registration, delegated management and exact external business memberships.
 */
/** Assemble the control plane without granting it authority over business records. */
import type { Request } from 'express';
import type { AppContext } from './app-context';
import { ApplicationAuthorizationRuntime, applicationAuthorizationMode } from './application-authorization-runtime';
import { readApplicationExecutionOwnership } from '../application-execution-ownership';
import { AuthorizationToolRuntime, registerAuthorizationTools } from './authorization-tool';
import { createApplicationAuthorizationActorResolver } from '../middleware/application-authorization-identity';
import { ApplicationAuthorizationService, PostgresAuthorizationStore, ensureApplicationAuthorizationSchema } from '@/features/application-authorization';
import type { AuthorizationActor, AuthorizationStore, ApplicationAuthorizationServiceOptions } from '@/features/application-authorization';
import { getSessionSnapshot } from '@/features/local-auth';
import { ensurePrincipalDirectorySchema, ensurePrincipalRegistrationSchema } from '@/features/principal-directory';
import { ExternalTenantMembershipService, PostgresExternalTenantMembershipStore, ensureExternalTenantMembershipSchema } from '@/features/external-tenant-memberships';
import { createApplicationPrincipalDirectory } from './application-principal-directory';
import type { AppAccessService, SwarmAppService } from '@/features/swarm-apps';
import { LOCAL_AUTH_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { createChildLogger } from '@/shared/logger';
import { configureApplicationExecutionPolicy } from '@/shared/application-authorization-execution';
import { ensureRemoteExecutionSchema } from '@/features/application-remote-execution';
import { createApplicationRemoteExecutionWiring } from './application-remote-execution-wiring';

const logger = createChildLogger({ module: 'application-authorization-wiring' });
function createActorPorts(ctx: AppContext, directory: ReturnType<typeof createApplicationPrincipalDirectory>, memberships: PostgresExternalTenantMembershipStore) {
  const tenants = async (sub: string, issuer = LOCAL_AUTH_PRINCIPAL_ISSUER) => issuer !== LOCAL_AUTH_PRINCIPAL_ISSUER ? memberships.tenantIds(sub, issuer) : runWithSystemIdentity(async () => (await ctx.pool.query<{ tenant_id: string }>(
    'SELECT tenant_id::text FROM oshal_tenant_memberships WHERE user_sub=$1', [sub],
  )).rows.map(row => row.tenant_id));
  const resolveActor = createApplicationAuthorizationActorResolver(ctx.pool, { tenantIds: tenants, nativePrincipal: directory.nativePrincipal });
  const targetActor = async (sub: string, issuer: string): Promise<AuthorizationActor | null> => {
    const account = await directory.targetActor(sub,issuer);
    return account ? { ...account, tenantIds: account.isActive ? await tenants(sub,issuer) : [] } : null;
  };
  const refreshActor = async (original: AuthorizationActor) => {
      const account = original.issuer === LOCAL_AUTH_PRINCIPAL_ISSUER ? await getSessionSnapshot(ctx.pool, original.sub) : null;
      if (original.issuer === LOCAL_AUTH_PRINCIPAL_ISSUER && account?.status !== 'active') return null;
      // Recheck account, tenant and administration stores for an already authenticated identity.
      // No client can call this callback or supply its principal fields.
      const current = await resolveActor({ oidc: { isAuthenticated: () => original.isActive,
        user: { sub: original.sub, iss: original.issuer, email: account?.email } }, headers: {} } as unknown as Request);
      return { ...current, directory: original.directory, allowedPermissions: original.allowedPermissions,
        isSwarmAdmin: current.isSwarmAdmin && original.isSwarmAdmin };
    };
  return { resolveActor, targetActor, refreshActor, inventory: directory.inventory };
}

function createPolicyOptions(ctx: AppContext, appAccess: AppAccessService, getApps: () => SwarmAppService,
  actors: ReturnType<typeof createActorPorts>): ApplicationAuthorizationServiceOptions {
  return { refreshActor: actors.refreshActor, resolveActor: actors.targetActor,
    resolveTier: async (app, actor) => {
      const record = await getApps().getApp(app);
      // Old rows have no issuer column. They belong only to canonical local accounts.
      if (actor.issuer !== LOCAL_AUTH_PRINCIPAL_ISSUER) return { tier: 'deny', explicit: false };
      const access = await runWithSystemIdentity(() => appAccess.resolve(app, actor.sub, record?.manifest.access ?? {
        supported: ['deny', 'viewer', 'editor', 'admin'], defaultTier: 'deny',
      }));
      return { tier: access.tier, explicit: access.source !== 'default' };
    },
    inventory: actors.inventory,
  };
}

/** @description Await schema readiness before any policy store operation. @param ctx Core services. @param ready Schema initialization. @returns Durable store ports. */
function readyPolicyStore(ctx: AppContext, ready: Promise<unknown>): AuthorizationStore {
  const durable = new PostgresAuthorizationStore(ctx.pool);
  return {
    readPreview: async id => { await ready; return durable.readPreview(id); },
    readAudit: async input => { await ready; return durable.readAudit(input); },
    publishAppPosture: async (app, protectedApp, agentIds, toolNames) => { await ready; return durable.publishAppPosture(app, protectedApp, agentIds, toolNames); },
    read: async () => { await ready; return durable.read(); },
    transaction: async operation => { await ready; return durable.transaction(operation); },
  };
}

/** @description Wire one durable authority into UI, tools and package execution.
 * @param ctx Core services. @param appAccess Legacy explicit ceilings.
 * @param getApps Lazy application registry. @param bootstrap Core schema readiness.
 * @returns Registered runtime, service and request adapters.
 */
export function createApplicationAuthorizationWiring(ctx: AppContext, appAccess: AppAccessService,
  getApps: () => SwarmAppService, bootstrap: Promise<unknown>) {
  const policyReady = bootstrap.then(() => Promise.all([ensureApplicationAuthorizationSchema(ctx.pool), ensurePrincipalDirectorySchema(ctx.pool),
    ensurePrincipalRegistrationSchema(ctx.pool), ensureRemoteExecutionSchema(ctx.pool)]));
  const ready = policyReady.then(() => ensureExternalTenantMembershipSchema(ctx.pool));
  // Observe rejection immediately; each operation still waits and refuses on the same failure.
  void ready.catch(error => logger.error({ err: error }, 'Application authorization unavailable'));
  const store = readyPolicyStore(ctx, ready);
  const directory = createApplicationPrincipalDirectory(ctx.pool,ready);
  const membershipStore = new PostgresExternalTenantMembershipStore(ctx.pool, ready);
  const actors = createActorPorts(ctx,directory,membershipStore);
  const memberships = new ExternalTenantMembershipService(membershipStore, { refreshActor: actors.refreshActor, resolveTarget: directory.targetActor });
  const { resolveActor } = actors;
  const service = new ApplicationAuthorizationService(store, createPolicyOptions(ctx, appAccess, getApps, actors));
  const runtime = new ApplicationAuthorizationRuntime(service, resolveActor, process.env, name => getApps().getApp(name));
  const remoteExecution = createApplicationRemoteExecutionWiring(ctx.pool, ready, runtime, actors.refreshActor);
  const isProtected = async (app: string) => {
    await ready;
    return (await readApplicationExecutionOwnership(ctx.pool, { kind: 'tools', id: app, app, mode: applicationAuthorizationMode() }))?.protected
      || runtime.protectedApp(app);
  };
  configureApplicationExecutionPolicy({
    owner: async (kind, id) => {
      await ready;
      return (await readApplicationExecutionOwnership(ctx.pool, { kind, id, mode: applicationAuthorizationMode() }))?.app
        ?? runtime.owner(kind, id);
    },
    protectedApp: isProtected,
    authorize: (actor, operation) => runtime.authorize(actor, operation),
  });
  const authorizationTool = new AuthorizationToolRuntime(service);
  ctx.applicationAuthorization = runtime;
  ctx.authorizationTool = authorizationTool;
  const registered = ready.then(() => registerAuthorizationTools(ctx.toolRegistryService, ctx.dynamicToolExecutorRegistry, service));
  void registered.catch(error => logger.error({ err: error }, 'Authorization tool registration failed'));
  return { service, runtime, remoteExecution, directory: { registrations: directory.registrations, roster: directory.roster }, memberships,
    refreshActor: actors.refreshActor, authorizationTool, isProtected, observePrincipal: directory.observePrincipal,
    resolveActor: (req: Request) => resolveActor(req), targetActor: actors.targetActor, ready: registered };
}
