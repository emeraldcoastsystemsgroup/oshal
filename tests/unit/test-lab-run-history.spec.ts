/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove durable run identity, cancellation, revision and restart behavior through real HTTP and PostgreSQL.
 */
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestLabRunFixture,TEST_CASE } from '../fixtures/test-lab-runs';
import { PostgresTestLabRunStore } from '@/app/routes/test-lab-run-store';

let fixture: Awaited<ReturnType<typeof startTestLabRunFixture>>;
beforeAll(async () => { fixture = await startTestLabRunFixture(); },45000);
afterAll(async () => { await fixture?.close(); },30000);
beforeEach(async () => {
  fixture.finish(); await fixture.pool.query('TRUNCATE oshal_test_lab_runs');
  Object.assign(fixture.state,{ visible: true,canRun: true,hold: false,starts: 0,cleanupVerified: true,throwAfterStart: false,test: structuredClone(TEST_CASE) });
});

async function start() {
  const response = await fixture.call('/runs','POST',fixture.input());
  expect(response.status).toBe(202); return (await response.json()).run;
}
async function completed(id: string) {
  await expect.poll(async () => (await (await fixture.call('/runs/'+id)).json()).run.state).toBe('passed');
  return (await (await fixture.call('/runs/'+id)).json()).run;
}

describe('Durable Lab run history',() => {
  it('retains exact version and bounded text across a service restart, but never across same-sub issuers',async () => {
    const run = await start(); const result = await completed(run.id);
    expect(result.result.output).toContain('invoice total: 42');
    expect(result.result.cleanupVerified).toBe(true); fixture.restart();
    expect((await (await fixture.call('/runs/'+run.id)).json()).run.result.output).toBe(result.result.output);
    expect((await fixture.call('/runs/'+run.id,'GET',undefined,{ 'x-fixture-issuer': 'other' })).status).toBe(404);
    expect((await (await fixture.call('/runs','GET',undefined,{ 'x-fixture-issuer': 'other' })).json()).runs).toEqual([]);
    const history = (await (await fixture.call('/runs')).json()).runs;
    expect(history).toHaveLength(1); expect(history[0].result).toBeUndefined();
  });

  it('rejects arbitrary fields, stale selection, missing operator authority and cross-origin mutation before execution',async () => {
    expect((await fixture.call('/runs','POST',{ ...fixture.input(),command: 'anything' })).status).toBe(400);
    expect((await fixture.call('/runs','POST',{ ...fixture.input(),revision: 'd'.repeat(64) })).status).toBe(409);
    expect((await fixture.call('/runs','POST',fixture.input(),{ origin: 'https://foreign.test' })).status).toBe(403);
    fixture.state.canRun = false;
    expect((await fixture.call('/runs','POST',fixture.input())).status).toBe(403);
    expect(fixture.state.starts).toBe(0);
  });

  it('returns the same receipt on retry, globally bounds concurrent admission and lets cancellation win',async () => {
    fixture.state.hold = true; const input = fixture.input();
    const first = await fixture.call('/runs','POST',input); const run = (await first.json()).run;
    expect(first.status).toBe(202);
    const repeat = await fixture.call('/runs','POST',input); expect((await repeat.json()).run.id).toBe(run.id);
    expect((await fixture.call('/runs','POST',fixture.input(),{ 'x-fixture-issuer': 'other' })).status).toBe(409);
    expect((await fixture.call('/runs/'+run.id+'/cancel','POST',{}, { 'x-fixture-issuer': 'other' })).status).toBe(404);
    expect((await fixture.call('/runs/'+run.id+'/cancel','POST',{})).status).toBe(200);
    await expect.poll(async () => (await (await fixture.call('/runs/'+run.id)).json()).run.state).toBe('cancelled');
    expect(fixture.state.starts).toBe(1);
    expect((await (await fixture.call('/runs/'+run.id)).json()).run.result?.output).toBeUndefined();
  });
});

describe('Current authority and durable lifecycle',() => {
  it('withholds output when rights or source change during inference and hides history on loss of app access',async () => {
    fixture.state.hold = true; const run = await start();
    fixture.state.canRun = false; fixture.finish();
    await expect.poll(async () => (await (await fixture.call('/runs/'+run.id)).json()).run.state).toBe('pending');
    expect((await (await fixture.call('/runs/'+run.id)).json()).run.result.output).toBeUndefined();
    fixture.state.visible = false;
    expect((await fixture.call('/runs/'+run.id)).status).toBe(404);
    expect((await (await fixture.call('/runs')).json()).runs).toEqual([]);
  });

  it('labels retained prior content stale after update and preserves it across uninstall/reinstall',async () => {
    const run = await start(); await completed(run.id);
    fixture.state.test.executionRevision = 'e'.repeat(64); fixture.state.test.revision = 'f'.repeat(64);
    expect((await (await fixture.call('/runs/'+run.id)).json()).run.stale).toBe(true);
    fixture.state.visible = false; expect((await fixture.call('/runs/'+run.id)).status).toBe(404);
    fixture.state.visible = true; fixture.restart();
    expect((await (await fixture.call('/runs/'+run.id)).json()).run.test.executionRevision).toBe('b'.repeat(64));
  });

  it('recovers an expired process lease as interrupted without rerunning the package',async () => {
    const actor = { issuer: 'https://first.test',sub: 'same-sub' }; const id = randomUUID();
    await fixture.store.create({ id,requestId: randomUUID(),actor,test: TEST_CASE,state: 'queued',createdAt: new Date().toISOString(),updatedAt: new Date().toISOString() });
    await fixture.store.begin(actor,id);
    await fixture.pool.query("UPDATE oshal_test_lab_runs SET lease_until=NOW()-INTERVAL '1 second' WHERE id=$1",[id]);
    fixture.restart(); expect((await (await fixture.call('/runs/'+id)).json()).run.state).toBe('interrupted');
    expect(fixture.state.starts).toBe(0);
    const next = await start(); expect(next.id).not.toBe(id); await completed(next.id);
  });
});

describe('Database authority fence',() => {
  it('retains global capacity after uncertain cleanup or a runner exception until correlated recovery succeeds',async () => {
    for (const throwing of [false,true]) {
      fixture.state.cleanupVerified = false; fixture.state.throwAfterStart = throwing;
      const run = await start();
      await expect.poll(async () => (await (await fixture.call('/runs/'+run.id)).json()).run.state).toBe('cancelling');
      expect((await fixture.call('/runs','POST',fixture.input())).status).toBe(409);
      await fixture.pool.query("UPDATE oshal_test_lab_runs SET lease_until=NOW()-INTERVAL '1 second' WHERE id=$1",[run.id]);
      expect((await (await fixture.call('/runs/'+run.id)).json()).run.state).toBe('cancelled');
    }
  });

  it('does not free capacity for an expired runner until external cleanup is positively verified',async () => {
    const actor = { issuer: 'https://first.test',sub: 'same-sub' }; const id = randomUUID();
    const store = new PostgresTestLabRunStore(fixture.pool,Promise.resolve(),async () => false);
    const run = { id,requestId: randomUUID(),actor,test: TEST_CASE,state: 'queued' as const,createdAt: new Date().toISOString(),updatedAt: new Date().toISOString() };
    await store.create(run); await store.begin(actor,id);
    await fixture.pool.query("UPDATE oshal_test_lab_runs SET lease_until=NOW()-INTERVAL '1 second' WHERE id=$1",[id]);
    expect((await store.get(actor,id))?.state).toBe('running');
    await expect(store.create({ ...run,id: randomUUID(),requestId: randomUUID() })).rejects.toMatchObject({ status: 409 });
    expect((await fixture.store.get(actor,id))?.state).toBe('interrupted');
  });

  it('uses forced control-plane RLS so ordinary database roles cannot read or forge run evidence',async () => {
    const run = await start(); await completed(run.id);
    await fixture.pool.query('CREATE ROLE lab_untrusted NOSUPERUSER NOBYPASSRLS; GRANT SELECT,INSERT,UPDATE ON oshal_test_lab_runs TO lab_untrusted');
    const client = await fixture.pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SET LOCAL ROLE lab_untrusted');
      expect((await client.query('SELECT * FROM oshal_test_lab_runs')).rows).toEqual([]);
      await expect(client.query(`INSERT INTO oshal_test_lab_runs(id,issuer,user_sub,request_id,app_name,case_id,state,test)
        VALUES($1,'x','x',$2,'fixture','case','queued','{}')`,[randomUUID(),randomUUID()])).rejects.toMatchObject({ code: '42501' });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
