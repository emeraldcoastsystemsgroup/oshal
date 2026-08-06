/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard exact dual-channel scoping, approved atomic 0600 writes, linked/nonregular target and parent refusal, hard-link safety, race-safe publish, and identity-owned cleanup.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: assert workspace scoping ignores credential carriers and publishes only invocation-owned identity markers.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireModule = createRequire(import.meta.url);
const writer = requireModule('../../any-bot/server/services/codebase/scoped-file-writer.js') as {
  writeScopedFile(filePath: string, value: string): Record<string, unknown>;
  removeOwnedScopedFile(identity: Record<string, unknown>): boolean;
};
const scoping = requireModule('../../any-bot/server/services/codebase/user-scoping.js') as {
  applyUserScoping(workspace: string, env: Record<string, unknown>): Record<string, string>;
  acquireUserScoping(workspace: string, env: Record<string, unknown>): Promise<{
    env: Record<string, string>;
    release(): void;
  }>;
  wipeUserScoping(workspace: string): void;
};

let root: string;
let outside: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-scoped-files-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-scoped-outside-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

/** Create a directory link without requiring Windows file-symlink privileges. */
function linkDirectory(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

/** List invocation temporary files left in one workspace. */
function scopedTemps(directory = root): string[] {
  return fs.readdirSync(directory).filter((name) => name.includes('.tmp-'));
}

describe('safe any-bot scoped-file publication', () => {
  it('preserves exact subjects, ignores credentials, publishes privately, and wipes only owned files', () => {
    const exactSub = ' Auth0|Case-Sensitive ';
    const env = scoping.applyUserScoping(root, {
      OSHAL_USER_SUB: exactSub,
      OSHAL_CRED_GOOGLE: 'short-lived-google-token',
      PATH: 'C:\\attacker',
    });

    expect(env.OSHAL_USER_SUB).toBe(exactSub);
    expect(env).not.toHaveProperty('OSHAL_CRED_GOOGLE');
    expect(env).not.toHaveProperty('PATH');
    expect(fs.readFileSync(path.join(root, '.oshal-user-sub'), 'utf8')).toBe(exactSub);
    expect(fs.existsSync(path.join(root, '.oshal-cred-google'))).toBe(false);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(root, '.oshal-user-sub')).mode & 0o777).toBe(0o600);
    }
    expect(scopedTemps()).toEqual([]);

    scoping.wipeUserScoping(root);
    expect(fs.existsSync(path.join(root, '.oshal-user-sub'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.oshal-user-key'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.oshal-cred-google'))).toBe(false);
  });

  it('rejects invalid supplied subjects before creating any scoped file', () => {
    const invalid = ['', 'owner\u0000alias', 'owner\u0085alias', 'x'.repeat(513), '\ud800', 42];
    for (const value of invalid) {
      expect(() => scoping.applyUserScoping(root, { OSHAL_USER_SUB: value }), String(value))
        .toThrow(/exact UTF-8/);
      expect(fs.readdirSync(root)).toEqual([]);
    }
    expect(scoping.applyUserScoping(root, { OSHAL_USER_SUB: '   ' }).OSHAL_USER_SUB).toBe('   ');
  });

  it('rejects linked/nonregular targets and linked parents without touching external data', () => {
    const marker = path.join(outside, 'marker.txt');
    fs.writeFileSync(marker, 'outside-data');
    linkDirectory(outside, path.join(root, '.oshal-user-sub'));
    expect(() => scoping.applyUserScoping(root, { OSHAL_USER_SUB: 'owner-a' }))
      .toThrow(/Unsafe scoped file/);
    expect(fs.readFileSync(marker, 'utf8')).toBe('outside-data');

    fs.rmSync(path.join(root, '.oshal-user-sub'), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, '.oshal-user-key'));
    expect(() => scoping.applyUserScoping(root, { OSHAL_USER_SUB: 'owner-a' }))
      .toThrow(/Unsafe scoped file/);
    expect(fs.existsSync(path.join(root, '.oshal-user-sub'))).toBe(false);

    fs.rmSync(path.join(root, '.oshal-user-key'), { recursive: true, force: true });
    const linkedWorkspace = path.join(root, 'linked-workspace');
    linkDirectory(outside, linkedWorkspace);
    expect(() => scoping.applyUserScoping(linkedWorkspace, { OSHAL_USER_SUB: 'owner-a' }))
      .toThrow(/linked parent/);
    expect(fs.existsSync(path.join(outside, '.oshal-user-sub'))).toBe(false);
  });

  it('replaces a hard-linked target entry without modifying its external referent', () => {
    const externalSecret = path.join(outside, 'external-secret.txt');
    const target = path.join(root, '.oshal-user-sub');
    fs.writeFileSync(externalSecret, 'external-original');
    fs.linkSync(externalSecret, target);

    writer.writeScopedFile(target, 'request-subject');

    expect(fs.readFileSync(externalSecret, 'utf8')).toBe('external-original');
    expect(fs.readFileSync(target, 'utf8')).toBe('request-subject');
    expect(fs.statSync(externalSecret).ino).not.toBe(fs.statSync(target).ino);
  });

  it('leaves a raced replacement untouched when an invocation releases its scope', async () => {
    const lease = await scoping.acquireUserScoping(root, {
      OSHAL_USER_SUB: 'owner-a',
      OSHAL_CRED_GOOGLE: 'request-token',
    });
    const subjectPath = path.join(root, '.oshal-user-sub');
    fs.unlinkSync(subjectPath);
    fs.writeFileSync(subjectPath, 'attacker-replacement', { mode: 0o600 });

    lease.release();

    expect(fs.readFileSync(subjectPath, 'utf8')).toBe('attacker-replacement');
    expect(fs.existsSync(path.join(root, '.oshal-user-key'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.oshal-cred-google'))).toBe(false);
  });

  it('never follows a target planted in the final publish race and cleans its temp', () => {
    const marker = path.join(outside, 'marker.txt');
    const target = path.join(root, '.oshal-user-sub');
    fs.writeFileSync(marker, 'outside-data');
    const realRename = fs.renameSync.bind(fs);
    let planted = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!planted && path.resolve(String(to)) === path.resolve(target)) {
        planted = true;
        linkDirectory(outside, target);
      }
      return realRename(from, to);
    });

    let identity: Record<string, unknown> | undefined;
    let refusal: unknown;
    try { identity = writer.writeScopedFile(target, 'request-subject'); }
    catch (error) { refusal = error; }

    expect(planted).toBe(true);
    expect(fs.readFileSync(marker, 'utf8')).toBe('outside-data');
    expect(scopedTemps()).toEqual([]);
    if (identity) {
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(target, 'utf8')).toBe('request-subject');
    } else {
      expect(refusal).toBeDefined();
    }
  });
});
