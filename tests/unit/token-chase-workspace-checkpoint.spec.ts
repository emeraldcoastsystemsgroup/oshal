/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-git guard for the workspace checkpoint (BACKLOG "Workspace-bound checkpoint and tail replay", ADR-046 §1): commits are built from the redacted objects in a PRIVATE .tokenchase/git repository with a private index; the task's own .git and index are byte-untouched; the commit/tree SHAs are stable for an identical tree and chain to the previous seq; restore yields a byte-identical tree for non-redacted files while a redacted path is named; and a git failure fails OPEN to null rather than fabricating a SHA.
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const requireModule = createRequire(import.meta.url);
const checkpoint = requireModule('../../any-bot/server/services/token-chase/workspace-checkpoint.js') as {
  snapshotWorkspaceTree(dir: string, objectDir: string, redact: (t: string) => string): { files: Array<{ path: string; sha256: string }>; treeSha: string; complete: boolean; redactedPaths: string[] };
  digestWorkspaceTree(dir: string, redact: (t: string) => string): { files: Array<{ path: string; sha256: string }>; treeSha: string };
  commitCheckpoint(input: { captureDir: string; taskId: string; seq: number | string; files: Array<{ path: string; sha256: string }>; objectDir: string; parentSeq?: number | null }): { workspaceCommit: string | null; gitTreeSha: string | null; ref: string; error: string | null };
  restoreCheckpoint(input: { captureDir: string; sha: string; targetDir: string }): { restored: number; sha: string };
  checkpointRef(taskId: string, seq: number | string): string;
};

const identity = (t: string): string => t;
const scrub = (t: string): string => t.replace(/hunter2secret/g, '[REDACTED]');
const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ckpt-'));
  roots.push(root);
  return root;
}
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

/** A workspace with its OWN git repo (index + HEAD) so the checkpoint can be proven not to touch it. */
function workspaceWithOwnRepo(): { workspace: string; captureDir: string; objectDir: string } {
  const workspace = path.join(tempRoot(), 'task-1');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'main.txt'), 'hello checkpoint\n');
  fs.writeFileSync(path.join(workspace, 'notes.md'), 'plain notes\n');
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@oshal.example.com', 'add', '.'], { cwd: workspace });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@oshal.example.com', 'commit', '-q', '-m', 'task repo'], { cwd: workspace });
  const captureDir = path.join(workspace, '.tokenchase');
  return { workspace, captureDir, objectDir: path.join(captureDir, 'objects') };
}

function taskRepoState(workspace: string): { head: string; index: Buffer; status: string } {
  return {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(),
    index: fs.readFileSync(path.join(workspace, '.git', 'index')),
    status: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: workspace, encoding: 'utf8' }),
  };
}

describe('Token Chase workspace checkpoint (real git, private repository)', () => {
  it('commits the redacted snapshot under refs/tokenchase/<task>/<seq> without touching the task repo', () => {
    const { workspace, captureDir, objectDir } = workspaceWithOwnRepo();
    const before = taskRepoState(workspace);

    const snapshot = checkpoint.snapshotWorkspaceTree(workspace, objectDir, identity);
    const first = checkpoint.commitCheckpoint({ captureDir, taskId: 'task-1', seq: 1, files: snapshot.files, objectDir });

    expect(first.error).toBeNull();
    expect(first.workspaceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(first.ref).toBe('refs/tokenchase/task-1/1');
    const gitDir = path.join(captureDir, 'git');
    const shown = execFileSync('git', ['--git-dir', gitDir, 'ls-tree', '-r', '--name-only', first.workspaceCommit!], { encoding: 'utf8' });
    expect(shown.trim().split(/\r?\n/).sort()).toEqual(['notes.md', 'src/main.txt']);
    expect(execFileSync('git', ['--git-dir', gitDir, 'rev-parse', first.ref], { encoding: 'utf8' }).trim()).toBe(first.workspaceCommit);

    // The task's own repository is byte-for-byte where it was: same HEAD, same index bytes, no status.
    const after = taskRepoState(workspace);
    expect(after.head).toBe(before.head);
    expect(after.index.equals(before.index)).toBe(true);
    expect(after.status).toBe(before.status);
    expect(fs.existsSync(path.join(workspace, '.git', 'refs', 'tokenchase'))).toBe(false);
    expect(fs.readdirSync(gitDir).filter((n) => n.startsWith('index-'))).toEqual([]);
  });

  it('yields a stable SHA for an identical tree and chains to the previous seq', () => {
    const { workspace, captureDir, objectDir } = workspaceWithOwnRepo();
    const snapshot = checkpoint.snapshotWorkspaceTree(workspace, objectDir, identity);
    const a = checkpoint.commitCheckpoint({ captureDir, taskId: 'task-1', seq: 1, files: snapshot.files, objectDir });
    const again = checkpoint.commitCheckpoint({ captureDir, taskId: 'task-1', seq: 1, files: snapshot.files, objectDir });
    expect(again.workspaceCommit).toBe(a.workspaceCommit);
    expect(again.gitTreeSha).toBe(a.gitTreeSha);

    const second = checkpoint.commitCheckpoint({ captureDir, taskId: 'task-1', seq: 2, files: snapshot.files, objectDir });
    expect(second.gitTreeSha).toBe(a.gitTreeSha); // identical tree, identical tree object
    expect(second.workspaceCommit).not.toBe(a.workspaceCommit); // but a new commit with a parent
    const parent = execFileSync('git', ['--git-dir', path.join(captureDir, 'git'), 'rev-parse', `${second.workspaceCommit}^`], { encoding: 'utf8' }).trim();
    expect(parent).toBe(a.workspaceCommit);

    // A different tree is a different commit; the digest side agrees.
    fs.writeFileSync(path.join(workspace, 'notes.md'), 'changed notes\n');
    const changed = checkpoint.snapshotWorkspaceTree(workspace, objectDir, identity);
    expect(changed.treeSha).not.toBe(snapshot.treeSha);
    const third = checkpoint.commitCheckpoint({ captureDir, taskId: 'task-1', seq: 3, files: changed.files, objectDir });
    expect(third.gitTreeSha).not.toBe(a.gitTreeSha);
  });

  it('restores a commit into an isolated directory byte-identically for non-redacted files, naming redacted paths', () => {
    const { workspace, captureDir, objectDir } = workspaceWithOwnRepo();
    fs.writeFileSync(path.join(workspace, 'creds.txt'), 'password: hunter2secret\n');
    const snapshot = checkpoint.snapshotWorkspaceTree(workspace, objectDir, scrub);
    expect(snapshot.redactedPaths).toEqual(['creds.txt']);
    const commit = checkpoint.commitCheckpoint({ captureDir, taskId: 'task-1', seq: 1, files: snapshot.files, objectDir });

    const target = path.join(tempRoot(), 'restored');
    const restore = checkpoint.restoreCheckpoint({ captureDir, sha: commit.workspaceCommit!, targetDir: target });

    expect(restore.restored).toBe(3);
    expect(fs.readFileSync(path.join(target, 'src', 'main.txt')).equals(fs.readFileSync(path.join(workspace, 'src', 'main.txt')))).toBe(true);
    expect(fs.readFileSync(path.join(target, 'notes.md')).equals(fs.readFileSync(path.join(workspace, 'notes.md')))).toBe(true);
    // The redacted file restores as the REDACTED bytes: no raw secret ever entered the checkpoint.
    expect(fs.readFileSync(path.join(target, 'creds.txt'), 'utf8')).toBe('password: [REDACTED]\n');
    for (const name of fs.readdirSync(objectDir)) expect(fs.readFileSync(path.join(objectDir, name), 'utf8')).not.toContain('hunter2secret');
    // The restored tree digests to the captured tree digest: this is the artifact comparison a replay makes.
    expect(checkpoint.digestWorkspaceTree(target, scrub).treeSha).toBe(snapshot.treeSha);
    // Neither the task .git nor the capture repo grew a work tree/index side effect.
    expect(fs.existsSync(path.join(target, '.git'))).toBe(false);
    expect(fs.readdirSync(path.join(captureDir, 'git')).filter((n) => n.startsWith('index-'))).toEqual([]);
  });

  it('refuses a malformed sha and fails OPEN to null on a git failure — never a fabricated commit', () => {
    const { captureDir, objectDir } = workspaceWithOwnRepo();
    expect(() => checkpoint.restoreCheckpoint({ captureDir, sha: 'not-a-sha', targetDir: path.join(tempRoot(), 'x') })).toThrow(/40-hex/);
    // A manifest naming an object that is not in the store cannot be hashed by git.
    const missing = crypto.createHash('sha256').update('never written').digest('hex');
    const result = checkpoint.commitCheckpoint({ captureDir, taskId: 'task-1', seq: 1, files: [{ path: 'ghost.txt', sha256: missing }], objectDir });
    expect(result.workspaceCommit).toBeNull();
    expect(result.gitTreeSha).toBeNull();
    expect(typeof result.error).toBe('string');
    expect(checkpoint.checkpointRef('task/with spaces', 'final')).toBe('refs/tokenchase/task_with_spaces/final');
  });
});
