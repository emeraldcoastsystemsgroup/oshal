/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary guard for scripts/governance/attribution-scrub: builds a fixture repository with a clean root commit, a commit carrying a model co-author trailer and a commit carrying the "Generated with" footer, bare-clones it and runs the REAL rewrite (git + git-filter-repo, no doubles). Proves the trailer and footer are gone, every tree is byte-identical, the clean root keeps its SHA, the commit-map is written, and the pure message cleaner's self-test passes. Fails loudly (never skips) when python or git-filter-repo is missing, because a skipped guard is no guard.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../..');
const TOOL_DIR = join(REPO_ROOT, 'scripts/governance/attribution-scrub');
const SCRUB = join(TOOL_DIR, 'scrub_history.py');
const FIXTURE_TIMEOUT_MS = 60_000;

/**
 * @description Locate a Python 3 interpreter; the tooling is Python because git-filter-repo is.
 * @returns The executable name that answered `--version`.
 */
function python(): string {
  for (const candidate of ['python3', 'python']) {
    const r = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (r.status === 0 && /Python 3/.test(`${r.stdout}${r.stderr}`)) return candidate;
  }
  throw new Error('python3 is required for the attribution-scrub tooling guard and was not found on PATH');
}

/**
 * @description Run git in a directory and return trimmed stdout.
 * @param cwd - Repository directory.
 * @param args - git arguments.
 * @returns Trimmed stdout.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * @description Commit one file change with a fixed identity so the fixture is deterministic.
 * @param cwd - Fixture repository.
 * @param file - File to write.
 * @param message - Full commit message (may carry attribution lines).
 * @returns The new commit SHA.
 */
function commit(cwd: string, file: string, message: string): string {
  writeFileSync(join(cwd, file), `${file}\n${message.length}\n`);
  git(cwd, 'add', file);
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-q', '-F', '-'],
    { cwd, input: message, encoding: 'utf8' });
  return git(cwd, 'rev-parse', 'HEAD');
}

// Built by concatenation so this spec never carries the literal shapes the tree guard forbids.
const TRAILER = ['Co-Authored-By', ': Some Model <noreply@', 'anthropic.com>'].join('');
const FOOTER = ['\u{1F916} Generated with [Claude', ' Code](https://example.invalid/tool)'].join('');

describe('attribution-scrub tooling (real git + git-filter-repo)', () => {
  it('the message cleaner self-test passes', () => {
    const r = spawnSync(python(), [SCRUB, '--self-test'], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toMatch(/self-test: 4\/4 passed/);
    expect(r.status).toBe(0);
  });

  it('rewrites only the attributed commits and their descendants, keeping every tree', () => {
    const fr = spawnSync('git', ['filter-repo', '--version'], { encoding: 'utf8' });
    if (fr.status !== 0) {
      throw new Error('git-filter-repo is required for the attribution-scrub tooling guard (pip install git-filter-repo)');
    }
    const work = mkdtempSync(join(tmpdir(), 'attribution-scrub-'));
    try {
      const src = join(work, 'src');
      git(work, 'init', '-q', '-b', 'main', src);
      const root = commit(src, 'a.txt', 'chore: clean root\n');
      const withTrailer = commit(src, 'b.txt', `feat: attributed\n\nbody\n\n${TRAILER}\n`);
      const withFooter = commit(src, 'c.txt', `fix: footer\n\n${FOOTER}\n`);
      git(src, 'branch', 'side', root);

      const bare = join(work, 'fixture.git');
      git(work, 'clone', '-q', '--bare', src, bare);
      const r = spawnSync(python(), [SCRUB, bare], { encoding: 'utf8', cwd: work });
      expect(r.stdout).toMatch(/attributed: 2/);
      expect(r.stdout).toMatch(/rewrite set: 2 commits/);
      expect(r.stdout).toMatch(/attribution left: 0; tree\/ref mismatches: 0/);
      expect(r.status).toBe(0);

      const newMain = git(bare, 'rev-parse', 'main');
      expect(newMain).not.toBe(withFooter);
      expect(git(bare, 'rev-parse', 'side')).toBe(root); // untouched ref keeps its SHA
      expect(git(bare, 'rev-parse', `${newMain}~2`)).toBe(root); // clean root keeps its SHA
      expect(git(bare, 'rev-parse', `${newMain}^{tree}`)).toBe(git(src, 'rev-parse', `${withFooter}^{tree}`));
      expect(git(bare, 'rev-parse', `${newMain}~1^{tree}`)).toBe(git(src, 'rev-parse', `${withTrailer}^{tree}`));
      const messages = git(bare, 'log', '--format=%B', 'main');
      expect(messages).not.toMatch(/anthropic/i);
      expect(messages).not.toMatch(/Generated with/);
      expect(messages).toContain('feat: attributed\n\nbody\n');

      const map = readFileSync(join(work, 'fixture.commit-map'), 'utf8');
      expect(map).toContain(`${withFooter} ${newMain}`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, FIXTURE_TIMEOUT_MS);
});
