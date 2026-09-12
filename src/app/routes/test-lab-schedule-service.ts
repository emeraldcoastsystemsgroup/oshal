/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Re-discover current installed Node suites for exact-owner local schedules and reuse durable run authorization and evidence.
 */
import { createHash } from 'node:crypto';
import type { InstalledAppTestCatalog, InstalledAppTestCase } from '@/features/swarm-apps';
import type { TestLabRunService } from './test-lab-run-service';
import type { TestLabPrincipal, TestLabRunContext } from './test-lab-run-types';
import type { TestLabScheduleStore, TestLabSchedule, TestLabScheduleInput, TestLabScheduleContext,
  TestLabScheduledContext, TestLabScheduleClaim, TestLabScheduleBatch, TestLabBatchSummary } from './test-lab-schedule-types';

export interface TestLabScheduleOptions {
  store: TestLabScheduleStore; runs: TestLabRunService; catalog: InstalledAppTestCatalog;
  resolveScheduledContext: TestLabScheduledContext; now?: () => Date;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const active = new Set(['queued','running','cancelling']);
function refusal(message: string, status = 403): never { throw Object.assign(new Error(message), { status }); }
function same(a: TestLabPrincipal, b: TestLabPrincipal): boolean { return a.issuer === b.issuer && a.sub === b.sub; }
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.sort().join(',');
}
function input(value: unknown): TestLabScheduleInput {
  if (!exact(value,['appName','levels','cadence']) || typeof value.appName !== 'string'
    || !/^(?:\*|[a-z0-9][a-z0-9-]{0,79})$/.test(value.appName) || !['hourly','daily','weekly'].includes(String(value.cadence))
    || !Array.isArray(value.levels) || !value.levels.length || value.levels.length > 2
    || new Set(value.levels).size !== value.levels.length || value.levels.some(level => !['unit','integration'].includes(level))) {
    refusal('Select an application, supported levels and local cadence.',400);
  }
  return { appName: value.appName,levels: [...value.levels].sort(),cadence: value.cadence } as TestLabScheduleInput;
}
function runRequest(batchId: string, caseId: string): string {
  const value = createHash('sha256').update(JSON.stringify([batchId,caseId])).digest('hex');
  return `${value.slice(0,8)}-${value.slice(8,12)}-4${value.slice(13,16)}-8${value.slice(17,20)}-${value.slice(20,32)}`;
}
async function context(resolve: TestLabScheduleContext, admin = true): Promise<TestLabRunContext> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const current = await Promise.race([resolve(),new Promise<never>((_,reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Current schedule authority is unavailable.'),{ status: 503 })),5000);
    })]);
    if (!current.actor?.issuer || !current.actor.sub) refusal('A verified user is required.',401);
    if (admin && current.auth.canRunSuites !== true) refusal('Current operator access is required for local schedules.');
    return current;
  } finally { if (timer) clearTimeout(timer); }
}

/** @description Server-owned local scheduling; no session tokens, commands, paths or user-supplied authority are persisted. */
export class TestLabScheduleService {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private cycling = false;
  private readonly running = new Set<string>();
  constructor(private readonly options: TestLabScheduleOptions) {}

  private async owned(id: string, resolve: TestLabScheduleContext, admin = true) {
    if (!UUID.test(id)) refusal('Schedule not found.',404);
    const current = await context(resolve,admin), item = await this.options.store.get(current.actor,id);
    if (!item) refusal('Schedule not found.',404);
    return { current,item };
  }
  private selection(item: TestLabScheduleInput, current: TestLabRunContext) {
    if (item.appName !== '*' && !current.visibleApps.has(item.appName)) refusal('Application is unavailable.',404);
    return new Map([...current.visibleApps].filter(([name]) => item.appName === '*' || item.appName === name));
  }
  private visibleBatch(row: TestLabScheduleBatch, current: TestLabRunContext): TestLabScheduleBatch {
    const names = [...row.summary.runs,...row.summary.unavailable,...row.summary.drift].map(entry => entry.appName);
    return names.some(name => !current.visibleApps.has(name)) ? { ...row,summary: { selected: 0,deferred: 0,runs: [],unavailable: [],drift: [],
      error: 'Some applications are no longer visible. Their batch details were withheld.' } } : row;
  }

  /** @description List owner schedules and current catalog-derived selection choices.
   * @param resolve Fresh verified caller. @returns Schedules and honest available/pending suite counts. */
  async list(resolve: TestLabScheduleContext) {
    const before = await context(resolve,false), schedules = await this.options.store.list(before.actor), after = await context(resolve,false);
    if (!same(before.actor,after.actor)) refusal('User changed. Refresh the page.');
    const tests = this.options.catalog.list(after.visibleApps,after.auth);
    const apps = [...after.visibleApps].map(([name,displayName]) => ({ name,displayName,
      eligible: tests.filter(test => test.appName === name && test.runner.kind === 'node-test' && test.runnable).length,
      pending: tests.filter(test => test.appName === name && !test.runnable).length }));
    const scoped = schedules.map(item => item.appName !== '*' && !after.visibleApps.has(item.appName)
      ? { ...item,appName: 'unavailable',unavailable: true } : item);
    return { schedules: scoped,options: { canSchedule: after.auth.canRunSuites === true,apps,
      levels: ['unit','integration'],cadences: ['hourly','daily','weekly'],maxCases: 100 } };
  }
  /** @description Save a reviewed selector as disabled; registration never schedules execution automatically.
   * @param value Closed browser input. @param resolve Fresh caller. @returns Disabled draft. */
  async create(value: unknown, resolve: TestLabScheduleContext): Promise<TestLabSchedule> {
    const selected = input(value), current = await context(resolve); this.selection(selected,current);
    return this.options.store.create(current.actor,selected);
  }
  /** @description Change only enablement with optimistic revision checking; disable invalidates any current batch.
   * @param id Schedule UUID. @param value Exact revision/enablement body. @param resolve Fresh caller. @returns Updated schedule. */
  async update(id: string, value: unknown, resolve: TestLabScheduleContext): Promise<TestLabSchedule> {
    if (!exact(value,['revision','enabled']) || !Number.isInteger(value.revision) || Number(value.revision) < 1 || typeof value.enabled !== 'boolean') refusal('Select the current schedule revision and enablement.',400);
    const { current,item } = await this.owned(id,resolve,value.enabled); if (value.enabled) this.selection(item,current);
    const result = await this.options.store.update(current.actor,id,Number(value.revision),value.enabled,this.options.now?.() ?? new Date());
    if (!result) refusal('Schedule changed. Refresh before saving.',409); return result;
  }
  /** @description Run a disabled draft once or request an extra enabled occurrence without changing its cadence.
   * @param id Schedule UUID. @param value Exact revision and retry UUID. @param resolve Fresh caller. @returns Durable batch receipt. */
  async runNow(id: string, value: unknown, resolve: TestLabScheduleContext): Promise<TestLabScheduleBatch> {
    if (!exact(value,['revision','requestId']) || !Number.isInteger(value.revision) || Number(value.revision) < 1
      || typeof value.requestId !== 'string' || !UUID.test(value.requestId)) refusal('Select the current schedule revision and retry identifier.',400);
    const { current,item } = await this.owned(id,resolve); this.selection(item,current);
    const claim = await this.options.store.claim(current.actor,id,Number(value.revision),value.requestId);
    try {
      const after = await context(resolve);
      if (!same(current.actor,after.actor)) refusal('User changed. Refresh the page.'); this.selection(item,after);
      if (claim.created) this.launch(claim); return this.visibleBatch(claim.batch,after);
    } catch (error) {
      if (claim.created) await this.options.store.finish(claim.batch,'cancelled',{ ...claim.batch.summary,error: 'Current schedule authority changed before dispatch.' });
      throw error;
    }
  }
  /** @description Return metadata links only while applications remain currently visible; run output uses existing guarded /runs.
   * @param id Schedule UUID. @param resolve Fresh exact caller. @returns Latest bounded batch history. */
  async history(id: string, resolve: TestLabScheduleContext): Promise<TestLabScheduleBatch[]> {
    const { current,item } = await this.owned(id,resolve,false), rows = await this.options.store.history(current.actor,id);
    const after = await context(resolve,false); if (!same(current.actor,after.actor)) refusal('User changed. Refresh the page.');
    this.selection(item,after);
    return rows.map(row => this.visibleBatch(row,after));
  }

  /** @description Start local polling; schedules remain disabled until a user explicitly enables one.
   * @param intervalMs Controller-only polling interval. @returns Nothing. */
  startPolling(intervalMs = 15000): void {
    if (this.timer) return;
    if (!Number.isInteger(intervalMs) || intervalMs < 1000) throw new Error('Invalid schedule poll interval');
    this.stopped = false; this.timer = setInterval(() => { void this.tick().catch(() => undefined); },intervalMs); this.timer.unref();
  }
  /** @description Stop polling and make active runner callbacks refuse further execution. @returns Nothing. */
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  /** @description Claim at most one durable due occurrence; missed intervals do not replay a backlog.
   * @returns New durable batch or null. */
  async tick(): Promise<TestLabScheduleBatch | null> {
    if (this.stopped || this.cycling) return null; this.cycling = true;
    try {
      const claim = await this.options.store.claimDue(this.options.now?.() ?? new Date());
      if (!claim) return null; this.launch(claim); return claim.batch;
    } finally { this.cycling = false; }
  }
  private launch(claim: TestLabScheduleClaim): void {
    if (this.running.has(claim.batch.id)) return; this.running.add(claim.batch.id);
    void this.perform(claim).catch(() => undefined).finally(() => this.running.delete(claim.batch.id));
  }
  private batchContext(claim: TestLabScheduleClaim, cancelled: () => boolean): TestLabScheduleContext {
    return () => context(async () => {
      if (this.stopped || cancelled() || !await this.options.store.heartbeat(claim.batch)) refusal('Schedule is no longer active.');
      const current = await this.options.resolveScheduledContext(claim.batch.actor);
      if (!same(current.actor,claim.batch.actor)) refusal('Scheduled owner changed.');
      this.selection(claim.schedule,current); return current;
    });
  }
  private discover(claim: TestLabScheduleClaim, current: TestLabRunContext, summary: TestLabBatchSummary): InstalledAppTestCase[] {
    const visible = this.selection(claim.schedule,current), tests = this.options.catalog.list(visible,current.auth)
      .filter(test => claim.schedule.levels.includes(test.level as 'unit' | 'integration'));
    const eligible = tests.filter(test => test.runnable && test.runner.kind === 'node-test' && test.runner.scope === 'package');
    summary.unavailable = tests.filter(test => !eligible.includes(test)).slice(0,100)
      .map(test => ({ appName: test.appName,caseId: test.id,reason: test.pendingReason || 'This suite requires another supported runner.' }));
    summary.selected = Math.min(eligible.length,100); summary.deferred = Math.max(eligible.length-100,0);
    summary.drift = this.options.catalog.inventory(visible).slice(0,100);
    return eligible.slice(0,100);
  }
  private async perform(claim: TestLabScheduleClaim): Promise<void> {
    const summary: TestLabBatchSummary = { selected: 0,deferred: 0,unavailable: [],drift: [],runs: [] };
    let cancelled = false;
    const deadline = setTimeout(() => { cancelled = true; },1800000); deadline.unref();
    const resolve = this.batchContext(claim,() => cancelled);
    try {
      const tests = this.discover(claim,await resolve(),summary);
      await this.options.store.checkpoint(claim.batch,summary);
      for (const test of tests) {
        try { await this.runOne(claim,test,summary,resolve); }
        catch { cancelled = true; summary.deferred += tests.length-summary.runs.length; summary.error = 'Batch stopped because current authority, selection or runner admission became unavailable.'; break; }
      }
    } catch { cancelled = true; summary.error = 'Current schedule authority or installed catalog is unavailable.'; }
    finally {
      clearTimeout(deadline);
      await this.options.store.finish(claim.batch,cancelled ? 'cancelled' : 'completed',summary);
    }
  }
  private async runOne(claim: TestLabScheduleClaim, test: InstalledAppTestCase, summary: TestLabBatchSummary, resolve: TestLabScheduleContext): Promise<void> {
    await resolve();
    const run = await this.options.runs.start({ caseId: test.id,revision: test.revision,executionRevision: test.executionRevision!,
      requestId: runRequest(claim.batch.id,test.id) },resolve);
    const entry = { appName: test.appName,caseId: test.id,runId: run.id,state: run.state }; summary.runs.push(entry);
    await this.options.store.checkpoint(claim.batch,summary);
    while (active.has(entry.state)) {
      await new Promise<void>(done => setTimeout(done,1000));
      await resolve(); entry.state = (await this.options.runs.read(run.id,resolve)).state;
    }
    await this.options.store.checkpoint(claim.batch,summary);
  }
}
