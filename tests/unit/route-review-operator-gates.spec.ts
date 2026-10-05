/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the second slice of the signed-in route review (2026-10-05), for the gates that sit inside routers the ratchet cannot see: the governance security-posture report, Plane ticket sync and the bot-registry proxy-health fetch are portal-admin only, and checkpoints answer only the owner of their task. Mount-level gates in the same slice (/api/logs, /api/process-lab, /api/swarm/ops, the legacy bot lifecycle and proxy routes) are held by the signed-in route ratchet.
 */

import type { AddressInfo } from 'node:net';
import express, { type Request, type Router } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/routes/protected-result-access', () => ({
  // The real check (task ownership plus protected-result lineage) has its own suites; here the
  // stored task `task-of-<sub>` belongs to <sub>, so the test proves the checkpoint routes ask it.
  callerCanReadStoredTaskResult: vi.fn(async (_ctx: unknown, req: Request, taskId: string) =>
    taskId === `task-of-${(req as Request & { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub}`),
}));

import { createAuditExportRouter } from '@/app/routes/audit-export-routes';
import { createTicketRoutes } from '@/app/routes/ticket-routes';
import { createBotRegistryRoutes } from '@/app/extensions/swarm/routes/bot-registry-routes';
import { createCheckpointRoutes } from '@/app/routes/checkpoint-routes';

const OPERATOR = 'fixture-admin';
const MEMBER = 'fixture-member';

beforeEach(() => { vi.stubEnv('OSHAL_OPERATOR_SUBS', OPERATOR); });
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

/** @description Serves one router behind a fixture sign-in that takes the caller's sub from a header. */
async function serve(router: Router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { oidc: { user: { sub: String(req.headers['x-test-sub'] ?? '') } } });
    next();
  });
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    call: (path: string, sub: string, method = 'GET', body?: unknown) => fetch(`${base}${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-test-sub': sub },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

describe('admin-only routes inside signed-in mounts', () => {
  it('the governance security-posture report refuses an ordinary user before reading the database', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) };
    const app = await serve(createAuditExportRouter({ pool } as never));
    try {
      expect((await app.call('/posture', MEMBER)).status).toBe(403);
      expect(pool.query).not.toHaveBeenCalled();
      expect((await app.call('/posture', OPERATOR)).status).not.toBe(403);
    } finally { await app.close(); }
  });

  it('Plane ticket sync refuses an ordinary user and never touches Plane', async () => {
    const planeSyncService = {
      pullTickets: vi.fn(async () => ({ pulled: 0 })),
      pushUpdate: vi.fn(async () => undefined),
      syncTicketState: vi.fn(async () => undefined),
    };
    const app = await serve(createTicketRoutes({ planeSyncService } as never));
    try {
      expect((await app.call('/sync/pull', MEMBER, 'POST', {})).status).toBe(403);
      expect((await app.call('/sync/push', MEMBER, 'POST', { ticketId: 'someone-elses', status: 'done' })).status).toBe(403);
      expect((await app.call('/sync/state', MEMBER, 'POST', { ticketId: 'someone-elses' })).status).toBe(403);
      expect(planeSyncService.pullTickets).not.toHaveBeenCalled();
      expect(planeSyncService.pushUpdate).not.toHaveBeenCalled();
      expect(planeSyncService.syncTicketState).not.toHaveBeenCalled();

      expect((await app.call('/sync/pull', OPERATOR, 'POST', {})).status).toBe(200);
      expect((await app.call('/sync/push', OPERATOR, 'POST', { ticketId: 't-1', status: 'done' })).status).toBe(200);
      expect((await app.call('/sync/state', OPERATOR, 'POST', { ticketId: 't-1' })).status).toBe(200);
      expect(planeSyncService.pushUpdate).toHaveBeenCalledWith('t-1', { status: 'done', comment: undefined });
    } finally { await app.close(); }
  });

  it('the bot-registry proxy-health fetch refuses an ordinary user before reading the target', async () => {
    const app = await serve(createBotRegistryRoutes());
    try {
      expect((await app.call('/proxy-health', MEMBER)).status).toBe(403);
      // The operator reaches the handler, which asks for the missing target.
      expect((await app.call('/proxy-health', OPERATOR)).status).toBe(400);
    } finally { await app.close(); }
  });
});

describe('checkpoints answer only the owner of their task', () => {
  const memoryService = {
    getCheckpoint: vi.fn(async (id: string) => (id === 'cp-alice' ? { checkpointId: 'cp-alice', taskId: 'task-of-alice' } : null)),
    restoreCheckpoint: vi.fn(async () => ({ taskId: 'task-of-alice' })),
    deleteCheckpoint: vi.fn(async () => true),
  };

  it('looks the same as a missing checkpoint to anyone else, and changes nothing', async () => {
    const app = await serve(createCheckpointRoutes({ memoryService } as never));
    try {
      expect((await app.call('/cp-alice', 'bob')).status).toBe(404);
      expect((await app.call('/cp-alice/restore', 'bob', 'POST')).status).toBe(404);
      expect((await app.call('/cp-alice', 'bob', 'DELETE')).status).toBe(404);
      expect((await app.call('/cp-missing', 'bob')).status).toBe(404);
      expect(memoryService.restoreCheckpoint).not.toHaveBeenCalled();
      expect(memoryService.deleteCheckpoint).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('still serves, restores and deletes for the owner', async () => {
    const app = await serve(createCheckpointRoutes({ memoryService } as never));
    try {
      const read = await app.call('/cp-alice', 'alice');
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ checkpoint: { checkpointId: 'cp-alice' } });
      expect((await app.call('/cp-alice/restore', 'alice', 'POST')).status).toBe(200);
      expect((await app.call('/cp-alice', 'alice', 'DELETE')).status).toBe(200);
      expect(memoryService.deleteCheckpoint).toHaveBeenCalledWith('cp-alice');
    } finally { await app.close(); }
  });
});
