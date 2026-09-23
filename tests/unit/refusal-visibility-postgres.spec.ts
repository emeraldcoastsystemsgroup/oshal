/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | Drive a real refused scheduled dispatch through the production chokepoint into PostgreSQL, then prove owner isolation, operator visibility and the authenticated HTTP read under a NOSUPERUSER NOBYPASSRLS role.
 */

import { createServer, type Server } from 'node:http';
import express, { type RequestHandler } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runActivatedServiceTick, setManifestServiceActivationRuntime } from '@/app/manifest-service-route-activation';
import { createRefusalRoutes } from '@/app/routes/refusal-routes';
import {
  APPLICATION_SERVICE_PRINCIPAL_ISSUER,
  applicationServicePrincipalSub,
  type ApplicationServiceActivation,
} from '@/features/application-authorization';
import { PostgresRefusalStore } from '@/features/refusal-visibility';
import { configureApplicationExecutionPolicy } from '@/shared/application-authorization-execution';
import { configureRefusalRecorder } from '@/shared/refusal-events';
import { wrapPoolWithGuc } from '@/shared/services/database';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const ROLE = 'refusal_runtime';
const APP = 'metrics-app';
const SCHEDULE = `${APP}-daily-ingest`;
const SERVICE_SUB = applicationServicePrincipalSub(APP);
const OTHER_SUB = 'auth0|other';

const fixture = new DisposablePostgres({
  purpose: 'refusal-visibility',
  migrations: ['155-refusal-ledger.sql'],
  roles: [ROLE],
});

let store: PostgresRefusalStore;
let baseUrl = '';
let server: Server;
let suspended: { id: string; reason: string } | undefined;

const activation: ApplicationServiceActivation = {
  id: 'activation-refusal-fixture',
  app: APP,
  scheduleId: SCHEDULE,
  runsAs: 'system',
  requires: ['metrics.write'],
  catalogRevision: 'fixture-rev-1',
  activatedBySub: 'auth0|operator',
  activatedByIssuer: 'https://identity.fixture.test',
  activatedAt: '2026-09-23T20:00:00.000Z',
};

/** Auth gate used by this isolated HTTP server. */
const requiresAuth: RequestHandler = (req, res, next) => {
  if (!req.header('x-test-sub')) {
    res.status(401).json({ error: 'authentication_required' });
    return;
  }
  next();
};

/** Call the real route as one test principal. */
async function readHttp(sub?: string, operator = false, query = ''): Promise<{ status: number; body: any; cache: string | null }> {
  const response = await fetch(`${baseUrl}/api/ops/refusals${query}`, {
    headers: sub ? { 'x-test-sub': sub, 'x-test-operator': operator ? 'on' : 'off' } : {},
  });
  return {
    status: response.status,
    body: await response.json(),
    cache: response.headers.get('cache-control'),
  };
}

beforeAll(async () => {
  vi.stubEnv('OSHAL_DB_GUC_STRICT', 'deny');
  await fixture.start();
  await fixture.pool.query(`GRANT SELECT, INSERT ON oshal_refusals TO ${ROLE}`);

  const role = await fixture.rolePool(ROLE).query(
    `SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
  );
  expect(role.rows[0]).toMatchObject({ current_user: ROLE, rolsuper: false, rolbypassrls: false });

  const runtimePool = wrapPoolWithGuc(fixture.rolePool(ROLE));
  store = new PostgresRefusalStore(runtimePool);
  configureRefusalRecorder(store);
  setManifestServiceActivationRuntime({
    resolveDispatch: async () => activation,
    suspend: async (row, reason) => { suspended = { id: row.id, reason }; },
  });
  configureApplicationExecutionPolicy({
    owner: async () => APP,
    protectedApp: async () => true,
    authorize: async () => ({
      allowed: false,
      reason: 'authorization_permission_denied',
      decisionId: 'decision-refusal-fixture',
      revision: 2,
      app: APP,
      grants: [],
    }),
  });

  const app = express();
  app.use((req, _res, next) => {
    const sub = req.header('x-test-sub') ?? null;
    return runWithRequestIdentity({
      sub,
      principalIssuer: sub ? 'https://identity.fixture.test' : null,
      isOperator: req.header('x-test-operator') === 'on',
    }, () => next());
  });
  app.use('/api/ops/refusals', createRefusalRoutes(store, requiresAuth));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('refusal route fixture did not bind TCP');
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
  configureRefusalRecorder(undefined);
  configureApplicationExecutionPolicy(undefined);
  setManifestServiceActivationRuntime(undefined);
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await fixture.stop();
  vi.unstubAllEnvs();
}, 120_000);

describe('P1 refusal visibility — real dispatch, real store, enforced role', () => {
  it('lands the denied schedule with actor, package, target and prepared execution id', async () => {
    const execute = vi.fn(async () => 'must-not-run');
    const result = await runActivatedServiceTick(
      { app: APP, scheduleId: SCHEDULE, ownerSub: null },
      execute,
    );

    expect(result).toEqual({ ran: false, reason: 'denied', detail: 'authorization_permission_denied' });
    expect(execute).not.toHaveBeenCalled();
    expect(suspended).toEqual({ id: activation.id, reason: 'authorization_permission_denied' });

    const landed = await fixture.pool.query('SELECT * FROM oshal_refusals');
    expect(landed.rows).toHaveLength(1);
    expect(landed.rows[0]).toMatchObject({
      code: 'authorization_permission_denied',
      owner_sub: SERVICE_SUB,
      actor_sub: SERVICE_SUB,
      actor_issuer: APPLICATION_SERVICE_PRINCIPAL_ISSUER,
      owning_package: APP,
      target_kind: 'job',
      target: SCHEDULE,
      prepared_execution_id: activation.id,
      remedy: 'Grant the refusing actor the application permission required by this target, then reactivate the scheduled service and retry.',
    });
    expect(landed.rows[0].metadata).toEqual({ runsAs: 'system', requires: ['metrics.write'] });
  });

  it('lets the owner see its row, hides it from another caller, and widens an operator', async () => {
    const owner = await readHttp(SERVICE_SUB);
    expect(owner.status).toBe(200);
    expect(owner.cache).toContain('no-store');
    expect(owner.body).toMatchObject({ count: 1, windowHours: 24 });
    expect(owner.body.refusals[0]).toMatchObject({
      code: 'authorization_permission_denied',
      actorSub: SERVICE_SUB,
      owningPackage: APP,
      targetKind: 'job',
      target: SCHEDULE,
      preparedExecutionId: activation.id,
    });

    const other = await readHttp(OTHER_SUB);
    expect(other.status).toBe(200);
    expect(other.body).toMatchObject({ count: 0, refusals: [] });

    const operator = await readHttp('auth0|operator', true, '?hours=999&limit=999');
    expect(operator.status).toBe(200);
    expect(operator.body).toMatchObject({ count: 1, windowHours: 168 });
  });

  it('requires authentication and rejects a forged cross-owner insert at the database', async () => {
    expect((await readHttp()).status).toBe(401);

    const runtimePool = wrapPoolWithGuc(fixture.rolePool(ROLE));
    await expect(runWithRequestIdentity({ sub: OTHER_SUB, isOperator: false }, () => runtimePool.query(
      `INSERT INTO oshal_refusals
         (code, owner_sub, actor_sub, owning_package, target_kind, target)
       VALUES ('forged', $1, $2, 'fixture', 'job', 'forged-target')`,
      [SERVICE_SUB, OTHER_SUB],
    ))).rejects.toMatchObject({ code: '42501' });
  });
});
