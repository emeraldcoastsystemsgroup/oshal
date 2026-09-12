/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Orchestrate cancellable catalog-only runs and exact-caller versioned history with fresh authority.
 */
import { randomUUID } from 'node:crypto';
import type { InstalledAppTestCatalog, InstalledAppTestCase, InstalledAppTestResult } from '@/features/swarm-apps';
import type { TestLabRun, TestLabRunContext, TestLabRunSelection, TestLabRunStore } from './test-lab-run-types';

type Context = () => Promise<TestLabRunContext>;
const active = new Set(['queued','running','cancelling']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
function refusal(message: string, status = 403): never { throw Object.assign(new Error(message), { status }); }
function sameActor(a: TestLabRunContext, b: TestLabRunContext): boolean {
  return a.actor.issuer === b.actor.issuer && a.actor.sub === b.actor.sub;
}
function currentTest(catalog: InstalledAppTestCatalog, context: TestLabRunContext, test: InstalledAppTestCase) {
  return catalog.list(context.visibleApps,context.auth).find(item => item.id === test.id);
}
function unchanged(a: InstalledAppTestCase, b: InstalledAppTestCase | undefined): boolean {
  return !!b && a.id === b.id && a.revision === b.revision && a.executionRevision === b.executionRevision
    && a.appVersion === b.appVersion && a.source === b.source;
}

/** Server-owned execution jobs; no paths, commands, credentials or principals are accepted from the browser. */
export class TestLabRunService {
  private readonly controllers = new Map<string, AbortController>();
  constructor(private readonly store: TestLabRunStore, private readonly catalog: InstalledAppTestCatalog) {}

  private async context(resolve: Context): Promise<TestLabRunContext> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const context = await Promise.race([resolve(),new Promise<never>((_resolve,reject) => {
        timer = setTimeout(() => reject(new Error('Current authority is unavailable.')),5000);
      })]);
      if (!context.actor?.issuer || !context.actor?.sub) refusal('A verified user identity is required.',401);
      return context;
    } finally { if (timer) clearTimeout(timer); }
  }

  private selected(input: TestLabRunSelection, context: TestLabRunContext): InstalledAppTestCase {
    if (!input || Object.keys(input).sort().join(',') !== 'caseId,executionRevision,requestId,revision'
      || typeof input.caseId !== 'string' || typeof input.requestId !== 'string' || typeof input.revision !== 'string'
      || typeof input.executionRevision !== 'string' || !uuid.test(input.requestId) || !hash.test(input.revision) || !hash.test(input.executionRevision)) {
      refusal('Select a current catalog case before running.',400);
    }
    if (context.auth.canRunSuites !== true) refusal('An operator is required to run package suites.');
    const test = this.catalog.list(context.visibleApps,context.auth).find(item => item.id === input.caseId);
    if (!test) refusal('This test is unavailable.',404);
    if (test.runner.kind !== 'node-test' || !test.runnable) refusal(test.pendingReason ?? 'This runner is unavailable.',409);
    if (test.revision !== input.revision || test.executionRevision !== input.executionRevision) refusal('This test changed. Refresh the catalog.',409);
    return test;
  }

  /** @description Admit one fixed current catalog suite and detach its bounded execution.
   * @param input Case identity and caller-generated retry key. @param resolve Fresh server-owned caller authority.
   * @returns The durable run receipt, including an existing receipt on an exact retry.
   */
  async start(input: TestLabRunSelection, resolve: Context): Promise<TestLabRun> {
    const context = await this.context(resolve);
    const test = this.selected(input,context);
    const now = new Date().toISOString();
    const id = randomUUID();
    const run = await this.store.create({ id,requestId: input.requestId,actor: context.actor,test,state: 'queued',createdAt: now,updatedAt: now });
    if (!unchanged(test,run.test)) refusal('This retry key belongs to another test selection.',409);
    if (run.id === id) void this.execute(run,context,resolve).catch(() => undefined);
    return this.read(run.id,resolve);
  }

  private async allowed(run: TestLabRun, original: TestLabRunContext, resolve: Context): Promise<boolean> {
    try {
      const context = await this.context(resolve);
      const test = currentTest(this.catalog,context,run.test);
      return sameActor(original,context) && context.auth.canRunSuites === true && !!test?.runnable && unchanged(run.test,test);
    } catch { return false; }
  }

  private async watch(run: TestLabRun, original: TestLabRunContext, resolve: Context, controller: AbortController): Promise<void> {
    if (!await this.live(run) || !await this.allowed(run,original,resolve)) controller.abort();
  }

  private async live(run: TestLabRun): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([this.store.pulse(run.actor,run.id).then(state => state === 'running'),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false),5000); })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async execute(run: TestLabRun, original: TestLabRunContext, resolve: Context): Promise<void> {
    if (!await this.store.begin(run.actor,run.id)) return;
    const controller = new AbortController();
    this.controllers.set(run.id,controller);
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.watch(run,original,resolve,controller).catch(() => controller.abort()).finally(() => { checking = false; });
    },2000);
    timer.unref();
    try { await this.perform(run,original,resolve,controller); }
    catch {
      // Unknown execution failures retain capacity until the correlated sandbox is reaped.
      await this.store.cancel(run.actor,run.id);
    } finally { clearInterval(timer); this.controllers.delete(run.id); }
  }

  private async perform(run: TestLabRun, original: TestLabRunContext, resolve: Context, controller: AbortController): Promise<void> {
    const revalidate = async () => await this.live(run) && await this.allowed(run,original,resolve);
    if (!await revalidate()) controller.abort();
    let result: InstalledAppTestResult = controller.signal.aborted
      ? { name: run.test.name,path: run.test.path,status: 'pending',durationMs: 0,cleanupVerified: true,error: 'Current test access is unavailable.' }
      : await this.catalog.run(run.test,original.visibleApps,{ ...original.auth,apiBaseUrl: 'http://127.0.0.1',
        signal: controller.signal,revalidate,executionId: run.id });
    if (!await revalidate()) result = { name: run.test.name,path: run.test.path,status: 'pending',durationMs: result.durationMs,
      cleanupVerified: result.cleanupVerified,executionRevision: result.executionRevision,image: result.image,
      error: 'Access or the installed test changed during execution. Output was withheld.' };
    if (result.cleanupVerified !== true) { await this.store.cancel(run.actor,run.id); return; }
    result = { ...result, ...(typeof result.output === 'string' ? { output: result.output.slice(0,65536) } : {}) };
    const state = result.cancelled || controller.signal.aborted ? 'cancelled' : result.status;
    await this.store.finish(run.actor,run.id,state,result);
  }

  private decorate(run: TestLabRun, context: TestLabRunContext): TestLabRun {
    return { ...run,stale: !unchanged(run.test,currentTest(this.catalog,context,run.test)) };
  }

  /** @description Read exact-owner evidence and recheck current app access after persistence reads.
   * @param id Run UUID. @param resolve Current verified caller. @returns Authorized version-labelled evidence.
   */
  async read(id: string, resolve: Context): Promise<TestLabRun> {
    if (!uuid.test(id)) refusal('Run not found.',404);
    const before = await this.context(resolve);
    const run = await this.store.get(before.actor,id);
    const after = await this.context(resolve);
    if (!run || !sameActor(before,after) || !after.visibleApps.has(run.test.appName)) refusal('Run not found.',404);
    return this.decorate(run,after);
  }

  /** @description List only current readable applications after exact-principal filtering.
   * @param resolve Current verified caller. @param app Optional application filter. @returns Version-labelled metadata without output bytes.
   */
  async history(resolve: Context, app?: string): Promise<TestLabRun[]> {
    const before = await this.context(resolve);
    const apps = [...before.visibleApps.keys()].filter(name => !app || name === app);
    const runs = await this.store.list(before.actor,apps);
    const after = await this.context(resolve);
    if (!sameActor(before,after)) refusal('User context changed. Refresh the page.');
    return runs.filter(run => after.visibleApps.has(run.test.appName)).map(run => this.decorate(run,after));
  }

  /** @description Cancel only the current caller's currently visible active run.
   * @param id Run UUID. @param resolve Current verified caller. @returns Durable current cancellation state.
   */
  async cancel(id: string, resolve: Context): Promise<TestLabRun> {
    const run = await this.read(id,resolve);
    if (active.has(run.state)) {
      await this.store.cancel(run.actor,id);
      this.controllers.get(id)?.abort();
    }
    return this.read(id,resolve);
  }
}
