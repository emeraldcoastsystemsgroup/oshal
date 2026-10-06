/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B guards (step B5-8) on a private PostgreSQL under the NON-superuser application role with the REAL migrations 060 (household tables, membership helper, RLS policies), 135 (external-identity memberships) and 174 (admin helper, membership fence): listHouseholds answers an operator every household with every member, admins first whatever their join order, counts external-identity members, and marks manageable only the households that operator is admin of; a person sees only their own households through the same query (RLS); the fence refuses an operator who is not a household's admin adding a member, which is what manageable: false reports; the route is mounted behind requiresAuth and requiresOperator and the real operator gate answers a user 403; the route answers 503 without a pool. Each fails on the tree before the fix.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { isOperator, requiresOperator } from '@/shared/middleware/authz';
import { createSwarmHouseholdsRoutes, listHouseholds } from '@/app/routes/swarm-households-routes';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const APP_ROLE = 'oshal_app';
const database = new DisposablePostgres({
  purpose: 'swarm-households', roles: [APP_ROLE], max: 4,
  migrations: ['060-platform-rls-tenancy.sql', '135-external-tenant-memberships.sql', '174-tenant-admin-membership-fence.sql'],
});
let superuser: Pool;
let runtime: Pool;
const OPERATOR = 'op-sub';
const ALICE = 'alice-sub';
const BOB = 'bob-sub';
const DAVE = 'dave-sub';

const as = <T>(sub: string | null, isOp: boolean, fn: () => Promise<T>) => runWithRequestIdentity({ sub, isOperator: isOp }, fn);

beforeAll(async () => {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', OPERATOR); vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  superuser = await database.start();
  await superuser.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON oshal_tenants, oshal_tenant_memberships, oshal_external_tenant_memberships TO ${APP_ROLE}`);
  runtime = wrapPoolWithGuc(database.rolePool(APP_ROLE));
  // Dave founds a team and admits Alice, then makes her admin too: an admin who joined later must still list first.
  const daves = await as(DAVE, false, async () => (await runtime.query("INSERT INTO oshal_tenants (kind, name, created_by_sub) VALUES ('org', 'Dave team', $1) RETURNING tenant_id", [DAVE])).rows[0].tenant_id as string);
  await as(DAVE, false, () => runtime.query("INSERT INTO oshal_tenant_memberships (tenant_id, user_sub, role) VALUES ($1, $2, 'admin')", [daves, DAVE]));
  await as(DAVE, false, () => runtime.query("INSERT INTO oshal_tenant_memberships (tenant_id, user_sub, role) VALUES ($1, $2, 'member')", [daves, BOB]));
  await as(DAVE, false, () => runtime.query("INSERT INTO oshal_tenant_memberships (tenant_id, user_sub, role) VALUES ($1, $2, 'member')", [daves, ALICE]));
  await as(DAVE, false, () => runtime.query("UPDATE oshal_tenant_memberships SET role = 'admin' WHERE tenant_id = $1 AND user_sub = $2", [daves, ALICE]));
  // The operator founds a household, admits Alice, and an external-identity person belongs to it too.
  const ops = await as(OPERATOR, true, async () => (await runtime.query("INSERT INTO oshal_tenants (kind, name, created_by_sub) VALUES ('space', 'Ops home', $1) RETURNING tenant_id", [OPERATOR])).rows[0].tenant_id as string);
  await as(OPERATOR, true, () => runtime.query("INSERT INTO oshal_tenant_memberships (tenant_id, user_sub, role) VALUES ($1, $2, 'admin')", [ops, OPERATOR]));
  await as(OPERATOR, true, () => runtime.query("INSERT INTO oshal_tenant_memberships (tenant_id, user_sub, role) VALUES ($1, $2, 'member')", [ops, ALICE]));
  await as(OPERATOR, true, () => runtime.query("INSERT INTO oshal_external_tenant_memberships (issuer, user_sub, tenant_id) VALUES ('https://login.example.test/tenant', 'ext-person', $1)", [ops]));
  await as(OPERATOR, true, () => runtime.query("INSERT INTO oshal_tenants (kind, name, created_by_sub) VALUES ('space', 'Empty nest', $1)", [OPERATOR]));
}, 180_000);
afterAll(async () => { await database.stop(); vi.unstubAllEnvs(); });

describe('listHouseholds under RLS as the application role, on the real migrations', () => {
  it('an operator sees every household with every member, admins first whatever their join order, external members counted, and may manage only the ones they are admin of', async () => {
    const households = await as(OPERATOR, true, () => listHouseholds(runtime, OPERATOR));
    expect(households.map((h) => h.name)).toEqual(['Dave team', 'Ops home', 'Empty nest']);
    const [daves, ops, empty] = households;
    // Admins first (Alice joined after Bob and still lists before him); among admins, the earlier joiner first.
    expect(daves.members.map((m) => [m.sub, m.role])).toEqual([[DAVE, 'admin'], [ALICE, 'admin'], [BOB, 'member']]);
    expect(daves).toMatchObject({ kind: 'org', createdBySub: DAVE, externalMembers: 0, myRole: null, manageable: false });
    expect(ops.members.map((m) => [m.sub, m.role])).toEqual([[OPERATOR, 'admin'], [ALICE, 'member']]);
    expect(ops).toMatchObject({ kind: 'space', externalMembers: 1, myRole: 'admin', manageable: true });
    expect(empty).toMatchObject({ members: [], externalMembers: 0, myRole: null, manageable: false });
  });

  it('a person sees only their own households through the same query', async () => {
    const bobs = await as(BOB, false, () => listHouseholds(runtime, BOB));
    expect(bobs.map((h) => [h.name, h.myRole, h.manageable])).toEqual([['Dave team', 'member', false]]);
    const alices = await as(ALICE, false, () => listHouseholds(runtime, ALICE));
    expect(alices.map((h) => [h.name, h.myRole, h.manageable])).toEqual([['Dave team', 'admin', true], ['Ops home', 'member', false]]);
  });

  it('the real membership fence refuses an operator who is not a household\'s admin, which is what manageable: false reports', async () => {
    const daves = (await as(OPERATOR, true, () => listHouseholds(runtime, OPERATOR))).find((h) => h.name === 'Dave team')!;
    await expect(as(OPERATOR, true, () => runtime.query("INSERT INTO oshal_tenant_memberships (tenant_id, user_sub, role) VALUES ($1, 'carol-sub', 'member')", [daves.tenantId]))).rejects.toThrow(/only an admin of the tenant/);
    await expect(as(ALICE, false, () => runtime.query("INSERT INTO oshal_tenant_memberships (tenant_id, user_sub, role) VALUES ($1, 'carol-sub', 'member')", [daves.tenantId]))).resolves.toBeTruthy();
    const after = (await as(OPERATOR, true, () => listHouseholds(runtime, OPERATOR))).find((h) => h.name === 'Dave team')!;
    expect(after.members.map((m) => m.sub)).toEqual([DAVE, ALICE, BOB, 'carol-sub']);
  });

  it('is mounted behind requiresAuth and requiresOperator; the real operator gate answers a user 403; the route answers 503 without a pool', async () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/app/server-auxiliary-routes.ts'), 'utf8');
    expect(source).toContain("app.use('/api/admin/households', requiresAuth, requiresOperator, createSwarmHouseholdsRoutes({ pool: ctx.pool }));");
    const app = express();
    app.use((req, _res, next) => {
      const sub = String(req.headers['x-test-sub'] ?? '');
      Object.assign(req, { oidc: { isAuthenticated: () => Boolean(sub), user: { sub } } });
      runWithRequestIdentity({ sub: sub || null, isOperator: isOperator(req) }, () => next());
    });
    app.use('/with', requiresOperator, createSwarmHouseholdsRoutes({ pool: runtime }));
    app.use('/without', createSwarmHouseholdsRoutes({ pool: null }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}/with/`, { headers: { 'x-test-sub': OPERATOR } });
      expect(res.status).toBe(200);
      const body = await res.json() as { households: Array<{ name: string; manageable: boolean; externalMembers: number }>; count: number; note: string };
      expect(body.count).toBe(3);
      expect(body.households.map((h) => [h.name, h.manageable, h.externalMembers])).toEqual([['Dave team', false, 0], ['Ops home', true, 1], ['Empty nest', false, 0]]);
      expect(body.note).toContain('managed by its own admins');
      expect((await fetch(`${base}/with/`, { headers: { 'x-test-sub': ALICE } })).status).toBe(403);
      expect((await fetch(`${base}/without/`, { headers: { 'x-test-sub': OPERATOR } })).status).toBe(503);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
