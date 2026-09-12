/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify disabled schedule creation, explicit execution, current controls and exact-owner history in the actual Lab browser.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Prove automatic recovery from a temporary history failure without retrying execution or retaining stale evidence.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Synchronize schedule creation with actual mutation and refreshed history responses, proving delayed creation still preserves stale-revision refusal.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Exercise catalog refresh during an actual pending schedule creation and correlate refreshed rows with their created identifier.
 */
import { afterAll,afterEach,beforeAll,beforeEach,expect,it } from 'vitest';
import { chromium,type Browser,type BrowserContext,type Page } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';
import { startTestLabScheduleFixture } from '../fixtures/test-lab-schedules';
import type { TestLabScheduleService } from '@/app/routes/test-lab-schedule-service';

const database = new DisposableAlertPostgres();
let pool: Pool,browser: Browser,context: BrowserContext,page: Page;
let fixture: Awaited<ReturnType<typeof startTestLabScheduleFixture>>;
beforeAll(async () => {
  pool = await database.start();
  for (const name of ['136-test-lab-runs.sql','137-test-lab-local-schedules.sql']) await pool.query(readFileSync(resolve('scripts/migrations',name),'utf8'));
  browser = await chromium.launch({ headless: true });
},45000);
afterAll(async () => { await browser?.close(); await database.stop(); },30000);
beforeEach(async () => {
  await pool.query('TRUNCATE oshal_test_lab_schedule_batches,oshal_test_lab_schedules,oshal_test_lab_runs');
  fixture = await startTestLabScheduleFixture(pool); fixture.addPackage({ name: 'schedule-browser' });
  context = await browser.newContext(); await context.route('**/*',route => new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(15000); await page.goto(fixture.base+'/api/test-lab/app');
  await expect.poll(() => page.locator('#runStatus').textContent(),{ timeout: 10000 }).toContain('Ready.');
  await page.locator('#schedulePanel > summary').click();
  await expect.poll(() => page.locator('#scheduleStatus').textContent(),{ timeout: 10000 }).toContain('current catalog');
},30000);
afterEach(async () => { await context?.close(); await fixture?.close(); },60000);

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
