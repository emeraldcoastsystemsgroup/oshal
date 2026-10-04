/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise the real Jarvis overview and canonical operator/service containment so personal panels survive without global fleet reads or projection.
 */
import express, { type RequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJarvisRoutes } from '@/app/routes/jarvis-routes';
import { SwarmBotRegistry } from '@/app/extensions/swarm/swarm-bot-registry';
import { hasAuthenticatedUserIdentity, serviceSecretOr } from '@/shared/middleware/authz';

const OWNER = 'oidc|fleet-viewer', OPERATOR = 'oidc|fleet-operator';
const SERVICE_SECRET = 'unit-jarvis-fleet-sentinel';
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', OPERATOR);
  vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  vi.stubEnv('SWARM_SERVICE_SECRET', SERVICE_SECRET);
});
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(close => close()));
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

/** @description Supply identifiable fleet sources and caller-owned personal records without any provider execution. */
function sources() {
  const definitions = vi.spyOn(SwarmBotRegistry, 'listDefinitions').mockReturnValue([
    { agentId: 'inline', name: 'Fixture inline', container: 'oshal-api', port: 0, role: 'fixture', capabilities: ['one'] },
    { agentId: 'online', name: 'Fixture worker', container: 'oshal-worker', port: 0, role: 'fixture', capabilities: ['two'] },
    { agentId: 'disabled', name: 'Fixture disabled', container: 'oshal-api', port: 0, role: 'fixture', capabilities: [] },
  ]);
  const online = vi.fn(async (): Promise<string[]> => ['online']);
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT DISTINCT agent_id FROM chat_tasks')) return { rows: [{ agent_id: 'online' }] };
    if (sql.includes("FROM agents WHERE status IN")) return { rows: [{ agent_id: 'disabled' }] };
    if (sql.includes('FROM oshal_inbox_messages')) return { rows: [
      { from_addr: 'fixture@example.invalid', subject: 'Own message for ' + params[0], snippet: 'Own signal', received_at: '2026-10-04' },
    ] };
    return { rows: [], rowCount: 0 };
  });
  const listTickets = vi.fn(async ({ ownerSub }: { ownerSub: string }) => [{
    ticketId: 'own-ticket', title: 'Own work for ' + ownerSub, ownerSub, status: 'approved', updatedAt: '2026-10-04',
  }]);
  return { definitions, online, query, listTickets };
}

/** @description Mount the shipped router and real service-secret containment with a synthetic verified-user seam. */
async function serve(source: ReturnType<typeof sources>) {
  const app = express();
  app.use((req, _res, next) => {
    const sub = req.header('x-test-authenticated-sub');
    if (sub) (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub } };
    next();
  });
  const userAuth: RequestHandler = (req, res, next) => {
    if (hasAuthenticatedUserIdentity(req)) next();
    else res.status(401).json({ error: 'not_authenticated' });
  };
  const pool = { query: source.query, connect: async () => ({ query: source.query, release() {} }) };
  app.use('/api/jarvis', serviceSecretOr(userAuth), createJarvisRoutes({
    pool, ticketService: { listTickets: source.listTickets },
    swarm: { runtimeRegistryService: { listOnlineAgentIds: source.online } },
  } as never, process.cwd()));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  source.definitions.mockClear(); source.query.mockClear();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jarvis/overview`;
}

/** @description Assert that neither global registry/online status nor unscoped fleet SQL was consulted. */
function noFleetRead(source: ReturnType<typeof sources>) {
  expect(source.definitions).not.toHaveBeenCalled();
  expect(source.online).not.toHaveBeenCalled();
  expect(source.query.mock.calls.some(([sql]) => sql.includes('SELECT DISTINCT agent_id FROM chat_tasks')
    || sql.includes('FROM agents WHERE status IN'))).toBe(false);
}

describe('Jarvis overview fleet admission', () => {
  it('keeps ordinary caller personal panels with no fleet field or fleet reads', async () => {
    const source = sources(), url = await serve(source);
    const response = await fetch(url, { headers: { 'x-test-authenticated-sub': OWNER } });
    const body = await response.json();
    expect(response.status).toBe(200); expect(body).not.toHaveProperty('bots'); noFleetRead(source);
    expect(source.listTickets).toHaveBeenCalledWith({ ownerSub: OWNER, limit: 100 });
    expect(body.activity).toMatchObject({ openCount: 1, tickets: [{ title: 'Own work for ' + OWNER }] });
    expect(body.comms.signals).toMatchObject([{ subject: 'Own message for ' + OWNER }]);
    expect(body.calendar).toEqual({ events: [] });
    for (const [sql, params] of source.query.mock.calls) {
      if (sql.includes('WHERE user_sub = $1')) expect(params).toEqual([OWNER]);
    }
  });

  it('ignores forged role/scope and operator-sub compatibility headers on an authenticated viewer', async () => {
    const source = sources(), url = await serve(source);
    const response = await fetch(url + '?scope=all&isOperator=true', { headers: {
      'x-test-authenticated-sub': OWNER, 'X-Service-Secret': SERVICE_SECRET, 'X-Oshal-User-Sub': OPERATOR,
      'X-Oshal-Workload-Id': 'fixture-operator-sentinel',
    } });
    const body = await response.json();
    expect(response.status).toBe(200); expect(body).not.toHaveProperty('bots'); noFleetRead(source);
    expect(source.listTickets).toHaveBeenCalledWith({ ownerSub: OWNER, limit: 100 });
  });

  it('preserves actual operator roster/online/active flags and personal panels', async () => {
    const source = sources(), url = await serve(source);
    const response = await fetch(url, { headers: { 'x-test-authenticated-sub': OPERATOR } });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.bots).toMatchObject([
      { agentId: 'inline', name: 'Fixture inline', online: true, active: false, capabilities: ['one'] },
      { agentId: 'online', online: true, active: true }, { agentId: 'disabled', online: false, active: false },
    ]);
    expect(source.definitions).toHaveBeenCalledOnce(); expect(source.online).toHaveBeenCalledOnce();
    expect(source.listTickets).toHaveBeenCalledWith({ ownerSub: OPERATOR, limit: 100 });
    expect(body.calendar).toEqual({ events: [] });
  });

  it('retains a genuine empty operator roster instead of treating it as unavailable', async () => {
    const source = sources(); source.definitions.mockReturnValue([]); source.online.mockResolvedValue([]);
    const url = await serve(source);
    const response = await fetch(url, { headers: { 'x-test-authenticated-sub': OPERATOR } });
    expect(response.status).toBe(200); expect((await response.json()).bots).toEqual([]);
    expect(source.definitions).toHaveBeenCalledOnce();
  });

  it('refuses unsigned requests before personal or fleet reads', async () => {
    const source = sources(), url = await serve(source);
    const response = await fetch(url);
    expect(response.status).toBe(401); noFleetRead(source); expect(source.listTickets).not.toHaveBeenCalled();
  });

  it('retains machine-only legacy-secret refusal even when an operator subject is asserted', async () => {
    const source = sources(), url = await serve(source);
    const response = await fetch(url, { headers: { 'X-Service-Secret': SERVICE_SECRET, 'X-Oshal-User-Sub': OPERATOR } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'legacy_service_identity_not_allowed' });
    noFleetRead(source); expect(source.listTickets).not.toHaveBeenCalled();
  });
});
