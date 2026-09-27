/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary guard for LoRA per-character generalization. The box scripts carried the first character the studio ever trained as constants - its trigger word, identity sentence, anatomy guard, dataset globs and one shared dataset folder per box - so a second character could not be trained without editing them and would have consumed and overwritten the first one's data on the way. Every case here drives the REAL scripts in scripts/comfyui-edge for a character that is NOT that one, and asserts on what actually leaves them: the curated.zip the trainer consumes, the ComfyUI workflow payload the validator submits, and the argv the overnight loop spawns its nested steps with.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | The overnight loop signs its review callback with the dispatch's callback grant (OSHAL_LORA_CALLBACK_GRANT) instead of the fleet secret. Prove the grant reaches nested steps only through the environment (never their argv), and drive the real loop's final callback against a loopback listener: vendor media type, grant headers, a signature that verifies under an independent recomputation of the store verifier's contract, and no fleet secret even when one is in the environment.
 */

import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { createHash, createHmac } from 'crypto';
import { createServer } from 'http';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { execFileSync } from 'child_process';

const REPO_ROOT = resolve(__dirname, '../..');
const EDGE_DIR = join(REPO_ROOT, 'scripts/comfyui-edge');
const RUN_TIMEOUT_MS = 60_000;
const GRANT_ID = '0d0d0d0d-1111-4222-8333-444444444444';
const GRANT_SECRET = 'Z'.repeat(43);
const GRANT_TOKEN = `${GRANT_ID}.${GRANT_SECRET}`;

/** A real 1x1 PNG, so every pool the scripts walk is genuine image files. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Two characters that are both unlike the one the scripts used to hard-code. */
const MINE = {
  subject: 'tin-drummer',
  trigger: 'tindrummer',
  hero: 'hero_tin_drummer.png',
  ident: 'a bright tin wind-up drummer toy with two round glass eyes and a red drum',
  negative: 'blurry, lowres, rusted, missing drum',
  identityStructure: 'a wind-up toy with a drum strapped to its chest',
  identityViolation: 'a toy with no drum at all',
};
const THEIRS = { subject: 'other-character', trigger: 'othertrigger' };

/** Measurements that clear every DEFAULT_THRESHOLDS bar, so a discovered pair is kept. */
const KEEPABLE = {
  identity: 0.95,
  quality: 0.9,
  caption_agreement: 0.9,
  two_eye_margin: -0.2,
  multi_character_margin: -0.2,
};

/**
 * @description Locate a Python 3 interpreter; the box-side LoRA pipeline is Python because
 *   ComfyUI, kohya and CLIP are. Fails loudly rather than skipping - a skipped guard is no guard.
 * @returns The executable name that answered `--version`.
 */
function python(): string {
  for (const candidate of ['python3', 'python']) {
    const r = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (r.status === 0 && /Python 3/.test(`${r.stdout}${r.stderr}`)) return candidate;
  }
  throw new Error('python3 is required for the LoRA per-character guard and was not found on PATH');
}

/**
 * @description Run a python driver over one of the REAL box scripts.
 * @param lines - Driver source lines.
 * @param args - Arguments after the interpreter's -c program.
 * @returns status, stdout and stderr.
 */
function drive(lines: string[], args: string[], env: NodeJS.ProcessEnv = process.env): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(python(), ['-c', lines.join('\n'), ...args], {
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    env,
  });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * @description Recompute a captured callback's signature from the grant secret, independently of the
 *   box helper, using the contract the controller verifies: HMAC-SHA256 keyed by SHA-256 of
 *   "oshal-lora-callback-grant-v1:" + secret over METHOD|target|timestamp|nonce|sha256(body).
 * @param secret - The grant secret half.
 * @param method - HTTP method as received.
 * @param target - Request target as received (path and query).
 * @param headers - Received headers.
 * @param body - Received body bytes.
 * @returns The expected hex signature.
 */
function expectedSignature(secret: string, method: string, target: string,
  headers: Record<string, string | string[] | undefined>, body: Buffer): string {
  const key = createHash('sha256').update(`oshal-lora-callback-grant-v1:${secret}`).digest();
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', key)
    .update(`${method}|${target}|${headers['x-lora-callback-timestamp']}|${headers['x-lora-callback-nonce']}|${bodyHash}`)
    .digest('hex');
}

/** Parse the last JSON line a driver printed (the scripts log to stdout as well). */
function lastJson<T>(stdout: string): T {
  const lines = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return JSON.parse(lines[lines.length - 1] || '{}') as T;
}

/** Names inside a zip, read with python's own zipfile so no JS zip dependency is needed. */
function zipNames(zipPath: string): string[] {
  const out = execFileSync(python(), [
    '-c',
    'import json,sys,zipfile;print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))',
    zipPath,
  ], { encoding: 'utf8' });
  return JSON.parse(out) as string[];
}

/**
 * @description Build a box tree holding TWO characters' pools, each under its own root, and the
 *   measurements file that would let either of them be curated.
 * @returns The work directory, each character's root, and the measurements path.
 */
function twoCharacterBox(): { work: string; mineRoot: string; theirsRoot: string; measurements: string } {
  const work = mkdtempSync(join(tmpdir(), 'lora-per-character-'));
  const mineRoot = join(work, MINE.subject);
  const theirsRoot = join(work, THEIRS.subject);
  const measurements: Record<string, Record<string, number>> = {};
  for (const [root, character] of [[mineRoot, MINE], [theirsRoot, THEIRS]] as const) {
    const pool = join(root, 'img');
    mkdirSync(pool, { recursive: true });
    for (let i = 0; i < 3; i += 1) {
      const id = `${character.subject}_t${String(i).padStart(4, '0')}`;
      writeFileSync(join(pool, `${id}.png`), PNG_1X1);
      writeFileSync(join(pool, `${id}.txt`), `${character.trigger}, standing\n`);
      measurements[id] = KEEPABLE;
    }
  }
  const measurementsPath = join(work, 'measurements.json');
  writeFileSync(measurementsPath, JSON.stringify(measurements, null, 2));
  return { work, mineRoot, theirsRoot, measurements: measurementsPath };
}

describe('LoRA box scripts generalize to a newly created character', () => {
  it('curates only the named character\'s own pool into its own training set', () => {
    // The improve path used to glob one fixed character's file prefix out of one shared dataset
    // folder per box. A second character therefore trained on the first one's images, and its own
    // curated set landed on top of the first one's.
    const box = twoCharacterBox();
    const r = drive([
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("mtb", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'cfg = m.character_config(m.argparse.Namespace(character=sys.argv[2], box_root=sys.argv[3]))',
      'print(json.dumps({"kept": m.recurate(cfg, measurements_path=sys.argv[4])}))',
    ], [join(EDGE_DIR, 'make-targeted-batch.py'), MINE.subject, box.mineRoot, box.measurements]);

    expect(r.status, `recurate failed: ${r.stderr}`).toBe(0);
    expect(lastJson<{ kept: number }>(r.stdout).kept).toBe(3);

    const zipPath = join(box.mineRoot, 'curated.zip');
    expect(existsSync(zipPath), 'the improve path wrote no training set for this character').toBe(true);
    const names = zipNames(zipPath);
    for (let i = 0; i < 3; i += 1) {
      expect(names).toContain(`${MINE.subject}_t${String(i).padStart(4, '0')}.png`);
      expect(names, 'another character\'s image reached this character\'s training set')
        .not.toContain(`${THEIRS.subject}_t${String(i).padStart(4, '0')}.png`);
    }
    expect(existsSync(join(box.theirsRoot, 'curated.zip')),
      'curating one character overwrote another character\'s training set').toBe(false);
  }, RUN_TIMEOUT_MS);

  it('submits the character\'s own prompt, negative and checkpoint in the ComfyUI validation payload', () => {
    // The validator built every cell prompt from one character's identity sentence and sent one
    // character's negative prompt and checkpoint, whatever character it was told to validate.
    const r = drive([
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("val", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'args = json.loads(sys.argv[2])',
      'm.run = lambda wf: {"submitted": wf}',
      'cfg = m.character_config(m.argparse.Namespace(**args))',
      'wf = m.gen_cell(cfg, "lora.safetensors", cfg.prompt("standing, front view"), 500000, "val")["submitted"]',
      'print(json.dumps({"positive": wf["pos"]["inputs"]["text"], "negative": wf["neg"]["inputs"]["text"],'
      + ' "checkpoint": wf["ck"]["inputs"]["ckpt_name"]}))',
    ], [join(EDGE_DIR, 'validate-lora.py'), JSON.stringify({
      character: MINE.subject,
      trigger: MINE.trigger,
      ident: MINE.ident,
      negative: MINE.negative,
      base_model: 'my-own-checkpoint.safetensors',
    })]);

    expect(r.status, `validate driver failed: ${r.stderr}`).toBe(0);
    const payload = lastJson<{ positive: string; negative: string; checkpoint: string }>(r.stdout);
    expect(payload.positive).toContain(MINE.trigger);
    expect(payload.positive).toContain(MINE.ident);
    expect(payload.positive).toContain('standing, front view');
    expect(payload.negative).toBe(MINE.negative);
    expect(payload.checkpoint).toBe('my-own-checkpoint.safetensors');
  }, RUN_TIMEOUT_MS);

  it('probes the character\'s own anatomy, and probes none when it declares none', () => {
    // The structural guard was one character's anatomy. Every other character lost the margin on
    // every cell, which is a 45% quality penalty applied for being a different creature.
    const driver = [
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("val", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'class FakeClip:',
      '    ok = True',
      '    def txt_vec(self, text): return text',
      'cfg = m.character_config(m.argparse.Namespace(**json.loads(sys.argv[2])))',
      'print(json.dumps(m.structural_probe(cfg, FakeClip())))',
    ];

    const declared = drive(driver, [join(EDGE_DIR, 'validate-lora.py'), JSON.stringify({
      character: MINE.subject,
      identity_structure: MINE.identityStructure,
      identity_violation: MINE.identityViolation,
    })]);
    expect(declared.status, `probe driver failed: ${declared.stderr}`).toBe(0);
    expect(lastJson<{ ok: string; violation: string }>(declared.stdout)).toEqual({
      ok: MINE.identityStructure,
      violation: MINE.identityViolation,
    });

    const undeclared = drive(driver, [join(EDGE_DIR, 'validate-lora.py'),
      JSON.stringify({ character: THEIRS.subject })]);
    expect(undeclared.status, `probe driver failed: ${undeclared.stderr}`).toBe(0);
    expect(lastJson<unknown>(undeclared.stdout),
      'a character that declares no anatomy was probed against one anyway').toBeNull();
  }, RUN_TIMEOUT_MS);

  it('measures no structural violation for a character that declares no structural pair', () => {
    // Same defect one layer down, in the pre-training judge: the contrastive pair had a default,
    // so an undeclared character was measured against it and rejected as a violation.
    const r = drive([
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("judge", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'print(json.dumps(sorted(m.DEFAULT_STRUCTURAL_PROMPTS)))',
    ], [join(EDGE_DIR, 'curation_judge.py')]);

    expect(r.status, `judge driver failed: ${r.stderr}`).toBe(0);
    expect(lastJson<string[]>(r.stdout),
      'the judge still carries a default anatomy every character is measured against')
      .toEqual(['bad', 'good', 'multiple_characters', 'single_character']);
  }, RUN_TIMEOUT_MS);

  it('forwards the whole identity into every nested overnight step, not just the subject', () => {
    // The unattended loop passed --character alone, so each nested script fell back to its own
    // defaults and an overnight round regenerated, curated and validated the wrong character.
    const work = mkdtempSync(join(tmpdir(), 'lora-overnight-'));
    const r = drive([
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("loop", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'calls = []',
      'm.sh = lambda script, args: calls.append({"script": script, "args": args}) or 0',
      'm.scorecard = lambda cfg, version: {"overall": 0.5, "weak_cells": []}',
      'sys.argv = ["overnight-loop.py"] + json.loads(sys.argv[2])',
      'm.main()',
      'print(json.dumps(calls))',
    ], [join(EDGE_DIR, 'overnight-loop.py'), JSON.stringify([
      '--character', MINE.subject,
      '--trigger', MINE.trigger,
      '--hero', MINE.hero,
      '--ident', MINE.ident,
      '--negative', MINE.negative,
      '--identity-structure', MINE.identityStructure,
      '--identity-violation', MINE.identityViolation,
      '--box-root', work,
      '--start-version', '1',
      '--max-hours', '0.0001',
      '--controller', 'http://controller.test',
      '--owner-sub-b64', 'b3duZXItYQ',
    ])], { ...process.env, OSHAL_LORA_CALLBACK_GRANT: GRANT_TOKEN });

    expect(r.status, `overnight driver failed: ${r.stderr}`).toBe(0);
    const calls = lastJson<Array<{ script: string; args: string[] }>>(r.stdout);
    for (const call of calls) {
      expect(call.args.join(' '), `${call.script} received the callback grant in its argv`).not.toContain(GRANT_SECRET);
      if (call.script !== 'make-targeted-batch.py') expect(call.args).toContain('--controller');
    }
    const scripts = calls.map((c) => c.script);
    expect(scripts, 'the loop never reached the improve round').toContain('make-targeted-batch.py');
    expect(scripts).toContain('validate-lora.py');
    for (const call of calls) {
      if (call.script === 'train-lora.py') {
        expect(call.args, 'training was pointed at a dataset that is not this character\'s')
          .toContain(join(work, 'curated'));
        continue;
      }
      const argv = call.args.join(' ');
      for (const [flag, value] of [['--trigger', MINE.trigger], ['--hero', MINE.hero],
        ['--ident', MINE.ident], ['--negative', MINE.negative],
        ['--identity-structure', MINE.identityStructure],
        ['--identity-violation', MINE.identityViolation], ['--box-root', work]] as const) {
        expect(argv, `${call.script} was spawned without ${flag}, so it falls back to a default character`)
          .toContain(flag);
        expect(call.args, `${call.script} was spawned with the wrong value for ${flag}`).toContain(value);
      }
    }
  }, RUN_TIMEOUT_MS);

  it('returns the originating review ticket in the final owner-authenticated callback', () => {
    const work = mkdtempSync(join(tmpdir(), 'lora-review-ticket-'));
    const r = drive([
      'import importlib.util, json, sys, os',
      'spec = importlib.util.spec_from_file_location("loop", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'm.sh = lambda script, args: 0',
      'm.scorecard = lambda cfg, version: {"overall": 0.5, "weak_cells": []}',
      'm.post = lambda controller, grant, owner, payload: print(json.dumps(dict(payload, grant_id=grant[0])))',
      'os.environ["OSHAL_LORA_CALLBACK_GRANT"] = sys.argv[3]',
      'sys.argv = ["overnight-loop.py"] + json.loads(sys.argv[2])',
      'm.main()',
    ], [join(EDGE_DIR, 'overnight-loop.py'), JSON.stringify([
      '--character', MINE.subject,
      '--trigger', MINE.trigger,
      '--hero', MINE.hero,
      '--ident', MINE.ident,
      '--negative', MINE.negative,
      '--identity-structure', MINE.identityStructure,
      '--identity-violation', MINE.identityViolation,
      '--box-root', work,
      '--start-version', '1',
      '--max-hours', '0.0001',
      '--controller', 'http://controller.test',
      '--owner-sub-b64', 'owner-a',
      '--review-ticket-id', 'ticket-123',
    ]), GRANT_TOKEN]);

    expect(r.status, `overnight callback driver failed: ${r.stderr}`).toBe(0);
    expect(lastJson<{ ticket_id: string; grant_id: string }>(r.stdout)).toMatchObject({ ticket_id: 'ticket-123', grant_id: GRANT_ID });
  }, RUN_TIMEOUT_MS);

  it('signs the real final review callback with the grant and never sends the fleet secret', async () => {
    const received: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined>; body: Buffer }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const work = mkdtempSync(join(tmpdir(), 'lora-review-signed-'));
    const driver = [
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("loop", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'm.sh = lambda script, args: 0',
      'm.scorecard = lambda cfg, version: {"overall": 0.5, "weak_cells": []}',
      'sys.argv = ["overnight-loop.py"] + json.loads(sys.argv[2])',
      'm.main()',
    ].join('\n');
    // Asynchronous on purpose: the listener above lives in this process's event loop.
    const run = await new Promise<{ status: number; stderr: string }>((done, fail) => {
      const child = spawn(python(), ['-c', driver, join(EDGE_DIR, 'overnight-loop.py'), JSON.stringify([
        '--character', MINE.subject, '--box-root', work, '--start-version', '1', '--max-hours', '0.0001',
        '--controller', origin, '--owner-sub-b64', 'b3duZXItYQ', '--review-ticket-id', 'ticket-456',
      ])], { env: { ...process.env, OSHAL_LORA_CALLBACK_GRANT: GRANT_TOKEN, SWARM_SERVICE_SECRET: 'fleet-secret-in-env' } });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.once('error', fail);
      child.once('close', (code) => done({ status: code ?? -1, stderr }));
    });
    await new Promise<void>((done) => server.close(() => done()));
    expect(run.status, run.stderr).toBe(0);
    expect(received).toHaveLength(1);
    const [review] = received;
    expect(review.method).toBe('POST');
    expect(review.url).toBe('/api/lora/ingest');
    expect(review.headers['content-type']).toBe('application/vnd.oshal.lora-callback+json');
    expect(review.headers['x-service-secret']).toBeUndefined();
    expect(JSON.stringify(review.headers)).not.toContain('fleet-secret-in-env');
    expect(review.headers['x-lora-callback-grant']).toBe(GRANT_ID);
    expect(review.headers['x-lora-callback-owner']).toBe('b3duZXItYQ');
    expect(review.headers['x-lora-callback-signature'])
      .toBe(expectedSignature(GRANT_SECRET, review.method, review.url, review.headers, review.body));
    expect(JSON.parse(review.body.toString('utf8'))).toMatchObject({ kind: 'review', ticket_id: 'ticket-456', character: MINE.subject });
  }, RUN_TIMEOUT_MS);

  it('refuses to curate when no character and no pool were named', () => {
    // The manual curation tool used to default the pool, the hero and the glob to one character.
    // With that gone the only safe default is none: refuse rather than curate somebody else's data.
    const r = spawnSync(python(), [join(EDGE_DIR, 'make-curate.py')],
      { encoding: 'utf8', timeout: RUN_TIMEOUT_MS });
    expect(r.status, 'curating with no character and no source must refuse').not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('no pool to curate');
  }, RUN_TIMEOUT_MS);

  it('refuses a subject that would escape the character\'s own box directory', () => {
    // The subject became a directory name and a file stem the moment datasets were keyed per
    // character, so it is validated as a slug before anything is written.
    const r = drive([
      'import importlib.util, sys',
      'spec = importlib.util.spec_from_file_location("cc", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'm.character_config(m.os.path and __import__("argparse").Namespace(character=sys.argv[2]))',
    ], [join(EDGE_DIR, 'character_config.py'), '../../windows/system32']);
    expect(r.status, 'a traversing subject must refuse').not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('refusing character');
  }, RUN_TIMEOUT_MS);
});
