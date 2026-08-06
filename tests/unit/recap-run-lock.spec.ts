/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                   | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Two-process behavioral guard for the normal-run mutex: block a second shared-file run, keep verifier/manifest probes exempt, and prove release permits the next run.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Keep the concurrency scenario readable and policy-compliant by extracting each independent process assertion into a small named helper.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Guard recap's acquisition, heartbeat, and exact-token release of the durable render-node lease shared with the pump; the companion live spec proves real PostgreSQL contention.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Bound every PowerShell child and give only their host-startup handshakes full-suite headroom; mutex acquisition, exclusion, and release behavior remain unchanged.
 */
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  afterAll, describe, expect, it,
} from 'vitest';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..', '..');
const runner = join(repoRoot, 'scripts', 'run-daily-recap.ps1');
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const scratch = mkdtempSync(join(tmpdir(), 'oshal-recap-run-lock-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const delay = (milliseconds: number) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

/** @description Waits for the real runner to cross its post-lock, pre-staging test boundary. */
const waitForFile = async (path: string, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await delay(20);
  }
};

/** @description Creates one temp-scoped contract; token equality selects the same test mutex. */
const makeContract = (label: string, token: string, released = false) => {
  const path = join(scratch, `${label}.json`);
  const ready = join(scratch, `${label}.ready`);
  const release = join(scratch, `${label}.release`);
  writeFileSync(path, JSON.stringify({
    operation: 'holdNormalRunLock', token, ready, release, holdTimeoutMs: 60_000,
  }));
  if (released) writeFileSync(release, 'release');
  return { path, ready, release };
};

const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner, '-Date', '2026-08-05'];
const probeEnv = (contract: string) => ({
  ...process.env,
  OSHAL_RECAP_TEST_RUN_LOCK_CONTRACT: contract,
});

/** @description Starts a normal runner process and captures its deterministic exit evidence. */
const startNormalRun = (contract: string) => {
  const child = spawn(powershell, args, {
    encoding: 'utf8', windowsHide: true, env: probeEnv(contract),
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const done = new Promise<number | null>((resolve) => {
    child.once('close', (code) => resolve(code));
  });
  return { child, done, output: () => output };
};

const assertSecondRunBlocked = (contract: ReturnType<typeof makeContract>) => {
  const second = spawnSync(powershell, args, {
    encoding: 'utf8', windowsHide: true, timeout: 20_000,
    env: probeEnv(contract.path),
  });
  const output = `${second.stdout}\n${second.stderr}`;
  expect(second.status).toBe(1);
  expect(output).toMatch(/another daily recap run already owns/i);
  expect(existsSync(contract.ready)).toBe(false);
};

const assertProbeModesStayLockFree = (contract: string) => {
  const manifestProbe = join(scratch, 'manifest-probe.json');
  writeFileSync(manifestProbe, JSON.stringify({
    operation: 'validate', manifest: null, date: '2026-08-05', inputs: [], requiredPieces: [],
  }));
  const manifestResult = spawnSync(powershell, [
    ...args, '-ManifestContractProbe', manifestProbe,
  ], {
    encoding: 'utf8', windowsHide: true, timeout: 20_000, env: probeEnv(contract),
  });
  expect(manifestResult.status).toBe(0);
  expect(manifestResult.stdout).toContain('"valid":false');

  const invalidDelivery = join(scratch, 'invalid-delivery.json');
  writeFileSync(invalidDelivery, '{}');
  const verifierResult = spawnSync(powershell, [
    ...args, '-VerifyDeliveryManifest', invalidDelivery,
  ], {
    encoding: 'utf8', windowsHide: true, timeout: 20_000, env: probeEnv(contract),
  });
  expect(verifierResult.status).toBe(1);
  expect(verifierResult.stdout).toContain('"valid":false');
  expect(`${verifierResult.stdout}\n${verifierResult.stderr}`).not.toMatch(/another daily recap run/i);
};

const assertNextRunEnters = (token: string) => {
  const nextContract = makeContract('next', token, true);
  const next = spawnSync(powershell, args, {
    encoding: 'utf8', windowsHide: true, timeout: 20_000,
    env: probeEnv(nextContract.path),
  });
  expect(next.status, `${next.stdout}\n${next.stderr}`).toBe(0);
  expect(existsSync(nextContract.ready)).toBe(true);
};

describe('daily recap full-run concurrency lock (behavioral)', () => {
  it('keeps a second normal process before staging while probe modes stay lock-free', async () => {
    const token = randomUUID().replaceAll('-', '');
    const firstContract = makeContract('first', token);
    const secondContract = makeContract('second', token);
    const first = startNormalRun(firstContract.path);
    let firstStatus: number | null = null;

    try {
      await waitForFile(firstContract.ready);
      assertSecondRunBlocked(secondContract);
      assertProbeModesStayLockFree(secondContract.path);
    } finally {
      writeFileSync(firstContract.release, 'release');
      firstStatus = await first.done;
      if (firstStatus === null) first.child.kill();
    }

    expect(firstStatus, first.output()).toBe(0);
    assertNextRunEnters(token);
  }, 75_000);
});

describe('daily recap shared render-node lease wiring', () => {
  const source = readFileSync(runner, 'utf8');

  it('acquires the PostgreSQL lease before the first node preflight', () => {
    const acquire = source.indexOf('$sharedNodeLease = Enter-SharedNodeLease');
    const preflight = source.indexOf('# 1) PREFLIGHT');
    expect(acquire).toBeGreaterThan(0);
    expect(acquire).toBeLessThan(preflight);
    expect(source).toContain('/app/scripts/oshal-node-lease.js');
  });

  it('heartbeats during the long build and releases before the host mutex', () => {
    expect(source.match(/Renew-SharedNodeLease \$sharedNodeLease/g)?.length).toBeGreaterThanOrEqual(4);
    const finalizer = source.lastIndexOf('} finally {');
    const releaseLease = source.indexOf('Exit-SharedNodeLease $sharedNodeLease', finalizer);
    const releaseMutex = source.indexOf('Exit-RecapRunLock $recapRunLock', finalizer);
    expect(releaseLease).toBeGreaterThan(finalizer);
    expect(releaseLease).toBeLessThan(releaseMutex);
  });
});
