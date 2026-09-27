/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Encrypted owner-store version + ciphertext-only snapshot/restore for Token Chase (ADR-046 §1 "three-part checkpoint", BACKLOG "Workspace-bound checkpoint and tail replay"). The version is sha256 over the sorted (path, sha256(ciphertext)) pairs of the owner's exact-subject store directory (the same AES-256-GCM vault layout the Personal Data Vault uses, resolved through resolveExactSubjectStoreDirectory and the link-free file guards, so a symlinked or aliased store is refused). Snapshot copies the stored bytes as-is into a content-addressed object dir — nothing is ever decrypted, and no plaintext is written. Restore re-binds the owner under an isolated store root with ensureExactSubjectStoreDirectory; key derivation (per-user HKDF) is untouched, so the restored store decrypts for the same owner only. With no configured store root the snapshotter reports bound:false and every version is null.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | versionAt(storeRoot, ownerSub): version the same owner under a different root with this node's tenant and limits — the bot-node tail executor re-versions the ISOLATED restored store with it and compares that to final.json's ownerStoreVersion, so the store comparison uses the one contract instead of a re-derived config.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createChildLogger } from '@/shared/logger';
import {
  assertLinkFreeSqliteDatabase,
  assertLinkFreeStoreFile,
  ensureExactSubjectStoreDirectory,
  ensureLinkFreeStoreSubdirectory,
  resolveExactSubjectStoreDirectory,
  resolveLinkFreeStoreSubdirectory,
  UnsafeExactSubjectStoreError,
} from '@/shared/security/exact-subject-store';

const logger = createChildLogger({ module: 'token-chase-owner-store-snapshot' });

/** @description The exact-owner marker the store layout keeps; it names the subject and is re-bound on restore, never copied. */
const OWNER_MARKER = '.oshal-user-sub';
const SQLITE_NAME = /\.(?:sqlite|sqlite3|db)$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
/** @description Default per-object ceiling for a store file; larger files leave the snapshot honestly incomplete. */
export const DEFAULT_OWNER_STORE_MAX_OBJECT_BYTES = 64 * 1024 * 1024;

/** @description Where the owner store lives on this node (null when the node has none). */
export interface OwnerStoreConfig {
  storeRoot: string | null;
  tenant: string;
  maxObjectBytes: number;
}

/** @description One versioned store file: its store-relative path and the digest of its stored (ciphertext) bytes. */
export interface OwnerStoreFile {
  path: string;
  sha256: string;
  bytes: number;
}

/** @description The version identity of an owner store at one instant, plus what the walk could not include. */
export interface OwnerStoreManifest {
  version: string;
  files: OwnerStoreFile[];
  complete: boolean;
  warnings: string[];
}

/** @description The outcome of restoring a manifest into an isolated store root. */
export interface OwnerStoreRestoreResult {
  subjectDir: string;
  restored: number;
  version: string;
}

/** @description The duck-typed contract the CommonJS capture lane and tail runner consume. */
export interface OwnerStoreSnapshotter {
  readonly bound: boolean;
  /** Versions the owner's store without copying anything. */
  version(ownerSub: string): OwnerStoreManifest;
  /** Versions the store AND copies each file's stored bytes into `objectDir/<sha256>`. */
  snapshot(ownerSub: string, objectDir: string): OwnerStoreManifest;
  /** Materializes a manifest from `objectDir` into an isolated store root, re-bound to the same owner. */
  restore(manifest: OwnerStoreManifest, objectDir: string, isolatedRoot: string, ownerSub: string): OwnerStoreRestoreResult;
  /** Versions the same owner under a DIFFERENT store root (an isolated replay root) with this node's tenant and limits. */
  versionAt(storeRoot: string, ownerSub: string): OwnerStoreManifest;
}

/**
 * @description Reads the owner-store location from the environment the way the vault services do:
 * TOKEN_CHASE_STORE_ROOT overrides, else PI_STORE_ROOT / JOBHUNTER_STORE_ROOT; tenant from PI_TENANT.
 * @param env - The environment to read (defaults to process.env).
 * @returns The config; `storeRoot` is null when no store is configured on this node.
 */
export function readOwnerStoreConfig(env: NodeJS.ProcessEnv = process.env): OwnerStoreConfig {
  const root = [env.TOKEN_CHASE_STORE_ROOT, env.PI_STORE_ROOT, env.JOBHUNTER_STORE_ROOT]
    .find((value) => typeof value === 'string' && value.trim().length > 0);
  const max = Number.parseInt(String(env.TOKEN_CHASE_STORE_OBJECT_MAX_BYTES ?? ''), 10);
  return {
    storeRoot: root ? root.trim() : null,
    tenant: (env.PI_TENANT ?? '').trim() || 'default',
    maxObjectBytes: Number.isInteger(max) && max > 0 ? max : DEFAULT_OWNER_STORE_MAX_OBJECT_BYTES,
  };
}

/**
 * @description The store version: sha256 over the sorted `path\0sha256\n` lines. An empty store has a
 * stable version too, so "no files yet" is distinguishable from "no store".
 * @param files - The versioned files.
 * @returns The 64-hex version.
 */
export function computeOwnerStoreVersion(files: ReadonlyArray<OwnerStoreFile>): string {
  const hash = crypto.createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${file.path}\0${file.sha256}\n`);
  }
  return hash.digest('hex');
}

/** @description Refuses a manifest path that is absolute, traverses, or names a store-internal marker. */
function safeRelativePath(relative: string): string {
  const segments = relative.split('/');
  if (!relative || path.isAbsolute(relative) || relative.includes('\\')
    || segments.some((s) => s === '' || s === '.' || s === '..' || s === OWNER_MARKER)) {
    throw new UnsafeExactSubjectStoreError('manifest path is not a safe store-relative path');
  }
  return relative;
}

/** @description Walks one link-free store directory, versioning every regular file and refusing links. */
function walkStoreDirectory(
  dir: string, relativePrefix: string, out: OwnerStoreFile[], warnings: string[], maxBytes: number,
  onObject: ((sha256: string, bytes: Buffer) => void) | null,
): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === OWNER_MARKER) continue;
    if (entry.isSymbolicLink()) throw new UnsafeExactSubjectStoreError('store contains a linked entry');
    const relative = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walkStoreDirectory(resolveLinkFreeStoreSubdirectory(dir, entry.name), relative, out, warnings, maxBytes, onObject);
      continue;
    }
    if (!entry.isFile()) throw new UnsafeExactSubjectStoreError('store contains a nonregular entry');
    if (SQLITE_NAME.test(entry.name)) assertLinkFreeSqliteDatabase(dir, entry.name);
    else assertLinkFreeStoreFile(dir, entry.name);
    const stat = fs.lstatSync(path.join(dir, entry.name));
    if (stat.size > maxBytes) { warnings.push(`store file exceeds the object ceiling: ${relative}`); continue; }
    const bytes = fs.readFileSync(path.join(dir, entry.name));
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (onObject) onObject(sha256, bytes);
    out.push({ path: relative, sha256, bytes: bytes.length });
  }
}

/** @description Writes one content-addressed ciphertext object, tolerating a concurrent identical writer. */
function writeStoreObject(objectDir: string, sha256: string, bytes: Buffer): void {
  const objectPath = path.join(objectDir, sha256);
  if (fs.existsSync(objectPath)) return;
  try {
    fs.writeFileSync(objectPath, bytes, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

/** @description Reads one content-addressed object and verifies its digest before it is trusted. */
function readVerifiedObject(objectDir: string, sha256: string): Buffer {
  if (!SHA256_PATTERN.test(sha256)) throw new UnsafeExactSubjectStoreError('manifest object id is not a sha256');
  const bytes = fs.readFileSync(path.join(objectDir, sha256));
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== sha256) throw new Error(`store object ${sha256} failed its digest check`);
  return bytes;
}

/**
 * @description Builds the snapshotter for one node. With `storeRoot` null every version is null and
 * `bound` is false — the honest "no store here" posture rather than a fabricated version.
 * @param config - Where the store lives (see readOwnerStoreConfig).
 * @returns The snapshotter the capture lane and tail runner use.
 */
export function createOwnerStoreSnapshotter(config: OwnerStoreConfig): OwnerStoreSnapshotter {
  const storeRoot = config.storeRoot;
  if (!storeRoot) {
    const unbound = (): never => { throw new Error('no owner store configured on this node'); };
    return {
      bound: false,
      version: () => ({ version: '', files: [], complete: false, warnings: ['no owner store configured'] }),
      snapshot: unbound,
      restore: unbound,
      versionAt: unbound,
    };
  }

  const walk = (root: string, ownerSub: string, onObject: ((sha256: string, bytes: Buffer) => void) | null): OwnerStoreManifest => {
    const resolved = resolveExactSubjectStoreDirectory(root, config.tenant, ownerSub);
    const files: OwnerStoreFile[] = [];
    const warnings: string[] = [];
    if (resolved.exists) walkStoreDirectory(resolved.subjectDir, '', files, warnings, config.maxObjectBytes, onObject);
    return { version: computeOwnerStoreVersion(files), files, complete: warnings.length === 0, warnings };
  };

  return {
    bound: true,
    version: (ownerSub) => walk(storeRoot, ownerSub, null),
    snapshot: (ownerSub, objectDir) => {
      fs.mkdirSync(objectDir, { recursive: true });
      const manifest = walk(storeRoot, ownerSub, (sha256, bytes) => writeStoreObject(objectDir, sha256, bytes));
      logger.debug({ files: manifest.files.length, complete: manifest.complete }, 'Owner store snapshot written');
      return manifest;
    },
    restore: (manifest, objectDir, isolatedRoot, ownerSub) => restoreManifest(manifest, objectDir, isolatedRoot, ownerSub, config.tenant),
    versionAt: (root, ownerSub) => walk(root, ownerSub, null),
  };
}

/** @description Materializes a manifest's ciphertext into an isolated, owner-bound store directory. */
function restoreManifest(
  manifest: OwnerStoreManifest, objectDir: string, isolatedRoot: string, ownerSub: string, tenant: string,
): OwnerStoreRestoreResult {
  const bound = ensureExactSubjectStoreDirectory(isolatedRoot, tenant, ownerSub);
  let restored = 0;
  for (const file of manifest.files) {
    const relative = safeRelativePath(file.path);
    const segments = relative.split('/');
    let dir = bound.subjectDir;
    for (const segment of segments.slice(0, -1)) dir = ensureLinkFreeStoreSubdirectory(dir, segment);
    const name = segments[segments.length - 1];
    if (assertLinkFreeStoreFile(dir, name)) throw new Error(`restore target already exists: ${relative}`);
    fs.writeFileSync(path.join(dir, name), readVerifiedObject(objectDir, file.sha256), { flag: 'wx', mode: 0o600 });
    restored += 1;
  }
  return { subjectDir: bound.subjectDir, restored, version: computeOwnerStoreVersion(manifest.files) };
}
