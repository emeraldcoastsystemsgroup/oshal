import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCockpitRoutes } from '../../src/app/routes/cockpit-routes';

function appFor(sub: string, getTicket: ReturnType<typeof vi.fn>) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as { oidc?: unknown }).oidc = {
      user: { sub, email: `${sub}@example.test` },
    };
    next();
  });
  app.use('/api/v1', createCockpitRoutes({
    ticketService: {
      createTicket: vi.fn(),
      listTickets: vi.fn(async () => []),
      getTicket,
    },
    taskStore: { list: vi.fn(async () => []) },
    messageStore: {},
  } as never));
  return app;
}

describe('cockpit ticket detail route', () => {
  const servers: Array<{ close: (cb: () => void) => void }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
    servers.length = 0;
    vi.restoreAllMocks();
  });

  it('returns JSON for the authenticated owner', async () => {
    const getTicket = vi.fn(async () => ({
      ticketId: 'ticket-123',
      title: 'Owned ticket',
      status: 'approved',
      ownerSub: 'auth0|owner',
    }));
    const server = appFor('auth0|owner', getTicket).listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/tickets/ticket-123`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      ticket: { ticketId: 'ticket-123', ownerSub: 'auth0|owner' },
    });
  });

  it('fails closed for another user direct ticket id', async () => {
    const getTicket = vi.fn(async () => ({
      ticketId: 'ticket-123',
      title: 'Other user ticket',
      status: 'approved',
      ownerSub: 'auth0|other',
    }));
    const server = appFor('auth0|owner', getTicket).listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/tickets/ticket-123`);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ success: false });
  });
});

