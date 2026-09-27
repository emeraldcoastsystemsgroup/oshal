/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Encrypted owner-store version + ciphertext-only snapshot/restore for Token Chase (ADR-046 §1 "three-part checkpoint", BACKLOG "Workspace-bound checkpoint and tail replay"). The version is sha256 over the sorted (path, sha256(ciphertext)) pairs of the owner's exact-subject store directory (the same AES-256-GCM vault layout the Personal Data Vault uses, resolved through resolveExactSubjectStoreDirectory and the link-free file guards, so a symlinked or aliased store is refused). Snapshot copies the stored bytes as-is into a content-addressed object dir — nothing is ever decrypted, and no plaintext is written. Restore re-binds the owner under an isolated store root with ensureExactSubjectStoreDirectory; key derivation (per-user HKDF) is untouched, so the restored store decrypts for the same owner only. With no configured store root the snapshotter reports bound:false and every version is null.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | versionAt(storeRoot, ownerSub): version the same owner under a different root with this node's tenant and limits — the bot-node tail executor re-versions the ISOLATED restored store with it and compares that to final.json's ownerStoreVersion, so the store comparison uses the one contract instead of a re-derived config.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Explicit opt-in (regression fix for seq 1): readOwnerStoreConfig bound the snapshotter to PI_STORE_ROOT / JOBHUNTER_STORE_ROOT whenever either was set, so every captured bot turn on a node holding a vault hashed and copied that owner's whole store (measured on a jarvis bot: a 1.6 GB, 19,287-file store, the event loop held 88.8 s before the model call and 33.6 s after, 1.2 GB of store-objects per ask), with no way to turn it off. The store root is now read only when TOKEN_CHASE_OWNER_STORE_SNAPSHOT is on (isOwnerStoreSnapshotEnabled); otherwise storeRoot is null and the snapshotter is unbound, so frames record ownerStoreVersion null and ownerStore.bound false.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Opted-in snapshots are incremental, deduplicated and size-capped (same regression, the opt-in path). version/snapshot/versionAt are async and read, hash and copy with fs/promises, so the walk yields to the event loop between files instead of holding it for the whole store. A per-subject stat cache (size, mtimeMs, inode -> sha256) skips re-reading unchanged files; entries younger than RACY_WINDOW_MS are never cached, so a same-size rewrite inside the mtime granularity is still re-hashed. Objects go to ONE content-addressed directory per node (TOKEN_CHASE_STORE_OBJECT_DIR, default <shared workspace root>/.tokenchase-store-objects) through an atomic temp-file rename, so frames and tasks share each object instead of copying the store per task. A store whose regular files total more than TOKEN_CHASE_STORE_TOTAL_MAX_BYTES (default 256 MiB) is refused before anything is hashed or copied: the manifest carries skipped 'too_large' with measuredBytes. A file that vanishes between listing and reading (a SQLite -shm on close) is a warning that leaves the snapshot incomplete rather than failing it. Each manifest reports hashed/copied counts. Restore is unchanged.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
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
import { resolveSharedWorkspaceRoot } from '@/shared/workspace-root';

const logger = createChildLogger({ module: 'token-chase-owner-store-snapshot' });

/** @description The exact-owner marker the store layout keeps; it names the subject and is re-bound on restore, never copied. */
const OWNER_MARKER = '.oshal-user-sub';
const SQLITE_NAME = /\.(?:sqlite|sqlite3|db)$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
/** @description A file modified this recently is re-hashed next time rather than trusted from the stat cache. */
const RACY_WINDOW_MS = 2000;
/** @description Default per-object ceiling for a store file; larger files leave the snapshot honestly incomplete. */
export const DEFAULT_OWNER_STORE_MAX_OBJECT_BYTES = 64 * 1024 * 1024;
/** @description Default ceiling on the whole store; a larger store is refused (skipped 'too_large'), never hashed or copied. */
export const DEFAULT_OWNER_STORE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** @description The node's shared object directory name under the shared workspace root (not a run: it holds no .tokenchase). */
export const OWNER_STORE_OBJECT_DIRNAME = '.tokenchase-store-objects';

/** @description Where the owner store lives on this node (null when the node has none) and the snapshot limits. */
export interface OwnerStoreConfig {
  storeRoot: string | null;
  tenant: string;
  maxObjectBytes: number;
  /** Ceiling on the whole store's bytes; defaults to DEFAULT_OWNER_STORE_MAX_TOTAL_BYTES. */
  maxTotalBytes?: number;
  /** The node's content-addressed object directory; defaults to <shared workspace root>/.tokenchase-store-objects. */
  objectDir?: string | null;
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
  /** Set when the walk refused the store instead of versioning it: its files total more than maxTotalBytes. */
  skipped?: 'too_large';
  /** The total bytes of every regular store file the walk listed (measured before anything is read). */
  measuredBytes?: number;
  /** The ceiling the walk applied. */
  maxTotalBytes?: number;
  /** Files this call read and hashed; 0 when every file matched the stat cache and its object existed. */
  hashed?: number;
  /** Objects this call newly wrote into the object directory; 0 when every object was already there. */
  copied?: number;
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
  /** The node's shared content-addressed object directory, or null when unbound. */
  readonly objectDir: string | null;
  /** Versions the owner's store without copying anything. */
  version(ownerSub: string): Promise<OwnerStoreManifest>;
  /** Versions the store AND ensures each file's stored bytes exist as `<objectDir>/<sha256>` (the node's directory by default). */
  snapshot(ownerSub: string, objectDir?: string): Promise<OwnerStoreManifest>;
  /** Materializes a manifest from `objectDir` into an isolated store root, re-bound to the same owner. */
  restore(manifest: OwnerStoreManifest, objectDir: string, isolatedRoot: string, ownerSub: string): OwnerStoreRestoreResult;
  /** Versions the same owner under a DIFFERENT store root (an isolated replay root) with this node's tenant and limits. */
  versionAt(storeRoot: string, ownerSub: string): Promise<OwnerStoreManifest>;
}

/** @description The environment switch that opts a node in to per-frame owner-store snapshots. */
export const OWNER_STORE_SNAPSHOT_FLAG = 'TOKEN_CHASE_OWNER_STORE_SNAPSHOT';
const OPT_IN_VALUE = /^(?:on|true)$/i;

/**
 * @description Whether this node opted in to owner-store snapshots. Off unless the flag is exactly
 * `on` (or `true`): a snapshot hashes and copies the owner's whole encrypted store on every captured
 * frame, which on a large vault costs minutes and gigabytes per turn, so it is never implied by a
 * vault root being present.
 * @param env - The environment to read (defaults to process.env).
 * @returns True only when TOKEN_CHASE_OWNER_STORE_SNAPSHOT is on.
 */
export function isOwnerStoreSnapshotEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return OPT_IN_VALUE.test(String(env[OWNER_STORE_SNAPSHOT_FLAG] ?? '').trim());
}

/** @description A positive integer from the environment, else the fallback. */
function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(String(raw ?? ''), 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * @description Reads the owner-store location from the environment. Nothing binds unless the node
 * opted in (isOwnerStoreSnapshotEnabled); then TOKEN_CHASE_STORE_ROOT overrides, else the vault
 * services' PI_STORE_ROOT / JOBHUNTER_STORE_ROOT; tenant from PI_TENANT. Limits come from
 * TOKEN_CHASE_STORE_OBJECT_MAX_BYTES / TOKEN_CHASE_STORE_TOTAL_MAX_BYTES and the object directory from
 * TOKEN_CHASE_STORE_OBJECT_DIR (null here means the default under the shared workspace root).
 * @param env - The environment to read (defaults to process.env).
 * @returns The config; `storeRoot` is null when the node did not opt in or has no store root.
 */
export function readOwnerStoreConfig(env: NodeJS.ProcessEnv = process.env): OwnerStoreConfig {
  const root = !isOwnerStoreSnapshotEnabled(env) ? undefined
    : [env.TOKEN_CHASE_STORE_ROOT, env.PI_STORE_ROOT, env.JOBHUNTER_STORE_ROOT]
      .find((value) => typeof value === 'string' && value.trim().length > 0);
  const objectDir = (env.TOKEN_CHASE_STORE_OBJECT_DIR ?? '').trim();
  return {
    storeRoot: root ? root.trim() : null,
    tenant: (env.PI_TENANT ?? '').trim() || 'default',
    maxObjectBytes: positiveInteger(env.TOKEN_CHASE_STORE_OBJECT_MAX_BYTES, DEFAULT_OWNER_STORE_MAX_OBJECT_BYTES),
    maxTotalBytes: positiveInteger(env.TOKEN_CHASE_STORE_TOTAL_MAX_BYTES, DEFAULT_OWNER_STORE_MAX_TOTAL_BYTES),
    objectDir: objectDir ? path.resolve(objectDir) : null,
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

/** @description One listed store file with the stat the cache and the ceiling are decided on. */
interface StoreEntry {
  relative: string;
  full: string;
  size: number;
  mtimeMs: number;
  ino: number;
}

/** @description What the stat cache remembers about one store file. */
interface StatCacheEntry {
  size: number;
  mtimeMs: number;
  ino: number;
  sha256: string;
}

/** @description The mutable state of one walk: where objects go, the cache it reads and the one it rebuilds. */
interface WalkState {
  objectDir: string | null;
  maxObjectBytes: number;
  cache: Map<string, StatCacheEntry> | null;
  nextCache: Map<string, StatCacheEntry>;
  warnings: string[];
  hashed: number;
  copied: number;
  startedAt: number;
}

/** @description sha256 of a buffer as hex. */
function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** @description The error code of a filesystem error, or undefined. */
function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/** @description lstat that answers null for a path that no longer exists. */
async function lstatIfPresent(file: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(file);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null;
    throw err;
  }
}

/** @description readFile that answers null for a file that vanished after it was listed. */
async function readIfPresent(file: string): Promise<Buffer | null> {
  try {
    return await fsp.readFile(file);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null;
    throw err;
  }
}

/** @description Whether a path exists, without following it into an error. */
async function pathExists(file: string): Promise<boolean> {
  return (await lstatIfPresent(file)) !== null;
}

/**
 * @description Lists one link-free store directory recursively: every regular file with its stat,
 * refusing links and nonregular entries through the exact-subject-store guards. A file that is gone
 * by the time it is checked (a SQLite -shm removed on close) is a warning, not a failure.
 */
async function collectStoreEntries(dir: string, prefix: string, out: StoreEntry[], warnings: string[]): Promise<void> {
  const entries = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === OWNER_MARKER) continue;
    if (entry.isSymbolicLink()) throw new UnsafeExactSubjectStoreError('store contains a linked entry');
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await collectStoreEntries(resolveLinkFreeStoreSubdirectory(dir, entry.name), relative, out, warnings);
      continue;
    }
    if (!entry.isFile()) throw new UnsafeExactSubjectStoreError('store contains a nonregular entry');
    const present = SQLITE_NAME.test(entry.name) ? assertLinkFreeSqliteDatabase(dir, entry.name) : assertLinkFreeStoreFile(dir, entry.name);
    const full = path.join(dir, entry.name);
    const stat = present ? await lstatIfPresent(full) : null;
    if (!stat) { warnings.push(`store file vanished during the snapshot: ${relative}`); continue; }
    out.push({ relative, full, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino });
  }
}

/** @description The cached digest for an entry whose size, mtime and inode are unchanged, else null. */
function cachedDigest(state: WalkState, entry: StoreEntry): string | null {
  const hit = state.cache?.get(entry.relative);
  if (!hit || hit.size !== entry.size || hit.mtimeMs !== entry.mtimeMs || hit.ino !== entry.ino) return null;
  state.nextCache.set(entry.relative, hit);
  return hit.sha256;
}

/** @description Caches a freshly computed digest unless the file is too recent or changed size under the read. */
function rememberDigest(state: WalkState, entry: StoreEntry, sha256: string, bytesRead: number): void {
  if (bytesRead !== entry.size || state.startedAt - entry.mtimeMs < RACY_WINDOW_MS) return;
  state.nextCache.set(entry.relative, { size: entry.size, mtimeMs: entry.mtimeMs, ino: entry.ino, sha256 });
}

/**
 * @description Writes one content-addressed ciphertext object atomically (temp file + rename), so a
 * crash never leaves a truncated object under its digest and concurrent writers of the same object
 * both succeed.
 * @returns True when this call wrote the object; false when it was already present.
 */
async function writeObjectIfAbsent(objectDir: string, sha256: string, bytes: Buffer): Promise<boolean> {
  const target = path.join(objectDir, sha256);
  if (await pathExists(target)) return false;
  const temp = path.join(objectDir, `.${sha256}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  await fsp.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
  try {
    await fsp.rename(temp, target);
    return true;
  } catch (err) {
    await fsp.rm(temp, { force: true });
    if (await pathExists(target)) return false;
    throw err;
  }
}

/**
 * @description Versions one listed file: trusts the stat cache when the object is already where it
 * must be, otherwise reads and hashes the stored bytes and (when copying) writes the object.
 * @returns The versioned file, or null when it vanished before it could be read.
 */
async function versionEntry(entry: StoreEntry, state: WalkState): Promise<OwnerStoreFile | null> {
  const cached = cachedDigest(state, entry);
  const objectMissing = async (digest: string): Promise<boolean> => state.objectDir !== null && !(await pathExists(path.join(state.objectDir, digest)));
  if (cached && !(await objectMissing(cached))) return { path: entry.relative, sha256: cached, bytes: entry.size };
  const bytes = await readIfPresent(entry.full);
  if (!bytes) {
    state.warnings.push(`store file vanished during the snapshot: ${entry.relative}`);
    return null;
  }
  const sha256 = sha256Hex(bytes);
  state.hashed += 1;
  rememberDigest(state, entry, sha256, bytes.length);
  if (state.objectDir && await writeObjectIfAbsent(state.objectDir, sha256, bytes)) state.copied += 1;
  return { path: entry.relative, sha256, bytes: bytes.length };
}

/**
 * @description Walks one owner's store: lists it, refuses it whole when it exceeds the total ceiling
 * (nothing read, hashed or copied), and otherwise versions every file within the per-object ceiling.
 */
async function walkStore(subjectDir: string | null, state: WalkState, maxTotalBytes: number): Promise<OwnerStoreManifest> {
  const entries: StoreEntry[] = [];
  if (subjectDir) await collectStoreEntries(subjectDir, '', entries, state.warnings);
  const measuredBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (measuredBytes > maxTotalBytes) {
    const warning = `owner store is ${measuredBytes} bytes, above the ${maxTotalBytes}-byte snapshot ceiling`;
    return { version: '', files: [], complete: false, warnings: [...state.warnings, warning], skipped: 'too_large', measuredBytes, maxTotalBytes, hashed: 0, copied: 0 };
  }
  if (state.objectDir) await fsp.mkdir(state.objectDir, { recursive: true });
  const files: OwnerStoreFile[] = [];
  for (const entry of entries) {
    if (entry.size > state.maxObjectBytes) { state.warnings.push(`store file exceeds the object ceiling: ${entry.relative}`); continue; }
    const file = await versionEntry(entry, state);
    if (file) files.push(file);
  }
  return {
    version: computeOwnerStoreVersion(files), files, complete: state.warnings.length === 0, warnings: state.warnings,
    measuredBytes, maxTotalBytes, hashed: state.hashed, copied: state.copied,
  };
}

/** @description Reads one content-addressed object and verifies its digest before it is trusted. */
function readVerifiedObject(objectDir: string, sha256: string): Buffer {
  if (!SHA256_PATTERN.test(sha256)) throw new UnsafeExactSubjectStoreError('manifest object id is not a sha256');
  const bytes = fs.readFileSync(path.join(objectDir, sha256));
  const actual = sha256Hex(bytes);
  if (actual !== sha256) throw new Error(`store object ${sha256} failed its digest check`);
  return bytes;
}

/** @description The snapshotter for a node with no store: bound false, every version empty, every copy refused. */
function unboundSnapshotter(): OwnerStoreSnapshotter {
  const refuse = (): never => { throw new Error('no owner store configured on this node'); };
  return {
    bound: false,
    objectDir: null,
    version: async () => ({ version: '', files: [], complete: false, warnings: ['no owner store configured'] }),
    snapshot: async () => refuse(),
    restore: refuse,
    versionAt: async () => refuse(),
  };
}

/**
 * @description Builds the snapshotter for one node. With `storeRoot` null every version is null and
 * `bound` is false — the honest "no store here" posture rather than a fabricated version. A bound
 * snapshotter keeps a per-subject stat cache for the node's own store root and writes objects into
 * one shared directory, so an unchanged store costs a stat walk, not a re-read and a copy.
 * @param config - Where the store lives and the limits (see readOwnerStoreConfig).
 * @returns The snapshotter the capture lane and tail runner use.
 */
export function createOwnerStoreSnapshotter(config: OwnerStoreConfig): OwnerStoreSnapshotter {
  const storeRoot = config.storeRoot;
  if (!storeRoot) return unboundSnapshotter();
  const maxTotalBytes = config.maxTotalBytes && config.maxTotalBytes > 0 ? config.maxTotalBytes : DEFAULT_OWNER_STORE_MAX_TOTAL_BYTES;
  const nodeObjectDir = config.objectDir || path.join(resolveSharedWorkspaceRoot(), OWNER_STORE_OBJECT_DIRNAME);
  const caches = new Map<string, Map<string, StatCacheEntry>>();

  const walk = async (root: string, ownerSub: string, objectDir: string | null, useCache: boolean): Promise<OwnerStoreManifest> => {
    const resolved = resolveExactSubjectStoreDirectory(root, config.tenant, ownerSub);
    const subjectDir = resolved.exists ? resolved.subjectDir : null;
    const state: WalkState = {
      objectDir, maxObjectBytes: config.maxObjectBytes, cache: useCache && subjectDir ? caches.get(subjectDir) ?? null : null,
      nextCache: new Map(), warnings: [], hashed: 0, copied: 0, startedAt: Date.now(),
    };
    const manifest = await walkStore(subjectDir, state, maxTotalBytes);
    if (useCache && subjectDir && !manifest.skipped) caches.set(subjectDir, state.nextCache);
    return manifest;
  };

  return {
    bound: true,
    objectDir: nodeObjectDir,
    version: (ownerSub) => walk(storeRoot, ownerSub, null, true),
    snapshot: async (ownerSub, objectDir) => {
      const manifest = await walk(storeRoot, ownerSub, objectDir ?? nodeObjectDir, true);
      logger.debug({ files: manifest.files.length, complete: manifest.complete, skipped: manifest.skipped ?? null, hashed: manifest.hashed, copied: manifest.copied }, 'Owner store snapshot written');
      return manifest;
    },
    restore: (manifest, objectDir, isolatedRoot, ownerSub) => restoreManifest(manifest, objectDir, isolatedRoot, ownerSub, config.tenant),
    versionAt: (root, ownerSub) => walk(root, ownerSub, null, false),
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
