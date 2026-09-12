/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise real Lab HTTP and PostgreSQL history with a controlled runner boundary and isolated callers.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InstalledAppTestCatalog, InstalledAppTestCase, InstalledAppTestResult } from '@/features/swarm-apps/services/installed-app-test-catalog';
import { PostgresTestLabRunStore } from '@/app/routes/test-lab-run-store';
import { TestLabRunService } from '@/app/routes/test-lab-run-service';
import { createTestLabRunRoutes } from '@/app/routes/test-lab-run-routes';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';

export const TEST_CASE: InstalledAppTestCase = {
  id: 'app:fixture:test:invoice',caseId: 'invoice',appName: 'fixture',appVersion: '1.0.0',source: 'fixture-source',
  revision: 'a'.repeat(64),executionRevision: 'b'.repeat(64),name: 'Invoice calculation',purpose: 'Verify exact invoice totals.',
  level: 'unit',runner: { kind: 'node-test',scope: 'package',files: ['tests/invoice.test.js'] },expected: ['Exact totals'],sideEffects: 'none',
  isolation: { mode: 'disposable' },limits: { timeoutMs: 10000 },installationEligible: false,method: 'LOCAL',path: 'tests/invoice.test.js',
  auth: 'none',prerequisites: [],runnable: true,
};

/** @description Own every database/HTTP resource and keep the runner controllable for race assertions.
 * @returns Actual durable service, HTTP calls, server state and cleanup.
 */
export async function startTestLabRunFixture(options: { catalog?: InstalledAppTestCatalog; test?: InstalledAppTestCase } = {}) {
  const database = new DisposableAlertPostgres(); const pool = await database.start();
  const migration = readFileSync(resolve('scripts/migrations/136-test-lab-runs.sql'),'utf8');
  await pool.query(migration); await pool.query(migration);
  const state = { visible: true,canRun: true,hold: false,starts: 0,cleanupVerified: true,throwAfterStart: false,
    test: structuredClone(options.test ?? TEST_CASE),output: 'invoice total: 42\n<script>private fixture</script>' };
  let finish: (() => void) | undefined;
  const catalog = options.catalog ?? {
    list: () => state.visible ? [structuredClone(state.test)] : [],
    run: async (_test: unknown,_visible: unknown,options: { signal: AbortSignal; revalidate: () => Promise<boolean> }): Promise<InstalledAppTestResult> => {
      state.starts++;
      if (state.throwAfterStart) throw new Error('Uncertain sandbox failure');
      if (state.hold) await new Promise<void>(done => { finish = done; options.signal.addEventListener('abort',() => done(),{ once: true }); });
      const allowed = await options.revalidate();
      return { name: state.test.name,path: state.test.path,status: allowed ? 'passed' : 'pending',durationMs: 10,
        cancelled: options.signal.aborted,...(allowed && !options.signal.aborted ? { output: state.output } : {}),
        executionRevision: state.test.executionRevision,image: 'fixture@sha256:' + 'c'.repeat(64),cleanupVerified: state.cleanupVerified };
    },
  } as unknown as InstalledAppTestCatalog;
  const store = new PostgresTestLabRunStore(pool,Promise.resolve(),async () => true); let service = new TestLabRunService(store,catalog);
  const app = express(); app.use(express.json());
  const runContext = async (req: express.Request) => ({
    actor: { issuer: req.get('x-fixture-issuer') === 'other' || req.get('cookie') === 'actor=other' ? 'https://other.test' : 'https://first.test',sub: 'same-sub' },
    visibleApps: new Map(state.visible ? [['fixture','Fixture package']] : []),auth: { canRunSuites: state.canRun },
  });
  app.get('/api/test-lab/app',(_req,res) => res.sendFile(resolve('any-bot/server/services/tools/test-lab/test-lab-app.html')));
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
