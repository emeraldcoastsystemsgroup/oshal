/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added one fail-closed writer for every `.oshal-user-*` and `.oshal-cred-*` file: link/nonregular refusal, exclusive mode-0600 same-directory temp creation, atomic publish, and identity-bound cleanup.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Use lossless bigint device/inode metadata plus rename-stable fields for ownership; Windows birth/ctime changes and path-level birth-time retention are deliberately excluded.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const SCOPED_FILE_PATTERN = /^(?:\.oshal-user-(?:sub|key)|\.oshal-cred-[a-z0-9][a-z0-9-]{0,63})$/;

/** Stable refusal for a hostile scoped-file entry or parent. */
class UnsafeScopedFileError extends Error {
  /**
   * @description Creates a non-secret diagnostic for a scoped-file safety failure.
   * @param {string} reason - Bounded refusal reason.
   */
  constructor(reason) {
    super(`Unsafe scoped file: ${reason}`);
    this.name = 'UnsafeScopedFileError';
    this.code = 'UNSAFE_SCOPED_FILE';
  }
}

/** Return stable identity fields used to prove later cleanup still owns an entry. */
function fileIdentity(stat, filePath) {
  return {
    filePath,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
  };
}

/** Read an entry without following links, returning null only for absence. */
function lstatIfPresent(filePath) {
  try { return fs.lstatSync(filePath, { bigint: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    logger.error({ err: error, filePath }, 'Scoped-file lstat failed');
    throw error;
  }
}

/** Verify that no existing absolute parent component is a symlink/junction. */
function assertLinkFreeDirectory(directory) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  const relative = absolute.slice(parsed.root.length);
  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
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

/** Reject an existing target unless it is a real ordinary file. */
function assertRegularTargetOrMissing(filePath) {
  const stat = lstatIfPresent(filePath);
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new UnsafeScopedFileError('linked target');
  if (!stat.isFile()) throw new UnsafeScopedFileError('nonregular target');
}

/** Create and fill an exclusive private temp file, returning its open-time identity. */
function writeExclusiveTemp(tempPath, value) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow;
  const handle = fs.openSync(tempPath, flags, 0o600);
  try {
    fs.fchmodSync(handle, 0o600);
    fs.writeFileSync(handle, String(value), { encoding: 'utf8' });
    fs.fsyncSync(handle);
    return fileIdentity(fs.fstatSync(handle, { bigint: true }), tempPath);
  } finally {
    fs.closeSync(handle);
  }
}

/** Compare one current lstat result to an invocation-owned identity. */
function sameIdentity(stat, identity) {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && stat.dev === identity.dev
    && stat.ino === identity.ino
    && stat.mode === identity.mode
    && stat.size === identity.size
    && stat.mtimeNs === identity.mtimeNs;
}

/**
 * @description Removes an entry only when lstat proves it is still the regular file created by
 * this invocation. A raced symlink, directory, or replacement is deliberately left untouched.
 * @param {object} identity - Identity returned by {@link writeScopedFile} or temp creation.
 * @returns {boolean} True only when the owned link was removed.
 */
function removeOwnedScopedFile(identity) {
  if (!identity || typeof identity.filePath !== 'string') return false;
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

/** Generate an unguessable same-directory temp path for an approved scoped target. */
function tempPathFor(targetPath) {
  const suffix = crypto.randomBytes(16).toString('hex');
  return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.tmp-${process.pid}-${suffix}`);
}

/**
 * @description Writes one approved scoped identity/credential file without ever opening the target
 * for writing. The payload goes to an exclusive 0600 temp beside the target, parents and any old
 * entry are revalidated, and rename publishes it atomically (replacing a raced symlink itself,
 * never its referent). Failure cleanup is identity-bound to the invocation-owned temp/target.
 * @param {string} filePath - Exact `.oshal-user-sub`, `.oshal-user-key`, or `.oshal-cred-*` path.
 * @param {string} value - Identity or short-lived credential payload.
 * @returns {object} Published file identity for later owned cleanup.
 */
function writeScopedFile(filePath, value) {
  const targetPath = path.resolve(filePath);
  if (!SCOPED_FILE_PATTERN.test(path.basename(targetPath))) {
    throw new UnsafeScopedFileError('unapproved target name');
  }
  const directory = assertLinkFreeDirectory(path.dirname(targetPath));
  assertRegularTargetOrMissing(targetPath);
  const tempPath = tempPathFor(targetPath);
  let tempIdentity;
  let movedIdentity;
  try {
    tempIdentity = writeExclusiveTemp(tempPath, value);
    assertLinkFreeDirectory(directory);
    assertRegularTargetOrMissing(targetPath);
    fs.renameSync(tempPath, targetPath);
    movedIdentity = { ...tempIdentity, filePath: targetPath };
    tempIdentity = undefined;
    const published = fs.lstatSync(targetPath, { bigint: true });
    if (!sameIdentity(published, movedIdentity)) {
      throw new UnsafeScopedFileError('atomic publish identity changed');
    }
    return fileIdentity(published, targetPath);
  } catch (error) {
    if (tempIdentity) removeOwnedScopedFile(tempIdentity);
    if (movedIdentity) removeOwnedScopedFile(movedIdentity);
    throw error;
  }
}

module.exports = {
  UnsafeScopedFileError,
  assertLinkFreeDirectory,
  removeOwnedScopedFile,
  writeScopedFile,
};
