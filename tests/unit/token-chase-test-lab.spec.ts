/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The Token Chase checkpoint + tail replay card is registered exactly once, every attached suite exists on disk, and its read-only step reports honestly over a REAL loopback HTTP seam: pass with the run count it read, degraded when nothing is captured or the caller is not signed in, gap when the route is missing, fail on a server error or a malformed list. It never fires a replay.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Require the producing-bot execution-handler integration guard on the existing checkpoint/replay card; a capture guard on disk alone is not registered coverage.
 */

import { existsSync } from 'node:fs';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { TOKEN_CHASE_SCENARIOS, capturedRunsStep } from '@/app/routes/test-lab-token-chase-scenarios';

const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))); });

/** @description A real loopback api double answering the runs route with a fixed status/body and recording the calls. */
async function serve(status: number, body: unknown): Promise<{ url: string; calls: string[] }> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, calls };
}

describe('Token Chase Test Lab card', () => {
  it('is registered once with suites that exist on disk and one read-only step', () => {
    const [scenario] = TOKEN_CHASE_SCENARIOS;
    expect(SCENARIOS.filter((s) => s.id === scenario.id)).toEqual([scenario]);
    expect(scenario.group).toBe('tool');
    expect(scenario.regressionTests).toContainEqual({ level: 'integration', path: 'tests/unit/token-chase-producing-bot.spec.ts' });
    expect(scenario.regressionTests!.map((t) => t.path)).toContain('tests/unit/token-chase-checkpoint-replay-e2e.spec.ts');
    expect(scenario.regressionTests!.map((t) => t.path)).toContain('tests/unit/token-chase-bot-tail-route.spec.ts');
    for (const test of scenario.regressionTests!) expect(existsSync(test.path), test.path).toBe(true);
    expect(scenario.steps.map((s) => s.id)).toEqual(['captured-runs']);
  });

  it('passes with the run count it read and only ever GETs the runs route', async () => {
    const { url, calls } = await serve(200, { runs: [{ runId: 'task-9', frameCount: 3, modified: '2026-09-27T00:00:00.000Z' }, { runId: 'task-8', frameCount: 1, modified: '2026-09-26T00:00:00.000Z' }] });
    const r = await capturedRunsStep('cookie=x', url);
    expect(r.state).toBe('pass');
    expect(r.output).toEqual({ runs: 2, newest: 'task-9', frames: 3 });
    expect(r.detail).toContain('no replay fired');
    expect(calls).toEqual(['GET /api/token-chase/runs']);
  });

  it('is degraded, not failed, when nothing has been captured yet — and says what capture needs', async () => {
    const { url } = await serve(200, { runs: [] });
    const r = await capturedRunsStep('cookie=x', url);
    expect(r.state).toBe('degraded');
    expect(r.detail).toContain('TOKEN_CHASE_CAPTURE=true');
  });

  it('is degraded for an unauthenticated caller and a gap when the route is missing', async () => {
    const unauth = await serve(401, { error: 'unauthenticated' });
    expect((await capturedRunsStep('', unauth.url)).state).toBe('degraded');
    const missing = await serve(404, { error: 'not found' });
    expect((await capturedRunsStep('cookie=x', missing.url)).state).toBe('gap');
  });

  it('fails on a server error and on a malformed list', async () => {
    const broken = await serve(500, { error: 'boom' });
    expect((await capturedRunsStep('cookie=x', broken.url)).state).toBe('fail');
    const malformed = await serve(200, { runs: [{ nope: true }] });
    expect((await capturedRunsStep('cookie=x', malformed.url)).state).toBe('fail');
  });
});
