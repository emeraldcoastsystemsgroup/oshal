/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Isolated real HTTP administration routes, synthetic identities and temporary process-log data.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { createCockpitRoutes } from '@/app/routes/cockpit-routes';
import { registerLegacyEngineeringCompatRoutes } from '@/app/routes/legacy-engineering-compat-routes';
import * as builders from '@/app/routes/legacy-engineering-compat-builders';
import { LogReaderService } from '@/features/logging';
import type { AppContext } from '@/app/composition-root';

/** @description Exercise actual mounted routes against isolated data, never a live log or provider. @returns Local HTTP fixture and cleanup. */
export async function operatorAdministrationFixture() {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'fixture-operator'); vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  const directory = await mkdtemp(path.join(tmpdir(), 'operator-administration-'));
  const logFile = path.join(directory, 'controller.log');
  await writeFile(logFile, JSON.stringify({ level: 30, time: Date.now(), module: 'fixture-module', msg: 'PRIVATE PROCESS LOG' }) + '\n');
  const logReader = new LogReaderService(logFile);
  const query = LogReaderService.prototype.query, modules = LogReaderService.prototype.getModules;
  const logQuery = vi.spyOn(LogReaderService.prototype, 'query').mockImplementation(input => query.call(logReader, input));
  const logModules = vi.spyOn(LogReaderService.prototype, 'getModules').mockImplementation(() => modules.call(logReader));
  const listTickets = vi.fn(async () => []), listTasks = vi.fn(async () => []);
  const aggregate = vi.fn(() => ({ privateMarker: 'GLOBAL METRICS' }));
  const recent = vi.fn(() => [{ ticketId: 'foreign-ticket', agentId: 'foreign-bot', outcome: 'complete' }]);
  const snapshot = vi.spyOn(builders, 'collectRuntimeSnapshot').mockResolvedValue({ tasks: [], tickets: [], runs: [],
    workItems: [{ id: 'foreign-work', externalId: 'foreign-ticket', status: 'routing_failed', metadata: { routingFailure: { reason: 'PRIVATE ROUTING FAILURE' } } }],
    routingDecisions: [], channels: [], schedules: [] });
  const ctx = { ticketService: { listTickets }, taskStore: { list: listTasks }, messageStore: {},
    swarm: { swarmMetricsCollector: { getAggregatedMetrics: aggregate, getRecentMetrics: recent } } } as unknown as AppContext;
  const app = express(); app.use(express.json());
  const requiresAuth: express.RequestHandler = (req, res, next) => {
    const user = req.get('x-fixture-user');
    if (user !== 'member' && user !== 'operator') { res.sendStatus(401); return; }
    Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: `fixture-${user}`, iss: 'https://identity.example.test' } } }); next();
  };
  app.use('/api/v1', requiresAuth, createCockpitRoutes(ctx));
  registerLegacyEngineeringCompatRoutes({ app, ctx, requiresAuth } as never);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { logQuery, logModules, listTickets, listTasks, aggregate, recent, snapshot,
    call: (route: string, user = 'member') => fetch(base + route, { headers: { 'x-fixture-user': user } }),
    close: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
      vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); },
  };
}
