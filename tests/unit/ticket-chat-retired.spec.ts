/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The controller ticket chat stays retired (ADR-161 Tier-C register), over the real ticket router and HTTP. It ran a bot turn on the task orchestrator past the one admission decision, unattributed, and posted into an existing task id with no ownership check. Every caller now gets 410 legacy_execution_route_retired naming the canonical message door, the orchestrator is never reached, and nothing is linked or created: own ticket, another user's ticket, a bare task id, an unknown id, and an operator, each naming a privileged bot.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTaskStore } from '@/entities/task';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import { createTicketRoutes } from '@/app/routes/ticket-routes';

const ALICE = 'auth0|chat-alice';
const BOB = 'auth0|chat-bob';
const OPERATOR = 'auth0|chat-operator';
const PRIVILEGED_BOT = 'devops-bot-agent-id';
const ENV_KEYS = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_ALLOW_LEGACY_UNOWNED'];
const RETIRED = { error: 'legacy_execution_route_retired', replacement: 'POST /api/tasks/:taskId/messages' };

let savedEnv: Record<string, string | undefined>;
let server: Server;
let base: string;
let ticketService: TicketService;
let taskStore: InMemoryTaskStore;
let orchestratorCalls: unknown[][];
let ids: { own: string; foreign: string; bareTask: string };

/** @description Injects a signed-in session for the user named by the fixture header. */
function fixtureSession(req: Request, _res: Response, next: NextFunction): void {
  (req as { oidc?: unknown }).oidc = { isAuthenticated: () => true, user: { sub: String(req.get('x-fixture-user') || ALICE) } };
  next();
}

/** @description Posts a ticket chat turn naming a privileged bot, as one fixture user. */
function chat(ticketId: string, user: string): Promise<globalThis.Response> {
  return fetch(`${base}/api/tickets/${ticketId}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': user },
    body: JSON.stringify({ message: 'run the remediation', targetAgent: PRIVILEGED_BOT, agentId: PRIVILEGED_BOT }),
  });
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
  process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'false';
  ticketService = new TicketService(new InMemoryTicketStore());
  taskStore = new InMemoryTaskStore();
  orchestratorCalls = [];
  const orchestrator = {
    processMessage: async (...args: unknown[]) => {
      orchestratorCalls.push(args);
      return { success: true, response: 'a bot answered' };
    },
  };
  const own = await ticketService.createTicket({ title: 'alice ticket', ticketType: 'task', ownerSub: ALICE } as never);
  const foreign = await ticketService.createTicket({ title: 'bob ticket', ticketType: 'task', ownerSub: BOB } as never);
  const bareTask = await taskStore.create({ taskId: 'bob-bare-task', title: 'bob thread', processingMode: 'agentic', ownerSub: BOB, metadata: {} });
  ids = { own: own.ticketId, foreign: foreign.ticketId, bareTask: bareTask.taskId };
  const app = express();
  app.use(express.json());
  app.use(fixtureSession);
  app.use('/api/tickets', createTicketRoutes({ ticketService, taskStore, orchestrator, messageStore: {}, pool: {} } as never));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** @description Asserts one chat call was retired and reached nothing. */
async function expectRetired(ticketId: string, user: string): Promise<void> {
  const response = await chat(ticketId, user);
  expect(response.status).toBe(410);
  expect(await response.json()).toEqual(RETIRED);
  expect(orchestratorCalls).toEqual([]);
  expect(await ticketService.getTasksForTicket(ticketId).catch(() => [])).toEqual([]);
}

describe('controller ticket chat is retired', () => {
  it('retires a turn on the caller\'s own ticket', async () => {
    await expectRetired(ids.own, ALICE);
  });

  it('retires a turn on another user\'s ticket', async () => {
    await expectRetired(ids.foreign, ALICE);
  });

  it('retires a turn on another user\'s bare task id and leaves the thread untouched', async () => {
    await expectRetired(ids.bareTask, ALICE);
    expect((await taskStore.get(ids.bareTask))?.messageCount ?? 0).toBe(0);
  });

  it('retires a turn on an unknown id without creating a task', async () => {
    await expectRetired('no-such-ticket', ALICE);
    expect(await taskStore.get('no-such-ticket')).toBeNull();
  });

  it('retires a turn for an operator too', async () => {
    await expectRetired(ids.own, OPERATOR);
  });
});
