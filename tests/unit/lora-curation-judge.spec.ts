/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary guard for the LoRA automated curation judge. Runs the REAL scripts/comfyui-edge/make-curate.py over a real pool of image/caption pairs and inspects the artefact train-lora.py actually consumes - curated.zip - so "rejected candidates do not enter the training set" is proved at the training-set boundary rather than at the decision function. Also drives curation_judge.py's labelled-fixture mode: the false accept/reject rates are measured and shown to bite when the thresholds are loosened, and a fixture that cannot measure a rate is refused instead of reported as a perfect zero. Fails loudly (never skips) when Python is missing, because a skipped guard is no guard.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../..');
const EDGE_DIR = join(REPO_ROOT, 'scripts/comfyui-edge');
const JUDGE = join(EDGE_DIR, 'curation_judge.py');
const MAKE_CURATE = join(EDGE_DIR, 'make-curate.py');
const FIXTURE_PATH = join(EDGE_DIR, 'fixtures/curation-labels.json');
const RUN_TIMEOUT_MS = 60_000;

// A real 1x1 PNG, so the pool the judge walks is genuine image files and the review sheet renders.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface FixtureRow {
  id: string;
  label: 'keep' | 'reject';
  failure: string | null;
  measurements: Record<string, number>;
}

interface Fixture {
  thresholds: Record<string, number>;
  max_false_accept_rate: number;
  max_false_reject_rate: number;
  candidates: FixtureRow[];
}

/**
 * @description Locate a Python 3 interpreter; the box-side curation pipeline is Python because
 *   ComfyUI, kohya and CLIP are.
 * @returns The executable name that answered `--version`.
 */
function python(): string {
  for (const candidate of ['python3', 'python']) {
    const r = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (r.status === 0 && /Python 3/.test(`${r.stdout}${r.stderr}`)) return candidate;
  }
  throw new Error('python3 is required for the LoRA curation-judge guard and was not found on PATH');
}

/**
 * @description Run one of the real box scripts and return its exit status and streams.
 * @param script - Absolute path of the script to run.
 * @param args - Arguments for it.
 * @returns status, stdout and stderr.
 */
function run(script: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(python(), [script, ...args], { encoding: 'utf8', timeout: RUN_TIMEOUT_MS });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * @description Read the entry names out of a zip archive with the Python standard library, so the
 *   assertion inspects the shipped artefact rather than a record of what was meant to be written.
 * @param zipPath - Archive to list.
 * @returns Sorted entry names.
 */
function zipNames(zipPath: string): string[] {
  const r = spawnSync(python(), [
    '-c',
    'import json,sys,zipfile;print(json.dumps(sorted(zipfile.ZipFile(sys.argv[1]).namelist())))',
    zipPath,
  ], { encoding: 'utf8', timeout: RUN_TIMEOUT_MS });
  if (r.status !== 0) throw new Error(`could not list ${zipPath}: ${r.stderr}`);
  return JSON.parse(r.stdout) as string[];
}

/**
 * @description Read the committed labelled fixture.
 * @returns The parsed fixture.
 */
function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
}

/**
 * @description Materialise a candidate pool on disk from the labelled fixture: one real PNG and one
 *   caption sidecar per row, plus the measurements sidecar the judge scores them from.
 * @param extraPairsWithoutMeasurements - Ids written to the pool but deliberately left unmeasured.
 * @returns The working directories and the fixture that shaped them.
 */
function buildPool(extraPairsWithoutMeasurements: string[] = []): {
  work: string; pool: string; dest: string; zipPath: string; measurements: string; fixture: Fixture;
} {
  const fixture = loadFixture();
  const work = mkdtempSync(join(tmpdir(), 'lora-curation-'));
  const pool = join(work, 'pool');
  const dest = join(work, 'curated');
  mkdirSync(pool, { recursive: true });
  const measurements: Record<string, Record<string, number>> = {};
  for (const row of fixture.candidates) {
    writeFileSync(join(pool, `${row.id}.png`), PNG_1X1);
    writeFileSync(join(pool, `${row.id}.txt`), `oshbrainrot, ${row.id.replace(/_/g, ' ')}\n`);
    measurements[row.id] = row.measurements;
  }
  for (const id of extraPairsWithoutMeasurements) {
    writeFileSync(join(pool, `${id}.png`), PNG_1X1);
    writeFileSync(join(pool, `${id}.txt`), 'oshbrainrot, unmeasured candidate\n');
  }
  const measurementsPath = join(work, 'measurements.json');
  writeFileSync(measurementsPath, JSON.stringify(measurements, null, 2));
  return { work, pool, dest, zipPath: join(work, 'curated.zip'), measurements: measurementsPath, fixture };
}

/**
 * @description Invoke the real make-curate.py against a prepared pool.
 * @param ctx - buildPool() output.
 * @param extra - Additional arguments (overrides, thresholds).
 * @returns The process result.
 */
function curate(ctx: ReturnType<typeof buildPool>, extra: string[] = []) {
  return run(MAKE_CURATE, [
    '--source', ctx.pool,
    '--dest', ctx.dest,
    '--zip', ctx.zipPath,
    '--sheet', join(ctx.work, 'curated-sheet.png'),
    '--rejected-sheet', join(ctx.work, 'rejected-sheet.png'),
    '--target', '200',
    '--pattern', '*.png',
    '--fallback-pattern', '',
    '--measurements', ctx.measurements,
    ...extra,
  ]);
}

describe('LoRA automated curation judge', () => {
  it('measures false accept and false reject rates against the labelled fixture', () => {
    const r = run(JUDGE, ['--evaluate-fixture', FIXTURE_PATH]);
    expect(r.stderr).toBe('');
    const report = JSON.parse(r.stdout) as Record<string, unknown>;
    const fixture = loadFixture();
    expect(report.labelled_keeps).toBe(fixture.candidates.filter((c) => c.label === 'keep').length);
    expect(report.labelled_rejects).toBe(fixture.candidates.filter((c) => c.label === 'reject').length);
    expect(report.labelled_keeps as number).toBeGreaterThan(0);
    expect(report.labelled_rejects as number).toBeGreaterThan(0);
    expect(report.false_accepts).toEqual([]);
    expect(report.false_rejects).toEqual([]);
    expect(report.false_accept_rate).toBe(0);
    expect(report.false_reject_rate).toBe(0);
    expect(report.breached).toEqual([]);
    expect(r.status).toBe(0);
  }, RUN_TIMEOUT_MS);

  it('reports a rising false-accept rate and fails when the thresholds are loosened', () => {
    const work = mkdtempSync(join(tmpdir(), 'lora-curation-thresholds-'));
    const loose = join(work, 'loose.json');
    writeFileSync(loose, JSON.stringify({
      min_identity: 0.0, min_quality: 0.0, min_caption_agreement: 0.0,
      max_two_eye_margin: 1.0, max_multi_character_margin: 1.0,
    }));
    const r = run(JUDGE, ['--evaluate-fixture', FIXTURE_PATH, '--thresholds', loose]);
    const report = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(report.false_accept_rate).toBe(1);
    expect(report.breached).toContain('false_accept_rate');
    expect(r.status).toBe(1);
  }, RUN_TIMEOUT_MS);

  it('refuses a fixture that cannot measure a rate instead of reporting a perfect zero', () => {
    const work = mkdtempSync(join(tmpdir(), 'lora-curation-vacuous-'));
    const fixture = loadFixture();
    const keepsOnly = join(work, 'keeps-only.json');
    writeFileSync(keepsOnly, JSON.stringify({
      ...fixture,
      candidates: fixture.candidates.filter((c) => c.label === 'keep'),
    }));
    const r = run(JUDGE, ['--evaluate-fixture', keepsOnly]);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('cannot measure a rate');
  }, RUN_TIMEOUT_MS);

  it('keeps rejected candidates out of curated.zip, the artefact the trainer consumes', () => {
    const ctx = buildPool();
    // A reject left behind by a previous run must not survive into this training set either.
    mkdirSync(ctx.dest, { recursive: true });
    writeFileSync(join(ctx.dest, 'stale_reject_from_last_run.png'), PNG_1X1);
    writeFileSync(join(ctx.dest, 'stale_reject_from_last_run.txt'), 'stale\n');

    const r = curate(ctx);
    expect(r.status).toBe(0);
    expect(existsSync(ctx.zipPath)).toBe(true);

    const names = zipNames(ctx.zipPath);
    const onDisk = readdirSync(ctx.dest);
    for (const row of ctx.fixture.candidates) {
      const png = `${row.id}.png`;
      const txt = `${row.id}.txt`;
      if (row.label === 'reject') {
        expect(names, `${row.id} (${row.failure}) reached curated.zip`).not.toContain(png);
        expect(names).not.toContain(txt);
        expect(onDisk).not.toContain(png);
      } else {
        expect(names, `${row.id} was dropped from curated.zip`).toContain(png);
        expect(names).toContain(txt);
        expect(onDisk).toContain(png);
      }
    }
    expect(names).not.toContain('stale_reject_from_last_run.png');
    expect(names).not.toContain('curation.json');

    const report = JSON.parse(readFileSync(join(ctx.dest, 'curation.json'), 'utf8'));
    expect(report.summary.kept).toBe(ctx.fixture.candidates.filter((c) => c.label === 'keep').length);
    expect(report.summary.rejected).toBe(ctx.fixture.candidates.filter((c) => c.label === 'reject').length);
    expect(report.summary.overridden).toBe(0);
    expect(Object.keys(report.summary.reject_reasons)).toContain('structural-identity-violation');
  }, RUN_TIMEOUT_MS);

  it('rejects an unmeasured candidate rather than admitting it', () => {
    const ctx = buildPool(['pool_never_measured']);
    const r = curate(ctx);
    expect(r.status).toBe(0);
    expect(zipNames(ctx.zipPath)).not.toContain('pool_never_measured.png');
    const report = JSON.parse(readFileSync(join(ctx.dest, 'curation.json'), 'utf8'));
    const row = report.candidates.find((c: { id: string }) => c.id === 'pool_never_measured');
    expect(row.decision).toBe('reject');
    expect(row.reasons[0]).toMatch(/^unmeasured:/);
  }, RUN_TIMEOUT_MS);

  it('lets a human override the judge in both directions and records what it replaced', () => {
    const ctx = buildPool();
    const reinstated = ctx.fixture.candidates.find((c) => c.label === 'reject')!.id;
    const pulled = ctx.fixture.candidates.find((c) => c.label === 'keep')!.id;
    const overrides = join(ctx.work, 'overrides.json');
    writeFileSync(overrides, JSON.stringify({
      [reinstated]: { decision: 'keep', note: 'operator reinstated after reviewing the sheet' },
      [pulled]: { decision: 'reject', note: 'near-duplicate of another frame' },
    }));

    const r = curate(ctx, ['--overrides', overrides]);
    expect(r.status).toBe(0);
    const names = zipNames(ctx.zipPath);
    expect(names).toContain(`${reinstated}.png`);
    expect(names).toContain(`${reinstated}.txt`);
    expect(names).not.toContain(`${pulled}.png`);

    const report = JSON.parse(readFileSync(join(ctx.dest, 'curation.json'), 'utf8'));
    const reinstatedRow = report.candidates.find((c: { id: string }) => c.id === reinstated);
    expect(reinstatedRow.judge_decision).toBe('reject');
    expect(reinstatedRow.decision).toBe('keep');
    expect(reinstatedRow.override).toBe(true);
    expect(reinstatedRow.override_note).toContain('operator reinstated');
    const pulledRow = report.candidates.find((c: { id: string }) => c.id === pulled);
    expect(pulledRow.judge_decision).toBe('keep');
    expect(pulledRow.decision).toBe('reject');
    expect(report.summary.overridden).toBe(2);
  }, RUN_TIMEOUT_MS);
});
