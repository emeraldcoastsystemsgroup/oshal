/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary guard for the validation thumbnails the GPU box copies to the controller. Runs the REAL scripts/comfyui-edge/validate-lora.py main() with ComfyUI and CLIP stubbed out, against a real loopback HTTP listener, and inspects the requests the LoRA Studio's ingest mount would actually receive - method, path, query, both guard headers, media type and body bytes. The defect being closed was that a scorecard cell carried only a box-local filename and so had no fetchable image at all, so the assertion has to be on what left the box, not on a helper in isolation. Fails loudly (never skips) when Python or Pillow is missing, since a skipped guard is no guard.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../..');
const VALIDATE = join(REPO_ROOT, 'scripts/comfyui-edge/validate-lora.py');
const RUN_TIMEOUT_MS = 180_000;
const SERVICE_SECRET = 'lora-thumbnail-guard-secret';
const OWNER_PLAINTEXT = 'owner-under-test';
const OWNER_SUB_B64 = Buffer.from(OWNER_PLAINTEXT, 'utf8').toString('base64url');

/** The bound the controller's ingest route enforces (lora/src-routes/lora-cell-images.ts). */
const CONTROLLER_MAX_CELL_IMAGE_BYTES = 256 * 1024;

/** The widest edge a hosted thumbnail may have; the studio renders these in a 120px grid. */
const MAX_THUMBNAIL_EDGE = 320;

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

interface DriverResult {
  cells: number;
  renderBytes: number;
}

/**
 * @description Locate a Python 3 interpreter. The box-side validator is Python because ComfyUI,
 *   kohya and CLIP are; there is no second implementation to test instead.
 * @returns The executable name that answered `--version`.
 */
function python(): string {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0 && /Python 3/.test(`${probe.stdout}${probe.stderr}`)) return candidate;
  }
  throw new Error('python3 is required for the LoRA cell-thumbnail guard and was not found on PATH');
}

/**
 * @description Read a JPEG's pixel dimensions out of its own start-of-frame marker, so "it was
 *   downscaled" is measured on the bytes that were transmitted rather than reported by the encoder.
 * @param body - The JPEG body exactly as received.
 * @returns `{ width, height }`.
 */
function jpegSize(body: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset + 9 < body.length) {
    if (body[offset] !== 0xff) { offset += 1; continue; }
    const marker = body[offset + 1];
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) return { height: body.readUInt16BE(offset + 5), width: body.readUInt16BE(offset + 7) };
    offset += 2 + body.readUInt16BE(offset + 2);
  }
  throw new Error('no JPEG start-of-frame marker in the posted body');
}

/**
 * @description The driver executed against the real validator module. It stubs only what this box
 *   genuinely cannot provide - the ComfyUI render call and the CLIP scorer - writes real noisy PNGs
 *   the size of a validation render, then calls the SHIPPING main(), so the callback wiring is part
 *   of what is under test rather than assumed.
 * @returns Python source for the driver.
 */
function driverSource(): string {
  return [
    'import importlib.util, json, os, sys',
    'validate_path, work, controller, owner = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]',
    'spec = importlib.util.spec_from_file_location("validate_lora_under_test", validate_path)',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'from PIL import Image',
    'module.OUT = work',
    'module.INP = work',
    'module.DEST = os.path.join(work, "validate-out")',
    'module.VAL_CELLS = module.VAL_CELLS[:2]',
    'renders = []',
    'def fake_gen_cell(lora_name, prompt, seed, prefix):',
    '    name = prefix + "_00001_.png"',
    '    noise = [Image.effect_noise((1024, 1024), 160) for _ in range(3)]',
    '    Image.merge("RGB", noise).save(os.path.join(work, name))',
    '    renders.append(name)',
    '    return {"save": {"images": [{"filename": name}]}}',
    'module.gen_cell = fake_gen_cell',
    'class OfflineClip:',
    '    def __init__(self):',
    '        self.ok = False',
    'module.Clip = OfflineClip',
    'sys.argv = ["validate-lora.py", "--character", "demo", "--version", "1",',
    '            "--lora-name", "demo.safetensors", "--controller", controller,',
    '            "--owner-sub-b64", owner]',
    'module.main()',
    'print(json.dumps({"cells": len(renders),',
    '                  "renderBytes": os.path.getsize(os.path.join(work, renders[0]))}))',
  ].join('\n');
}

describe('LoRA validation thumbnails reach the controller', () => {
  const captured: CapturedRequest[] = [];
  let server: Server;
  let origin = '';
  let result: DriverResult;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        captured.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers as Record<string, string | undefined>,
          body: Buffer.concat(chunks),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') return fail(new Error('missing listener address'));
        origin = `http://127.0.0.1:${address.port}`;
        done();
      });
    });

    const work = mkdtempSync(join(tmpdir(), 'lora-thumb-guard-'));
    const driver = join(work, 'drive_validate_lora.py');
    writeFileSync(driver, driverSource(), 'utf8');
    // Asynchronous on purpose: spawnSync blocks this process's event loop, so the listener above
    // would never accept the validator's connection and the guard would fail on its own harness.
    const run = await new Promise<{ status: number; stdout: string; stderr: string }>((done, fail) => {
      const child = spawn(python(), [driver, VALIDATE, work, origin, OWNER_SUB_B64], {
        timeout: RUN_TIMEOUT_MS,
        env: { ...process.env, SWARM_SERVICE_SECRET: SERVICE_SECRET },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.once('error', fail);
      child.once('close', (code) => done({ status: code ?? -1, stdout, stderr }));
    });
    if (run.status !== 0) {
      throw new Error(`the real validator failed (${run.status}): ${run.stderr || run.stdout}`);
    }
    const printed = (run.stdout || '').trim().split(/\r?\n/).filter((line) => line.startsWith('{')).pop();
    if (!printed) throw new Error(`the validator printed no driver result: ${run.stdout}${run.stderr}`);
    result = JSON.parse(printed) as DriverResult;
  }, RUN_TIMEOUT_MS);

  afterAll(async () => {
    if (server) await new Promise<void>((done) => server.close(() => done()));
  });

  /**
   * @description The cell-image callbacks this run produced, in the order the box sent them. It
   *   asserts there is at least one, because every case below iterates them and a loop over an
   *   empty list asserts nothing — which is precisely the state this change exists to end.
   * @returns The captured cell-image requests.
   */
  function cellImagePosts(): CapturedRequest[] {
    const posts = captured.filter((request) => request.url.startsWith('/api/lora/ingest/cell-image'));
    expect(posts.length).toBeGreaterThan(0);
    return posts;
  }

  it('posts the scorecard and then one thumbnail for every scored cell', () => {
    expect(result.cells).toBe(2);
    const scorecard = captured.filter((request) => request.url === '/api/lora/ingest');
    expect(scorecard).toHaveLength(1);
    expect(JSON.parse(scorecard[0].body.toString('utf8')).kind).toBe('score');
    const images = cellImagePosts();
    expect(images).toHaveLength(2);
    expect(captured.indexOf(scorecard[0])).toBeLessThan(captured.indexOf(images[0]));
    for (const [index, request] of images.entries()) {
      expect(request.method).toBe('POST');
      const url = new URL(request.url, origin);
      expect(url.pathname).toBe('/api/lora/ingest/cell-image');
      expect(url.searchParams.get('character')).toBe('demo');
      expect(url.searchParams.get('version')).toBe('1');
      expect(url.searchParams.get('cell')).toBe(String(index));
      expect(url.searchParams.get('filename')).toBe(`val_demo_v1_0${index}_00001_.png`);
    }
  });

  it('carries the fleet secret and the separately encoded owner, and neither in the URL', () => {
    for (const request of cellImagePosts()) {
      expect(request.headers['x-service-secret']).toBe(SERVICE_SECRET);
      expect(request.headers['x-oshal-user-sub-b64']).toBe(OWNER_SUB_B64);
      expect(request.url).not.toContain(SERVICE_SECRET);
      expect(request.url).not.toContain(OWNER_PLAINTEXT);
    }
  });

  it('sends real bounded JPEG bytes the controller route will accept', () => {
    for (const request of cellImagePosts()) {
      expect(request.headers['content-type']).toBe('image/jpeg');
      expect(request.body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
      expect(request.body.length).toBeGreaterThan(0);
      expect(request.body.length).toBeLessThanOrEqual(CONTROLLER_MAX_CELL_IMAGE_BYTES);
    }
  });

  it('shrinks the render rather than shipping it, so a matrix stays cheap to host', () => {
    for (const request of cellImagePosts()) {
      const size = jpegSize(request.body);
      expect(size.width).toBeLessThanOrEqual(MAX_THUMBNAIL_EDGE);
      expect(size.height).toBeLessThanOrEqual(MAX_THUMBNAIL_EDGE);
      expect(request.body.length).toBeLessThan(result.renderBytes);
    }
  });
});
