/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | First guard for the publish gate. This repo is public with no sanitizer between a commit and the world, and scripts/publish-gate.sh is the only wall — yet it had no test, so a regression in it would be found by the leak. Proves the gate passes on this tree and goes RED on each shape it must refuse, including the binary blind spot found 2026-07-27 (every check used `git grep -I`, which skips binaries, so a screenshot of a filled-in job application passed clean). Also guards the .gitignore half of that fix: debris in a NEW artifacts subdir must be ignored without anyone having named the subdir.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guards check 5, the commit-message blind spot. Checks 1-4 read the TREE via git ls-files / git grep; a commit message is not a file, so a token or a personal detail typed into `git commit -m` shipped through a gate that printed "clean" — and undoing it needs a history rewrite the main ruleset now refuses outright. Also pins the SCOPE, which is the part that decides whether the check survives: it must scan `HEAD --not --remotes` and not `--all`, because this box carries 117 commits of unpushable local history (archive/pre-scrub-main, retired worktree lanes) that would fail the gate on every push forever until somebody disabled it.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../..');
const GATE = join(REPO_ROOT, 'scripts/publish-gate.sh');

/**
 * @description Resolve a POSIX bash to run the gate with.
 *
 * On Windows the `bash` on PATH is `C:\Windows\System32\bash.exe` — the WSL launcher, which is a
 * different filesystem namespace (the repo path would not resolve) and is a known wedge risk on
 * this host. Git ships a real bash; derive it from `git --exec-path` so this is not a hardcoded
 * install path. Everywhere else PATH bash is correct.
 *
 * Throws rather than returning null on purpose: a guard that quietly skips is a guard that does
 * not exist, and this one protects a public repo.
 *
 * @returns Absolute path to a usable bash, or the bare name on POSIX.
 * @throws If no non-WSL bash can be located.
 */
function resolveBash(): string {
  if (process.platform !== 'win32') return 'bash';
  // Walk up from the exec-path (…/Git/mingw64/libexec/git-core) rather than assuming a depth —
  // that nesting differs between Git for Windows layouts and a fixed dirname count got it wrong.
  let dir = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  for (let up = 0; up < 6; up++) {
    for (const rel of ['bin/bash.exe', 'usr/bin/bash.exe']) {
      const candidate = join(dir, rel);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('no Git Bash found near `git --exec-path`; refusing to fall back to the WSL bash on PATH');
}

const BASH = resolveBash();

interface GateResult {
  code: number;
  output: string;
}

/**
 * @description Run the real publish gate against a checkout and capture its verdict.
 * @param cwd - Repository to scan. The gate cd's to that repo's toplevel.
 * @returns Exit code and combined stdout+stderr.
 */
function runGate(cwd: string): GateResult {
  try {
    const output = execFileSync(BASH, [GATE], { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/**
 * @description Bytes of a small but genuine PNG — signature plus an IHDR chunk.
 *
 * The NUL bytes in the chunk length are what make git classify it as binary, which is the entire
 * point of the check under test: `git grep -I` will not look inside this, so no text rule can ever
 * see what it depicts.
 *
 * @returns A binary PNG buffer.
 */
function pngBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from('IHDR', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00]),
  ]);
}

/**
 * @description Build a throwaway git checkout that the gate should consider clean.
 *
 * Real git state is required: the gate scans `git ls-files`, so an untracked stray is correctly
 * not a finding — tracked-ness is the thing under test.
 *
 * @param mutate - Optional hook to plant a violation before files are committed.
 * @returns The fixture checkout path.
 */
function makeFixture(mutate?: (dir: string) => void, message = 'fixture'): string {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-gate-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/index.ts'), 'export const ok = true;\n', 'utf8');
  mutate?.(dir);
  execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' });
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', message],
    { stdio: 'pipe' },
  );
  return dir;
}

/**
 * @description Run a git command inside a fixture checkout with a fixed identity.
 * @param dir - Fixture repository.
 * @param args - git arguments.
 * @returns void
 */
function git(dir: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { stdio: 'pipe' },
  );
}

/**
 * @description A credential-shaped string the gate's check-2 regex matches.
 *
 * Assembled at runtime rather than written as one literal: this spec is a tracked file, and a
 * whole token in the source would be flagged by the gate's own scan of this repository — the
 * test would break the thing it tests.
 *
 * @returns A fake GitHub PAT.
 */
function fakeToken(): string {
  return ['ghp', 'A'.repeat(24)].join('_');
}

/**
 * @description Run an assertion against a fixture and always clean the checkout up.
 * @param mutate - Violation planter.
 * @param assertion - What the gate should report.
 * @returns void
 */
function withFixture(
  mutate: ((dir: string) => void) | undefined,
  assertion: (r: GateResult) => void,
): void {
  const dir = makeFixture(mutate);
  try {
    assertion(runGate(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('publish gate: the wall between this public repo and the world', () => {
  it('passes on this repository', () => {
    const { code, output } = runGate(REPO_ROOT);
    expect(output).toContain('Publish gate clean');
    expect(code).toBe(0);
  });

  it('passes on a clean fixture checkout', () => {
    withFixture(undefined, ({ code }) => expect(code).toBe(0));
  });

  it('FAILS when an internal-only path is tracked', () => {
    withFixture(
      (dir) => writeFileSync(join(dir, 'COLLABORATE.md'), '# internal thread\n', 'utf8'),
      ({ code, output }) => {
        expect(output).toContain('internal-only paths are tracked');
        expect(code).toBe(1);
      },
    );
  });

  it('FAILS when a vendor-prefixed credential is tracked', () => {
    withFixture(
      (dir) => {
        // Assembled at runtime, never written as a literal: this spec is itself a tracked file the
        // real gate scans, and a literal key shape here would make the gate flag its own guard.
        const fake = `AKIA${'Q7ZP4XN2WKDL8VRT'}`;
        writeFileSync(join(dir, 'src/creds.ts'), `export const k = '${fake}';\n`, 'utf8');
      },
      ({ code, output }) => {
        expect(output).toContain('vendor-prefixed credential');
        expect(code).toBe(1);
      },
    );
  });

  /**
   * The 2026-07-27 blind spot. Checks 1-3 are text rules and `git grep -I` skips binaries, so the
   * gate could not see a screenshot at all. Found live: artifacts/remote-control/ held 105 captures
   * of filled-in job applications (home address, phone, EEO disclosures).
   */
  describe('binary media, which no text rule can read', () => {
    it('is genuinely invisible to the text checks (the premise this rule exists for)', () => {
      const dir = makeFixture((d) => {
        mkdirSync(join(d, 'artifacts/remote-control'), { recursive: true });
        writeFileSync(join(d, 'artifacts/remote-control/capture.png'), pngBytes());
      });
      try {
        // -I is what every credential/identifier rule uses. If this ever returns a hit, binaries
        // became scannable and the allowlist rule could be reconsidered.
        const hits = execFileSync('git', ['-C', dir, 'grep', '-lI', '-e', 'IHDR', '--', '.'], {
          encoding: 'utf8',
          stdio: 'pipe',
        }).trim();
        expect(hits).toBe('');
      } catch (err) {
        // git grep exits 1 with no output when nothing matched — that IS the expected result.
        expect((err as { status?: number }).status).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('FAILS when tracked outside a curated directory', () => {
      withFixture(
        (dir) => {
          mkdirSync(join(dir, 'artifacts/remote-control'), { recursive: true });
          writeFileSync(join(dir, 'artifacts/remote-control/samsara-form.png'), pngBytes());
        },
        ({ code, output }) => {
          expect(output).toContain('binary media tracked outside a curated directory');
          expect(output).toContain('artifacts/remote-control/samsara-form.png');
          expect(code).toBe(1);
        },
      );
    });

    it('FAILS for a capture dropped in a directory nobody predicted', () => {
      // The rule must not depend on knowing the pipeline's output dir in advance — that is exactly
      // how the ignore rules missed remote-control/.
      withFixture(
        (dir) => {
          mkdirSync(join(dir, 'scratch/2026-08-run'), { recursive: true });
          writeFileSync(join(dir, 'scratch/2026-08-run/shot.png'), pngBytes());
        },
        ({ code, output }) => {
          expect(output).toContain('binary media tracked outside a curated directory');
          expect(code).toBe(1);
        },
      );
    });

    it('PASSES for the same bytes inside a curated directory (allowlist, not a blanket ban)', () => {
      withFixture(
        (dir) => {
          mkdirSync(join(dir, 'docs/assets/oshal'), { recursive: true });
          writeFileSync(join(dir, 'docs/assets/oshal/diagram.png'), pngBytes());
        },
        ({ code, output }) => {
          expect(output).toContain('no binary media outside curated directories');
          expect(code).toBe(0);
        },
      );
    });
  });
});

/**
 * The other half of the same fix. The gate catches media that reached the INDEX; .gitignore is what
 * stops it getting there. The rules were `artifacts/*.png` — one level, loose files only — so a
 * pipeline writing into a subdirectory was uncovered.
 */
describe('commit messages, which the tree checks cannot see', () => {
  /**
   * @description Give a fixture a bare remote and push, so its commits become "already
   *              published" — the state that must take a commit out of scope.
   * @param dir - Fixture repository.
   * @returns void
   */
  function publishTo(dir: string): void {
    const remote = mkdtempSync(join(tmpdir(), 'oshal-gate-remote-'));
    execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'pipe' });
    git(dir, 'remote', 'add', 'origin', remote);
    const branch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    git(dir, 'push', '-q', 'origin', branch);
  }

  it('FAILS when an unpushed commit message carries a credential', () => {
    const dir = makeFixture(undefined, `wire up deploy, token ${fakeToken()}`);
    try {
      const r = runGate(dir);
      expect(r.code).toBe(1);
      expect(r.output).toMatch(/COMMIT MESSAGE/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PASSES when unpushed commit messages are clean', () => {
    withFixture(undefined, (r) => {
      expect(r.code).toBe(0);
      expect(r.output).toMatch(/commit messages|commit messages to scan/i);
    });
  });

  it('does NOT re-flag a bad message that is already published', () => {
    // Nothing can be done about an already-pushed message except a history rewrite, which
    // the main ruleset refuses. Re-reporting it every push would only train people to bypass
    // the gate, so scope is what is about to ship, not what already shipped.
    const dir = makeFixture(undefined, `leaked ${fakeToken()}`);
    try {
      expect(runGate(dir).code).toBe(1);
      publishTo(dir);
      expect(runGate(dir).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores bad messages on OTHER local branches — the scope that keeps this usable', () => {
    // The trap this pins: `--all --not --remotes` would scan every unpushable local branch.
    // On the real repo that is 117 commits of archived history, and a gate that fails every
    // push on history nobody can rewrite is a gate that gets turned off.
    const dir = makeFixture();
    try {
      publishTo(dir);
      git(dir, 'checkout', '-q', '-b', 'archive/old-lane');
      writeFileSync(join(dir, 'src/other.ts'), 'export const x = 1;\n', 'utf8');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', `ancient mistake ${fakeToken()}`);
      expect(runGate(dir).code).toBe(1); // that branch IS HEAD right now, so it is in scope

      git(dir, 'checkout', '-q', '-');
      expect(runGate(dir).code).toBe(0); // back on the published branch: out of scope
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('artifacts/ ignore rules cover pipeline debris at any depth', () => {
  /**
   * @description Ask git whether a path would be ignored in this repo.
   * @param relPath - Repo-relative path to test.
   * @returns True when the path is ignored.
   */
  function isIgnored(relPath: string): boolean {
    try {
      execFileSync('git', ['-C', REPO_ROOT, 'check-ignore', '-q', '--no-index', relPath], {
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  }

  it.each([
    'artifacts/remote-control/samsara-form.png',
    'artifacts/some-future-pipeline/nested/deep/capture.jpg',
    'artifacts/remote-control/alt-f4.ps1',
    'artifacts/whatever/notes.txt',
  ])('ignores %s', (p) => {
    expect(isIgnored(p)).toBe(true);
  });

  it('still allows the one curated mockup directory to take new media', () => {
    // The excludes are extension patterns rather than a directory, which is what lets this
    // re-include work at all — git cannot re-include a file through an excluded parent directory.
    expect(isIgnored('artifacts/jarvis-rich-ux-mockups/option-d-new.png')).toBe(false);
  });
});
