/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify nonoperator summary and cost isolation even when a global scope is requested.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Prove global fleet reads and projections require an operator while own work totals and true fleet zero remain valid.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCockpitRoutes } from '../../src/app/routes/cockpit-routes';
import { getActiveRegistry } from '../../src/app/extensions/swarm/swarm-bot-registry';

vi.mock('../../src/app/extensions/swarm/swarm-bot-registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/app/extensions/swarm/swarm-bot-registry')>(),
  getActiveRegistry: vi.fn(() => []),
}));

const ENV_KEYS = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS'];
let savedEnv: Record<string, string | undefined>;
const servers: Array<{ close: (cb: () => void) => void }> = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  vi.mocked(getActiveRegistry).mockReset().mockReturnValue([]);
});

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
  servers.length = 0;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

/** @description Supply identifiable private/global sources to the real mounted summary handler. */
function metricsSources() {
  const tickets = [
    { ticketId: 'ticket-a', title: 'A', status: 'approved', ownerSub: 'auth0|user-a' },
    { ticketId: 'ticket-b', title: 'B', status: 'approved', ownerSub: 'auth0|user-b' },
  ];
  const listTickets = vi.fn(async (options: { ownerSub?: string }) => (
    options.ownerSub ? tickets.filter((ticket) => ticket.ownerSub === options.ownerSub) : tickets
  ));
  const poolQuery = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('GROUP BY EXTRACT(HOUR FROM updated_at)')) return { rows: [{ hour: '12', amount: '1.50' }] };
    if (sql.includes('SUM(total_cost)') && sql.includes('FROM chat_tasks')) return { rows: [{ total: '1.50' }] };
    if (sql.includes('FROM work_items')) return { rows: [{ cnt: '1' }] };
    if (sql.includes('FROM agents')) return { rows: [{ agent_id: 'disabled', name: 'disabled', status: 'disabled' }] };
    return { rows: [] };
  });
  const registry = {
    listOnlineAgentIds: vi.fn(async (): Promise<string[]> => ['online']),
    listAgentRegistrations: vi.fn(async (): Promise<Array<{ agentId: string; agentName: string; status: string }>> => [
      { agentId: 'online', agentName: 'online', status: 'online' },
    ]),
  };
  const definition = { port: 0, role: 'fixture', capabilities: [] };
  vi.mocked(getActiveRegistry).mockReturnValue([
    { ...definition, agentId: 'inline', name: 'inline', container: 'oshal-api' },
    { ...definition, agentId: 'online', name: 'online', container: 'oshal-online' },
    { ...definition, agentId: 'offline', name: 'offline', container: 'oshal-offline' },
    { ...definition, agentId: 'disabled', name: 'disabled', container: 'oshal-api' },
  ]);
  return { listTickets, poolQuery, registry };
}

/** @description Mount the actual router with a synthetic authenticated principal and real HTTP transport. */
async function summary(sources: ReturnType<typeof metricsSources>, sub = 'auth0|user-a', query = '') {
  const app = express();
  app.use(express.json());
  app.use(mockOidc(sub));
  app.use('/api/v1', createCockpitRoutes({
    ticketService: { createTicket: vi.fn(), listTickets: sources.listTickets, getTicket: vi.fn(async () => null) },
    taskStore: { list: vi.fn(async () => []) }, messageStore: {},
    pool: { query: sources.poolQuery }, swarm: { runtimeRegistryService: sources.registry },
  } as never));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/metrics/summary${query}`);
  return { status: response.status, body: await response.json() };
}

describe('cockpit metrics isolation route', () => {
  it('hard-scopes nonoperator summary and costs even when scope=all is requested', async () => {
    const sources = metricsSources();
    const { status, body } = await summary(sources, 'auth0|user-a', '?scope=all');
    expect(status).toBe(200);
    expect(sources.listTickets).toHaveBeenCalledWith(expect.objectContaining({ ownerSub: 'auth0|user-a' }));
    expect(body.data.total).toBe(1);
    expect(body.data.queue).toBe(1);
    expect(body.data.estimatedTotalCost).toBe(1.5);
    expect(body.data.costSeries.reduce((sum: number, bucket: { amount: number }) => sum + bucket.amount, 0)).toBe(1.5);
    for (const [sql, params] of sources.poolQuery.mock.calls) {
      if (sql.includes('FROM chat_tasks')) expect(params).toEqual(['auth0|user-a']);
    }
  });

  it.each(['', '?scope=all'])('omits global fleet and never reads its sources for a nonoperator (%s)', async (query) => {
    const sources = metricsSources();
    const { status, body } = await summary(sources, 'auth0|user-a', query);
    expect(status).toBe(200);
    expect(body.data).not.toHaveProperty('agents');
    expect(body.data).not.toHaveProperty('swarmHealth');
    expect(sources.registry.listOnlineAgentIds).not.toHaveBeenCalled();
    expect(sources.registry.listAgentRegistrations).not.toHaveBeenCalled();
    expect(getActiveRegistry).not.toHaveBeenCalled();
    expect(sources.poolQuery.mock.calls.some(([sql]) => /FROM (agents|work_items)\b/.test(sql))).toBe(false);
    expect(body.data.total).toBe(1);
    expect(body.data.queue).toBe(1);
  });

  it('preserves real operator fleet health/state and scoped own work by default', async () => {
    process.env.OSHAL_OPERATOR_SUBS = 'auth0|user-a';
    const sources = metricsSources();
    const { status, body } = await summary(sources);
    expect(status).toBe(200);
    expect(body.data.agents).toEqual({ total: 2, online: 2, busy: 1, idle: 1 });
    expect(body.data.swarmHealth).toEqual({ healthy: 2, degraded: 1, offline: 1 });
    expect(sources.registry.listOnlineAgentIds).toHaveBeenCalledOnce();
    expect(sources.registry.listAgentRegistrations).toHaveBeenCalledOnce();
    expect(sources.poolQuery.mock.calls.some(([sql]) => sql.includes('FROM work_items'))).toBe(true);
    expect(sources.listTickets).toHaveBeenCalledWith(expect.objectContaining({ ownerSub: 'auth0|user-a' }));
    expect(body.data.total).toBe(1);
    expect(body.data.estimatedTotalCost).toBe(1.5);
  });

  it('preserves operator global-work override and legitimate zero fleet', async () => {
    process.env.OSHAL_OPERATOR_SUBS = 'auth0|user-a';
    const sources = metricsSources();
    vi.mocked(getActiveRegistry).mockReturnValue([]);
    sources.registry.listOnlineAgentIds.mockResolvedValue([]);
    sources.registry.listAgentRegistrations.mockResolvedValue([]);
    const { status, body } = await summary(sources, 'auth0|user-a', '?scope=all');
    expect(status).toBe(200);
    expect(body.data.agents).toEqual({ total: 0, online: 0, busy: 0, idle: 0 });
    expect(body.data.swarmHealth).toEqual({ healthy: 0, degraded: 0, offline: 0 });
    expect(sources.listTickets).toHaveBeenCalledWith(expect.objectContaining({ ownerSub: undefined }));
    expect(body.data.total).toBe(2);
  });
});

/** @description Represent a logged-in HTTP caller without granting an operator role implicitly. */
function mockOidc(sub: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as { oidc?: unknown }).oidc = { user: { sub, email: `${sub.replace(/[^a-z0-9]/gi, '-')}@example.test` } };
    next();
  };
}
