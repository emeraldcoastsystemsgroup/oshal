/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard from the signed-in route review (2026-10-05): only the portal admin may add a person to a tenant, because membership pulls the tenant's shared connections and knowledge into that person's own resolution. Creating a tenant and the tenant admin's remove and role-change routes are unchanged.
 */

import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/routes/connector-tenancy', () => ({
  createTenant: vi.fn(async (_pool: unknown, input: { name: string }) => ({ id: 'tenant-1', name: input.name })),
  addMember: vi.fn(async () => undefined),
  removeMember: vi.fn(async () => undefined),
  setMemberRole: vi.fn(async () => undefined),
  listUserTenants: vi.fn(async () => []),
  isTenantMember: vi.fn(async () => true),
  listTenantMembers: vi.fn(async () => []),
  accessibleConnections: vi.fn(async () => []),
}));

import { addMember, createTenant, removeMember } from '@/app/routes/connector-tenancy';
import { createTenantRoutes } from '@/app/routes/tenant-routes';

let server: ReturnType<express.Express['listen']>;
let base = '';
beforeEach(async () => {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'portal-admin');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: String(req.headers['x-test-sub'] ?? '') } } });
    next();
  });
  app.use('/api/tenants', createTenantRoutes({ pool: {} } as never));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs(); vi.clearAllMocks();
});

function send(path: string, sub: string, method = 'POST', body: unknown = {}) {
  return fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-test-sub': sub }, body: JSON.stringify(body) });
}

describe('adding a person to a tenant', () => {
  it('is refused for an ordinary user, even one who created the tenant', async () => {
    expect((await send('/api/tenants', 'alice', 'POST', { name: 'Alice home' })).status).toBe(200);
    expect(createTenant).toHaveBeenCalled();
    const res = await send('/api/tenants/tenant-1/members', 'alice', 'POST', { memberSub: 'bob', role: 'admin' });
    expect(res.status).toBe(403);
    expect(addMember).not.toHaveBeenCalled();
  });

  it('is allowed for the portal admin', async () => {
    const res = await send('/api/tenants/tenant-1/members', 'portal-admin', 'POST', { memberSub: 'bob', role: 'member' });
    expect(res.status).toBe(200);
    expect(addMember).toHaveBeenCalledWith({}, 'tenant-1', 'bob', 'portal-admin', 'member');
  });

  it('leaves removing a member to the tenant admin', async () => {
    expect((await send('/api/tenants/tenant-1/members/bob', 'alice', 'DELETE')).status).toBe(200);
    expect(removeMember).toHaveBeenCalledWith({}, 'tenant-1', 'bob', 'alice');
  });
});
