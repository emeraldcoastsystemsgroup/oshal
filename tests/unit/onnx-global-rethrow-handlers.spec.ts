/**
 * Guard for the ONNX runtime's process-global rethrow handlers.
 *
 * onnxruntime-web's Emscripten Node shell appends two listeners the moment its wasm
 * initialises — `process.on('unhandledRejection', t => { throw t })` and
 * `process.on('uncaughtException', t => { if (!(t instanceof ExitStatus)) throw t })`.
 * They land BEHIND installProcessCrashGuards, so from that instant any unhandled
 * rejection anywhere in the controller is rethrown from inside the rejection handler,
 * becomes an uncaught exception, is rethrown again, and kills the process — measured
 * at exit code 7 with ~548 KB of minified bundle on stderr, before the crash guards'
 * 250 ms log flush ever runs. Dockerfile.oshal shims onnxruntime-node to
 * onnxruntime-web on musl, so the deployed api carries those listeners as soon as the
 * local embedding model loads.
 *
 * These cases cross the boundary that broke: the real onnxruntime package, a real
 * wasm initialisation, real crash guards and a real stray rejection in a real child
 * process. Nothing about the handler registry is mocked — a mocked registry cannot
 * fail the way the process did.
 *
 * The no-strip control is deliberate and load-bearing. If it ever goes green the
 * defect is gone from the dependency and this guard has become vacuous; that must
 * fail loudly rather than pass quietly.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — regression guard for the process-global rethrow handlers the ONNX wasm runtime installs: the real-library shape pin, the classifier's refusal to touch oshal's own crash guards, the three-way host child (no runtime / runtime unstripped / runtime stripped), the wiring pin on local-embedding-service, and the in-image case that runs the real load() against the Dockerfile's onnxruntime-node -> onnxruntime-web shim.
 */
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { isRethrowListener } from '@/features/rag/services/onnx-process-guards';
import { installProcessCrashGuards, resetProcessCrashGuardsForTest } from '@/shared/services/process-crash-guards';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CHILD = path.join('tests', 'fixtures', 'onnx-rethrow-child.ts');
const IMAGE_PROBE = path.join(REPO_ROOT, 'tests', 'fixtures', 'onnx-image-probe.ts');
const ORT_WEB_NODE_BUNDLE = path.join(REPO_ROOT, 'node_modules', 'onnxruntime-web', 'dist', 'ort-web.node.js');
const EMBEDDING_SERVICE = path.join(REPO_ROOT, 'src', 'features', 'rag', 'services', 'local-embedding-service.ts');
const IMAGE = 'oshal-bot:latest';
/** The api dies in well under this; a hang is a failure, not a pass. */
const CHILD_TIMEOUT_MS = 180_000;
const IMAGE_TIMEOUT_MS = 600_000;

interface ChildRun {
  status: number | null;
  stderrBytes: number;
  stderrHead: string;
  probes: Record<string, any>;
}

/**
 * @description Runs the child fixture under tsx and parses its JSON probe lines.
 * @param env - Extra environment for the child (the ONNX_CHILD_* switches).
 * @param timeoutMs - Hard cap so a wedged child fails instead of hanging the suite.
 * @returns Exit status, stderr volume, and the probe lines keyed by stage.
 */
function runChild(env: Record<string, string>, timeoutMs = CHILD_TIMEOUT_MS): ChildRun {
  const childEnv = { ...process.env, ...env };
  // vitest's own NODE_OPTIONS must not leak into a plain tsx child.
  delete childEnv.NODE_OPTIONS;
  delete childEnv.NODE_TEST_CONTEXT;
  // node + tsx's own CLI entry, never `npx` through a shell: Node refuses to spawn a
  // .cmd without shell:true, and shell:true with an args array is deprecated and a
  // Windows quoting hazard.
  const run = spawnSync(process.execPath, [require.resolve('tsx/cli'), CHILD], {
    cwd: REPO_ROOT,
    env: childEnv,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const stderr = run.stderr || '';
  const probes: Record<string, any> = {};
  for (const line of (run.stdout || '').split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.probe) probes[parsed.probe] = parsed;
    } catch {
      // Non-probe stdout (the pino logger's own output) is not an error.
    }
  }
  return { status: run.status, stderrBytes: Buffer.byteLength(stderr), stderrHead: stderr.slice(0, 400), probes };
}

describe('onnxruntime-web still installs process-global rethrow listeners', () => {
  it('registers both handlers in the installed bundle, in the rethrow shape', () => {
    const bundle = readFileSync(ORT_WEB_NODE_BUNDLE, 'utf8');
    const registrations = [
      /process\.on\("unhandledRejection",\((function\([\w$]+\)\{[^}]*\})\)\)/,
      /process\.on\("uncaughtException",\((function\([\w$]+\)\{.{0,80}?throw [\w$]+\})\)\)/,
    ];
    for (const pattern of registrations) {
      const match = pattern.exec(bundle);
      expect(match, `onnxruntime-web no longer matches ${pattern} — re-derive this guard before relaxing it`).not.toBeNull();
      // Materialise the library's own listener text and put it through the classifier
      // the fix relies on: a shape change in the dependency must fail here, loudly.
      // eslint-disable-next-line no-new-func
      const listener = new Function(`return (${match![1]})`)() as Function;
      expect(isRethrowListener(listener)).toBe(true);
    }
  });

  it('never classifies the api\'s own crash guards as rethrow listeners', () => {
    const beforeRejection = new Set(process.listeners('unhandledRejection'));
    const beforeException = new Set(process.listeners('uncaughtException'));
    resetProcessCrashGuardsForTest();
    installProcessCrashGuards('onnx-guard-spec');
    const added = [
      ...process.listeners('unhandledRejection').filter((fn) => !beforeRejection.has(fn)),
      ...process.listeners('uncaughtException').filter((fn) => !beforeException.has(fn)),
    ];
    try {
      expect(added).toHaveLength(2);
      for (const listener of added) {
        expect(isRethrowListener(listener)).toBe(false);
      }
    } finally {
      for (const listener of process.listeners('unhandledRejection')) {
        if (!beforeRejection.has(listener)) process.removeListener('unhandledRejection', listener);
      }
      for (const listener of process.listeners('uncaughtException')) {
        if (!beforeException.has(listener)) process.removeListener('uncaughtException', listener);
      }
      resetProcessCrashGuardsForTest();
    }
  });
});

describe('a stray rejection in a process that loaded the ONNX wasm runtime', () => {
  it('is survivable when the runtime was never initialised (isolation control)', () => {
    const run = runChild({ ONNX_CHILD_INIT: '0', ONNX_CHILD_STRIP: '0' });
    expect(run.status, run.stderrHead).toBe(0);
    expect(run.probes.survived).toBeDefined();
    expect(run.probes['after-init'].counts).toEqual(run.probes.baseline.counts);
  }, CHILD_TIMEOUT_MS);

  it('is FATAL once the runtime is initialised and nothing strips its listeners', () => {
    const run = runChild({ ONNX_CHILD_INIT: '1', ONNX_CHILD_STRIP: '0' });
    // The registration itself — two listeners appear behind the api's own guards.
    expect(run.probes['after-init'].counts.unhandledRejection).toBe(run.probes.baseline.counts.unhandledRejection + 1);
    expect(run.probes['after-init'].counts.uncaughtException).toBe(run.probes.baseline.counts.uncaughtException + 1);
    // And the consequence: the process is gone before it can report 'survived'.
    // Node exits 7 when a handler throws from inside the uncaughtException handler.
    expect(run.status, 'onnxruntime-web no longer kills the process — this guard is now vacuous and must be re-derived').not.toBe(0);
    expect(run.probes.survived).toBeUndefined();
  }, CHILD_TIMEOUT_MS);

  it('is survivable again after stripRethrowGuards, with the api\'s own guards intact', () => {
    const run = runChild({ ONNX_CHILD_INIT: '1', ONNX_CHILD_STRIP: '1' });
    expect(run.status, run.stderrHead).toBe(0);
    expect(run.probes.survived).toBeDefined();
    expect(run.probes['after-strip'].stripped.removed).toEqual({ unhandledRejection: 1, uncaughtException: 1 });
    // Nothing else was touched: no listener outside the rethrow shape was removed.
    expect(run.probes['after-strip'].stripped.kept).toEqual({ unhandledRejection: 0, uncaughtException: 0 });
    // The api's own crash guards are still installed and still the only listeners.
    expect(run.probes['after-strip'].counts).toEqual(run.probes.baseline.counts);
    expect(run.probes.survived.counts).toEqual(run.probes.baseline.counts);
    // The 548 KB minified-bundle dump is gone with the crash.
    expect(run.stderrBytes).toBeLessThan(8 * 1024);
  }, CHILD_TIMEOUT_MS);
});

describe('local-embedding-service wiring', () => {
  it('snapshots before the dynamic import and strips on every exit from load()', () => {
    const source = readFileSync(EMBEDDING_SERVICE, 'utf8');
    const snapshotAt = source.indexOf('snapshotProcessGuards()');
    const importAt = source.indexOf('import("@xenova/transformers")');
    expect(snapshotAt).toBeGreaterThan(-1);
    expect(importAt).toBeGreaterThan(-1);
    // A snapshot taken after the import would already contain the hijacked listeners
    // and the strip would remove nothing.
    expect(snapshotAt).toBeLessThan(importAt);
    // `finally`, not just the success path: a failing InferenceSession.create arms
    // the listeners too.
    expect(source).toMatch(/}\s*finally\s*{[\s\S]*stripRethrowGuards\(guards\)/);
  });
});

/**
 * @description True when this host can run the built api image — the image case is
 * where the defect is actually created (Dockerfile.oshal shims onnxruntime-node to
 * onnxruntime-web on musl), so it must run on any box that has the artifact.
 * @returns Whether docker answers and oshal-bot:latest exists locally.
 */
function imageAvailable(): boolean {
  const run = spawnSync('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], { encoding: 'utf8', timeout: 60_000 });
  return run.status === 0;
}

/** @returns Whether the compose workspace volume (which caches the model) exists. */
function modelCacheVolume(): string | null {
  const name = 'oshal-local_oshal_workspace';
  const run = spawnSync('docker', ['volume', 'inspect', name], { encoding: 'utf8', timeout: 60_000 });
  return run.status === 0 ? name : null;
}

describe.skipIf(!imageAvailable())(`the real load() inside ${IMAGE} (requires the built image)`, () => {
  /**
   * @description Runs the in-image probe, optionally mounting this working tree's
   * fixed sources over the image's own copies so the same container can be run with
   * and without the fix.
   * @param withFix - Mount the working tree's onnx-process-guards + local-embedding-service.
   * @returns The parsed probe output.
   */
  function runImageProbe(withFix: boolean): ChildRun {
    const cacheVolume = modelCacheVolume();
    const args = ['run', '--rm', '--memory=1500m'];
    if (withFix) {
      for (const rel of ['onnx-process-guards.ts', 'local-embedding-service.ts']) {
        const host = path.join(REPO_ROOT, 'src', 'features', 'rag', 'services', rel).replace(/\\/g, '/');
        args.push('-v', `${host}:/app/src/features/rag/services/${rel}:ro`);
      }
    }
    args.push('-v', `${IMAGE_PROBE.replace(/\\/g, '/')}:/app/onnx-image-probe.ts:ro`);
    if (cacheVolume) args.push('-v', `${cacheVolume}:/cache-src:ro`);
    args.push('-e', 'TRANSFORMERS_CACHE=/cache', '-e', 'NODE_ENV=test', '--entrypoint', 'sh', IMAGE, '-c',
      'mkdir -p /cache && cp -r /cache-src/.transformers-cache/. /cache/ 2>/dev/null; '
      + 'cd /app && npx tsx --tsconfig tsconfig.server.json onnx-image-probe.ts');
    const run = spawnSync('docker', args, { encoding: 'utf8', timeout: IMAGE_TIMEOUT_MS });
    const probes: Record<string, any> = {};
    for (const line of (run.stdout || '').split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.probe) probes[parsed.probe] = parsed;
      } catch {
        // Non-probe stdout is not an error.
      }
    }
    const stderr = run.stderr || '';
    return { status: run.status, stderrBytes: Buffer.byteLength(stderr), stderrHead: stderr.slice(0, 400), probes };
  }

  it('without the fix: the shimmed runtime adds the pair and the stray rejection is fatal', () => {
    const run = runImageProbe(false);
    expect(run.probes.baseline.shim, 'the Dockerfile shim is what creates this defect').toContain('require("onnxruntime-web")');
    expect(run.probes['after-load'].counts.unhandledRejection).toBe(run.probes.baseline.counts.unhandledRejection + 1);
    expect(run.probes['after-load'].counts.uncaughtException).toBe(run.probes.baseline.counts.uncaughtException + 1);
    expect(run.probes['after-load'].dims, 'inference itself was never the defect').toBe(384);
    expect(run.status, 'the image no longer reproduces the defect — re-derive this guard').not.toBe(0);
    expect(run.probes.survived).toBeUndefined();
  }, IMAGE_TIMEOUT_MS);

  it('with the fix: listener counts return to pre-load and embed() still returns 384 dims', () => {
    const run = runImageProbe(true);
    expect(run.status, run.stderrHead).toBe(0);
    expect(run.probes['after-load'].counts).toEqual(run.probes.baseline.counts);
    expect(run.probes['after-load'].rows).toBe(1);
    expect(run.probes['after-load'].dims).toBe(384);
    expect(run.probes.survived.counts).toEqual(run.probes.baseline.counts);
  }, IMAGE_TIMEOUT_MS);
});
