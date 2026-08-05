/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add deterministic behavioral guards proving publication consumes the delivery snapshot actually verified and canonical verification hashes and parses one build-manifest byte snapshot.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Opt into the temp-scoped snapshot race seam through an explicit contract-probe operation.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Keep each independent substitution boundary in a focused suite so the test-registration callbacks remain below the function-size limit.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..', '..');
const helperPath = join(repoRoot, 'scripts', 'lib', 'recap-publication.ps1');
const runnerPath = join(repoRoot, 'scripts', 'run-daily-recap.ps1');
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const scratch = mkdtempSync(join(tmpdir(), 'oshal-recap-toctou-'));

type ChildResult = { status: number | null; stdout: string; stderr: string };

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** @description Computes the exact lower-case SHA-256 representation used by recap manifests. */
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** @description Records one artifact from its on-disk bytes so fixtures exercise production checks. */
const artifact = (name: string, path: string) => {
  const bytes = readFileSync(path);
  return { name, bytes: bytes.length, sha256: sha256(bytes) };
};

/** @description Starts a real PowerShell child and captures its complete result without shell quoting. */
const startPowerShell = (args: string[], env: NodeJS.ProcessEnv = process.env) => {
  const child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const completion = new Promise<ChildResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
  return completion;
};

/** @description Waits for an explicit child-process boundary marker and fails instead of skipping. */
const waitForFile = async (path: string, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
};

/** @description Replaces a manifest path with complete alternate bytes, never exposing a partial write. */
const replaceFile = (path: string, bytes: Buffer): void => {
  const pending = `${path}.replacement`;
  writeFileSync(pending, bytes);
  rmSync(path);
  renameSync(pending, path);
};

/** @description Returns the final JSON object printed by a PowerShell probe. */
const parseLastJsonLine = (output: string): Record<string, unknown> => {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
};

/** @description Writes a verifier child that captures its input before waiting for a pointer swap. */
const writeBlockingVerifier = (path: string): void => writeFileSync(path, String.raw`
param([string]$VerifyDeliveryManifest, [string]$DeliveryArtifactRoot)
$raw = [IO.File]::ReadAllText($VerifyDeliveryManifest, [Text.Encoding]::UTF8)
$hash = (Get-FileHash -LiteralPath $VerifyDeliveryManifest -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($env:OSHAL_RECAP_TEST_CHILD_CAPTURE, $raw)
[IO.File]::WriteAllText($env:OSHAL_RECAP_TEST_CHILD_READY, 'ready')
$deadline = [datetime]::UtcNow.AddSeconds(15)
while (-not (Test-Path -LiteralPath $env:OSHAL_RECAP_TEST_CHILD_RELEASE)) {
  if ([datetime]::UtcNow -ge $deadline) { throw 'test verifier timed out' }
  Start-Sleep -Milliseconds 10
}
[pscustomobject]@{ valid = $true; manifestSha256 = $hash } | ConvertTo-Json -Compress
`);

/** @description Writes a thin process wrapper that invokes the real shared publication helper. */
const writeDeliveryReader = (path: string): void => writeFileSync(path, String.raw`
param([string]$Helper, [string]$Manifest, [string]$Artifacts, [string]$Date, [string]$Verifier)
. $Helper
$delivery = Read-VerifiedRecapDelivery $Manifest $Artifacts $Date $Verifier
[pscustomobject]@{ runId = $delivery.runId; requestedDate = $delivery.requestedDate } |
  ConvertTo-Json -Compress
`);

/** @description Creates a complete delivery whose hashed build and later-read build disagree safely. */
const createBuildSwapFixture = (name: string) => {
  const root = join(scratch, name);
  mkdirSync(root, { recursive: true });
  const date = '2026-08-05';
  const validRunId = 'a'.repeat(32);
  const sourceBytes = new Map<string, Buffer>([
    ['deck-data.json', Buffer.from('{"date":"August 5, 2026","results":{"pl":42}}')],
    ['deck.pptx', Buffer.alloc(20_000, 2)],
    ['presenter-head.png', Buffer.alloc(12_000, 3)],
    ['RECAP-BUILD-GOAL.md', Buffer.alloc(11_000, 4)],
    [`${date}.pdf`, Buffer.alloc(20_001, 5)],
    ['trade-recap.mp4', Buffer.alloc(1_100_000, 6)],
  ]);
  for (const [file, bytes] of sourceBytes) writeFileSync(join(root, file), bytes);
  const inputNames = ['deck-data.json', 'deck.pptx', 'presenter-head.png', 'RECAP-BUILD-GOAL.md'];
  const inputs = inputNames.map((file) => artifact(file, join(root, file)));
  const pieceNames = ['presenter-intro.mp4', 'presenter-overview.mp4', 'presenter-close.mp4', 'deck-narrated.mp4'];
  const pieces = pieceNames.map((file, index) => ({ name: file, bytes: 400_000 + index, sha256: String(index + 1).repeat(64) }));
  const build = {
    schemaVersion: 1, manifestKind: 'recap-build', runId: validRunId,
    requestedDate: date, status: 'complete', completedAt: '2026-08-05T23:20:00.000Z',
    inputs, pieces,
  };
  const hashedBytes = Buffer.from(JSON.stringify({ ...build, runId: 'c'.repeat(32) }));
  const readBytes = Buffer.from(JSON.stringify(build));
  const buildName = `build-artifacts-${validRunId}.json`;
  const buildPath = join(root, buildName);
  writeFileSync(buildPath, hashedBytes);
  const outputs = ['deck.pptx', `${date}.pdf`, 'trade-recap.mp4'].map((file) => artifact(file, join(root, file)));
  const delivery = {
    schemaVersion: 1, manifestKind: 'recap-delivery', runId: validRunId,
    deliveryId: 'b'.repeat(32), requestedDate: date, status: 'complete',
    completedAt: '2026-08-05T23:30:00.000Z',
    buildManifest: artifact(buildName, buildPath), inputs, pieces, outputs,
  };
  const deliveryPath = join(root, 'RECAP.manifest.json');
  writeFileSync(deliveryPath, JSON.stringify(delivery));
  return { root, buildPath, deliveryPath, hashedBytes, readBytes };
};

describe('recap delivery-pointer TOCTOU boundary (behavioral)', () => {
  it('returns the exact delivery snapshot verified even when its source pointer is replaced', async () => {
    const root = join(scratch, 'delivery-pointer');
    mkdirSync(root, { recursive: true });
    const pointer = join(root, 'RECAP.manifest.json');
    const verified = { requestedDate: '2026-08-05', runId: 'a'.repeat(32) };
    const replacement = { requestedDate: '2026-08-05', runId: 'b'.repeat(32) };
    writeFileSync(pointer, JSON.stringify(verified));
    const verifier = join(root, 'blocking-verifier.ps1');
    const wrapper = join(root, 'read-delivery.ps1');
    const ready = join(root, 'child.ready');
    const release = join(root, 'child.release');
    const capture = join(root, 'child-capture.json');
    writeBlockingVerifier(verifier);
    writeDeliveryReader(wrapper);

    const completion = startPowerShell([
      '-File', wrapper, '-Helper', helperPath, '-Manifest', pointer,
      '-Artifacts', root, '-Date', '2026-08-05', '-Verifier', verifier,
    ], {
      ...process.env,
      OSHAL_RECAP_TEST_CHILD_READY: ready,
      OSHAL_RECAP_TEST_CHILD_RELEASE: release,
      OSHAL_RECAP_TEST_CHILD_CAPTURE: capture,
    });
    await waitForFile(ready);
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual(verified);
    replaceFile(pointer, Buffer.from(JSON.stringify(replacement)));
    writeFileSync(release, 'continue');

    const result = await completion;
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(parseLastJsonLine(result.stdout)).toMatchObject(verified);
    expect(JSON.parse(readFileSync(pointer, 'utf8'))).toEqual(replacement);
  }, 30_000);
});

describe('recap build-manifest TOCTOU boundary (behavioral)', () => {
  it('rejects a hash-valid build whose later path bytes would be semantically valid', async () => {
    const fixture = createBuildSwapFixture('build-swap');
    const ready = join(fixture.root, 'build-hashed.ready');
    const release = join(fixture.root, 'build-hashed.release');
    const contractProbe = join(fixture.root, 'snapshot-race-probe.json');
    writeFileSync(contractProbe, JSON.stringify({ operation: 'verifiedJsonSnapshotRace' }));
    const completion = startPowerShell([
      '-File', runnerPath, '-VerifyDeliveryManifest', fixture.deliveryPath,
      '-DeliveryArtifactRoot', fixture.root, '-ManifestContractProbe', contractProbe,
    ], {
      ...process.env,
      OSHAL_RECAP_TEST_VERIFIED_JSON_READY: ready,
      OSHAL_RECAP_TEST_VERIFIED_JSON_RELEASE: release,
      OSHAL_RECAP_TEST_VERIFIED_JSON_TARGET: fixture.buildPath,
    });
    await waitForFile(ready);
    expect(fixture.readBytes.length).toBe(fixture.hashedBytes.length);
    expect(sha256(fixture.readBytes)).not.toBe(sha256(fixture.hashedBytes));
    replaceFile(fixture.buildPath, fixture.readBytes);
    writeFileSync(release, 'continue');

    const result = await completion;
    const body = parseLastJsonLine(result.stdout);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(body.valid).toBe(false);
    expect(body.errors).toContain('delivery runId does not match the build manifest');
  }, 30_000);
});
