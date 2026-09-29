/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the renderer live-acceptance case's own logic over a doubled HTTP transport: all card steps passing + same-origin Mermaid + an EXECUTED Tutor run = pass; a Tutor run that "passed" without executing tests, a redirected Mermaid asset or a non-passing card step = fail; a Tutor case that is absent or not runnable = degraded with its reason; the durable run is started with the Test Lab page's same-origin headers; the only thing kept is the Lab run-history row. The real companion is `node scripts/operations/live-acceptance.js response-renderer` on the box.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The Tutor half and the api's lazy runner probe. After an api start the catalog lists every browser case as not runnable with the runner-unverified reason until the probe finishes, and the listing that begins the probe still answers it; the case read the catalog once and reported the Tutor half blocked (the 2026-09-29 sweep read it 5.3 s before the probe verified the runner). Four cases over a catalog whose answer changes between reads: runnable at the first read (one read, no wait), runnable after three unverified answers (the run starts with the revisions of the LAST read, because the api re-seals every case when the probe verifies), the reason still present when the budget ends (degraded with the reason, no run started, a wait longer than the probe's 150 s timeout), and any other pending reason (degraded at the read that reports it, never waited on). A fifth binds the reason the case waits on to what the kernel's own recipe admission returns for a browser recipe before the probe, so a reworded kernel reason turns this spec red instead of silently ending the wait.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { packageTestRecipePending } from '@/features/swarm-apps/services/package-test-snapshot';
import type { PackageTestCase } from '@/shared/package-testing';
import { fakeApi, fakeClock, type FakeHandler } from '../fixtures/live-acceptance-fake-api';

const requireCjs = createRequire(import.meta.url);
const renderer = requireCjs('../../scripts/lib/live-acceptance-response-renderer.js');

const ORIGIN = 'http://127.0.0.1:5000';
const RUN_ID = '0b7e1c2a-1111-4222-8333-444455556666';
const TUTOR = { id: renderer.TUTOR_CASE_ID, revision: 'a'.repeat(64), executionRevision: 'b'.repeat(64), runnable: true, appVersion: '1.4.5' };
const KEPT_RUN = `test-lab-run ${RUN_ID} (the Lab run history row is the recorded evidence)`;
/** The probe's own timeout (package-test-sandbox.ts, probe()); the case's wait has to outlast it. */
const PROBE_TIMEOUT_MS = 150_000;
/** What the catalog lists for a browser case until the api has verified its browser runner. */
const UNVERIFIED = { ...TUTOR, runnable: false, pendingReason: 'The playwright runner is unavailable.' };
/** What it lists once the probe verified the runner: every case is re-sealed, so the revisions differ. */
const RESEALED = { ...TUTOR, revision: 'c'.repeat(64), executionRevision: 'd'.repeat(64) };
const OTHER_REASON = { ...TUTOR, runnable: false, pendingReason: 'Additional prerequisites require verification: core:surface-bridge.' };

function routes(over: Partial<Record<string, FakeHandler>> = {}, output = 'ok 1 - renders\nok 2 - escapes\n# tests 2\n# pass 2\n# fail 0\n') {
  let polls = 0;
  return fakeApi({
    'POST /api/test-lab/run': () => ({ status: 200, json: { ran: 1, results: [{ id: 'shared-response-renderer', steps: [
      { label: 'bundle', state: 'pass' }, { label: 'mermaid', state: 'pass' }, { label: 'inert', state: 'pass' }] }] } }),
    'GET /dist/vendor/mermaid/VERSION': () => ({ status: 200, text: '11.4.1\n', contentType: 'text/plain' }),
    'GET /dist/vendor/mermaid/mermaid.esm.min.mjs': () => ({ status: 200, text: 'export default {}', contentType: 'application/javascript' }),
    'GET /api/test-lab/catalog': () => ({ status: 200, json: { scenarios: [{ id: TUTOR.id, installedTest: TUTOR }] } }),
    'POST /api/test-lab/runs': () => ({ status: 202, json: { run: { id: RUN_ID, state: 'queued' } } }),
    'GET /api/test-lab/runs/:id': () => {
      polls += 1;
      return { status: 200, json: { run: polls < 2 ? { id: RUN_ID, state: 'running' } : { id: RUN_ID, state: 'passed', result: { status: 'passed', output } } } };
    },
    ...over,
  } as Record<string, FakeHandler>);
}

const run = (api: ReturnType<typeof fakeApi>) => renderer.run({ api: api.api, origin: ORIGIN, ...fakeClock() });

/** Run the case over a catalog whose successive reads answer `answers` in order (the last one repeats). */
async function drive(answers: object[]) {
  const clock = fakeClock();
  const reads: number[] = [];
  const api = routes({ 'GET /api/test-lab/catalog': () => {
    reads.push(clock.now());
    const installedTest = answers[Math.min(reads.length, answers.length) - 1];
    return { status: 200, json: { scenarios: [{ id: TUTOR.id, installedTest }] } };
  } });
  const result = await renderer.run({ api: api.api, origin: ORIGIN, ...clock });
  const starts = api.calls.filter((c) => c.method === 'POST' && c.path === '/api/test-lab/runs');
  return { result, starts, readAt: reads.map((at) => at - reads[0]) };
}

describe('shared response renderer live acceptance', () => {
  it('passes on three passing card steps, same-origin Mermaid and an executed Tutor run', async () => {
    const api = routes();
    const result = await run(api);
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('3/3 steps pass');
    expect(result.detail).toContain('Mermaid 11.4.1 is served same-origin');
    expect(result.detail).toContain('executed 2 test(s), 0 failed');
    const start = api.calls.find((c) => c.method === 'POST' && c.path === '/api/test-lab/runs')!;
    expect(start.headers).toEqual({ origin: ORIGIN, 'x-oshal-test-lab': '1' });
    expect(start.body).toMatchObject({ caseId: TUTOR.id, revision: TUTOR.revision, executionRevision: TUTOR.executionRevision });
    expect(result.cleanup.kept).toEqual([KEPT_RUN]);
    expect(result.cleanup.outstanding).toEqual([]);
  });

  it('fails a Tutor run that reports passed without executing tests', async () => {
    const result = await run(routes({}, 'no tests found\n'));
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('0 passed / 0 failed tests (not an executed run)');
  });

  it('fails when the Mermaid runtime is redirected elsewhere', async () => {
    const result = await run(routes({ 'GET /dist/vendor/mermaid/VERSION': () => ({ status: 302, location: 'https://cdn.example.com/mermaid', text: '' }) }));
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('redirected to https://cdn.example.com/mermaid');
  });

  it('fails and names a card step that is not pass', async () => {
    const result = await run(routes({ 'POST /api/test-lab/run': () => ({ status: 200, json: { results: [{ id: 'shared-response-renderer', steps: [
      { label: 'Same-origin pinned diagram runtime', state: 'gap', detail: 'No /dist/vendor/mermaid' }] }] } }) }));
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('Same-origin pinned diagram runtime = gap');
  });

  it('is degraded, with the reason, when the Tutor case is absent or not runnable', async () => {
    const absent = await run(routes({ 'GET /api/test-lab/catalog': () => ({ status: 200, json: { scenarios: [] } }) }));
    expect(absent.state).toBe('degraded');
    expect(absent.detail).toContain(`lists no ${TUTOR.id}`);
    const blocked = await run(routes({ 'GET /api/test-lab/catalog': () => ({ status: 200, json: { scenarios: [{ id: TUTOR.id,
      installedTest: { ...TUTOR, runnable: false, pendingReason: 'browser:chromium is not verified in this image' } }] } }) }));
    expect(blocked.state).toBe('degraded');
    expect(blocked.detail).toContain('browser:chromium is not verified');
  });

  it('counts node:test and Playwright summaries', () => {
    expect(renderer.countTests('# pass 3\n# fail 1')).toEqual({ passed: 3, failed: 1 });
    expect(renderer.countTests('  2 passed (4.1s)')).toEqual({ passed: 2, failed: 0 });
    expect(renderer.countTests('')).toEqual({ passed: 0, failed: 0 });
  });
});

describe('the Tutor half and the lazy runner probe', () => {
  it('runs a case that is runnable at the first read without reading the catalog again', async () => {
    const { result, starts, readAt } = await drive([TUTOR]);
    expect(result.state).toBe('pass');
    expect(readAt).toEqual([0]);
    expect(starts).toHaveLength(1);
    expect(starts[0].body).toMatchObject({ revision: TUTOR.revision, executionRevision: TUTOR.executionRevision });
    expect(result.evidence.tutorCatalogWaitMs).toBe(0);
  });

  it('re-reads the catalog while the runner is unverified and runs the case the last read lists', async () => {
    const { result, starts, readAt } = await drive([UNVERIFIED, UNVERIFIED, UNVERIFIED, RESEALED]);
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('the Tutor case executed 2 test(s), 0 failed');
    expect(readAt).toEqual([0, 3_000, 6_000, 9_000]);
    expect(starts).toHaveLength(1);
    expect(starts[0].headers).toEqual({ origin: ORIGIN, 'x-oshal-test-lab': '1' });
    expect(starts[0].body).toMatchObject({ caseId: TUTOR.id, revision: RESEALED.revision, executionRevision: RESEALED.executionRevision });
    expect(result.evidence.tutorCounts).toEqual({ passed: 2, failed: 0 });
    expect(result.evidence.tutorCatalogWaitMs).toBe(9_000);
    expect(result.cleanup.kept).toEqual([KEPT_RUN]);
  });

  it('stays degraded, with the reason, when the runner is still unverified as the budget ends', async () => {
    const { result, starts, readAt } = await drive([UNVERIFIED]);
    expect(result.state).toBe('degraded');
    expect(result.detail).toContain('is not runnable here: The playwright runner is unavailable. (still so after 165s of re-reading the catalog)');
    expect(starts).toEqual([]);
    const waited = readAt[readAt.length - 1];
    expect(waited).toBeGreaterThan(PROBE_TIMEOUT_MS);
    expect(waited).toBeLessThanOrEqual(PROBE_TIMEOUT_MS + 30_000);
    expect(readAt).toHaveLength(waited / 3_000 + 1);
    expect(result.evidence.tutorCounts).toBeNull();
    expect(result.cleanup.kept).toEqual([]);
    expect(result.cleanup.outstanding).toEqual([]);
  });

  it('does not wait on any other pending reason, at the first read or once it replaces the unverified one', async () => {
    const atOnce = await drive([OTHER_REASON]);
    expect(atOnce.result.state).toBe('degraded');
    expect(atOnce.result.detail).toContain(`is not runnable here: ${OTHER_REASON.pendingReason}`);
    expect(atOnce.result.detail).not.toContain('still so after');
    expect(atOnce.readAt).toEqual([0]);
    expect(atOnce.starts).toEqual([]);
    const replaced = await drive([UNVERIFIED, OTHER_REASON]);
    expect(replaced.result.state).toBe('degraded');
    expect(replaced.result.detail).toContain(`is not runnable here: ${OTHER_REASON.pendingReason}`);
    expect(replaced.result.detail).not.toContain('still so after');
    expect(replaced.readAt).toEqual([0, 3_000]);
    expect(replaced.starts).toEqual([]);
    const unexplained = await drive([{ ...TUTOR, runnable: false }]);
    expect(unexplained.result.state).toBe('degraded');
    expect(unexplained.result.detail).toContain('is not runnable here: no reason given');
    expect(unexplained.readAt).toEqual([0]);
  });

  it('waits on exactly the reason the kernel gives a browser recipe before the probe has verified the runner', () => {
    const browserCase: PackageTestCase = {
      id: 'tutor-shared-renderer', name: 'Tutor renderer', purpose: 'bind the reason the case waits on', level: 'browser',
      runner: { kind: 'playwright', scope: 'package', files: ['tests/tutor-renderer.core.spec.mjs'] },
      expected: ['passes'], prerequisites: [], sideEffects: 'none', isolation: { mode: 'disposable' },
      limits: { timeoutMs: 60000 }, installation: 'never',
    };
    expect(packageTestRecipePending(browserCase)).toBe(UNVERIFIED.pendingReason);
    expect(renderer.RUNNER_UNVERIFIED_REASON).toBe(packageTestRecipePending(browserCase));
    expect(packageTestRecipePending(browserCase, new Set(['runner:playwright', 'browser:chromium']))).toBeUndefined();
  });
});
