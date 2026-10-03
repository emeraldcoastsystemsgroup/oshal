/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | AUTH-07 reviewed catalog migration on real PostgreSQL under the non-superuser runtime role with FORCE row-level security: a Little Monsters-shaped 1.4.3 -> 1.4.4 upgrade carries every assignment in one transaction with its audit row (read back by a restarted service from the durable snapshot, not memory); a widening change refuses with a stored review and activates only after approval; a removed grant never revives; concurrent activations and approvals serialize to one migration and one approval; an audit failure rolls the re-stamp back.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Support reviewed experience role lifecycle with explicit selections, durable provenance and existing authority checks.
 */
/** Disposable local PostgreSQL only. Never consumes DATABASE_URL or deployment credentials. */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApplicationAuthorizationService, CATALOG_MIGRATION_INSTALLER, PostgresAuthorizationStore, type AuthorizationAudit,
} from '@/features/application-authorization';
import type { AuthorizationActor, AuthorizationCatalog, AuthorizationChange } from '@/shared/application-authorization';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { CLASSROOM_143, CLASSROOM_144, CLASSROOM_APP, classroomRegistration, editedCatalog } from '../fixtures/authorization-catalog-migration';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const RUNTIME = 'authorization_runtime';
const database = new DisposablePostgres({ purpose: 'authorization-catalog-migration', roles: [{ name: RUNTIME, max: 4 }],
  migrations: ['127-application-authorization.sql', '131-authorization-audit-indexes.sql', '173-authorization-catalog-migrations.sql', '185-experience-composite-roles.sql'] });
const ISSUER = 'https://identity.fixture.test';
const APP = CLASSROOM_APP;
const admin: AuthorizationActor = { sub: 'fixture-admin', issuer: ISSUER, isActive: true, isSwarmAdmin: true };
const outsider: AuthorizationActor = { sub: 'fixture-outsider', issuer: ISSUER, isActive: true, isSwarmAdmin: false };
const teacher: AuthorizationActor = { sub: 'fixture-teacher', issuer: ISSUER, isActive: true, isSwarmAdmin: false };
const student: AuthorizationActor = { sub: 'fixture-student', issuer: ISSUER, isActive: true, isSwarmAdmin: false };
const reviewer: AuthorizationActor = { sub: 'fixture-reviewer', issuer: ISSUER, isActive: true, isSwarmAdmin: false };
const denied: AuthorizationActor = { sub: 'fixture-denied', issuer: ISSUER, isActive: true, isSwarmAdmin: false };
let runtime: Pool;

const V143 = CLASSROOM_143;
const V144 = CLASSROOM_144;
const catalog = (edit: (value: AuthorizationCatalog) => void, base = V143): AuthorizationCatalog => editedCatalog(edit, base);
const registration = classroomRegistration;
function service(options: ConstructorParameters<typeof ApplicationAuthorizationService>[1] = {}): ApplicationAuthorizationService {
  return new ApplicationAuthorizationService(new PostgresAuthorizationStore(runtime), {
    resolveActor: async (sub, issuer) => [admin, outsider, teacher, student, reviewer, denied].find(actor => actor.sub === sub && actor.issuer === issuer) ?? null,
    ...options });
}
async function change(authority: ApplicationAuthorizationService, input: Omit<AuthorizationChange, 'expectedRevision' | 'reason' | 'app'>): Promise<void> {
  const revision = Number((await database.pool.query('SELECT revision FROM oshal_authorization_state')).rows[0].revision);
  const preview = await authority.previewChange(admin, { app: APP, reason: 'Catalog migration fixture', expectedRevision: revision, ...input } as AuthorizationChange);
  await authority.applyChange(admin, { previewId: preview.previewId, idempotencyKey: preview.previewId });
}
async function assignments(): Promise<Array<{ id: string; catalogRevision: string; role?: string; targetSub?: string }>> {
  return (await database.pool.query('SELECT payload FROM oshal_authorization_assignments ORDER BY id')).rows.map(row => row.payload);
}
async function migrationAudits(): Promise<AuthorizationAudit[]> {
  return (await database.pool.query(`SELECT payload FROM oshal_authorization_audit WHERE payload #>> '{change,action}'='catalog-migration' ORDER BY revision`)).rows.map(row => row.payload);
}
const operation = (method: string, path: string) => ({ app: APP, kind: 'http' as const, method, path });

/** Install 1.4.3 and grant the classroom: two named roles, a group mapping and an explicit deny. */
async function install143(): Promise<ApplicationAuthorizationService> {
  const authority = service();
  await authority.registerApp(registration(V143, '1.4.3'));
  await change(authority, { action: 'grant', targetSub: teacher.sub, targetIssuer: ISSUER, role: 'teacher' });
  await change(authority, { action: 'grant', targetSub: student.sub, targetIssuer: ISSUER, role: 'student' });
  await change(authority, { action: 'grant', targetSub: reviewer.sub, targetIssuer: ISSUER, role: 'reviewer' });
  // Tenant-scoped, so a caller outside the school needs no directory evidence to be decided.
  await change(authority, { action: 'group-map', tenantId: 'school-a', group: { issuer: ISSUER, tenantId: 'school-a', id: 'year-three' }, role: 'student' });
  await change(authority, { action: 'deny', targetSub: denied.sub, targetIssuer: ISSUER });
  return authority;
}

beforeAll(async () => {
  await database.start();
  await database.pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${RUNTIME}`);
  runtime = wrapPoolWithGuc(database.rolePool(RUNTIME));
}, 180_000);
afterAll(async () => { await database.stop(); });
beforeEach(async () => {
  await database.pool.query(`TRUNCATE oshal_authorization_assignments,oshal_authorization_previews,oshal_authorization_audit,
    oshal_authorization_applications,oshal_authorization_catalogs,oshal_authorization_catalog_migrations`);
  await database.pool.query('UPDATE oshal_authorization_state SET revision=0');
});

describe('AUTH-07 reviewed catalog migration on PostgreSQL', () => {
  it('keeps every control-plane table forced under the runtime role', async () => {
    const tables = (await database.pool.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname IN ('oshal_authorization_catalogs','oshal_authorization_catalog_migrations') ORDER BY relname`)).rows;
    expect(tables).toEqual([
      { relname: 'oshal_authorization_catalog_migrations', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'oshal_authorization_catalogs', relrowsecurity: true, relforcerowsecurity: true },
    ]);
    expect((await database.rolePool(RUNTIME).query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
      .toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await service().registerApp(registration(V143, '1.4.3'));
    // No operator identity on the connection: forced RLS returns nothing, even to the table's grantee.
    expect((await runtime.query('SELECT * FROM oshal_authorization_catalogs')).rows).toEqual([]);
    expect(Number((await database.pool.query('SELECT count(*) AS n FROM oshal_authorization_catalogs')).rows[0].n)).toBe(1);
  });

  it('carries a Little Monsters-shaped 1.4.3 -> 1.4.4 upgrade in one audited transaction', async () => {
    const before = await install143();
    expect((await before.authorize(teacher, operation('POST', '/import-artifact'))).reason).toBe('authorization_operation_unbound');
    const granted = await assignments();
    const revision = Number((await database.pool.query('SELECT revision FROM oshal_authorization_state')).rows[0].revision);
    // A restarted controller: nothing about 1.4.3 is in memory, only in the durable snapshot.
    const upgraded = service();
    await expect(upgraded.validateRegistration(registration(V144, '1.4.4'))).resolves.toBeUndefined();
    await upgraded.registerApp(registration(V144, '1.4.4'));
    const target = upgraded.getApp(APP)!.catalogRevision;
    const carried = await assignments();
    expect(carried.map(row => row.id)).toEqual(granted.map(row => row.id));
    expect(carried.every(row => row.catalogRevision === target)).toBe(true);
    const [audit] = await migrationAudits();
    expect(await migrationAudits()).toHaveLength(1);
    expect(audit).toMatchObject({ actor: { ...CATALOG_MIGRATION_INSTALLER }, revision: revision + 1,
      change: { action: 'catalog-migration', app: APP, expectedRevision: revision },
      migration: { fromVersions: ['1.4.3'], toVersion: '1.4.4', toRevision: target, classification: 'non-widening',
        assignmentIds: granted.map(row => row.id).sort(), removedIds: [] } });
    expect(audit.migration!.changes.map(item => `${item.id}:${item.effect}`)).toEqual(['POST /import-artifact:additive', 'class-material:additive']);
    expect(Date.parse(audit.at)).toBeGreaterThan(0);
    expect((await upgraded.authorize(teacher, operation('POST', '/import-artifact'))).allowed).toBe(true);
    expect((await upgraded.authorize(teacher, { app: APP, kind: 'artifactActions', operation: 'class-material' })).allowed).toBe(true);
    expect((await upgraded.authorize(student, operation('POST', '/import-artifact'))).reason).toBe('authorization_permission_denied');
    expect((await upgraded.authorize(student, operation('GET', '/study'))).allowed).toBe(true);
    expect((await upgraded.authorize(denied, operation('GET', '/study'))).reason).toBe('authorization_explicit_deny');
    const history = await upgraded.auditHistory(admin, { app: APP });
    expect(history.entries[0]).toMatchObject({ action: 'catalog-migration', migration: { toVersion: '1.4.4', removedIds: [] } });
    // Activating the same revision again (a second boot) is not a second migration.
    await service().registerApp(registration(V144, '1.4.4'));
    expect(await migrationAudits()).toHaveLength(1);
  });

  it('rolls the re-stamp back when its audit event cannot be written', async () => {
    await install143();
    const granted = await assignments();
    await database.pool.query(`REVOKE INSERT ON oshal_authorization_audit FROM ${RUNTIME}`);
    try {
      await expect(service().registerApp(registration(V144, '1.4.4'))).rejects.toThrow();
      expect(await assignments()).toEqual(granted);
      expect(Number((await database.pool.query('SELECT count(*) AS n FROM oshal_authorization_catalogs')).rows[0].n)).toBe(1);
    } finally { await database.pool.query(`GRANT INSERT ON oshal_authorization_audit TO ${RUNTIME}`); }
  });

  it('refuses a widening change with a reviewable preview and applies it only after approval', async () => {
    const running = await install143();
    const widened = catalog(value => {
      value.permissions['reward.grant'] = { resource: 'learner', effect: 'write', minimumTier: 'editor' };
      value.roles.student.grants.push({ permission: 'material.create', scope: 'own' });
    }, V144);
    const upgraded = service();
    const refusal = await upgraded.validateRegistration(registration(widened, '1.5.0')).catch(error => error);
    expect(refusal).toMatchObject({ status: 409, code: 'authorization_catalog_migration_required', classification: 'widening' });
    expect(refusal.message).toContain(refusal.previewId);
    await expect(upgraded.registerApp(registration(widened, '1.5.0'))).rejects.toMatchObject({ previewId: refusal.previewId });
    // The running 1.4.3 keeps working: nothing was re-stamped.
    expect((await running.authorize(student, operation('GET', '/study'))).allowed).toBe(true);
    const { migrations } = await upgraded.catalogMigrations(admin, { app: APP });
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toMatchObject({ previewId: refusal.previewId, status: 'pending', classification: 'widening',
      fromVersions: ['1.4.3'], toVersion: '1.5.0', affectedAssignments: 5, removedGrants: 0 });
    expect(migrations[0].changes.map(item => `${item.area}:${item.id}:${item.effect}`)).toEqual(expect.arrayContaining(
      ['permission:reward.grant:widening', 'role:student:widening', 'binding:POST /import-artifact:additive']));
    expect(JSON.stringify(migrations)).not.toContain(student.sub);
    await expect(upgraded.catalogMigrations(outsider, { app: APP })).rejects.toMatchObject({ status: 403 });
    await expect(upgraded.applyCatalogMigration(outsider, { previewId: refusal.previewId, idempotencyKey: 'outsider-approval' }))
      .rejects.toMatchObject({ status: 403 });
    const receipt = await upgraded.applyCatalogMigration(admin, { previewId: refusal.previewId, idempotencyKey: 'reviewed-approval' });
    expect(receipt).toMatchObject({ previewId: refusal.previewId, approved: true, app: APP });
    await upgraded.registerApp(registration(widened, '1.5.0'));
    const audits = await migrationAudits();
    expect(audits.at(-1)).toMatchObject({ actor: { sub: admin.sub, issuer: ISSUER }, previewId: refusal.previewId,
      migration: { classification: 'widening', reviewId: refusal.previewId, approvedBy: { sub: admin.sub, issuer: ISSUER } } });
    expect((await upgraded.authorize(student, operation('POST', '/materials'))).allowed).toBe(true);
    expect((await upgraded.catalogMigrations(admin, { app: APP })).migrations[0].status).toBe('applied');
    // A consumed review is not a reusable capability.
    await expect(upgraded.applyCatalogMigration(admin, { previewId: refusal.previewId, idempotencyKey: 'second-approval' }))
      .rejects.toMatchObject({ status: 409, code: 'authorization_preview_consumed' });
  });

  it('removes a grant whose role the reviewed catalog dropped, so re-adding the role cannot revive it', async () => {
    await install143();
    const reviewerRow = (await assignments()).find(row => row.targetSub === reviewer.sub)!;
    const dropped = catalog(value => { delete value.roles.reviewer; });
    const authority = service();
    const first = await authority.validateRegistration(registration(dropped, '1.6.0')).catch(error => error);
    expect(first.classification).toBe('breaking');
    expect((await authority.catalogMigrations(admin, { app: APP })).migrations[0].removedGrants).toBe(1);
    await authority.applyCatalogMigration(admin, { previewId: first.previewId, idempotencyKey: 'drop-reviewer' });
    await authority.registerApp(registration(dropped, '1.6.0'));
    expect((await assignments()).map(row => row.id)).not.toContain(reviewerRow.id);
    expect((await migrationAudits()).at(-1)!.migration!.removedIds).toEqual([reviewerRow.id]);
    const readded = catalog(value => { value.roles.reviewer = structuredClone(V143.roles.reviewer); }, dropped);
    const second = await authority.validateRegistration(registration(readded, '1.7.0')).catch(error => error);
    expect(second.classification).toBe('widening');
    await authority.applyCatalogMigration(admin, { previewId: second.previewId, idempotencyKey: 'readd-reviewer' });
    await authority.registerApp(registration(readded, '1.7.0'));
    expect((await assignments()).some(row => row.targetSub === reviewer.sub)).toBe(false);
    expect((await authority.authorize(reviewer, operation('GET', '/study'))).allowed).toBe(false);
    expect((await authority.effective(admin, { app: APP, targetSub: reviewer.sub, targetIssuer: ISSUER })).roles).toEqual([]);
    // Source-replaced grants cannot follow a package installed from somewhere else either.
    await expect(authority.validateRegistration(registration(readded, '1.7.0', 'store:another-repository')))
      .rejects.toMatchObject({ code: 'authorization_catalog_migration_required', previewId: null });
  });

  it('serializes concurrent activations into one migration and concurrent approvals into one', async () => {
    await install143();
    const results = await Promise.allSettled([service(), service(), service()].map(authority => authority.registerApp(registration(V144, '1.4.4'))));
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(await migrationAudits()).toHaveLength(1);
    const widened = catalog(value => { value.roles.student.grants.push({ permission: 'material.share', scope: 'own' }); }, V144);
    const authority = service();
    const { previewId } = await authority.validateRegistration(registration(widened, '1.8.0')).catch(error => error);
    const approvals = await Promise.allSettled(['approval-a', 'approval-b'].map(idempotencyKey =>
      service().applyCatalogMigration(admin, { previewId, idempotencyKey })));
    expect(approvals.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(approvals.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'authorization_preview_consumed' } });
    // Retrying the winning key concurrently is idempotent: the same receipt, no second approval.
    const winnerKey = approvals[0].status === 'fulfilled' ? 'approval-a' : 'approval-b';
    const repeated = await Promise.all([1, 2].map(() => service().applyCatalogMigration(admin, { previewId, idempotencyKey: winnerKey })));
    expect(repeated[0]).toEqual(repeated[1]);
    expect(repeated[0]).toEqual((approvals.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<unknown>).value);
    await Promise.all([service(), service()].map(racer => racer.registerApp(registration(widened, '1.8.0'))));
    expect((await migrationAudits()).filter(event => event.migration?.reviewId === previewId)).toHaveLength(1);
  });
});
