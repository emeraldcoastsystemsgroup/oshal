/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Orchestrate cancellable catalog-only runs and exact-caller versioned history with fresh authority.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Preserve cancellation and verified cleanup when final authority validation refuses a completed sandbox result.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Discard completed output after any observed cancellation, including a concurrent watchdog refusal followed by successful final validation.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Admit verified Node-harness Playwright recipes alongside Node suites.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Admit verified vitest recipes too; the catalog still decides runnability, this gate only names the kinds a sealed profile exists for.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Resolve every run-path authority check (start, read, cancel, the 2 s watch, revalidation and the sandbox pulse) for the run's own application only, and log which check refused a run and why (timeout, error or denial). An all-application re-check that ran past the 5 s cap counted as a denial and cancelled healthy runs, with nothing recording the cause. The cap and every fail-closed outcome are unchanged.
 */
import { randomUUID } from 'node:crypto';
import type { InstalledAppTestCatalog, InstalledAppTestCase, InstalledAppTestResult } from '@/features/swarm-apps';
import { createChildLogger } from '@/shared/logger';
import type { TestLabAuthority, TestLabRun, TestLabRunContext, TestLabRunSelection, TestLabRunStore } from './test-lab-run-types';

type Context = TestLabAuthority;
/** The in-flight checks that can end a run: the 2 s watch, the service's own pre/post revalidation and the sandbox pulse. */
type AuthorityCheck = 'watch' | 'revalidate' | 'sandbox';
type AuthorityOutcome = 'denied' | 'timeout' | 'error';
const logger = createChildLogger({ module: 'test-lab-runs' });
/** One authority resolution or lease pulse may take this long before it counts as unavailable. */
const AUTHORITY_CAP_MS = 5000;
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

/** @description The application a catalog case id belongs to, used only to scope the start check. The catalog mints
 * ids as `app:<encoded name>:<smoke|test>:<encoded case>`. The hint narrows what is decided and never grants: the case
 * must still be found among that application's currently visible cases, so a forged id can only reach a 404.
 * @param caseId Untrusted selection field. @returns The application name, or null when the id names none. */
function caseApplication(caseId: unknown): string | null {
  const match = typeof caseId === 'string' ? /^app:([^:]+):(?:smoke|test):/.exec(caseId) : null;
  if (!match) return null;
  try { return decodeURIComponent(match[1]); }
  catch (error) { logger.error({ err: error }, 'Test Lab run selection carried a malformed case id'); return null; }
}

/** @description Why current authority no longer admits a held run, or undefined while it still does.
 * @param catalog Current installed catalog. @param run Held run. @param original Authority the run was admitted under.
 * @param context Fresh authority for the run's application. @returns A stable denial reason, or undefined. */
function denialReason(catalog: InstalledAppTestCatalog, run: TestLabRun, original: TestLabRunContext, context: TestLabRunContext): string | undefined {
  if (!sameActor(original,context)) return 'caller-changed';
  if (context.auth.canRunSuites !== true) return 'operator-required';
  if (!context.visibleApps.has(run.test.appName)) return 'application-unavailable';
  const test = currentTest(catalog,context,run.test);
  if (!test) return 'test-unavailable';
  if (!test.runnable) return 'test-not-runnable';
  return unchanged(run.test,test) ? undefined : 'installed-test-changed';
}

/** @description Classify a resolution that threw: the cap, a refused identity, or a failure of the resolver itself.
 * @param error Rejection from the bounded resolution. @returns Outcome and stable reason for the run log. */
function failure(error: unknown): { outcome: AuthorityOutcome; reason: string } {
  const value = error as { authorityTimeout?: boolean; status?: number } | undefined;
  if (value?.authorityTimeout === true) return { outcome: 'timeout',reason: 'authority-unanswered' };
  if ([401,403,404].includes(Number(value?.status))) return { outcome: 'denied',reason: 'identity-unavailable' };
  return { outcome: 'error',reason: 'authority-failed' };
}

/** @description Record which in-flight check refused a run and why; the caller still cancels the run.
 * @param run Held run. @param check Which check refused. @param outcome Denial, timeout or error.
 * @param reason Stable reason. @param started Check start time. @param err Underlying error, when there is one. */
function refused(run: TestLabRun, check: AuthorityCheck, outcome: AuthorityOutcome, reason: string, started: number, err?: unknown): void {
  const fields = { runId: run.id,appName: run.test.appName,caseId: run.test.id,check,outcome,reason,durationMs: Date.now() - started };
  if (outcome === 'denied') logger.warn(fields,'Test Lab run authority check refused the run');
  else logger.error({ ...fields,...(err === undefined ? {} : { err }) },'Test Lab run authority check could not complete');
}

/** Server-owned execution jobs; no paths, commands, credentials or principals are accepted from the browser. */
export class TestLabRunService {
  private readonly controllers = new Map<string, AbortController>();
  constructor(private readonly store: TestLabRunStore, private readonly catalog: InstalledAppTestCatalog) {}

  private async context(resolve: Context, scope?: string | null): Promise<TestLabRunContext> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const context = await Promise.race([resolve(scope),new Promise<never>((_resolve,reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Current authority is unavailable.'),{ authorityTimeout: true })),AUTHORITY_CAP_MS);
      })]);
      if (!context.actor?.issuer || !context.actor?.sub) refusal('A verified user identity is required.',401);
      return context;
    } finally { if (timer) clearTimeout(timer); }
  }

  private selected(input: TestLabRunSelection, context: TestLabRunContext, app: string | null): InstalledAppTestCase {
    if (!input || Object.keys(input).sort().join(',') !== 'caseId,executionRevision,requestId,revision'
      || typeof input.caseId !== 'string' || typeof input.requestId !== 'string' || typeof input.revision !== 'string'
      || typeof input.executionRevision !== 'string' || !uuid.test(input.requestId) || !hash.test(input.revision) || !hash.test(input.executionRevision)) {
      refusal('Select a current catalog case before running.',400);
    }
    if (context.auth.canRunSuites !== true) refusal('An operator is required to run package suites.');
    const test = this.catalog.list(context.visibleApps,context.auth).find(item => item.id === input.caseId);
    if (!test || test.appName !== app) refusal('This test is unavailable.',404);
    if (!['node-test','playwright','vitest'].includes(test.runner.kind) || !test.runnable) refusal(test.pendingReason ?? 'This runner is unavailable.',409);
    if (test.revision !== input.revision || test.executionRevision !== input.executionRevision) refusal('This test changed. Refresh the catalog.',409);
    return test;
  }

  /** @description Admit one fixed current catalog suite and detach its bounded execution.
   * @param input Case identity and caller-generated retry key. @param resolve Fresh server-owned caller authority.
   * @returns The durable run receipt, including an existing receipt on an exact retry.
   */
  async start(input: TestLabRunSelection, resolve: Context): Promise<TestLabRun> {
    const app = caseApplication(input?.caseId);
    const context = await this.context(resolve,app);
    const test = this.selected(input,context,app);
    const now = new Date().toISOString();
    const id = randomUUID();
    const run = await this.store.create({ id,requestId: input.requestId,actor: context.actor,test,state: 'queued',createdAt: now,updatedAt: now });
    if (!unchanged(test,run.test)) refusal('This retry key belongs to another test selection.',409);
    if (run.id === id) {
      void this.execute(run,context,resolve)
        .catch(error => logger.error({ err: error,runId: run.id,appName: run.test.appName },'Test Lab run execution failed'));
    }
    return this.read(run.id,resolve);
  }

  /** @description Re-decide current authority for the held run's own application, never every installed one. */
  private async allowed(run: TestLabRun, original: TestLabRunContext, resolve: Context, check: AuthorityCheck): Promise<boolean> {
    const started = Date.now();
    try {
      const reason = denialReason(this.catalog,run,original,await this.context(resolve,run.test.appName));
      if (reason) refused(run,check,'denied',reason,started);
      return !reason;
    } catch (error) {
      const { outcome,reason } = failure(error);
      refused(run,check,outcome,reason,started,error);
      return false;
    }
  }

  private async current(run: TestLabRun, original: TestLabRunContext, resolve: Context, check: AuthorityCheck): Promise<boolean> {
    return await this.live(run,check) && await this.allowed(run,original,resolve,check);
  }

  private async watch(run: TestLabRun, original: TestLabRunContext, resolve: Context, controller: AbortController): Promise<void> {
    const started = Date.now();
    try { if (await this.current(run,original,resolve,'watch')) return; }
    catch (error) { refused(run,'watch','error','lease-failed',started,error); }
    controller.abort();
  }

  private async live(run: TestLabRun, check: AuthorityCheck): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const started = Date.now();
    try {
      const state = await Promise.race([this.store.pulse(run.actor,run.id),
        new Promise<'unanswered'>(resolve => { timer = setTimeout(() => resolve('unanswered'),AUTHORITY_CAP_MS); })]);
      if (state === 'running') return true;
      if (state === 'unanswered') refused(run,check,'timeout','lease-unanswered',started);
      else refused(run,check,'denied',`run-${state ?? 'missing'}`,started);
      return false;
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
      void this.watch(run,original,resolve,controller).finally(() => { checking = false; });
    },2000);
    timer.unref();
    try { await this.perform(run,original,resolve,controller); }
    catch (error) {
      // Unknown execution failures retain capacity until the correlated sandbox is reaped.
      logger.error({ err: error,runId: run.id,appName: run.test.appName },'Test Lab run ended without a verified result; capacity is held until its sandbox is reaped');
      await this.store.cancel(run.actor,run.id);
    } finally { clearInterval(timer); this.controllers.delete(run.id); }
  }

  private async perform(run: TestLabRun, original: TestLabRunContext, resolve: Context, controller: AbortController): Promise<void> {
    const revalidate = () => this.current(run,original,resolve,'revalidate');
    if (!await revalidate()) controller.abort();
    let result: InstalledAppTestResult = controller.signal.aborted
      ? { name: run.test.name,path: run.test.path,status: 'pending',durationMs: 0,cleanupVerified: true,error: 'Current test access is unavailable.' }
      : await this.catalog.run(run.test,original.visibleApps,{ ...original.auth,apiBaseUrl: 'http://127.0.0.1',
        signal: controller.signal,revalidate: () => this.current(run,original,resolve,'sandbox'),executionId: run.id });
    if (!await revalidate() || controller.signal.aborted || result.cancelled) {
      controller.abort();
      result = { name: run.test.name,path: run.test.path,status: 'pending',durationMs: result.durationMs,
        cancelled: true,timedOut: result.timedOut,cleanupVerified: result.cleanupVerified,
        executionRevision: result.executionRevision,image: result.image,
        error: 'Access or the installed test changed during execution. Output was withheld.' };
    }
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
    // The owner key needs only the caller's identity; the run's own application is decided once it is known.
    const before = await this.context(resolve,null);
    const run = await this.store.get(before.actor,id);
    const after = await this.context(resolve,run ? run.test.appName : null);
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
