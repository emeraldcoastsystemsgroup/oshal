/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Compose actual local schedule HTTP, PostgreSQL, catalog and Docker execution over disposable fixture packages.
 */
import express from 'express';
import type { Pool } from 'pg';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { InstalledAppTestCatalog } from '@/features/swarm-apps/services/installed-app-test-catalog';
import { TestLabRunService } from '@/app/routes/test-lab-run-service';
import { PostgresTestLabRunStore } from '@/app/routes/test-lab-run-store';
import { createTestLabRunRoutes } from '@/app/routes/test-lab-run-routes';
import { TestLabScheduleService } from '@/app/routes/test-lab-schedule-service';
import { PostgresTestLabScheduleStore } from '@/app/routes/test-lab-schedule-store';
import { createTestLabScheduleRoutes } from '@/app/routes/test-lab-schedule-routes';
import type { TestLabPrincipal } from '@/app/routes/test-lab-run-types';
import type { TestLabScheduleBatch } from '@/app/routes/test-lab-schedule-types';
import { createPackageExecutionFixture, ObservedPackageTestSandbox, PACKAGE_TEST_IMAGE, type PackageExecutionFixtureOptions } from './package-test-execution';

export const SCHEDULE_ACTOR = { issuer: 'https://schedule-fixture.test',sub: 'same-sub' };

/** @description Poll a real durable outcome with a fixed fixture deadline. @param read Current stored result.
 * @param done Expected terminal predicate. @returns The actual terminal result. */
export async function waitForSchedule<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now()+45000;
  while (Date.now() < deadline) {
    const result = await read(); if (done(result)) return result;
    await new Promise<void>(resolveDelay => setTimeout(resolveDelay,100));
  }
  throw new Error('Disposable schedule fixture did not finish within its deadline');
}

/** @description Bind actual schedule and run endpoints to an explicitly injected fixture identity adapter.
 * @param service Current service instance. @param runs Existing durable runner. @param actorContext Fixture account resolver.
 * @returns HTTP server and same-origin calls. */
async function httpFixture(service: () => TestLabScheduleService, runs: TestLabRunService,
  actorContext: (actor: TestLabPrincipal) => Promise<any>, catalog: InstalledAppTestCatalog) {
  const app = express(); app.use(express.json());
  const runContext = (req: express.Request) => actorContext({ ...SCHEDULE_ACTOR,
    ...(req.get('x-fixture-issuer') === 'other' || req.get('cookie') === 'actor=other' ? { issuer: 'https://other-fixture.test' } : {}) });
  app.get('/api/test-lab/app',(_req,res) => res.sendFile(resolve('any-bot/server/services/tools/test-lab/test-lab-app.html')));
  app.get('/api/test-lab/catalog',async (req,res) => {
    const current = await runContext(req), tests = catalog.list(current.visibleApps,current.auth);
    res.json({ scenarios: tests.map(test => ({ id: test.id,title: `${test.appName}: ${test.name}`,group: 'tool',
      description: test.purpose,installedTest: test,steps: [{ id: test.id,app: test.appName,label: test.name }] })),
      installedApps: [...current.visibleApps].map(([name,displayName]) => ({ name,displayName })) });
  });
  app.use('/api/test-lab',(req,res,next) => createTestLabScheduleRoutes({ scheduleService: service(),runContext })(req,res,next));
  app.use('/api/test-lab',createTestLabRunRoutes({ runService: runs,runContext }));
  const server = app.listen(0,'127.0.0.1'); await new Promise<void>(done => server.once('listening',done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server,base,call: (path: string,method = 'GET',body?: unknown,headers: Record<string,string> = {}) =>
    fetch(base+'/api/test-lab'+path,{ method,headers: { 'content-type': 'application/json',origin: base,'X-OSHAL-Test-Lab': '1',...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) };
}

/** @description Own all package files and actual HTTP/runner resources while the caller owns disposable PostgreSQL.
 * @param pool Isolated fixture database only. @returns Current source installation, scheduling and evidence helpers. */
export async function startTestLabScheduleFixture(pool: Pool) {
  const root = mkdtempSync(join(tmpdir(),'oshal-schedule-fixture-')), sandbox = new ObservedPackageTestSandbox();
  const catalog = new InstalledAppTestCatalog({ sandbox,runnerImage: PACKAGE_TEST_IMAGE });
  const runStore = new PostgresTestLabRunStore(pool), runs = new TestLabRunService(runStore,catalog), store = new PostgresTestLabScheduleStore(pool);
  const state = { admin: true,hang: false,now: new Date(),visible: new Map<string,string>() };
  const actorContext = async (actor: TestLabPrincipal) => ({ actor,visibleApps: new Map(state.visible),auth: { canRunSuites: state.admin } });
  const options = { store,runs,catalog,now: () => state.now,resolveScheduledContext: (actor: TestLabPrincipal) =>
    state.hang ? new Promise<Awaited<ReturnType<typeof actorContext>>>(() => {}) : actorContext(actor) };
  let service = new TestLabScheduleService(options); const services = [service];
  const http = await httpFixture(() => service,runs,actorContext,catalog);
  return { ...http,root,state,sandbox,catalog,store,runs,runStore,context: () => actorContext(SCHEDULE_ACTOR),
    service: () => service,restart: () => { service.stop(); service = new TestLabScheduleService(options); services.push(service); return service; },
    peer: () => { const peer = new TestLabScheduleService(options); services.push(peer); return peer; },
    addPackage: (variant: PackageExecutionFixtureOptions = {}) => {
      const source = createPackageExecutionFixture(root,variant); catalog.register(source.record);
      state.visible.set(source.record.name,source.record.displayName); return source;
    },
    finished: (id: string) => waitForSchedule(async () => (await store.history(SCHEDULE_ACTOR,id))[0],
      (value: TestLabScheduleBatch | undefined) => !!value && value.state !== 'running'),
    close: async () => {
      services.forEach(item => item.stop());
      await waitForSchedule(async () => (await pool.query("SELECT count(*)::int AS total FROM oshal_test_lab_runs WHERE state IN ('queued','running','cancelling')")).rows[0].total,
        total => total === 0);
      http.server.closeAllConnections(); await new Promise<void>(done => http.server.close(() => done()));
      const child = relative(resolve(tmpdir()),resolve(root));
      if (!child.startsWith('oshal-schedule-fixture-') || child.includes('..')) throw new Error('Unsafe schedule fixture cleanup');
      rmSync(root,{ recursive: true,force: true });
    },
  };
}
