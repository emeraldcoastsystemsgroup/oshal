/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Sole-operator self-approval on real PostgreSQL under the non-superuser runtime role: the swarm root alone may approve an AUTH-07 catalog migration or an access change touching their own sensitive grant by naming that exact preview, and the reference is stored with the approval and its audit event; a second administrator from ANY source (role store, configured subject, verified provider sign-in, local account) turns the two-person rule back on; a non-root administrator, a delegated root, a reference for another preview and an unreadable census are all refused.
 */
/** Disposable local PostgreSQL only. Never consumes DATABASE_URL or deployment credentials. */
import type { Pool } from 'pg';
import type { Request } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationAuthorizationService, PostgresAuthorizationStore, type AuthorizationAudit } from '@/features/application-authorization';
import type { AuthorizationActor, AuthorizationCatalog, AuthorizationChange } from '@/shared/application-authorization';
import { claimRoot, ensureSwarmRoleSchema, grantRole } from '@/features/swarm-roles';
import { ensureLocalUserSchema } from '@/features/local-auth';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { createApplicationPrincipalDirectory } from '../../src/app/composition/application-principal-directory';
import {
  createSoleOperatorApprovalVerifier, createSwarmAdministratorCensus, soleOperatorApprovalReference,
} from '../../src/app/composition/sole-operator-approval';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { CLASSROOM_143, CLASSROOM_APP, classroomRegistration, editedCatalog } from '../fixtures/authorization-catalog-migration';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const RUNTIME = 'sole_operator_runtime';
const database = new DisposablePostgres({ purpose: 'sole-operator-approval', roles: [{ name: RUNTIME, max: 4 }],
  migrations: ['127-application-authorization.sql', '129-verified-principal-directory.sql', '131-authorization-audit-indexes.sql',
    '173-authorization-catalog-migrations.sql'] });
const GOOGLE = 'https://accounts.google.com';
const APP = CLASSROOM_APP;
const root: AuthorizationActor = { sub: 'fixture-root', issuer: GOOGLE, isActive: true, isSwarmAdmin: true };
// Sets up grants without being counted: it exists only in memory, never in a store the census reads.
const helper: AuthorizationActor = { sub: 'fixture-helper', issuer: GOOGLE, isActive: true, isSwarmAdmin: true };
const student: AuthorizationActor = { sub: 'fixture-student', issuer: GOOGLE, isActive: true, isSwarmAdmin: false };
const otherAdmin: AuthorizationActor = { sub: 'fixture-other-admin', issuer: GOOGLE, isActive: true, isSwarmAdmin: true };
let runtime: Pool; let env: NodeJS.ProcessEnv;
let directory: ReturnType<typeof createApplicationPrincipalDirectory>;

function service(): ApplicationAuthorizationService {
  const verify = createSoleOperatorApprovalVerifier(createSwarmAdministratorCensus(runtime, env, directory.swarmAdministrators));
  return new ApplicationAuthorizationService(new PostgresAuthorizationStore(runtime), {
    resolveActor: async (sub, issuer) => [root, helper, student, otherAdmin].find(actor => actor.sub === sub && actor.issuer === issuer) ?? null,
    verifyApproval: verify, verifyCatalogMigrationApproval: verify });
}
async function revision(): Promise<number> {
  return Number((await database.pool.query('SELECT revision FROM oshal_authorization_state')).rows[0].revision);
}
async function preview(authority: ApplicationAuthorizationService, actor: AuthorizationActor, change: Omit<AuthorizationChange, 'expectedRevision' | 'reason' | 'app'>) {
  return authority.previewChange(actor, { app: APP, reason: 'Sole-operator fixture', expectedRevision: await revision(), ...change } as AuthorizationChange);
}
async function grant(authority: ApplicationAuthorizationService, target: AuthorizationActor, role: string): Promise<void> {
  const draft = await preview(authority, helper, { action: 'grant', targetSub: target.sub, targetIssuer: target.issuer, role });
  await authority.applyChange(helper, { previewId: draft.previewId, idempotencyKey: draft.previewId });
}
async function audits(): Promise<AuthorizationAudit[]> {
  return (await database.pool.query('SELECT payload FROM oshal_authorization_audit ORDER BY revision')).rows.map(row => row.payload);
}
function signIn(sub: string, email: string): Request {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: GOOGLE, sub, iat: now, exp: now + 3600, email, email_verified: true, name: sub };
  return { oidc: { isAuthenticated: () => true, user: { sub, email }, idTokenClaims: claims }, headers: {} } as unknown as Request;
}
/** A widening revision of the classroom catalog: the sensitive teacher role gains a permission. */
const widened: AuthorizationCatalog = editedCatalog(catalog => { catalog.roles.teacher.grants.push({ permission: 'study.read', scope: 'own' }); });

/** Install 1.4.3 with the root holding the sensitive teacher role, then refuse the widening upgrade into a review. */
async function pendingReview(authority: ApplicationAuthorizationService): Promise<string> {
  await authority.registerApp(classroomRegistration(CLASSROOM_143, '1.4.3'));
  await grant(authority, root, 'teacher');
  await grant(authority, student, 'student');
  const refusal = await authority.validateRegistration(classroomRegistration(widened, '1.4.5')).catch(error => error);
  expect(refusal).toMatchObject({ code: 'authorization_catalog_migration_required', classification: 'widening' });
  return refusal.previewId as string;
}

beforeAll(async () => {
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', '');
  await database.start();
  await ensureSwarmRoleSchema(database.pool); await ensureLocalUserSchema(database.pool);
  await database.pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${RUNTIME}`);
  runtime = wrapPoolWithGuc(database.rolePool(RUNTIME));
}, 180_000);
afterAll(async () => { await database.stop(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  await database.pool.query(`TRUNCATE oshal_authorization_assignments,oshal_authorization_previews,oshal_authorization_audit,
    oshal_authorization_applications,oshal_authorization_catalogs,oshal_authorization_catalog_migrations,
    swarm_roles,oshal_verified_principals,oshal_local_users CASCADE`);
  await database.pool.query('UPDATE oshal_authorization_state SET revision=0');
  env = { OIDC_ISSUER_URL: GOOGLE, OIDC_CLIENT_ID: 'fixture-google', OIDC_CLIENT_SECRET: 'fixture',
    OSHAL_OPERATOR_SUBS: root.sub, OSHAL_OPERATOR_EMAILS: 'root@example.test,second@example.test' };
  directory = createApplicationPrincipalDirectory(runtime, () => Promise.resolve(), env);
  await claimRoot(database.pool, { userSub: root.sub, email: 'root@example.test' });
  await directory.observe(signIn(root.sub, 'root@example.test'));
  await directory.observe(signIn(student.sub, 'student@example.test'));
});

describe('sole-operator self-approval of a catalog migration', () => {
  it('lets the sole root approve a review touching their own sensitive grant and records the reference', async () => {
    const authority = service();
    const previewId = await pendingReview(authority);
    await expect(authority.applyCatalogMigration(root, { previewId, idempotencyKey: 'no-reference' }))
      .rejects.toMatchObject({ status: 403, code: 'authorization_approval_required' });
    await expect(authority.applyCatalogMigration(root, { previewId, idempotencyKey: 'wrong-preview',
      approvalReference: soleOperatorApprovalReference('00000000-0000-4000-8000-000000000000') }))
      .rejects.toMatchObject({ status: 403, code: 'authorization_approval_required' });
    const reference = soleOperatorApprovalReference(previewId);
    const receipt = await authority.applyCatalogMigration(root, { previewId, idempotencyKey: 'self-approved', approvalReference: reference });
    expect(receipt).toMatchObject({ previewId, approved: true, app: APP });
    const stored = (await database.pool.query('SELECT payload FROM oshal_authorization_catalog_migrations WHERE id=$1', [previewId])).rows[0].payload;
    expect(stored.approval).toMatchObject({ actor: { sub: root.sub, issuer: GOOGLE }, reference });
    await authority.registerApp(classroomRegistration(widened, '1.4.5'));
    expect((await audits()).at(-1)).toMatchObject({ actor: { sub: root.sub, issuer: GOOGLE }, previewId, approvalReference: reference,
      change: { action: 'catalog-migration', app: APP }, migration: { reviewId: previewId, approvedBy: { sub: root.sub, issuer: GOOGLE } } });
    // The redacted history projection keeps omitting approval data.
    expect(JSON.stringify((await authority.auditHistory(root, { app: APP })).entries)).not.toContain(reference);
  });

  it('refuses once any other identity resolves as a swarm administrator, from every source', async () => {
    const authority = service();
    const previewId = await pendingReview(authority);
    const approve = (key: string) => authority.applyCatalogMigration(root, { previewId, idempotencyKey: key,
      approvalReference: soleOperatorApprovalReference(previewId) });
    const refused = { status: 403, code: 'authorization_approval_required' };
    await grantRole(database.pool, { userSub: otherAdmin.sub, role: 'admin', grantedBySub: root.sub });
    await expect(approve('role-store-admin')).rejects.toMatchObject(refused);
    await database.pool.query('DELETE FROM swarm_roles WHERE user_sub=$1', [otherAdmin.sub]);
    env.OSHAL_OPERATOR_SUBS = `${root.sub},configured-operator`;
    await expect(approve('configured-subject')).rejects.toMatchObject(refused);
    env.OSHAL_OPERATOR_SUBS = root.sub;
    await directory.observe(signIn('fixture-second-google', 'second@example.test'));
    await expect(approve('verified-sign-in')).rejects.toMatchObject(refused);
    await database.pool.query('DELETE FROM oshal_verified_principals WHERE user_sub=$1', ['fixture-second-google']);
    await database.pool.query(`INSERT INTO oshal_local_users(id,email,user_sub,status,password_hash)
      VALUES('local-second','second@example.test','local-second-sub','active','fixture-hash')`);
    await expect(approve('local-account')).rejects.toMatchObject(refused);
    // An operator email with no account behind it is no administrator yet; the root alone again.
    await database.pool.query('DELETE FROM oshal_local_users');
    await expect(approve('sole-again')).resolves.toMatchObject({ approved: true });
  });

  it('refuses the only administrator while swarm root is unclaimed', async () => {
    const authority = service();
    const previewId = await pendingReview(authority);
    await database.pool.query("DELETE FROM swarm_roles WHERE role='root'");
    await expect(authority.applyCatalogMigration(root, { previewId, idempotencyKey: 'root-unclaimed',
      approvalReference: soleOperatorApprovalReference(previewId) })).rejects.toMatchObject({ status: 403 });
  });

  it('fails closed when the administrator census cannot be read', async () => {
    const authority = service();
    const previewId = await pendingReview(authority);
    await database.pool.query('ALTER TABLE swarm_roles RENAME TO swarm_roles_unavailable');
    try {
      await expect(authority.applyCatalogMigration(root, { previewId, idempotencyKey: 'census-down',
        approvalReference: soleOperatorApprovalReference(previewId) })).rejects.toMatchObject({ status: 403 });
    } finally { await database.pool.query('ALTER TABLE swarm_roles_unavailable RENAME TO swarm_roles'); }
  });
});

describe('sole-operator self-approval of an access change', () => {
  it('lets the sole root grant themselves a sensitive role and stores the reference on the audit event', async () => {
    const authority = service();
    await authority.registerApp(classroomRegistration(CLASSROOM_143, '1.4.3'));
    const draft = await preview(authority, root, { action: 'grant', targetSub: root.sub, targetIssuer: GOOGLE, role: 'teacher' });
    expect(draft.requiresApproval).toBe(true);
    await expect(authority.applyChange(root, { previewId: draft.previewId, idempotencyKey: 'self-no-reference' }))
      .rejects.toMatchObject({ status: 403, code: 'authorization_approval_required' });
    const reference = soleOperatorApprovalReference(draft.previewId);
    const receipt = await authority.applyChange(root, { previewId: draft.previewId, idempotencyKey: 'self-granted', approvalReference: reference });
    expect(receipt.applied).toBe(true);
    expect((await audits()).at(-1)).toMatchObject({ id: receipt.auditId, previewId: draft.previewId, approvalReference: reference,
      change: { action: 'grant', targetSub: root.sub, role: 'teacher' } });
    expect((await authority.effective(root, { app: APP, targetSub: root.sub, targetIssuer: GOOGLE })).roles).toContain('teacher');
  });

  it('refuses a non-root administrator and a delegated root, and records nothing for an unneeded reference', async () => {
    const authority = service();
    await authority.registerApp(classroomRegistration(CLASSROOM_143, '1.4.3'));
    const other = await preview(authority, otherAdmin, { action: 'grant', targetSub: otherAdmin.sub, targetIssuer: GOOGLE, role: 'teacher' });
    await expect(authority.applyChange(otherAdmin, { previewId: other.previewId, idempotencyKey: 'not-root',
      approvalReference: soleOperatorApprovalReference(other.previewId) })).rejects.toMatchObject({ status: 403 });
    const delegatedRoot: AuthorizationActor = { ...root, allowedPermissions: ['platform:authorization.assign', 'platform:authorization.read'] };
    const verify = createSoleOperatorApprovalVerifier(createSwarmAdministratorCensus(runtime, env, directory.swarmAdministrators));
    await expect(verify(delegatedRoot, { previewId: other.previewId, app: APP }, soleOperatorApprovalReference(other.previewId))).resolves.toBe(false);
    // A grant that needed no approval keeps no reference, even when a caller sends one.
    const plain = await preview(authority, root, { action: 'grant', targetSub: student.sub, targetIssuer: GOOGLE, role: 'student' });
    expect(plain.requiresApproval).toBe(false);
    await authority.applyChange(root, { previewId: plain.previewId, idempotencyKey: 'plain-grant', approvalReference: soleOperatorApprovalReference(plain.previewId) });
    expect((await audits()).at(-1)!.approvalReference).toBeUndefined();
  });
});
