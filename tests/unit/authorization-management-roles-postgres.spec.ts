/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove durable delegated management, forced RLS, one-connection liveness and revoke-before-write ordering.
 */
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ApplicationAuthorizationService, PostgresAuthorizationStore, type AuthorizationTransaction } from '@/features/application-authorization';
import type { AuthorizationActor, AuthorizationChange } from '@/shared/application-authorization';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { LocalAccountFixture } from '../fixtures/local-account-administration';
import { CATALOG, ISSUER } from '../fixtures/authorization';

const database = new LocalAccountFixture(); let pool: Pool;
const admin: AuthorizationActor = { sub: 'admin', issuer: ISSUER, isActive: true, isSwarmAdmin: true };
const manager: AuthorizationActor = { sub: 'manager', issuer: ISSUER, isActive: true, isSwarmAdmin: false };
const registration = { app: 'catalog-app', source: 'fixture', version: '1', catalog: CATALOG, mode: 'enforce' as const };

beforeAll(async () => {
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', ''); await database.start();
  await database.owner.query(readFileSync('scripts/migrations/127-application-authorization.sql', 'utf8'));
  await database.owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO users_runtime');
  pool = wrapPoolWithGuc(new Pool({ ...database.runtime.options, password: database.runtime.options.password,
    max: 1, connectionTimeoutMillis: 1000 }));
}, 90_000);
beforeEach(async () => {
  await database.owner.query('TRUNCATE oshal_authorization_assignments,oshal_authorization_previews,oshal_authorization_audit,oshal_authorization_applications');
  await database.owner.query('UPDATE oshal_authorization_state SET revision=0');
});
afterAll(async () => { await pool?.end(); await database.close(); vi.unstubAllEnvs(); }, 30_000);

async function createService(store = new PostgresAuthorizationStore(pool)) {
  const service = new ApplicationAuthorizationService(store, {
    refreshActor: async actor => { await pool.query('SELECT 1'); return { ...actor, managementScopes: undefined }; },
    verifyApproval: async () => { await pool.query('SELECT 1'); return true; },
  });
  await service.registerApp(registration); return service;
}
async function apply(service: ApplicationAuthorizationService, input: Partial<AuthorizationChange> = {}, caller = admin) {
  const state = await new PostgresAuthorizationStore(pool).read();
  const preview = await service.previewChange(caller, { action: 'grant', app: registration.app, role: '@access-admin',
    targetSub: manager.sub, targetIssuer: manager.issuer, reason: 'Fixture delegation', expectedRevision: state.revision, ...input });
  return service.applyChange(caller, { previewId: preview.previewId, idempotencyKey: preview.previewId, approvalReference: 'trusted-fixture' });
}

class DelayedWriterStore extends PostgresAuthorizationStore {
  nextWrite: (() => Promise<void>) | undefined;
  /** @description Pause only the next write before acquiring its real PostgreSQL lock.
   * @param operation Actual policy transaction. @returns The actual committed or refused result.
   */
  override async transaction<T>(operation: (transaction: AuthorizationTransaction) => Promise<T>): Promise<T> {
    const wait = this.nextWrite; this.nextWrite = undefined; await wait?.();
    return super.transaction(operation);
  }
}

it('persists an auditor across service restart while keeping control rows inaccessible to ordinary SQL', async () => {
  const service = await createService(); await apply(service, { role: '@access-auditor' });
  const reloaded = await createService();
  expect((await reloaded.catalog(manager)).apps[0].managementScopes).toEqual([{ app: 'catalog-app', permissions: ['read'] }]);
  expect((await reloaded.effective(manager, { app: 'catalog-app' })).managementRoles).toEqual(['@access-auditor']);
  expect((await reloaded.authorize(manager, { app: 'catalog-app', method: 'GET', path: '/records' })).allowed).toBe(false);
  expect((await pool.query('SELECT * FROM oshal_authorization_assignments')).rowCount).toBe(0);
  expect((await pool.query('SELECT * FROM oshal_authorization_previews')).rowCount).toBe(0);
  expect((await database.owner.query('SELECT revision FROM oshal_authorization_audit')).rows).toEqual([{ revision: '1' }]);
});

it('approves and refreshes through one real pool connection without a nested writer acquisition', async () => {
  const service = await createService();
  await expect(apply(service, { targetSub: admin.sub, role: '@access-admin' })).resolves.toMatchObject({ applied: true });
  await expect(apply(service)).resolves.toMatchObject({ applied: true });
  await expect(apply(service, { targetSub: 'reader', role: 'reader' }, manager)).resolves.toMatchObject({ applied: true });
  expect((await database.owner.query('SELECT count(*)::int AS count FROM oshal_authorization_audit')).rows[0].count).toBe(3);
}, 10_000);

it('rechecks durable management after writer contention so a committed revocation cannot be lost', async () => {
  const store = new DelayedWriterStore(pool); const service = await createService(store); const revoker = await createService();
  await apply(service);
  const preview = await service.previewChange(manager, { action: 'grant', app: 'catalog-app', role: 'reader',
    targetSub: 'other', targetIssuer: ISSUER, reason: 'Delayed writer', expectedRevision: 1 });
  let entered!: () => void; let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  store.nextWrite = async () => { entered(); await gate; };
  const pending = service.applyChange(manager, { previewId: preview.previewId, idempotencyKey: preview.previewId });
  const refused = expect(pending).rejects.toMatchObject({ status: 403, code: 'authorization_management_denied' });
  await waiting;
  try { await apply(revoker, { action: 'revoke' }); } finally { release(); }
  await refused;
  expect((await store.read()).assignments).toEqual([]);
  expect((await database.owner.query('SELECT count(*)::int AS count FROM oshal_authorization_audit')).rows[0].count).toBe(2);
}, 10_000);
