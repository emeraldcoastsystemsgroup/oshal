/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Real administration HTTP routes with isolated workflow files and doubled execution/history collaborators.
 */
import express, { type Router } from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { createWorkflowStudioRoutes } from '@/app/routes/workflow-studio-routes';
import { createWorkflowStudioAssistRoutes } from '@/app/routes/workflow-studio-assist-routes';
import { createWorkflowRunRoutes } from '@/app/routes/workflow-run-routes';
import * as inlineExecution from '@/app/routes/inline-bot-execution';
import * as swarmApps from '@/features/swarm-apps';
import { createSwarmAppRoutes } from '@/app/routes/swarm-app-routes';
import { WorkflowStudioService, type WorkflowRunHistoryStore } from '@/features/workflow-studio';
import type { AppContext } from '@/app/composition/app-context';

/** @description Local HTTP transport with explicit synthetic session identity. @returns Request and cleanup helpers. */
async function serve(routes: Array<[string, Router]>, directory: string) {
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    const user = req.header('x-fixture-user');
    if (user !== 'member' && user !== 'operator') { res.sendStatus(401); return; }
    Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: `fixture-${user}` } } }); next();
  });
  for (const [mount, router] of routes) app.use(mount, router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { directory,
    call: (route: string, user = 'member', method = 'GET', body?: unknown) => fetch(base + route, {
      method, headers: { 'x-fixture-user': user, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    close: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
      vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); },
  };
}

/** @description Isolate all call-time workflow/manifest paths in a disposable workspace. @returns Owned temporary directory. */
async function workspace() {
  const directory = await mkdtemp(path.join(tmpdir(), 'workflow-administration-'));
  vi.spyOn(process, 'cwd').mockReturnValue(directory);
  vi.stubEnv('OSHAL_WORKSPACE_ROOT', directory);
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'fixture-operator'); vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  vi.stubEnv('OSHAL_ALLOW_LEGACY_UNOWNED', 'false');
  return directory;
}

/** @description Actual file-backed Studio routes, with execution/history collaborators recorded. @returns HTTP fixture and source-call spies. */
export async function workflowAdministrationFixture() {
  const directory = await workspace();
  const methods = ['listDefinitions', 'getDefinition', 'listDefinitionVersions', 'getDefinitionVersion',
    'createDefinition', 'createFromTemplate', 'saveDefinition', 'validateDefinition', 'compileDefinition',
    'duplicateDefinition', 'forkDefinitionVersion'] as const;
  const studio = methods.map(method => vi.spyOn(WorkflowStudioService.prototype, method));
  const bot = vi.spyOn(inlineExecution, 'executeBotOrInline').mockResolvedValue({ response: 'Which step follows?' } as
    Awaited<ReturnType<typeof inlineExecution.executeBotOrInline>>);
  const listRuns = vi.fn(async () => []);
  const getRun = vi.fn(async () => ({ runId: 'foreign-run', ownerSub: 'foreign-member', privateMarker: 'FOREIGN RESULT' }));
  const store = { listRuns, getRun } as unknown as WorkflowRunHistoryStore;
  const routes: Array<[string, Router]> = [
    ['/api/workflow-studio', createWorkflowStudioRoutes()], ['/api/workflow-studio', createWorkflowStudioAssistRoutes({} as AppContext)],
    ['/api/workflow-studio', createWorkflowRunRoutes({ store })],
  ];
  return { ...(await serve(routes, directory)), studio, bot, listRuns, getRun };
}

/** @description Real publish compiler and temporary manifest writes; loading/database effects are recorded collaborators. @returns HTTP fixture and activation spies. */
export async function swarmPublishingFixture() {
  const directory = await workspace();
  const source = { name: 'shared-workflow', scope: 'public', status: 'active', manifest: {
    name: 'shared-workflow', displayName: 'Shared workflow', description: 'Operator-managed workflow',
    ticketType: 'shared-workflow', bots: [{ agentId: 'shared-bot', name: 'Shared bot' }],
    workflow: { pipeline: 'graph', workerBot: 'shared-bot' },
  } };
  const getApp = vi.fn(async (name: string) => name === source.name ? source : null);
  const listApps = vi.fn(async () => [source]);
  const loadApp = vi.fn(async (manifestPath: string, options: unknown) => ({ name: path.basename(manifestPath, '.yaml'), ...options as object }));
  const files = vi.spyOn(swarmApps, 'listManifestFiles').mockReturnValue([]);
  const compile = vi.spyOn(swarmApps, 'compileWorkflowSpec');
  const routes: Array<[string, Router]> = [['/api/swarm/apps', createSwarmAppRoutes(
    { getApp, listApps, loadApp } as unknown as swarmApps.SwarmAppService, undefined, {
      authorization: { canDiscover: async () => true, resolveActor: async () => ({
        sub: 'fixture-member', issuer: 'urn:fixture', isActive: true, isSwarmAdmin: false,
      }) },
    })]];
  return { ...(await serve(routes, directory)), getApp, listApps, loadApp, files, compile, source };
}
