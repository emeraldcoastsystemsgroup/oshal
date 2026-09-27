/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the read-only installed-registration acceptance script by running the REAL script as a child process against a loopback catalog server: a complete catalog passes; a missing core suite, missing or outdated pilot case, refused catalog or missing PAT fails with its own exit code; the request is one authenticated GET and the token never reaches output.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = 'scripts/operations/verify-authorization-registration.js';
const TOKEN = `oshal_pat_fixture_${Date.now()}`;
const CORE = ['tests/unit/installer-root-bootstrap.spec.ts', 'tests/unit/installer-root-oidc-browser.spec.ts', 'tests/unit/chart-installer-root.spec.ts'];
const CASES = ['structural-roles', 'authorization-groups-delegation', 'authorization-record-rights-postgres', 'authorization-permission-ui'];

/** A catalog shaped like GET /api/test-lab/catalog, optionally damaged by `mutate`. */
function catalog(mutate: (body: { scenarios: Array<Record<string, any>> }) => void = () => undefined) {
  const body = { scenarios: [
    { id: 'authorization-management', regressionTests: CORE.map((path) => ({ level: 'integration', path })) },
    ...CASES.map((caseId) => ({ id: `installed-${caseId}`, installedTest: { appName: 'little-monsters', appVersion: '1.4.5', caseId } })),
  ] };
  mutate(body);
  return body;
}

let server: http.Server; let base: string; let reply: { status: number; body: unknown } = { status: 200, body: catalog() };
const seen: Array<{ method?: string; url?: string; authorization?: string }> = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    res.writeHead(reply.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });

/** Run the real script with the fixture base; resolves with its exit code and combined output. */
function run(token = TOKEN): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH ?? '', OSHAL_VERIFY_BASE_URL: base,
      ...(token ? { OSHAL_VERIFY_OPERATOR_PAT: token } : {}) } });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('installed authorization registration acceptance script', () => {
  it('passes a complete catalog with one authenticated GET and never prints the token', async () => {
    reply = { status: 200, body: catalog() }; seen.length = 0;
    const result = await run();
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toEqual({ ok: true, problems: [], pilotVersion: '1.4.5' });
    expect(seen).toEqual([{ method: 'GET', url: '/api/test-lab/catalog', authorization: `Bearer ${TOKEN}` }]);
    expect(result.output).not.toContain(TOKEN);
  });

  it.each([
    ['a core suite is unregistered', (b: any) => { b.scenarios[0].regressionTests.pop(); }, 'does not register tests/unit/chart-installer-root.spec.ts'],
    ['a pilot case is missing', (b: any) => { b.scenarios.splice(2, 1); }, 'case authorization-groups-delegation is not installed'],
    ['the pilot is below 1.4.5', (b: any) => { b.scenarios[4].installedTest.appVersion = '1.4.4'; }, 'installed at 1.4.4, below 1.4.5'],
    ['the package is not visible', (b: any) => { b.scenarios.splice(1); }, 'little-monsters has no installed Test Lab cases'],
  ])('fails when %s', async (_label, mutate, message) => {
    reply = { status: 200, body: catalog(mutate) };
    const result = await run();
    expect(result.code).toBe(1); expect(result.output).toContain(message); expect(result.output).not.toContain(TOKEN);
  });

  it('fails on a refused catalog and refuses to run without the operator PAT', async () => {
    reply = { status: 401, body: { error: 'authentication required' } };
    const refused = await run();
    expect(refused.code).toBe(1); expect(refused.output).toContain('answered 401');
    seen.length = 0;
    const missing = await run('');
    expect(missing.code).toBe(2); expect(missing.output).toContain('OSHAL_VERIFY_OPERATOR_PAT is required');
    expect(seen).toEqual([]);
  });
});
