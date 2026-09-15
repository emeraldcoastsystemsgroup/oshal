/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | ADR-157 S1: the closure proof over a real, disposable PostgreSQL — migration 144 as shipped, the real ADR-149 policy store, and the real evaluator. Activating a system service makes the application's service principal pass authorize() for EXACTLY the declared permission and fail a second job binding it was never granted; deactivating revokes precisely the assignments that activation created.
 * 2   | maintainer@emeraldcoastsystemsgroup.com     | Deactivation authority, against the same real table where the system row's target_sub really is NULL and an untargeted lookup really does match it: a person who holds no activation is answered with not-found, a non-administrator cannot close the system service, an administrator closes one named person's activation without touching it, and only an administrator closes the system one. Naming the class is what decides, so nothing infers "system" from a lookup that missed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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
/** Unclassified on purpose: until a package declares runsAs, a system activation and a person's
 *  activation of the SAME schedule coexist, which is the shape the deactivation defect lived in. */
const SHARED = `${APP}-shared-tick`;
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
const alice: AuthorizationActor = { sub: 'alice', issuer: ISSUER, isActive: true, isSwarmAdmin: false };
const bob: AuthorizationActor = { sub: 'bob', issuer: ISSUER, isActive: true, isSwarmAdmin: false };
const servicePrincipal: AuthorizationActor = {
  sub: applicationServicePrincipalSub(APP), issuer: APPLICATION_SERVICE_PRINCIPAL_ISSUER,
  isActive: true, isSwarmAdmin: false,
};

const database = new DisposableAlertPostgres();
let policy: PostgresAuthorizationStore;
let authorization: ApplicationAuthorizationService;
let activations: PostgresApplicationServiceActivationStore;
let service: ApplicationServiceActivationService;
/** Per-user schedule instances the activation service asked the scheduler to register. */
let instances: string[] = [];

/** @description Count the assignment rows one activation created, straight out of the table. */
async function grantedRows(activationId: string): Promise<Array<{ permission: string; target: string }>> {
  const result = await database.pool.query<{ permission: string; target: string }>(
    `SELECT payload->>'permission' AS permission, payload->>'targetSub' AS target
       FROM oshal_authorization_assignments WHERE payload->>'grantSource' = $1 ORDER BY 1`,
    [serviceActivationGrantSource(activationId)],
  );
  return result.rows;
}

/** @description Read the live activation rows of one schedule straight out of the table, so an
 * assertion about "the system service is still on" is the row itself and not a return value. */
async function liveRows(scheduleId: string): Promise<Array<{ id: string; runs_as: string; target_sub: string | null }>> {
  const result = await database.pool.query<{ id: string; runs_as: string; target_sub: string | null }>(
    `SELECT id, runs_as, target_sub FROM oshal_application_service_activations
      WHERE app=$1 AND schedule_id=$2 AND revoked_at IS NULL ORDER BY runs_as`,
    [APP, scheduleId],
  );
  return result.rows;
}

/** @description Give one person the catalog role a user service requires, through the real
 * management path, so the activation they make is one they were genuinely authorized for. */
async function grantContributor(sub: string): Promise<void> {
  const effective = await authorization.effective(admin, { app: APP, targetSub: sub, targetIssuer: ISSUER });
  const preview = await authorization.previewChange(admin, {
    action: 'grant', app: APP, targetSub: sub, targetIssuer: ISSUER, role: 'contributor',
    reason: 'ADR-157 guard: the person must really hold what the user service requires.',
    expectedRevision: effective.revision,
  });
  await authorization.applyChange(admin, { previewId: preview.previewId, idempotencyKey: randomUUID() });
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
      { app: APP, id: 'shared-tick', scheduleId: SHARED, cron: '0 * * * *', requires: ['metrics.write'], queue: APP },
    ],
    authorize: (actor, operation) => authorization.authorize(actor, operation),
    registerUserInstance: async input => { instances.push(input.userSub); },
    removeUserInstance: async input => { instances = instances.filter(sub => sub !== input.userSub); },
  });
  await grantContributor(alice.sub);
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
    expect(await service.deactivate(admin, { app: APP, scheduleId: INGEST, runsAs: 'system' })).toBe(true);
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

describe('ADR-157 deactivation authority over real PostgreSQL', () => {
  let systemActivation: string;
  let aliceActivation: string;

  // One schedule, both principals live: the application's own activation (target_sub IS NULL) and
  // one person's. Every case below asserts the OTHER row is untouched, read back from the table.
  beforeEach(async () => {
    for (const row of await liveRows(SHARED)) {
      await activations.revoke(row.id, { sub: 'fixture-reset', issuer: ISSUER }, new Date().toISOString());
    }
    instances = [];
    systemActivation = (await service.activate(admin, { app: APP, scheduleId: SHARED, runsAs: 'system' })).id;
    aliceActivation = (await service.activate(alice, { app: APP, scheduleId: SHARED, runsAs: 'user' })).id;
    expect(instances).toEqual([alice.sub]);
  });

  it('answers a person who holds no activation with not-found, leaving the system service live', async () => {
    expect(await service.deactivate(bob, { app: APP, scheduleId: SHARED, targetSub: bob.sub, targetIssuer: ISSUER })).toBe(false);

    const live = await liveRows(SHARED);
    expect(live.map(row => row.runs_as)).toEqual(['system', 'user']);
    expect(live.find(row => row.runs_as === 'system')?.id).toBe(systemActivation);
    expect(await grantedRows(systemActivation)).toHaveLength(1);
    expect((await authorization.authorize(servicePrincipal, { app: APP, kind: 'jobs', operation: INGEST })).allowed).toBe(true);
  });

  it('never answers a named principal with the application\'s own activation', async () => {
    expect(await service.deactivate(admin, { app: APP, scheduleId: SHARED, targetSub: 'never-activated', targetIssuer: ISSUER })).toBe(false);
    expect((await liveRows(SHARED)).map(row => row.runs_as)).toEqual(['system', 'user']);
    expect(await grantedRows(systemActivation)).toHaveLength(1);
  });

  it('refuses a named target that is not a principal rather than widening the lookup', async () => {
    // An empty target is the same untargeted key the system row matches on COALESCE(target_sub,'').
    await expect(service.deactivate(admin, { app: APP, scheduleId: SHARED, targetSub: '', targetIssuer: ISSUER }))
      .rejects.toMatchObject({ status: 400, code: 'authorization_service_target_invalid' });
    expect((await liveRows(SHARED)).map(row => row.runs_as)).toEqual(['system', 'user']);
  });

  it('refuses a non-administrator who asks to deactivate the system service', async () => {
    await expect(service.deactivate(bob, { app: APP, scheduleId: SHARED, runsAs: 'system' }))
      .rejects.toMatchObject({ status: 403, code: 'authorization_service_admin_required' });
    expect((await liveRows(SHARED)).map(row => row.runs_as)).toEqual(['system', 'user']);
    expect(await grantedRows(systemActivation)).toHaveLength(1);
  });

  it('lets an administrator close one person\'s activation without touching the system service', async () => {
    expect(await service.deactivate(admin, { app: APP, scheduleId: SHARED, targetSub: alice.sub, targetIssuer: ISSUER })).toBe(true);

    const live = await liveRows(SHARED);
    expect(live.map(row => row.runs_as)).toEqual(['system']);
    expect(live[0].id).toBe(systemActivation);
    expect(instances).toEqual([]);
    const closed = await database.pool.query<{ revoked_by_sub: string }>(
      'SELECT revoked_by_sub FROM oshal_application_service_activations WHERE id=$1', [aliceActivation]);
    expect(closed.rows[0].revoked_by_sub).toBe('admin');
    expect(await grantedRows(systemActivation)).toHaveLength(1);
  });

  it('lets a swarm administrator close the system service, and only its own grants go', async () => {
    expect(await service.deactivate(admin, { app: APP, scheduleId: SHARED, runsAs: 'system' })).toBe(true);

    const live = await liveRows(SHARED);
    expect(live.map(row => row.runs_as)).toEqual(['user']);
    expect(live[0].id).toBe(aliceActivation);
    expect(instances).toEqual([alice.sub]);
    expect(await grantedRows(systemActivation)).toEqual([]);
    expect(await service.resolveDispatch({ app: APP, scheduleId: SHARED, ownerSub: null })).toBeNull();
    expect(await service.resolveDispatch({ app: APP, scheduleId: SHARED, ownerSub: alice.sub })).toMatchObject({ id: aliceActivation });
  });

  it('lets a person close their own activation with no target and no class named', async () => {
    expect(await service.deactivate(alice, { app: APP, scheduleId: SHARED })).toBe(true);
    expect((await liveRows(SHARED)).map(row => row.runs_as)).toEqual(['system']);
    expect(instances).toEqual([]);
  });
});
