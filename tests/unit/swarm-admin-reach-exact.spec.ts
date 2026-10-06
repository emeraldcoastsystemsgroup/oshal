/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 S02 guard: the swarm admin's reach is exact. Pure (swarmAdminMayReach) and over HTTP (the real guard): the never-list is exported, checked first (a widened rule set cannot reopen it) and refuses every method on /api/remote-clients, /api/cli-tokens and /api/join and beneath them, in any case; the node worker plane, the caller's CLI tokens and enrolment are pinned; the routes that act as the caller inside the narrowed routers (connectors, channels, shared memory, notify, dev console, the app clone, the n8n pack import, the onboarding progress, and every write of the Security Center, the personal graph, the Test Lab and the persona evals) are refused, including their case variants; the admin's own calls into the same routers stay allowed, among them the apps router's install-remote, schedule control and service activation and deactivation, and the reads of the four routers that became read-only. Service activation is proven end to end through the real guard, the real activation route and the real activation service: the admin is refused a user activation (403 swarm_admin_not_a_user, in any case of the path, with no activation stored and no schedule instance registered for it), while its system activation, a person's own user activation and the admin closing that person's activation all still work. The RAG upload and ingest are proven the same way through the real RAG router: the admin is refused a document it would own itself (a private ingest or upload, an ingest stamped with its own sub, or any ingest or upload while it lacks the operator role), with nothing stored, while its shared-corpus writes and a person's private ingest still work. Every route the narrowed routers declare (read from their source) is decided on purpose: listed as allowed or refused, or, for a read in a router whose reads are one wildcard, passed by the gate. So a narrowing cannot quietly refuse an admin route, and a route added to one of them later must be decided before it is admitted. Every exact call is anchored, lower case and flag-free, nothing in the reach lists names a never-listed path, and the identity lives in a leaf module that imports only ./principal-issuer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Server } from 'node:http';
import express, { type RequestHandler } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApplicationServiceActivations } from '@/app/application-service-activation-wiring';
import { registerApplicationServiceActivationRoutes } from '@/app/routes/application-service-activation-routes';
import { createRagRoutes } from '@/app/routes/rag-routes';
import {
  ApplicationAuthorizationService, ApplicationServiceActivationService,
  MemoryApplicationServiceActivationStore, MemoryAuthorizationStore,
} from '@/features/application-authorization';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { LOCAL_AUTH_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import * as gate from '@/shared/middleware/swarm-admin-scope';
import type { SwarmAdminReachRules } from '@/shared/middleware/swarm-admin-scope';

type Call = [method: string, pathname: string];

const PERSON = { iss: 'https://accounts.google.com', sub: 'google-person-placeholder' };

/** Signs the request in as the swarm admin or an ordinary person, by the x-test-who header; anything else is anonymous. */
const fixtureIdentity: RequestHandler = (req, _res, next) => {
  const who = req.get('x-test-who');
  if (who === 'admin') {
    Object.assign(req, { oidc: { isAuthenticated: () => true, user: { iss: LOCAL_AUTH_PRINCIPAL_ISSUER, sub: gate.SWARM_ADMIN_SUB, oshal_account_kind: 'swarm-admin' } } });
  } else if (who === 'person') {
    Object.assign(req, { oidc: { isAuthenticated: () => true, user: { ...PERSON } } });
  }
  next();
};

/** Listens on a loopback port and resolves the server with its base URL. */
async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

/** Closes a server started by listen(), if it started. */
async function close(server: Server | undefined): Promise<void> {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
}

const NEVER = ['/api/remote-clients', '/api/cli-tokens', '/api/join'];
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const NEVER_CALLS: Call[] = NEVER.flatMap((prefix) => [prefix, `${prefix}/x`].flatMap((p) => METHODS.map((m): Call => [m, p])));

// The node worker plane (remote-client-routes.ts and its task, workspace and print modules), the caller's
// own CLI tokens (cli-token-routes.ts) and enrolment (join-routes.ts, node-installer-routes.ts).
const WORKER_PLANE: Call[] = [
  ['POST', '/api/remote-clients/register'], ['POST', '/api/remote-clients/node-1/heartbeat'],
  ['POST', '/api/remote-clients/node-1/chat'], ['POST', '/api/remote-clients/node-1/swarm/send'],
  ['GET', '/api/remote-clients/node-1/swarm/next'], ['POST', '/api/remote-clients/node-1/tasks'],
  ['GET', '/api/remote-clients/node-1/tasks/next'], ['GET', '/api/remote-clients/node-1/tasks/task-1/result'],
  ['POST', '/api/remote-clients/node-1/tasks/task-1/complete'], ['GET', '/api/remote-clients/node-1/tasks/task-1/workspace'],
  ['GET', '/api/remote-clients/node-1/tasks/task-1/workspace/file'], ['PUT', '/api/remote-clients/node-1/tasks/task-1/workspace/file'],
  ['POST', '/api/remote-clients/node-1/print-documents'], ['POST', '/api/remote-clients/node-1/token/rotate'],
  ['POST', '/api/remote-clients/node-1/owner'], ['GET', '/api/remote-clients'], ['GET', '/api/remote-clients/node-1'],
  ['GET', '/api/cli-tokens/whoami'], ['POST', '/api/cli-tokens'], ['GET', '/api/cli-tokens'], ['DELETE', '/api/cli-tokens/token-1'],
  ['POST', '/api/join/enroll'], ['GET', '/api/join/node-installer'], ['GET', '/api/join'], ['GET', '/api/join/code'],
];

// Routes inside the narrowed routers that the admin must not call. Most act as the caller; the others are named
// where they are listed. Every one is reachable on the old broad prefixes.
const REFUSED: Call[] = [
  // Pack deploy loads from the caller's own pack folder with the caller as owner; no allowed call fills the admin's folder.
  ['POST', '/api/swarm/packs/my-pack/deploy'],
  ['POST', '/api/connectors/jira/search-issues'], ['POST', '/api/connectors/jira/actions/create-issue'],
  ['GET', '/api/connectors/jira/_resources'], ['GET', '/api/connectors/marketplace/my-enablement'],
  ['GET', '/api/connectors/marketplace/my-enablement/'], ['POST', '/api/connectors/marketplace/jira/enable-for-me'],
  ['POST', '/api/connectors/marketplace/jira/disable-for-me'], ['GET', '/api/connectors/actions/audit'],
  ['POST', '/api/channels/telegram/link'], ['DELETE', '/api/channels/telegram/123'], ['POST', '/api/channels/sms/link'],
  ['DELETE', '/api/channels/sms/123'], ['POST', '/api/channels/whatsapp/link'], ['DELETE', '/api/channels/whatsapp/123'],
  ['POST', '/api/channels/discord/link'], ['DELETE', '/api/channels/discord/123'],
  // Telegram's inbound webhook (chat-channel-routes.ts): Telegram calls it with its own secret, never the admin.
  ['POST', '/api/channels/telegram/webhook'],
  ['POST', '/api/swarm/memory/shared/store'], ['GET', '/api/swarm/memory/shared/query'], ['POST', '/api/swarm/memory/shared/context'],
  ['GET', '/api/notify/prefs'], ['POST', '/api/notify/prefs'], ['POST', '/api/notify/test'],
  // The developer console (dev-console-routes.ts), refused apart from the access probe: its sessions are the
  // caller's own, a commit lands the caller's session on a branch, and apply and promote change the live tree.
  ['POST', '/api/dev-console/sessions'], ['GET', '/api/dev-console/sessions'], ['GET', '/api/dev-console/sessions/s-1/stream'],
  ['POST', '/api/dev-console/sessions/s-1/commit'], ['POST', '/api/dev-console/sessions/s-1/discard'],
  ['POST', '/api/dev-console/apply'], ['POST', '/api/dev-console/promote'], ['GET', '/api/dev-console/status'],
  ['GET', '/api/dev-console/health-snapshot'], ['GET', '/api/join/code'],
  ['POST', '/api/swarm/apps/hello-flow/clone'], ['POST', '/api/swarm/packs/import/n8n'],
  ['GET', '/api/user/onboarding'], ['PUT', '/api/user/onboarding'],
  // Security Center writes (security-routes.ts): scans, findings, tickets and assessments are the caller's.
  ['POST', '/api/security/scan'], ['PATCH', '/api/security/findings/f1'], ['POST', '/api/security/findings/f1/assess'],
  ['POST', '/api/security/findings/f1/ticket'],
  // The personal-graph ingest pulls connector data with the caller's token (personal-graph-ingest-routes.ts).
  ['POST', '/api/personal-graph/ingest/github'],
  // Test Lab writes: the golden run files dispatched tickets owned by the caller (test-lab-golden.ts); the
  // scenario run, package runs and schedules act as the caller (test-lab-routes.ts, -run-routes.ts, -schedule-routes.ts).
  ['POST', '/api/test-lab/golden/run'], ['POST', '/api/test-lab/run'], ['POST', '/api/test-lab/runs'],
  ['POST', '/api/test-lab/runs/run-1/cancel'], ['POST', '/api/test-lab/schedules'], ['PATCH', '/api/test-lab/schedules/s-1'],
  ['POST', '/api/test-lab/schedules/s-1/run-now'],
  // The persona-eval run grades with quality-judge brain turns run as the caller (persona-eval-routes.ts).
  ['POST', '/api/persona-evals/run'],
];

// The admin's own calls into the same routers: admin.js (marketplace reads and toggles), channels.html (the
// Discord card), /applications (apps and the Packs link), workflow-studio-data.js (publish), swarm-packs.html (deploy),
// the apps router's operator install, schedule control and service activation (app-store-remote.ts,
// app-schedule-control-routes.ts, application-service-activation-routes.ts), and the reads of the three routers
// that became read-only: the Security Center, the personal graph and the Test Lab.
const ALLOWED: Call[] = [
  ['GET', '/cockpit/tools/dlq.html'], ['HEAD', '/cockpit/tools/channels.html'],
  ['GET', '/api/connectors/marketplace'], ['HEAD', '/api/connectors/marketplace'], ['GET', '/api/connectors/marketplace/'],
  ['GET', '/api/connectors/marketplace/audit-export'], ['GET', '/api/connectors/marketplace/jira'],
  ['POST', '/api/connectors/marketplace/jira/enable'], ['POST', '/api/connectors/marketplace/jira/disable'],
  ['POST', '/api/connectors/marketplace/jira/remove'], ['POST', '/api/connectors/marketplace/jira/audit-refresh'],
  ['DELETE', '/api/connectors/marketplace/jira'],
  ['GET', '/api/channels'], ['GET', '/api/channels/admin/discord'], ['POST', '/api/channels/admin/discord'],
  ['DELETE', '/api/channels/admin/discord'], ['POST', '/api/channels/telegram/register-webhook'],
  ['POST', '/api/swarm/memory/agents/bot-a/bootstrap'], ['POST', '/api/swarm/memory/agents/bot-a/remember'],
  ['POST', '/api/swarm/memory/agents/bot-a/remember-batch'], ['GET', '/api/swarm/memory/agents/bot-a/recall'],
  ['GET', '/api/swarm/memory/agents/bot-a/knowledge'], ['GET', '/api/swarm/memory/agents/bot-a/collections'],
  ['POST', '/api/swarm/memory/shared/w-1/approve'],
  ['POST', '/api/notify/operator'], ['POST', '/api/notify/alert'], ['GET', '/api/dev-console/access'],
  ['GET', '/api/swarm/apps'], ['GET', '/api/swarm/apps/access-matrix'], ['GET', '/api/swarm/apps/hello-flow/export'],
  ['POST', '/api/swarm/apps/load'], ['POST', '/api/swarm/apps/import'], ['POST', '/api/swarm/apps/publish'],
  ['PUT', '/api/swarm/apps/hello-flow/access'], ['PATCH', '/api/swarm/apps/hello-flow/guest-tier'],
  ['PATCH', '/api/swarm/apps/hello-flow/toggle'], ['DELETE', '/api/swarm/apps/hello-flow'],
  ['GET', '/api/swarm/apps/catalog'], ['GET', '/api/swarm/apps/pending'], ['POST', '/api/swarm/apps/install-remote'],
  ['GET', '/api/swarm/apps/hello-flow/schedules'], ['PATCH', '/api/swarm/apps/hello-flow/schedules/nightly'],
  // The gate admits the activation path; the route itself refuses the admin runsAs 'user' (proven at the end).
  ['GET', '/api/swarm/apps/hello-flow/services'], ['POST', '/api/swarm/apps/hello-flow/services/nightly/activate'],
  ['DELETE', '/api/swarm/apps/hello-flow/services/nightly/activation'],
  ['GET', '/api/swarm/packs'], ['GET', '/api/swarm/packs/studio'],
  ['GET', '/api/user'],
  ['GET', '/api/security'], ['HEAD', '/api/security/ui'], ['GET', '/api/security/status'], ['GET', '/api/security/findings'],
  ['GET', '/api/security/findings/f1'], ['GET', '/api/personal-graph/stats'], ['GET', '/api/personal-graph/node/n1/neighbors'],
  ['GET', '/api/test-lab/app'], ['GET', '/api/test-lab/catalog'], ['GET', '/api/test-lab/visual/bar.svg'],
  ['GET', '/api/test-lab/runs'], ['GET', '/api/test-lab/schedules/s-1/history'], ['GET', '/api/test-lab/golden/catalog'],
  ['GET', '/api/test-lab/golden/run/batch-1'],
  ['GET', '/api/persona-evals/suites'], ['GET', '/api/persona-evals/run/run-1'], ['GET', '/api/persona-evals/results'],
  ['GET', '/api/persona-evals/results/report-1.json'],
];

// Express 5 routes case-insensitively: each of these reaches a refused handler, so each must be refused.
const CASE_VARIANTS: Call[] = [
  ['GET', '/api/connectors/marketplace/My-Enablement'], ['GET', '/API/Connectors/Marketplace/MY-ENABLEMENT'],
  ['POST', '/api/connectors/marketplace/Jira/Enable-For-Me'], ['POST', '/api/connectors/Jira/Search-Issues'],
  ['GET', '/api/connectors/Actions/Audit'], ['GET', '/api/notify/PREFS'], ['POST', '/api/Notify/Test'],
  ['POST', '/api/swarm/memory/Shared/Store'], ['POST', '/api/Swarm/Memory/Shared/Store'], ['POST', '/api/channels/Telegram/Link'],
  ['POST', '/api/Dev-Console/Sessions'], ['POST', '/api/swarm/apps/Hello-Flow/CLONE'], ['POST', '/api/swarm/packs/Import/N8N'],
  ['PUT', '/api/user/Onboarding'], ['POST', '/API/Remote-Clients/x/chat'], ['POST', '/Api/Join/Enroll'], ['GET', '/Api/Join/Code'],
  ['GET', '/API/CLI-TOKENS/whoami'], ['POST', '/api/security/Scan'], ['POST', '/api/security/findings/f1/TICKET'],
  ['POST', '/api/personal-graph/Ingest/github'], ['POST', '/api/test-lab/Golden/Run'], ['POST', '/API/Test-Lab/golden/run'],
  ['POST', '/api/persona-evals/RUN'],
];

// The routers this slice narrowed, each file with the path its routes are mounted under. Every route they declare
// must be decided on purpose: classified in ALLOWED, REFUSED or WORKER_PLANE. In a router whose reads are one
// wildcard, a read only has to pass the gate. So a narrowing cannot quietly refuse an admin route, and a route
// added later to one of these routers is not admitted or refused until someone decides which.
const NARROWED: Array<{ mount: string; file: string; readWildcard?: boolean }> = [
  { mount: '/api/connectors', file: 'src/app/routes/connector-marketplace-routes.ts' },
  { mount: '/api/connectors', file: 'src/app/routes/connector-action-audit.ts' },
  { mount: '', file: 'src/app/routes/connector-spec-routes.ts' },
  { mount: '', file: 'src/app/routes/connector-action-routes.ts' },
  { mount: '/api/channels', file: 'src/app/routes/chat-channel-routes.ts' },
  { mount: '/api/channels/admin', file: 'src/app/routes/chat-channel-admin-routes.ts' },
  { mount: '/api/swarm/memory', file: 'src/app/extensions/swarm/routes/memory-routes.ts' },
  { mount: '/api/notify', file: 'src/app/routes/notify-routes.ts' },
  { mount: '/api/dev-console', file: 'src/app/routes/dev-console-routes.ts' },
  { mount: '/api', file: 'src/app/routes/onboarding-routes.ts' },
  { mount: '/api/swarm/apps', file: 'src/app/routes/swarm-app-routes.ts', readWildcard: true },
  { mount: '/api/swarm/apps', file: 'src/app/routes/app-store-remote.ts', readWildcard: true },
  { mount: '/api/swarm/apps', file: 'src/app/routes/app-schedule-control-routes.ts', readWildcard: true },
  { mount: '/api/swarm/apps', file: 'src/app/routes/application-service-activation-routes.ts', readWildcard: true },
  { mount: '/api/swarm/packs', file: 'src/app/routes/swarm-pack-routes.ts', readWildcard: true },
  { mount: '/api/security', file: 'src/app/routes/security-routes.ts', readWildcard: true },
  { mount: '/api/personal-graph', file: 'src/app/routes/personal-graph-routes.ts', readWildcard: true },
  { mount: '/api/personal-graph/ingest', file: 'src/app/routes/personal-graph-ingest-routes.ts', readWildcard: true },
  { mount: '/api/test-lab', file: 'src/app/routes/test-lab-routes.ts', readWildcard: true },
  { mount: '/api/test-lab', file: 'src/app/routes/test-lab-run-routes.ts', readWildcard: true },
  { mount: '/api/test-lab', file: 'src/app/routes/test-lab-schedule-routes.ts', readWildcard: true },
  { mount: '/api/test-lab/golden', file: 'src/app/routes/test-lab-golden.ts', readWildcard: true },
  { mount: '/api/persona-evals', file: 'src/app/routes/persona-eval-routes.ts', readWildcard: true },
];

/** Method and full path of every route a file declares on a router or the app, comments stripped. */
function declaredRoutes(mount: string, file: string): Call[] {
  const source = fs.readFileSync(path.resolve(__dirname, '..', '..', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...source.matchAll(/\b(?:router|app)\.(get|post|put|patch|delete)\(\s*(['"`])(\/[^'"`]*)\2/g)]
    .map(([, method, , route]): Call => [method.toUpperCase(), `${mount}${route}`.replace(/(.)\/$/, '$1')]);
}

/** A declared route as an anchored pattern over concrete paths: each :param is one path segment. */
function routePattern(route: string): RegExp {
  const segments = route.split('/').map((s) => (s.startsWith(':') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return new RegExp(`^${segments.join('/')}/?$`);
}

describe('every route the narrowed routers declare is decided on purpose', () => {
  const CLASSIFIED = [...ALLOWED, ...REFUSED, ...WORKER_PLANE];

  it('reads the routes from every narrowed router file', () => {
    expect(NARROWED.flatMap(({ mount, file }) => declaredRoutes(mount, file)).length).toBeGreaterThan(100);
  });

  it.each(NARROWED)('classifies each route $file declares under $mount', ({ mount, file, readWildcard }) => {
    const routes = declaredRoutes(mount, file);
    expect(routes.length, file).toBeGreaterThan(0);
    const undecided = routes.filter(([method, route]) => {
      if (readWildcard && method === 'GET') return !gate.swarmAdminMayReach(route.replace(/:[^/]+/g, 'p1'), 'GET');
      const pattern = routePattern(route);
      return !CLASSIFIED.some(([m, p]) => m === method && pattern.test(p));
    }).map(([method, route]) => `${method} ${route}`);
    expect(undecided, 'add each to ALLOWED or REFUSED (a wildcard read must pass the gate)').toEqual([]);
  });
});

describe('the never-list', () => {
  it('is exported and names the worker plane, the caller\'s CLI tokens and enrolment', () => {
    expect(gate.SWARM_ADMIN_NEVER_PREFIXES).toEqual(NEVER);
  });

  it('is checked first: a rule set widened to every /api path still never reaches it', () => {
    const wide: SwarmAdminReachRules = {
      never: gate.SWARM_ADMIN_NEVER_PREFIXES,
      prefixes: ['/api'],
      exactCalls: [{ methods: ['GET', 'POST'], pattern: /^\/api\/(join|cli-tokens|remote-clients)(\/.*)?$/ }],
    };
    expect(gate.swarmAdminMayReach('/api/tasks', 'POST', wide), 'the widened rules are live').toBe(true);
    const reopened = [...WORKER_PLANE, ['POST', '/API/Remote-Clients/x/chat'] as Call]
      .filter(([method, pathname]) => gate.swarmAdminMayReach(pathname, method, wide));
    expect(reopened).toEqual([]);
  });

  it.each(NEVER_CALLS)('refuses %s %s', (method, pathname) => {
    expect(gate.swarmAdminMayReach(pathname, method)).toBe(false);
  });

  it('is named by nothing in the reach lists', () => {
    const named = [...gate.SWARM_ADMIN_SURFACE_PATHS, ...gate.SWARM_ADMIN_API_PREFIXES]
      .filter((prefix) => NEVER.some((n) => prefix === n || prefix.startsWith(`${n}/`) || n.startsWith(`${prefix}/`)));
    expect(named).toEqual([]);
    const probes = NEVER.flatMap((n) => [n, `${n}/x`, `${n}/x/y`]);
    const matching = gate.SWARM_ADMIN_EXACT_CALLS
      .filter(({ pattern }) => probes.some((p) => pattern.test(p))).map(({ pattern }) => pattern.source);
    expect(matching).toEqual([]);
  });
});

describe('the exact reach, decided without HTTP', () => {
  it.each(WORKER_PLANE)('pins the worker plane, tokens and enrolment: refuses %s %s', (method, pathname) => {
    expect(gate.swarmAdminMayReach(pathname, method)).toBe(false);
  });
  it.each(REFUSED)('refuses the call that acts as the caller: %s %s', (method, pathname) => {
    expect(gate.swarmAdminMayReach(pathname, method)).toBe(false);
  });
  it.each(CASE_VARIANTS)('refuses the case variant %s %s', (method, pathname) => {
    expect(gate.swarmAdminMayReach(pathname, method)).toBe(false);
  });
  it.each(ALLOWED)('still allows the admin call %s %s', (method, pathname) => {
    expect(gate.swarmAdminMayReach(pathname, method)).toBe(true);
  });

  it('anchors every exact call, writes it in lower case without flags and names real methods', () => {
    const calls = gate.SWARM_ADMIN_EXACT_CALLS;
    expect(calls.length).toBeGreaterThan(10);
    for (const { methods, pattern } of calls) {
      expect([pattern.source.startsWith('^'), pattern.source.endsWith('$'), pattern.flags], pattern.source).toEqual([true, true, '']);
      expect(pattern.source, 'matched against the lower-cased path, so a capital never matches').toBe(pattern.source.toLowerCase());
      expect(methods.length, pattern.source).toBeGreaterThan(0);
      expect(methods.filter((m) => !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)), pattern.source).toEqual([]);
    }
  });

  it('keeps the identity in a leaf module that imports only ./principal-issuer, re-exported by the gate', async () => {
    const identity = await import('@/shared/middleware/swarm-admin-identity');
    expect(identity.SWARM_ADMIN_SUB).toBe(gate.SWARM_ADMIN_SUB);
    expect(identity.isSwarmAdminPrincipal).toBe(gate.isSwarmAdminPrincipal);
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src/shared/middleware/swarm-admin-identity.ts'), 'utf8');
    const imports = [...source.matchAll(/^import\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map(([, type, spec]) => `${type ?? ''}${spec}`);
    expect(imports).toEqual(['type express', './principal-issuer']);
  });
});

describe('the exact reach through the real guard', () => {
  let server: Server | undefined;
  let base = '';

  beforeAll(async () => {
    const app = express();
    app.use(fixtureIdentity);
    app.use(gate.createSwarmAdminScopeGuard());
    app.use((_req, res) => { res.status(200).json({ reached: true }); });
    ({ server, base } = await listen(app));
  });

  afterAll(() => close(server));

  function call(method: string, pathname: string, who = 'admin') {
    return fetch(base + pathname, { method, redirect: 'manual', headers: { 'x-test-who': who } });
  }

  async function expectRefused(method: string, pathname: string): Promise<void> {
    const res = await call(method, pathname);
    expect(res.status, `${method} ${pathname}`).toBe(403);
    if (method !== 'HEAD') expect(await res.json()).toMatchObject({ error: 'swarm_admin_not_a_user' });
  }

  it.each(NEVER_CALLS)('the never-list answers 403 to %s %s', expectRefused);
  it.each(WORKER_PLANE)('the worker plane, tokens and enrolment answer 403 to %s %s', expectRefused);
  it.each(REFUSED)('a call that acts as the caller answers 403: %s %s', expectRefused);
  it.each(CASE_VARIANTS)('a case variant answers 403, never a redirect: %s %s', expectRefused);

  it.each(ALLOWED)('the admin call %s %s goes through', async (method, pathname) => {
    expect((await call(method, pathname)).status).toBe(200);
  });

  it('leaves everyone else untouched on the narrowed and never-listed routes', async () => {
    for (const [method, pathname] of [...REFUSED, ...WORKER_PLANE.slice(0, 4), ['POST', '/api/join/enroll'] as Call]) {
      expect((await call(method, pathname, 'person')).status, `${method} ${pathname}`).toBe(200);
    }
  });
});

// The activation names its principal class in the body, which the gate does not read, so the activation route
// refuses the admin a user activation itself: that activation would make the admin the service's principal and
// register a schedule instance whose every tick runs as the admin. Proven through the real guard, the real
// route and the real activation service on memory stores, with the JSON body parsed before the gate as in the
// server.
describe('service activation through the real guard and route: the admin activates as the application, never as itself', () => {
  const APP = 'hello-flow';
  const SERVICES = `/api/swarm/apps/${APP}/services`;
  const ACTORS: Record<string, AuthorizationActor> = {
    admin: { sub: gate.SWARM_ADMIN_SUB, issuer: LOCAL_AUTH_PRINCIPAL_ISSUER, isActive: true, isSwarmAdmin: true },
    person: { sub: PERSON.sub, issuer: PERSON.iss, isActive: true, isSwarmAdmin: false },
  };
  let server: Server | undefined;
  let base = '';
  let activations: MemoryApplicationServiceActivationStore;
  let registered: string[];

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(fixtureIdentity);
    app.use(gate.createSwarmAdminScopeGuard());
    const router = express.Router();
    registerApplicationServiceActivationRoutes(router);
    app.use('/api/swarm/apps', router);
    ({ server, base } = await listen(app));
  });

  afterAll(() => close(server));

  beforeEach(async () => {
    registered = [];
    activations = new MemoryApplicationServiceActivationStore();
    const policy = new MemoryAuthorizationStore();
    const authorization = new ApplicationAuthorizationService(policy);
    await authorization.registerApp({ app: APP, source: 'fixture-store', version: '1.0.0', catalog: null, mode: 'legacy' });
    // An unclassified service with no requirements: nothing but the caller's class decides who it runs as.
    const service = new ApplicationServiceActivationService({
      activations, policy, describeApp: (name) => authorization.getApp(name),
      declaredServices: async () => [{ app: APP, id: 'nightly', scheduleId: `${APP}-nightly`, cron: '0 3 * * *', requires: [], queue: APP }],
      authorize: (actor, operation) => authorization.authorize(actor, operation),
      registerUserInstance: async ({ userSub }) => { registered.push(userSub); },
      removeUserInstance: async ({ userSub }) => { registered = registered.filter((sub) => sub !== userSub); },
    });
    setApplicationServiceActivations({ service, resolveActor: async (req) => structuredClone(ACTORS[String(req.get('x-test-who'))]) });
  });

  afterEach(() => setApplicationServiceActivations(undefined));

  function send(method: string, pathname: string, who: string, body?: unknown) {
    return fetch(base + pathname, {
      method, redirect: 'manual', headers: { 'x-test-who': who, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** The live activations of the fixture service: class and, for a user activation, whose. */
  async function live(): Promise<Array<{ runsAs: string; targetSub?: string }>> {
    return (await activations.listByApp(APP)).map(({ runsAs, targetSub }) => ({ runsAs, ...(targetSub ? { targetSub } : {}) }));
  }

  it.each([`${SERVICES}/nightly/activate`, `${SERVICES}/${APP}-nightly/activate`, `/api/swarm/apps/${APP}/Services/nightly/ACTIVATE`])(
    'refuses the admin a user activation at %s: 403, nothing stored, no schedule instance', async (pathname) => {
      const res = await send('POST', pathname, 'admin', { runsAs: 'user' });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'swarm_admin_not_a_user' });
      expect(await live()).toEqual([]);
      expect(registered).toEqual([]);
    },
  );

  it('still lets the admin activate the service as the application, and turn it off again', async () => {
    const res = await send('POST', `${SERVICES}/nightly/activate`, 'admin', { runsAs: 'system' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ activation: { runsAs: 'system' } });
    expect(await live()).toEqual([{ runsAs: 'system' }]);
    expect(registered).toEqual([]);
    const off = await send('DELETE', `${SERVICES}/nightly/activation?runsAs=system`, 'admin');
    expect([off.status, await off.json()]).toEqual([200, { deactivated: true }]);
    expect(await live()).toEqual([]);
  });

  it('leaves a person\'s own user activation alone, and the admin may still close it', async () => {
    const mine = await send('POST', `${SERVICES}/nightly/activate`, 'person', { runsAs: 'user' });
    expect(mine.status).toBe(200);
    expect(await live()).toEqual([{ runsAs: 'user', targetSub: PERSON.sub }]);
    expect(registered).toEqual([PERSON.sub]);
    const target = `targetSub=${encodeURIComponent(PERSON.sub)}&targetIssuer=${encodeURIComponent(PERSON.iss)}`;
    const closed = await send('DELETE', `${SERVICES}/nightly/activation?${target}`, 'admin');
    expect([closed.status, await closed.json()]).toEqual([200, { deactivated: true }]);
    expect(await live()).toEqual([]);
    expect(registered).toEqual([]);
  });

  it('answers a missing or unknown class with the route\'s own 400, for the admin as for anyone', async () => {
    for (const body of [{}, { runsAs: 'USER' }, undefined]) {
      const res = await send('POST', `${SERVICES}/nightly/activate`, 'admin', body);
      expect([res.status, await res.json()], JSON.stringify(body)).toEqual([400, { error: 'authorization_service_class_required' }]);
    }
    expect(await live()).toEqual([]);
  });
});

// The RAG upload and ingest pick the document's owner from the body, which the gate does not read, so the RAG
// routes refuse the admin a document it would own itself, while its writes to the shared corpus stay. Proven
// through the real guard and the real RAG router (multer included) over a corpus that records each ingest.
describe('the shared corpus through the real guard and route: the admin writes shared documents, never its own', () => {
  const ingest = vi.fn(async (_texts: string[], _collection: string, _metadata: Record<string, unknown>) => ({ documentCount: 1, chunkCount: 1 }));
  let server: Server | undefined;
  let base = '';

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(fixtureIdentity);
    app.use(gate.createSwarmAdminScopeGuard());
    app.use('/api/rag', createRagRoutes({ ingest } as never, undefined, null));
    ({ server, base } = await listen(app));
  });

  afterAll(() => close(server));

  beforeEach(() => {
    // The admin holds the operator role here unless a case takes it away.
    vi.stubEnv('OSHAL_OPERATOR_SUBS', gate.SWARM_ADMIN_SUB);
    vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    ingest.mockClear();
  });

  function ingestAs(who: string, extra: Record<string, unknown>) {
    return fetch(`${base}/api/rag/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-who': who },
      body: JSON.stringify({ format: 'text', content: 'placeholder notes for the corpus', ...extra }),
    });
  }

  function uploadAs(who: string, fields: Record<string, string>) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append('files', new Blob(['placeholder notes for the corpus'], { type: 'text/plain' }), 'notes.txt');
    return fetch(`${base}/api/rag/upload`, { method: 'POST', headers: { 'x-test-who': who }, body: form });
  }

  async function expectRefusedBeforeStoring(res: Response): Promise<void> {
    expect([res.status, ((await res.json()) as { error?: string }).error]).toEqual([403, 'swarm_admin_not_a_user']);
    expect(ingest).not.toHaveBeenCalled();
  }

  it.each([
    ['a private ingest', { private: true }],
    ['a private ingest by visibility', { visibility: 'private' }],
    ['an ingest stamped with its own sub', { metadata: { owner_sub: gate.SWARM_ADMIN_SUB } }],
  ])('refuses the admin %s: 403 before anything is stored', async (_label, extra) => {
    await expectRefusedBeforeStoring(await ingestAs('admin', extra));
  });

  it('refuses the admin a private upload: 403 before anything is extracted or stored', async () => {
    await expectRefusedBeforeStoring(await uploadAs('admin', { private: 'true' }));
  });

  it('refuses every ingest and upload while the admin lacks the operator role, since each would be the admin\'s own', async () => {
    vi.stubEnv('OSHAL_OPERATOR_SUBS', '');
    await expectRefusedBeforeStoring(await ingestAs('admin', {}));
    await expectRefusedBeforeStoring(await uploadAs('admin', {}));
  });

  it('still lets the admin write the shared corpus by ingest and by upload, with no owner stamped', async () => {
    expect((await ingestAs('admin', {})).status).toBe(200);
    expect((await uploadAs('admin', {})).status).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(2);
    for (const [, , metadata] of ingest.mock.calls) expect(metadata).not.toHaveProperty('owner_sub');
  });

  it('leaves a person\'s private ingest alone, owned by that person', async () => {
    expect((await ingestAs('person', { private: true })).status).toBe(200);
    expect(ingest).toHaveBeenCalledWith(expect.any(Array), 'default', expect.objectContaining({ owner_sub: PERSON.sub }));
  });
});

describe('path tricks never widen the reach', () => {
  const TRICKS = [
    '/cockpit/tools/dlq.html/../../index.html', '/cockpit/tools/dlq.html/%2e%2e/%2e%2e/index.html',
    '/cockpit/tools/channels.html/../devices.html', '/cockpit/tools/dlq.html/../../js/app.js', '/admin/./admin.js',
    '/admin/%2E%2E/cockpit/index.html', '/api/config/%2e%2e/v1/tickets', '/api/config/..%2fv1%2ftickets', '/shared/%5c..%5cx',
  ];
  it.each(TRICKS)('refuses %s before any rule', (pathname) => {
    expect(gate.swarmAdminMayReach(pathname, 'GET')).toBe(false);
  });
  it('refuses the cockpit tool pages for anything but a read', () => {
    expect(gate.swarmAdminMayReach('/cockpit/tools/dlq.html', 'POST')).toBe(false);
    expect(gate.swarmAdminMayReach('/cockpit/tools/dlq.htmlx', 'GET')).toBe(false);
  });
});
