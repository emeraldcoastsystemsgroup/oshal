/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | PUT /api/tickets/:ticketId/state (cockpit compatibility) decides like its sibling /status, over the real ticket router, HTTP and the real protected-result policy and execution fixture. Another user's ticket or bare task id is refused with the missing-id 404 and its status is unchanged (the bare-task branch had no ownership check at all), the owner still changes their own ticket and task, and once the owner's result rights are revoked a protected ticket or protected bare task is refused too.
 */
import express, { type Request } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTicketRoutes } from '@/app/routes/ticket-routes';
import { CreateInternalTicketSchema } from '@/entities/ticket';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { createProtectedResultFixture } from '../fixtures/protected-results';

const ENV_KEYS = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_ALLOW_LEGACY_UNOWNED'];
const PLAIN_TASK = 'alice-plain-task';
const PROTECTED_TASK = 'alice-protected-task';

let fixture: Awaited<ReturnType<typeof createProtectedResultFixture>>;
let savedEnv: Record<string, string | undefined>;
let server: Server;
let base: string;
let plainTicket: string;
let protectedTicket: string;

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'false';
  fixture = await createProtectedResultFixture();
  fixture.ctx.ticketService = new TicketService(new InMemoryTicketStore());
  const create = (title: string) => fixture.ctx.ticketService.createTicket(CreateInternalTicketSchema.parse({ title, ownerSub: 'alice', ticketType: 'task' }));
  plainTicket = (await create('alice plain ticket')).ticketId;
  protectedTicket = (await create('alice protected ticket')).ticketId;
  await fixture.seed(protectedTicket);
  await fixture.ctx.taskStore.create({ taskId: PLAIN_TASK, title: 'alice thread', processingMode: 'agentic', ownerSub: 'alice', metadata: {} });
  await fixture.seed(PROTECTED_TASK);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = fixture.actors[String(req.get('x-fixture-user') || 'alice')];
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub: actor.sub, iss: actor.issuer } };
    (req as Request & { isOperator?: boolean }).isOperator = actor.isSwarmAdmin;
    runWithApplicationAuthorizationActor(actor, () => runWithRequestIdentity({ sub: actor.sub,
      principalIssuer: actor.issuer, isOperator: actor.isSwarmAdmin }, next));
  });
  app.use('/api/tickets', createTicketRoutes(fixture.ctx));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tickets`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await fixture?.close();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** @description Asks the cockpit-compatibility route to cancel a ticket or task, as one fixture actor. */
function cancel(id: string, user: string): Promise<globalThis.Response> {
  return fetch(`${base}/${id}/state`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-fixture-user': user },
    body: JSON.stringify({ status: 'cancelled' }) });
}

/** @description The stored status of a ticket and of a task, so a refusal can be shown to change nothing. */
async function statuses(): Promise<Record<string, string | undefined>> {
  const ticket = async (id: string) => (await fixture.ctx.ticketService.getTicket(id))?.status;
  const task = async (id: string) => (await fixture.ctx.taskStore.get(id))?.status;
  return { plainTicket: await ticket(plainTicket), protectedTicket: await ticket(protectedTicket),
    plainTask: await task(PLAIN_TASK), protectedTask: await task(PROTECTED_TASK) };
}

/** @description Asserts the call is refused with the missing-id 404 and no status moved. */
async function expectRefused(id: string, user: string): Promise<void> {
  const before = await statuses();
  const response = await cancel(id, user);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'Ticket not found' });
  expect(await statuses()).toEqual(before);
}

describe('PUT /api/tickets/:ticketId/state decides like /status', () => {
  it('refuses another user\'s ticket, changing nothing', async () => {
    await expectRefused(plainTicket, 'bob');
  });

  it('refuses another user\'s bare task id, changing nothing', async () => {
    await expectRefused(PLAIN_TASK, 'bob');
  });

  it('lets the owner change their own ticket and their own bare task', async () => {
    const ticket = await cancel(plainTicket, 'alice');
    expect(ticket.status).toBe(200);
    expect(await ticket.json()).toMatchObject({ success: true, entity: 'ticket' });
    const task = await cancel(PLAIN_TASK, 'alice');
    expect(task.status).toBe(200);
    expect(await task.json()).toMatchObject({ success: true, entity: 'task', newStatus: 'cancelled' });
    expect((await statuses()).plainTask).toBe('cancelled');
  });

  it('refuses the owner on a protected ticket and a protected bare task once result rights are revoked', async () => {
    await fixture.change('alice', 'revoke');
    expect((await fetch(`${base}/${protectedTicket}`, { headers: { 'x-fixture-user': 'alice' } })).status).toBe(404);
    await expectRefused(protectedTicket, 'alice');
    await expectRefused(PROTECTED_TASK, 'alice');
  });

  it('answers a refused id exactly like a missing one', async () => {
    const refused = await cancel(PLAIN_TASK, 'bob');
    const missing = await cancel('no-such-ticket-or-task', 'bob');
    expect([refused.status, missing.status]).toEqual([404, 404]);
    expect(await refused.json()).toEqual(await missing.json());
  });
});
