/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-115 guard: prove the repo-separation check both PASSES on this tree and goes RED on each way application code can walk back into the kernel. ADR-085 carved 21 app surfaces out of core and nothing has stopped one returning since; the public core trunk is app-free by construction, so a re-mixed app is a release defect found at publish time. Fixture checkouts (not this tree) exercise the failure paths, so the shared index is never touched.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export-shape guard: run the check from inside a .git-LESS fixture with NO --core flag — the exact ci-local --head GATE_SRC shape where the unconditional `git rev-parse --show-toplevel` (the second git dependence, missed by the 07-23 trackedFiles fix) crashed the gate on a healthy tree. Goes red if either git dependence returns.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Give each disk/subprocess-heavy separation case a local 30-second ceiling. Concurrent full-suite load can exhaust Vitest's 5-second default on Windows even when the guard is healthy; a suite-local helper keeps every mutation case active without weakening unrelated unit-test budgets.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../..');
const GUARD = join(REPO_ROOT, 'scripts/check-repo-separation.js');
const REPOSITORY_GUARD_TIMEOUT_MS = 30_000;

/** Register a repository guard with a bounded timeout local to this disk-heavy suite. */
function repositoryGuard(name: string, test: () => void): void {
  it(name, test, REPOSITORY_GUARD_TIMEOUT_MS);
}

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
 * @param mutate - Optional hook to plant a violation before the files are committed.
 * @param opts - `git: false` skips git init/commit to model a `git archive` export.
 * @returns The fixture checkout path.
 */
function makeKernelFixture(mutate?: (dir: string) => void, opts: { git?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-sep-'));
  mkdirSync(join(dir, 'swarm-apps'), { recursive: true });
  for (const name of KERNEL_MANIFESTS) {
    writeFileSync(join(dir, 'swarm-apps', name), `name: ${name.replace('.yaml', '')}\n`, 'utf8');
  }
  mutate?.(dir);
  if (opts.git === false) return dir;
  execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' });
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'fixture'],
    { stdio: 'pipe' },
  );
  return dir;
}

/**
 * @description Run a fixture assertion and always clean the temp checkout up.
 * @param mutate - Violation planter.
 * @param assertion - What the guard should report.
 * @returns void
 */
function withFixture(
  mutate: ((dir: string) => void) | undefined,
  assertion: (r: GuardResult) => void,
): void {
  const dir = makeKernelFixture(mutate);
  try {
    assertion(runGuard(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('repo separation (ADR-115): application code never mixes into the swarm repo', () => {
  repositoryGuard('passes on this repository', () => {
    const { code, output } = runGuard();
    expect(output).toContain('Repo separation holds');
    expect(code).toBe(0);
  });

  repositoryGuard('passes on a compliant kernel fixture', () => {
    withFixture(undefined, ({ code }) => expect(code).toBe(0));
  });

  repositoryGuard('passes when run from inside a .git-less EXPORT with no --core (ci-local --head GATE_SRC shape)', () => {
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

  repositoryGuard('FAILS when a store package manifest is tracked in the kernel', () => {
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

  repositoryGuard('FAILS when a non-kernel manifest appears in swarm-apps/', () => {
    withFixture(
      (dir) => writeFileSync(join(dir, 'swarm-apps/eats.yaml'), 'name: eats\n', 'utf8'),
      ({ code, output }) => {
        expect(output).toContain('non-kernel manifest(s) in swarm-apps/');
        expect(output).toContain('swarm-apps/eats.yaml');
        expect(code).toBe(1);
      },
    );
  });

  repositoryGuard('FAILS when a kernel manifest goes missing (a core-platform app was carved by mistake)', () => {
    withFixture(
      (dir) => rmSync(join(dir, 'swarm-apps/jarvis.yaml')),
      ({ code, output }) => {
        expect(output).toContain('kernel manifest(s) missing');
        expect(code).toBe(1);
      },
    );
  });

  repositoryGuard('FAILS when installed-application staging directories are tracked', () => {
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
