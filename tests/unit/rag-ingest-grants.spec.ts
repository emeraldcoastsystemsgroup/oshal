/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard from the signed-in route review (2026-10-05): a non-operator may share an ingested document only with tenants they belong to. Grants to other users, to public:anyone (which every signed-in user carries), to other groups or to a foreign tenant, in the body or in metadata, are refused before anything is stored; the operator may still grant anyone.
 */

import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/routes/connector-tenancy', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/app/routes/connector-tenancy')>(),
  getUserTenantIds: vi.fn(async (_pool: unknown, sub: string) => (sub === 'alice' ? ['alice-home'] : [])),
}));

import { createRagRoutes } from '@/app/routes/rag-routes';

const ingest = vi.fn(async () => ({ documentCount: 1, chunkCount: 1 }));
let server: ReturnType<express.Express['listen']>;
let base = '';
beforeEach(async () => {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'portal-admin'); vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { oidc: { user: { sub: String(req.headers['x-test-sub'] ?? '') } } }); next(); });
  app.use('/api/rag', createRagRoutes({ ingest } as never, undefined, {} as never));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs(); vi.clearAllMocks();
});

function ingestAs(sub: string, extra: Record<string, unknown>) {
  return fetch(`${base}/api/rag/ingest`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-sub': sub },
    body: JSON.stringify({ format: 'text', content: 'Notes for the household', ...extra }),
  });
}

describe("a user's ingest cannot reach other people's retrieval", () => {
  it.each([
    ['another user', { allowedUsers: ['bob'] }],
    ['every signed-in user', { allowedGroups: ['public:anyone'] }],
    ['an email domain', { allowedGroups: 'domain:example.com' }],
    ['a household they are not in', { tenantId: 'bob-home' }],
    ['another user, through metadata', { metadata: { allowed_users: 'bob' } }],
    ['every signed-in user, through metadata', { metadata: { allowed_groups: 'public:anyone' } }],
  ])('refuses a grant to %s before storing anything', async (_label, extra) => {
    const res = await ingestAs('alice', extra);
    expect(res.status).toBe(403);
    expect(ingest).not.toHaveBeenCalled();
  });
});

describe('sharing a user may still do', () => {
  it('keeps a private ingest owned by the caller', async () => {
    expect((await ingestAs('alice', {})).status).toBe(200);
    expect(ingest).toHaveBeenCalledWith(['Notes for the household'], 'default', expect.objectContaining({ owner_sub: 'alice' }));
  });

  it('shares with a household the caller belongs to', async () => {
    expect((await ingestAs('alice', { tenantId: 'alice-home' })).status).toBe(200);
    expect(ingest).toHaveBeenCalledWith(expect.any(Array), 'default', expect.objectContaining({ allowed_groups: 'tenant:alice-home' }));
  });

  it('lets the operator grant anyone', async () => {
    expect((await ingestAs('portal-admin', { allowedGroups: ['public:anyone'], allowedUsers: ['bob'] })).status).toBe(200);
    expect(ingest).toHaveBeenCalled();
  });
});
