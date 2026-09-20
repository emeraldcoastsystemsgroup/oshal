/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise real Git archives, the store compiler and TypeScript; prove dishonest ambient types fail and dirty checkouts remain byte-identical. No compiler or filesystem doubles.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | The fixture's committed route is now a REAL compiled artifact and untouched-ness is proven by identity rather than by bytes. The store's rebuilder gained a canonical-parity check that refuses committed output not matching its TypeScript source, and the core runner invokes it with --check-only, so this file's deliberately-wrong placeholder made the whole run exit 1 before any claim here was reached - one case red in the sanctioned nightly. The obvious repair, hand-typing the compiler's output into the fixture, would have destroyed the property the placeholder existed for: once committed bytes equal emitted bytes, a byte comparison cannot tell 'left alone' from 'rewritten identically', and it would re-red on every TypeScript upgrade. Instead the store's own rebuilder runs once in write mode during setup (memoised across fixtures, so the file got FASTER), and both preservation cases snapshot sha256 + size + mtime and compare. Mutation-proven with a runner that rewrites the source route with IDENTICAL bytes: git status stays clean, sha and size are unchanged, and only the mtime catches it - both cases go red, which the byte assertion could not have done. The node_modules junction the rebuild needs is removed in a finally, and the removal is checked against the real compiler path afterwards; that removing a Windows junction leaves its target intact was measured on this platform, not assumed.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.cwd();
const runner = join(root, 'scripts/check-store-compatibility.mjs');

/**
 * The fixture package's committed route bytes, compiled ONCE by the store's own rebuilder.
 *
 * They used to be the literal `exports.original = true;\n` — chosen to differ from anything a
 * compile would emit, so that "the runner left the committed bytes alone" was provable. The store's
 * rebuilder then gained a canonical-parity check (`--check-only` refuses committed output that does
 * not match its TypeScript source), which the core runner invokes, so a deliberately-wrong
 * placeholder now makes the whole run exit 1 before any of this file's claims are reached.
 *
 * Hand-typing the compiler's output instead would destroy the very property the literal existed
 * for: once the committed bytes equal the emitted bytes, a byte comparison can no longer tell
 * "left alone" from "rewritten identically", and it would re-red on every TypeScript upgrade. So
 * the bytes come from a real compile and untouched-ness is proven by IDENTITY instead — see
 * `snapshot()`.
 */
let compiledRoute: string | undefined;

/** A file's content hash, size and modification time — enough to catch an identical rewrite. */
function snapshot(path: string): { sha: string; size: number; mtimeMs: number } {
  const stat = statSync(path);
  return { sha: createHash('sha256').update(readFileSync(path)).digest('hex'), size: stat.size, mtimeMs: stat.mtimeMs };
}

/**
 * @description Compile the fixture package's route with the store's OWN rebuilder in write mode, so
 * the committed artifact is real rather than asserted. Memoised: the inputs are fixed, so every
 * fixture in this file shares one compile.
 * @param core - Fixture framework checkout (supplies tsconfig and the ambient module).
 * @param store - Fixture store checkout (carries the rebuilder and the alpha package).
 * @returns The emitted `alpha/routes/main.js` text.
 */
function buildRoute(core: string, store: string): string {
  if (compiledRoute !== undefined) return compiledRoute;
  // The rebuilder resolves tsc at `<framework>/node_modules/typescript/bin/tsc`, exactly as the
  // core runner's own `dependencies()` arranges by junctioning the provisioned modules in. Removing
  // a junction does not touch what it points at — measured on this platform before relying on it.
  const link = join(core, 'node_modules');
  symlinkSync(realpathSync(join(root, 'node_modules')), link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const result = spawnSync(process.execPath,
      [join(store, 'scripts/security/rebuild-store-routes.mjs'), '--store', store, '--framework', core],
      { cwd: core, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
    if (result.status !== 0) {
      throw new Error(`fixture route rebuild failed (${result.status}): ${result.stdout}${result.stderr}`);
    }
    compiledRoute = readFileSync(join(store, 'alpha/routes/main.js'), 'utf8');
    if (!compiledRoute.includes('createRoutes')) {
      throw new Error(`fixture route rebuild emitted nothing recognisable: ${compiledRoute.slice(0, 200)}`);
    }
    return compiledRoute;
  } finally {
    rmSync(link, { recursive: true, force: true });
    if (!existsSync(join(root, 'node_modules', 'typescript', 'bin', 'tsc'))) {
      throw new Error('removing the fixture node_modules junction reached the real one — stop and repair the checkout');
    }
  }
}

/** @description Write a test file, creating parents as needed. */
function put(path: string, body: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

/** @description Invoke real Git with isolated fixture identity and no hooks. */
function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', '-c', 'user.name=Compatibility Test',
    '-c', 'user.email=compatibility@example.invalid', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

/** @description Commit only the explicitly created fixture files in a disposable repository. */
function commit(repo: string) {
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'compatibility fixture');
  return git(repo, 'rev-parse', 'HEAD');
}

/** @description Construct small real repositories using the shipped store rebuild and installed TypeScript. */
function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'compatibility-test-'));
  const core = join(temp, 'core');
  const store = join(temp, 'store');
  mkdirSync(core); mkdirSync(store);
  git(core, 'init', '-q'); git(store, 'init', '-q');
  for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(root, file), join(core, file));
  put(join(core, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'commonjs', rootDir: 'src', baseUrl: '.', paths: { '@/*': ['src/*'] },
    strict: true, skipLibCheck: true, types: [],
  }, include: ['src/**/*.ts'] }));
  put(join(core, 'src/shared/workspace-root.ts'), 'export const workspaceRoot = "fixture";\n');
  const sourceStore = resolve(process.env.OSHAL_STORE_REPO ?? join(root, '..', 'oshal-applications'));
  for (const file of ['rebuild-store-routes.mjs', 'check-store-security.mjs']) {
    put(join(store, 'scripts/security', file), readFileSync(join(sourceStore, 'scripts/security', file), 'utf8'));
  }
  put(join(store, 'alpha/oshal-app.yaml'), 'name: alpha\nroutes:\n  - module: routes/main.js\n    factory: createRoutes\n    mountPath: /api/alpha\n    auth: oidc\n');
  put(join(store, 'alpha/src-routes/main.ts'), "import { workspaceRoot } from '@/shared/workspace-root';\nexport function createRoutes() { return workspaceRoot; }\n");
  // The committed artifact is what the store's own rebuilder emits for that source. Anything else
  // fails its canonical-parity check and the run never reaches this file's actual claims.
  put(join(store, 'alpha/routes/main.js'), buildRoute(core, store));
  const coreSha = commit(core), storeSha = commit(store);
  const reports = join(temp, 'reports');
  const args = [runner, '--core', core, '--store', store, '--dependencies', root, '--reports', reports];
  return { temp, core, store, reports, args, coreSha, storeSha };
}

/** @description Read the unique durable report generated by a fixture run. */
function report(reports: string) {
  const directory = join(reports, readdirSync(reports)[0]);
  return JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
}

describe('committed store compatibility', () => {
  it('compiles pinned exports, rejects an invented ambient export, and preserves dirty and untracked bytes', () => {
    const f = fixture();
    try {
      put(join(f.core, 'src/shared/workspace-root.ts'), 'uncommitted invalid core');
      put(join(f.store, 'alpha/src-routes/main.ts'), 'uncommitted invalid store');
      put(join(f.core, 'src/untracked.ts'), 'untracked core');
      put(join(f.store, 'alpha/src-routes/untracked.ts'), 'untracked store');
      const before = [git(f.core, 'status', '--porcelain'), git(f.store, 'status', '--porcelain')];
      // The committed route is now a real compiled artifact, so its BYTES no longer distinguish
      // "left alone" from "rewritten identically" — the identity does. A `--check-only` run must
      // never call syncOutputs, and a rewrite updates mtime even when the content is unchanged.
      const routeBefore = snapshot(join(f.store, 'alpha/routes/main.js'));
      const result = spawnSync(process.execPath, [...f.args, '--prove-rejection'], { encoding: 'utf8', windowsHide: true, timeout: 90000 });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const evidence = report(f.reports);
      expect(evidence.coreSha).toBe(f.coreSha); expect(evidence.storeSha).toBe(f.storeSha);
      expect(evidence.rejectionProof).toContain('TS2305');
      expect(evidence.cleaned).toBe(true); expect(existsSync(evidence.scratch)).toBe(false);
      expect(readFileSync(join(evidence.directory, 'rejection.log'), 'utf8')).toContain('inventedCompatibilityExport');
      expect([git(f.core, 'status', '--porcelain'), git(f.store, 'status', '--porcelain')]).toEqual(before);
      expect(readFileSync(join(f.core, 'src/shared/workspace-root.ts'), 'utf8')).toBe('uncommitted invalid core');
      expect(readFileSync(join(f.store, 'alpha/src-routes/main.ts'), 'utf8')).toBe('uncommitted invalid store');
      expect(readFileSync(join(f.core, 'src/untracked.ts'), 'utf8')).toBe('untracked core');
      expect(readFileSync(join(f.store, 'alpha/src-routes/untracked.ts'), 'utf8')).toBe('untracked store');
      expect(snapshot(join(f.store, 'alpha/routes/main.js')), 'the run rewrote a committed route module').toEqual(routeBefore);
      expect(existsSync(join(root, 'node_modules/typescript/bin/tsc'))).toBe(true);
    } finally { rmSync(f.temp, { recursive: true, force: true }); }
  }, 120000);

  it('fails a committed bad import with package-specific diagnostics and keeps both repos untouched', () => {
    const f = fixture();
    try {
      put(join(f.store, 'alpha/src-routes/main.ts'), "import { inventedCompatibilityExport } from '@/shared/workspace-root';\nexport function createRoutes() { return inventedCompatibilityExport; }\n");
      put(join(f.store, 'alpha/src-routes/core-modules.d.ts'), "declare module '@/shared/workspace-root' { export const inventedCompatibilityExport: number; }\n");
      commit(f.store);
      const result = spawnSync(process.execPath, f.args, { encoding: 'utf8', windowsHide: true, timeout: 90000 });
      expect(result.status).toBe(1);
      const evidence = report(f.reports);
      expect(evidence.status).toBe('failed'); expect(evidence.cleaned).toBe(true);
      expect(readFileSync(join(evidence.directory, 'compile.log'), 'utf8').replaceAll('\\', '/')).toMatch(/alpha\/main.ts.*TS2305/);
      expect(git(f.core, 'status', '--porcelain')).toBe(''); expect(git(f.store, 'status', '--porcelain')).toBe('');
      expect(existsSync(evidence.scratch)).toBe(false);
    } finally { rmSync(f.temp, { recursive: true, force: true }); }
  }, 120000);

  it('refuses dependency reuse when the pinned lock differs', () => {
    const f = fixture();
    try {
      put(join(f.core, 'package-lock.json'), '{}\n'); commit(f.core);
      const result = spawnSync(process.execPath, f.args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      expect(result.status).toBe(1);
      expect(report(f.reports).error).toContain('package-lock.json differs');
      expect(report(f.reports).cleaned).toBe(true);
    } finally { rmSync(f.temp, { recursive: true, force: true }); }
  }, 45000);

  it('keeps source repositories untouched when the compile process tree is forcibly interrupted', async () => {
    const f = fixture();
    // Taken before the child starts: a kill mid-compile must leave the committed
    // artifact byte-for-byte AND untouched — git status alone cannot see a rewrite
    // that put back identical content.
    const routeBefore = snapshot(join(f.store, 'alpha/routes/main.js'));
    let scratch: string | undefined;
    const child = spawn(process.execPath, f.args, { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
    const exited = new Promise((accept) => child.once('exit', accept));
    try {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (existsSync(f.reports) && readdirSync(f.reports).length) {
          const file = join(f.reports, readdirSync(f.reports)[0], 'result.json');
          if (existsSync(file)) {
            const evidence = report(f.reports);
            if (evidence.phase === 'compiling') { scratch = evidence.scratch; break; }
          }
        }
        await new Promise((accept) => setTimeout(accept, 20));
      }
      expect(scratch).toBeTruthy();
      // taskkill may report a missing parent after killing its compiler child: the parent's
      // error handling can exit before taskkill reaches it. The observed exit proves interruption.
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else process.kill(-child.pid!, 'SIGKILL');
      await exited;
      expect(child.exitCode).not.toBe(0);
      expect(git(f.core, 'status', '--porcelain')).toBe('');
      expect(git(f.store, 'status', '--porcelain')).toBe('');
      expect(snapshot(join(f.store, 'alpha/routes/main.js')), 'the run rewrote a committed route module').toEqual(routeBefore);
      expect(existsSync(join(root, 'node_modules/typescript/bin/tsc'))).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (scratch && existsSync(scratch)) {
        const link = join(scratch, 'core/node_modules');
        if (existsSync(link)) unlinkSync(link);
        rmSync(scratch, { recursive: true, force: true });
      }
      rmSync(f.temp, { recursive: true, force: true });
    }
  }, 30000);
});
