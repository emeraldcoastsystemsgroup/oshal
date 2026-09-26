/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Compose durable policy, current principal resolution, execution guards and registered management tools.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Adopt existing local and verified provider accounts without conflating subjects or granting new operator roles.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Compose durable remote execution and scoped result authority behind schema readiness.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Compose reviewed roster registration, delegated management and exact external business memberships.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | ADR-157: compose the scheduled-service activation authority beside the policy it reads, and refresh an application service principal to itself — it has no account or session to revalidate, and its liveness is the activation row the runner re-resolves on every tick.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Make schema readiness re-requestable and sequence its DDL. One eagerly created promise cached its own rejection for the life of the process, so a bootstrap that lost the boot-time pool race made every later authorization operation refuse forever while the controller still reported healthy.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Supply the installed-package reader the package grant plan needs. The policy slice may not import the application registry directly (layer direction), so composition reads the record here and hands over ONLY the declared dependency tiers and whether the record is active - no manifest, no owner, no business data.
 * 8 | maintainer@emeraldcoastsystemsgroup.com | Give the RETURNED readiness the same re-requestable shape. It was a plain promise derived once from the recovered thunk, so the four modules chaining off it - queued ticket provenance, the user directory, Jarvis briefings and Test Lab runs - still inherited the first bootstrap failure forever, and authenticated ticket creation threw for the life of the process.
 * 9 | maintainer@emeraldcoastsystemsgroup.com | Resolve a legacy explicit tier on the full principal while retaining the canonical-local meaning of issuer-less assignments.
 */
/** Assemble the control plane without granting it authority over business records. */
import type { Request } from 'express';
import type { AppContext } from './app-context';
import { ApplicationAuthorizationRuntime, applicationAuthorizationMode } from './application-authorization-runtime';
import { readApplicationExecutionOwnership } from '../application-execution-ownership';
import { AuthorizationToolRuntime, registerAuthorizationTools } from './authorization-tool';
import { createApplicationAuthorizationActorResolver } from '../middleware/application-authorization-identity';
import { createLegacyTierResolver } from './application-access-tier';
import { ApplicationAuthorizationService, PostgresAuthorizationStore, ensureApplicationAuthorizationSchema } from '@/features/application-authorization';
import type { AuthorizationActor, AuthorizationStore, ApplicationAuthorizationServiceOptions } from '@/features/application-authorization';
import { getSessionSnapshot } from '@/features/local-auth';
import { ensurePrincipalDirectorySchema, ensurePrincipalRegistrationSchema } from '@/features/principal-directory';
import { ExternalTenantMembershipService, PostgresExternalTenantMembershipStore, ensureExternalTenantMembershipSchema } from '@/features/external-tenant-memberships';
import { createApplicationPrincipalDirectory } from './application-principal-directory';
import type { AppAccessService, SwarmAppService } from '@/features/swarm-apps';
import { LOCAL_AUTH_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { inspectAppDependencies } from '@/shared/app-dependencies';
import { createRetryableReady } from '@/shared/services/database';
import { createChildLogger } from '@/shared/logger';
import { configureApplicationExecutionPolicy } from '@/shared/application-authorization-execution';
import { ensureRemoteExecutionSchema } from '@/features/application-remote-execution';
import { createApplicationRemoteExecutionWiring } from './application-remote-execution-wiring';
import { createApplicationServiceActivationWiring } from '../application-service-activation-wiring';
import { APPLICATION_SERVICE_PRINCIPAL_ISSUER } from '@/features/application-authorization';

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
      // ADR-157: an application service principal is minted by the kernel on activation, not by a
      // login. There is no account or session to revalidate, and it never holds swarm administration
      // or management scopes; what keeps it live is the activation row, which the runner re-resolves
      // on every tick and which authorize() still evaluates against current assignments.
      if (original.issuer === APPLICATION_SERVICE_PRINCIPAL_ISSUER) {
        return { ...original, isSwarmAdmin: false, managementScopes: [] };
      }
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

function createPolicyOptions(appAccess: AppAccessService, getApps: () => SwarmAppService,
  actors: ReturnType<typeof createActorPorts>): ApplicationAuthorizationServiceOptions {
  return { refreshActor: actors.refreshActor, resolveActor: actors.targetActor,
    // The legacy ADR-118 ceiling is resolved on the FULL principal. This used to refuse any
    // issuer but urn:oshal:local-auth BEFORE reading an assignment, because an old row carried
    // no issuer and could only belong to a local account — but refusing early also made an
    // assignment deliberately written for a federated identity unreadable, so every
    // OIDC-signed-in user resolved deny everywhere and a catalog-less application then answered
    // them authorization_app_admin_required. The legacy rule now lives in the query predicate.
    resolveTier: createLegacyTierResolver(appAccess, getApps),
    inventory: actors.inventory,
    // Declared dependency tiers only. inspectAppDependencies is the lenient reader: an already
    // loaded record with a malformed block contributes an EMPTY required set rather than making
    // the whole plan unreadable, which is the same posture the group resolver takes.
    resolvePackage: async app => {
      const record = await getApps().getApp(app);
      if (!record) return null;
      const tiers = inspectAppDependencies(record.manifest);
      return { required: tiers.required, optional: { apps: tiers.optional.apps } };
    },
  };
}

/** @description Await schema readiness before any policy store operation. @param ctx Core services. @param ready Re-requestable schema initialization. @returns Durable store ports. */
function readyPolicyStore(ctx: AppContext, ready: () => Promise<unknown>): AuthorizationStore {
  const durable = new PostgresAuthorizationStore(ctx.pool);
  return {
    readPreview: async id => { await ready(); return durable.readPreview(id); },
    readAudit: async input => { await ready(); return durable.readAudit(input); },
    publishAppPosture: async (app, protectedApp, agentIds, toolNames) => { await ready(); return durable.publishAppPosture(app, protectedApp, agentIds, toolNames); },
    read: async () => { await ready(); return durable.read(); },
    transaction: async operation => { await ready(); return durable.transaction(operation); },
  };
}

/** @description Bring every authorization schema up one at a time.
 * Four of these ran together inside one `Promise.all`. Each takes a transaction-scoped advisory
 * lock and holds a pool client for its whole DDL transaction, so a controller loading its
 * manifests against a pool of 8 was asked for four more clients at the worst moment and could
 * lose the acquire. The four are order-independent, so sequencing them costs a little boot
 * latency and cuts concurrent client demand from four to one. External memberships stay last:
 * that schema references the tenant and authorization tables the earlier statements require.
 * @param pool Control-plane pool. @param bootstrap Core schema readiness. @returns Completion once every schema is present.
 */
async function bootstrapAuthorizationSchemas(pool: AppContext['pool'], bootstrap: Promise<unknown>): Promise<void> {
  await bootstrap;
  await ensureApplicationAuthorizationSchema(pool);
  await ensurePrincipalDirectorySchema(pool);
  await ensurePrincipalRegistrationSchema(pool);
  await ensureRemoteExecutionSchema(pool);
  await ensureExternalTenantMembershipSchema(pool);
}

/** @description Hand out schema readiness that a later caller can ask for again.
 * A single eagerly created promise kept its own rejection: one lost pool acquire at boot made
 * every authorization operation await the same dead promise for the life of the process, and the
 * only tell was one log line. Dropping the memo on failure is the shape already used by the Entra
 * local identity bridge and the ops pipeline routes — the next caller starts a fresh attempt while
 * concurrent callers still share one in-flight bootstrap.
 * @param ctx Core services. @param bootstrap Core schema readiness. @returns Re-requestable readiness.
 */
function createSchemaReady(ctx: AppContext, bootstrap: Promise<unknown>): () => Promise<unknown> {
  return createRetryableReady(() => bootstrapAuthorizationSchemas(ctx.pool, bootstrap));
}

/** @description Wire one durable authority into UI, tools and package execution.
 * @param ctx Core services. @param appAccess Legacy explicit ceilings.
 * @param getApps Lazy application registry. @param bootstrap Core schema readiness.
 * @returns Registered runtime, service and request adapters.
 */
export function createApplicationAuthorizationWiring(ctx: AppContext, appAccess: AppAccessService,
  getApps: () => SwarmAppService, bootstrap: Promise<unknown>) {
  const ready = createSchemaReady(ctx, bootstrap);
  // Observe the first attempt immediately. A failure refuses the operations waiting on it, but is
  // not kept: the next authorization operation asks again and retries the bootstrap.
  void ready().catch(error => logger.error({ err: error },
    'Application authorization unavailable; the next authorization operation retries the schema bootstrap'));
  const store = readyPolicyStore(ctx, ready);
  const directory = createApplicationPrincipalDirectory(ctx.pool,ready);
  const membershipStore = new PostgresExternalTenantMembershipStore(ctx.pool, ready);
  const actors = createActorPorts(ctx,directory,membershipStore);
  const memberships = new ExternalTenantMembershipService(membershipStore, { refreshActor: actors.refreshActor, resolveTarget: directory.targetActor });
  const { resolveActor } = actors;
  const service = new ApplicationAuthorizationService(store, createPolicyOptions(appAccess, getApps, actors));
  const runtime = new ApplicationAuthorizationRuntime(service, resolveActor, process.env, name => getApps().getApp(name), actors.targetActor);
  const remoteExecution = createApplicationRemoteExecutionWiring(ctx.pool, ready, runtime, actors.refreshActor);
  const isProtected = async (app: string) => {
    await ready();
    return (await readApplicationExecutionOwnership(ctx.pool, { kind: 'tools', id: app, app, mode: applicationAuthorizationMode() }))?.protected
      || runtime.protectedApp(app);
  };
  configureApplicationExecutionPolicy({
    owner: async (kind, id) => {
      await ready();
      return (await readApplicationExecutionOwnership(ctx.pool, { kind, id, mode: applicationAuthorizationMode() }))?.app
        ?? runtime.owner(kind, id);
    },
    protectedApp: isProtected,
    authorize: (actor, operation) => runtime.authorize(actor, operation),
  });
  createApplicationServiceActivationWiring({
    pool: ctx.pool, ready, policy: store, getApps,
    describeApp: app => {
      const summary = service.getApp(app);
      return summary ? { source: summary.source, catalogRevision: summary.catalogRevision, catalog: summary.catalog } : null;
    },
    authorize: (actor, operation) => runtime.authorize(actor, operation),
    resolveActor: (req: Request) => resolveActor(req),
  });
  const authorizationTool = new AuthorizationToolRuntime(service);
  ctx.applicationAuthorization = runtime;
  ctx.authorizationTool = authorizationTool;
  // The readiness this wiring HANDS OUT, not the one it awaits internally. Derived once with
  // `.then()`, it kept the first bootstrap failure even after the thunk above had recovered, and
  // every module chaining off it stayed dead - including the queued-principal capture that
  // authenticated ticket creation performs on every ticket. Registration is idempotent (it seeds
  // code-owned tool metadata and re-registers fixed executors on each startup), so a retry after a
  // failed attempt repeats it safely.
  const registered = createRetryableReady(async () => {
    await ready();
    await registerAuthorizationTools(ctx.toolRegistryService, ctx.dynamicToolExecutorRegistry, service);
  });
  void registered().catch(error => logger.error({ err: error },
    'Authorization tool registration failed; the next consumer of authorization readiness retries it'));
  return { service, runtime, remoteExecution, directory: { registrations: directory.registrations, roster: directory.roster }, memberships,
    refreshActor: actors.refreshActor, authorizationTool, isProtected, observePrincipal: directory.observePrincipal,
    resolveActor: (req: Request) => resolveActor(req), targetActor: actors.targetActor, ready: registered };
}
