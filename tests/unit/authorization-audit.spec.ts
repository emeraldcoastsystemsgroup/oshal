/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Verify redacted, scoped audit pagination against real PostgreSQL, HTTP and the registered tool handler.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Give sequential PostgreSQL/HTTP integration cases explicit budgets on loaded development hosts.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { AuthorizationAuditFixture } from '../fixtures/authorization-audit';
import { AUTHORIZATION_READ_TOOL } from '@/shared/security/authorization-tool-contract';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { ApplicationAuthorizationService, PostgresAuthorizationStore } from '@/features/application-authorization';

const fixture = new AuthorizationAuditFixture();
beforeAll(async () => { vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', ''); await fixture.start(); }, 90_000);
beforeEach(async () => { await fixture.reset(); }, 30_000);
afterAll(async () => { try { await fixture.close(); } finally { vi.unstubAllEnvs(); } }, 60_000);

  it.sequential('uses stable descending keyset pages while new changes arrive and a new store instance reads the same history', { timeout: 30_000 }, async () => {
    for (let i = 0; i < 5; i++) await fixture.apply();
    const first = await fixture.call('/audit?app=app-one&limit=2');
    expect(first.status).toBe(200); expect(first.headers.get('cache-control')).toContain('no-store');
    expect(first.body.entries.map((entry: { revision: number }) => entry.revision)).toEqual([5, 4]);
    expect(first.body.snapshotRevision).toBe(5);
    await fixture.apply();
    const second = await fixture.call('/audit?app=app-one&limit=2&cursor=' + first.body.nextCursor);
    expect(second.body.entries.map((entry: { revision: number }) => entry.revision)).toEqual([3, 2]);
    const third = await fixture.call('/audit?app=app-one&limit=2&cursor=' + second.body.nextCursor);
    expect(third.body.entries.map((entry: { revision: number }) => entry.revision)).toEqual([1]); expect(third.body.nextCursor).toBeNull();
    expect((await fixture.call('/audit?app=app-one&limit=2')).body.entries[0].revision).toBe(6);
    const row = (await fixture.database.owner.query('SELECT payload FROM oshal_authorization_audit ORDER BY revision DESC LIMIT 1')).rows[0].payload;
    expect(row.change.reason).toContain('SECRET_REASON');
    expect(JSON.stringify(first.body)).not.toMatch(/SECRET_REASON|previewId|expectedRevision|reason|approvalReference/);
    const restarted = new ApplicationAuthorizationService(new PostgresAuthorizationStore(fixture.database.runtime));
    expect((await restarted.auditHistory(fixture.actors.root, {})).entries[0].revision).toBe(6);
  });

  it.sequential('filters by app and tenant before pagination and denies cross-app, unscoped and ordinary reads', { timeout: 30_000 }, async () => {
    await fixture.apply({ tenantId: 'tenant-a' }); await fixture.apply({ tenantId: 'tenant-b' }); await fixture.apply({ app: 'app-two' });
    const tenant = await fixture.call('/audit?app=app-one&tenantId=tenant-a&limit=1', 'tenant');
    expect(tenant.status).toBe(200); expect(tenant.body.entries.map((entry: { revision: number }) => entry.revision)).toEqual([1]);
    expect(tenant.body.nextCursor).toBeNull();
    for (const [caller, query] of [['tenant', 'app=app-one'], ['tenant', 'app=app-one&tenantId=tenant-b'],
      ['manager', 'app=app-two'], ['manager', ''], ['user', 'app=app-one']]) {
      expect((await fixture.call('/audit?' + query, caller)).status).toBe(403);
    }
    expect((await fixture.call('/audit?app=app-one', 'manager')).body.entries).toHaveLength(2);
    expect((await fixture.call('/audit')).body.entries).toHaveLength(3);
    expect((await fixture.call('/audit', '')).status).toBe(401);
  });

  it.sequential('rechecks current authority and delegation ceilings on every continuation; cursors cannot switch actor or scope', { timeout: 30_000 }, async () => {
    await fixture.apply(); await fixture.apply();
    const first = await fixture.call('/audit?app=app-one&limit=1', 'manager');
    const cursor = first.body.nextCursor;
    expect((await fixture.call('/audit?app=app-two&cursor=' + cursor)).status).toBe(400);
    expect((await fixture.call('/audit?app=app-one&cursor=' + cursor)).status).toBe(400);
    fixture.actors.manager.managementScopes = [];
    expect((await fixture.call('/audit?app=app-one&cursor=' + cursor, 'manager')).status).toBe(403);
    await expect(fixture.service.auditHistory({ ...fixture.actors.root, allowedPermissions: [] }, {})).rejects.toMatchObject({ status: 403 });
    fixture.actors.root.isActive = false;
    expect((await fixture.call('/audit')).status).toBe(401);
  });

  it.sequential('rejects unbounded, malformed or authority-bearing requests and preserves database RLS', { timeout: 30_000 }, async () => {
    await fixture.apply();
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=1e2', 'limit=1&limit=2', 'actor=root', 'isSwarmAdmin=true', 'cursor=invalid', 'tenantId=tenant-a']) {
      expect((await fixture.call('/audit?' + query)).status).toBe(400);
    }
    const rows = await runWithRequestIdentity({ sub: 'user', principalIssuer: 'urn:audit-fixture', isOperator: false },
      () => fixture.database.runtime.query('SELECT * FROM oshal_authorization_audit'));
    expect(rows.rows).toHaveLength(0);
    const indexes = await fixture.database.owner.query("SELECT indexname FROM pg_indexes WHERE tablename='oshal_authorization_audit'");
    expect(indexes.rows.map(row => row.indexname)).toContain('authorization_audit_tenant_revision');
  });

  it.sequential('keeps removed-app history readable only by its current scoped manager or swarm administrator', { timeout: 30_000 }, async () => {
    await fixture.apply(); fixture.service.unregisterApp('app-one');
    expect((await fixture.call('/audit?app=app-one', 'manager')).body.entries).toHaveLength(1);
    expect((await fixture.call('/audit?app=app-one', 'user')).status).toBe(403);
  });

  it.sequential('runs read-only audit through the fixed tool with the same projection and no implicit mutation permission', { timeout: 30_000 }, async () => {
    await fixture.apply();
    const context = { resolveActor: async () => fixture.actors.manager, allowChanges: false };
    const result = JSON.parse(await fixture.tool.execute(AUTHORIZATION_READ_TOOL, { operation: 'audit_history', query: { app: 'app-one' } }, context));
    expect(result).toEqual((await fixture.call('/audit?app=app-one', 'manager')).body);
    await expect(fixture.tool.execute(AUTHORIZATION_READ_TOOL, { operation: 'audit_history', query: {} }, context)).rejects.toMatchObject({ status: 403 });
    await expect(fixture.tool.execute(AUTHORIZATION_READ_TOOL, { operation: 'audit_history', query: { app: 'app-one', actor: 'root' } }, context)).rejects.toThrow();
    expect((await fixture.tool.discover(fixture.actors.manager))[0].operations).toContain('audit_history');
    const ordinary = await fixture.tool.discover(fixture.actors.user);
    expect(ordinary[0].operations).not.toContain('audit_history');
    expect(ordinary[0].targets[0].operations).not.toContain('audit_history');
  });
