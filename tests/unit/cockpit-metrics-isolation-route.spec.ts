import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCockpitRoutes } from '../../src/app/routes/cockpit-routes';

const ENV_KEYS = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('cockpit metrics isolation route', () => {
  const servers: Array<{ close: (cb: () => void) => void }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
    servers.length = 0;
    vi.restoreAllMocks();
  });

  it('hard-scopes non-operator summary and cost queries even when scope=all is requested', async () => {
    const tickets = [
      { ticketId: 'ticket-a', title: 'A', status: 'approved', ownerSub: 'auth0|user-a' },
      { ticketId: 'ticket-b', title: 'B', status: 'approved', ownerSub: 'auth0|user-b' },
    ];
    const listTickets = vi.fn(async (options: { ownerSub?: string }) => (
      options.ownerSub ? tickets.filter((ticket) => ticket.ownerSub === options.ownerSub) : tickets
    ));
    const poolQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('GROUP BY EXTRACT(HOUR FROM updated_at)')) {
        expect(params).toEqual(['auth0|user-a']);
        return { rows: [{ hour: '12', amount: '1.50' }] };
      }
      if (sql.includes('SUM(total_cost)') && sql.includes('FROM chat_tasks')) {
        expect(params).toEqual(['auth0|user-a']);
        return { rows: [{ total: '1.50' }] };
      }
      if (sql.includes('FROM work_items')) {
        return { rows: [{ cnt: '0' }] };
      }
      return { rows: [] };
    });

    const app = express();
    app.use(express.json());
    app.use(mockOidc('auth0|user-a'));
    app.use('/api/v1', createCockpitRoutes({
      ticketService: {
        createTicket: vi.fn(),
        listTickets,
        getTicket: vi.fn(async () => null),
      },
      taskStore: { list: vi.fn(async () => []) },
      messageStore: {},
      pool: { query: poolQuery },
    } as never));

    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/metrics/summary?scope=all`);
    const body = await response.json() as { data: { total: number; estimatedTotalCost: number; costSeries: Array<{ amount: number }> } };

    expect(response.status).toBe(200);
    expect(listTickets).toHaveBeenCalledWith(expect.objectContaining({ ownerSub: 'auth0|user-a' }));
    expect(body.data.total).toBe(1);
    expect(body.data.estimatedTotalCost).toBe(1.5);
    expect(body.data.costSeries.reduce((sum, bucket) => sum + bucket.amount, 0)).toBe(1.5);
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
