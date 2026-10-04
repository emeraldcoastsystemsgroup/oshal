/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Global project registry mutations are operator administration, over the real cockpit project router and HTTP: a signed-in non-operator cannot create, rename or archive a registry project (403, registry file untouched), an operator can do all three, and a non-operator still assigns their OWN ticket to any project name through the owner-scoped ticket route, which needs no registry entry.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fixture only: the context resolves the signed-in session as an active verified actor, as production's application-authorization runtime always does. The ticket read verdict behind PUT /api/tickets/:id/project now requires one (exact-principal ownership, P5 step 1) and fails closed without it. No assertion changed.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTaskStore } from '@/entities/task';
import { InMemoryTicketStore, TicketProjectAssignmentService, TicketService } from '@/features/ticketing';
import { createCockpitProjectRoutes } from '@/app/routes/cockpit-project-routes';
import { createTicketRoutes } from '@/app/routes/ticket-routes';

const USER = 'auth0|projects-user';
const OPERATOR = 'auth0|projects-operator';
const ENV_KEYS = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_ALLOW_LEGACY_UNOWNED'];

let savedEnv: Record<string, string | undefined>;
let server: Server;
let base: string;
let outputDir: string;
let ticketService: TicketService;

/** @description Injects a signed-in session for the user named by the fixture header. */
function fixtureSession(req: Request, _res: Response, next: NextFunction): void {
  (req as { oidc?: unknown }).oidc = { isAuthenticated: () => true, user: { sub: String(req.get('x-fixture-user') || USER) } };
  next();
}

/** @description The verified actor production resolves for a signed-in session: the session's own sub, active. */
async function sessionActor(req: Request): Promise<{ sub: string; issuer: string; isActive: boolean; isSwarmAdmin: boolean }> {
  return { sub: String(req.get('x-fixture-user') || USER), issuer: 'https://projects.fixture.test', isActive: true, isSwarmAdmin: false };
}

/** @description Calls the API as one fixture user. */
function call(route: string, user: string, method = 'GET', body?: unknown): Promise<globalThis.Response> {
  return fetch(base + route, {
    method, headers: { 'content-type': 'application/json', 'x-fixture-user': user },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** @description The registry project ids currently on disk. */
function registryIds(): string[] {
  const file = path.join(outputDir, 'projects.json');
  if (!fs.existsSync(file)) return [];
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{ id: string }>).map((entry) => entry.id).sort();
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
  process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'false';
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-projects-'));
  ticketService = new TicketService(new InMemoryTicketStore());
  const taskStore = new InMemoryTaskStore();
  const ticketProjectAssignmentService = new TicketProjectAssignmentService(ticketService, taskStore);
  const ctx = {
    ticketService, taskStore, ticketProjectAssignmentService, messageStore: {}, orchestrator: {}, pool: {}, configOutputDir: outputDir,
    applicationAuthorization: { resolveActor: sessionActor },
  } as never;
  const app = express();
  app.use(express.json());
  app.use(fixtureSession);
  app.use('/api/v1', createCockpitProjectRoutes(ctx));
  app.use('/api/tickets', createTicketRoutes(ctx));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  fs.rmSync(outputDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('global project registry administration', () => {
  it('refuses a non-operator create and leaves the registry untouched', async () => {
    const response = await call('/api/v1/projects', USER, 'POST', { name: 'Side Project' });
    expect(response.status).toBe(403);
    expect(registryIds()).toEqual([]);
  });

  it('refuses a non-operator rename or archive of an operator project', async () => {
    expect((await call('/api/v1/projects', OPERATOR, 'POST', { name: 'Shared Roadmap' })).status).toBe(200);
    expect(registryIds()).toEqual(['shared-roadmap']);
    expect((await call('/api/v1/projects/shared-roadmap', USER, 'PATCH', { name: 'Hijacked' })).status).toBe(403);
    expect((await call('/api/v1/projects/shared-roadmap', USER, 'DELETE')).status).toBe(403);
    expect(registryIds()).toEqual(['shared-roadmap']);
  });

  it('lets an operator create, rename and archive', async () => {
    expect((await call('/api/v1/projects', OPERATOR, 'POST', { name: 'Ops Board' })).status).toBe(200);
    expect((await call('/api/v1/projects/ops-board', OPERATOR, 'PATCH', { name: 'Ops Board Two' })).status).toBe(200);
    expect(registryIds()).toEqual(['ops-board-two']);
    expect((await call('/api/v1/projects/ops-board-two', OPERATOR, 'DELETE')).status).toBe(200);
    expect(registryIds()).toEqual([]);
  });

  it('still lets a non-operator put their own ticket in a project of their choosing', async () => {
    const created = await (await call('/api/tickets', USER, 'POST', { title: 'my work' })).json() as { ticketId: string };
    const assigned = await call(`/api/tickets/${created.ticketId}/project`, USER, 'PUT', { projectName: 'Side Project' });
    expect(assigned.status).toBe(200);
    expect(registryIds()).toEqual([]);
  });
});
