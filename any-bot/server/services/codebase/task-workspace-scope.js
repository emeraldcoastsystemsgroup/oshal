/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added canonical cross-platform task IDs plus resolved, link-free workspace containment shared by every TaskController creation branch and trusted tool cwd resolution.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CANONICAL_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const WINDOWS_DEVICE_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/;
const MAX_WORKSPACE_SOURCE_BYTES = 2_048;

/** Stable refusal for a workspace identifier or path that cannot be safely contained. */
class UnsafeWorkspacePathError extends Error {
  /**
   * @description Builds a stable, non-path-disclosing workspace refusal.
   * @param {string} reason - Bounded diagnostic category.
   */
  constructor(reason) {
    super(`Unsafe task workspace: ${reason}`);
    this.name = 'UnsafeWorkspacePathError';
    this.code = 'UNSAFE_TASK_WORKSPACE';
  }
}

/**
 * @description Produces one cross-platform workspace segment from a logical server task ID.
 * Lowercase portable IDs remain readable; every path-shaped, mixed-case, Unicode, drive, UNC, or
 * reserved-device value becomes a deterministic SHA-256 scope. Invalid text is rejected.
 * @param {unknown} value - Logical ID that must never be joined directly to a filesystem root.
 * @returns {string} Portable single-segment workspace ID.
 */
function canonicalWorkspaceId(value) {
  const bytes = workspaceSourceBytes(value);
  if (CANONICAL_SEGMENT.test(value) && !WINDOWS_DEVICE_SEGMENT.test(value)) return value;
  const digest = crypto.createHash('sha256')
    .update('oshal-bot-workspace-v1\0', 'utf8')
    .update(bytes)
    .digest('hex');
  return `scope-${digest}`;
}

/** Validate a logical ID before it is retained or encoded. */
function workspaceSourceBytes(value) {
  if (typeof value !== 'string' || value.length === 0 || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new UnsafeWorkspacePathError('invalid logical id');
  }
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > MAX_WORKSPACE_SOURCE_BYTES || bytes.toString('utf8') !== value) {
    throw new UnsafeWorkspacePathError('invalid logical id');
  }
  return bytes;
}

/**
 * @description Resolves a configured workspace trust anchor. A configured root alias may itself
 * be a symlink, but callers receive its real directory so no child operation traverses that alias.
 * @param {string} root - Configured workspace root.
 * @returns {string} Existing real directory path.
 */
function resolveTrustedWorkspaceRoot(root) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new UnsafeWorkspacePathError('missing root');
  }
  const absolute = path.resolve(root);
  let real;
  try { real = fs.realpathSync.native(absolute); }
  catch { throw new UnsafeWorkspacePathError('root unavailable'); }
  const stat = fs.lstatSync(real);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new UnsafeWorkspacePathError('root is not a real directory');
  }
  return real;
}

/**
 * @description Creates a single missing root beneath an already trusted parent and returns its
 * real path. Recursive creation is intentionally avoided so an attacker cannot insert a linked
 * intermediate directory between checks.
 * @param {string} root - Desired workspace root.
 * @returns {string} Existing real directory path.
 */
function ensureTrustedWorkspaceRoot(root) {
  try { return resolveTrustedWorkspaceRoot(root); }
  catch (error) {
    if (fs.existsSync(path.resolve(root))) throw error;
  }
  const absolute = path.resolve(root);
  const parent = resolveTrustedWorkspaceRoot(path.dirname(absolute));
  const candidate = path.resolve(parent, path.basename(absolute));
  try { fs.mkdirSync(candidate, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return resolveTrustedWorkspaceRoot(candidate);
}

/** True only when candidate is root or a descendant on the host filesystem. */
function isContainedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

/**
 * @description Verifies every existing component below a trusted real root with lstat, rejecting
 * symlinks/junctions and non-directory parents. Missing suffixes are allowed for safe creation.
 * @param {string} realRoot - Real workspace trust anchor.
 * @param {string} candidate - Absolute candidate under that root.
 * @returns {boolean} True when the complete candidate already exists.
 */
function assertLinkFreeContainedPath(realRoot, candidate) {
  if (!isContainedPath(realRoot, candidate)) throw new UnsafeWorkspacePathError('path escape');
  const relative = path.relative(realRoot, candidate);
  const segments = relative ? relative.split(path.sep) : [];
  let current = realRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new UnsafeWorkspacePathError('linked component');
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new UnsafeWorkspacePathError('non-directory parent');
    }
    const realCurrent = fs.realpathSync.native(current);
    if (!isContainedPath(realRoot, realCurrent)) throw new UnsafeWorkspacePathError('resolved escape');
  }
  return true;
}

/**
 * @description Resolves a canonical child under one trusted workspace root and verifies any
 * existing components without following links.
 * @param {string} root - Configured workspace root.
 * @param {unknown} logicalId - Logical task/workspace identifier.
 * @returns {{taskId:string, workspaceDir:string, exists:boolean}} Canonical contained location.
 */
function resolveTaskWorkspace(root, logicalId) {
  const realRoot = resolveTrustedWorkspaceRoot(root);
  const taskId = canonicalWorkspaceId(logicalId);
  const workspaceDir = path.resolve(realRoot, taskId);
  const exists = assertLinkFreeContainedPath(realRoot, workspaceDir);
  if (exists && !fs.lstatSync(workspaceDir).isDirectory()) {
    throw new UnsafeWorkspacePathError('task entry is not a directory');
  }
  return { taskId, workspaceDir, exists };
}

/** Safely creates or validates one ordinary directory beneath a trusted root. */
function ensureDirectory(realRoot, directory) {
  const exists = assertLinkFreeContainedPath(realRoot, directory);
  if (!exists) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (!assertLinkFreeContainedPath(realRoot, directory) || !fs.lstatSync(directory).isDirectory()) {
    throw new UnsafeWorkspacePathError('directory creation race');
  }
}

/**
 * @description Creates a canonical task workspace and its standard child directories with a
 * link-free check before and after every creation.
 * @param {string} root - Configured workspace root.
 * @param {unknown} logicalId - Logical task/workspace identifier.
 * @returns {{taskId:string, workspaceDir:string, created:boolean}} Safe workspace result.
 */
function ensureTaskWorkspace(root, logicalId) {
  const realRoot = resolveTrustedWorkspaceRoot(root);
  const resolved = resolveTaskWorkspace(realRoot, logicalId);
  const created = !resolved.exists;
  ensureDirectory(realRoot, resolved.workspaceDir);
  for (const child of ['notes', 'deliverables', 'developer-handovers']) {
    ensureDirectory(realRoot, path.join(resolved.workspaceDir, child));
  }
  return { taskId: resolved.taskId, workspaceDir: resolved.workspaceDir, created };
}

/**
 * @description Resolves an existing task cwd against allowlisted roots using real paths and
 * link-free traversal. An unsafe supplied cwd is rejected rather than broadening to app root.
 * @param {unknown} value - Candidate absolute task workspace.
 * @param {string[]} roots - Configured workspace trust anchors.
 * @returns {string} Existing real contained directory.
 */
function resolveExistingTaskWorkspace(value, roots) {
  if (typeof value !== 'string' || value.length === 0 || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new UnsafeWorkspacePathError('invalid task cwd');
  }
  const candidate = path.resolve(value);
  for (const root of roots) {
    let realRoot;
    try { realRoot = resolveTrustedWorkspaceRoot(root); } catch { continue; }
    const absoluteRoot = path.resolve(root);
    let mappedCandidate;
    if (isContainedPath(realRoot, candidate)) {
      mappedCandidate = candidate;
    } else if (isContainedPath(absoluteRoot, candidate)) {
      mappedCandidate = path.resolve(realRoot, path.relative(absoluteRoot, candidate));
    } else {
      continue;
    }
    if (!assertLinkFreeContainedPath(realRoot, mappedCandidate)) continue;
    if (!fs.lstatSync(mappedCandidate).isDirectory()) continue;
    const candidateReal = fs.realpathSync.native(mappedCandidate);
    if (!isContainedPath(realRoot, candidateReal)) {
      throw new UnsafeWorkspacePathError('resolved task cwd escape');
    }
    return candidateReal;
  }
  throw new UnsafeWorkspacePathError('task cwd is outside allowed roots');
}

module.exports = {
  UnsafeWorkspacePathError,
  assertLinkFreeContainedPath,
  canonicalWorkspaceId,
  ensureTaskWorkspace,
  ensureTrustedWorkspaceRoot,
  isContainedPath,
  resolveExistingTaskWorkspace,
  resolveTaskWorkspace,
  resolveTrustedWorkspaceRoot,
};
