/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token-stranding fix proof: a mid-run rotation of the per-task auth.json is CAS-written back to the shared source (so the next task seeds the FRESH single-use refresh token), an unchanged run touches nothing, a moved source is never clobbered, and a failing write degrades to a logged no-op instead of failing the task. Covers the TS helper AND the JS CodexCLIWrapper twin so the two launch paths cannot drift apart silently.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Adversarial-review hardening proofs: content-validity guard (torn/injected bytes never reach the shared credential), ENOENT-create for secrets-seeded containers (replaces the old "never created" expectation — that behavior warn-looped the rotation into a permanent strand), reseedFromAdvancedSource (queued waiters pick up the fresh chain; an already-rotated copy is never clobbered), and the JS twin's failed/invalid/reseed branches.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  looksLikeCodexAuth,
  reseedFromAdvancedSource,
  snapshotCodexAuth,
  writeBackRotatedCodexAuth,
} from '../../src/features/llm-provider/services/codex-auth-write-back';
// The JS bot-node twin — same CAS rules, second launch path.
import CodexCLIWrapper from '../../any-bot/server/services/codebase/CodexCLIWrapper';

// last_refresh stamps matter: the re-seed only trusts a source that is provably NEWER.
const SEEDED = JSON.stringify({ auth_mode: 'chatgpt', last_refresh: '2026-07-12T10:00:00.000Z', tokens: { access_token: 'a1', refresh_token: 'r1' } });
const ROTATED = JSON.stringify({ auth_mode: 'chatgpt', last_refresh: '2026-07-12T11:00:00.000Z', tokens: { access_token: 'a2', refresh_token: 'r2' } });
const HOST_RELOGIN = JSON.stringify({ auth_mode: 'chatgpt', last_refresh: '2026-07-12T12:00:00.000Z', tokens: { access_token: 'a9', refresh_token: 'r9' } });
const UNSTAMPED = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'aX', refresh_token: 'rX' } });
const TORN = '{"auth_mode":"chatgpt","tokens":{"access_tok';           // SIGKILL mid-write
const INJECTED = JSON.stringify({ evil: true });                        // valid JSON, wrong shape

const LOG = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** One temp "world": a shared source auth.json + a per-task copy, both seeded identically. */
function makeWorld() {
  const root = mkdtempSync(join(tmpdir(), 'codex-writeback-'));
  const sourceDir = join(root, 'host-codex');
  const taskDir = join(root, 'task', '.codex-home', '.codex');
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(taskDir, { recursive: true });
  const sourcePath = join(sourceDir, 'auth.json');
  const taskAuthPath = join(taskDir, 'auth.json');
  writeFileSync(sourcePath, SEEDED, 'utf8');
  writeFileSync(taskAuthPath, SEEDED, 'utf8');
  return { root, sourceDir, sourcePath, taskDir, taskAuthPath };
}

const worlds: string[] = [];
function world() {
  const w = makeWorld();
  worlds.push(w.root);
  return w;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (worlds.length) {
    try { rmSync(worlds.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('writeBackRotatedCodexAuth (TS helper — the harness-adapter path)', () => {
  it('THE FIX: a mid-run rotation is written back, so the next task seeds the fresh token', () => {
    const w = world();
    const snapshot = snapshotCodexAuth(w.taskAuthPath);
    expect(snapshot).toBe(SEEDED);

    // The CLI spends the single-use refresh token and rewrites its per-task copy.
    writeFileSync(w.taskAuthPath, ROTATED, 'utf8');

    const outcome = writeBackRotatedCodexAuth(w.taskAuthPath, w.sourcePath, snapshot);
    expect(outcome).toBe('written');
    // The shared source now holds the rotated chain — a second task copying from it
    // authenticates without a host re-login. This is the two-sequential-tasks proof.
    expect(readFileSync(w.sourcePath, 'utf8')).toBe(ROTATED);
    // Atomic write left no temp debris next to the source.
    expect(readdirSync(w.sourceDir)).toEqual(['auth.json']);
  });

  it('no rotation → the source is not touched at all', () => {
    const w = world();
    const before = fs.statSync(w.sourcePath).mtimeMs;
    const outcome = writeBackRotatedCodexAuth(w.taskAuthPath, w.sourcePath, snapshotCodexAuth(w.taskAuthPath));
    expect(outcome).toBe('unchanged');
    expect(readFileSync(w.sourcePath, 'utf8')).toBe(SEEDED);
    expect(fs.statSync(w.sourcePath).mtimeMs).toBe(before);
  });

  it('CAS guard: a source that moved since seeding (host re-login) is NEVER clobbered', () => {
    const w = world();
    const snapshot = snapshotCodexAuth(w.taskAuthPath);
    writeFileSync(w.taskAuthPath, ROTATED, 'utf8');      // our run rotated…
    writeFileSync(w.sourcePath, HOST_RELOGIN, 'utf8');   // …but the operator re-logged in meanwhile

    const outcome = writeBackRotatedCodexAuth(w.taskAuthPath, w.sourcePath, snapshot);
    expect(outcome).toBe('source-moved');
    expect(readFileSync(w.sourcePath, 'utf8')).toBe(HOST_RELOGIN); // newer chain preserved
  });

  it('secrets-seeded container: a MISSING source is created (atomic tmp+link), persisting the rotation', () => {
    const w = world();
    const snapshot = snapshotCodexAuth(w.taskAuthPath);
    writeFileSync(w.taskAuthPath, ROTATED, 'utf8');
    rmSync(w.sourcePath); // no source file — seeding came from secrets.json
    expect(writeBackRotatedCodexAuth(w.taskAuthPath, w.sourcePath, snapshot)).toBe('written');
    // Later tasks in this container now seed the ROTATED chain from the file; no tmp debris.
    expect(readFileSync(w.sourcePath, 'utf8')).toBe(ROTATED);
    expect(readdirSync(w.sourceDir)).toEqual(['auth.json']);
  });

  it('a non-ENOENT source read error is reported as failed, never as source-moved', () => {
    const w = world();
    const snapshot = snapshotCodexAuth(w.taskAuthPath);
    writeFileSync(w.taskAuthPath, ROTATED, 'utf8');
    const realRead = fs.readFileSync.bind(fs);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      if (p === w.sourcePath) {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return realRead(p as never, o as never);
    }) as typeof fs.readFileSync);
    const log = LOG();
    expect(writeBackRotatedCodexAuth(w.taskAuthPath, w.sourcePath, snapshot, log)).toBe('failed');
    expect(log.error).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
    expect(readFileSync(w.sourcePath, 'utf8')).toBe(SEEDED); // untouched
  });

  it('content guard: a torn write (SIGKILL mid-rotation) is never propagated', () => {
    const w = world();
    const snapshot = snapshotCodexAuth(w.taskAuthPath);
    writeFileSync(w.taskAuthPath, TORN, 'utf8');
    const log = LOG();
    expect(writeBackRotatedCodexAuth(w.taskAuthPath, w.sourcePath, snapshot, log)).toBe('invalid');
    expect(readFileSync(w.sourcePath, 'utf8')).toBe(SEEDED);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('content guard: valid JSON without an auth shape (workspace injection) is never propagated', () => {
    const w = world();
    const snapshot = snapshotCodexAuth(w.taskAuthPath);
    writeFileSync(w.taskAuthPath, INJECTED, 'utf8');
    expect(writeBackRotatedCodexAuth(w.taskAuthPath, w.sourcePath, snapshot)).toBe('invalid');
    expect(readFileSync(w.sourcePath, 'utf8')).toBe(SEEDED);
  });

  it('skips cleanly when there is no snapshot, no source path, or no per-task file', () => {
    const w = world();
    expect(writeBackRotatedCodexAuth(w.taskAuthPath, w.sourcePath, null)).toBe('skipped');
    expect(writeBackRotatedCodexAuth(w.taskAuthPath, null, SEEDED)).toBe('skipped');
    rmSync(w.taskAuthPath);
    expect(writeBackRotatedCodexAuth(w.taskAuthPath, w.sourcePath, SEEDED)).toBe('skipped');
    expect(readFileSync(w.sourcePath, 'utf8')).toBe(SEEDED);
  });

  it('never throws into the task path: a failing rename (e.g. :ro mount) degrades to a logged no-op', () => {
    const w = world();
    const snapshot = snapshotCodexAuth(w.taskAuthPath);
    writeFileSync(w.taskAuthPath, ROTATED, 'utf8');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('EROFS: read-only file system'); });
    const log = LOG();

    const outcome = writeBackRotatedCodexAuth(w.taskAuthPath, w.sourcePath, snapshot, log);
    expect(outcome).toBe('failed');
    expect(log.error).toHaveBeenCalledOnce();
    expect(readFileSync(w.sourcePath, 'utf8')).toBe(SEEDED);   // source untouched
    vi.restoreAllMocks();
    expect(readdirSync(w.sourceDir)).toEqual(['auth.json']);   // tmp file cleaned up
  });

  it('snapshotCodexAuth returns null for a missing file (stale-workspace safety)', () => {
    const w = world();
    expect(snapshotCodexAuth(join(w.taskDir, 'nope.json'))).toBeNull();
  });
});

describe('looksLikeCodexAuth', () => {
  it('accepts OAuth-token and API-key shapes, rejects everything else', () => {
    expect(looksLikeCodexAuth(SEEDED)).toBe(true);
    expect(looksLikeCodexAuth(JSON.stringify({ OPENAI_API_KEY: 'sk-test' }))).toBe(true);
    expect(looksLikeCodexAuth(TORN)).toBe(false);
    expect(looksLikeCodexAuth(INJECTED)).toBe(false);
    expect(looksLikeCodexAuth(JSON.stringify({ OPENAI_API_KEY: '' }))).toBe(false);
    expect(looksLikeCodexAuth('[]')).toBe(false);
  });
});

describe('reseedFromAdvancedSource (gate waiters / lease queues pick up the fresh chain)', () => {
  it('an untouched copy is re-seeded when the source advanced, and the new snapshot is returned', () => {
    const w = world();
    const snapshot = snapshotCodexAuth(w.taskAuthPath);      // waiter seeded from stale S0
    writeFileSync(w.sourcePath, ROTATED, 'utf8');            // primer's write-back advanced the source

    const next = reseedFromAdvancedSource(w.taskAuthPath, w.sourcePath, snapshot);
    expect(next).toBe(ROTATED);
    expect(readFileSync(w.taskAuthPath, 'utf8')).toBe(ROTATED); // waiter now spawns on the live chain
  });

  it('an already-rotated copy is NEVER clobbered', () => {
    const w = world();
    const snapshot = snapshotCodexAuth(w.taskAuthPath);
    writeFileSync(w.taskAuthPath, ROTATED, 'utf8');          // this task's CLI rotated already
    writeFileSync(w.sourcePath, HOST_RELOGIN, 'utf8');       // source moved too

    const next = reseedFromAdvancedSource(w.taskAuthPath, w.sourcePath, snapshot);
    expect(next).toBe(snapshot);                             // snapshot unchanged → CAS stays honest
    expect(readFileSync(w.taskAuthPath, 'utf8')).toBe(ROTATED);
  });

  it('no source / source unchanged → no-op returning the original snapshot', () => {
    const w = world();
    const snapshot = snapshotCodexAuth(w.taskAuthPath);
    expect(reseedFromAdvancedSource(w.taskAuthPath, w.sourcePath, snapshot)).toBe(snapshot);
    expect(reseedFromAdvancedSource(w.taskAuthPath, null, snapshot)).toBe(snapshot);
  });

  it('DIRECTION GUARD: after a FAILED write-back the source holds the older dead chain — the live copy is kept', () => {
    const w = world();
    // Run 1 rotated SEEDED→ROTATED in the copy but its write-back failed: source still SEEDED.
    writeFileSync(w.taskAuthPath, ROTATED, 'utf8');
    const snapshot = snapshotCodexAuth(w.taskAuthPath); // run 2 baselines the LIVE chain

    const next = reseedFromAdvancedSource(w.taskAuthPath, w.sourcePath, snapshot);
    expect(next).toBe(snapshot);                                 // no re-seed —
    expect(readFileSync(w.taskAuthPath, 'utf8')).toBe(ROTATED);  // the only live chain survives
  });

  it('DIRECTION GUARD: an unstamped or garbage source never overwrites a stamped copy', () => {
    const w = world();
    const snapshot = snapshotCodexAuth(w.taskAuthPath);
    writeFileSync(w.sourcePath, UNSTAMPED, 'utf8');
    expect(reseedFromAdvancedSource(w.taskAuthPath, w.sourcePath, snapshot)).toBe(snapshot);
    writeFileSync(w.sourcePath, TORN, 'utf8');
    expect(reseedFromAdvancedSource(w.taskAuthPath, w.sourcePath, snapshot)).toBe(snapshot);
    expect(readFileSync(w.taskAuthPath, 'utf8')).toBe(SEEDED);
  });

  it('a MISSING copy is seeded from an existing source (sibling ENOENT-create made one)', () => {
    const w = world();
    rmSync(w.taskAuthPath);
    const next = reseedFromAdvancedSource(w.taskAuthPath, w.sourcePath, null);
    expect(next).toBe(SEEDED);
    expect(readFileSync(w.taskAuthPath, 'utf8')).toBe(SEEDED);
  });
});

describe('CodexCLIWrapper twin (JS bot-node path — same CAS rules, must not drift)', () => {
  function wrapperFor(sourcePath: string) {
    // spawnImpl stub: these tests never spawn, but the constructor stores it.
    return new CodexCLIWrapper({ authSourcePath: sourcePath, spawnImpl: () => { throw new Error('not spawned in this test'); } });
  }

  it('writes a rotation back to the source', () => {
    const w = world();
    const wrapper = wrapperFor(w.sourcePath);
    const snapshot = wrapper._snapshotAuth(w.taskDir);
    expect(snapshot).toBe(SEEDED);
    writeFileSync(w.taskAuthPath, ROTATED, 'utf8');
    expect(wrapper._writeBackAuth(w.taskDir, snapshot)).toBe('written');
    expect(readFileSync(w.sourcePath, 'utf8')).toBe(ROTATED);
    expect(readdirSync(w.sourceDir)).toEqual(['auth.json']);
  });

  it('is a no-op when the copy did not change', () => {
    const w = world();
    const wrapper = wrapperFor(w.sourcePath);
    expect(wrapper._writeBackAuth(w.taskDir, wrapper._snapshotAuth(w.taskDir))).toBe('unchanged');
    expect(readFileSync(w.sourcePath, 'utf8')).toBe(SEEDED);
  });

  it('never clobbers a moved source', () => {
    const w = world();
    const wrapper = wrapperFor(w.sourcePath);
    const snapshot = wrapper._snapshotAuth(w.taskDir);
    writeFileSync(w.taskAuthPath, ROTATED, 'utf8');
    writeFileSync(w.sourcePath, HOST_RELOGIN, 'utf8');
    expect(wrapper._writeBackAuth(w.taskDir, snapshot)).toBe('source-moved');
    expect(readFileSync(w.sourcePath, 'utf8')).toBe(HOST_RELOGIN);
  });

  it('creates a MISSING source (secrets-seeded container) with the rotated chain', () => {
    const w = world();
    const wrapper = wrapperFor(w.sourcePath);
    const snapshot = wrapper._snapshotAuth(w.taskDir);
    writeFileSync(w.taskAuthPath, ROTATED, 'utf8');
    rmSync(w.sourcePath);
    expect(wrapper._writeBackAuth(w.taskDir, snapshot)).toBe('written');
    expect(readFileSync(w.sourcePath, 'utf8')).toBe(ROTATED);
  });

  it('blocks torn/injected content from the shared credential', () => {
    const w = world();
    const wrapper = wrapperFor(w.sourcePath);
    const snapshot = wrapper._snapshotAuth(w.taskDir);
    writeFileSync(w.taskAuthPath, TORN, 'utf8');
    expect(wrapper._writeBackAuth(w.taskDir, snapshot)).toBe('invalid');
    writeFileSync(w.taskAuthPath, INJECTED, 'utf8');
    expect(wrapper._writeBackAuth(w.taskDir, snapshot)).toBe('invalid');
    expect(readFileSync(w.sourcePath, 'utf8')).toBe(SEEDED);
  });

  it('never throws when the rename fails — degrades to a logged no-op (the .finally safety)', () => {
    const w = world();
    const wrapper = wrapperFor(w.sourcePath);
    const snapshot = wrapper._snapshotAuth(w.taskDir);
    writeFileSync(w.taskAuthPath, ROTATED, 'utf8');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('EROFS: read-only file system'); });
    expect(wrapper._writeBackAuth(w.taskDir, snapshot)).toBe('failed');
    expect(readFileSync(w.sourcePath, 'utf8')).toBe(SEEDED);
    vi.restoreAllMocks();
    expect(readdirSync(w.sourceDir)).toEqual(['auth.json']);
  });

  it('re-seeds an untouched copy from an advanced source, never an already-rotated one', () => {
    const w = world();
    const wrapper = wrapperFor(w.sourcePath);
    const snapshot = wrapper._snapshotAuth(w.taskDir);
    writeFileSync(w.sourcePath, ROTATED, 'utf8');
    expect(wrapper._reseedFromSource(w.taskDir, snapshot)).toBe(ROTATED);
    expect(readFileSync(w.taskAuthPath, 'utf8')).toBe(ROTATED);

    // Now the copy rotates further; a second source move must not clobber it.
    writeFileSync(w.taskAuthPath, HOST_RELOGIN, 'utf8');
    writeFileSync(w.sourcePath, SEEDED, 'utf8');
    expect(wrapper._reseedFromSource(w.taskDir, ROTATED)).toBe(ROTATED);
    expect(readFileSync(w.taskAuthPath, 'utf8')).toBe(HOST_RELOGIN);
  });

  it('DIRECTION GUARD: keeps the live copy when the source holds the older dead chain (failed prior write-back)', () => {
    const w = world();
    const wrapper = wrapperFor(w.sourcePath);
    writeFileSync(w.taskAuthPath, ROTATED, 'utf8');           // live chain, write-back failed earlier
    const snapshot = wrapper._snapshotAuth(w.taskDir);        // source still holds older SEEDED
    expect(wrapper._reseedFromSource(w.taskDir, snapshot)).toBe(snapshot);
    expect(readFileSync(w.taskAuthPath, 'utf8')).toBe(ROTATED);
  });

  it('skips on a null snapshot (missing auth at spawn time)', () => {
    const w = world();
    const wrapper = wrapperFor(w.sourcePath);
    expect(wrapper._writeBackAuth(w.taskDir, null)).toBe('skipped');
  });
});

describe('acquireUserScoping lease (JS) — unconditional, so same-workspace runs never interleave', () => {
  it('an UNSCOPED request (no sub, no creds) still serializes behind a prior holder', async () => {
    const { acquireUserScoping } = await import('../../any-bot/server/services/codebase/user-scoping');
    const w = world();

    const first = await acquireUserScoping(w.root, undefined);
    let secondAcquired = false;
    const secondPromise = acquireUserScoping(w.root, undefined).then((lease: { release: () => void }) => {
      secondAcquired = true;
      return lease;
    });

    // Give the second acquisition every chance to (wrongly) slip through.
    await new Promise((r) => setTimeout(r, 25));
    expect(secondAcquired).toBe(false);   // pre-fix this was true: the no-op fast path skipped the tail

    first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    second.release();

    // And it wrote no scoping files — unscoped requests only serialize, never scope.
    expect(readdirSync(w.root).filter((f) => f.startsWith('.oshal-'))).toEqual([]);
  });
});
