/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Isolation + governance tests for the ADR-077 Phase 2 Dev Session Engine (never touches main / the live tree).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added post-red-team tests: verify-gated commit, symlink escape, protected-path + poisoned-session rejection.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DevSessionEngine, type DevSession } from '@/features/dev-console';

const PASS = ['node', '-e', 'process.exit(0)'];
const FAIL = ['node', '-e', 'process.exit(1)'];

let base: string;
let repoRoot: string;
let worktreesRoot: string;
let engine: DevSessionEngine;
const openSessions: DevSession[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

/** Apply a change set and run a passing verify, so commit() is permitted. */
function applyAndVerify(session: DevSession, edits: { path: string; content: string }[]): void {
  engine.applyChangeSet(session, edits);
  expect(engine.verify(session, PASS).passed).toBe(true);
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'oshal-dse-'));
  repoRoot = path.join(base, 'repo');
  worktreesRoot = path.join(base, 'worktrees');
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.email', 'test@example.test']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  writeFileSync(path.join(repoRoot, 'seed.txt'), 'seed\n', 'utf8');
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-m', 'init']);
  engine = new DevSessionEngine({ repoRoot, worktreesRoot, verifyCommand: PASS });
});

afterEach(() => {
  for (const session of openSessions.splice(0)) {
    try { engine.teardown(session); } catch { /* already gone */ }
  }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
});

function open(label?: string): DevSession {
  const session = engine.create(label);
  openSessions.push(session);
  return session;
}

describe('DevSessionEngine — isolation + governance (ADR-077 Phase 2)', () => {
  it('creates an isolated worktree on a dev-session branch without moving main', () => {
    const mainHead = git(repoRoot, ['rev-parse', 'HEAD']).trim();
    const session = open('fix-bug');
    expect(session.branch.startsWith('dev-session/')).toBe(true);
    expect(git(session.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(session.branch);
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(mainHead);
    expect(git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
  });

  it('applies a change set inside the worktree and surfaces it in the diff', () => {
    const session = open();
    expect(engine.applyChangeSet(session, [{ path: 'src/new.txt', content: 'hello\n' }])).toEqual(['src/new.txt']);
    const diff = engine.diff(session);
    expect(diff.changed).toBe(true);
    expect(diff.files.map((f) => f.path)).toContain('src/new.txt');
    expect(() => readFileSync(path.join(repoRoot, 'src/new.txt'))).toThrow(); // live tree untouched
  });

  it('verify gate passes on exit 0 and fails on non-zero', () => {
    const session = open();
    expect(engine.verify(session, PASS).passed).toBe(true);
    expect(engine.verify(session, FAIL).passed).toBe(false);
  });

  it('commits a verified change to the session branch, leaving main untouched', () => {
    const mainHead = git(repoRoot, ['rev-parse', 'HEAD']).trim();
    const session = open();
    applyAndVerify(session, [{ path: 'docs/x.md', content: '# x\n' }]);
    const result = engine.commit(session, 'add x');
    expect(result.branch).toBe(session.branch);
    expect(git(session.worktreePath, ['log', '--oneline', '-1']).trim()).toContain('add x');
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(mainHead);
    expect(git(repoRoot, ['status', '--porcelain']).trim()).toBe('');
  });

  it('REFUSES to commit without a passing verify for the current tree', () => {
    const session = open();
    engine.applyChangeSet(session, [{ path: 'a.txt', content: 'a\n' }]);
    expect(() => engine.commit(session, 'no verify')).toThrow(/no passing verify/i);
  });

  it('REFUSES to commit if the tree changed after verify passed', () => {
    const session = open();
    applyAndVerify(session, [{ path: 'a.txt', content: 'a\n' }]);
    engine.applyChangeSet(session, [{ path: 'b.txt', content: 'b\n' }]); // invalidates the verify
    expect(() => engine.commit(session, 'stale verify')).toThrow(/no passing verify/i);
  });

  it('REFUSES to commit when the worktree is not on a dev-session branch', () => {
    const session = open();
    applyAndVerify(session, [{ path: 'a.txt', content: 'a\n' }]);
    git(session.worktreePath, ['switch', '-c', 'feature/sneaky']); // escape the namespace, keep the tree
    expect(() => engine.commit(session, 'nope')).toThrow(/not a .*session branch/i);
    git(session.worktreePath, ['switch', session.branch]);
    git(session.worktreePath, ['branch', '-D', 'feature/sneaky']);
  });

  it('rejects change-set paths that escape the worktree or hit protected areas', () => {
    const session = open();
    expect(() => engine.applyChangeSet(session, [{ path: '../escape.txt', content: 'x' }])).toThrow(/escapes the worktree/i);
    expect(() => engine.applyChangeSet(session, [{ path: 'node_modules/evil.js', content: 'x' }])).toThrow(/protected path/i);
    expect(() => engine.applyChangeSet(session, [{ path: '.git/config', content: 'x' }])).toThrow(/protected path/i);
    expect(() => engine.applyChangeSet(session, [{ path: '.githooks/pre-commit', content: 'x' }])).toThrow(/protected path/i);
    expect(() => readFileSync(path.join(base, 'escape.txt'))).toThrow();
  });

  it('rejects a change-set write that would tunnel through a symlinked directory', () => {
    const session = open();
    const outside = path.join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(session.worktreePath, 'sneaky'), 'junction'); // plant an escape symlink
    expect(() => engine.applyChangeSet(session, [{ path: 'sneaky/pwned.txt', content: 'x' }]))
      .toThrow(/symlink/i);
    expect(() => readFileSync(path.join(outside, 'pwned.txt'))).toThrow(); // nothing landed outside
  });

  it('rejects an untrusted (poisoned) session pointing outside worktreesRoot', () => {
    const session = open();
    const poisoned: DevSession = { ...session, worktreePath: repoRoot }; // point at the LIVE tree
    expect(() => engine.applyChangeSet(poisoned, [{ path: 'x.txt', content: 'x' }])).toThrow(/untrusted session/i);
    expect(() => engine.commit(poisoned, 'x')).toThrow(/untrusted session/i);
  });

  it('tears down the worktree and branch, leaving main intact', () => {
    const mainHead = git(repoRoot, ['rev-parse', 'HEAD']).trim();
    const session = engine.create();
    engine.teardown(session);
    expect(git(repoRoot, ['worktree', 'list']).includes(session.id)).toBe(false);
    expect(git(repoRoot, ['branch', '--list', session.branch]).trim()).toBe('');
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(mainHead);
  });

  it('constructor refuses a worktreesRoot inside the repo', () => {
    expect(() => new DevSessionEngine({ repoRoot, worktreesRoot: path.join(repoRoot, 'nested') }))
      .toThrow(/OUTSIDE repoRoot/i);
  });
});
