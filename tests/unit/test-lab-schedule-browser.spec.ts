/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify disabled schedule creation, explicit execution, current controls and exact-owner history in the actual Lab browser.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Prove automatic recovery from a temporary history failure without retrying execution or retaining stale evidence.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Synchronize schedule creation with actual mutation and refreshed history responses, proving delayed creation still preserves stale-revision refusal.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Exercise catalog refresh during an actual pending schedule creation and correlate refreshed rows with their created identifier.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Prove single-package batch admission, selector preservation and uncertain-response refusal with real services and exact-owned browser cleanup.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Prove run history stays current across the gaps between batch children, a selection change and the terminal read without a manual refresh.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Give the hooks that own the isolated fixture browser the fixture's exit budget, so a confirmed but slow shutdown on a loaded box is failed by neither deadline.
 */
import { afterAll,afterEach,beforeAll,beforeEach,expect,it,vi } from 'vitest';
import { type Browser,type BrowserContext,type Page } from 'playwright';
import { readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';
import { SCHEDULE_ACTOR,startTestLabScheduleFixture } from '../fixtures/test-lab-schedules';
import type { TestLabScheduleService } from '@/app/routes/test-lab-schedule-service';
import { BROWSER_HOOK_TIMEOUT_MS, launchIsolatedBrowser } from '../fixtures/isolated-browser';
import yaml from 'js-yaml';

vi.setConfig({ hookTimeout: BROWSER_HOOK_TIMEOUT_MS });

const database = new DisposableAlertPostgres();
let pool: Pool,browser: Browser,context: BrowserContext,page: Page;
let fixture: Awaited<ReturnType<typeof startTestLabScheduleFixture>>;
let packageSource: ReturnType<typeof fixture.addPackage>;
let owned: Awaited<ReturnType<typeof launchIsolatedBrowser>>;
beforeAll(async () => {
  pool = await database.start();
  for (const name of ['136-test-lab-runs.sql','137-test-lab-local-schedules.sql']) await pool.query(readFileSync(resolve('scripts/migrations',name),'utf8'));
  owned = await launchIsolatedBrowser({ headless: true }); browser = owned.browser;
},45000);
afterAll(async () => {
  try {
    const cleanup = await owned?.close();
    if (cleanup && process.env.OSHAL_BATCH_CLEANUP_DIR) writeFileSync(resolve(process.env.OSHAL_BATCH_CLEANUP_DIR,
      `package-batch-browser-cleanup-${cleanup.pid}-${Date.now()}.json`),JSON.stringify(cleanup,null,2)+'\n',{ flag: 'wx' });
  } finally { await database.stop(); }
},30000);
beforeEach(async () => {
  await pool.query('TRUNCATE oshal_test_lab_schedule_batches,oshal_test_lab_schedules,oshal_test_lab_runs');
  fixture = await startTestLabScheduleFixture(pool); packageSource = fixture.addPackage({ name: 'schedule-browser' });
  context = await browser.newContext(); await context.route('**/*',route => new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(15000);
  if (process.env.OSHAL_BATCH_BASELINE_HTML) await page.route('**/api/test-lab/app',route => route.fulfill({
    contentType: 'text/html',body: readFileSync(process.env.OSHAL_BATCH_BASELINE_HTML!,'utf8') }));
  await page.goto(fixture.base+'/api/test-lab/app');
  await expect.poll(() => page.locator('#runStatus').textContent(),{ timeout: 10000 }).toContain('Ready.');
  await page.locator('#schedulePanel > summary').click();
  await expect.poll(() => page.locator('#scheduleStatus').textContent(),{ timeout: 10000 }).toContain('current catalog');
},30000);
afterEach(async () => { await page?.unrouteAll({ behavior: 'ignoreErrors' }); await context?.close(); await fixture?.close(); },60000);

async function createDraft() {
  await page.locator('#scheduleApp').selectOption('schedule-browser');
  await page.locator('#scheduleCadence').selectOption('daily');
  const endpoint = fixture.base+'/api/test-lab/schedules';
  const created = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST');
  const refreshed = page.waitForResponse(async response => {
    if (response.url() !== endpoint || response.request().method() !== 'GET' || response.status() !== 200) return false;
    const schedule = (await (await created).json()).schedule;
    return (await response.json()).schedules.some((item: { id: string }) => item.id === schedule.id);
  }).catch(() => undefined);
  await page.locator('#createSchedule').click();
  const response = await created;
  expect(response.status(),await response.text()).toBe(201);
  const schedule = (await response.json()).schedule;
  const current = await refreshed;
  expect(current,'Schedule creation must refresh the authoritative list').toBeDefined();
  expect(current!.status(),await current!.text()).toBe(200);
  expect((await current!.json()).schedules).toEqual([expect.objectContaining({ id: schedule.id,appName: 'schedule-browser',enabled: false })]);
  await expect.poll(() => page.locator('[data-schedule-id]').count()).toBe(1);
  expect(await page.locator('[data-schedule-id]').getAttribute('data-schedule-id')).toBe(schedule.id);
  return schedule;
}

function historyErrors(service: TestLabScheduleService): string[] {
  const errors: string[] = []; const original = service.history.bind(service);
  service.history = async (...args) => {
    try { return await original(...args); }
    catch (error: any) { errors.push([error?.name,error?.code,error?.message].filter(Boolean).join(': ')); throw error; }
  };
  return errors;
}

async function selectPackage() {
  await page.locator('#historyApp').selectOption('schedule-browser');
  await expect.poll(() => page.locator('#packageBatchCounts').textContent()).toContain('ready /');
}

async function fullSelector(cadence = 'daily') {
  const response = await fixture.call('/schedules','POST',{ appName: 'schedule-browser',levels: ['unit','integration'],cadence });
  expect(response.status).toBe(201); return (await response.json()).schedule;
}

it('waits for the delayed batch asset before initializing catalog and schedule controls',async () => {
  await page.route('**/api/test-lab/package-batch.js',async route => {
    await new Promise<void>(done => setTimeout(done,300)); await route.continue();
  });
  await page.reload();
  await expect.poll(() => page.locator('#runStatus').textContent(),{ timeout: 2000 }).toContain('Ready.');
  await selectPackage(); expect(await page.locator('#runPackageBatch').isDisabled()).toBe(false);
  expect(fixture.sandbox.calls).toBe(0);
});

it('runs one selected package once despite a double click and keeps automatic scheduling disabled',async () => {
  const cases = [packageSource.test,
    { ...packageSource.test,id: 'framework-pending',prerequisites: ['framework-checkout:oshal-core-dir'] },
    { ...packageSource.test,id: 'browser-pending',level: 'browser',runner: { ...packageSource.test.runner,kind: 'playwright' },prerequisites: ['runner:playwright'] }];
  writeFileSync(resolve(packageSource.dir,'tests/test-lab.yaml'),yaml.dump({ version: 1,cases })); fixture.catalog.register(packageSource.record);
  expect(await page.locator('#runPackageBatch').count()).toBe(1);
  expect(await page.locator('#runPackageBatch').isDisabled()).toBe(true); await selectPackage();
  expect(await page.locator('#packageBatchCounts').textContent()).toContain('1 ready / 2 unavailable');
  let release!: () => void, entered!: () => void, creates = 0, claims = 0;
  const held = new Promise<void>(done => { release = done; }), arrived = new Promise<void>(done => { entered = done; });
  await page.route('**/api/test-lab/schedules',async route => {
    if (route.request().method() === 'POST') { creates++; entered(); await held; }
    await route.continue();
  });
  page.on('request',request => { if (request.url().endsWith('/run-now')) claims++; });
  try {
    await page.locator('#runPackageBatch').evaluate((button: HTMLButtonElement) => { button.click(); button.click(); }); await arrived;
    expect(await page.locator('#historyApp').isDisabled()).toBe(true);
    expect(await page.locator('#runPackageBatch').isDisabled()).toBe(true);
  } finally { release(); }
  await expect.poll(() => page.locator('#packageBatchStatus').textContent()).toContain('admitted');
  await expect.poll(() => page.locator('#scheduleHistory').textContent(),{ timeout: 45000 }).toContain('completed');
  expect(await page.locator('#scheduleHistory').textContent()).toContain('browser-pending');
  expect(await page.locator('#scheduleHistory').textContent()).toContain('framework-pending');
  const schedules = (await (await fixture.call('/schedules')).json()).schedules;
  expect(schedules).toEqual([expect.objectContaining({ enabled: false,levels: ['integration','unit'],cadence: 'daily' })]);
  expect(creates).toBe(1); expect(claims).toBe(1); expect(fixture.sandbox.calls).toBe(1);
},90000);

it('reuses an exact disabled selector without changing cadence and reports a failed suite honestly',async () => {
  writeFileSync(packageSource.helperPath,'exports.lineTotal = () => 1;\n'); fixture.catalog.register(packageSource.record);
  const schedule = await fullSelector('weekly');
  await selectPackage(); const mutations: string[] = [];
  page.on('request',request => { if (request.method() !== 'GET') mutations.push(request.method()+' '+new URL(request.url()).pathname); });
  await page.locator('#runPackageBatch').click();
  await expect.poll(() => page.locator('#scheduleHistory').textContent(),{ timeout: 45000 }).toContain('failed');
  expect(mutations).toEqual(['POST /api/test-lab/schedules/'+schedule.id+'/run-now']);
  expect((await (await fixture.call('/schedules')).json()).schedules[0]).toMatchObject({ cadence: 'weekly',enabled: false,revision: 1 });
  expect((await fixture.finished(schedule.id))!.summary.runs[0].state).toBe('failed');
},90000);

it.each(['different levels','enabled'])('does not change an existing selector with %s',async variant => {
  const body = { appName: 'schedule-browser',levels: variant === 'different levels' ? ['unit'] : ['unit','integration'],cadence: 'weekly' };
  const schedule = (await (await fixture.call('/schedules','POST',body)).json()).schedule;
  if (variant === 'enabled') await fixture.call('/schedules/'+schedule.id,'PATCH',{ revision: 1,enabled: true });
  const before = (await (await fixture.call('/schedules')).json()).schedules;
  await selectPackage(); expect(await page.locator('#runPackageBatch').isDisabled()).toBe(true);
  expect(await page.locator('#packageBatchCounts').textContent()).toContain('It was not changed');
  expect((await (await fixture.call('/schedules')).json()).schedules).toEqual(before);
  expect(fixture.sandbox.calls).toBe(0);
});

it('rechecks operator access before shortcut creation or admission',async () => {
  await selectPackage(); fixture.state.admin = false; await page.locator('#runPackageBatch').click();
  await expect.poll(() => page.locator('#packageBatchCounts').textContent()).toContain('operator access');
  expect(await page.locator('#runPackageBatch').isDisabled()).toBe(true);
  expect((await (await fixture.call('/schedules')).json()).schedules).toEqual([]); expect(fixture.sandbox.calls).toBe(0);
});

it('refuses a selector revision changed after its fresh read without starting a batch',async () => {
  const schedule = await fullSelector(); await selectPackage(); let changed = false;
  await page.route('**/api/test-lab/schedules',async route => {
    const response = await route.fetch();
    if (!changed && route.request().method() === 'GET') {
      changed = true; expect((await fixture.call('/schedules/'+schedule.id,'PATCH',{ revision: 1,enabled: true })).status).toBe(200);
    }
    await route.fulfill({ response });
  });
  await page.locator('#runPackageBatch').click();
  await expect.poll(() => page.locator('#packageBatchStatus').textContent()).toContain('changed');
  expect((await pool.query('SELECT count(*)::int AS total FROM oshal_test_lab_schedule_batches')).rows[0].total).toBe(0);
  expect(fixture.sandbox.calls).toBe(0);
});

it.each(['create','claim'])('never retries an uncertain %s response even when the server committed it',async phase => {
  const existing = phase === 'claim' ? await fullSelector() : null; await selectPackage(); let posts = 0;
  const endpoint = phase === 'create' ? '**/api/test-lab/schedules' : '**/schedules/'+existing.id+'/run-now';
  await page.route(endpoint,async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    posts++; const response = await route.fetch(); expect(response.ok()).toBe(true);
    await route.fulfill({ status: 502,contentType: 'text/html',body: '<!doctype html><title>Synthetic gateway</title>' });
  });
  await page.locator('#runPackageBatch').click();
  await expect.poll(() => page.locator('#packageBatchStatus').textContent()).toContain('No automatic retry');
  expect(await page.locator('#packageBatchStatus').textContent()).not.toContain('admitted');
  const rows = (await (await fixture.call('/schedules')).json()).schedules; expect(rows).toHaveLength(1);
  if (existing) await fixture.finished(existing.id);
  expect(posts).toBe(1);
  expect((await pool.query('SELECT count(*)::int AS total FROM oshal_test_lab_schedule_batches')).rows[0].total).toBe(existing ? 1 : 0);
  expect(fixture.sandbox.calls).toBe(existing ? 1 : 0);
},90000);

it('shows the single saved draft when catalog refresh completes during its pending creation',async () => {
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(done => { release = done; });
  const entered = new Promise<void>(done => { arrived = done; });
  const endpoint = fixture.base+'/api/test-lab/schedules';
  await page.route(endpoint,async route => {
    if (route.request().method() === 'POST') { arrived(); await held; }
    await route.continue();
  });
  await page.locator('#scheduleApp').selectOption('schedule-browser');
  const created = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST');
  try {
    await page.locator('#createSchedule').click(); await entered;
    const catalogRead = page.waitForResponse(fixture.base+'/api/test-lab/catalog');
    await page.locator('#refreshCatalog').click(); await catalogRead;
    await expect.poll(() => page.locator('#runStatus').textContent()).toContain('Ready.');
  } finally { release(); }
  const response = await created;
  expect(response.status(),await response.text()).toBe(201);
  const schedule = (await response.json()).schedule;
  expect((await (await fixture.call('/schedules')).json()).schedules).toEqual([
    expect.objectContaining({ id: schedule.id,appName: 'schedule-browser',enabled: false }),
  ]);
  await expect.poll(() => page.locator('[data-schedule-id]').count()).toBe(1);
  expect(await page.locator('[data-schedule-id]').getAttribute('data-schedule-id')).toBe(schedule.id);
});

it('discards a list response captured before the current schedule mutation',async () => {
  let release!: () => void, arrived!: () => void, reads = 0;
  const held = new Promise<void>(done => { release = done; });
  const entered = new Promise<void>(done => { arrived = done; });
  await page.route('**/api/test-lab/schedules',async route => {
    if (route.request().method() !== 'GET' || ++reads !== 1) { await route.continue(); return; }
    const response = await route.fetch(); arrived(); await held; await route.fulfill({ response });
  });
  const oldRead = page.waitForResponse(async response => response.url() === fixture.base+'/api/test-lab/schedules'
    && response.request().method() === 'GET' && (await response.json()).schedules.length === 0);
  let schedule: { id: string };
  try {
    await page.locator('#refreshSchedules').click(); await entered;
    schedule = await createDraft();
  } finally { release(); }
  await (await oldRead).finished();
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await expect.poll(() => page.locator('[data-schedule-id]').count()).toBe(1);
  expect(await page.locator('[data-schedule-id]').getAttribute('data-schedule-id')).toBe(schedule.id);
});

it('refreshes current authority after closing and reopening during a saved mutation without showing the former owner rows',async () => {
  const schedule = await createDraft();
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(done => { release = done; });
  const entered = new Promise<void>(done => { arrived = done; });
  await page.route('**/api/test-lab/schedules/'+schedule.id,async route => {
    const response = await route.fetch(); arrived(); await held; await route.fulfill({ response });
  });
  try {
    await page.locator('[data-schedule-enable]').click(); await entered;
    await page.locator('#schedulePanel > summary').click();
    await expect.poll(() => page.locator('#scheduleList').textContent()).toBe('');
    fixture.state.admin = false;
    await context.setExtraHTTPHeaders({ 'x-fixture-issuer': 'other' });
    await page.locator('#schedulePanel > summary').click();
    expect(await page.locator('#createSchedule').isDisabled()).toBe(true);
  } finally { release(); }
  await expect.poll(() => page.locator('#scheduleStatus').textContent()).toContain('operator');
  expect(await page.locator('#scheduleList').textContent()).toContain('No schedules');
  expect(await page.locator('#createSchedule').isDisabled()).toBe(true);
  expect((await (await fixture.call('/schedules')).json()).schedules).toEqual([
    expect.objectContaining({ id: schedule.id,enabled: true }),
  ]);
});

it('creates a disabled selector, explicitly enables and runs it through the sandbox, then follows durable result history',async () => {
  const errors = historyErrors(fixture.service());
  const schedule = await createDraft();
  expect(schedule.enabled).toBe(false); expect(schedule.levels).toEqual(['unit']);
  expect((await pool.query('SELECT count(*)::int AS total FROM oshal_test_lab_runs')).rows[0].total).toBe(0);
  await page.locator('[data-schedule-enable]').click();
  await expect.poll(() => page.locator('[data-schedule-enable]').textContent()).toBe('Disable');
  await page.locator('[data-schedule-run]').click();
  await fixture.finished(schedule.id);
  await expect.poll(async () => ({ text: await page.locator('#scheduleHistory').textContent(),errors }),{ timeout: 15000 })
    .toMatchObject({ text: expect.stringContaining('completed') });
  await expect.poll(() => page.locator('#scheduleHistory').textContent()).toContain('passed');
  await page.locator('[data-schedule-evidence]').click();
  await expect.poll(() => page.locator('#runEvidence').textContent()).toContain('# pass 2');
  await page.reload(); await page.locator('#schedulePanel > summary').click();
  await page.locator('[data-schedule-history]').click();
  await expect.poll(() => page.locator('#scheduleHistory').textContent()).toContain('completed');
},90000);

it('refuses a stale enablement revision in the row and refreshes the authoritative current state',async () => {
  let creations = 0;
  await page.route('**/api/test-lab/schedules',async route => {
    if (route.request().method() === 'POST') {
      creations++;
      await new Promise(resolveDelay => setTimeout(resolveDelay,1500));
    }
    await route.continue();
  });
  const schedule = await createDraft();
  expect(creations).toBe(1);
  expect((await fixture.call('/schedules/'+schedule.id,'PATCH',{ revision: schedule.revision,enabled: true })).status).toBe(200);
  await page.locator('[data-schedule-enable]').click();
  await expect.poll(() => page.locator('#scheduleStatus').textContent()).toContain('changed');
  expect((await (await fixture.call('/schedules')).json()).schedules[0].revision).toBe(2);
  await page.locator('#refreshSchedules').click();
  await expect.poll(() => page.locator('[data-schedule-enable]').textContent()).toBe('Disable');
  expect((await pool.query('SELECT count(*)::int AS total FROM oshal_test_lab_runs')).rows[0].total).toBe(0);
});

it('recovers a temporary history read automatically without starting another batch or exposing stale output',async () => {
  const schedule = await createDraft();
  await fixture.call('/schedules/'+schedule.id+'/run-now','POST',{ revision: schedule.revision,requestId: crypto.randomUUID() });
  await fixture.finished(schedule.id);
  let reads = 0;
  await page.route('**/schedules/'+schedule.id+'/history',async route => {
    reads++;
    if (reads === 1) await route.fulfill({ status: 503,contentType: 'application/json',body: JSON.stringify({ error: 'Temporary fixture history read failure.' }) });
    else await route.continue();
  });
  await page.locator('[data-schedule-history]').click();
  await expect.poll(() => page.locator('#scheduleHistory').textContent()).toContain('Retrying');
  expect(await page.locator('#runEvidence').textContent()).toBe('');
  await expect.poll(() => page.locator('#scheduleHistory').textContent(),{ timeout: 10000 }).toContain('completed');
  expect(reads).toBe(2);
  expect((await pool.query('SELECT count(*)::int AS total FROM oshal_test_lab_schedule_batches')).rows[0].total).toBe(1);
},90000);

it('keeps another issuer out of same-sub schedule history and disables creation and execution after operator revocation',async () => {
  await createDraft(); fixture.state.admin = false;
  await page.locator('#refreshSchedules').click();
  await expect.poll(() => page.locator('#scheduleStatus').textContent()).toContain('operator');
  expect(await page.locator('#createSchedule').isDisabled()).toBe(true);
  expect(await page.locator('[data-schedule-run]').isDisabled()).toBe(true);
  expect(await page.locator('[data-schedule-enable]').isDisabled()).toBe(true);
  await context.setExtraHTTPHeaders({ 'x-fixture-issuer': 'other' });
  await page.reload(); await page.locator('#schedulePanel > summary').click();
  await expect.poll(() => page.locator('#scheduleList').textContent()).toContain('No schedules');
});

it('keeps run history current across the gaps between batch children, a selection change and the terminal read without a manual refresh',async () => {
  const cases = ['first','second','third'].map(suffix => ({ ...packageSource.test,id: packageSource.test.id+'-'+suffix }));
  writeFileSync(resolve(packageSource.dir,'tests/test-lab.yaml'),yaml.dump({ version: 1,cases })); fixture.catalog.register(packageSource.record);
  // A real gap: the second and third children are admitted four seconds after the previous one finished,
  // longer than the 1.5 s run poll, so no run is active while the batch is still running.
  const start = fixture.runs.start.bind(fixture.runs); let starts = 0;
  fixture.runs.start = async (...args: Parameters<typeof start>) => {
    if (++starts > 1) await new Promise<void>(done => setTimeout(done,4000));
    return start(...args);
  };
  const historyReads: string[] = [];
  page.on('request',request => { const url = new URL(request.url()); if (url.pathname === '/api/test-lab/runs') historyReads.push(url.search); });
  await selectPackage(); await page.locator('#runPackageBatch').click();
  await expect.poll(() => page.locator('#packageBatchStatus').textContent()).toContain('admitted');
  const schedule = (await (await fixture.call('/schedules')).json()).schedules[0];
  // The first child has finished and nothing is active while the batch still runs: where the rows used to freeze.
  await expect.poll(async () => ({ rows: await page.locator('[data-history-id]').count(),active: await page.locator('[data-cancel-id]').count() }),
    { timeout: 60000 }).toEqual({ rows: 1,active: 0 });
  expect((await fixture.store.history(SCHEDULE_ACTOR,schedule.id))[0].state).toBe('running');
  // One transient failure of the runs read while the batch is followed must not end the follow.
  let failed = false;
  await page.route((url: URL) => url.pathname === '/api/test-lab/runs',async route => {
    if (failed) { await route.continue(); return; }
    failed = true; await route.fulfill({ status: 503,contentType: 'application/json',body: JSON.stringify({ error: 'Temporary fixture run history failure.' }) });
  });
  await expect.poll(() => page.locator('#runHistory').textContent(),{ timeout: 10000 }).toContain('Retrying');
  await page.locator('#historyApp').selectOption(''); await page.locator('#historyApp').selectOption('schedule-browser');
  // No clicks from here on: the page must reach three passed rows by itself.
  await expect.poll(() => page.locator('[data-history-id]').count(),{ timeout: 90000 }).toBe(3);
  expect((await fixture.finished(schedule.id)).state).toBe('completed');
  await expect.poll(async () => ((await page.locator('#runHistory').textContent()) ?? '').match(/ · passed/g)?.length ?? 0).toBe(3);
  expect(await page.locator('[data-cancel-id]').count()).toBe(0);
  await page.waitForTimeout(3000); const settled = historyReads.length;
  await page.waitForTimeout(5000); expect(historyReads.length,'polling must stop once the batch is terminal').toBe(settled);
  expect(failed).toBe(true); expect(fixture.sandbox.calls).toBe(3);
},180000);
