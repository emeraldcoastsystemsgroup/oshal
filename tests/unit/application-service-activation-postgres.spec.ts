/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | ADR-157 S1: the closure proof over a real, disposable PostgreSQL — migration 144 as shipped, the real ADR-149 policy store, and the real evaluator. Activating a system service makes the application's service principal pass authorize() for EXACTLY the declared permission and fail a second job binding it was never granted; deactivating revokes precisely the assignments that activation created.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';
import {
  APPLICATION_SERVICE_PRINCIPAL_ISSUER, ApplicationAuthorizationService,
  ApplicationServiceActivationService, AUTHORIZATION_SCHEMA,
  PostgresApplicationServiceActivationStore, PostgresAuthorizationStore,
  applicationServicePrincipalSub, serviceActivationGrantSource,
} from '@/features/application-authorization';
import type { AuthorizationActor, AuthorizationCatalog } from '@/shared/application-authorization';

const APP = 'metrics-app';
const INGEST = `${APP}-daily-ingest`;
const REVIEW = `${APP}-weekly-review`;
const ISSUER = 'https://identity.fixture.test';
const SOURCE = 'fixture-store';

const CATALOG: AuthorizationCatalog = {
  version: 1,
  resources: { scorecard: { scopes: ['own'] } },
  permissions: {
    'metrics.write': { resource: 'scorecard', effect: 'write', minimumTier: 'editor' },
    'scorecard.administer': { resource: 'scorecard', effect: 'administer', minimumTier: 'admin' },
  },
  roles: { contributor: { tier: 'editor', grants: [{ permission: 'metrics.write', scope: 'own' }] } },
  bindings: {
    jobs: [
      { id: INGEST, allOf: ['metrics.write'] },
      { id: REVIEW, allOf: ['scorecard.administer'] },
    ],
  },
};

const admin: AuthorizationActor = { sub: 'admin', issuer: ISSUER, isActive: true, isSwarmAdmin: true };
const servicePrincipal: AuthorizationActor = {
  sub: applicationServicePrincipalSub(APP), issuer: APPLICATION_SERVICE_PRINCIPAL_ISSUER,
  isActive: true, isSwarmAdmin: false,
};

const database = new DisposableAlertPostgres();
let policy: PostgresAuthorizationStore;
let authorization: ApplicationAuthorizationService;
let activations: PostgresApplicationServiceActivationStore;
let service: ApplicationServiceActivationService;

/** @description Count the assignment rows one activation created, straight out of the table. */
async function grantedRows(activationId: string): Promise<Array<{ permission: string; target: string }>> {
  const result = await database.pool.query<{ permission: string; target: string }>(
    `SELECT payload->>'permission' AS permission, payload->>'targetSub' AS target
       FROM oshal_authorization_assignments WHERE payload->>'grantSource' = $1 ORDER BY 1`,
    [serviceActivationGrantSource(activationId)],
  );
  return result.rows;
}

beforeAll(async () => {
  await database.start();
  for (const statement of AUTHORIZATION_SCHEMA) await database.pool.query(statement);
  await database.pool.query(readFileSync(resolve('scripts/migrations/144-application-service-activations.sql'), 'utf8'));
  policy = new PostgresAuthorizationStore(database.pool);
  authorization = new ApplicationAuthorizationService(policy);
  await authorization.registerApp({
    app: APP, source: SOURCE, version: '1.0.0', catalog: CATALOG, mode: 'enforce',
    adapters: { scorecard: { authorize: async () => true } },
  });
  activations = new PostgresApplicationServiceActivationStore(database.pool);
  const summary = authorization.getApp(APP)!;
  service = new ApplicationServiceActivationService({
    activations, policy,
    describeApp: () => ({ source: summary.source, catalogRevision: summary.catalogRevision, catalog: CATALOG }),
    declaredServices: async () => [
      { app: APP, id: 'daily-ingest', scheduleId: INGEST, cron: '15 6 * * *', runsAs: 'system', requires: ['metrics.write'], queue: APP },
      { app: APP, id: 'weekly-review', scheduleId: REVIEW, cron: '0 7 * * 1', runsAs: 'system', requires: ['scorecard.administer'], queue: APP },
    ],
    authorize: (actor, operation) => authorization.authorize(actor, operation),
    registerUserInstance: async () => { /* a system activation registers no per-user instance */ },
    removeUserInstance: async () => { /* likewise */ },
  });
}, 180_000);

afterAll(async () => {
  await database.stop();
});

describe('ADR-157 system activation over real PostgreSQL', () => {
  it('refuses the tick before anything is activated', async () => {
    const decision = await authorization.authorize(servicePrincipal, { app: APP, kind: 'jobs', operation: INGEST });
    expect(decision.allowed).toBe(false);
    expect(await service.resolveDispatch({ app: APP, scheduleId: INGEST, ownerSub: null })).toBeNull();
  });

  it('grants exactly the declared permission, and only that one', async () => {
    const activation = await service.activate(admin, { app: APP, scheduleId: INGEST, runsAs: 'system' });
    expect(await grantedRows(activation.id)).toEqual([
      { permission: 'metrics.write', target: applicationServicePrincipalSub(APP) },
    ]);

    const allowed = await authorization.authorize(servicePrincipal, { app: APP, kind: 'jobs', operation: INGEST });
    expect(allowed).toMatchObject({ allowed: true, reason: 'authorization_allowed' });
    expect(allowed.grants).toEqual([{ permission: 'metrics.write', scope: 'own' }]);

    const other = await authorization.authorize(servicePrincipal, { app: APP, kind: 'jobs', operation: REVIEW });
    expect(other.allowed).toBe(false);

    const resolved = await service.resolveDispatch({ app: APP, scheduleId: INGEST, ownerSub: null });
    expect(resolved).toMatchObject({ runsAs: 'system', requires: ['metrics.write'], activatedBySub: 'admin' });
  });

  it('never lets the service principal borrow a person authorization', async () => {
    const stranger: AuthorizationActor = { sub: 'nobody', issuer: ISSUER, isActive: true, isSwarmAdmin: false };
    const decision = await authorization.authorize(stranger, { app: APP, kind: 'jobs', operation: INGEST });
    expect(decision.allowed).toBe(false);
  });

  it('revokes exactly what the activation created when it is deactivated', async () => {
    const live = await service.resolveDispatch({ app: APP, scheduleId: INGEST, ownerSub: null });
    expect(live).not.toBeNull();
    expect(await service.deactivate(admin, { app: APP, scheduleId: INGEST })).toBe(true);
    expect(await grantedRows(live!.id)).toEqual([]);
    const decision = await authorization.authorize(servicePrincipal, { app: APP, kind: 'jobs', operation: INGEST });
    expect(decision.allowed).toBe(false);
    expect(await service.resolveDispatch({ app: APP, scheduleId: INGEST, ownerSub: null })).toBeNull();
    const row = await database.pool.query<{ revoked_by_sub: string }>(
      'SELECT revoked_by_sub FROM oshal_application_service_activations WHERE id=$1', [live!.id]);
    expect(row.rows[0].revoked_by_sub).toBe('admin');
  });

  it('suspends an activation with the decision reason and reactivation clears it', async () => {
    const activation = await service.activate(admin, { app: APP, scheduleId: INGEST, runsAs: 'system' });
    await service.suspend(activation, 'authorization_permission_denied');
    expect((await activations.read(activation.id))?.suspendedReason).toBe('authorization_permission_denied');
    const reactivated = await service.activate(admin, { app: APP, scheduleId: INGEST, runsAs: 'system' });
    expect(reactivated.id).not.toBe(activation.id);
    expect(reactivated.suspendedReason).toBeUndefined();
    expect(await grantedRows(activation.id)).toEqual([]);
    expect(await grantedRows(reactivated.id)).toHaveLength(1);
  });
});
