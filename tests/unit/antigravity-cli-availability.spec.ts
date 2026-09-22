/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the two measured facts that decide whether a node can serve an Antigravity turn, asked without spawning anything. The binary is resolved by PATH-FREE existence check against a real file on a real temp path, because the vendor installer's TARGET_DIR is not on PATH and an earlier probe concluded the CLI was absent on a machine that plainly had it. The libc half is pinned as the shared probe the harness adapter now delegates to, so the musl diagnosis has one home rather than two copies that can drift. No real install, no real home directory and no spawn is involved in any case here.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_BINARY_NAME,
  antigravityMuslBlockingReason,
  antigravityNodeReadiness,
  resolveAntigravityCliBinary,
} from '../../src/features/llm-provider';

let root = '';

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-agy-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** A real file at a path no real user owns, standing in for the vendor binary. */
function placeBinary(...segments: string[]): string {
  const file = path.join(root, ...segments);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not a real binary', 'utf8');
  return file;
}

describe('finding the Antigravity binary', () => {
  it('takes the explicit path when it exists, and refuses it when it does not', () => {
    const binary = placeBinary('explicit', 'agy.exe');
    expect(resolveAntigravityCliBinary({ ANTIGRAVITY_CLI_PATH: binary })).toBe(binary);
    // A configured path that is wrong is an answer of NO, never a silent fall back to a guess:
    // otherwise an operator who mistyped it would get a different install than the one they named.
    expect(resolveAntigravityCliBinary({
      ANTIGRAVITY_CLI_PATH: path.join(root, 'nope', 'agy.exe'),
      LOCALAPPDATA: path.dirname(path.dirname(path.dirname(binary))),
    })).toBeNull();
  });

  it('finds the installer default under LOCALAPPDATA without consulting PATH', () => {
    // The vendor installer's TARGET_DIR. It does NOT add this directory to PATH, which is why a
    // `which agy` miss proves nothing and resolution is by existence instead.
    const binary = placeBinary('agy', 'bin', 'agy.exe');
    expect(resolveAntigravityCliBinary({ LOCALAPPDATA: root })).toBe(binary);
  });

  it('finds the POSIX default under the home directory', () => {
    const binary = placeBinary('.local', 'share', 'agy', 'bin', ANTIGRAVITY_BINARY_NAME);
    expect(resolveAntigravityCliBinary({ HOME: root })).toBe(binary);
  });

  it('answers null when nothing is installed, rather than a bare command name', () => {
    expect(resolveAntigravityCliBinary({ HOME: root, LOCALAPPDATA: root })).toBeNull();
    expect(resolveAntigravityCliBinary({})).toBeNull();
  });
});

describe('whether this node could run it at all', () => {
  it('reports the binary as the missing piece when the libc is not the problem', () => {
    const readiness = antigravityNodeReadiness({ HOME: root, LOCALAPPDATA: root });
    if (antigravityMuslBlockingReason()) {
      // On a musl node the libc answer wins and must be the one reported — the binary being
      // absent is true but irrelevant, and naming it would send an operator to install a binary
      // that still could not load.
      expect(readiness.reason).toBe('musl-node');
      expect(readiness.detail).toContain('musl');
    } else {
      expect(readiness).toEqual({
        runnable: false,
        reason: 'binary-absent',
        detail: expect.stringContaining('ANTIGRAVITY_CLI_PATH') as unknown as string,
      });
    }
    expect(readiness.runnable).toBe(false);
  });

  it('is runnable only when a binary is actually present on a node that can load it', () => {
    const binary = placeBinary('agy', 'bin', 'agy.exe');
    const readiness = antigravityNodeReadiness({ ANTIGRAVITY_CLI_PATH: binary });
    if (antigravityMuslBlockingReason()) {
      expect(readiness.runnable).toBe(false);
      expect(readiness.reason).toBe('musl-node');
    } else {
      expect(readiness).toEqual({ runnable: true, reason: null, detail: '' });
    }
  });

  it('never reports a libc block off linux, where the question does not apply', () => {
    if (process.platform !== 'linux') expect(antigravityMuslBlockingReason()).toBeNull();
    else expect(typeof antigravityMuslBlockingReason()).toMatch(/string|object/);
  });
});
