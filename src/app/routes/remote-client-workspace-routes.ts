/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extract held-task workspace synchronization from the remote-client route factory while preserving owner-aware journal reads, path confinement, and detailed failure logs.
 */

import { promises as fsp } from 'fs';
import { basename, resolve, sep } from 'path';
import { raw, type Request, type RequestHandler, type Response, type Router } from 'express';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import type { RemoteClientRegistryService } from '@/features/remote-client';

const logger = createChildLogger({ module: 'remote-client-workspace-routes' });

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

/** @description Rejects traversal and multi-segment task workspace identifiers. */
function sanitizeFolderId(value: string | undefined): string | null {
  if (!value) return null;
  const segment = basename(String(value));
  if (!segment || segment === '.' || segment === '..') return null;
  if (segment.includes('/') || segment.includes('\\')) return null;
  return segment;
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
  if (entry.isDirectory()) return walkWorkspace(root, absolutePath, files);
  if (!entry.isFile()) return;
  try {
    const stat = await fsp.stat(absolutePath);
    files.push({
      path: absolutePath.slice(root.length + 1).split(sep).join('/'),
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
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
    res.send(await fsp.readFile(target));
  } catch (error) {
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
    await fsp.mkdir(resolve(target, '..'), { recursive: true });
    await fsp.writeFile(target, body);
    res.json({ ok: true, path: readQueryPath(req), bytes: body.length });
  } catch (error) {
    logger.error({ err: error, folderId: workspace.folderId, target }, 'Failed to write remote workspace file');
    res.status(500).json({ error: 'Failed to write file' });
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
