/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove durable run identity, cancellation, revision and restart behavior through real HTTP and PostgreSQL.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Require cancelled state after execution authority is revoked while preserving output and history refusal checks.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Regression for runs that cancelled themselves when an all-application authority re-check ran past the 5 s cap: a held run keeps its result and its reads answer while unscoped resolution is slow, every in-flight check names the run's application, and a denial, timeout, error, lost access or changed test for that application still cancels, withholds output and logs which check refused and why.
 */
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestLabRunFixture,TEST_CASE,RUN_ACTOR } from '../fixtures/test-lab-runs';
import { PostgresTestLabRunStore } from '@/app/routes/test-lab-run-store';

// The refusal cause is the evidence an operator reads, so the two loggers on the run path are observable here.
const logs = vi.hoisted(() => ({ warn: vi.fn(),error: vi.fn(),info: vi.fn(),debug: vi.fn() }));
vi.mock('@/shared/logger',async original => {
  const actual = await original<typeof import('@/shared/logger')>();
  return { ...actual,createChildLogger: (bindings: { module?: string }) =>
    ['test-lab-runs','package-test-execution'].includes(String(bindings?.module)) ? logs : actual.createChildLogger(bindings) };
});

let fixture: Awaited<ReturnType<typeof startTestLabRunFixture>>;
beforeAll(async () => { fixture = await startTestLabRunFixture(); },45000);
afterAll(async () => { await fixture?.close(); },30000);
beforeEach(async () => {
  fixture.finish(); await fixture.pool.query('TRUNCATE oshal_test_lab_runs');
  Object.assign(fixture.state,{ visible: true,canRun: true,hold: false,starts: 0,cleanupVerified: true,throwAfterStart: false,test: structuredClone(TEST_CASE),
    sandboxed: false,slowUnscoped: false,slowScoped: false,failScoped: false,scopes: [] });
  for (const spy of Object.values(logs)) spy.mockClear();
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
    await expect.poll(async () => (await (await fixture.call('/runs/'+run.id)).json()).run.state).toBe('cancelled');
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
    const store = new PostgresTestLabRunStore(fixture.pool,() => Promise.resolve(),async () => false);
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

const ACTIVE = ['queued','running','cancelling'];
const WITHHELD = 'Access or the installed test changed during execution. Output was withheld.';
const pause = (ms: number) => new Promise<void>(done => setTimeout(done,Math.max(0,ms)));

/** @description Wait for the durable run to leave the active states, reading the real store directly so a slow
 * route cannot hide the outcome. @param id Run UUID. @returns The terminal stored run. */
async function settled(id: string) {
  const deadline = Date.now()+40000;
  for (;;) {
    const run = await fixture.store.get(RUN_ACTOR,id);
    if (run && !ACTIVE.includes(run.state)) return run;
    if (Date.now() > deadline) throw new Error(`Run ${id} is still ${run?.state} after 40 s`);
    await pause(200);
  }
}
/** @description Refusals one logger recorded. @param match Record selector. @returns Logged structured fields. */
function logged(match: (fields: Record<string,unknown>) => boolean) {
  return [...logs.warn.mock.calls,...logs.error.mock.calls].map(call => call[0] as Record<string,unknown>).filter(fields => !!fields && match(fields));
}

describe('Run-path authority is decided for the run\'s own application',() => {
  it('finishes a held run with its output, and answers its reads, while an all-application resolution runs past the 5 s cap',async () => {
    Object.assign(fixture.state,{ hold: true,sandboxed: true });
    const run = await start();
    await expect.poll(() => fixture.state.starts).toBe(1);
    const switched = fixture.state.scopes.length; fixture.state.slowUnscoped = true;
    const began = Date.now();
    const during = await fixture.call('/runs/'+run.id);
    const answeredIn = Date.now()-began;
    expect.soft(during.status,'GET /runs/:id during the hold').toBe(200);
    expect.soft(answeredIn,'GET /runs/:id latency (ms) during the hold').toBeLessThan(2000);
    // Hold through several 2 s watch ticks, several 1 s sandbox pulses and one whole 5 s cap.
    await pause(7500-(Date.now()-began));
    const later = await fixture.call('/runs/'+run.id);
    expect.soft(later.status,'GET /runs/:id late in the hold').toBe(200);
    fixture.finish();
    const final = await settled(run.id);
    expect.soft(final.state,'run outcome').toBe('passed');
    expect.soft(final.result?.output,'run output').toContain('invoice total: 42');
    const calls = fixture.state.scopes.slice(switched);
    const inFlight = calls.filter(call => call.origin === 'POST /api/test-lab/runs').map(call => call.scope);
    expect(inFlight,'every in-flight authority check names the run\'s application').toEqual(inFlight.map(() => 'fixture'));
    expect(inFlight.length,'in-flight checks during the hold (watch, sandbox pulse, revalidation)').toBeGreaterThanOrEqual(6);
    expect(calls.filter(call => call.origin.startsWith('GET ')).map(call => call.scope)).toEqual([null,'fixture',null,'fixture']);
    expect(logged(fields => fields.runId === run.id || fields.executionId === run.id)).toEqual([]);
  },60000);

  it('starts, reads and cancels through checks that decide only the run\'s application or the caller\'s identity',async () => {
    Object.assign(fixture.state,{ hold: true,slowUnscoped: true });
    const began = Date.now(), run = await start();
    expect((await fixture.call('/runs/'+run.id)).status).toBe(200);
    expect((await fixture.call('/runs/'+run.id+'/cancel','POST',{})).status).toBe(200);
    expect(Date.now()-began).toBeLessThan(5000);
    expect((await settled(run.id)).state).toBe('cancelled');
    expect(fixture.state.scopes.filter(call => call.scope !== 'fixture' && call.scope !== null)).toEqual([]);
    // A case id only narrows the check to the application it names (or to none); it can never widen access.
    fixture.state.scopes.length = 0;
    expect((await fixture.call('/runs','POST',{ ...fixture.input(),caseId: 'app:other:test:invoice' })).status).toBe(404);
    expect((await fixture.call('/runs','POST',{ ...fixture.input(),caseId: 'invoice' })).status).toBe(404);
    expect(fixture.state.scopes.map(call => call.scope)).toEqual(['other',null]);
    expect(fixture.state.starts).toBe(1);
  },30000);

  it.each([
    ['the caller loses access to the run\'s application',() => { fixture.state.visible = false; },'denied','application-unavailable'],
    ['the installed test changes',() => { fixture.state.test.revision = 'f'.repeat(64); },'denied','installed-test-changed'],
    ['the caller is no longer an operator',() => { fixture.state.canRun = false; },'denied','operator-required'],
    ['the run\'s own application resolves past the 5 s cap',() => { fixture.state.slowScoped = true; },'timeout','authority-unanswered'],
    ['the run\'s own application cannot be resolved',() => { fixture.state.failScoped = true; },'error','authority-failed'],
  ] as const)('still cancels a held run, withholds its output and logs the cause when %s',async (_cause,revoke,outcome,reason) => {
    Object.assign(fixture.state,{ hold: true,sandboxed: true });
    const run = await start();
    await expect.poll(() => fixture.state.starts).toBe(1);
    revoke();
    const final = await settled(run.id); // never released: only the refusal can end this run
    expect(final.state).toBe('cancelled');
    expect(final.result).toMatchObject({ status: 'pending',cancelled: true,cleanupVerified: true,error: WITHHELD });
    expect(final.result?.output).toBeUndefined();
    expect(fixture.state.scopes.filter(call => call.scope === undefined)).toEqual([]);
    expect(logged(fields => fields.runId === run.id)).toContainEqual(expect.objectContaining({ appName: 'fixture',outcome,reason,
      check: expect.stringMatching(/^(watch|sandbox|revalidate)$/) }));
    expect(logged(fields => fields.executionId === run.id && fields.check === 'sandbox').length).toBeGreaterThan(0);
  },60000);
});
