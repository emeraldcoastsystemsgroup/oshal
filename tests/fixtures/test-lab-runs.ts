/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise real Lab HTTP and PostgreSQL history with a controlled runner boundary and isolated callers.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Serve the shipped batch asset while preserving the independent single-suite runner fixture.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Record the scope of every authority resolution and make a resolution slow or failing per scope, and optionally route a case through the real sandbox execution loop (1 s pulse, 5 s cap) with a held runner, so run-path scoping and each fail-closed cause can be proven on the real run store.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InstalledAppTestCatalog, InstalledAppTestCase, InstalledAppTestResult } from '@/features/swarm-apps/services/installed-app-test-catalog';
import { executePackageTest } from '@/features/swarm-apps/services/package-test-execution';
import type { PackageTestSandbox } from '@/features/swarm-apps/services/package-test-sandbox';
import { PostgresTestLabRunStore } from '@/app/routes/test-lab-run-store';
import { TestLabRunService } from '@/app/routes/test-lab-run-service';
import { createTestLabRunRoutes } from '@/app/routes/test-lab-run-routes';
import type { TestLabAuthorityScope } from '@/app/routes/test-lab-run-types';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';

export const TEST_CASE: InstalledAppTestCase = {
  id: 'app:fixture:test:invoice',caseId: 'invoice',appName: 'fixture',appVersion: '1.0.0',source: 'fixture-source',
  revision: 'a'.repeat(64),executionRevision: 'b'.repeat(64),name: 'Invoice calculation',purpose: 'Verify exact invoice totals.',
  level: 'unit',runner: { kind: 'node-test',scope: 'package',files: ['tests/invoice.test.js'] },expected: ['Exact totals'],sideEffects: 'none',
  isolation: { mode: 'disposable' },limits: { timeoutMs: 10000 },installationEligible: false,method: 'LOCAL',path: 'tests/invoice.test.js',
  auth: 'none',prerequisites: [],runnable: true,
};
/** The fixture caller's exact principal, for reading the run store directly. */
export const RUN_ACTOR = { issuer: 'https://first.test',sub: 'same-sub' };
/** A slow resolution answers after this long: past the run service's and the sandbox's 5 s authority cap. */
export const SLOW_AUTHORITY_MS = 5500;
const IMAGE = 'fixture@sha256:' + 'c'.repeat(64);
const TAP_PASS = '# tests 1\n# pass 1\n# fail 0\n';

/** One authority resolution the fixture served: which request it was bound to and which applications it decided. */
export interface ResolvedScope { origin: string; scope: TestLabAuthorityScope }

/** Mutable fixture state the specs drive: access, runner hold, and the authority resolver's behaviour per scope. */
export type TestLabRunFixtureState = ReturnType<typeof fixtureState>;
function fixtureState(test: InstalledAppTestCase) {
  return { visible: true,canRun: true,hold: false,starts: 0,cleanupVerified: true,throwAfterStart: false,
    sandboxed: false,slowUnscoped: false,slowScoped: false,failScoped: false,scopes: [] as ResolvedScope[],
    test: structuredClone(test),output: 'invoice total: 42\n<script>private fixture</script>' };
}
type RunOptions = { signal: AbortSignal; revalidate: () => Promise<boolean>; executionId?: string };
type Hold = (signal: AbortSignal) => Promise<void>;

/** @description The real execution loop (1 s authority pulse, 5 s cap, before/after checks) around a held runner.
 * @param state Fixture state. @param held Hold until finish() or abort. @param test Selected case. @param options Run service options.
 * @returns The real execution result. */
function sandboxedRun(state: TestLabRunFixtureState, held: Hold, test: InstalledAppTestCase, options: RunOptions): Promise<InstalledAppTestResult> {
  const sandbox = { run: async (input: { signal?: AbortSignal }) => {
    state.starts++;
    if (state.hold && input.signal) await held(input.signal);
    const cancelled = !!input.signal?.aborted;
    return { exitCode: cancelled ? null : 0,output: TAP_PASS + state.output,image: IMAGE,timedOut: false,cancelled,
      cleanupVerified: state.cleanupVerified,truncated: false };
  } } as unknown as PackageTestSandbox;
  const snapshot = () => ({ revision: state.test.executionRevision!,files: [] });
  return executePackageTest({ name: test.name,path: test.path,suiteFiles: [test.path],timeoutMs: 60000,snapshot: snapshot(),
    snapshotNow: snapshot,current: options.revalidate,signal: options.signal,executionId: options.executionId,sandbox });
}

/** @description Catalog double: lists the one case only for a caller who can see its application, and runs it
 * either through the real sandbox loop or as a directly controlled result.
 * @param state Fixture state. @param held Runner hold. @returns The catalog double. */
function fixtureCatalog(state: TestLabRunFixtureState, held: Hold): InstalledAppTestCatalog {
  return {
    list: (visible: ReadonlyMap<string,string>) => state.visible && visible.has(state.test.appName) ? [structuredClone(state.test)] : [],
    run: async (test: InstalledAppTestCase,_visible: unknown,options: RunOptions): Promise<InstalledAppTestResult> => {
      if (state.sandboxed) return sandboxedRun(state,held,test,options);
      state.starts++;
      if (state.throwAfterStart) throw new Error('Uncertain sandbox failure');
      if (state.hold) await held(options.signal);
      const allowed = await options.revalidate();
      return { name: state.test.name,path: state.test.path,status: allowed ? 'passed' : 'pending',durationMs: 10,
        cancelled: options.signal.aborted,...(allowed && !options.signal.aborted ? { output: state.output } : {}),
        executionRevision: state.test.executionRevision,image: IMAGE,cleanupVerified: state.cleanupVerified };
    },
  } as unknown as InstalledAppTestCatalog;
}

/** @description Request authority shaped like the composition root's: an omitted scope walks every installed
 * application (slow under load when slowUnscoped is set), a name decides that application alone, null decides none.
 * Every call is recorded with the request it is bound to. @param state Fixture state. @returns The resolver. */
function fixtureAuthority(state: TestLabRunFixtureState) {
  return async (req: express.Request,scope?: TestLabAuthorityScope) => {
    state.scopes.push({ origin: `${req.method} ${req.originalUrl}`,scope });
    const named = typeof scope === 'string';
    if ((scope === undefined && state.slowUnscoped) || (named && state.slowScoped)) await new Promise<void>(done => setTimeout(done,SLOW_AUTHORITY_MS));
    if (named && state.failScoped) throw new Error('Fixture authority provider failed');
    const visible = state.visible && (scope === undefined || scope === state.test.appName);
    return {
      actor: { issuer: req.get('x-fixture-issuer') === 'other' || req.get('cookie') === 'actor=other' ? 'https://other.test' : RUN_ACTOR.issuer,sub: RUN_ACTOR.sub },
      visibleApps: new Map(visible ? [[state.test.appName,'Fixture package']] : []),auth: { canRunSuites: state.canRun },
    };
  };
}

/** @description Own every database/HTTP resource and keep the runner controllable for race assertions.
 * @returns Actual durable service, HTTP calls, server state and cleanup.
 */
export async function startTestLabRunFixture(options: { catalog?: InstalledAppTestCatalog; test?: InstalledAppTestCase } = {}) {
  const database = new DisposableAlertPostgres(); const pool = await database.start();
  const migration = readFileSync(resolve('scripts/migrations/136-test-lab-runs.sql'),'utf8');
  await pool.query(migration); await pool.query(migration);
  const state = fixtureState(options.test ?? TEST_CASE);
  let finish: (() => void) | undefined;
  const held: Hold = signal => new Promise<void>(done => { finish = done; signal.addEventListener('abort',() => done(),{ once: true }); });
  const catalog = options.catalog ?? fixtureCatalog(state,held);
  const store = new PostgresTestLabRunStore(pool,() => Promise.resolve(),async () => true); let service = new TestLabRunService(store,catalog);
  const app = express(); app.use(express.json());
  const runContext = fixtureAuthority(state);
  app.get('/api/test-lab/app',(_req,res) => res.sendFile(resolve('any-bot/server/services/tools/test-lab/test-lab-app.html')));
  app.get('/api/test-lab/package-batch.js',(_req,res) => res.sendFile(resolve('any-bot/server/services/tools/test-lab/test-lab-package-batch.js')));
  app.get('/api/test-lab/catalog',async (req,res) => {
    const current = await runContext(req);
    const tests = catalog.list(current.visibleApps,current.auth);
    res.json({ scenarios: tests.map(test => ({ id: test.id,title: test.name,description: test.purpose,
      group: 'tool',installedTest: test,steps: [{ app: 'fixture',label: test.name }] })),installedApps: [{ name: 'fixture',displayName: 'Fixture package' }] });
  });
  app.use('/api/test-lab',(req,res,next) => createTestLabRunRoutes({ runService: service,runContext })(req,res,next));
  const server = app.listen(0,'127.0.0.1'); await new Promise<void>(done => server.once('listening',done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { pool,store,catalog,state,base,finish: () => finish?.(),restart: () => { service = new TestLabRunService(store,catalog); },
    input: () => ({ caseId: state.test.id,revision: state.test.revision,executionRevision: state.test.executionRevision,requestId: randomUUID() }),
    call: (path: string,method = 'GET',body?: unknown,headers: Record<string,string> = {}) => fetch(base+'/api/test-lab'+path,{ method,
      headers: { 'content-type': 'application/json',origin: base,'X-OSHAL-Test-Lab': '1',...headers },...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    close: async () => { finish?.(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await database.stop(); },
  };
}
