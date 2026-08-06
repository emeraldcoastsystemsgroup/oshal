/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added collision-resistant exact-subject store directories, exact owner markers, conservative legacy discovery, and link-free SQLite path guards so opaque OIDC subjects never become raw path syntax.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { requireExactUserSubject } from './exact-user-subject';

const CANONICAL_DIRECTORY_PATTERN = /^u-[0-9a-f]{64}$/;
const OWNER_MARKER = '.oshal-user-sub';
const SQLITE_SIDECARS = ['', '-journal', '-shm', '-wal'] as const;
const TENANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** @description A resolved, exact-owner directory beneath one configured tenant root. */
export interface ExactSubjectStoreDirectory {
  /** Absolute configured storage root after lexical normalization. */
  storeRoot: string;
  /** Absolute tenant root validated as a single portable path component. */
  tenantRoot: string;
  /** Absolute canonical or conservatively accepted legacy owner directory. */
  subjectDir: string;
  /** True only when the selected owner directory already exists. */
  exists: boolean;
  /** Identifies whether the directory is digest-keyed or an exact legacy entry. */
  kind: 'canonical' | 'legacy';
}

/** @description Stable refusal for an aliased, linked, escaped, or malformed subject store path. */
export class UnsafeExactSubjectStoreError extends Error {
  /** Stable machine-readable code used by callers that map storage failures. */
  public readonly code = 'UNSAFE_EXACT_SUBJECT_STORE';

  /**
   * @description Creates a bounded error that never echoes an OIDC subject.
   * @param reason - Non-sensitive reason for refusing the path.
   */
  constructor(reason: string) {
    super(`Unsafe exact-subject store: ${reason}`);
    this.name = 'UnsafeExactSubjectStoreError';
  }
}

/** Read an entry without following it, returning undefined only for absence. */
function lstatIfPresent(targetPath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Validate a configured root and normalize it without accepting an empty cwd alias. */
function normalizedStoreRoot(storeRoot: string): string {
  if (typeof storeRoot !== 'string' || !storeRoot.trim() || storeRoot.includes('\0')) {
    throw new UnsafeExactSubjectStoreError('storage root is absent or malformed');
  }
  return path.resolve(storeRoot);
}

/** Validate one portable tenant component before joining it to the configured root. */
function validatedTenant(tenant: string): string {
  if (!TENANT_PATTERN.test(tenant) || tenant === '.' || tenant === '..') {
    throw new UnsafeExactSubjectStoreError('tenant is not a portable path component');
  }
  return tenant;
}

/** Assert that a candidate remains at or below its lexical root. */
function assertContained(rootPath: string, candidatePath: string): void {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new UnsafeExactSubjectStoreError('path escapes its configured root');
  }
}

/** Inspect every existing component without following a link. */
function inspectLinkFreeDirectory(directory: string): boolean {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  let missing = false;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = missing ? undefined : lstatIfPresent(current);
    if (!stat) { missing = true; continue; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new UnsafeExactSubjectStoreError('directory path contains a link or non-directory');
    }
  }
  return !missing;
}

/** Create one directory path, checking every component after each possible creation. */
function ensureLinkFreeDirectory(directory: string, mode: number): string {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!lstatIfPresent(current)) {
      try { fs.mkdirSync(current, { mode }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new UnsafeExactSubjectStoreError('directory creation encountered a link or non-directory');
    }
  }
  return absolute;
}

/** Ensure two existing paths have the expected real containment relationship. */
function assertRealContained(rootPath: string, candidatePath: string): void {
  const relative = path.relative(fs.realpathSync(rootPath), fs.realpathSync(candidatePath));
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new UnsafeExactSubjectStoreError('real path escapes its configured root');
  }
}

/** Treat POSIX group/world-writable owner metadata as mutable by another principal. */
function isSharedWritable(stat: fs.Stats): boolean {
  return process.platform !== 'win32' && (stat.mode & 0o022) !== 0;
}

/** Refuse a tenant boundary another POSIX principal can rename beneath a checked path. */
function assertPrivateDirectoryBoundary(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || isSharedWritable(stat)) {
    throw new UnsafeExactSubjectStoreError('storage boundary is linked or shared-writable');
  }
}

/** Read a canonical directory's exact owner marker through a no-follow file descriptor. */
function readOwnerMarker(subjectDir: string): string {
  const markerPath = path.join(subjectDir, OWNER_MARKER);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const before = lstatIfPresent(markerPath);
  if (!before || before.isSymbolicLink() || !before.isFile() || before.nlink !== 1
      || before.size > 512 || isSharedWritable(before)) {
    throw new UnsafeExactSubjectStoreError('owner marker is not a bounded private file');
  }
  let handle: number | undefined;
  try {
    handle = fs.openSync(markerPath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(handle);
    const after = fs.lstatSync(markerPath);
    const unchanged = !after.isSymbolicLink() && after.isFile()
      && before.dev === opened.dev && opened.dev === after.dev
      && before.ino === opened.ino && opened.ino === after.ino
      && before.size === opened.size && opened.size === after.size;
    if (!unchanged || opened.nlink !== 1 || opened.size > 512 || isSharedWritable(opened)) {
      throw new UnsafeExactSubjectStoreError('owner marker is not a bounded private file');
    }
    return requireExactUserSubject(fs.readFileSync(handle, 'utf8'), 'owner marker');
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

/** Create a canonical directory's owner marker once, without replacing an existing binding. */
function bindOwnerMarker(subjectDir: string, subject: string): void {
  const markerPath = path.join(subjectDir, OWNER_MARKER);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow;
  let handle: number | undefined;
  try {
    handle = fs.openSync(markerPath, flags, 0o600);
    fs.fchmodSync(handle, 0o600);
    fs.writeFileSync(handle, subject, 'utf8');
    fs.fsyncSync(handle);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
  if (readOwnerMarker(subjectDir) !== subject) {
    throw new UnsafeExactSubjectStoreError('owner marker does not match the exact subject');
  }
}

/** Find an exact directory entry without accepting filesystem case or whitespace aliases. */
function exactDirectoryEntry(tenantRoot: string, name: string): fs.Dirent | undefined {
  return fs.readdirSync(tenantRoot, { withFileTypes: true }).find((entry) => entry.name === name);
}

/** Verify one selected entry is a link-free directory contained by its tenant. */
function assertedSubjectDirectory(tenantRoot: string, entry: fs.Dirent): string {
  const subjectDir = path.join(tenantRoot, entry.name);
  assertContained(tenantRoot, subjectDir);
  const stat = fs.lstatSync(subjectDir);
  if (entry.isSymbolicLink() || stat.isSymbolicLink() || !stat.isDirectory() || isSharedWritable(stat)) {
    throw new UnsafeExactSubjectStoreError('subject entry is linked or not a directory');
  }
  assertRealContained(tenantRoot, subjectDir);
  return subjectDir;
}

/** Resolve and inspect the configured tenant root without creating storage. */
function inspectedTenant(storeRoot: string, tenant: string): { storeRoot: string; tenantRoot: string; exists: boolean } {
  const root = normalizedStoreRoot(storeRoot);
  const tenantRoot = path.join(root, validatedTenant(tenant));
  assertContained(root, tenantRoot);
  const rootExists = inspectLinkFreeDirectory(root);
  const tenantExists = rootExists && inspectLinkFreeDirectory(tenantRoot);
  if (rootExists) assertPrivateDirectoryBoundary(root);
  if (tenantExists) {
    assertPrivateDirectoryBoundary(tenantRoot);
    assertRealContained(root, tenantRoot);
  }
  return { storeRoot: root, tenantRoot, exists: tenantExists };
}

/**
 * @description Derives a fixed-length collision-resistant directory key from exact UTF-8 subject
 * bytes, preserving case, separators, and surrounding whitespace as distinct identities.
 * @param subject - Exact validated OIDC subject.
 * @returns A portable 66-character directory component.
 */
export function exactSubjectDirectoryKey(subject: string): string {
  const exact = requireExactUserSubject(subject);
  return `u-${crypto.createHash('sha256').update(exact, 'utf8').digest('hex')}`;
}

/**
 * @description Resolves an exact owner to a canonical digest directory or an existing exact-name
 * legacy directory. Canonical/legacy coexistence, marker mismatch, and filesystem aliases fail closed.
 * @param storeRoot - Configured root that contains tenant directories.
 * @param tenant - Portable tenant identifier.
 * @param subject - Exact OIDC subject.
 * @returns Inspected owner directory metadata without creating anything.
 */
export function resolveExactSubjectStoreDirectory(
  storeRoot: string,
  tenant: string,
  subject: string,
): ExactSubjectStoreDirectory {
  const exact = requireExactUserSubject(subject);
  const inspected = inspectedTenant(storeRoot, tenant);
  const key = exactSubjectDirectoryKey(exact);
  if (!inspected.exists) return { ...inspected, subjectDir: path.join(inspected.tenantRoot, key), exists: false, kind: 'canonical' };
  const canonical = exactDirectoryEntry(inspected.tenantRoot, key);
  const legacy = exactDirectoryEntry(inspected.tenantRoot, exact);
  if (canonical && legacy && canonical.name !== legacy.name) {
    throw new UnsafeExactSubjectStoreError('canonical and legacy owner aliases coexist');
  }
  if (canonical) {
    const subjectDir = assertedSubjectDirectory(inspected.tenantRoot, canonical);
    if (readOwnerMarker(subjectDir) !== exact) throw new UnsafeExactSubjectStoreError('canonical owner binding mismatch');
    return { ...inspected, subjectDir, exists: true, kind: 'canonical' };
  }
  if (legacy) {
    const subjectDir = assertedSubjectDirectory(inspected.tenantRoot, legacy);
    return { ...inspected, subjectDir, exists: true, kind: 'legacy' };
  }
  return { ...inspected, subjectDir: path.join(inspected.tenantRoot, key), exists: false, kind: 'canonical' };
}

/**
 * @description Creates a private canonical owner directory when no safe exact legacy directory
 * exists, then binds it permanently to the exact subject with a mode-0600 no-follow marker.
 * @param storeRoot - Configured root that contains tenant directories.
 * @param tenant - Portable tenant identifier.
 * @param subject - Exact OIDC subject.
 * @returns The existing legacy or newly verified canonical owner directory.
 */
export function ensureExactSubjectStoreDirectory(
  storeRoot: string,
  tenant: string,
  subject: string,
): ExactSubjectStoreDirectory {
  const exact = requireExactUserSubject(subject);
  const root = ensureLinkFreeDirectory(normalizedStoreRoot(storeRoot), 0o750);
  const tenantRoot = ensureLinkFreeDirectory(path.join(root, validatedTenant(tenant)), 0o750);
  assertPrivateDirectoryBoundary(root);
  assertPrivateDirectoryBoundary(tenantRoot);
  assertContained(root, tenantRoot);
  assertRealContained(root, tenantRoot);
  const resolved = resolveExactSubjectStoreDirectory(root, tenant, exact);
  if (resolved.kind === 'legacy') return resolved;
  const subjectDir = ensureLinkFreeDirectory(resolved.subjectDir, 0o700);
  assertContained(tenantRoot, subjectDir);
  assertRealContained(tenantRoot, subjectDir);
  bindOwnerMarker(subjectDir, exact);
  return resolveExactSubjectStoreDirectory(root, tenant, exact);
}

/**
 * @description Resolves one fixed child directory without following an existing link or allowing
 * parent syntax in its name; an absent parent or child remains a non-mutating path result.
 * @param parentDirectory - Exact-owner directory that anchors the child.
 * @param childName - Single trusted layout component.
 * @returns Absolute child path after inspecting every existing component.
 */
export function resolveLinkFreeStoreSubdirectory(parentDirectory: string, childName: string): string {
  if (!childName || path.basename(childName) !== childName) {
    throw new UnsafeExactSubjectStoreError('child directory name is not one component');
  }
  const parent = path.resolve(parentDirectory);
  const child = path.join(parent, childName);
  assertContained(parent, child);
  if (!inspectLinkFreeDirectory(parent)) return child;
  const childExists = inspectLinkFreeDirectory(child);
  if (childExists) assertRealContained(parent, child);
  return child;
}

/**
 * @description Creates one fixed private child below a verified exact-owner directory and checks
 * lexical plus real containment after creation.
 * @param parentDirectory - Existing exact-owner directory that anchors the child.
 * @param childName - Single trusted layout component.
 * @returns Absolute verified child directory.
 */
export function ensureLinkFreeStoreSubdirectory(parentDirectory: string, childName: string): string {
  const child = resolveLinkFreeStoreSubdirectory(parentDirectory, childName);
  if (!inspectLinkFreeDirectory(parentDirectory)) {
    throw new UnsafeExactSubjectStoreError('child directory parent is missing');
  }
  ensureLinkFreeDirectory(child, 0o700);
  assertRealContained(parentDirectory, child);
  return child;
}

/**
 * @description Enumerates exact subjects from canonical owner markers and unambiguous legacy
 * directory names, rejecting linked entries, marker/key mismatch, and duplicate aliases.
 * @param storeRoot - Configured root that contains tenant directories.
 * @param tenant - Portable tenant identifier.
 * @returns Verified existing owner directories and their exact subjects.
 */
export function listExactSubjectStoreDirectories(
  storeRoot: string,
  tenant: string,
): Array<ExactSubjectStoreDirectory & { subject: string }> {
  const inspected = inspectedTenant(storeRoot, tenant);
  if (!inspected.exists) return [];
  const results: Array<ExactSubjectStoreDirectory & { subject: string }> = [];
  const seen = new Set<string>();
  for (const entry of fs.readdirSync(inspected.tenantRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new UnsafeExactSubjectStoreError('tenant contains a linked entry');
    if (!entry.isDirectory()) continue;
    const subjectDir = assertedSubjectDirectory(inspected.tenantRoot, entry);
    const subject = CANONICAL_DIRECTORY_PATTERN.test(entry.name)
      ? readOwnerMarker(subjectDir)
      : requireExactUserSubject(entry.name, 'legacy owner directory');
    if (CANONICAL_DIRECTORY_PATTERN.test(entry.name) && exactSubjectDirectoryKey(subject) !== entry.name) {
      throw new UnsafeExactSubjectStoreError('canonical directory key does not match its owner marker');
    }
    const resolved = resolveExactSubjectStoreDirectory(inspected.storeRoot, tenant, subject);
    if (resolved.subjectDir !== subjectDir || seen.has(subject)) {
      throw new UnsafeExactSubjectStoreError('owner directory has an ambiguous alias');
    }
    seen.add(subject);
    results.push({ ...resolved, subject });
  }
  return results;
}

/** Assert one existing entry is an ordinary single-link file within its link-free directory. */
function assertRegularFileOrMissing(directory: string, fileName: string): boolean {
  if (path.basename(fileName) !== fileName || !fileName) {
    throw new UnsafeExactSubjectStoreError('file name is not a single path component');
  }
  if (!inspectLinkFreeDirectory(directory)) throw new UnsafeExactSubjectStoreError('file parent is missing');
  const filePath = path.join(directory, fileName);
  assertContained(directory, filePath);
  const stat = lstatIfPresent(filePath);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new UnsafeExactSubjectStoreError('store file is linked or nonregular');
  }
  assertRealContained(directory, filePath);
  return true;
}

/**
 * @description Verifies that one optional store file is an ordinary single-link file beneath a
 * link-free exact-owner directory; callers can safely distinguish absence without following it.
 * @param directory - Verified exact-owner directory containing the file.
 * @param fileName - Single basename with no parent components.
 * @returns True only when the file already exists as an ordinary single-link file.
 */
export function assertLinkFreeStoreFile(directory: string, fileName: string): boolean {
  return assertRegularFileOrMissing(directory, fileName);
}

/**
 * @description Rejects links and nonregular entries for a SQLite database and every sidecar name
 * SQLite may open implicitly, preventing a validated main file from hiding a linked WAL or journal.
 * @param directory - Verified exact-owner directory containing the database.
 * @param databaseName - SQLite basename, without parent components.
 * @returns True only when the main database already exists as an ordinary single-link file.
 */
export function assertLinkFreeSqliteDatabase(directory: string, databaseName: string): boolean {
  let mainExists = false;
  for (const suffix of SQLITE_SIDECARS) {
    const exists = assertRegularFileOrMissing(directory, `${databaseName}${suffix}`);
    if (!suffix) mainExists = exists;
  }
  return mainExists;
}
