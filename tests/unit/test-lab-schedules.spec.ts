/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise actual scheduled Node execution, exact-owner HTTP, dynamic catalog discovery, durable concurrency and current-rights refusal.
 */
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import yaml from 'js-yaml';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';
import { startTestLabScheduleFixture, SCHEDULE_ACTOR, waitForSchedule } from '../fixtures/test-lab-schedules';
import { TEST_LAB_SCHEDULE_STATEMENTS } from '@/app/routes/test-lab-schedule-schema';

const database = new DisposableAlertPostgres();
let pool: Pool, f: Awaited<ReturnType<typeof startTestLabScheduleFixture>>;
beforeAll(async () => {
  pool = await database.start();
  for (const name of ['136-test-lab-runs.sql','137-test-lab-local-schedules.sql']) await pool.query(readFileSync(resolve('scripts/migrations',name),'utf8'));
  await pool.query(readFileSync(resolve('scripts/migrations/137-test-lab-local-schedules.sql'),'utf8'));
  for (const sql of TEST_LAB_SCHEDULE_STATEMENTS) await pool.query(sql);
},60000);
beforeEach(async () => {
  await pool.query('TRUNCATE oshal_test_lab_schedule_batches,oshal_test_lab_schedules,oshal_test_lab_runs CASCADE');
  f = await startTestLabScheduleFixture(pool);
});
afterEach(async () => { if (f) await f.close(); },60000);
afterAll(async () => { await database.stop(); },60000);

/** @description Create a real disabled HTTP schedule. @param appName Current app selector. @returns Actual saved schedule. */
async function draft(appName = '*') {
  const response = await f.call('/schedules','POST',{ appName,levels: ['unit','integration'],cadence: 'daily' });
  expect(response.status).toBe(201); return (await response.json()).schedule;
}
/** @description Request one real occurrence with an explicit retry key. @param schedule Current draft or enabled record.
 * @param requestId Stable user request key. @returns Durable admitted batch. */
async function runNow(schedule: { id: string; revision: number }, requestId = randomUUID()) {
  const response = await f.call(`/schedules/${schedule.id}/run-now`,'POST',{ revision: schedule.revision,requestId });
  expect(response.status).toBe(202); return (await response.json()).batch;
}

it('creates a disabled draft, runs actual Node assertions once and links the existing exact-owner durable result', async () => {
  f.addPackage(); const saved = await draft();
  expect(saved).toMatchObject({ enabled: false,nextRunAt: null,revision: 1 }); expect(await f.service().tick()).toBeNull();
  const requestId = randomUUID(), admitted = await runNow(saved,requestId), completed = await f.finished(saved.id);
  expect(completed).toMatchObject({ state: 'completed',summary: { selected: 1,deferred: 0,runs: [{ state: 'passed' }] } });
  const history = await f.call(`/runs/${completed!.summary.runs[0].runId}`), result = (await history.json()).run;
  expect(result.result).toMatchObject({ status: 'passed',cleanupVerified: true });
  expect(result.result.output).toContain('whole-item totals preserve integer minor currency units');
  expect((await runNow(saved,requestId)).id).toBe(admitted.id); expect(f.sandbox.calls).toBe(1);
  expect((await f.store.get(SCHEDULE_ACTOR,saved.id))?.enabled).toBe(false);
},60000);

it('discovers newly installed apps, reports unresolved prerequisites and flags shipped tests missing registration', async () => {
  f.addPackage({ name: 'invoice-first' }); const saved = await draft();
  const second = f.addPackage({ name: 'invoice-new' });
  writeFileSync(join(second.dir,'tests/unregistered.test.cjs'),'throw new Error("Unregistered suite must never execute");\n');
  f.catalog.register(second.record);
  f.addPackage({ name: 'invoice-pending',prerequisites: ['runner:node-test','fixture:unavailable-provider'] });
  await runNow(saved); const completed = await f.finished(saved.id);
  expect(completed!.summary.runs.map(run => run.appName).sort()).toEqual(['invoice-first','invoice-new']);
  expect(completed!.summary.runs.every(run => run.state === 'passed')).toBe(true);
  expect(completed!.summary.unavailable).toContainEqual(expect.objectContaining({ appName: 'invoice-pending',reason: expect.stringContaining('fixture:unavailable-provider') }));
  expect(completed!.summary.unavailable.filter(item => item.caseId.includes(':smoke:'))).toHaveLength(3);
  expect(completed!.summary.drift).toContainEqual(expect.objectContaining({ appName: 'invoice-new',missingRegistrations: ['tests/unregistered.test.cjs'] }));
  expect(f.sandbox.calls).toBe(2);
},60000);

it('redacts a wildcard retry after one app becomes invisible without executing the previous request again', async () => {
  f.addPackage({ name: 'visible-invoice' }); f.addPackage({ name: 'retired-invoice' }); const saved = await draft();
  const requestId = randomUUID(); await runNow(saved,requestId); await f.finished(saved.id); f.state.visible.delete('retired-invoice');
  const retried = await runNow(saved,requestId);
  expect(retried.summary).toMatchObject({ selected: 0,runs: [],unavailable: [],drift: [],error: expect.stringContaining('withheld') });
  const history = await f.call(`/schedules/${saved.id}/history`);
  expect((await history.json()).batches[0].summary).toEqual(retried.summary); expect(f.sandbox.calls).toBe(2);
},60000);

it('keeps exact issuer ownership, closed request fields and same-origin writes while allowing an owner to disable after demotion', async () => {
  f.addPackage(); const saved = await draft();
  expect((await f.call(`/schedules/${saved.id}/history`,'GET',undefined,{ 'x-fixture-issuer': 'other' })).status).toBe(404);
  expect((await f.call(`/schedules/${saved.id}`,'PATCH',{ revision: 1,enabled: true },{ 'x-fixture-issuer': 'other' })).status).toBe(404);
  expect((await f.call('/schedules','POST',{ appName: '*',levels: ['unit'],cadence: 'daily',actor: SCHEDULE_ACTOR })).status).toBe(400);
  expect((await f.call(`/schedules/${saved.id}`,'PATCH',{ revision: 1,enabled: true },{ origin: 'https://foreign.test' })).status).toBe(403);
  f.state.admin = false;
  expect((await f.call(`/schedules/${saved.id}/run-now`,'POST',{ revision: 1,requestId: randomUUID() })).status).toBe(403);
  const disabled = await f.call(`/schedules/${saved.id}`,'PATCH',{ revision: 1,enabled: false });
  expect(disabled.status).toBe(200); expect(f.sandbox.calls).toBe(0);
},30000);

it('persists cadence across API restart, claims one due occurrence across workers and collapses missed intervals', async () => {
  f.addPackage(); const saved = await draft();
  const response = await f.call(`/schedules/${saved.id}`,'PATCH',{ revision: 1,enabled: true }), enabled = (await response.json()).schedule;
  expect(new Date(enabled.nextRunAt).getTime()-f.state.now.getTime()).toBe(86400000);
  const restarted = f.restart(), peer = f.peer(); expect(await restarted.tick()).toBeNull();
  f.state.now = new Date(f.state.now.getTime()+7*86400000);
  const claims = await Promise.all([restarted.tick(),peer.tick()]); expect(claims.filter(Boolean)).toHaveLength(1);
  const done = await f.finished(saved.id); expect(done!.summary.runs[0].state).toBe('passed');
  expect(await peer.tick()).toBeNull(); expect(f.sandbox.calls).toBe(1);
  const current = await f.store.get(SCHEDULE_ACTOR,saved.id);
  expect(new Date(current!.nextRunAt!).getTime()-f.state.now.getTime()).toBe(86400000);
},60000);

it('rechecks a due schedule owner instead of preserving the operator privilege captured at creation', async () => {
  f.addPackage(); const saved = await draft();
  expect((await f.call(`/schedules/${saved.id}`,'PATCH',{ revision: 1,enabled: true })).status).toBe(200);
  f.state.now = new Date(f.state.now.getTime()+86400000); f.state.admin = false;
  expect(await f.service().tick()).not.toBeNull(); expect((await f.finished(saved.id))!.state).toBe('cancelled');
  expect(f.sandbox.calls).toBe(0);
},15000);

it('bounds one occurrence at one hundred current cases and reports the deferred remainder', async () => {
  const source = f.addPackage({ delayMs: 10000 });
  const cases = Array.from({ length: 101 },(_,index) => ({ ...source.test,id: `invoice-${String(index).padStart(3,'0')}` }));
  writeFileSync(join(source.dir,'tests/test-lab.yaml'),yaml.dump({ version: 1,cases })); f.catalog.register(source.record);
  const saved = await draft(); await runNow(saved); await f.sandbox.requested;
  const current = await waitForSchedule(async () => (await f.store.history(SCHEDULE_ACTOR,saved.id))[0],row => row.summary.selected === 100);
  expect(current.summary).toMatchObject({ selected: 100,deferred: 1 });
  f.service().stop(); expect((await f.finished(saved.id))!.state).toBe('cancelled');
},60000);

it('revoking operator authority during a real execution cancels the batch and withholds private output', async () => {
  f.addPackage({ delayMs: 10000 }); const saved = await draft();
  await runNow(saved); await f.sandbox.requested; f.state.admin = false;
  const completed = await f.finished(saved.id); expect(completed!.state).toBe('cancelled');
  const runs = await waitForSchedule(() => f.runStore.list(SCHEDULE_ACTOR,[...f.state.visible.keys()]),rows => rows.length === 1 && !['queued','running','cancelling'].includes(rows[0].state));
  const actual = await f.runStore.get(SCHEDULE_ACTOR,runs[0].id);
  expect(actual!.state).toBe('cancelled'); expect(actual!.result?.output).toBeUndefined();
  expect(f.sandbox.last?.cleanupVerified).toBe(true);
},60000);

it('disabling a current generation cancels its active suite and rejects stale enablement edits', async () => {
  f.addPackage({ delayMs: 10000 }); const saved = await draft();
  await runNow(saved); await f.sandbox.requested;
  expect((await f.call(`/schedules/${saved.id}`,'PATCH',{ revision: 1,enabled: false })).status).toBe(200);
  expect((await f.call(`/schedules/${saved.id}`,'PATCH',{ revision: 1,enabled: true })).status).toBe(409);
  expect((await f.finished(saved.id))!.state).toBe('cancelled');
},60000);

it('records genuine assertion failure without turning an admitted batch into a passing test', async () => {
  f.addPackage({ broken: true }); const saved = await draft(); await runNow(saved);
  const completed = await f.finished(saved.id); expect(completed!.state).toBe('completed');
  expect(completed!.summary.runs).toEqual([expect.objectContaining({ state: 'failed' })]);
  const run = await f.runStore.get(SCHEDULE_ACTOR,completed!.summary.runs[0].runId);
  expect(run!.result?.output).toContain('AssertionError'); expect(run!.result?.cleanupVerified).toBe(true);
},60000);

it('bounds unavailable background identity reads before launching a scheduled container', async () => {
  f.addPackage(); const saved = await draft(); f.state.hang = true; const started = Date.now();
  await runNow(saved); expect((await f.finished(saved.id))!.state).toBe('cancelled');
  expect(Date.now()-started).toBeLessThan(10000); expect(f.sandbox.calls).toBe(0);
},15000);

it('bounds a never-returning lease check before launching a scheduled container', async () => {
  f.addPackage(); const saved = await draft(), started = Date.now();
  f.store.heartbeat = () => new Promise<boolean>(() => {});
  await runNow(saved); expect((await f.finished(saved.id))!.state).toBe('cancelled');
  expect(Date.now()-started).toBeLessThan(10000); expect(f.sandbox.calls).toBe(0);
},15000);

it('recovers an expired batch as interrupted without changing completed durable run evidence', async () => {
  f.addPackage(); const saved = await draft(); await runNow(saved);
  const complete = await f.finished(saved.id), originalRun = await f.runStore.get(SCHEDULE_ACTOR,complete!.summary.runs[0].runId);
  const held = await f.store.claim(SCHEDULE_ACTOR,saved.id,1,randomUUID());
  await pool.query("UPDATE oshal_test_lab_schedule_batches SET lease_until=NOW()-INTERVAL '1 minute' WHERE id=$1",[held.batch.id]);
  f.restart(); const recovered = await f.store.claim(SCHEDULE_ACTOR,saved.id,1,randomUUID());
  expect(recovered.created).toBe(true); expect(await f.store.heartbeat(held.batch)).toBe(false);
  const history = await f.store.history(SCHEDULE_ACTOR,saved.id);
  expect(history.find(row => row.id === held.batch.id)?.state).toBe('interrupted');
  expect(await f.runStore.get(SCHEDULE_ACTOR,originalRun!.id)).toEqual(originalRun);
  await f.store.finish(recovered.batch,'cancelled',recovered.batch.summary);
},60000);

it('enforces the control-plane RLS fence for raw unprivileged schedule and batch writes', async () => {
  await pool.query('CREATE ROLE schedule_unprivileged NOLOGIN');
  await pool.query('GRANT SELECT,INSERT,UPDATE ON oshal_test_lab_schedules,oshal_test_lab_schedule_batches TO schedule_unprivileged');
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE schedule_unprivileged');
    expect((await client.query('SELECT * FROM oshal_test_lab_schedules')).rows).toEqual([]);
    await expect(client.query(`INSERT INTO oshal_test_lab_schedules(id,issuer,user_sub,app_name,levels,cadence)
      VALUES($1,'https://foreign.test','same-sub','*','["unit"]','daily')`,[randomUUID()])).rejects.toMatchObject({ code: '42501' });
  } finally { await client.query('ROLLBACK'); client.release(); }
},30000);
