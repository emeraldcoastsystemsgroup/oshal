/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Real swarm controller, run/intake services and operator guard over isolated data and a recorded Plane adapter.
 */
import express, { type RequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import { createSwarmOrchestrationRoutes } from '@/app/extensions/swarm/routes/swarm-orchestration-routes';
import { SwarmOrchestrationController } from '@/features/swarm-orchestration/controllers/swarm-orchestration-controller';
import { SwarmTicketProcessingService } from '@/features/swarm-orchestration/services/swarm-ticket-processing-service';
import { InMemorySwarmRunStore } from '@/features/swarm-orchestration/services/swarm-run-store';
import { InMemorySwarmEscalationStore } from '@/features/swarm-orchestration/services/swarm-escalation-store';
import { IntakeService } from '@/features/intake/services/intake-service';
import { InMemoryIntakeCursorStore } from '@/features/intake/services/intake-cursor-store';
import { buildExternalTicketHierarchy, buildExternalTicketWorkflow, ExternalWorkItemSchema } from '@/entities/ticket';
import { WorkItemSchema, type WorkItemRepository } from '@/entities/work-item';
import { clearPrivilegedIdentities, setPrivilegedIdentities } from '@/shared/middleware/privileged-identities';

/** @description Synthetic validated-session seam; the mounted production operator gate is unchanged. @param req Request. @param res Response. @param next Middleware. */
const authenticate: RequestHandler = (req, res, next) => {
  const user = req.get('x-fixture-user');
  if (!['member', 'operator', 'breakglass'].includes(user ?? '')) { res.sendStatus(401); return; }
  const sub = `fixture-${user}`;
  Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub },
    idTokenClaims: { sub, iss: 'https://identity.example.test', aud: 'oshal' } } });
  next();
};

/** @description Isolated run records, work-item repository seam and Plane adapter; processing writes cannot invoke a provider/model. @returns Services and read/effect recorders. */
async function isolatedSwarm() {
  const runStore = new InMemorySwarmRunStore();
  await runStore.create({ runId: 'foreign-run', provider: 'plane', startedAt: '2026-01-01T00:00:00Z' });
  await runStore.fail('foreign-run', new Error('PRIVATE RUN OUTPUT'), []);
  const listRuns = vi.spyOn(runStore, 'list'), getRun = vi.spyOn(runStore, 'get');
  const work = WorkItemSchema.parse({ workItemId: '00000000-0000-4000-8000-000000000001',
    swarmRunId: 'foreign-run', externalId: 'foreign-ticket', provider: 'plane', unitId: 'foreign-unit',
    title: 'PRIVATE WORK', executionOutput: 'PRIVATE EXECUTION', verificationResult: 'PRIVATE VERIFICATION',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
  const recent = vi.fn(async () => [work]), external = vi.fn(async () => [work]), byRun = vi.fn(async () => [work]);
  const repository = { listRecent: recent, findByExternalIdAnyProvider: external, findByRunId: byRun } as unknown as WorkItemRepository;
  const planeItem = ExternalWorkItemSchema.parse({ provider: 'plane', externalId: 'foreign-ticket',
    title: 'PRIVATE PLANE', workflow: buildExternalTicketWorkflow('approved'),
    hierarchy: buildExternalTicketHierarchy('foreign-ticket'), rawPayload: { privateMarker: 'PRIVATE PLANE PAYLOAD' } });
  const pullPlane = vi.fn(async () => ({ items: [planeItem], source: 'isolated-plane', nextCursor: 'fixture-next' }));
  const cursor = new InMemoryIntakeCursorStore(), getCursor = vi.spyOn(cursor, 'getCursor'), setCursor = vi.spyOn(cursor, 'setCursor');
  const intake = new IntakeService([{ provider: 'plane', pullWorkItems: pullPlane }], cursor);
  const processing = new SwarmTicketProcessingService(intake, runStore);
  const result = { runId: 'submitted-run', provider: 'direct' as const, source: 'fixture', effectiveCursor: null,
    pulledCount: 1, processedCount: 1, processed: [] };
  const submit = vi.spyOn(processing, 'processTickets').mockResolvedValue(result);
  const process = vi.spyOn(processing, 'processProvider').mockResolvedValue({ ...result, provider: 'plane' });
  const escalations = new InMemorySwarmEscalationStore(), escalationRead = vi.spyOn(escalations, 'list');
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const controller = new SwarmOrchestrationController(processing, intake, escalations, logger, repository);
  return { controller, listRuns, getRun, recent, external, byRun, pullPlane, getCursor, setCursor, submit, process, escalationRead };
}

/** @description Mount the real router/controller on loopback with explicit isolated authentication and data seams. @returns Requests, read recorders and cleanup. */
export async function swarmAdministrationFixture() {
  clearPrivilegedIdentities();
  setPrivilegedIdentities([{ sub: 'fixture-operator', email: null, role: 'admin' }]);
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'fixture-breakglass'); vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  const services = await isolatedSwarm(), app = express(); app.use(express.json());
  app.use('/api/swarm', authenticate, createSwarmOrchestrationRoutes(services.controller));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { ...services,
    call: (route: string, user = 'member', method = 'GET', body?: unknown) => fetch(base + '/api/swarm' + route,
      { method, headers: { 'x-fixture-user': user, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    close: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
      clearPrivilegedIdentities(); vi.restoreAllMocks(); vi.unstubAllEnvs(); },
  };
}
