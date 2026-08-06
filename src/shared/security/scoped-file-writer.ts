/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added the controller-runtime scoped-file writer: approved names only, link-free parents, regular-target refusal, exclusive 0600 same-directory temp writes, atomic publish, and identity-owned cleanup.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Track file ownership with lossless bigint device/inode metadata and rename-stable fields; Windows preserves a destination name's birth time across delete/recreate, so birth/ctime are not ownership identifiers.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: narrow the exported writer to exact identity markers; credential workspace files are no longer an approved target class.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'scoped-file-writer' });
const SCOPED_FILE_PATTERN = /^\.oshal-user-(?:sub|key)$/;

/** Filesystem identity retained so cleanup never removes another invocation's replacement. */
export interface ScopedFileIdentity {
  filePath: string;
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
}

/** Stable refusal for a hostile scoped-file entry or parent. */
export class UnsafeScopedFileError extends Error {
  /** Stable machine-readable code used at the execution boundary. */
  public readonly code = 'UNSAFE_SCOPED_FILE';

  /** Create a bounded diagnostic that never includes a credential or subject. */
  constructor(reason: string) {
    super(`Unsafe scoped file: ${reason}`);
    this.name = 'UnsafeScopedFileError';
  }
}

/** Capture stable lstat/fstat fields for owned cleanup. */
function fileIdentity(stat: fs.BigIntStats, filePath: string): ScopedFileIdentity {
  return {
    filePath,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
  };
}

/** Read an entry without following links, returning undefined only for absence. */
function lstatIfPresent(filePath: string): fs.BigIntStats | undefined {
  try {
    return fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    logger.error({ err: error, filePath }, 'Scoped-file lstat failed');
    throw error;
  }
}

/** Verify that every existing absolute parent component is a real directory. */
export function assertLinkFreeScopedDirectory(directory: string): string {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = lstatIfPresent(current);
    if (!stat) throw new UnsafeScopedFileError('parent is missing');
    if (stat.isSymbolicLink()) throw new UnsafeScopedFileError('linked parent');
    if (!stat.isDirectory()) throw new UnsafeScopedFileError('non-directory parent');
  }
  return absolute;
}

/** Reject an existing target unless it is an ordinary, non-linked file. */
function assertRegularTargetOrMissing(filePath: string): void {
  const stat = lstatIfPresent(filePath);
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new UnsafeScopedFileError('linked target');
  if (!stat.isFile()) throw new UnsafeScopedFileError('nonregular target');
}

/** Create and fill one exclusive private temp file beside the final target. */
function writeExclusiveTemp(tempPath: string, value: string): ScopedFileIdentity {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow;
  const handle = fs.openSync(tempPath, flags, 0o600);
  try {
    fs.fchmodSync(handle, 0o600);
    fs.writeFileSync(handle, value, { encoding: 'utf8' });
    fs.fsyncSync(handle);
    return fileIdentity(fs.fstatSync(handle, { bigint: true }), tempPath);
  } finally {
    fs.closeSync(handle);
  }
}

/** True only while an entry is still the regular file represented by an owned identity. */
function sameIdentity(stat: fs.BigIntStats, identity: ScopedFileIdentity): boolean {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && stat.dev === identity.dev
    && stat.ino === identity.ino
    && stat.mode === identity.mode
    && stat.size === identity.size
    && stat.mtimeNs === identity.mtimeNs;
}

/**
 * Remove an entry only while lstat proves this invocation still owns it.
 * Raced links, directories, and replacement files are deliberately retained.
 */
export function removeOwnedScopedFile(identity: ScopedFileIdentity | undefined): boolean {
  if (!identity) return false;
  const stat = lstatIfPresent(identity.filePath);
  if (!stat || !sameIdentity(stat, identity)) return false;
  try {
    fs.unlinkSync(identity.filePath);
    return true;
  } catch (error) {
    logger.error({ err: error, filePath: identity.filePath }, 'Owned scoped-file cleanup failed');
    return false;
  }
}

/** Generate an unguessable same-directory temporary name for an approved target. */
function tempPathFor(targetPath: string): string {
  const suffix = crypto.randomBytes(16).toString('hex');
  return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.tmp-${process.pid}-${suffix}`);
}

/**
 * Write an approved scoped identity marker without opening the target for writing.
 * Publishing is atomic and failure cleanup is bound to the invocation-owned inode/file identity.
 */
export function writeScopedFile(filePath: string, value: string): ScopedFileIdentity {
  const targetPath = path.resolve(filePath);
  if (!SCOPED_FILE_PATTERN.test(path.basename(targetPath))) {
    throw new UnsafeScopedFileError('unapproved target name');
  }
  const directory = assertLinkFreeScopedDirectory(path.dirname(targetPath));
  assertRegularTargetOrMissing(targetPath);
  let tempIdentity: ScopedFileIdentity | undefined;
  let movedIdentity: ScopedFileIdentity | undefined;
  try {
    tempIdentity = writeExclusiveTemp(tempPathFor(targetPath), value);
    assertLinkFreeScopedDirectory(directory);
    assertRegularTargetOrMissing(targetPath);
    fs.renameSync(tempIdentity.filePath, targetPath);
    movedIdentity = { ...tempIdentity, filePath: targetPath };
    tempIdentity = undefined;
    const published = fs.lstatSync(targetPath, { bigint: true });
    if (!sameIdentity(published, movedIdentity)) {
      throw new UnsafeScopedFileError('atomic publish identity changed');
    }
    return fileIdentity(published, targetPath);
  } catch (error) {
    removeOwnedScopedFile(tempIdentity);
    removeOwnedScopedFile(movedIdentity);
    throw error;
  }
}
