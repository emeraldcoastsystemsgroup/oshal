/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove durable composite receipts, forced RLS, single-connection liveness and atomic rollback against disposable PostgreSQL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApplicationAuthorizationService, PostgresAuthorizationStore } from '@/features/application-authorization';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import type { AuthorizationActor, CompositeRolePreview } from '@/shared/application-authorization';
import type { Pool } from 'pg';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { CATALOG, ISSUER } from '../fixtures/authorization';
const RUNTIME = 'composite_runtime';
const database = new DisposablePostgres({ purpose: 'experience-composite', roles: [{ name: RUNTIME, max: 1 }],
  migrations: ['127-application-authorization.sql', '173-authorization-catalog-migrations.sql', '185-experience-composite-roles.sql'] });
let runtime: Pool, service: ApplicationAuthorizationService;
const admin: AuthorizationActor = { sub: 'synthetic-admin', issuer: ISSUER, isActive: true, isSwarmAdmin: true };
const user: AuthorizationActor = { sub: 'synthetic-user', issuer: ISSUER, isActive: true, isSwarmAdmin: false };
async function authority() {
  const value = new ApplicationAuthorizationService(new PostgresAuthorizationStore(runtime), {
    refreshActor: async actor => { await runtime.query('SELECT 1'); return actor; },
    resolveActor: async () => { await runtime.query('SELECT 1'); return user; },
    verifyApproval: async () => { await runtime.query('SELECT 1'); return true; },
  });
  await value.registerApp({ app: 'synthetic-member', source: 'fixture-member', version: '1', catalog: CATALOG, mode: 'enforce' });
  await value.registerApp({ app: 'synthetic-experience', source: 'fixture-host', version: '1', catalog: CATALOG, mode: 'enforce', compositeRoles: {
    templates: [{ id: 'resident', version: 1, label: 'Resident', members: [{ app: 'synthetic-experience', role: 'reader' }, { app: 'synthetic-member', role: 'reader' }] }], requiredApps: ['synthetic-member'], optionalApps: [] } });
  return value;
}
beforeAll(async () => {
  await database.start(); await database.pool.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ' + RUNTIME);
  runtime = wrapPoolWithGuc(database.rolePool(RUNTIME));
}, 180000);
afterAll(async () => { await database.stop(); });
beforeEach(async () => {
  await database.pool.query('TRUNCATE oshal_authorization_assignments,oshal_authorization_previews,oshal_authorization_audit,oshal_authorization_composite_assignments,oshal_authorization_composite_previews,oshal_authorization_applications,oshal_authorization_catalogs,oshal_authorization_catalog_migrations');
  await database.pool.query('UPDATE oshal_authorization_state SET revision=0'); service = await authority();
});
async function preview() { return service.previewCompositeRole(admin, { action: 'assign', app: 'synthetic-experience', template: 'resident', targetSub: user.sub, targetIssuer: user.issuer,
  reason: 'Synthetic durable review', expectedRevision: (await new PostgresAuthorizationStore(runtime).read()).revision }); }
const apply = (review: CompositeRolePreview, key = randomUUID()) => service.applyCompositeRole(admin, { previewId: review.previewId!, idempotencyKey: key });
describe('durable experience role lifecycle', () => {
  it('persists one complete set and retrieves the same receipt across service restart', async () => {
    const review = await preview(), key = randomUUID(), receipt = await apply(review, key);
    service = await authority(); expect(await apply(review, key)).toEqual(receipt);
    expect((await service.listCompositeRoles(admin)).assignments).toHaveLength(1);
    expect((await database.pool.query('SELECT count(*)::int AS count FROM oshal_authorization_assignments')).rows[0].count).toBe(2);
    expect((await database.pool.query('SELECT count(*)::int AS count FROM oshal_authorization_audit')).rows[0].count).toBe(2);
  });
  it('forces operator-only RLS on both new control tables', async () => {
    await apply(await preview());
    for (const table of ['oshal_authorization_composite_assignments', 'oshal_authorization_composite_previews']) {
      expect((await runtime.query('SELECT * FROM ' + table)).rows).toEqual([]);
      const posture = (await database.pool.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=$1', [table])).rows[0];
      expect(posture).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      await expect(runtime.query('INSERT INTO ' + table + '(id,payload) VALUES($1,$2::jsonb)', [randomUUID(), '{}'])).rejects.toThrow();
    }
  });
  it('rolls back member grants, parent assignment, revision and receipts on an audit failure', async () => {
    const review = await preview(); await database.pool.query('REVOKE INSERT ON oshal_authorization_audit FROM ' + RUNTIME);
    try {
      await expect(apply(review)).rejects.toThrow();
      const state = await new PostgresAuthorizationStore(runtime).read(); expect(state.revision).toBe(0); expect(state.assignments).toEqual([]); expect(state.compositeAssignments).toEqual([]);
      expect((await new PostgresAuthorizationStore(runtime).readCompositePreview(review.previewId!))?.receipt).toBeUndefined();
    } finally { await database.pool.query('GRANT INSERT ON oshal_authorization_audit TO ' + RUNTIME); }
  });
  it('serializes competing complete sets so a stale review cannot partially apply', async () => {
    const one = await preview(), two = await preview();
    const result = await Promise.allSettled([apply(one), apply(two)]);
    expect(result.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect((await service.listCompositeRoles(admin)).assignments).toHaveLength(1);
    expect((await new PostgresAuthorizationStore(runtime).read()).assignments).toHaveLength(2);
  });
});
