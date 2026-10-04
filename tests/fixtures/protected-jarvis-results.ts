/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Compose real Jarvis HTTP and isolated PostgreSQL with completed signed application execution fixtures.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Serve the real Jarvis page and its browser assets from this origin (absolute api dir, shared asset attach) and expose the base URL so Chromium cases run against the same real router and database.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Compose the canonical ticket service/store and seed completed owner-stamped records before protected return proofs; signed executions and task lineage remain independent.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Bind notice owner/snapshot/authorization to the real fixture policy and expose trusted PAT, guest and consumed-delegation rail fixtures; use an explicitly unsigned three-part fixture carrier through the real delegation parser without granting results.
 */
import express, { type RequestHandler } from 'express';
import { CreateInternalTicketSchema, type InternalTicket } from '@/entities/ticket';
import { InMemoryTicketStore, InMemoryWorkspaceStore, TicketService, WorkspaceService } from '@/features/ticketing';
import type { AuthorizationActor } from '@/shared/application-authorization';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createProtectedResultFixture, RESULT_AGENT, RESULT_APP } from './protected-results';
import { createWorkloadDelegationMiddleware, getVerifiedWorkloadDelegation } from '@/features/security';
import { GUEST_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { attachJarvisBrowserAssets } from './jarvis-package-tools-browser';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';
import { createJarvisRoutes } from '@/app/routes/jarvis-routes';
import { createTicketRoutes } from '@/app/routes/ticket-routes';
import { ensureJarvisSchema } from '@/app/routes/jarvis-task-store';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';

/** @description Unsigned deterministic carrier for the explicit verifier/consume doubles; never a usable signed credential. */
const NOTICE_DELEGATION_BEARER = [Buffer.from(JSON.stringify({ typ: 'OSHAL-DLG' })).toString('base64url'), 'fixture', 'fixture'].join('.');

/**
 * @description Seed one actual completed ticket through canonical creation under the fixture's verified owner identity.
 * @param tickets Canonical isolated ticket service. @param actor Current fixture owner.
 * @returns Actual generated UUID and owner/issuer provenance; no execution metadata is copied.
 */
async function createCompletedTicket(tickets: TicketService, actor: AuthorizationActor): Promise<InternalTicket> {
  return runWithRequestIdentity({ sub: actor.sub, principalIssuer: actor.issuer, isOperator: false },
    () => tickets.createTicket(CreateInternalTicketSchema.parse({ title: 'Completed fixture work', ticketType: 'task',
      status: 'complete', ownerSub: actor.sub })));
}

/** @description Use the installed real policy for every notice decision; the map/generation are controller-owned fixture facts.
 * @param fixture Canonical result fixture. @returns No grants or new authority; the existing service makes each decision.
 */
function bindNoticePolicy(fixture: Awaited<ReturnType<typeof createProtectedResultFixture>>): void {
  Object.assign(fixture.ctx.applicationAuthorization!, {
    owner: (kind: string, id: string) => kind === 'bots' && id === RESULT_AGENT ? RESULT_APP : undefined,
    snapshot: (app: string) => {
      const current = fixture.policy.getApp(app);
      return app === RESULT_APP && current ? { app, source: current.source,
        catalogRevision: current.catalogRevision, generation: 'fixture-generation' } : null;
    },
    authorize: fixture.policy.authorize.bind(fixture.policy),
  });
}

/** @description Exercise real private delegated-marker attachment with explicit signature/consume seams; not a live credential proof.
 * @param fixture Server-owned actor map. @param observed Marker observation callback. @returns Real route middleware with bounded fixture seams.
 */
function noticeDelegation(fixture: Awaited<ReturnType<typeof createProtectedResultFixture>>, observed: () => void): RequestHandler {
  const gate = createWorkloadDelegationMiddleware({ env: { OSHAL_WORKLOAD_DELEGATION_MODE: 'enforce' },
    fallback: (_req, res) => { res.sendStatus(401); }, store: { consumeDelegation: async () => 'authorized' } as never,
    verifier: { verify: (_token: string, expected: { iss: string; aud: string; method: string; path: string; body_sha256: string; scope: string[] }) => ({
      ...expected, sub: fixture.actors.alice.sub, principal_iss: fixture.actors.alice.issuer, azp: RESULT_AGENT,
      task_id: 'notice-fixture-delegation', jti: 'notice-fixture-one-use', iat: 1, nbf: 1, exp: 2 }) } });
  return (req, res, next) => gate(req, res, () => {
    if (getVerifiedWorkloadDelegation(req)) observed();
    next();
  });
}

/** @description Inject explicit verified-session fixture rails; only the real delegation middleware creates its private marker.
 * @param fixture Current actor map. @param delegated Real marker gate. @returns Server-owned synthetic browser/PAT/guest identity seam.
 */
function jarvisFixtureIdentity(fixture: Awaited<ReturnType<typeof createProtectedResultFixture>>, delegated: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const user = String(req.get('x-fixture-user') || ''), actor = fixture.actors[user];
    if (!actor) { res.sendStatus(401); return; }
    if (user === 'delegated') { void delegated(req, res, next); return; }
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true,
      user: { sub: actor.sub, iss: actor.issuer, ...(user === 'guest' ? { is_guest: true } : {}) },
      ...(user === 'cli' ? { idToken: 'cli-token', accessToken: 'cli-token' } : {}),
      ...(user === 'guest' ? { idToken: 'guest-token' } : {}) };
    runWithRequestIdentity({ sub: actor.sub, principalIssuer: actor.issuer, isOperator: false }, next);
  };
}

/**
 * @description Mount real Jarvis routes over disposable storage and server-owned fixture authentication.
 * @param database - Already started, isolated PostgreSQL lifetime owned by this suite.
 * @returns Actual route controls and cleanup, without using an operator database or model.
 */
export async function createProtectedJarvisFixture(database: DisposableAlertPostgres) {
  const fixture = await createProtectedResultFixture(), pool = database.pool;
  bindNoticePolicy(fixture);
  fixture.actors.cli = { ...fixture.actors.alice };
  fixture.actors.delegated = { ...fixture.actors.alice };
  fixture.actors.guest = { ...fixture.actors.alice, issuer: GUEST_PRINCIPAL_ISSUER };
  await ensureJarvisSchema(pool); await pool.query('TRUNCATE jarvis_tasks');
  const ticketStore = new InMemoryTicketStore(), tickets = new TicketService(ticketStore);
  const ctx = Object.assign(fixture.ctx, { pool, ticketService: tickets,
    workspaceService: new WorkspaceService(new InMemoryWorkspaceStore(), ticketStore) });
  const app = express(); app.use(express.json());
  const rails = { delegated: 0 };
  app.use(jarvisFixtureIdentity(fixture, noticeDelegation(fixture, () => { rails.delegated += 1; })));
  attachJarvisBrowserAssets(app);
  app.use('/api/jarvis', createJarvisRoutes(ctx as never, resolve('src/api'), async () => new Map()));
  app.use('/api/tickets', createTicketRoutes(ctx));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, user = 'alice', body?: unknown) => fetch(base + '/api/jarvis' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'x-fixture-user': user, 'content-type': 'application/json',
      ...(user === 'delegated' ? { authorization: 'Bearer ' + NOTICE_DELEGATION_BEARER } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { ...fixture, pool, call, base, tickets, rails,
    seedCompletedTicket: (user = 'alice') => createCompletedTicket(tickets, fixture.actors[user]),
    async close() { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await fixture.close(); } };
}
