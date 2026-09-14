/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | First guard for the publish gate. This repo is public with no sanitizer between a commit and the world, and scripts/publish-gate.sh is the only wall — yet it had no test, so a regression in it would be found by the leak. Proves the gate passes on this tree and goes RED on each shape it must refuse, including the binary blind spot found 2026-07-27 (every check used `git grep -I`, which skips binaries, so a screenshot of a filled-in job application passed clean). Also guards the .gitignore half of that fix: debris in a NEW artifacts subdir must be ignored without anyone having named the subdir.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guards check 5, the commit-message blind spot. Checks 1-4 read the TREE via git ls-files / git grep; a commit message is not a file, so a token or a personal detail typed into `git commit -m` shipped through a gate that printed "clean" — and undoing it needs a history rewrite the main ruleset now refuses outright. Also pins the SCOPE, which is the part that decides whether the check survives: it must scan `HEAD --not --remotes` and not `--all`, because this box carries 117 commits of unpushable local history (archive/pre-scrub-main, retired worktree lanes) that would fail the gate on every push forever until somebody disabled it.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | 2026-07-31 23:21:37 America/Chicago — Raises the real-repository gate assertion timeout because a full parallel unit run can spend more than Vitest's 5s default in shell/git startup before the gate reports clean.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Bound each disposable Git/Bash gate process and give the two-invocation branch-scope proof explicit full-suite startup headroom.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Apply the documented full-suite startup allowance to the real-repository gate assertion itself; the child process remains independently bounded at 15 seconds.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Guards the model-attribution refusal added to check 5. Every spelling of the co-author trailer, the vendor no-reply address and the tool footer that a session produces goes red and names the commit; a human co-author, the maintainer and prose that merely names the model pass; history the remote already holds is never re-judged. Also pins the PRE-PUSH scope - the ref-update lines git writes to the hook's stdin - including a push BY SHA while HEAD is clean, and drives one case through a real `git push` with the real hook installed, the boundary a direct gate call cannot exercise.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeout?: number;
}

/**
 * @description Run a process to completion and capture its verdict instead of throwing on a
 * non-zero exit — a refusal is the result under test, not an error.
 * @param file - Executable.
 * @param args - Arguments.
 * @param options - Working directory, environment, stdin and a per-process time bound.
 * @returns Exit code and output (stdout on success, stdout+stderr on failure).
 */
function captureRun(file: string, args: string[], options: RunOptions): GateResult {
  try {
    const output = execFileSync(file, args, { encoding: 'utf8', stdio: 'pipe', timeout: 15_000, ...options });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/**
 * @description Run the real publish gate against a checkout and capture its verdict.
 * @param cwd - Repository to scan. The gate cd's to that repo's toplevel.
 * @param opts - `args` for the gate (e.g. `--pre-push`) and `input` for its stdin, which as the
 *               pre-push hook carries git's ref-update lines.
 * @returns Exit code and combined stdout+stderr.
 */
function runGate(cwd: string, opts: { args?: string[]; input?: string } = {}): GateResult {
  return captureRun(BASH, [GATE, ...(opts.args ?? [])], { cwd, input: opts.input });
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

/**
 * @description Publish a fixture's current branch to a fresh bare remote, so its commits become
 *              "already published" — the state that must take a commit out of scope.
 * @param dir - Fixture repository.
 * @returns Path of the bare remote, for tests that inspect what a push actually landed.
 */
function publishTo(dir: string): string {
  const remote = mkdtempSync(join(tmpdir(), 'oshal-gate-remote-'));
  execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'pipe' });
  git(dir, 'remote', 'add', 'origin', remote);
  const branch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  git(dir, 'push', '-q', 'origin', branch);
  return remote;
}

/**
 * @description Resolve a revision (or pass other rev-parse flags) inside a fixture.
 * @param dir - Fixture repository.
 * @param args - rev-parse arguments, e.g. `['--short', sha]`.
 * @returns The trimmed rev-parse output.
 */
function revParse(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', ...args], { encoding: 'utf8' }).trim();
}

let changeCounter = 0;

/**
 * @description Commit one new file with an exact, possibly multi-line message.
 *
 * The message goes to `git commit -F -` on stdin rather than `-m`, so trailers, blank lines and
 * the footer's emoji reach git byte-for-byte on every platform. Only the new file is staged, so
 * untracked fixture tooling (an installed copy of the gate) never joins the tree under test.
 *
 * @param dir - Fixture repository.
 * @param message - Full commit message.
 * @returns The new commit's full SHA.
 */
function commitMessage(dir: string, message: string): string {
  changeCounter += 1;
  const rel = `src/change-${changeCounter}.ts`;
  writeFileSync(join(dir, rel), `export const change = ${changeCounter};\n`, 'utf8');
  git(dir, 'add', '--', rel);
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-F', '-'],
    { input: message, stdio: 'pipe' },
  );
  return revParse(dir, 'HEAD');
}

/** The object name git writes on a pre-push line for a ref that does not exist on that side. */
const ZERO_SHA = '0'.repeat(40);

/**
 * @description One ref-update line in the exact shape git writes to a pre-push hook's stdin.
 * @param localRef - Local ref (or `(delete)`).
 * @param localSha - Commit being pushed (all zeros for a deletion).
 * @param remoteRef - Destination ref on the remote.
 * @param remoteSha - The remote's current value of that ref (all zeros when it is new).
 * @returns The line, newline-terminated.
 */
function pushLine(localRef: string, localSha: string, remoteRef = localRef, remoteSha = ZERO_SHA): string {
  return `${localRef} ${localSha} ${remoteRef} ${remoteSha}\n`;
}

/**
 * @description Install the REAL pre-push hook and gate into a fixture — both untracked — so an
 * actual `git push` drives them exactly as it does on a maintainer checkout. Only a real push
 * makes git write the ref-update lines to the hook's stdin, which no direct gate call exercises.
 * `core.hooksPath` is set locally so a global hooks path can never substitute other hooks.
 *
 * @param dir - Fixture repository.
 * @returns void
 */
function installRealHook(dir: string): void {
  const hooks = join(dir, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  copyFileSync(join(REPO_ROOT, '.githooks', 'pre-push'), join(hooks, 'pre-push'));
  chmodSync(join(hooks, 'pre-push'), 0o755);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  copyFileSync(GATE, join(dir, 'scripts', 'publish-gate.sh'));
  git(dir, 'config', 'core.hooksPath', hooks);
}

/**
 * @description Push a refspec through the fixture's hooks and capture the verdict.
 *
 * `OSHAL_SKIP_PREPUSH_VERIFY=1` skips only the hook's HEAD typecheck (a fixture has no
 * node_modules); the hook runs the publish gate before that switch is even read, so a green push
 * here still means the gate passed it.
 *
 * @param dir - Fixture repository with a hook installed.
 * @param refspec - What to push, e.g. `<sha>:refs/heads/lane`.
 * @returns Exit code and combined stdout+stderr.
 */
function gitPush(dir: string, refspec: string): GateResult {
  return captureRun('git', ['-C', dir, 'push', '-q', 'origin', refspec], {
    timeout: 60_000,
    env: { ...process.env, OSHAL_SKIP_PREPUSH_VERIFY: '1' },
  });
}

/**
 * @description Read a ref from a bare remote.
 * @param remote - Bare repository path.
 * @param ref - Full ref name.
 * @returns The ref's SHA, or null when the ref does not exist there.
 */
function remoteRef(remote: string, ref: string): string | null {
  try {
    return execFileSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '-q', ref], {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  } catch {
    return null; // rev-parse --verify -q exits 1 with no output for a missing ref
  }
}

/**
 * The model vendor's no-reply address, assembled at runtime: this spec is a tracked file, and
 * tests/unit/no-model-attribution.spec.ts refuses any tracked file carrying a real co-author
 * trailer at that address — the whole shape must never appear here as one literal.
 */
const MODEL_ADDRESS = ['noreply', 'anthropic.com'].join('@');

/** The model tool's footer as the harness writes it, split for the same reason. */
const TOOL_FOOTER = ['Generated with [Claude', ' Code](https://claude.com/claude-code)'].join('');

/**
 * @description Build one git trailer line, by default at the vendor no-reply address.
 * @param key - Trailer key exactly as written, e.g. `Co-Authored-By`.
 * @param name - Display name.
 * @param address - Email address; defaults to the vendor no-reply address.
 * @returns The trailer line.
 */
function trailer(key: string, name: string, address = MODEL_ADDRESS): string {
  return `${key}: ${name} <${address}>`;
}

/** What a harness session appends by default — the shape that reached main on 2026-09-14. */
const HARNESS_TRAILER = trailer('Co-Authored-By', 'Claude Opus 5 (1M context)');

describe('publish gate: the wall between this public repo and the world', () => {
  it('passes on this repository', () => {
    const { code, output } = runGate(REPO_ROOT);
    expect(output).toContain('Publish gate clean');
    expect(code).toBe(0);
  }, 20_000);

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
  }, 30_000);
});

/**
 * The other half of the same fix. The gate catches media that reached the INDEX; .gitignore is what
 * stops it getting there. The rules were `artifacts/*.png` — one level, loose files only — so a
 * pipeline writing into a subdirectory was uncovered.
 */
describe('commit messages, which the tree checks cannot see', () => {
  it('FAILS when an unpushed commit message carries a credential', () => {
    const dir = makeFixture(undefined, `wire up deploy, token ${fakeToken()}`);
    try {
      const r = runGate(dir);
      expect(r.code).toBe(1);
      expect(r.output).toMatch(/COMMIT MESSAGE/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('PASSES when unpushed commit messages are clean', () => {
    withFixture(undefined, (r) => {
      expect(r.code).toBe(0);
      expect(r.output).toMatch(/commit messages|commit messages to scan/i);
    });
  }, 20_000);

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
  }, 30_000);

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
  }, 30_000);
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

/**
 * The 2026-09-12 history scrub left no attributed commit reachable from origin; by 2026-09-14, 45
 * commits reachable from main carried a model co-author trailer again (d679b696). The
 * tree guard (no-model-attribution.spec.ts) reads FILES; the trailer lives in the commit MESSAGE,
 * and the only wall in front of a message is this push gate. It must refuse the trailer in every
 * spelling a session produces, pass human co-authors and prose, judge only what the push
 * publishes, and never re-judge history the remote already holds.
 */
describe('model attribution in commit messages is refused at push time', () => {
  // Every row after the first trips exactly ONE of the gate's three rules (named trailer, vendor
  // address, tool footer) and none of the others — so narrowing any one rule turns a row red
  // instead of hiding behind a rule that happens to match the same line.
  const OTHER = 'bot@example.org';
  const REFUSED: Array<[string, string]> = [
    ['the trailer exactly as the harness appends it', `fix: wire the importer\n\nWhy it changed.\n\n${HARNESS_TRAILER}\n`],
    ['GitHub casing (Co-authored-by)', `fix: wire the importer\n\n${trailer('Co-authored-by', 'Claude Sonnet 4.5', OTHER)}\n`],
    ['all lower case', `fix: wire the importer\n\n${trailer('co-authored-by', 'claude', OTHER)}\n`],
    ['all upper case', `fix: wire the importer\n\n${trailer('CO-AUTHORED-BY', 'CLAUDE CODE', OTHER.toUpperCase())}\n`],
    ['an indented trailer', `fix: wire the importer\n\n   ${trailer('Co-Authored-By', 'Claude', OTHER)}\n`],
    ['an Anthropic co-author that never says Claude', `fix: wire the importer\n\n${trailer('Co-Authored-By', 'Anthropic Assistant', OTHER)}\n`],
    ['a model named under another -by trailer key', `fix: wire the importer\n\n${trailer('Assisted-by', 'Claude Code', OTHER)}\n`],
    ['the vendor no-reply address outside any -by trailer', `fix: wire the importer\n\n${trailer('Model', 'Some Model')}\n`],
    ['the vendor no-reply address in mixed case', `fix: wire the importer\n\n${trailer('Model', 'Bot', 'NoReply@Anthropic.COM')}\n`],
    ['the tool footer with its emoji and link', `feat: add the export\n\nBody.\n\n\u{1F916} ${TOOL_FOOTER}\n`],
    ['the tool footer without the link', 'feat: add the export\n\nGenerated with Claude Code\n'],
    ['the tool footer in upper case', 'feat: add the export\n\nGENERATED WITH CLAUDE CODE\n'],
    ['the tool footer mid-sentence', 'feat: add the export\n\nThis change was generated by Claude.\n'],
  ];

  it.each(REFUSED)('FAILS on %s, naming the commit', (_label, message) => {
    const dir = makeFixture();
    try {
      const sha = commitMessage(dir, message);
      const r = runGate(dir);
      expect(r.output).toContain('model attribution in unpublished COMMIT MESSAGE');
      expect(r.output).toContain(revParse(dir, '--short', sha));
      expect(r.code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  const PASSED: Array<[string, string]> = [
    ['a clean message', 'fix: wire the importer\n\nWhy it changed.\n'],
    ['a human co-author', 'feat: pair on the importer\n\nCo-authored-by: Pat Rivera <pat.rivera@example.org>\n'],
    ['the maintainer as co-author', 'feat: pair on the importer\n\nCo-authored-by: oshal maintainers <maintainer@emeraldcoastsystemsgroup.com>\n'],
    ['prose that names the model without attributing to it', 'docs: say why Claude sessions must not sign commits\n\nThe gate refuses co-author trailers that name a model.\n'],
  ];

  it.each(PASSED)('PASSES on %s', (_label, message) => {
    const dir = makeFixture();
    try {
      commitMessage(dir, message);
      const r = runGate(dir);
      expect(r.output).toContain('no model attribution in unpublished commit messages');
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('tells the pusher how to fix it — reword, never --no-verify', () => {
    const dir = makeFixture();
    try {
      const sha = commitMessage(dir, `fix: wire the importer\n\n${HARNESS_TRAILER}\n`);
      const r = runGate(dir);
      expect(r.code).toBe(1);
      expect(r.output).toContain(HARNESS_TRAILER);
      expect(r.output).toContain('git commit --amend');
      expect(r.output).toContain(`git rebase -i ${revParse(dir, '--short', sha)}~1`);
      expect(r.output).toContain('--no-verify');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('names only the attributed commit inside a longer unpushed range', () => {
    const dir = makeFixture();
    let remote = '';
    try {
      remote = publishTo(dir);
      const before = commitMessage(dir, 'fix: first\n');
      const bad = commitMessage(dir, `fix: second\n\n${HARNESS_TRAILER}\n`);
      const after = commitMessage(dir, 'fix: third\n');
      const r = runGate(dir);
      expect(r.code).toBe(1);
      expect(r.output).toContain(revParse(dir, '--short', bad));
      expect(r.output).not.toContain(revParse(dir, '--short', before));
      expect(r.output).not.toContain(revParse(dir, '--short', after));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (remote) rmSync(remote, { recursive: true, force: true });
    }
  }, 30_000);

  it('does NOT re-judge attributed history the remote already holds', () => {
    // main carries 45 such commits (2026-09-14). Removing them is an operator-run history rewrite; a
    // gate that refused every push until then would halt all work, so published = out of scope.
    const dir = makeFixture();
    let remote = '';
    try {
      commitMessage(dir, `fix: already shipped\n\n${HARNESS_TRAILER}\n`);
      expect(runGate(dir).code).toBe(1); // in scope while unpublished
      remote = publishTo(dir);
      expect(runGate(dir).code).toBe(0); // published: never re-judged
      commitMessage(dir, 'fix: new clean work on top\n');
      const r = runGate(dir);
      expect(r.output).toContain('no model attribution in unpublished commit messages');
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (remote) rmSync(remote, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * As the pre-push hook the gate is told what is actually being pushed: git writes one
 * "<local ref> <local sha> <remote ref> <remote sha>" line per ref to the hook's stdin. HEAD alone
 * is not the push — the shared checkout's private-index recipe pushes BY SHA
 * (`git push origin <sha>:refs/heads/x`) while HEAD sits on another lane's branch.
 */
describe('pre-push scope: the commits the push publishes, not whatever HEAD is', () => {
  it('refuses an attributed commit pushed BY SHA while HEAD is clean', () => {
    const dir = makeFixture();
    let remote = '';
    try {
      remote = publishTo(dir);
      git(dir, 'checkout', '-q', '-b', 'lane');
      const sha = commitMessage(dir, `fix: lane work\n\n${HARNESS_TRAILER}\n`);
      git(dir, 'checkout', '-q', '-');
      expect(runGate(dir).code).toBe(0); // by hand the scope is HEAD, which is published and clean
      const r = runGate(dir, { args: ['--pre-push'], input: pushLine(sha, sha, 'refs/heads/lane') });
      expect(r.output).toContain('model attribution in unpublished COMMIT MESSAGE');
      expect(r.output).toContain(revParse(dir, '--short', sha));
      expect(r.code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (remote) rmSync(remote, { recursive: true, force: true });
    }
  }, 30_000);

  it('judges only what is pushed, not unrelated unpushed work sitting on HEAD', () => {
    const dir = makeFixture();
    let remote = '';
    try {
      remote = publishTo(dir);
      git(dir, 'checkout', '-q', '-b', 'other');
      const clean = commitMessage(dir, 'fix: clean lane work\n');
      git(dir, 'checkout', '-q', '-');
      commitMessage(dir, `wip: someone else\n\n${HARNESS_TRAILER}\n`);
      expect(runGate(dir).code).toBe(1); // by hand, HEAD's own unpushed commit is judged
      const r = runGate(dir, { args: ['--pre-push'], input: pushLine('refs/heads/other', clean) });
      expect(r.output).toContain('no model attribution in unpublished commit messages');
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (remote) rmSync(remote, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not re-judge what the remote already has, even with no remote-tracking refs', () => {
    // A push to a bare path (no remote name) leaves no refs/remotes/* behind, so `--not --remotes`
    // excludes nothing — git's <remote sha> on the pre-push line is the only record of what the
    // remote holds, and it alone must keep the published attributed commit out of scope.
    const dir = makeFixture();
    const remote = mkdtempSync(join(tmpdir(), 'oshal-gate-remote-'));
    try {
      execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'pipe' });
      const published = commitMessage(dir, `fix: already shipped\n\n${HARNESS_TRAILER}\n`);
      git(dir, 'push', '-q', remote, 'HEAD:refs/heads/main');
      const next = commitMessage(dir, 'fix: clean follow-up\n');
      const r = runGate(dir, {
        args: ['--pre-push'],
        input: pushLine('refs/heads/main', next, 'refs/heads/main', published),
      });
      expect(r.output).toContain('no model attribution in unpublished commit messages');
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  }, 30_000);

  it('ignores a ref deletion, which publishes nothing', () => {
    const dir = makeFixture();
    try {
      const deletion = pushLine('(delete)', ZERO_SHA, 'refs/heads/gone', revParse(dir, 'HEAD'));
      const r = runGate(dir, { args: ['--pre-push'], input: deletion });
      expect(r.output).toContain('no model attribution in unpublished commit messages');
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('fails closed when a pushed commit cannot be enumerated', () => {
    const dir = makeFixture();
    try {
      const r = runGate(dir, { args: ['--pre-push'], input: pushLine('refs/heads/x', 'f'.repeat(40)) });
      expect(r.output).toContain('cannot list the commits this push publishes');
      expect(r.code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('through a REAL git push and the REAL hook: refused by SHA and from HEAD, clean lands', () => {
    const dir = makeFixture();
    let remote = '';
    try {
      remote = publishTo(dir);
      installRealHook(dir);
      const home = revParse(dir, '--abbrev-ref', 'HEAD');

      git(dir, 'checkout', '-q', '-b', 'lane');
      const bad = commitMessage(dir, `fix: lane work\n\n${HARNESS_TRAILER}\n`);
      const fromHead = gitPush(dir, 'HEAD:refs/heads/lane');
      expect(fromHead.output).toContain(revParse(dir, '--short', bad));
      expect(fromHead.code).not.toBe(0);

      git(dir, 'checkout', '-q', home);
      const bySha = gitPush(dir, `${bad}:refs/heads/lane`);
      expect(bySha.output).toContain('model attribution in unpublished COMMIT MESSAGE');
      expect(bySha.code).not.toBe(0);
      expect(remoteRef(remote, 'refs/heads/lane')).toBeNull();

      git(dir, 'checkout', '-q', '-b', 'clean-lane');
      const good = commitMessage(dir, 'fix: clean lane work\n');
      git(dir, 'checkout', '-q', home);
      expect(gitPush(dir, `${good}:refs/heads/clean-lane`).code).toBe(0);
      expect(remoteRef(remote, 'refs/heads/clean-lane')).toBe(good);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (remote) rmSync(remote, { recursive: true, force: true });
    }
  }, 90_000);
});
