/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extract held-task workspace synchronization from the remote-client route factory while preserving owner-aware journal reads, path confinement, and detailed failure logs.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Use the bot workspace canonical-ID contract for every held remote workspace so separators, traversal, drives, UNC syntax, Unicode, and case variants cannot collide at the filesystem boundary.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Refuse linked workspace parents and multi-link reads, publish uploads through exclusive private temporary files, and verify file identity so worker synchronization cannot read or overwrite data outside its held task folder.
 */

import { randomBytes } from 'crypto';
import { constants as fsConstants, promises as fsp, type BigIntStats } from 'fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';
import { raw, type Request, type RequestHandler, type Response, type Router } from 'express';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import type { RemoteClientRegistryService } from '@/features/remote-client';
import { canonicalBotWorkspaceId } from '../bot-node-request-scope';

const logger = createChildLogger({ module: 'remote-client-workspace-routes' });
const PRIVATE_FILE_MODE = 0o600;

const WORKSPACE_ROOT = (
  process.env.SHARED_WORKSPACE_ROOT
  || process.env.WORKSPACE_DIR
  || process.env.WORKSPACE_ROOT
  || '/app/workspace-shared'
).trim();

interface RemoteClientWorkspaceDependencies {
  registry: RemoteClientRegistryService;
  isMachineCaller: (req: Request) => boolean;
}

interface WorkspaceFileIdentity { dev: bigint; ino: bigint }

class UnsafeRemoteWorkspacePathError extends Error {
  constructor() {
    super('Unsafe remote workspace path');
    this.name = 'UnsafeRemoteWorkspacePathError';
  }
}

/** @description Mounts held-task-only workspace reads and additive writes. */
export function registerRemoteClientWorkspaceRoutes(
  router: Router,
  requireDeviceAccess: RequestHandler,
  deps: RemoteClientWorkspaceDependencies,
): void {
  const run = (req: Request, res: Response, operation: WorkspaceOperation): void => {
    void operation(req, res, deps);
  };
  router.get('/:clientId/tasks/:taskId/workspace', requireDeviceAccess, (req, res) => {
    run(req, res, handleWorkspaceManifest);
  });
  router.get('/:clientId/tasks/:taskId/workspace/file', requireDeviceAccess, (req, res) => {
    run(req, res, handleWorkspaceGetFile);
  });
  router.put(
    '/:clientId/tasks/:taskId/workspace/file',
    requireDeviceAccess,
    raw({ type: () => true, limit: '64mb' }),
    (req, res) => run(req, res, handleWorkspacePutFile),
  );
}

type WorkspaceOperation = (
  req: Request,
  res: Response,
  deps: RemoteClientWorkspaceDependencies,
) => Promise<void>;

/** @description Resolves a safe task folder under the shared workspace mount. */
export function taskWorkspaceFolder(folderId: string): string | null {
  const segment = sanitizeFolderId(folderId);
  return segment ? resolve(WORKSPACE_ROOT, segment) : null;
}

/** @description Resolves only a workspace attached to a task this client currently holds. */
async function resolveHeldWorkspace(
  clientId: string,
  taskId: string,
  deps: RemoteClientWorkspaceDependencies,
): Promise<{ dir: string; folderId: string } | null> {
  const task = await deps.registry.getInFlightTask(clientId, taskId);
  if (!task) return null;
  const folderId = sanitizeFolderId(task.workspacePath);
  return folderId ? { dir: resolve(WORKSPACE_ROOT, folderId), folderId } : null;
}

/** @description Encodes one logical remote workspace ID as a portable filesystem segment. */
function sanitizeFolderId(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    return canonicalBotWorkspaceId(value);
  } catch (error) {
    logger.warn({ err: error }, 'Rejected invalid remote task workspace identifier');
    return null;
  }
}

/** @description Joins a relative path without allowing escape from the held task folder. */
function safeJoin(directory: string, relativePath: string): string | null {
  const root = resolve(directory);
  const target = resolve(root, relativePath);
  return target === root || target.startsWith(root + sep) ? target : null;
}

/** @description Runs machine-secret calls as system and leaves session/node-token RLS identity intact. */
function runWorkspaceIdentity<T>(
  req: Request,
  deps: RemoteClientWorkspaceDependencies,
  operation: () => Promise<T>,
): Promise<T> {
  return deps.isMachineCaller(req) ? runWithSystemIdentity(operation) : operation();
}

/** @description Recursively lists regular files, treating an absent new folder as empty. */
async function listWorkspaceFiles(
  directory: string,
): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  const root = resolve(directory);
  await walkWorkspace(root, root, files);
  return files;
}

/** @description Traverses one workspace directory while logging every filesystem refusal. */
async function walkWorkspace(
  root: string,
  current: string,
  files: Array<{ path: string; size: number; mtimeMs: number }>,
): Promise<void> {
  await assertLinkFreeWorkspaceDirectory(root, current);
  let entries: import('fs').Dirent[];
  try {
    entries = await fsp.readdir(current, { withFileTypes: true });
  } catch (error) {
    logger.debug({ err: error, current }, 'Remote task workspace directory is not readable yet');
    return;
  }
  for (const entry of entries) await visitWorkspaceEntry(root, current, entry, files);
}

/** @description Visits one directory entry and records only regular files. */
async function visitWorkspaceEntry(
  root: string,
  current: string,
  entry: import('fs').Dirent,
  files: Array<{ path: string; size: number; mtimeMs: number }>,
): Promise<void> {
  const absolutePath = resolve(current, entry.name);
  try {
    const stat = await fsp.lstat(absolutePath, { bigint: true });
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) return walkWorkspace(root, absolutePath, files);
    if (!stat.isFile() || stat.nlink !== 1n) return;
    files.push({
      path: absolutePath.slice(root.length + 1).split(sep).join('/'),
      size: Number(stat.size),
      mtimeMs: Number(stat.mtimeNs / 1_000_000n),
    });
  } catch (error) {
    logger.warn({ err: error, absolutePath }, 'Remote task workspace file disappeared during manifest scan');
  }
}

/** @description Returns the held workspace manifest. */
async function handleWorkspaceManifest(
  req: Request,
  res: Response,
  deps: RemoteClientWorkspaceDependencies,
): Promise<void> {
  const workspace = await resolveRequestWorkspace(req, deps);
  if (!workspace) return denyWorkspace(res);
  try {
    res.json({ folderId: workspace.folderId, files: await listWorkspaceFiles(workspace.dir) });
  } catch (error) {
    logger.error({ err: error, folderId: workspace.folderId }, 'Failed to list remote workspace');
    res.status(500).json({ error: 'Failed to list workspace' });
  }
}

/** @description Returns one file from a held workspace. */
async function handleWorkspaceGetFile(
  req: Request,
  res: Response,
  deps: RemoteClientWorkspaceDependencies,
): Promise<void> {
  const workspace = await resolveRequestWorkspace(req, deps);
  if (!workspace) return denyWorkspace(res);
  const target = resolveRequestFile(req, workspace.dir, res);
  if (!target) return;
  try {
    res.setHeader('content-type', 'application/octet-stream');
    res.send(await readWorkspaceFile(workspace.dir, target));
  } catch (error) {
    if (error instanceof UnsafeRemoteWorkspacePathError) {
      res.status(400).json({ error: 'Unsafe workspace file' });
      return;
    }
    logger.debug({ err: error, folderId: workspace.folderId, target }, 'Remote workspace file was not found');
    res.status(404).json({ error: 'File not found' });
  }
}

/** @description Writes one file without deleting sibling or handover artifacts. */
async function handleWorkspacePutFile(
  req: Request,
  res: Response,
  deps: RemoteClientWorkspaceDependencies,
): Promise<void> {
  const workspace = await resolveRequestWorkspace(req, deps);
  if (!workspace) return denyWorkspace(res);
  const target = resolveRequestFile(req, workspace.dir, res);
  if (!target) return;
  try {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
    await writeWorkspaceFile(workspace.dir, target, body);
    res.json({ ok: true, path: readQueryPath(req), bytes: body.length });
  } catch (error) {
    if (error instanceof UnsafeRemoteWorkspacePathError) {
      res.status(400).json({ error: 'Unsafe workspace file' });
      return;
    }
    logger.error({ err: error, folderId: workspace.folderId, target }, 'Failed to write remote workspace file');
    res.status(500).json({ error: 'Failed to write file' });
  }
}

/** @description Read a regular single-link file while proving the opened entry is the validated target. */
async function readWorkspaceFile(root: string, target: string): Promise<Buffer> {
  await assertLinkFreeWorkspaceDirectory(root, dirname(target));
  const before = await requireRegularWorkspaceFile(target);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await fsp.open(target, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    const after = await requireRegularWorkspaceFile(target);
    if (!sameWorkspaceFile(before, opened) || !sameWorkspaceFile(opened, after)) {
      throw new UnsafeRemoteWorkspacePathError();
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** @description Atomically replace one held-workspace file without opening an existing target for writing. */
async function writeWorkspaceFile(root: string, target: string, body: Buffer): Promise<void> {
  const parent = await ensureLinkFreeWorkspaceDirectory(root, dirname(target));
  await assertRegularWorkspaceTargetOrMissing(target);
  const tempPath = resolve(parent, `.oshal-upload-${process.pid}-${randomBytes(16).toString('hex')}`);
  let tempIdentity: WorkspaceFileIdentity | undefined;
  let movedIdentity: WorkspaceFileIdentity | undefined;
  try {
    tempIdentity = await writeExclusiveWorkspaceTemp(tempPath, body);
    await assertLinkFreeWorkspaceDirectory(root, parent);
    await assertRegularWorkspaceTargetOrMissing(target);
    await fsp.rename(tempPath, target);
    movedIdentity = tempIdentity;
    tempIdentity = undefined;
    const published = await requireRegularWorkspaceFile(target);
    if (!movedIdentity || !sameWorkspaceFile(published, movedIdentity)) {
      throw new UnsafeRemoteWorkspacePathError();
    }
  } catch (error) {
    await removeOwnedWorkspaceFile(tempPath, tempIdentity);
    await removeOwnedWorkspaceFile(target, movedIdentity);
    throw error;
  }
}

/** @description Create parent directories one level at a time and reject every linked component. */
async function ensureLinkFreeWorkspaceDirectory(root: string, directory: string): Promise<string> {
  const rootPath = resolve(root);
  const segments = workspaceSegments(rootPath, directory);
  await requireWorkspaceDirectory(rootPath);
  let current = rootPath;
  for (const segment of segments) {
    current = resolve(current, segment);
    try { await fsp.mkdir(current, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await requireWorkspaceDirectory(current);
  }
  return assertLinkFreeWorkspaceDirectory(rootPath, directory);
}

/** @description Prove every existing component between the task root and a requested directory is real. */
async function assertLinkFreeWorkspaceDirectory(root: string, directory: string): Promise<string> {
  const rootPath = resolve(root);
  const segments = workspaceSegments(rootPath, directory);
  await requireWorkspaceDirectory(rootPath);
  let current = rootPath;
  for (const segment of segments) {
    current = resolve(current, segment);
    await requireWorkspaceDirectory(current);
  }
  return current;
}

/** @description Return a contained relative path as filesystem segments. */
function workspaceSegments(root: string, target: string): string[] {
  const value = relative(root, resolve(target));
  if (isAbsolute(value) || value === '..' || value.startsWith(`..${sep}`)) {
    throw new UnsafeRemoteWorkspacePathError();
  }
  return value ? value.split(sep).filter(Boolean) : [];
}

/** @description Require one path to be a non-linked directory. */
async function requireWorkspaceDirectory(directory: string): Promise<BigIntStats> {
  const stat = await fsp.lstat(directory, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new UnsafeRemoteWorkspacePathError();
  return stat;
}

/** @description Require an existing regular single-link file. */
async function requireRegularWorkspaceFile(target: string): Promise<BigIntStats> {
  const stat = await fsp.lstat(target, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) {
    throw new UnsafeRemoteWorkspacePathError();
  }
  return stat;
}

/** @description Refuse a present upload target unless atomic replacement cannot affect another entry. */
async function assertRegularWorkspaceTargetOrMissing(target: string): Promise<void> {
  try { await requireRegularWorkspaceFile(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

/** @description Create, fill, sync, and identify one exclusive private upload temporary file. */
async function writeExclusiveWorkspaceTemp(target: string, body: Buffer): Promise<WorkspaceFileIdentity> {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
  const handle = await fsp.open(target, flags, PRIVATE_FILE_MODE);
  let identity: WorkspaceFileIdentity | undefined;
  let complete = false;
  try {
    identity = workspaceFileIdentity(await handle.stat({ bigint: true }));
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(body);
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    if (!written.isFile() || written.nlink !== 1n || !sameWorkspaceFile(written, identity)) {
      throw new UnsafeRemoteWorkspacePathError();
    }
    complete = true;
    return identity;
  } finally {
    await handle.close();
    if (!complete) await removeOwnedWorkspaceFile(target, identity);
  }
}

/** @description Convert a stat into the stable filesystem identity used by publish cleanup. */
function workspaceFileIdentity(stat: BigIntStats): WorkspaceFileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

/** @description Compare a filesystem stat with another stat or retained identity. */
function sameWorkspaceFile(left: BigIntStats, right: BigIntStats | WorkspaceFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** @description Remove only an entry that still represents this invocation's temporary file. */
async function removeOwnedWorkspaceFile(target: string, identity?: WorkspaceFileIdentity): Promise<void> {
  if (!identity) return;
  try {
    const stat = await fsp.lstat(target, { bigint: true });
    if (stat.isFile() && !stat.isSymbolicLink() && sameWorkspaceFile(stat, identity)) await fsp.unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ err: error, target }, 'Failed to remove invocation-owned workspace upload');
    }
  }
}

/** @description Resolves route parameters under the caller's correct RLS identity. */
function resolveRequestWorkspace(
  req: Request,
  deps: RemoteClientWorkspaceDependencies,
): Promise<{ dir: string; folderId: string } | null> {
  return runWorkspaceIdentity(req, deps, () => resolveHeldWorkspace(
    normalizeParam(req.params.clientId),
    normalizeParam(req.params.taskId),
    deps,
  ));
}

/** @description Validates the requested relative path and writes a 400 on refusal. */
function resolveRequestFile(req: Request, directory: string, res: Response): string | null {
  const relativePath = readQueryPath(req);
  const target = safeJoin(directory, relativePath);
  if (relativePath && target) return target;
  res.status(400).json({ error: 'Invalid path' });
  return null;
}

/** @description Returns the single string query path accepted by the workspace protocol. */
function readQueryPath(req: Request): string {
  return typeof req.query.path === 'string' ? req.query.path : '';
}

/** @description Denies access without revealing another task's workspace details. */
function denyWorkspace(res: Response): void {
  res.status(403).json({ error: 'No workspace for a task this client holds' });
}

/** @description Normalizes an Express route parameter to a scalar string. */
function normalizeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
