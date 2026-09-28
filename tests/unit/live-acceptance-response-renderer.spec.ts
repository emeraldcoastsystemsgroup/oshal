/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the renderer live-acceptance case's own logic over a doubled HTTP transport: all card steps passing + same-origin Mermaid + an EXECUTED Tutor run = pass; a Tutor run that "passed" without executing tests, a redirected Mermaid asset or a non-passing card step = fail; a Tutor case that is absent or not runnable = degraded with its reason; the durable run is started with the Test Lab page's same-origin headers; the only thing kept is the Lab run-history row. The real companion is `node scripts/operations/live-acceptance.js response-renderer` on the box.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { fakeApi, fakeClock, type FakeHandler } from '../fixtures/live-acceptance-fake-api';

const requireCjs = createRequire(import.meta.url);
const renderer = requireCjs('../../scripts/lib/live-acceptance-response-renderer.js');

const ORIGIN = 'http://127.0.0.1:5000';
const RUN_ID = '0b7e1c2a-1111-4222-8333-444455556666';
const TUTOR = { id: renderer.TUTOR_CASE_ID, revision: 'a'.repeat(64), executionRevision: 'b'.repeat(64), runnable: true, appVersion: '1.4.5' };

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
    expect(result.cleanup.kept).toEqual([`test-lab-run ${RUN_ID} (the Lab run history row is the recorded evidence)`]);
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
