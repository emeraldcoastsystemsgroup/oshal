/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove installed report linkage, safe smoke execution, pending prerequisites, reload refusal and portable CLI outcomes over real HTTP.
 */
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { packageManifest } from '../fixtures/package-testing';
import { INSTALL_COOKIE, INSTALL_SECRET, installationRequest, startInstallationVerificationFixture } from '../fixtures/app-installation-verification';
import type { InstallationVerificationReport } from '@/features/swarm-apps/services/app-installation-report';

let fixture: Awaited<ReturnType<typeof startInstallationVerificationFixture>>;
beforeEach(async () => {
  vi.stubEnv('SWARM_SERVICE_SECRET', INSTALL_SECRET);
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'installation-operator');
  fixture = await startInstallationVerificationFixture();
});
afterEach(async () => { await fixture?.close(); vi.unstubAllEnvs(); });

async function report(apps = ['install-fixture'], headers: Record<string, string> = {}) {
  const response = await installationRequest(fixture.base, apps, headers);
  return { status: response.status, body: await response.json() as InstallationVerificationReport };
}

function cli(apps: string): Promise<{ code: number | null; output: string }> {
  return new Promise((done, reject) => {
    const command = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    const child = spawn(command, ['scripts/oshal-verify.sh', '--skip-containers', '--no-ai', '--wait', '0', '--api', fixture.base, '--apps', apps],
      { cwd: process.cwd(), windowsHide: true, env: { ...env, SWARM_SERVICE_SECRET: INSTALL_SECRET } });
    let output = ''; const timer = setTimeout(() => child.kill(), 15000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { output += value; if (output.length > 65536) child.kill(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); done({ code, output }); });
  });
}

it('links the exact installed smoke and suite identities while executing only the real HTTP smoke', async () => {
  fixture.add();
  const result = await report();
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ success: true, verified: true, verificationStatus: 'passed',
    summary: { registeredCases: 2, smokesPassed: 1, suitesNotRun: 1 } });
  const installed = fixture.catalog.list(new Map([['install-fixture', 'Fixture']]));
  expect(result.body.apps[0].registration).toEqual({ coverage: 'catalog', caseCount: 2, smokeCount: 1, suiteCount: 1, caseIds: installed.map(test => test.id) });
  for (const test of installed) expect(result.body.apps[0].cases).toContainEqual(expect.objectContaining({ id: test.id, revision: test.revision,
    appVersion: test.appVersion, source: test.source, labUrl: `/api/test-lab/app#${encodeURIComponent('card-' + test.id)}` }));
  expect(result.body.apps[0].smokes[0]).toMatchObject({ name: 'ready', path: '/api/install-fixture/ready', status: 'passed' });
  expect(fixture.state.reads.get('GET /api/install-fixture/ready')).toBe(1);
  expect(fixture.state.suiteRuns).toBe(0);
});

it('refuses verified success when a mandatory safe smoke returns an actual failing assertion', async () => {
  fixture.add(); fixture.state.ready = false;
  const result = await report();
  expect(result.status).toBe(503);
  expect(result.body).toMatchObject({ success: false, verified: false, verificationStatus: 'failed', failedApps: ['install-fixture'], summary: { smokesFailed: 1 } });
  expect(result.body.apps[0].cases.find(test => test.runner === 'smoke')?.error).toContain('rejected value');
  expect(fixture.state.suiteRuns).toBe(0);
});

it('preserves the legacy fetch seam while sending the exact registered path over real HTTP', async () => {
  fixture.add(); const urls: string[] = [];
  fixture.state.fetchImpl = async (url, init) => { urls.push(String(url)); return fetch(url, init); };
  expect((await report()).body.verified).toBe(true);
  expect(urls).toEqual([fixture.base + '/api/install-fixture/ready']);
  expect(fixture.state.reads.get('GET /api/install-fixture/ready')).toBe(1);
});

it('reports user, AI and mutating smokes pending without issuing any of those requests', async () => {
  const manifest = packageManifest('pending-fixture');
  manifest.smoke = [
    { name: 'user', method: 'GET', path: '/api/pending-fixture/user', auth: 'pat', requiresUser: true, expect: { status: 200 } },
    { name: 'mutate', method: 'POST', path: '/api/pending-fixture/mutate', auth: 'service', expect: { status: 200 } },
    { name: 'ai', method: 'POST', path: '/api/pending-fixture/ai', auth: 'service', requiresAi: true, expect: { status: 200 } },
  ];
  fixture.add(manifest);
  const result = await report(['pending-fixture']);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ success: true, verified: false, verificationStatus: 'pending', summary: { smokesPending: 3, suitesNotRun: 1 } });
  expect(result.body.apps[0].cases.filter(test => test.runner === 'smoke').every(test => test.status === 'pending' && test.error)).toBe(true);
  expect(fixture.state.reads.size).toBe(0); expect(fixture.state.suiteRuns).toBe(0);
});

it('distinguishes legacy smoke-only and undeclared coverage without inventing a green empty installation', async () => {
  fixture.add(packageManifest('legacy-fixture'), false);
  const empty = packageManifest('empty-fixture'); empty.smoke = []; fixture.add(empty, false);
  const result = await report(['legacy-fixture', 'empty-fixture']);
  expect(result.body.apps[0]).toMatchObject({ verified: true, registration: { coverage: 'smoke-only', caseCount: 1 } });
  expect(result.body.apps[1]).toMatchObject({ verified: false, status: 'pending', registration: { coverage: 'not-declared', caseCount: 0 } });
  expect(result.body.verified).toBe(false);
});

it('keeps member-owned IDs and executes shared group selections only once', async () => {
  fixture.add(packageManifest('first-member')); fixture.add(packageManifest('second-member'));
  const group = packageManifest('fixture-group'); group.kind = 'group'; group.routes = []; group.smoke = [];
  group.dependencies = { apps: ['first-member', 'second-member'] }; fixture.add(group, false);
  const result = await report(['fixture-group', 'first-member']);
  expect(result.body.verified).toBe(true);
  expect(result.body.summary).toMatchObject({ registeredCases: 4, smokesPassed: 2, suitesNotRun: 2 });
  expect(result.body.apps[0].registration).toMatchObject({ coverage: 'members', caseCount: 4 });
  expect(result.body.apps[0].cases.every(test => test.appName.endsWith('-member'))).toBe(true);
  expect(result.body.apps[0].smokes.map(smoke => smoke.name)).toEqual(['first-member/ready', 'second-member/ready']);
  expect([...fixture.state.reads.values()]).toEqual([1, 1]);
});

it('fails a missing/inactive member and an inactive app without issuing their smoke', async () => {
  const member = fixture.add(packageManifest('inactive-member')); member.status = 'inactive'; fixture.catalog.unregister(member.name);
  const group = packageManifest('fixture-group'); group.kind = 'group'; group.routes = []; group.smoke = [];
  group.dependencies = { apps: ['missing-member'] }; fixture.add(group, false);
  const result = await report(['fixture-group', member.name, 'not-installed']);
  expect(result.status).toBe(503); expect(result.body.failedApps).toEqual(['fixture-group', 'inactive-member', 'not-installed']);
  expect(result.body.apps[0].error).toContain('missing-member'); expect(fixture.state.reads.size).toBe(0);
});

it('retracts passing verification when activation replaces the app during the real HTTP request', async () => {
  fixture.add(); fixture.state.hold = async () => { fixture.replace('install-fixture', '2.0.0'); fixture.state.hold = undefined; };
  const result = await report();
  expect(result.body).toMatchObject({ verified: false, verificationStatus: 'pending' });
  expect(result.body.apps[0]).toMatchObject({ stale: true, version: '1.0.0', status: 'pending' });
  expect(result.body.apps[0].cases.find(test => test.runner === 'smoke')?.status).toBe('pending');
  expect((await report()).body).toMatchObject({ verified: true, apps: [expect.objectContaining({ version: '2.0.0' })] });
});

it('preserves real request-bound service smoke identity and refuses an authority change before fetch', async () => {
  const manifest = packageManifest('install-fixture'); manifest.smoke![0].auth = 'service'; fixture.add(manifest);
  fixture.state.requireSession = true;
  expect((await report()).body.verified).toBe(false);
  expect((await report(undefined, { cookie: INSTALL_COOKIE })).body.verified).toBe(true);
  fixture.state.reads.clear();
  fixture.state.beforeTransport = () => { fixture.state.actor = { ...fixture.state.actor, isSwarmAdmin: false }; };
  const revoked = await report(undefined, { cookie: INSTALL_COOKIE });
  expect(revoked.body.verified).toBe(false);
  expect(revoked.body.apps[0].cases.find(test => test.runner === 'smoke')?.error).toContain('authority');
  expect(fixture.state.reads.size).toBe(0);
});

it('refuses a same-subject issuer switch before the captured service smoke transport fetches', async () => {
  const manifest = packageManifest('install-fixture'); manifest.smoke![0].auth = 'service'; fixture.add(manifest);
  fixture.state.beforeTransport = () => { fixture.state.actor = { ...fixture.state.actor, issuer: 'https://other.fixture.test' }; };
  expect((await report(undefined, { cookie: INSTALL_COOKIE })).body.verified).toBe(false);
  expect(fixture.state.reads.size).toBe(0);
});

it('retracts a group verification when the group unloads while its member smoke is running', async () => {
  fixture.add(packageManifest('first-member'));
  const group = packageManifest('fixture-group'); group.kind = 'group'; group.routes = []; group.smoke = [];
  group.dependencies = { apps: ['first-member'] }; fixture.add(group, false);
  fixture.state.hold = async () => { fixture.catalog.unregister(group.name); fixture.state.hold = undefined; };
  const result = await report([group.name]);
  expect(result.body).toMatchObject({ verified: false, verificationStatus: 'pending', apps: [expect.objectContaining({ stale: true })] });
  expect(fixture.catalog.list(new Map([['first-member', 'Member']])).length).toBe(2);
});

it('keeps successful member evidence consistent in either selection order when only its group unloads', async () => {
  fixture.add(packageManifest('first-member'));
  const group = packageManifest('fixture-group'); group.kind = 'group'; group.routes = []; group.smoke = [];
  group.dependencies = { apps: ['first-member'] }; fixture.add(group, false);
  const summaries = [];
  for (const selection of [[group.name, 'first-member'], ['first-member', group.name]]) {
    fixture.catalog.register(fixture.records.get(group.name)!);
    fixture.state.hold = async () => { fixture.catalog.unregister(group.name); fixture.state.hold = undefined; };
    const result = (await report(selection)).body;
    expect(result.apps.find(app => app.appName === group.name)).toMatchObject({ verified: false, status: 'pending', stale: true });
    const member = result.apps.find(app => app.appName === 'first-member')!;
    expect(member).toMatchObject({ verified: true, status: 'passed', stale: false });
    expect(member.smokes[0].status).toBe('passed');
    expect(member.cases.find(test => test.runner === 'smoke')?.status).toBe('passed');
    summaries.push(result.summary);
  }
  expect(summaries[0]).toEqual(summaries[1]);
  expect(summaries[0]).toMatchObject({ registeredCases: 2, smokesPassed: 1, smokesPending: 0, suitesNotRun: 1 });
});

it('counts actual selected member evidence independently of an unavailable sibling in either order', async () => {
  fixture.add(packageManifest('first-member'));
  const group = packageManifest('fixture-group'); group.kind = 'group'; group.routes = []; group.smoke = [];
  group.dependencies = { apps: ['first-member', 'missing-member'] }; fixture.add(group, false);
  const summaries = [];
  for (const selection of [[group.name, 'first-member'], ['first-member', group.name]]) {
    const result = (await report(selection)).body;
    expect(result.apps.find(app => app.appName === group.name)?.status).toBe('failed');
    expect(result.apps.find(app => app.appName === 'first-member')?.verified).toBe(true);
    summaries.push(result.summary);
  }
  expect(summaries[0]).toEqual(summaries[1]);
  expect(summaries[0]).toMatchObject({ registeredCases: 2, smokesPassed: 1, smokesPending: 0 });
});

it('requires installation authority and rejects destinations supplied as app names', async () => {
  fixture.add();
  const anonymous = await fetch(fixture.base + '/api/install-verification/apps', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apps: ['install-fixture'] }) });
  expect([401, 403]).toContain(anonymous.status);
  expect((await installationRequest(fixture.base, ['http://untrusted.test'])).status).toBe(400);
  expect(fixture.state.reads.size).toBe(0);
});

it('uses the actual portable CLI formatter for passed, pending and failed installation outcomes', async () => {
  fixture.add();
  const pass = await cli('install-fixture');
  expect(pass.code).toBe(0); expect(pass.output).toContain('OSHAL_APP_VERIFICATION passed');
  expect(pass.output).toContain('Registered cases: 2'); expect(pass.output).toContain('suites not run: 1');
  expect(pass.output).toContain('/api/test-lab/app#card-app%3Ainstall-fixture%3Asmoke%3Aready');
  fixture.state.ready = false;
  const fail = await cli('install-fixture'); expect(fail.code).toBe(1); expect(fail.output).toContain('RESULT: FAIL');
  const pending = packageManifest('pending-fixture'); pending.smoke = [{ name: 'user', method: 'GET',
    path: '/api/pending-fixture/user', auth: 'pat', requiresUser: true, expect: { status: 200 } }];
  fixture.add(pending);
  const waiting = await cli('pending-fixture'); expect(waiting.code).toBe(0);
  expect(waiting.output).toContain('RESULT: PENDING'); expect(waiting.output).not.toContain('RESULT: PASS');
  expect(waiting.output).not.toContain('every named package executed'); expect(fixture.state.suiteRuns).toBe(0);
}, 60000);
