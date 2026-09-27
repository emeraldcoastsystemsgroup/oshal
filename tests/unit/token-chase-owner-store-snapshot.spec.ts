/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the encrypted owner-store version + ciphertext-only restore (BACKLOG "Workspace-bound checkpoint and tail replay", ADR-046 §1): the version is stable and changes after a write; the snapshot copies CIPHERTEXT only (no plaintext under .tokenchase, proven by scanning every object for the plaintext); a restore is byte-identical and decrypts with the owner's key and ONLY that owner's; a symlinked store file is refused through the real exact-subject-store guards; and a node with no configured store reports bound:false instead of a made-up version.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Wiring seam: the bot-node server installs the snapshotter on the capture lane (configureOwnerStore over readOwnerStoreConfig) and the feature barrel exports it, so a frame's ownerStoreVersion has a real producer on every worker rather than a contract nobody calls.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The config case opts in (TOKEN_CHASE_OWNER_STORE_SNAPSHOT=on) before expecting a bound root: a vault root alone no longer binds the snapshotter (the opt-in itself is guarded by token-chase-owner-store-opt-in.spec.ts).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | The snapshotter is async, incremental, deduplicated and size-capped. New cases over a real vault on disk: a second snapshot into the same node directory copies zero objects; an unchanged file (mtime outside the racy window) is not re-read (hashed 0), a changed one is, a just-written one is re-hashed, and a cached digest whose object disappeared is re-read and re-copied; a store above the total ceiling is refused before anything is read (skipped 'too_large', measuredBytes, nothing copied); a file that vanishes between listing and reading leaves the snapshot incomplete instead of failing it; the walk interleaves with the event loop rather than holding it; and the config reads the total ceiling and the object directory.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  computeOwnerStoreVersion,
  createOwnerStoreSnapshotter,
  DEFAULT_OWNER_STORE_MAX_TOTAL_BYTES,
  readOwnerStoreConfig,
} from '../../src/features/token-chase/services/owner-store-snapshot';
import { ensureExactSubjectStoreDirectory } from '../../src/shared/security/exact-subject-store';
import { decryptField, encryptField } from '../../src/features/personal-data/vault-crypto';
import * as tokenChaseBarrel from '../../src/features/token-chase';

const OWNER = 'auth0|token-chase-owner';
const OTHER = 'auth0|token-chase-other';
const TENANT = 'default';
const PLAINTEXT = 'the quick brown vault entry';
const HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000);
const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-store-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});
beforeAll(() => { process.env.SESSION_SECRET = 'token-chase-owner-store-test-secret-0001'; });

/** Seeds one owner's vault with an AES-256-GCM field the way the Personal Data Vault stores it. */
function seedVault(storeRoot: string, owner: string, plaintext = PLAINTEXT): { vaultDir: string; file: string } {
  const subject = ensureExactSubjectStoreDirectory(storeRoot, TENANT, owner);
  const vaultDir = path.join(subject.subjectDir, 'vault');
  fs.mkdirSync(vaultDir, { recursive: true });
  const file = path.join(vaultDir, 'entities.enc');
  fs.writeFileSync(file, encryptField(owner, plaintext)!, 'utf8');
  return { vaultDir, file };
}

/** Writes one more ciphertext file into the vault, dated an hour ago so the stat cache may trust it. */
function addSettledFile(vaultDir: string, name: string, plaintext: string, when = HOUR_AGO): string {
  const file = path.join(vaultDir, name);
  fs.writeFileSync(file, encryptField(OWNER, plaintext)!, 'utf8');
  fs.utimesSync(file, when, when);
  return file;
}

/** Every byte written under the capture dir, so plaintext can be proven absent. */
function scanForPlaintext(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (fs.readFileSync(p, 'latin1').includes(needle)) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}

describe('Token Chase owner-store snapshot (ciphertext only)', () => {
  it('versions the store stably, changes after a write, and copies only ciphertext', async () => {
    const storeRoot = tempRoot();
    const capture = path.join(tempRoot(), '.tokenchase');
    const objectDir = path.join(capture, 'store-objects');
    const { file } = seedVault(storeRoot, OWNER);
    const store = createOwnerStoreSnapshotter({ storeRoot, tenant: TENANT, maxObjectBytes: 1024 * 1024 });
    expect(store.bound).toBe(true);

    const first = await store.snapshot(OWNER, objectDir);
    expect(first.version).toMatch(/^[0-9a-f]{64}$/);
    expect(first.complete).toBe(true);
    expect(first.files.map((f) => f.path)).toEqual(['vault/entities.enc']);
    expect((await store.version(OWNER)).version).toBe(first.version);
    expect((await store.snapshot(OWNER, objectDir)).version).toBe(first.version);
    expect(first.version).toBe(computeOwnerStoreVersion(first.files));

    // The object is the stored ciphertext byte for byte, and the plaintext appears nowhere under the capture.
    const stored = fs.readFileSync(path.join(objectDir, first.files[0].sha256));
    expect(stored.equals(fs.readFileSync(file))).toBe(true);
    expect(stored.toString('utf8').startsWith('v1:')).toBe(true);
    expect(scanForPlaintext(capture, PLAINTEXT)).toEqual([]);

    fs.writeFileSync(file, encryptField(OWNER, 'a different entry')!, 'utf8');
    const second = await store.snapshot(OWNER, objectDir);
    expect(second.version).not.toBe(first.version);
    expect(fs.readdirSync(objectDir)).toHaveLength(2);
    // An owner with no directory yet has the stable empty version, distinct from "no store".
    expect((await store.version(OTHER)).version).toBe(computeOwnerStoreVersion([]));
  });

  it('restores byte-identical ciphertext into an isolated root that decrypts for the owner only', async () => {
    const storeRoot = tempRoot();
    const objectDir = path.join(tempRoot(), 'store-objects');
    const { file } = seedVault(storeRoot, OWNER);
    const store = createOwnerStoreSnapshotter({ storeRoot, tenant: TENANT, maxObjectBytes: 1024 * 1024 });
    const manifest = await store.snapshot(OWNER, objectDir);

    const isolatedRoot = path.join(tempRoot(), 'replay-store');
    const restore = store.restore(manifest, objectDir, isolatedRoot, OWNER);

    expect(restore.restored).toBe(1);
    expect(restore.version).toBe(manifest.version);
    const restored = path.join(restore.subjectDir, 'vault', 'entities.enc');
    expect(fs.readFileSync(restored).equals(fs.readFileSync(file))).toBe(true);
    expect(decryptField(OWNER, fs.readFileSync(restored, 'utf8'))).toBe(PLAINTEXT);
    // Another owner's key cannot open it: decryptField returns the envelope unchanged on auth failure.
    expect(decryptField(OTHER, fs.readFileSync(restored, 'utf8'))).not.toBe(PLAINTEXT);
    // The isolated root re-versions to the same identity and is bound to the same exact subject.
    const isolated = createOwnerStoreSnapshotter({ storeRoot: isolatedRoot, tenant: TENANT, maxObjectBytes: 1024 * 1024 });
    expect((await isolated.version(OWNER)).version).toBe(manifest.version);
    expect((await store.versionAt(isolatedRoot, OWNER)).version).toBe(manifest.version);
    expect(fs.readFileSync(path.join(restore.subjectDir, '.oshal-user-sub'), 'utf8')).toBe(OWNER);
    expect(scanForPlaintext(isolatedRoot, PLAINTEXT)).toEqual([]);
    // A manifest that names a tampered object is refused by its digest check.
    const tampered = { ...manifest, files: [{ ...manifest.files[0], sha256: crypto.createHash('sha256').update('nope').digest('hex') }] };
    expect(() => store.restore(tampered, objectDir, path.join(tempRoot(), 'r2'), OWNER)).toThrow();
  });

  it('refuses a linked store file and a traversing manifest path', async () => {
    const storeRoot = tempRoot();
    const { vaultDir } = seedVault(storeRoot, OWNER);
    const outside = path.join(tempRoot(), 'outside.enc');
    fs.writeFileSync(outside, encryptField(OWNER, 'outside')!, 'utf8');
    let linked = false;
    try { fs.symlinkSync(outside, path.join(vaultDir, 'linked.enc'), 'file'); linked = true; } catch { linked = false; }
    const store = createOwnerStoreSnapshotter({ storeRoot, tenant: TENANT, maxObjectBytes: 1024 * 1024 });
    if (linked) {
      await expect(store.snapshot(OWNER, path.join(tempRoot(), 'objects'))).rejects.toThrow(/link/i);
    } else {
      // Symlink creation needs a privilege this host lacks; the guard is exercised by the traversal case below.
      expect((await store.snapshot(OWNER, path.join(tempRoot(), 'objects'))).complete).toBe(true);
    }
    if (linked) fs.rmSync(path.join(vaultDir, 'linked.enc'));
    const objectDir = path.join(tempRoot(), 'objects2');
    const manifest = await store.snapshot(OWNER, objectDir);
    const traversing = { ...manifest, files: [{ ...manifest.files[0], path: '../escape.enc' }] };
    expect(() => store.restore(traversing, objectDir, path.join(tempRoot(), 'r3'), OWNER)).toThrow(/safe store-relative/);
  });

  it('reports bound:false with no configured store and, once opted in, reads its config from the vault env names', async () => {
    const none = createOwnerStoreSnapshotter(readOwnerStoreConfig({}));
    expect(none.bound).toBe(false);
    expect(none.objectDir).toBeNull();
    await expect(none.snapshot(OWNER, tempRoot())).rejects.toThrow(/no owner store/);
    const on = { TOKEN_CHASE_OWNER_STORE_SNAPSHOT: 'on' };
    const cfg = readOwnerStoreConfig({
      ...on, PI_STORE_ROOT: '/home/user/vaults', PI_TENANT: 'acme', TOKEN_CHASE_STORE_OBJECT_MAX_BYTES: '4096',
      TOKEN_CHASE_STORE_TOTAL_MAX_BYTES: '8192', TOKEN_CHASE_STORE_OBJECT_DIR: '/home/user/tc-objects',
    });
    expect(cfg).toEqual({ storeRoot: '/home/user/vaults', tenant: 'acme', maxObjectBytes: 4096, maxTotalBytes: 8192, objectDir: path.resolve('/home/user/tc-objects') });
    expect(readOwnerStoreConfig({ ...on, TOKEN_CHASE_STORE_ROOT: '/home/user/tc', PI_STORE_ROOT: '/home/user/vaults' }).storeRoot).toBe('/home/user/tc');
    expect(readOwnerStoreConfig({ ...on, PI_STORE_ROOT: '/home/user/vaults', TOKEN_CHASE_STORE_TOTAL_MAX_BYTES: 'lots' })).toMatchObject({ maxTotalBytes: DEFAULT_OWNER_STORE_MAX_TOTAL_BYTES, objectDir: null });
  });

  it('is installed on the capture lane by the bot-node server and exported through the barrel', () => {
    const server = fs.readFileSync('src/app/bot-node-server.ts', 'utf8');
    expect(server).toContain("import { createOwnerStoreSnapshotter, readOwnerStoreConfig } from '@/features/token-chase';");
    expect(server).toContain('const ownerStore = createOwnerStoreSnapshotter(readOwnerStoreConfig());');
    expect(server).toContain('tokenChase.configureOwnerStore(ownerStore);');
    expect(tokenChaseBarrel.createOwnerStoreSnapshotter).toBe(createOwnerStoreSnapshotter);
    expect(tokenChaseBarrel.readOwnerStoreConfig).toBe(readOwnerStoreConfig);
  });
});

describe('Token Chase owner-store snapshot is incremental, deduplicated and size-capped', () => {
  /** A vault with three settled ciphertext files and a snapshotter writing to one node object directory. */
  function settledStore(options: { maxTotalBytes?: number } = {}) {
    const storeRoot = tempRoot();
    const { vaultDir, file } = seedVault(storeRoot, OWNER);
    fs.utimesSync(file, HOUR_AGO, HOUR_AGO);
    addSettledFile(vaultDir, 'events.enc', 'second entry');
    addSettledFile(vaultDir, 'notes.enc', 'third entry');
    const objectDir = path.join(tempRoot(), 'node-objects');
    const store = createOwnerStoreSnapshotter({ storeRoot, tenant: TENANT, maxObjectBytes: 1024 * 1024, objectDir, ...options });
    return { storeRoot, vaultDir, file, objectDir, store };
  }

  it('writes into the node object directory by default, and a second snapshot copies zero objects', async () => {
    const { objectDir, store } = settledStore();
    expect(store.objectDir).toBe(objectDir);
    const first = await store.snapshot(OWNER);
    expect(first).toMatchObject({ complete: true, hashed: 3, copied: 3 });
    expect(fs.readdirSync(objectDir).sort()).toEqual(first.files.map((f) => f.sha256).sort());
    const second = await store.snapshot(OWNER);
    expect(second).toMatchObject({ version: first.version, hashed: 0, copied: 0 });
    expect(fs.readdirSync(objectDir)).toHaveLength(3);
    // No stray temp files are left behind by the atomic writes.
    expect(fs.readdirSync(objectDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('re-reads only what changed: an unchanged file is served from the stat cache, a rewritten one is re-hashed', async () => {
    const { vaultDir, store } = settledStore();
    const readSpy = vi.spyOn(fsp, 'readFile');
    await store.snapshot(OWNER);
    expect(readSpy).toHaveBeenCalledTimes(3);
    readSpy.mockClear();
    const unchanged = await store.snapshot(OWNER);
    expect(unchanged.hashed).toBe(0);
    expect(readSpy).not.toHaveBeenCalled();

    const changedAt = new Date(HOUR_AGO.getTime() + 60_000);
    addSettledFile(vaultDir, 'events.enc', 'the second entry, edited', changedAt);
    const changed = await store.snapshot(OWNER);
    expect(changed).toMatchObject({ hashed: 1, copied: 1 });
    expect(changed.version).not.toBe(unchanged.version);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(String(readSpy.mock.calls[0][0])).toMatch(/events\.enc$/);
  });

  it('does not trust the cache for a file written inside the racy window, or for an object that went missing', async () => {
    const { vaultDir, objectDir, store } = settledStore();
    await store.snapshot(OWNER);
    // Dated a minute ahead so it stays inside the racy window however slow this host is.
    addSettledFile(vaultDir, 'fresh.enc', 'just written', new Date(Date.now() + 60_000));
    expect((await store.snapshot(OWNER)).hashed).toBe(1);
    // Still inside the window: re-hashed again rather than cached from a stat that could hide a same-size rewrite.
    expect((await store.snapshot(OWNER)).hashed).toBe(1);

    fs.rmSync(objectDir, { recursive: true, force: true });
    const recopied = await store.snapshot(OWNER);
    expect(recopied.copied).toBe(4);
    expect(fs.readdirSync(objectDir)).toHaveLength(4);
  });

  it('refuses a store above the total ceiling before reading anything, and records the measured size', async () => {
    const { vaultDir, objectDir, store } = settledStore({ maxTotalBytes: 64 });
    const measured = fs.readdirSync(vaultDir).reduce((sum, name) => sum + fs.statSync(path.join(vaultDir, name)).size, 0);
    const readSpy = vi.spyOn(fsp, 'readFile');
    const refused = await store.snapshot(OWNER);
    expect(refused).toMatchObject({ skipped: 'too_large', measuredBytes: measured, maxTotalBytes: 64, version: '', complete: false, hashed: 0, copied: 0 });
    expect(refused.files).toEqual([]);
    expect(refused.warnings.join('\n')).toContain(`owner store is ${measured} bytes, above the 64-byte snapshot ceiling`);
    expect(readSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(objectDir)).toBe(false);
  });

  it('leaves the snapshot incomplete, not failed, when a file vanishes between listing and reading', async () => {
    const { store } = settledStore();
    const real = fsp.readFile.bind(fsp);
    vi.spyOn(fsp, 'readFile').mockImplementation(async (file, ...rest) => {
      if (String(file).endsWith('notes.enc')) throw Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' });
      return real(file as never, ...(rest as []));
    });
    const manifest = await store.snapshot(OWNER);
    expect(manifest.complete).toBe(false);
    expect(manifest.files.map((f) => f.path)).toEqual(['vault/entities.enc', 'vault/events.enc']);
    expect(manifest.warnings).toContain('store file vanished during the snapshot: vault/notes.enc');
  });

  it('yields to the event loop while it walks instead of holding it for the whole store', async () => {
    const storeRoot = tempRoot();
    const { vaultDir } = seedVault(storeRoot, OWNER);
    for (let i = 0; i < 40; i += 1) addSettledFile(vaultDir, `entry-${String(i).padStart(2, '0')}.enc`, `entry ${i}`);
    const store = createOwnerStoreSnapshotter({ storeRoot, tenant: TENANT, maxObjectBytes: 1024 * 1024, objectDir: path.join(tempRoot(), 'objects') });
    let ticks = 0;
    let spinning = true;
    const spin = (): void => { if (!spinning) return; ticks += 1; setImmediate(spin); };
    setImmediate(spin);
    const manifest = await store.snapshot(OWNER);
    spinning = false;
    expect(manifest.files).toHaveLength(41);
    // A synchronous walk would let the ticker run at most once; this one interleaves with it throughout.
    expect(ticks).toBeGreaterThan(20);
  });
});
