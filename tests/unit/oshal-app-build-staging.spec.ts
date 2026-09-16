/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | `oshal-app.js build` stages a package's TypeScript inside the framework checkout so the kernel's tsc can compile it against the @/ type graph. It used to copy those sources FLAT into src/app/routes/ and delete them in a `finally` — which a kill, an OOM or a closed terminal never reaches: on 2026-09-09 seventeen package sources sat untracked in the kernel's src/app/routes/ after such a build. These cases run the real CLI against a real throwaway framework checkout and hash every file under src/app before and after: a build killed mid-compile leaves src/app byte-identical, its one survivor is the src/__oshal_build_* staging directory, and check-repo-separation.js refuses that survivor by name. The compiler is real TypeScript in the success case; the kill and compiler-failure cases stand it in (a real tsc cannot be paused at a chosen moment, and the compiler is outside the boundary these two claim).
 */
import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.cwd();
const cli = join(root, 'scripts/oshal-app.js');
const guard = join(root, 'scripts/check-repo-separation.js');
const realTsc = join(root, 'node_modules/typescript/bin/tsc');

/** @description The staging directory prefix `oshal-app.js build` uses under the framework's src/. */
const STAGING_PREFIX = '__oshal_build_';

/**
 * @description Write a fixture file, creating parent directories as needed.
 * @param path - Absolute file path.
 * @param body - File contents.
 * @returns void
 */
function put(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

/**
 * @description sha256 every file under a directory, keyed by its path relative to that directory.
 * Byte-level, so a re-copied file with identical content is indistinguishable from an untouched
 * one — which is exactly the claim ("byte-identical to its pre-build state").
 * @param dir - Directory to hash.
 * @param base - Internal recursion base (relative prefix).
 * @returns Map of relative path to sha256 hex digest.
 */
function hashTree(dir: string, base = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(full).isDirectory()) Object.assign(out, hashTree(full, rel));
    else out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
  }
  return out;
}

/** @description Staging directories left under a framework checkout's src/. */
function stagingDirs(fw: string): string[] {
  return readdirSync(join(fw, 'src')).filter((name) => name.startsWith(STAGING_PREFIX)).sort();
}

interface Fixture {
  temp: string;
  fw: string;
  pkg: string;
  marker: string;
}

/**
 * @description Build a throwaway framework checkout (tsconfig with the @/ paths, a seeded src/app
 * tree, a src/shared module the package imports) plus a one-route package to compile against it.
 * The framework's node_modules/typescript/bin/tsc is a stand-in whose behaviour is chosen per run
 * by OSHAL_TEST_TSC_MODE: `real` executes the installed TypeScript compiler, `hang` records what
 * was staged and blocks so the run can be killed at a known point, `fail` exits non-zero.
 * @returns The fixture paths.
 */
function fixture(): Fixture {
  const temp = mkdtempSync(join(tmpdir(), 'oshal-build-staging-'));
  const fw = join(temp, 'framework');
  const pkg = join(temp, 'sports-edge');
  const marker = join(temp, 'compiler-started.json');

  put(join(fw, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'CommonJS',
      moduleResolution: 'Node',
      rootDir: './src',
      outDir: './dist',
      baseUrl: '.',
      paths: { '@/shared/*': ['src/shared/*'], '@/app/*': ['src/app/*'] },
      types: [],
      strict: true,
      skipLibCheck: true,
    },
    include: ['src/**/*.ts'],
    exclude: ['node_modules', 'dist'],
  }, null, 2)}\n`);
  put(join(fw, 'src/app/server.ts'), 'export const server = true;\n');
  put(join(fw, 'src/app/routes/health-routes.ts'), 'export const health = true;\n');
  put(join(fw, 'src/app/routes/inline-bot-execution.ts'), 'export const inlineBot = true;\n');
  put(join(fw, 'src/app/extensions/swarm/boot.ts'), 'export const boot = true;\n');
  put(join(fw, 'src/shared/thing.ts'), "export const thing = 'kernel-thing';\n");

  put(join(fw, 'node_modules/typescript/bin/tsc'), [
    "'use strict';",
    'const fs = require("fs");',
    'const path = require("path");',
    'const mode = process.env.OSHAL_TEST_TSC_MODE;',
    'if (mode === "fail") { process.stderr.write("stand-in compiler failure\\n"); process.exit(9); }',
    'if (mode === "hang") {',
    '  const src = path.join(process.cwd(), "src");',
    '  fs.writeFileSync(process.env.OSHAL_TEST_MARKER, JSON.stringify({',
    '    staged: fs.readdirSync(src).filter((n) => n.startsWith("__oshal_")),',
    '    routes: fs.readdirSync(path.join(src, "app", "routes")),',
    '  }));',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);',
    '  process.exit(0);',
    '}',
    'require(process.env.OSHAL_TEST_REAL_TSC);',
    '',
  ].join('\n'));

  put(join(pkg, 'oshal-app.yaml'), [
    'name: sports-edge',
    'version: 0.1.0',
    'suite: ai-productivity',
    'routes:',
    '  - module: routes/sports-routes.js',
    '    factory: createSportsRoutes',
    '    mountPath: /api/sports',
    '',
  ].join('\n'));
  put(join(pkg, 'src-routes/sports-routes.ts'), [
    "import { thing } from '@/shared/thing';",
    '',
    'export function createSportsRoutes(): string {',
    '  return thing;',
    '}',
    '',
  ].join('\n'));

  return { temp, fw, pkg, marker };
}

/**
 * @description The environment a build run needs: the compiler mode, the marker path and the real
 * compiler the `real` mode delegates to.
 * @param mode - Stand-in compiler behaviour.
 * @param marker - Path the `hang` mode writes when the compiler starts.
 * @returns Environment for the child process.
 */
function buildEnv(mode: string, marker: string): NodeJS.ProcessEnv {
  return { ...process.env, OSHAL_TEST_TSC_MODE: mode, OSHAL_TEST_MARKER: marker, OSHAL_TEST_REAL_TSC: resolve(realTsc) };
}

/**
 * @description Kill a process and everything it spawned. The compiler runs as a grandchild of the
 * test, so signalling the CLI alone would leave it running — the same distinction the ci-purge
 * watchdog had to make.
 * @param pid - Child process id.
 * @returns void
 */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group is already gone (the CLI exited before the kill landed) — the run is over either way.
    process.kill(pid, 'SIGKILL');
  }
}

describe('oshal-app build: a package build never writes into the kernel src/app tree', () => {
  it('compiles a package with its sources staged outside src/app/, leaving src/app byte-identical', () => {
    const f = fixture();
    try {
      const before = hashTree(join(f.fw, 'src/app'));
      const run = spawnSync(process.execPath, [cli, 'build', f.pkg, '--framework', f.fw], {
        encoding: 'utf8', windowsHide: true, timeout: 120000, env: buildEnv('real', f.marker),
      });
      expect(`${run.stdout}${run.stderr}`).toContain('built 1 route module');
      expect(run.status).toBe(0);

      const emitted = readFileSync(join(f.pkg, 'routes/sports-routes.js'), 'utf8');
      expect(emitted).toContain('createSportsRoutes');
      // The @/ alias still resolves from the new staging depth, and is PRESERVED in the emit
      // (ManifestRouteMounter resolves it at runtime — no tsc-alias in this build).
      expect(emitted).toContain('@/shared/thing');

      expect(hashTree(join(f.fw, 'src/app'))).toEqual(before);
      expect(stagingDirs(f.fw)).toEqual([]);
    } finally {
      rmSync(f.temp, { recursive: true, force: true });
    }
  }, 180000);

  it('leaves src/app byte-identical when the build is killed mid-compile, and the survivor is the staging directory the separation gate refuses', async () => {
    const f = fixture();
    const before = hashTree(join(f.fw, 'src/app'));
    const child = spawn(process.execPath, [cli, 'build', f.pkg, '--framework', f.fw], {
      stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32', env: buildEnv('hang', f.marker),
    });
    const exited = new Promise((accept) => child.once('exit', accept));
    try {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !existsSync(f.marker)) {
        await new Promise((accept) => setTimeout(accept, 20));
      }
      expect(existsSync(f.marker)).toBe(true);
      const observed = JSON.parse(readFileSync(f.marker, 'utf8')) as { staged: string[]; routes: string[] };
      // What the compiler saw at the moment it ran: the package source is staged under src/, and
      // the kernel's route directory holds only the kernel's own files.
      expect(observed.staged).toHaveLength(1);
      expect(observed.staged[0].startsWith(STAGING_PREFIX)).toBe(true);
      expect(observed.routes.sort()).toEqual(['health-routes.ts', 'inline-bot-execution.ts']);

      killTree(child.pid!);
      await exited;
      expect(child.exitCode).not.toBe(0);

      expect(hashTree(join(f.fw, 'src/app'))).toEqual(before);
      const survivors = stagingDirs(f.fw);
      expect(survivors).toHaveLength(1);
      expect(readdirSync(join(f.fw, 'src', survivors[0]))).toEqual(['sports-routes.ts']);

      // The residue a killed build can leave is exactly the shape the separation gate refuses, so
      // it is caught by the gate rather than by a person reading `git status`.
      const gate = spawnSync(process.execPath, [guard, '--core', f.fw], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
      expect(`${gate.stdout}${gate.stderr}`).toContain('package-build staging director');
      expect(`${gate.stdout}${gate.stderr}`).toContain(`src/${survivors[0]}/`);
      expect(gate.status).toBe(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) killTree(child.pid!);
      rmSync(f.temp, { recursive: true, force: true });
    }
  }, 120000);

  it('clears the staging directory when the compiler fails, leaving src/app byte-identical', () => {
    const f = fixture();
    try {
      const before = hashTree(join(f.fw, 'src/app'));
      const run = spawnSync(process.execPath, [cli, 'build', f.pkg, '--framework', f.fw], {
        encoding: 'utf8', windowsHide: true, timeout: 60000, env: buildEnv('fail', f.marker),
      });
      expect(run.status).toBe(1);
      expect(`${run.stdout}${run.stderr}`).toContain('build failed');
      expect(hashTree(join(f.fw, 'src/app'))).toEqual(before);
      expect(stagingDirs(f.fw)).toEqual([]);
    } finally {
      rmSync(f.temp, { recursive: true, force: true });
    }
  }, 60000);

  it('refuses a framework checkout with no src/ rather than creating one', () => {
    const f = fixture();
    try {
      rmSync(join(f.fw, 'src'), { recursive: true, force: true });
      const run = spawnSync(process.execPath, [cli, 'build', f.pkg, '--framework', f.fw], {
        encoding: 'utf8', windowsHide: true, timeout: 60000, env: buildEnv('real', f.marker),
      });
      expect(run.status).toBe(1);
      expect(`${run.stdout}${run.stderr}`).toContain('no src/');
      expect(existsSync(join(f.fw, 'src'))).toBe(false);
    } finally {
      rmSync(f.temp, { recursive: true, force: true });
    }
  }, 60000);
});

// The real companion for the two stand-in-compiler cases is the first case above, which runs the
// installed TypeScript compiler through the same CLI path (docs/governance/real-boundary-regression-audit.md).
