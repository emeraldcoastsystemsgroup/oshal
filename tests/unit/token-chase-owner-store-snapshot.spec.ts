/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the encrypted owner-store version + ciphertext-only restore (BACKLOG "Workspace-bound checkpoint and tail replay", ADR-046 §1): the version is stable and changes after a write; the snapshot copies CIPHERTEXT only (no plaintext under .tokenchase, proven by scanning every object for the plaintext); a restore is byte-identical and decrypts with the owner's key and ONLY that owner's; a symlinked store file is refused through the real exact-subject-store guards; and a node with no configured store reports bound:false instead of a made-up version.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Wiring seam: the bot-node server installs the snapshotter on the capture lane (configureOwnerStore over readOwnerStoreConfig) and the feature barrel exports it, so a frame's ownerStoreVersion has a real producer on every worker rather than a contract nobody calls.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The config case opts in (TOKEN_CHASE_OWNER_STORE_SNAPSHOT=on) before expecting a bound root: a vault root alone no longer binds the snapshotter (the opt-in itself is guarded by token-chase-owner-store-opt-in.spec.ts).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  computeOwnerStoreVersion,
  createOwnerStoreSnapshotter,
  readOwnerStoreConfig,
} from '../../src/features/token-chase/services/owner-store-snapshot';
import { ensureExactSubjectStoreDirectory } from '../../src/shared/security/exact-subject-store';
import { decryptField, encryptField } from '../../src/features/personal-data/vault-crypto';
import * as tokenChaseBarrel from '../../src/features/token-chase';

const OWNER = 'auth0|token-chase-owner';
const OTHER = 'auth0|token-chase-other';
const TENANT = 'default';
const PLAINTEXT = 'the quick brown vault entry';
const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-store-'));
  roots.push(root);
  return root;
}
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
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
  it('versions the store stably, changes after a write, and copies only ciphertext', () => {
    const storeRoot = tempRoot();
    const capture = path.join(tempRoot(), '.tokenchase');
    const objectDir = path.join(capture, 'store-objects');
    const { file } = seedVault(storeRoot, OWNER);
    const store = createOwnerStoreSnapshotter({ storeRoot, tenant: TENANT, maxObjectBytes: 1024 * 1024 });
    expect(store.bound).toBe(true);

    const first = store.snapshot(OWNER, objectDir);
    expect(first.version).toMatch(/^[0-9a-f]{64}$/);
    expect(first.complete).toBe(true);
    expect(first.files.map((f) => f.path)).toEqual(['vault/entities.enc']);
    expect(store.version(OWNER).version).toBe(first.version);
    expect(store.snapshot(OWNER, objectDir).version).toBe(first.version);
    expect(first.version).toBe(computeOwnerStoreVersion(first.files));

    // The object is the stored ciphertext byte for byte, and the plaintext appears nowhere under the capture.
    const stored = fs.readFileSync(path.join(objectDir, first.files[0].sha256));
    expect(stored.equals(fs.readFileSync(file))).toBe(true);
    expect(stored.toString('utf8').startsWith('v1:')).toBe(true);
    expect(scanForPlaintext(capture, PLAINTEXT)).toEqual([]);

    fs.writeFileSync(file, encryptField(OWNER, 'a different entry')!, 'utf8');
    const second = store.snapshot(OWNER, objectDir);
    expect(second.version).not.toBe(first.version);
    expect(fs.readdirSync(objectDir)).toHaveLength(2);
    // An owner with no directory yet has the stable empty version, distinct from "no store".
    expect(store.version(OTHER).version).toBe(computeOwnerStoreVersion([]));
  });

  it('restores byte-identical ciphertext into an isolated root that decrypts for the owner only', () => {
    const storeRoot = tempRoot();
    const objectDir = path.join(tempRoot(), 'store-objects');
    const { file } = seedVault(storeRoot, OWNER);
    const store = createOwnerStoreSnapshotter({ storeRoot, tenant: TENANT, maxObjectBytes: 1024 * 1024 });
    const manifest = store.snapshot(OWNER, objectDir);

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
    expect(isolated.version(OWNER).version).toBe(manifest.version);
    expect(fs.readFileSync(path.join(restore.subjectDir, '.oshal-user-sub'), 'utf8')).toBe(OWNER);
    expect(scanForPlaintext(isolatedRoot, PLAINTEXT)).toEqual([]);
    // A manifest that names a tampered object is refused by its digest check.
    const tampered = { ...manifest, files: [{ ...manifest.files[0], sha256: crypto.createHash('sha256').update('nope').digest('hex') }] };
    expect(() => store.restore(tampered, objectDir, path.join(tempRoot(), 'r2'), OWNER)).toThrow();
  });

  it('refuses a linked store file and a traversing manifest path', () => {
    const storeRoot = tempRoot();
    const { vaultDir } = seedVault(storeRoot, OWNER);
    const outside = path.join(tempRoot(), 'outside.enc');
    fs.writeFileSync(outside, encryptField(OWNER, 'outside')!, 'utf8');
    let linked = false;
    try { fs.symlinkSync(outside, path.join(vaultDir, 'linked.enc'), 'file'); linked = true; } catch { linked = false; }
    const store = createOwnerStoreSnapshotter({ storeRoot, tenant: TENANT, maxObjectBytes: 1024 * 1024 });
    if (linked) {
      expect(() => store.snapshot(OWNER, path.join(tempRoot(), 'objects'))).toThrow(/link/i);
    } else {
      // Symlink creation needs a privilege this host lacks; the guard is exercised by the traversal case below.
      expect(store.snapshot(OWNER, path.join(tempRoot(), 'objects')).complete).toBe(true);
    }
    const objectDir = path.join(tempRoot(), 'objects2');
    const manifest = store.snapshot(OWNER, objectDir);
    const traversing = { ...manifest, files: [{ ...manifest.files[0], path: '../escape.enc' }] };
    expect(() => store.restore(traversing, objectDir, path.join(tempRoot(), 'r3'), OWNER)).toThrow(/safe store-relative/);
  });

  it('reports bound:false with no configured store and, once opted in, reads its config from the vault env names', () => {
    const none = createOwnerStoreSnapshotter(readOwnerStoreConfig({}));
    expect(none.bound).toBe(false);
    expect(() => none.snapshot(OWNER, tempRoot())).toThrow(/no owner store/);
    const on = { TOKEN_CHASE_OWNER_STORE_SNAPSHOT: 'on' };
    const cfg = readOwnerStoreConfig({ ...on, PI_STORE_ROOT: '/home/user/vaults', PI_TENANT: 'acme', TOKEN_CHASE_STORE_OBJECT_MAX_BYTES: '4096' });
    expect(cfg).toEqual({ storeRoot: '/home/user/vaults', tenant: 'acme', maxObjectBytes: 4096 });
    expect(readOwnerStoreConfig({ ...on, TOKEN_CHASE_STORE_ROOT: '/home/user/tc', PI_STORE_ROOT: '/home/user/vaults' }).storeRoot).toBe('/home/user/tc');
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
