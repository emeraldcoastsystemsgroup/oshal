/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-115 guard: prove the repo-separation check both PASSES on this tree and goes RED on each way application code can walk back into the kernel. ADR-085 carved 21 app surfaces out of core and nothing has stopped one returning since; the public core trunk is app-free by construction, so a re-mixed app is a release defect found at publish time. Fixture checkouts (not this tree) exercise the failure paths, so the shared index is never touched.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export-shape guard: run the check from inside a .git-LESS fixture with NO --core flag — the exact ci-local --head GATE_SRC shape where the unconditional `git rev-parse --show-toplevel` (the second git dependence, missed by the 07-23 trackedFiles fix) crashed the gate on a healthy tree. Goes red if either git dependence returns.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Give each disk/subprocess-heavy separation case a local 30-second ceiling. Concurrent full-suite load can exhaust Vitest's 5-second default on Windows even when the guard is healthy; a suite-local helper keeps every mutation case active without weakening unrelated unit-test budgets.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | CORE-06 timeout containment: retain a 20-second exception only for the real-repository tree walk; tiny fixture mutations return to the global unit-test budget.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Package-build residue: the gate now judges UNTRACKED state too. A fixture may plant files AFTER its commit, and five cases pin the rule: an untracked file under src/app/routes/ (the shape seventeen sports-edge sources took there on 2026-09-09) is red; a gitignored one is not (it is not what `git add -A` stages); a surviving src/__oshal_store_parity_* (store compiler) or src/__oshal_build_* (`oshal-app.js build`) staging directory is red; a tracked route file stays green. Each red case failed against the previous gate before the change.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Two cases for check 4b, the cross-repo-import shape: a fixture file whose specifier leaves the repo is RED, and a deep relative import that stays inside it stays GREEN. The second is not padding - the first draft of the check reported every any-bot/server/app-modules file, because `git rev-parse` answers with forward slashes on Windows and the prefix comparison never matched. The escaping specifier is ASSEMBLED from parts rather than written out: the guard reads every tracked source line, so spelling it as a literal would make this very file the violation it tests for, which is the fixture-literal trap the publish gate has the same way.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../..');
const GUARD = join(REPO_ROOT, 'scripts/check-repo-separation.js');
const TREE_WALK_TIMEOUT_MS = 20_000;

/** The ten kernel-resident manifests a valid fixture must contain (ADR-085 completion). */
const KERNEL_MANIFESTS = [
  'codex-packer.yaml',
  'devops.yaml',
  'intelligent-operations.yaml',
  'intelligent-processing.yaml',
  'jarvis.yaml',
  'oshal-dev.yaml',
  'oshal-engineering.yaml',
  'person-model.yaml',
  'security.yaml',
  'workflow-studio.yaml',
];

interface GuardResult {
  code: number;
  output: string;
}

/**
 * @description Run the separation guard against a checkout and capture its verdict.
 * @param coreDir - Repository to check (omit for this repo).
 * @returns Exit code and combined output.
 */
function runGuard(coreDir?: string): GuardResult {
  const args = [GUARD, ...(coreDir ? ['--core', coreDir] : [])];
  try {
    const output = execFileSync('node', args, { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/**
 * @description Build a throwaway git checkout shaped like a compliant kernel repo.
 *
 * A real git repo is required because the guard reads `git ls-files` — tracked state is the thing
 * under test (an untracked stray file is not a repo-separation violation). Pass `git: false` to
 * build an EXPORT-shaped tree instead (no .git — the ci-local --head GATE_SRC shape, where disk
 * contents stand in for tracked state).
 *
 * The fixture carries one TRACKED route file under src/app/routes/ — the directory a package build
 * stages into — so every case also proves committed kernel routes are never mistaken for residue.
 *
 * @param mutate - Optional hook to plant a violation before the files are committed.
 * @param opts - `git: false` skips git init/commit to model a `git archive` export; `afterCommit`
 *   plants UNTRACKED state once the commit exists (the residue a killed build leaves behind).
 * @returns The fixture checkout path.
 */
function makeKernelFixture(
  mutate?: (dir: string) => void,
  opts: { git?: boolean; afterCommit?: (dir: string) => void } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-sep-'));
  mkdirSync(join(dir, 'swarm-apps'), { recursive: true });
  for (const name of KERNEL_MANIFESTS) {
    writeFileSync(join(dir, 'swarm-apps', name), `name: ${name.replace('.yaml', '')}\n`, 'utf8');
  }
  mkdirSync(join(dir, 'src/app/routes'), { recursive: true });
  writeFileSync(join(dir, 'src/app/routes/health-routes.ts'), 'export const health = true;\n', 'utf8');
  mutate?.(dir);
  if (opts.git === false) return dir;
  execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' });
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'fixture'],
    { stdio: 'pipe' },
  );
  opts.afterCommit?.(dir);
  return dir;
}

/**
 * @description Run a fixture assertion and always clean the temp checkout up.
 * @param mutate - Violation planter (runs before the fixture commit, so the plant is tracked).
 * @param assertion - What the guard should report.
 * @param afterCommit - Optional planter that runs after the commit, so the plant is untracked.
 * @returns void
 */
function withFixture(
  mutate: ((dir: string) => void) | undefined,
  assertion: (r: GuardResult) => void,
  afterCommit?: (dir: string) => void,
): void {
  const dir = makeKernelFixture(mutate, { afterCommit });
  try {
    assertion(runGuard(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The sibling checkout's directory name, assembled so this file never spells an escaping specifier. */
const STORE_REPO = ['oshal', 'applications'].join('-');

describe('repo separation (ADR-115): application code never mixes into the swarm repo', () => {
  it('passes on this repository', () => {
    const { code, output } = runGuard();
    expect(output).toContain('Repo separation holds');
    expect(code).toBe(0);
  }, TREE_WALK_TIMEOUT_MS);

  it('passes on a compliant kernel fixture (a TRACKED route file under src/app/routes/ is not residue)', () => {
    withFixture(undefined, ({ code, output }) => {
      expect(output).toContain('no untracked files under src/app/routes/');
      expect(code).toBe(0);
    });
  });

  it('FAILS on an untracked file under src/app/routes/ — the residue a killed `oshal-app.js build` leaves', () => {
    // `oshal-app.js build` copies <pkg>/src-routes/*.ts flat into the framework's src/app/routes/
    // and removes them in a `finally`. A kill never reaches the `finally`; on 2026-09-09 seventeen
    // such files (package-smoke.ts, sports-*.ts) sat untracked in core, invisible to every
    // tracked-path check and one `git add -A` away from landing application code in the kernel.
    withFixture(
      undefined,
      ({ code, output }) => {
        expect(output).toContain('untracked file(s) under src/app/routes/');
        expect(output).toContain('src/app/routes/package-smoke.ts');
        expect(output).toContain('src/app/routes/sports-routes.ts');
        expect(code).toBe(1);
      },
      (dir) => {
        writeFileSync(join(dir, 'src/app/routes/package-smoke.ts'), 'export const smoke = 1;\n', 'utf8');
        writeFileSync(join(dir, 'src/app/routes/sports-routes.ts'), 'export const sports = 1;\n', 'utf8');
      },
    );
  });

  it('passes when the only untracked file under src/app/routes/ is gitignored (not what `git add -A` stages)', () => {
    // The dev box keeps an editor workspace file there under a `*.code-workspace` ignore rule; the
    // gate judges the `git add -A` set, and an ignored file is not in it.
    withFixture(
      (dir) => writeFileSync(join(dir, '.gitignore'), '*.code-workspace\n', 'utf8'),
      ({ code, output }) => {
        expect(output).toContain('no untracked files under src/app/routes/');
        expect(code).toBe(0);
      },
      (dir) => writeFileSync(join(dir, 'src/app/routes/agentic.code-workspace'), '{}\n', 'utf8'),
    );
  });

  it('FAILS when a store-compiler staging directory survives under src/ (rebuild-store-routes.mjs shape)', () => {
    // The store's rebuild-store-routes.mjs stages every package under a mkdtemp of
    // src/__oshal_store_parity_ and removes it in a `finally` — the same kill hazard, one level up.
    withFixture(
      undefined,
      ({ code, output }) => {
        expect(output).toContain('package-build staging director');
        expect(output).toContain('src/__oshal_store_parity_k1ll3d/');
        expect(code).toBe(1);
      },
      (dir) => {
        mkdirSync(join(dir, 'src/__oshal_store_parity_k1ll3d/sports-edge'), { recursive: true });
        writeFileSync(
          join(dir, 'src/__oshal_store_parity_k1ll3d/sports-edge/sports-routes.ts'),
          'export const sports = 1;\n',
          'utf8',
        );
      },
    );
  });

  it('FAILS when an `oshal-app.js build` staging directory survives under src/ (the killed-build survivor)', () => {
    // `oshal-app.js build` now stages under a mkdtemp of src/__oshal_build_ instead of copying into
    // src/app/routes/: a killed build leaves kernel source untouched, and what it does leave is this
    // directory. The gate is what turns that survivor into a red run rather than a `git status` line.
    withFixture(
      undefined,
      ({ code, output }) => {
        expect(output).toContain('package-build staging director');
        expect(output).toContain('src/__oshal_build_k1ll3d/');
        expect(code).toBe(1);
      },
      (dir) => {
        mkdirSync(join(dir, 'src/__oshal_build_k1ll3d'), { recursive: true });
        writeFileSync(
          join(dir, 'src/__oshal_build_k1ll3d/sports-routes.ts'),
          'export const sports = 1;\n',
          'utf8',
        );
      },
    );
  });

  it('passes when run from inside a .git-less EXPORT with no --core (ci-local --head GATE_SRC shape)', () => {
    // The gate runs `cd $GATE_SRC && node scripts/check-repo-separation.js` against a `git archive`
    // export — no .git, no --core flag. That path crashed "fatal: not a git repository" twice: first
    // in trackedFiles() (fixed 07-23), then in the coreDir resolution the same fix missed. Running
    // the script with cwd INSIDE the export and no flags exercises both git dependences at once.
    const dir = makeKernelFixture(undefined, { git: false });
    try {
      let result: GuardResult;
      try {
        const output = execFileSync('node', [GUARD], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
        result = { code: 0, output };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        result = { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
      }
      expect(result.output).not.toContain('not a git repository');
      expect(result.output).toContain('Repo separation holds');
      expect(result.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FAILS when a kernel file imports ACROSS the repo boundary into a sibling checkout', () => {
    // The mirror image of every other shape here: not application code carried inside the kernel,
    // but kernel code reaching out of it. A core spec really did import a store package's route
    // module through `../../../oshal-applications/...`. It resolved on a developer box with the
    // sibling beside it, and could never resolve in the sanctioned gate, which builds from a `git
    // archive` export with no sibling anywhere near it — so the file collapsed at import and
    // counted red in the nightly for as long as it stood.
    // The escaping specifier is ASSEMBLED rather than written out. The guard reads every tracked
    // source line, so spelling it here as a plain `from '...'` literal would make this very file
    // the violation it is testing for — the fixture-literal trap the publish gate has the same
    // way. Assembling it also means the guard has to resolve the path, not merely match the text.
    const escaping = ['..', '..', '..', STORE_REPO, 'some-package', 'src-routes', 'routes'].join('/');
    withFixture(
      (dir) => {
        mkdirSync(join(dir, 'tests/unit'), { recursive: true });
        writeFileSync(
          join(dir, 'tests/unit/reaches-out.spec.ts'),
          `import { handler } from '${escaping}';\nexport default handler;\n`,
          'utf8',
        );
      },
      ({ code, output }) => {
        expect(output).toContain('kernel file(s) importing across the repository boundary');
        expect(output).toContain('tests/unit/reaches-out.spec.ts:1');
        expect(output).toContain(escaping);
        expect(code).toBe(1);
      },
    );
  });

  it('passes a deep relative import that stays INSIDE the repo (the any-bot shape this must not flag)', () => {
    // `any-bot/server/app-modules/*.js` is full of `../services/...` and `../utils/...`. Those
    // resolve inside the tree and are not violations; an early draft of the check reported all of
    // them, because `git rev-parse` answers with forward slashes on Windows and the prefix
    // comparison against a natively-resolved path never matched.
    withFixture(
      (dir) => {
        mkdirSync(join(dir, 'any-bot/server/app-modules'), { recursive: true });
        mkdirSync(join(dir, 'any-bot/server/utils'), { recursive: true });
        writeFileSync(join(dir, 'any-bot/server/utils/config.js'), 'module.exports = {};\n', 'utf8');
        writeFileSync(
          join(dir, 'any-bot/server/app-modules/routes-thing.js'),
          "const config = require('../utils/config');\nmodule.exports = config;\n",
          'utf8',
        );
      },
      ({ code, output }) => {
        expect(output).toContain('no kernel file imports across the repository boundary');
        expect(code).toBe(0);
      },
    );
  });

  it('FAILS when a store package manifest is tracked in the kernel', () => {
    withFixture(
      (dir) => {
        mkdirSync(join(dir, 'movies'), { recursive: true });
        writeFileSync(join(dir, 'movies/oshal-app.yaml'), 'name: movies\n', 'utf8');
      },
      ({ code, output }) => {
        expect(output).toContain('application package(s) tracked in the swarm repo');
        expect(output).toContain('movies/oshal-app.yaml');
        expect(code).toBe(1);
      },
    );
  });

  it('FAILS when a non-kernel manifest appears in swarm-apps/', () => {
    withFixture(
      (dir) => writeFileSync(join(dir, 'swarm-apps/eats.yaml'), 'name: eats\n', 'utf8'),
      ({ code, output }) => {
        expect(output).toContain('non-kernel manifest(s) in swarm-apps/');
        expect(output).toContain('swarm-apps/eats.yaml');
        expect(code).toBe(1);
      },
    );
  });

  it('FAILS when a kernel manifest goes missing (a core-platform app was carved by mistake)', () => {
    withFixture(
      (dir) => rmSync(join(dir, 'swarm-apps/jarvis.yaml')),
      ({ code, output }) => {
        expect(output).toContain('kernel manifest(s) missing');
        expect(code).toBe(1);
      },
    );
  });

  it('FAILS when installed-application staging directories are tracked', () => {
    withFixture(
      (dir) => {
        mkdirSync(join(dir, 'deployed-apps/dnd'), { recursive: true });
        writeFileSync(join(dir, 'deployed-apps/dnd/routes.js'), '// installed\n', 'utf8');
      },
      ({ code, output }) => {
        expect(output).toContain('installed-application directories are tracked');
        expect(code).toBe(1);
      },
    );
  });
});
