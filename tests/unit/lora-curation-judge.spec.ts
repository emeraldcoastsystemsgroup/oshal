/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary guard for the LoRA automated curation judge. Runs the REAL scripts/comfyui-edge/make-curate.py over a real pool of image/caption pairs and inspects the artefact train-lora.py actually consumes - curated.zip - so "rejected candidates do not enter the training set" is proved at the training-set boundary rather than at the decision function. Also drives curation_judge.py's labelled-fixture mode: the false accept/reject rates are measured and shown to bite when the thresholds are loosened, and a fixture that cannot measure a rate is refused instead of reported as a perfect zero. Fails loudly (never skips) when Python is missing, because a skipped guard is no guard.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Pin that curating INTO the candidate pool refuses. curate() empties --dest first, and this change made --dest operator-supplied beside an independent --source, so --source X --dest X wiped the pool - measured on this fixture: 36 files to 0, then a traceback.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Cover the AUTONOMOUS improve path, which had no judge at all. make-targeted-batch.recurate() zipped an even-sample straight into curated.zip, and overnight-loop.py trains on that exact path - so the judge was a make-curate-only feature and every unattended improve round trained on unjudged renders, rejects included. Two cases, both asserting on curated.zip rather than on the decision function, because the defect was in what got WRITTEN: every fixture reject stays out of the training set the loop consumes, and an unmeasurable run refuses instead of writing one.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Drive the improve path through a resolved character configuration instead of poking module-level DATA/DEST globals, which no longer exist: the pool, curated set and glob are now that character's own. Every assertion is unchanged - the same fixture verdicts, against the same curated.zip the loop trains on - and the pool is named for a character that is not the one the scripts used to hard-code, so the glob has to follow the character to pass.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Cover the TRAINER, where the training set is actually assembled and where no case reached. Every case above asserts on curated.zip, but the LoRA Studio dispatch passes a FOLDER (~/overnight/curated) to both /train and /improve-overnight and never the zip. train-lora.prepare_dataset copied that folder wholesale into the kohya image directory, ignoring the curation.json lying in it, so a rejected pair present in the folder trained anyway and the judge's own report became a training file. Three cases drive the REAL prepare_dataset and assert on the kohya staging directory: survivors only from a judged folder, a refusal for an unjudged one that destroys nothing, and the human override staging it deliberately.
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
// Deliberately NOT the character these scripts used to hard-code: the pool glob, the captions and
// the curated set all have to follow whichever character is being curated.
const SUBJECT = 'fixture-character';

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

  it('the AUTONOMOUS improve path judges too, so overnight training never sees a reject', () => {
    // make-targeted-batch.recurate() used to zip an even-sample straight into curated.zip with no
    // judgement at all, which made the judge a make-curate-only feature. overnight-loop.py runs
    // make-targeted-batch and then trains on ~/overnight/curated.zip - the exact path recurate
    // overwrites - so every autonomous improve round trained on unjudged renders while the manual
    // path rejected them. Even sampling is DIVERSITY, never judgement.
    //
    // Asserted on curated.zip, the artefact train-lora.py consumes, not on the decision function:
    // the defect lived in what got written, not in how a candidate was scored.
    const fixture = loadFixture();
    const work = mkdtempSync(join(tmpdir(), 'lora-improve-'));
    const pool = join(work, 'img');
    mkdirSync(pool, { recursive: true });

    // recurate() globs <subject>_*.png out of the character's own pool, so the pool is built under
    // the name the REAL code looks for for THIS character; the fixture stays the source of truth
    // for the verdicts and the measurements.
    const measurements: Record<string, Record<string, number>> = {};
    for (const row of fixture.candidates) {
      const id = `${SUBJECT}_${row.id}`;
      writeFileSync(join(pool, `${id}.png`), PNG_1X1);
      writeFileSync(join(pool, `${id}.txt`), `${SUBJECT}, ${row.id.replace(/_/g, ' ')}\n`);
      measurements[id] = row.measurements;
    }
    const measurementsPath = join(work, 'measurements.json');
    writeFileSync(measurementsPath, JSON.stringify(measurements, null, 2));

    const driver = [
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("mtb", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'cfg = m.character_config(m.argparse.Namespace(character=sys.argv[2], box_root=sys.argv[3]))',
      'print(json.dumps({"kept": m.recurate(cfg, measurements_path=sys.argv[4])}))',
    ].join('\n');
    const r = spawnSync(
      python(),
      ['-c', driver, join(EDGE_DIR, 'make-targeted-batch.py'), SUBJECT, work, measurementsPath],
      { encoding: 'utf8', timeout: RUN_TIMEOUT_MS },
    );
    expect(r.status, `recurate failed: ${r.stderr}`).toBe(0);

    const zipPath = join(work, 'curated.zip');
    expect(existsSync(zipPath), 'the improve path wrote no training set at all').toBe(true);
    const names = zipNames(zipPath);

    for (const row of fixture.candidates) {
      const png = `${SUBJECT}_${row.id}.png`;
      if (row.label === 'reject') {
        expect(names, `${row.id} (${row.failure}) reached the training set the overnight loop trains on`)
          .not.toContain(png);
      } else {
        expect(names, `${row.id} was dropped from the training set`).toContain(png);
      }
    }
    // recurate() logs to stdout as well, so take the last line, which is the driver's JSON.
    const lines = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const kept = JSON.parse(lines[lines.length - 1] || '{}').kept as number;
    expect(kept).toBe(fixture.candidates.filter((c) => c.label === 'keep').length);
  }, RUN_TIMEOUT_MS);

  it('the improve path REFUSES rather than writing an unjudged training set', () => {
    // Fail-closed, matching curation_judge's own stance. If the run cannot be measured, a stopped
    // loop beats a loop that trains on whatever it rendered - overnight-loop.py reads the non-zero
    // exit as "targeted batch failed; stopping".
    const work = mkdtempSync(join(tmpdir(), 'lora-improve-closed-'));
    const pool = join(work, 'img');
    mkdirSync(pool, { recursive: true });
    writeFileSync(join(pool, `${SUBJECT}_unmeasured.png`), PNG_1X1);
    writeFileSync(join(pool, `${SUBJECT}_unmeasured.txt`), `${SUBJECT}, unmeasured\n`);

    const driver = [
      'import importlib.util, sys',
      'spec = importlib.util.spec_from_file_location("mtb", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'm.INP = sys.argv[3]',  // no hero in either search directory, so it cannot measure
      'm.OUT = sys.argv[3]',
      'cfg = m.character_config(m.argparse.Namespace(character=sys.argv[2], box_root=sys.argv[3]))',
      'm.recurate(cfg)',
    ].join('\n');
    const r = spawnSync(
      python(),
      ['-c', driver, join(EDGE_DIR, 'make-targeted-batch.py'), SUBJECT, work],
      { encoding: 'utf8', timeout: RUN_TIMEOUT_MS },
    );
    expect(r.status, 'an unmeasurable run must not exit 0').not.toBe(0);
    expect(r.stderr).toMatch(/REFUSING to recurate unjudged/);
    expect(existsSync(join(work, 'curated.zip')), 'it wrote a training set anyway').toBe(false);
  }, RUN_TIMEOUT_MS);

  it('refuses to curate INTO the candidate pool instead of deleting it', () => {
    // curate() empties --dest before it copies. --dest became operator-supplied alongside an
    // independent --source, so pointing both at the pool wiped it: measured on this fixture, all 36
    // files gone, then a traceback - a night of GPU output destroyed on the way to a crash.
    const ctx = buildPool();
    const before = readdirSync(ctx.pool).length;
    expect(before).toBeGreaterThan(0);

    const r = run(MAKE_CURATE, [
      '--source', ctx.pool, '--dest', ctx.pool, '--zip', ctx.zipPath,
      '--sheet', join(ctx.work, 'curated-sheet.png'),
      '--rejected-sheet', join(ctx.work, 'rejected-sheet.png'),
      '--target', '200', '--pattern', '*.png', '--fallback-pattern', '',
      '--measurements', ctx.measurements,
    ]);

    expect(r.status, 'curating into the pool must refuse, not proceed').not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('REFUSING');
    // The pool is intact: the refusal comes BEFORE anything is emptied.
    expect(readdirSync(ctx.pool).length, 'the candidate pool was destroyed').toBe(before);
    expect(existsSync(ctx.zipPath)).toBe(false);
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

// ---------------------------------------------------------------------------------------------
// The TRAINER. Everything above asserts on curated.zip; the LoRA Studio dispatch never sends the
// zip. lora-train-dispatch passes `$env:USERPROFILE/overnight/curated` - a FOLDER - as --dataset to
// both the /train and the /improve-overnight commands, and train-lora.py staged that folder into
// kohya's image directory file by file with no reference to the curation.json sitting in it.
// ---------------------------------------------------------------------------------------------

/**
 * @description Drive the REAL train-lora.py prepare_dataset() with its kohya staging root pointed
 *   at a scratch directory, so the assertion inspects the directory kohya is handed rather than a
 *   decision function. The script is loaded by path because its filename is hyphenated.
 * @param datasetDir - The --dataset folder to stage.
 * @param workRoot - Scratch replacement for train-lora.WORK.
 * @param allowUnjudged - Whether to pass the human override.
 * @returns The process result plus the parsed JSON summary when it staged.
 */
function stageDataset(datasetDir: string, workRoot: string, allowUnjudged = false): {
  status: number; stdout: string; stderr: string; summary?: { img_root: string; n: number; state: string };
} {
  const driver = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("trainlora", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'm.WORK = sys.argv[3]',
    'allow = sys.argv[4] == "1"',
    'try:',
    '    root, img_root, n, state = m.prepare_dataset(sys.argv[2], "oshbrainrot", 1, "oshbrainrot", allow)',
    'except m.DatasetRefused as exc:',
    '    print("DATASET_REFUSED " + str(exc)); sys.exit(3)',
    'print(json.dumps({"root": root, "img_root": img_root, "n": n, "state": state}))',
  ].join('\n');
  const r = spawnSync(
    python(),
    ['-c', driver, join(EDGE_DIR, 'train-lora.py'), datasetDir, workRoot, allowUnjudged ? '1' : '0'],
    { encoding: 'utf8', timeout: RUN_TIMEOUT_MS },
  );
  if (r.error) throw r.error;
  const stdout = r.stdout ?? '';
  const lines = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  return {
    status: r.status ?? -1,
    stdout,
    stderr: r.stderr ?? '',
    summary: last.startsWith('{') ? JSON.parse(last) : undefined,
  };
}

describe('the trainer stages only what the curation judge approved', () => {
  it('leaves a reject in the dataset FOLDER out of the kohya training directory', () => {
    // Build a real judged folder with the real make-curate.py, then put a rejected pair back into
    // it - which is all it takes, because nothing re-judges the folder at training time and the
    // dispatch points --dataset straight at it.
    const ctx = buildPool();
    expect(curate(ctx).status).toBe(0);

    const restored = ctx.fixture.candidates.find((c) => c.label === 'reject')!;
    for (const ext of ['png', 'txt']) {
      writeFileSync(join(ctx.dest, `${restored.id}.${ext}`),
        readFileSync(join(ctx.pool, `${restored.id}.${ext}`)));
    }
    expect(readdirSync(ctx.dest), 'the reject was not actually put back')
      .toContain(`${restored.id}.png`);
    expect(readdirSync(ctx.dest), 'the judge left no report to read').toContain('curation.json');

    const staged = stageDataset(ctx.dest, join(ctx.work, 'lora-train'));
    expect(staged.status, `prepare_dataset failed: ${staged.stderr}`).toBe(0);
    const imgRoot = staged.summary!.img_root;
    const trainingFiles = readdirSync(imgRoot);

    expect(trainingFiles, `${restored.id} (${restored.failure}) reached the kohya training directory`)
      .not.toContain(`${restored.id}.png`);
    expect(trainingFiles).not.toContain(`${restored.id}.txt`);
    expect(trainingFiles, "the judge's own report became a training file").not.toContain('curation.json');
    for (const row of ctx.fixture.candidates.filter((c) => c.label === 'keep')) {
      expect(trainingFiles, `${row.id} was dropped from the training directory`).toContain(`${row.id}.png`);
      expect(trainingFiles).toContain(`${row.id}.txt`);
    }
    const keeps = ctx.fixture.candidates.filter((c) => c.label === 'keep').length;
    expect(staged.summary!.n, 'the reported image count must match what was staged').toBe(keeps);
    expect(staged.summary!.state).toBe('judged');
  }, RUN_TIMEOUT_MS);

  it('REFUSES an unjudged dataset folder, and the refusal destroys nothing', () => {
    // Fail-closed, matching curation_judge: a folder nobody judged is every render the box made.
    const work = mkdtempSync(join(tmpdir(), 'lora-train-unjudged-'));
    const dataset = join(work, 'unjudged');
    mkdirSync(dataset, { recursive: true });
    for (const id of ['oshbrainrot_a', 'oshbrainrot_b']) {
      writeFileSync(join(dataset, `${id}.png`), PNG_1X1);
      writeFileSync(join(dataset, `${id}.txt`), 'oshbrainrot, never judged\n');
    }
    // A previous version's staging directory must survive a refusal.
    const workRoot = join(work, 'lora-train');
    const priorRoot = join(workRoot, 'oshbrainrot_v1');
    mkdirSync(priorRoot, { recursive: true });
    writeFileSync(join(priorRoot, 'previous-run.txt'), 'kept\n');

    const staged = stageDataset(dataset, workRoot);
    expect(staged.status, 'an unjudged dataset must not be staged').toBe(3);
    expect(`${staged.stdout}${staged.stderr}`).toContain('REFUSING to train on an unjudged dataset');
    expect(`${staged.stdout}${staged.stderr}`).toContain('curation.json');
    expect(existsSync(join(priorRoot, 'previous-run.txt')),
      'the refusal wiped the previous staging directory').toBe(true);
    expect(existsSync(join(priorRoot, 'img')), 'it staged into the run it refused').toBe(false);
  }, RUN_TIMEOUT_MS);

  it('lets the human override the refusal and records that the run was unjudged', () => {
    const work = mkdtempSync(join(tmpdir(), 'lora-train-override-'));
    const dataset = join(work, 'unjudged');
    mkdirSync(dataset, { recursive: true });
    writeFileSync(join(dataset, 'oshbrainrot_a.png'), PNG_1X1);
    writeFileSync(join(dataset, 'oshbrainrot_a.txt'), 'oshbrainrot, never judged\n');

    const staged = stageDataset(dataset, join(work, 'lora-train'), true);
    expect(staged.status, `the override must stage: ${staged.stderr}`).toBe(0);
    expect(readdirSync(staged.summary!.img_root)).toContain('oshbrainrot_a.png');
    expect(staged.summary!.state, 'an unjudged run must be visible in the metrics afterwards')
      .toBe('unjudged-override');
  }, RUN_TIMEOUT_MS);
});
