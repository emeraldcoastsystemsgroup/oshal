/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove fixed package Node execution, credential and filesystem isolation, resource refusal and complete Docker cancellation cleanup.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Kill a separate controller process and prove automatic deadline disposal and correlated hostile-orphan cleanup.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Prove unavailable image preflight certifies that no container requires cleanup.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { PackageTestSandbox } from '@/features/swarm-apps/services/package-test-sandbox';
import { sandboxPayload } from '@/features/swarm-apps/services/package-test-sandbox-launcher';
import { dockerControl } from '@/features/swarm-apps/services/package-test-sandbox-process';

const configuredImage = process.env.OSHAL_TEST_RUNNER_IMAGE || 'oshal-bot:latest';
const imageProbe = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', configuredImage], { encoding: 'utf8', timeout: 10000 });
const image = (imageProbe.stdout || '').trim();
const available = imageProbe.status === 0 && /^sha256:[a-f0-9]{64}$/.test(image);
const dockerTest = available ? it : it.skip;

/** @description Build one package-relative fixture; no live data, service credentials or filesystem mounts are used. */
function input(source: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  return { files: [{ path: 'tests/behavior.test.cjs', content: Buffer.from(source) }],
    suiteFiles: ['tests/behavior.test.cjs'], image, timeoutMs: options.timeoutMs ?? 20000,
    maxMemoryMb: 256, signal: options.signal };
}

it('rejects traversal, duplicate files, unsupported suite paths and oversized snapshots before running code', () => {
  for (const name of ['../outside.cjs', '/tmp/out.cjs', 'C:/outside.cjs', 'a/../b.cjs', 'a\\b.cjs', 'a//b.cjs']) {
    expect(() => sandboxPayload([{ path: name, content: Buffer.from('') }], [name])).toThrow('path_invalid');
  }
  const file = { path: 'test.cjs', content: Buffer.from('') };
  expect(() => sandboxPayload([file, file], [file.path])).toThrow('snapshot_invalid');
  expect(() => sandboxPayload([file], ['other.cjs'])).toThrow('suites_invalid');
  expect(() => sandboxPayload([{ ...file, content: Buffer.alloc(8 * 1024 * 1024 + 1) }], [file.path])).toThrow('snapshot_invalid');
});

it('does not create a container for an already cancelled invocation', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await new PackageTestSandbox().run(input('throw Error("must not run")', { signal: controller.signal }));
  expect(result).toMatchObject({ exitCode: null, cancelled: true, timedOut: false, cleanupVerified: true, output: '' });
});

dockerTest('runs actual Node assertions against a separately staged implementation in the pinned image', async () => {
  const request = input(`const {test}=require('node:test'),assert=require('node:assert/strict');
const total=require('../lib/total.cjs');test('invoice arithmetic',()=>assert.equal(total(3,125),375));`);
  request.files.push({ path: 'lib/total.cjs', content: Buffer.from('module.exports=(count,price)=>count*price;') });
  const result = await new PackageTestSandbox().run(request);
  expect(result, result.output).toMatchObject({ exitCode: 0, image, timedOut: false, cancelled: false, cleanupVerified: true });
  expect(result.output).toContain('invoice arithmetic'); expect(result.output).toContain('# pass 1');
}, 45000);

dockerTest('returns a real assertion failure without treating process execution as a passing test', async () => {
  const result = await new PackageTestSandbox().run(input(`const {test}=require('node:test'),assert=require('node:assert/strict');
test('broken calculation',()=>assert.equal(2+2,5));`));
  expect(result.exitCode).not.toBe(0); expect(result.output).toContain('not ok'); expect(result.cleanupVerified).toBe(true);
}, 45000);

dockerTest('keeps host credentials, daemon sockets, network and persistent filesystem writes unavailable', async () => {
  const before = process.env.OSHAL_SANDBOX_SENTINEL; process.env.OSHAL_SANDBOX_SENTINEL = 'fixture-private-secret';
  try {
    const result = await new PackageTestSandbox().run(input(`const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),net=require('node:net');
test('container authority boundary',async()=>{
 assert.equal(process.getuid(),1000);assert.equal(process.env.OSHAL_SANDBOX_SENTINEL,undefined);
 for(const key of ['DATABASE_URL','BOOTSTRAP_DATABASE_URL','SWARM_SERVICE_SECRET','OPENAI_API_KEY'])assert.equal(process.env[key],undefined);
 const initial=fs.readFileSync('/proc/1/environ','utf8');assert.equal(initial.includes('fixture-private-secret'),false);
 for(const entry of initial.split('\\0').filter(Boolean)){const key=entry.split('=')[0];if(/SECRET|PASSWORD|TOKEN|API_KEY|DATABASE_URL/i.test(key))assert.equal(entry,key+'=');}
 assert.equal(process.env.OSHAL_CORE_ROOT,'/app');assert.equal(fs.existsSync('/var/run/docker.sock'),false);
 assert.equal(fs.existsSync('/root/.codex/auth.json'),false);assert.equal(fs.existsSync('/root/.claude/.credentials.json'),false);
 assert.throws(()=>fs.writeFileSync('/app/package-test-write-refused','x'));
 fs.writeFileSync('/work/disposable.txt','fixture');assert.equal(fs.readFileSync('/work/disposable.txt','utf8'),'fixture');
 assert.match(fs.readFileSync('/proc/self/status','utf8'),/CapEff:\\s+0+\\n/);
 for(const host of ['1.1.1.1','127.0.0.1'])await new Promise((resolve,reject)=>{
  const socket=net.connect({host,port:35457});socket.setTimeout(400,()=>{socket.destroy();resolve();});
  socket.on('error',()=>resolve());socket.on('connect',()=>{socket.destroy();reject(Error('unexpected network access'));});
 });
});`));
    expect(result, result.output).toMatchObject({ exitCode: 0, cleanupVerified: true });
    expect(result.output).not.toContain('fixture-private-secret');
  } finally { if (before === undefined) delete process.env.OSHAL_SANDBOX_SENTINEL; else process.env.OSHAL_SANDBOX_SENTINEL = before; }
}, 45000);

dockerTest('terminates the whole container including detached descendants at the wall-clock limit', async () => {
  const result = await new PackageTestSandbox().run(input(`const {spawn}=require('node:child_process');
spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref();
console.log('DESCENDANT_READY');setInterval(()=>{},1000);`, { timeoutMs: 4000 }));
  expect(result.output).toContain('DESCENDANT_READY');
  expect(result).toMatchObject({ timedOut: true, cancelled: false, cleanupVerified: true });
  expect(result.exitCode).not.toBe(0);
}, 45000);

/** @description Observe only this fixture's nonce in isolated Docker output before requesting cancellation. */
async function waitForFixtureOutput(nonce: string): Promise<string> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const listing = await dockerControl(['ps', '--filter', 'label=oshal.test-lab.sandbox=1', '--format', '{{.Names}}']);
    for (const name of listing.output.trim().split(/\s+/).filter(Boolean)) {
      const logs = await dockerControl(['logs', '--tail', '10', name]);
      if (logs.output.includes(nonce)) return name;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Fixture did not start its isolated child');
}

dockerTest('cancels an already running process and verifies the named container is absent', async () => {
  const controller = new AbortController(), nonce = randomUUID();
  const work = new PackageTestSandbox().run(input(`console.log(${JSON.stringify(nonce)});setInterval(()=>{},1000);`, { signal: controller.signal }));
  try {
    const name = await waitForFixtureOutput(nonce);
    const inspected = await dockerControl(['inspect', '--format', '{{json .HostConfig}}', name]);
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.output)).toMatchObject({ Binds: null, ReadonlyRootfs: true, Privileged: false,
      NetworkMode: 'none', AutoRemove: true, PidsLimit: 64, NanoCpus: 1000000000, Memory: 256 * 1024 * 1024, CapDrop: ['ALL'] });
  } finally { controller.abort(); }
  const result = await work;
  expect(result.output).toContain(nonce); expect(result).toMatchObject({ cancelled: true, cleanupVerified: true });
  expect(result.exitCode).not.toBe(0);
}, 45000);

dockerTest('bounds output bytes and kills a flooding fixture instead of accumulating arbitrary controller memory', async () => {
  const result = await new PackageTestSandbox().run(input(`setInterval(()=>process.stdout.write('x'.repeat(65536)),1);`));
  expect(Buffer.byteLength(result.output)).toBeLessThan(64 * 1024 + 100);
  expect(result.output).toContain('output limit exceeded'); expect(result.cleanupVerified).toBe(true); expect(result.exitCode).not.toBe(0);
}, 45000);

dockerTest('refuses a missing local image without pulling or falling back to another runtime', async () => {
  const executionId = randomUUID(), sandbox = new PackageTestSandbox();
  await expect(sandbox.run({ ...input(''), executionId, image: `oshal-unavailable-fixture:${randomUUID()}` }))
    .rejects.toMatchObject({ message: 'package_test_image_unavailable', cleanupVerified: true });
  const listing = await dockerControl(['ps', '-a', '--filter', `name=^/oshal-lab-${executionId}$`, '--format', '{{.ID}}']);
  expect(listing.code).toBe(0); expect(listing.output.trim()).toBe('');
}, 30000);

/** @description Wait for actual Docker absence without invoking the recovery cleaner. */
async function waitForRemoval(executionId: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const listing = await dockerControl(['ps', '-a', '--filter', `name=^/oshal-lab-${executionId}$`, '--format', '{{.ID}}']);
    if (listing.code === 0 && !listing.output.trim()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw Error('Orphaned fixture container remained after its independent deadline');
}

/** @description Start one disposable controller process; killing it never targets the API or another runner. */
function startCrashController(executionId: string, mode = 'deadline') {
  return spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/package-test-sandbox-controller.ts', image, executionId, mode],
    { windowsHide: true, stdio: 'ignore' });
}

dockerTest('removes the container at its own deadline after the controller process disappears', async () => {
  const executionId = randomUUID(), controller = startCrashController(executionId), sandbox = new PackageTestSandbox();
  try {
    await waitForFixtureOutput(executionId);
    const exited = new Promise(resolve => controller.once('exit', resolve));
    expect(controller.kill('SIGKILL')).toBe(true); await exited;
    await waitForRemoval(executionId);
    expect(await sandbox.cleanupExecution(executionId)).toBe(true);
  } finally { controller.kill('SIGKILL'); await sandbox.cleanupExecution(executionId); }
}, 45000);

dockerTest('reaps a correlated orphan even when its fixture stopped the in-container launcher', async () => {
  const executionId = randomUUID(), controller = startCrashController(executionId, 'stop-launcher'), sandbox = new PackageTestSandbox();
  try {
    const name = await waitForFixtureOutput(executionId);
    const exited = new Promise(resolve => controller.once('exit', resolve));
    expect(controller.kill('SIGKILL')).toBe(true); await exited;
    const inspected = await dockerControl(['inspect', '--format', '{{json .Config.Labels}}', name]);
    expect(JSON.parse(inspected.output)).toMatchObject({ 'oshal.test-lab.sandbox': '1', 'oshal.test-lab.run-id': executionId });
    expect(await sandbox.cleanupExecution(executionId)).toBe(true); await waitForRemoval(executionId);
  } finally { controller.kill('SIGKILL'); await sandbox.cleanupExecution(executionId); }
}, 45000);
