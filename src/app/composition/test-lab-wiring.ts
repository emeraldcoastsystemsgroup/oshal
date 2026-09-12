/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Wire isolated package runs to fresh exact-principal authority and durable versioned evidence.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Share the same current-principal runner with local catalog schedules.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Keep a verified operator session inside a request-bound local read-only service-smoke transport so application authorization sees the real caller.
 */
import type { Request } from 'express';
import type { AppContext } from './app-context';
import { PackageTestSandbox, type AppAccessService, type SwarmAppService, type AppSmokeVerificationOptions } from '@/features/swarm-apps';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { isOperator } from '@/shared/middleware/authz';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { TestLabRunService } from '../routes/test-lab-run-service';
import { PostgresTestLabRunStore } from '../routes/test-lab-run-store';
import { ensureTestLabRunSchema } from '../routes/test-lab-run-schema';
import type { TestLabRouteOptions } from '../routes/test-lab-routes';
import { createTestLabScheduleWiring, type TestLabScheduledActorPorts } from './test-lab-schedule-wiring';

interface AuthorizationPorts extends TestLabScheduledActorPorts {
  ready: Promise<unknown>;
  resolveActor(req: Request): Promise<AuthorizationActor>;
  runtime: { protectedApp(name: string): boolean; canDiscover(name: string, actor: AuthorizationActor): Promise<boolean> };
}

/** @description Bind a real operator session to local service-smoke HTTP without exporting credentials.
 * @param req Verified original request. @param resolveActor Current exact-principal authority.
 * @param apiBaseUrl Controller-owned loopback origin, never a request header or manifest destination.
 * @param smokePath Exact selected catalog path, independently validated by the installed manifest loader.
 * @returns A restricted fetch callback, or undefined when no eligible cookie-only operator session exists.
 */
export async function createServiceSmokeFetch(req: Request, resolveActor: AuthorizationPorts['resolveActor'], apiBaseUrl: string, smokePath: string):
Promise<AppSmokeVerificationOptions['serviceSmokeFetch']> {
  const cookie = req.headers.cookie;
  if (!cookie || req.headers.authorization || !req.oidc?.isAuthenticated()) return undefined;
  const actor = await resolveActor(req);
  if (!actor.isActive || !actor.isSwarmAdmin) return undefined;
  const origin = new URL(apiBaseUrl);
  const allowed = new URL(smokePath, origin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password
    || allowed.origin !== origin.origin || allowed.username || allowed.password || allowed.hash) {
    throw new Error('Service smoke transport requires the configured loopback origin.');
  }
  return async (input, init) => {
    const target = new URL(input);
    if (target.href !== allowed.href || target.username || target.password || !['GET', 'HEAD'].includes(init.method)) {
      throw new Error('Service smoke request is outside the approved local read boundary.');
    }
    const current = await resolveActor(req);
    if (!current.isActive || !current.isSwarmAdmin || current.issuer !== actor.issuer || current.sub !== actor.sub) {
      throw new Error('Current service smoke authority is unavailable.');
    }
    return globalThis.fetch(target, { ...init, headers: { ...init.headers, cookie }, redirect: 'manual' });
  };
}

/** @description Recompute installed package visibility from current app and authorization policy. */
async function visibleCases(apps: SwarmAppService, access: AppAccessService, authorization: AuthorizationPorts, actor: AuthorizationActor) {
  const result = new Map<string, string>();
  if (!actor.isActive) return result;
  const visible = new Set((await apps.listApps('active', { ownerSub: actor.sub, isOperator: actor.isSwarmAdmin })).map(record => record.name));
  for (const manifest of await apps.getActiveManifests()) {
    if (!visible.has(manifest.name)) continue;
    if (manifest.access && (await access.resolve(manifest.name, actor.sub, manifest.access)).tier === 'deny') continue;
    if (authorization.runtime.protectedApp(manifest.name) && !await authorization.runtime.canDiscover(manifest.name, actor)) continue;
    result.set(manifest.name, manifest.displayName || manifest.name);
  }
  return result;
}

/** @description Share fresh policy across start, cancellation, history reads and in-flight execution checks. */
export function createTestLabWiring(ctx: AppContext, apps: SwarmAppService, access: AppAccessService, authorization: AuthorizationPorts): TestLabRouteOptions {
  const ready = authorization.ready.then(() => runWithSystemIdentity(() => ensureTestLabRunSchema(ctx.pool)));
  // Store operations await readiness; retain a rejection handler before the first browser request.
  void ready.catch(() => undefined);
  const executionAuth = (req: Request) => ({ serviceSecret: isOperator(req) ? process.env.SWARM_SERVICE_SECRET : undefined,
    authorization: req.headers.authorization, canRunSuites: isOperator(req) });
  const runContext = async (req: Request) => {
    const actor = await authorization.resolveActor(req);
    if (!actor.isActive) throw Object.assign(new Error('An active verified identity is required.'), { status: 401 });
    return { actor: { issuer: actor.issuer, sub: actor.sub }, visibleApps: await visibleCases(apps, access, authorization, actor),
      auth: { ...executionAuth(req), canRunSuites: actor.isSwarmAdmin } };
  };
  const runService = new TestLabRunService(new PostgresTestLabRunStore(ctx.pool, ready,
    async ids => (await Promise.all(ids.map(id => new PackageTestSandbox().cleanupExecution(id)))).every(Boolean)), apps.testLabCatalog);
  return { installedTests: apps.testLabCatalog, executionAuth, runContext, runService,
    serviceSmokeFetch: (req, test) => createServiceSmokeFetch(req, authorization.resolveActor,
      `http://127.0.0.1:${process.env.PORT || '5000'}`, test.path),
    visibleApps: async req => (await runContext(req)).visibleApps,
    scheduleService: createTestLabScheduleWiring({ ctx, apps, runs: runService, ready, authorization,
      visible: actor => visibleCases(apps, access, authorization, actor) }) };
}
