/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Workspace-bound checkpoint (ADR-046 §1, BACKLOG "Workspace-bound checkpoint and tail replay"): the bounded redacted tree walk moved here from TokenChaseCapture.js and gained a real git commit built from the SAME redacted content-addressed objects, in a private bare repository under <workspace>/.tokenchase/git with a private index, so the task's own .git and index are never touched and no raw secret enters history. Commits are deterministic (fixed identity and date, message from task/seq/tree) and reachable under refs/tokenchase/<taskId>/<seq>. Every git call is bounded by a timeout and FAILS OPEN: workspaceCommit stays null and the caller flags the checkpoint incomplete; a SHA is never fabricated. restoreCheckpoint materializes a commit into an isolated directory through read-tree + checkout-index with a throwaway index, and digestWorkspaceTree computes the same manifest/tree digest without writing objects so a replay can compare artifacts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | restageFromObjects: the object-store fallback the bot-node tail executor uses for a frame captured before the private-git checkpoint existed (or whose commit failed open to null) — each manifest entry is path-guarded, read from .tokenchase/objects, digest-verified and written under the isolated target; a bad entry degrades the restage with a named warning instead of aborting. This moved off the controller, which no longer restages anything.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const logger = require('../../utils/logger');

/** @description The per-workspace capture directory name every Token Chase writer and reader agrees on. */
const CAPTURE_DIRNAME = '.tokenchase';
/** @description The end-of-run checkpoint file name inside the capture directory. */
const FINAL_FILE = 'final.json';
const GIT_DIRNAME = 'git';
const MAX_TREE_FILES = 200;
const MAX_TREE_FILE_BYTES = 256 * 1024;
const MAX_TREE_BYTES = 5 * 1024 * 1024;
const SKIP_TREE_SEGMENTS = new Set(['.git', 'node_modules', CAPTURE_DIRNAME]);
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT_MS = readPositiveInt(process.env.TOKEN_CHASE_GIT_TIMEOUT_MS, 15_000);
// A checkpoint commit must be reproducible from its tree alone: the identity and date are fixed
// constants of the format, so the same tree at the same seq/parent always yields the same SHA.
const GIT_IDENTITY_ENV = Object.freeze({
  GIT_AUTHOR_NAME: 'oshal token chase',
  GIT_AUTHOR_EMAIL: 'token-chase@oshal.example.com',
  GIT_COMMITTER_NAME: 'oshal token chase',
  GIT_COMMITTER_EMAIL: 'token-chase@oshal.example.com',
  GIT_AUTHOR_DATE: '1000000000 +0000',
  GIT_COMMITTER_DATE: '1000000000 +0000',
  GIT_CONFIG_NOSYSTEM: '1',
  // Blobs are written and checked out byte-for-byte: no eol conversion from any global config.
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.autocrlf',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'core.safecrlf',
  GIT_CONFIG_VALUE_1: 'false',
});

/** @description Parses a positive integer env value, else the fallback. */
function readPositiveInt(raw, fallback) {
  const value = Number.parseInt(String(raw ?? ''), 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** @description The frame file name for one call sequence (`frame-0007.json`). */
function frameFileName(seq) {
  return `frame-${String(seq).padStart(4, '0')}.json`;
}

/** @description Enumerate bounded regular text files without traversing symlinks or private capture data. */
function treeFiles(root, relative = '', out = []) {
  if (out.length >= MAX_TREE_FILES) return out;
  const absolute = path.join(root, relative);
  let entries;
  try { entries = fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return out; }
  for (const entry of entries) {
    if (out.length >= MAX_TREE_FILES) break;
    if (SKIP_TREE_SEGMENTS.has(entry.name)) continue;
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) treeFiles(root, child, out);
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/** @description Content-addressed digest over a sorted (path, sha256) manifest — the tree identity replay compares. */
function digestTree(files) {
  const hash = crypto.createHash('sha256');
  for (const entry of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${entry.path}\0${entry.sha256}\n`);
  }
  return hash.digest('hex');
}

/**
 * @description Walks a workspace into a bounded, redacted manifest. `onObject(sha256, bytes)` is
 * invoked for every retained file when supplied, so the same walk both snapshots objects (capture)
 * and merely digests a tree (replay comparison). Paths whose bytes changed under redaction are
 * listed in `redactedPaths`: a replay cannot faithfully reproduce those from the capture alone.
 * @param {string} workspaceDir - The workspace to walk.
 * @param {(text: string) => string} redact - The capture lane's secret scrubber.
 * @param {((sha256: string, bytes: Buffer) => void)|null} onObject - Optional object sink.
 * @returns {{files: Array<{path: string, sha256: string}>, treeSha: string, bytes: number, warnings: string[], complete: boolean, redactedPaths: string[]}}
 */
function walkWorkspaceTree(workspaceDir, redact, onObject) {
  const files = treeFiles(workspaceDir);
  const manifest = [];
  const warnings = [];
  const redactedPaths = [];
  let totalBytes = 0;
  for (const relative of files) {
    if (totalBytes >= MAX_TREE_BYTES) { warnings.push('workspace tree byte cap reached'); break; }
    const absolute = path.join(workspaceDir, relative);
    let bytes;
    try { bytes = fs.readFileSync(absolute); } catch { warnings.push(`unreadable workspace file: ${relative}`); continue; }
    if (bytes.length > MAX_TREE_FILE_BYTES || bytes.includes(0)) { warnings.push(`skipped non-text or oversized workspace file: ${relative}`); continue; }
    const safe = Buffer.from(redact(bytes.toString('utf8')), 'utf8');
    if (totalBytes + safe.length > MAX_TREE_BYTES) { warnings.push('workspace tree byte cap reached'); break; }
    const posixPath = relative.replaceAll(path.sep, '/');
    if (!safe.equals(bytes)) redactedPaths.push(posixPath);
    const sha256 = crypto.createHash('sha256').update(safe).digest('hex');
    if (onObject) onObject(sha256, safe);
    manifest.push({ path: posixPath, sha256 });
    totalBytes += safe.length;
  }
  const complete = warnings.length === 0 && files.length <= MAX_TREE_FILES;
  return { files: manifest, treeSha: digestTree(manifest), bytes: totalBytes, warnings, complete, redactedPaths };
}

/** @description Writes one content-addressed object, tolerating a concurrent writer of the same content. */
function writeObject(objectDir, sha256, bytes) {
  const objectPath = path.join(objectDir, sha256);
  if (fs.existsSync(objectPath)) return;
  try {
    fs.writeFileSync(objectPath, bytes, { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

/**
 * @description Snapshot text workspace files into redacted content-addressed objects under `objectDir`.
 * @param {string} workspaceDir - The workspace to snapshot.
 * @param {string} objectDir - The content-addressed object store (created if absent).
 * @param {(text: string) => string} redact - The capture lane's secret scrubber.
 * @returns {ReturnType<typeof walkWorkspaceTree>} The manifest plus tree digest and redaction notes.
 */
function snapshotWorkspaceTree(workspaceDir, objectDir, redact) {
  fs.mkdirSync(objectDir, { recursive: true });
  return walkWorkspaceTree(workspaceDir, redact, (sha256, bytes) => writeObject(objectDir, sha256, bytes));
}

/**
 * @description Digest a directory with the capture walk WITHOUT writing objects — the replay side
 * of the artifact comparison.
 * @param {string} workspaceDir - The directory to digest.
 * @param {(text: string) => string} redact - The same scrubber capture used, so both sides agree.
 * @returns {ReturnType<typeof walkWorkspaceTree>} The manifest plus tree digest.
 */
function digestWorkspaceTree(workspaceDir, redact) {
  return walkWorkspaceTree(workspaceDir, redact, null);
}

/** @description Bounded git invocation against the private capture repository; throws on failure or timeout. */
function git(args, { gitDir, indexFile, input, cwd }) {
  const configFile = path.join(gitDir, 'empty-config');
  const env = {
    ...process.env,
    ...GIT_IDENTITY_ENV,
    GIT_DIR: gitDir,
    GIT_CONFIG_GLOBAL: configFile,
    ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
  };
  // A private repo must never inherit an ambient work tree, index, or namespace from the process.
  delete env.GIT_WORK_TREE;
  delete env.GIT_NAMESPACE;
  if (!indexFile) delete env.GIT_INDEX_FILE;
  return execFileSync('git', args, {
    env, cwd: cwd || gitDir, input, timeout: GIT_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8',
  }).trim();
}

/** @description Resolve (and lazily create) the private bare checkpoint repository for one capture dir. */
function ensureCheckpointRepo(captureDir) {
  const gitDir = path.join(captureDir, GIT_DIRNAME);
  if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'empty-config'), '', { flag: 'a' });
    git(['init', '-q', '--bare'], { gitDir });
  }
  return gitDir;
}

/** @description A ref-safe rendering of a task id (git refs refuse most punctuation). */
function refSegment(value) {
  const safe = String(value ?? '').replaceAll(/[^A-Za-z0-9-]/g, '_');
  return safe.length > 0 ? safe : 'task';
}

/** @description The reachable ref name for one checkpoint (`refs/tokenchase/<task>/<seq>`). */
function checkpointRef(taskId, seq) {
  return `refs/tokenchase/${refSegment(taskId)}/${refSegment(seq)}`;
}

/** @description Write the manifest's blobs (from the object store) and return the git tree SHA. */
function writeCheckpointTree(gitDir, indexFile, files, objectDir) {
  if (files.length === 0) {
    return git(['write-tree'], { gitDir, indexFile });
  }
  const objectPaths = files.map((entry) => path.join(objectDir, entry.sha256)).join('\n');
  const blobs = git(['hash-object', '-w', '--no-filters', '--stdin-paths'], { gitDir, input: `${objectPaths}\n` }).split(/\r?\n/);
  if (blobs.length !== files.length) throw new Error(`git hash-object returned ${blobs.length} blobs for ${files.length} files`);
  const indexInfo = files.map((entry, index) => `100644 blob ${blobs[index]}\t${entry.path}`).join('\n');
  git(['update-index', '--add', '--index-info'], { gitDir, indexFile, input: `${indexInfo}\n` });
  return git(['write-tree'], { gitDir, indexFile });
}

/**
 * @description Commit a captured manifest into the private checkpoint repository. The blobs are the
 * redacted objects already on disk, so history can never hold a byte the frame does not. Fails open:
 * any git failure logs at ERROR and yields `workspaceCommit: null` with the error — never a made-up SHA.
 * @param {{captureDir: string, taskId: string, seq: number|string, files: Array<{path: string, sha256: string}>, objectDir: string, parentSeq?: number|string|null}} input - The checkpoint to commit.
 * @returns {{workspaceCommit: string|null, gitTreeSha: string|null, ref: string, error: string|null}} The commit identity or the failure.
 */
function commitCheckpoint(input) {
  const ref = checkpointRef(input.taskId, input.seq);
  let indexFile = null;
  try {
    const gitDir = ensureCheckpointRepo(input.captureDir);
    indexFile = path.join(gitDir, `index-${process.pid}-${refSegment(input.seq)}-${crypto.randomBytes(4).toString('hex')}`);
    const tree = writeCheckpointTree(gitDir, indexFile, input.files, input.objectDir);
    const parentSeq = input.parentSeq ?? (Number.isInteger(input.seq) && input.seq > 0 ? input.seq - 1 : null);
    const parentArgs = [];
    if (parentSeq !== null) {
      try { parentArgs.push('-p', git(['rev-parse', '--verify', '-q', `${checkpointRef(input.taskId, parentSeq)}^{commit}`], { gitDir })); } catch { /* first checkpoint of the run has no parent */ }
    }
    const message = `tokenchase ${refSegment(input.taskId)} seq ${refSegment(input.seq)} tree ${tree}`;
    const commit = git(['commit-tree', tree, ...parentArgs, '-m', message], { gitDir });
    if (!SHA1_PATTERN.test(commit)) throw new Error(`git commit-tree returned an unexpected value: ${commit.slice(0, 64)}`);
    git(['update-ref', ref, commit], { gitDir });
    return { workspaceCommit: commit, gitTreeSha: tree, ref, error: null };
  } catch (err) {
    logger.error(`[TokenChase] workspace checkpoint commit failed (task=${input.taskId} seq=${input.seq}): ${err.message}`);
    return { workspaceCommit: null, gitTreeSha: null, ref, error: err.message };
  } finally {
    if (indexFile) { try { fs.rmSync(indexFile, { force: true }); } catch { /* best effort */ } }
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** @description A manifest path is safe when it is relative, POSIX and never leaves the target. */
function safeManifestPath(relative) {
  if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative) || relative.includes('\\')) return null;
  const segments = relative.split('/');
  return segments.some((segment) => segment === '' || segment === '.' || segment === '..') ? null : relative;
}

/**
 * @description Restage a captured manifest from the content-addressed object store into an isolated
 * directory — the fallback for frames that carry a workspaceTree but no checkpoint commit. Every
 * object is digest-verified before it is written; an unsafe path, a missing object or a digest
 * mismatch is recorded as a warning and skipped, never written.
 * @param {{files: Array<{path: string, sha256: string}>, objectDir: string, targetDir: string}} input - The manifest, the object store and the isolated target.
 * @returns {{restored: number, total: number, warnings: string[]}} How many objects landed and what could not.
 */
function restageFromObjects(input) {
  const targetDir = path.resolve(input.targetDir);
  fs.mkdirSync(targetDir, { recursive: true });
  const files = Array.isArray(input.files) ? input.files : [];
  const warnings = [];
  let restored = 0;
  for (const entry of files) {
    const relative = safeManifestPath(entry && entry.path);
    const sha = entry && typeof entry.sha256 === 'string' ? entry.sha256.toLowerCase() : '';
    if (!relative || !SHA256_PATTERN.test(sha)) { warnings.push(`skipped unsafe manifest entry: ${String(entry && entry.path)}`); continue; }
    let bytes;
    try { bytes = fs.readFileSync(path.join(input.objectDir, sha)); } catch { warnings.push(`missing tree object for ${relative}`); continue; }
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== sha) { warnings.push(`object digest mismatch for ${relative}`); continue; }
    const destination = path.join(targetDir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
    restored += 1;
  }
  return { restored, total: files.length, warnings };
}

/**
 * @description Materialize one checkpoint commit into an isolated directory (the replay worktree). Uses a
 * throwaway index so neither the task's index nor the capture repository's state is touched. Throws when
 * the SHA is malformed, the repository is absent, or git fails.
 * @param {{captureDir: string, sha: string, targetDir: string}} input - The commit to restore and where.
 * @returns {{restored: number, sha: string}} The number of files written and the commit restored.
 */
function restoreCheckpoint(input) {
  const sha = String(input.sha ?? '').trim().toLowerCase();
  if (!SHA1_PATTERN.test(sha)) throw new Error('workspace checkpoint sha is not a 40-hex commit id');
  const gitDir = path.join(input.captureDir, GIT_DIRNAME);
  if (!fs.existsSync(path.join(gitDir, 'HEAD'))) throw new Error('no checkpoint repository for this run');
  const targetDir = path.resolve(input.targetDir);
  fs.mkdirSync(targetDir, { recursive: true });
  const indexFile = path.join(gitDir, `index-restore-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    git(['read-tree', sha], { gitDir, indexFile });
    const listing = git(['ls-files'], { gitDir, indexFile });
    git(['--work-tree', targetDir, 'checkout-index', '-a', '-f'], { gitDir, indexFile, cwd: targetDir });
    return { restored: listing.length === 0 ? 0 : listing.split(/\r?\n/).length, sha };
  } finally {
    try { fs.rmSync(indexFile, { force: true }); } catch { /* best effort */ }
  }
}

module.exports = {
  CAPTURE_DIRNAME,
  FINAL_FILE,
  MAX_TREE_FILES,
  checkpointRef,
  commitCheckpoint,
  digestTree,
  digestWorkspaceTree,
  frameFileName,
  restageFromObjects,
  restoreCheckpoint,
  snapshotWorkspaceTree,
  writeObject,
};
