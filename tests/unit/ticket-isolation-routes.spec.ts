import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTicketStore, TicketService } from '../../src/features/ticketing';
import { createTicketRoutes } from '../../src/app/routes/ticket-routes';

const ENV_KEYS = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_ALLOW_LEGACY_UNOWNED'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'false';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('ticket API isolation routes', () => {
  const servers: Array<{ close: (cb: () => void) => void }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
    servers.length = 0;
  });

  it('does not let a non-operator list or read another user ticket', async () => {
    const ticketService = new TicketService(new InMemoryTicketStore());
    const userATicket = await ticketService.createTicket({
      title: 'User A ticket',
      description: 'owned by A',
      ticketType: 'task',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'auth0|user-a',
    });
    const userBTicket = await ticketService.createTicket({
      title: 'User B ticket',
      description: 'owned by B',
      ticketType: 'task',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'auth0|user-b',
    });

    const app = express();
    app.use(express.json());
    app.use(mockOidc('auth0|user-a'));
    app.use('/api/tickets', createTicketRoutes({
      ticketService,
      taskStore: {},
      messageStore: {},
      orchestrator: {},
      pool: {},
    } as never));

    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const listResponse = await fetch(`${baseUrl}/api/tickets?scope=all&ownerSub=auth0%7Cuser-b`);
    const listBody = await listResponse.json() as { tickets: Array<{ ticketId: string }> };
    expect(listResponse.status).toBe(200);
    expect(listBody.tickets.map((ticket) => ticket.ticketId)).toEqual([userATicket.ticketId]);

    const directResponse = await fetch(`${baseUrl}/api/tickets/${encodeURIComponent(userBTicket.ticketId)}`);
    expect(directResponse.status).toBe(404);
  });
});

function mockOidc(sub: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as { oidc?: unknown }).oidc = {
      user: { sub, email: `${sub.replace(/[^a-z0-9]/gi, '-')}@example.test` },
    };
    next();
  };
}
