/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — file-content guards for the 2026-07-28 recap outage fixes. Each assertion goes red if its fix regresses: doomed 30s pulls, existence-only piece checks (the stale-mix hazard), silent MessageBox failures, the missing OSHAL_USER_SUB on data steps, the localhost/::1 watchdog false-FAIL, piece-name drift across runner/assembler/goal, and the auto-journaled knob turns feeding the deck's "changes" section.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the 2026-07-30 silent-transfer fix, plus a re-point. NodePull is no longer a one-liner, so the existing 600000-timeout assertion (which required the value on the SAME line as `function NodePull`) is re-pointed at the function BODY — same claim, new shape; it would otherwise have gone green-by-vacuity the moment the body moved. New assertions: both transfer helpers inspect RN's result instead of discarding it to Out-Null, and NodePull fails on a local file that did not change (the exact shape of the 26-minute silent no-op).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Add behavioral build and delivery manifest guards. The production PowerShell contract is executed against stale-date, mismatched-input, partial, corrupt-piece, final-output tampering, and overwrite attempts so ResumePull, SkipBuild, and publishers cannot regress to trusting filenames or the node's current bytes.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Pin the async CLI failure boundary and finally-based remote scratch cleanup; require delivery outputs to retain the deck/PDF/video minimum-size rails.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Require explicit build-manifest identity and reject impossible delivery calendar dates.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Reject root-array and traversal-shaped delivery identities before any artifact path is derived.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Split manifest and delivery scenarios into small named fixtures and focused suites so every test callback stays within the repository's function-size limit.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Re-point remote-pull rails at the extracted option, staging, range-read, and cleanup helpers so the function-size refactor preserves non-vacuous linear-transfer and failure-cleanup guards.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Give the delivery-verifier behavior guard an explicit process-startup budget. It launches five real Windows PowerShell processes and can exceed Vitest's five-second default only when the full suite contends for process startup; the production verifier and its fail-closed assertions remain unchanged.
 * 10 | maintainer@emeraldcoastsystemsgroup.com  | Apply the same bounded process-startup budget to artifact-reuse guards that launch two or three real PowerShell probes. Full-suite contention must not turn successful fail-closed verification into a five-second harness timeout.
 * 11 | maintainer@emeraldcoastsystemsgroup.com  | Prove the completed-build contract rejects omitted timestamps, divergent top-level input digests, reversed time bounds, and pieces lacking successful ffprobe evidence.
 * 12 | maintainer@emeraldcoastsystemsgroup.com  | Give each real PowerShell manifest/delivery boundary a call-count-sized startup budget under the parallel suite; production verification rules remain unchanged.
 */
import { afterAll, describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * Extracts one PowerShell function's body from a script's text.
 * @description Assertions that pin behaviour to a single physical line silently stop testing
 *   anything when the function is reformatted. Scoping to the body keeps the claim honest
 *   across shape changes — and throws (rather than passing) if the function is renamed away.
 * @param src the script contents
 * @param name the function name, e.g. 'NodePull'
 * @returns the function header plus its brace-matched body
 * @throws if the function is absent or its braces do not balance — either way the guard is no
 *   longer testing what it claims to, and going red is the correct outcome.
 */
const bodyOf = (src: string, name: string): string => {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found — the guard is pointing at a name that no longer exists`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && (depth -= 1) === 0) return src.slice(start, i + 1);
  }
  throw new Error(`function ${name} has unbalanced braces — cannot scope the assertion to its body`);
};

const runner = read('scripts/run-daily-recap.ps1');
const routability = read('scripts/swarm-routability-check.sh');
const remoteNode = read('scripts/codex-remote-node.mjs');
const assemble = read('scripts/assemble-recap.js');
const goal = read('packages/oshal-vids-operator/RECAP-BUILD-GOAL.md');
const deckGen = read('scripts/oshal-deck-data.js');
const overrides = read('src/app/trading-config-overrides.ts');
const template = read('packages/oshal-vids-operator/make-deck-detailed.py');

const manifestProbeDir = mkdtempSync(join(tmpdir(), 'oshal-recap-manifest-'));
const runnerPath = join(root, 'scripts', 'run-daily-recap.ps1');
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
let manifestProbeSeq = 0;

type ManifestProbeResult = { status: number | null; body: Record<string, unknown>; stderr: string };

/**
 * Executes the production manifest contract without entering the recap workflow.
 * @description The runner's probe exits before Docker, node calls, or recap paths are touched;
 *   exercising PowerShell itself prevents a TypeScript reimplementation from drifting green.
 * @param payload operation and values consumed by the production contract
 * @returns process status, parsed JSON result, and stderr for actionable assertion failures
 */
const runManifestProbe = (payload: Record<string, unknown>): ManifestProbeResult => {
  const probePath = join(manifestProbeDir, `probe-${manifestProbeSeq += 1}.json`);
  writeFileSync(probePath, JSON.stringify(payload), 'utf8');
  const child = spawnSync(powershell, ['-NoProfile', '-File', runnerPath, '-ManifestContractProbe', probePath], {
    encoding: 'utf8',
  });
  if (child.error) throw new Error(`PowerShell manifest probe could not start: ${child.error.message}`);
  const output = child.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!output) throw new Error(`PowerShell manifest probe returned no JSON (stderr: ${child.stderr})`);
  return { status: child.status, body: JSON.parse(output) as Record<string, unknown>, stderr: child.stderr };
};

/** @description Executes the same fail-closed delivery verifier exposed to recap publishers. */
const runDeliveryVerifier = (manifestPath: string, artifactRoot: string): ManifestProbeResult => {
  const child = spawnSync(powershell, [
    '-NoProfile', '-File', runnerPath,
    '-VerifyDeliveryManifest', manifestPath,
    '-DeliveryArtifactRoot', artifactRoot,
  ], { encoding: 'utf8' });
  if (child.error) throw new Error(`PowerShell delivery verifier could not start: ${child.error.message}`);
  const output = child.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!output) throw new Error(`PowerShell delivery verifier returned no JSON (stderr: ${child.stderr})`);
  return { status: child.status, body: JSON.parse(output) as Record<string, unknown>, stderr: child.stderr };
};

afterAll(() => rmSync(manifestProbeDir, { recursive: true, force: true }));

const requiredPieces = ['presenter-intro.mp4', 'presenter-overview.mp4', 'presenter-close.mp4', 'deck-narrated.mp4'];
const expectedInputs = [
  { name: 'deck-data.json', bytes: 1200, sha256: '1'.repeat(64) },
  { name: 'deck.pptx', bytes: 6400, sha256: '2'.repeat(64) },
  { name: 'presenter-head.png', bytes: 3200, sha256: '3'.repeat(64) },
  { name: 'RECAP-BUILD-GOAL.md', bytes: 1800, sha256: '4'.repeat(64) },
];

/** @description Returns a new valid manifest so each adversarial case mutates isolated data. */
const validManifest = (): Record<string, unknown> => ({
  schemaVersion: 1,
  manifestKind: 'recap-build',
  runId: 'a'.repeat(32),
  date: '2026-08-05',
  requestedDate: '2026-08-05',
  status: 'complete',
  startedAt: '2026-08-05T22:50:00.0000000+00:00',
  completedAt: '2026-08-05T23:20:00.0000000+00:00',
  deckDataSha256: expectedInputs[0].sha256,
  deckPptxSha256: expectedInputs[1].sha256,
  inputs: expectedInputs.map((item) => ({ ...item })),
  pieces: requiredPieces.map((name, index) => ({
    name, bytes: 400_000 + index, sha256: String(index + 5).repeat(64), mediaVerified: true,
  })),
});

/** @description Executes manifest validation using the canonical requested date and inputs. */
const validateManifest = (manifest: unknown): ManifestProbeResult => runManifestProbe({
  operation: 'validate', manifest, date: '2026-08-05', inputs: expectedInputs, requiredPieces,
});

const fileArtifact = (name: string, path: string) => {
  const bytes = readFileSync(path);
  return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};

const createDeliveryFixture = () => {
  const artifactRoot = join(manifestProbeDir, 'delivery-verifier');
  mkdirSync(artifactRoot);
  const build = validManifest();
  const runId = String(build.runId);
  const buildName = `build-artifacts-${runId}.json`;
  const buildPath = join(artifactRoot, buildName);
  const outputNames = ['deck.pptx', '2026-08-05.pdf', 'trade-recap.mp4'];
  const outputSizes = [20_000, 20_001, 1_100_000];
  for (const [index, name] of outputNames.entries()) {
    writeFileSync(join(artifactRoot, name), Buffer.alloc(outputSizes[index], index + 1));
  }
  const buildInputs = build.inputs as Array<{ name: string; bytes: number; sha256: string }>;
  Object.assign(buildInputs.find((item) => item.name === 'deck.pptx')!, fileArtifact('deck.pptx', join(artifactRoot, 'deck.pptx')));
  build.deckPptxSha256 = buildInputs.find((item) => item.name === 'deck.pptx')!.sha256;
  writeFileSync(buildPath, JSON.stringify(build), 'utf8');
  const delivery = {
    schemaVersion: 1, manifestKind: 'recap-delivery', runId, deliveryId: 'b'.repeat(32),
    requestedDate: '2026-08-05', status: 'complete', completedAt: '2026-08-05T23:30:00.0000000+00:00',
    buildManifest: fileArtifact(buildName, buildPath), inputs: build.inputs, pieces: build.pieces,
    outputs: outputNames.map((name) => fileArtifact(name, join(artifactRoot, name))),
  };
  const deliveryPath = join(artifactRoot, 'RECAP.manifest.json');
  writeFileSync(deliveryPath, JSON.stringify(delivery), 'utf8');
  return {
    artifactRoot, deliveryPath, delivery, runId, videoSize: outputSizes[2],
  };
};

const assertDeliveryMutationsFailClosed = (fixture: ReturnType<typeof createDeliveryFixture>) => {
  const { artifactRoot, deliveryPath, delivery } = fixture;
  writeFileSync(join(artifactRoot, 'trade-recap.mp4'), Buffer.alloc(fixture.videoSize, 9));
  const tampered = runDeliveryVerifier(deliveryPath, artifactRoot);
  expect(tampered.status).toBe(1);
  expect(tampered.body.errors as string[]).toContain("output 'trade-recap.mp4' SHA-256 mismatch");

  delivery.requestedDate = '2026-02-30';
  writeFileSync(deliveryPath, JSON.stringify(delivery), 'utf8');
  const impossibleDate = runDeliveryVerifier(deliveryPath, artifactRoot);
  expect(impossibleDate.status).toBe(1);
  expect(impossibleDate.body.errors as string[]).toContain('delivery requestedDate is invalid');

  delivery.requestedDate = '..\\..\\outside-root';
  writeFileSync(deliveryPath, JSON.stringify(delivery), 'utf8');
  const traversal = runDeliveryVerifier(deliveryPath, artifactRoot);
  expect(traversal.status).toBe(1);
  expect(traversal.body.errors).toEqual(['delivery requestedDate is invalid']);

  writeFileSync(deliveryPath, JSON.stringify([delivery]), 'utf8');
  const rootArray = runDeliveryVerifier(deliveryPath, artifactRoot);
  expect(rootArray.status).toBe(2);
  expect(String((rootArray.body.errors as string[])[0])).toMatch(/root must be an object/i);
};

describe('recap runner honesty rails (2026-07-28 outage fixes)', () => {
  it('pulls wait for chunked transfers instead of the doomed 30s default', () => {
    expect(bodyOf(runner, 'NodePull')).toMatch(/--timeoutMs=600000/);
  });
  it('piece check includes FRESHNESS, not just existence (the stale-mix hazard)', () => {
    expect(runner).toMatch(/LastWriteTime -lt \$runStart/);
  });
  it('failures alert by email, never a blocking dialog an unattended run cannot dismiss', () => {
    expect(runner).toMatch(/oshal-send-alert\.js/);
    expect(runner).not.toMatch(/MessageBox/);
  });
  it('data generation carries OSHAL_USER_SUB (else the headline P/L ships as silent nulls)', () => {
    expect(runner).toMatch(/OSHAL_USER_SUB=\$\(\$env:OSHAL_USER_SUB\)/);
  });
  it('preflight prunes stray Chrome but never the oshal-video-chrome automation profile', () => {
    expect(runner).toMatch(/CommandLine -notmatch 'oshal-video-chrome'/);
  });
  it('runner writes ops-notes.json for the report\'s operations section', () => {
    expect(runner).toMatch(/ops-notes\.json/);
  });
  it('runs ffprobe before recording media verification in the immutable manifest inventory', () => {
    expect(runner).toMatch(/Get-Command `\$ffprobeName -ErrorAction Stop/);
    expect(runner).toMatch(/-show_entries 'stream=codec_type:format=duration'/);
    expect(runner).toMatch(/`\$record\.mediaVerified = `\$true/);
    expect(runner.indexOf('`$record.mediaVerified = `$true')).toBeLessThan(runner.indexOf('$manifest = [ordered]@{'));
  });
});

describe('completed-build manifest identity contract (behavioral)', () => {
  it('accepts one complete run binding date, input hashes, and all piece hashes', { timeout: 15_000 }, () => {
    const result = validateManifest(validManifest());
    expect(result.status, result.stderr).toBe(0);
    expect(result.body).toMatchObject({ valid: true, errors: [] });
  });

  it('makes SkipBuild fail closed when the manifest is missing or belongs to another date', { timeout: 30_000 }, () => {
    const missing = validateManifest(null);
    expect(missing.body).toMatchObject({ valid: false, errors: ['manifest is missing'] });

    const stale = validManifest();
    stale.requestedDate = '2026-08-04';
    const result = validateManifest(stale);
    expect(result.body.valid).toBe(false);
    expect(result.body.errors as string[]).toContain("requestedDate '2026-08-04' does not match '2026-08-05'");
  });

  it('rejects a build with the wrong manifest kind', { timeout: 15_000 }, () => {
    const manifest = validManifest();
    manifest.manifestKind = 'recap-delivery';
    const result = validateManifest(manifest);
    expect(result.body.valid).toBe(false);
    expect(result.body.errors as string[]).toContain('build manifest schema is invalid');
  });

  it('makes SkipBuild fail on changed inputs, an incomplete status, and partial piece inventory', { timeout: 15_000 }, () => {
    const manifest = validManifest();
    (manifest.inputs as Array<{ sha256: string }>)[0].sha256 = 'f'.repeat(64);
    (manifest.pieces as Array<{ name: string; bytes: number }>).pop();
    manifest.status = 'building';
    const result = validateManifest(manifest);
    const errors = result.body.errors as string[];
    expect(result.body.valid).toBe(false);
    expect(errors).toEqual(expect.arrayContaining([
      "status 'building' is not complete",
      "input 'deck-data.json' SHA-256 mismatch",
      'piece count is 3, expected 4',
      "piece 'deck-narrated.mp4' must appear exactly once",
    ]));
  });

  it('rejects manifests missing explicit input digests, start provenance, or media proof', { timeout: 15_000 }, () => {
    const manifest = validManifest();
    delete manifest.startedAt;
    manifest.deckDataSha256 = 'f'.repeat(64);
    delete (manifest.pieces as Array<Record<string, unknown>>)[0].mediaVerified;
    const result = validateManifest(manifest);
    expect(result.body.valid).toBe(false);
    expect(result.body.errors as string[]).toEqual(expect.arrayContaining([
      'startedAt is missing or invalid',
      'deckDataSha256 does not match the deck-data.json input',
      "piece 'presenter-intro.mp4' has no successful media verification",
    ]));
  });

  it('rejects a manifest whose completion precedes its declared start', { timeout: 15_000 }, () => {
    const manifest = validManifest();
    manifest.startedAt = '2026-08-05T23:21:00.000Z';
    const result = validateManifest(manifest);
    expect(result.body.valid).toBe(false);
    expect(result.body.errors as string[]).toContain('completedAt precedes startedAt');
  });
});

describe('completed-build artifact reuse contract (behavioral)', () => {
  // These guards intentionally execute the production PowerShell contract multiple times. Their
  // explicit budget covers process startup under full-suite load; it does not relax verification.
  it('allows ResumePull reuse only for the exact manifest byte length and SHA-256', { timeout: 15_000 }, () => {
    const piecePath = join(manifestProbeDir, 'presenter-intro.mp4');
    const bytes = Buffer.alloc(400_000, 7);
    writeFileSync(piecePath, bytes);
    const artifact = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };

    const exact = runManifestProbe({ operation: 'pieceMatches', path: piecePath, artifact });
    expect(exact.status, exact.stderr).toBe(0);
    expect(exact.body).toEqual({ matches: true });

    bytes[0] = 8;
    writeFileSync(piecePath, bytes);
    const changed = runManifestProbe({ operation: 'pieceMatches', path: piecePath, artifact });
    expect(changed.body).toEqual({ matches: false });

    const wrongLength = runManifestProbe({ operation: 'pieceMatches', path: piecePath, artifact: { ...artifact, bytes: bytes.length - 1 } });
    expect(wrongLength.body).toEqual({ matches: false });
  });

  it('never overwrites a run-id-named immutable manifest', { timeout: 15_000 }, () => {
    const immutablePath = join(manifestProbeDir, 'build-artifacts-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json');
    const first = runManifestProbe({ operation: 'writeImmutable', path: immutablePath, value: { runId: 'first' } });
    expect(first.status, first.stderr).toBe(0);

    const overwrite = runManifestProbe({ operation: 'writeImmutable', path: immutablePath, value: { runId: 'second' } });
    expect(overwrite.status).toBe(2);
    expect(String(overwrite.body.error)).toMatch(/exist/i);
    expect(JSON.parse(readFileSync(immutablePath, 'utf8'))).toEqual({ runId: 'first' });
  });
});

describe('delivery verifier contract (behavioral)', () => {
  // Five production PowerShell invocations are intentional: one valid delivery plus four distinct
  // tamper shapes. Full-suite process contention can make their startup alone exceed Vitest's
  // five-second default, so this test owns a bounded harness budget without relaxing any verifier.
  it('publisher verifier binds deck, dated PDF, and final video to the same build run', { timeout: 45_000 }, () => {
    const fixture = createDeliveryFixture();
    const valid = runDeliveryVerifier(fixture.deliveryPath, fixture.artifactRoot);
    expect(valid.status, valid.stderr).toBe(0);
    expect(valid.body).toMatchObject({ valid: true, runId: fixture.runId });
    assertDeliveryMutationsFailClosed(fixture);
  });
});

// 2026-07-30: the four piece pulls ran 26 minutes, reported nothing, and produced a prior day's
// deck-narrated.mp4. RN returns its last output after exhausting retries; both helpers threw that
// output away with `| Out-Null`, so a dead transfer and a good one were the same thing to every
// caller. The failure the operator finally saw named a stale FILE, not the dead transfer.
describe('node transfers fail loudly (2026-07-30 silent-pull fix)', () => {
  it('neither transfer helper discards the driver result to Out-Null', () => {
    expect(bodyOf(runner, 'NodePull')).not.toMatch(/\|\s*Out-Null/);
    expect(bodyOf(runner, 'NodePush')).not.toMatch(/\|\s*Out-Null/);
  });

  it('both helpers inspect the result and call Fail on a dead transfer', () => {
    for (const fn of ['NodePull', 'NodePush']) {
      const body = bodyOf(runner, fn);
      expect(body, `${fn} must test the transfer result`).toMatch(/TransferFailed/);
      expect(body, `${fn} must fail loudly, not continue`).toMatch(/Fail /);
    }
  });

  it('the failure test covers the transport errors RN itself retries on', () => {
    const test = bodyOf(runner, 'TransferFailed');
    for (const signal of ['ECONNRESET', 'fetch failed', 'timed out']) {
      expect(test, `TransferFailed must recognise "${signal}"`).toContain(signal);
    }
  });

  it('NodePull rejects a pull that left the local copy unchanged (the silent no-op)', () => {
    const body = bodyOf(runner, 'NodePull');
    expect(body).toMatch(/\$before/);              // captures the pre-pull timestamp
    expect(body).toMatch(/LastWriteTime -le \$before/); // …and refuses when it did not move
  });

  it('keeps the independent step-5 freshness gate — it catches a stale REMOTE piece', () => {
    expect(runner).toMatch(/LastWriteTime -lt \$runStart/);
  });
});

describe('watchdog false-FAIL fix', () => {
  it('routability probes 127.0.0.1, not localhost (the ::1 wslrelay squatter)', () => {
    expect(routability).toMatch(/127\.0\.0\.1:35457/);
    expect(routability).not.toMatch(/http:\/\/localhost:35457/);
  });
});

describe('remote pull chunk window', () => {
  it('pull defaults each chunk to a patient window; explicit --timeoutMs still wins', () => {
    expect(remoteNode).toMatch(/if \(args\.timeoutMs == null\) args\.timeoutMs = 120_000;/);
  });
});

// 2026-07-30: pullFile re-ran ToBase64String(ReadAllBytes(file)) for EVERY chunk and discarded all
// but ~14KB of the result. A 2.8MB piece is 278 chunks, so the node read 810MB and encoded 1.08GB
// to deliver 2.8MB — quadratic, four times a night, and it presents as a node that looks idle
// while the pull grinds for 26 minutes and then fails.
describe('pull is linear, not quadratic (2026-07-30)', () => {
  const pull = bodyOf(remoteNode, 'pullFile');
  const options = bodyOf(remoteNode, 'resolvePullOptions');
  const stage = bodyOf(remoteNode, 'stageRemotePull');
  const ranges = bodyOf(remoteNode, 'readRemotePullChunks');
  const chunk = bodyOf(remoteNode, 'fetchRemotePullChunk');
  const cleanup = bodyOf(remoteNode, 'finalizeRemotePull');

  it('encodes the source exactly once, not once per chunk', () => {
    // Comment prose describes the old quadratic loop, so count code only.
    const code = [stage, ranges, chunk].join('\n').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const encodes = code.match(/ToBase64String/g) || [];
    expect(encodes, 'a second ToBase64String in code means the per-chunk re-encode is back').toHaveLength(1);
  });

  it('the per-chunk command reads the scratch file, never the source', () => {
    const chunkCmd = /const cmd = \[([\s\S]*?)\]\.join/.exec(chunk);
    expect(chunkCmd, 'per-chunk command not found').toBeTruthy();
    expect(chunkCmd![1], 'the chunk read must not touch remotePath — that is the quadratic bug')
      .not.toMatch(/remotePath/);
    expect(chunkCmd![1]).toMatch(/marker/);
  });

  it('serves chunks as byte-range reads of a staged scratch file', () => {
    expect(chunk).toMatch(/OpenRead/);
    expect(chunk).toMatch(/Seek\(\$\{offset\}/);
  });

  it('deletes the scratch file even when the transfer fails midway', () => {
    expect(cleanup).toMatch(/Remove-Item/);
    expect(cleanup).toMatch(/-ErrorAction Stop/);
    expect(pull).toMatch(/finally\s*{\s*await finalizeRemotePull\(marker, transferError\)/);
    expect(remoteNode).toMatch(/function die\(message\)\s*{\s*throw new Error/);
    expect(remoteNode).not.toMatch(/function die\(message\)[\s\S]{0,100}process\.exit/);
  });

  it('refuses a short chunk instead of splicing it into the file', () => {
    expect(chunk).toMatch(/got\.length !== take/);
    expect(chunk).toMatch(/throw new Error/);
  });

  it('keeps the chunk under the node\'s measured 20000-char stdout truncation', () => {
    const clamp = /Math\.min\(num\(args\.chunkSize,\s*(\d+)\),\s*(\d+)\)/.exec(options);
    expect(clamp, 'chunkSize clamp not found — the truncation guard is unverified').toBeTruthy();
    expect(Number(clamp![1]), 'default chunk must sit under the 20000 cap').toBeLessThan(20000);
    expect(Number(clamp![2]), 'max chunk must sit under the 20000 cap').toBeLessThan(20000);
  });
});

describe('the nightly runs the trunk driver, not the frozen archive', () => {
  it('$RNJS resolves to the script\'s own repo first', () => {
    // Every driver fix landed in the trunk while the nightly kept loading the archive's copy,
    // which has neither the 07-28 chunk-window fix nor the 07-30 quadratic-pull fix.
    expect(runner).toMatch(/\$RNJS\s*=\s*if \(Test-Path "\$PSScriptRoot\\codex-remote-node\.mjs"\)/);
  });
});

describe('piece-name contract (runner, assembler and build goal must agree)', () => {
  const pieces = ['presenter-intro.mp4', 'presenter-overview.mp4', 'presenter-close.mp4', 'deck-narrated.mp4'];
  it.each(pieces)('%s appears in runner, assembler and goal', (piece) => {
    expect(runner).toContain(piece);
    if (piece !== 'deck-narrated.mp4') expect(assemble).toContain(piece);
    else expect(assemble).toContain(piece);
    expect(goal).toContain(piece);
  });
  it('no orphaned pre-scrub piece names survive anywhere in the contract files', () => {
    for (const f of [runner, assemble, goal]) expect(f).not.toMatch(/the operator-(intro|overview|close)\.mp4/);
  });
});

describe('what-changed / ops sections exist end to end', () => {
  it('deck generator reads the strategy journal since the prior session', () => {
    expect(deckGen).toMatch(/oshal_trading_strategy_journal/);
    expect(deckGen).toMatch(/et_day > \$2::date AND et_day <= \$3::date/);
  });
  it('deck generator folds date-guarded ops notes in', () => {
    expect(deckGen).toMatch(/ops-notes\.json/);
    expect(deckGen).toMatch(/ops\.date !== targetDate/);
  });
  it('knob turns auto-journal on apply and revert', () => {
    expect(overrides).toMatch(/recordStrategyJournal/);
    expect(overrides).toMatch(/applyOverride[\s\S]*kind: 'knob-turn'/);
  });
  it('the deck template renders the transparency slide honestly when empty', () => {
    expect(template).toMatch(/WHAT CHANGED/);
    expect(template).toMatch(/No strategy changes since the last report/);
  });
});
