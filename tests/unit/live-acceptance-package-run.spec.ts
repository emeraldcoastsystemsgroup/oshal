/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the package-run live-acceptance case's own logic over a doubled HTTP transport (the fake api and clock stand in for the installed run routes; the real companion is `node scripts/operations/live-acceptance.js package-run` on the box). A passed run with executed tests and every read under 1 s passes; a run that ends cancelled with its output withheld, a single read of 1 s or more, a read that answers 503, a passed run with no executed tests and a run still going at the budget each fail; a case the catalog does not list is unavailable and a listed case that is not runnable is degraded, neither starting a run. The run is started with the Lab page's same-origin headers and only its run-history row is kept.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { fakeApi, fakeClock, type FakeHandler } from '../fixtures/live-acceptance-fake-api';

const requireCjs = createRequire(import.meta.url);
const packageRun = requireCjs('../../scripts/lib/live-acceptance-package-run.js');

const ORIGIN = 'http://127.0.0.1:5000';
const RUN_ID = '1c8e2d3b-2222-4333-8444-555566667777';
const CASE = { id: packageRun.PACKAGE_CASE_ID, revision: 'a'.repeat(64), executionRevision: 'b'.repeat(64), runnable: true, appVersion: '2.13.0' };
const KEPT_RUN = `test-lab-run ${RUN_ID} (the Lab run history row is the recorded evidence)`;
const TAP = 'ok 1 - deck\nok 2 - document\nok 3 - workbook\n# tests 3\n# pass 3\n# fail 0\n';
const WITHHELD = 'Access or the installed test changed during execution. Output was withheld.';

type Read = { status?: number; ms?: number; run: object };
/** Successive GET /runs/:id answers; the last repeats. Each read advances the clock by its own latency. */
function routes(clock: ReturnType<typeof fakeClock>, reads: Read[], over: Partial<Record<string, FakeHandler>> = {}) {
  let index = 0;
  return fakeApi({
    'GET /api/test-lab/catalog': () => ({ status: 200, json: { scenarios: [{ id: CASE.id, installedTest: CASE }] } }),
    'POST /api/test-lab/runs': () => ({ status: 202, json: { run: { id: RUN_ID, state: 'queued' } } }),
    'GET /api/test-lab/runs/:id': () => {
      const read = reads[Math.min(index++, reads.length - 1)];
      clock.advance(read.ms ?? 40);
      return { status: read.status ?? 200, json: read.status && read.status !== 200 ? { error: 'Package execution is temporarily unavailable.' } : { run: read.run } };
    },
    ...over,
  } as Record<string, FakeHandler>);
}
const running = { id: RUN_ID, state: 'running' };
const passed = { id: RUN_ID, state: 'passed', result: { status: 'passed', output: TAP } };

async function drive(reads: Read[], over: Partial<Record<string, FakeHandler>> = {}, options: object = {}) {
  const clock = fakeClock();
  const api = routes(clock, reads, over);
  const result = await packageRun.run({ api: api.api, origin: ORIGIN, ...clock }, options);
  return { result, api, starts: api.calls.filter((c) => c.method === 'POST' && c.path === '/api/test-lab/runs') };
}

describe('package-run live acceptance', () => {
  it('passes a passed run with executed tests whose every read answered 200 in under 1 s', async () => {
    const { result, starts } = await drive([{ run: running, ms: 120 }, { run: running, ms: 980 }, { run: passed, ms: 60 }]);
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('executing 3 test(s), 0 failed; 3 run read(s), slowest 980 ms');
    expect(starts).toHaveLength(1);
    expect(starts[0].headers).toEqual({ origin: ORIGIN, 'x-oshal-test-lab': '1' });
    expect(starts[0].body).toMatchObject({ caseId: CASE.id, revision: CASE.revision, executionRevision: CASE.executionRevision });
    expect(result.evidence.reads.map((r: { ms: number }) => r.ms)).toEqual([120, 980, 60]);
    expect(result.cleanup.kept).toEqual([KEPT_RUN]);
    expect(result.cleanup.outstanding).toEqual([]);
  });

  it('fails a run that ended cancelled with its output withheld, naming the end state and the reason', async () => {
    const { result } = await drive([{ run: running }, { run: { id: RUN_ID, state: 'cancelled', result: { status: 'pending', cancelled: true, error: WITHHELD } } }]);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`the run ended cancelled: ${WITHHELD}`);
    expect(result.cleanup.kept).toEqual([KEPT_RUN]);
  });

  it('fails a passed run when one read took 1 s or more', async () => {
    const { result } = await drive([{ run: running, ms: 1000 }, { run: passed }]);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('1 of 2 run read(s) answered non-200 or took 1000 ms or more (HTTP 200 in 1000 ms)');
  });

  it('fails when a read answers 503, and still follows the run to its own end state', async () => {
    const { result, api } = await drive([{ run: running }, { status: 503, ms: 5200, run: running }, { run: passed }]);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('HTTP 503 in 5200 ms');
    expect(result.evidence.state).toBe('passed');
    expect(api.calls.filter((c) => c.method === 'GET' && c.path === `/api/test-lab/runs/${RUN_ID}`)).toHaveLength(3);
  });

  it('fails a run that reports passed without executing tests', async () => {
    const { result } = await drive([{ run: { ...passed, result: { status: 'passed', output: 'no tests found\n' } } }]);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('reported passed but its output shows 0 passed / 0 failed tests');
  });

  it('fails a run still going when the budget ends', async () => {
    const { result } = await drive([{ run: running }], {}, { runBudgetMs: 5_000, pollMs: 1_000 });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('the run is still running after 5s');
  });

  it('is unavailable when the catalog lists no brand-render case, and degraded when it is not runnable; neither starts a run', async () => {
    const absent = await drive([{ run: passed }], { 'GET /api/test-lab/catalog': () => ({ status: 200, json: { scenarios: [] } }) });
    expect(absent.result.state).toBe('unavailable');
    expect(absent.result.detail).toContain('presentations not installed, or a version before 2.13.0');
    expect(absent.starts).toHaveLength(0);
    const blocked = await drive([{ run: passed }], { 'GET /api/test-lab/catalog': () => ({ status: 200, json: { scenarios: [{ id: CASE.id,
      installedTest: { ...CASE, runnable: false, pendingReason: 'Additional prerequisites require verification: fixture:core-checkout.' } }] } }) });
    expect(blocked.result.state).toBe('degraded');
    expect(blocked.result.detail).toContain('fixture:core-checkout');
    expect(blocked.starts).toHaveLength(0);
    expect(blocked.result.cleanup.kept).toEqual([]);
  });

  it('fails without following when the run route refuses the start', async () => {
    const { result, api } = await drive([{ run: passed }], { 'POST /api/test-lab/runs': () => ({ status: 409, json: { error: 'The package runner is busy. Wait for the active run to finish.' } }) });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('did not start (HTTP 409: The package runner is busy.');
    expect(api.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/api/test-lab/runs/'))).toHaveLength(0);
  });
});
