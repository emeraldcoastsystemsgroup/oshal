/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Wire isolated package runs to fresh exact-principal authority and durable versioned evidence.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Share the same current-principal runner with local catalog schedules.
 */
import type { Request } from 'express';
import type { AppContext } from './app-context';
import { PackageTestSandbox, type AppAccessService, type SwarmAppService } from '@/features/swarm-apps';
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
    visibleApps: async req => (await runContext(req)).visibleApps,
    scheduleService: createTestLabScheduleWiring({ ctx, apps, runs: runService, ready, authorization,
      visible: actor => visibleCases(apps, access, authorization, actor) }) };
}
