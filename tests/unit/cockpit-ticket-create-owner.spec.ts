import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCockpitRoutes } from '../../src/app/routes/cockpit-routes';

describe('cockpit ticket creation ownership', () => {
  const servers: Array<{ close: (cb: () => void) => void }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
    servers.length = 0;
    vi.restoreAllMocks();
  });

  it('stamps /api/v1/tickets creates with the authenticated caller sub', async () => {
    const createTicket = vi.fn(async (input: Record<string, unknown>) => ({
      ticketId: 'ticket-123',
      title: input.title,
      ticketType: input.ticketType,
      status: input.status,
      ownerSub: input.ownerSub,
      priority: input.priority,
      labels: input.labels,
      metadata: input.metadata,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as { oidc?: unknown }).oidc = {
        user: { sub: 'auth0|creator-a', email: 'creator@example.test' },
      };
      next();
    });
    app.use('/api/v1', createCockpitRoutes({
      ticketService: {
        createTicket,
        listTickets: vi.fn(async () => []),
        getTicket: vi.fn(async () => null),
      },
      taskStore: {},
      messageStore: {},
    } as never));

    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Fresh build ownership proof',
        description: 'Verify cockpit-created build tickets are owned.',
        ticketType: 'build',
        status: 'approved',
        priority: 'medium',
        labels: ['verification'],
      }),
    });

    expect(response.status).toBe(200);
    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(createTicket.mock.calls[0][0]).toMatchObject({
      title: 'Fresh build ownership proof',
      ticketType: 'build',
      status: 'approved',
      ownerSub: 'auth0|creator-a',
    });
  });
});
