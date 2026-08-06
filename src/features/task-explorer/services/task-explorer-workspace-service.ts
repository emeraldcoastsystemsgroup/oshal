/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted task explorer workspace browsing and file preview logic into a dedicated service to satisfy the Session 68 decomposition gate
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Aligned workspace root discovery with shared swarm task-folder paths so cockpit artifact browsing resolves real ticket workspaces
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Bound every filesystem lookup to an exact task/workspace owner or operator, removed guessed-folder discovery, rejected link escapes, bounded trees/previews, and removed absolute paths from payloads.
 */

import { constants as fsConstants, type Dirent, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ITaskStore } from '@/entities/task';
import type { InternalWorkspace } from '@/entities/workspace';
import type { WorkspaceService } from '@/features/ticketing';
import { createChildLogger } from '@/shared/logger';
import { resolveSharedWorkspaceRoot } from '@/shared/workspace-root';

const logger = createChildLogger({ module: 'task-explorer-workspace-service' });
const FILE_PREVIEW_LIMIT_BYTES = 256 * 1024;
const TREE_MAX_DEPTH = 8;
const TREE_MAX_FILES = 500;
const TREE_MAX_ENTRIES = 1_000;
const TREE_MAX_FILE_BYTES = 32 * 1024 * 1024;
const WORKSPACE_BROWSE_LIMIT = 200;
const SAFE_TASK_FOLDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;
const IGNORED_WORKSPACE_ENTRIES = new Set(['.git', '.oshal', 'node_modules']);
const TEXT_FILE_EXTENSIONS = new Set([
  'css', 'csv', 'html', 'js', 'json', 'jsx', 'log', 'md', 'mjs', 'sql', 'svg', 'sh',
  'text', 'ts', 'tsx', 'txt', 'xml', 'yaml', 'yml',
]);

interface WorkspacePrincipal {
  sub: string;
  operator: boolean;
}

interface WorkspaceLocation {
  absolutePath: string;
  displayPath: string;
  exists: boolean;
}

interface InspectedDirectory {
  absolutePath: string;
  exists: boolean;
}

interface WorkspaceEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  extension: string;
  size?: number;
  sizeFormatted?: string;
  modified?: string;
  truncated?: boolean;
  children?: WorkspaceEntry[];
}

interface TreeBudget {
  entries: number;
  files: number;
  fileBytes: number;
  truncated: boolean;
}

interface WorkspaceSummary {
  name: string;
  path: string;
  fileCount: number;
  modified: string;
  truncated: boolean;
}

/**
 * @description Builds owner-scoped, bounded workspace trees and text previews without
 * exposing host paths or following filesystem links.
 */
export class TaskExplorerWorkspaceService {
  private readonly workspaceRoot: string;

  /**
   * @description Creates a task-explorer workspace boundary over task and workspace records.
   * @param taskStore - Task persistence boundary used to establish exact ownership.
   * @param workspaceService - Optional DB-backed workspace and ticket-link resolver.
   */
  constructor(
    private readonly taskStore: ITaskStore,
    private readonly workspaceService?: WorkspaceService,
  ) {
    this.workspaceRoot = resolveSharedWorkspaceRoot();
  }

  /**
   * @description Resolves a bounded file tree only after exact owner/operator authorization.
   * @param ticketId - Persisted task, ticket, or workspace identifier.
   * @param callerSub - Exact authenticated OIDC subject.
   * @param operator - Whether the caller is explicitly operator-authorized.
   * @returns Logical workspace path, existence, bounded children, and truncation metrics.
   */
  async getWorkspaceFiles(
    ticketId: string,
    callerSub: string,
    operator = false,
  ): Promise<Record<string, unknown>> {
    return this.measure('getWorkspaceFiles', async () => {
      const workspace = await this.resolveWorkspace(ticketId, principal(callerSub, operator));
      if (!workspace.exists) return missingWorkspacePayload(workspace.displayPath);

      const budget = newTreeBudget();
      const children = await this.readWorkspaceEntries(workspace.absolutePath, workspace.absolutePath, 0, budget);
      return {
        path: workspace.displayPath,
        exists: true,
        children,
        truncated: budget.truncated,
        scanned: { entries: budget.entries, files: budget.files, fileBytes: budget.fileBytes },
      };
    }, { ticketId });
  }

  /**
   * @description Lists only DB-recorded workspaces visible to the exact caller; ordinary
   * users never enumerate filesystem-global folder names.
   * @param callerSub - Exact authenticated OIDC subject.
   * @param operator - Whether the caller may view all recorded workspaces.
   * @returns Bounded logical workspace summaries.
   */
  async browseWorkspaces(callerSub: string, operator = false): Promise<{
    basePath: string;
    workspaces: WorkspaceSummary[];
    total: number;
  }> {
    return this.measure('browseWorkspaces', async () => {
      const identity = principal(callerSub, operator);
      const workspaces = await this.listAuthorizedWorkspaces(identity);
      return { basePath: 'workspace', workspaces, total: workspaces.length };
    });
  }

  /**
   * @description Reads at most the preview byte budget from a contained regular text file.
   * @param ticketId - Persisted task, ticket, or workspace identifier.
   * @param relativePath - Relative path within the authorized workspace.
   * @param callerSub - Exact authenticated OIDC subject.
   * @param operator - Whether the caller is explicitly operator-authorized.
   * @returns Logical metadata and bounded UTF-8 preview content.
   */
  async getWorkspaceFileContent(
    ticketId: string,
    relativePath: string,
    callerSub: string,
    operator = false,
  ): Promise<Record<string, unknown>> {
    return this.measure('getWorkspaceFileContent', async () => {
      const workspace = await this.resolveWorkspace(ticketId, principal(callerSub, operator));
      if (!workspace.exists) throw new Error('Workspace not found');
      const filePath = await resolveContainedRegularFile(workspace.absolutePath, relativePath);
      return this.readFilePreview(workspace.absolutePath, filePath);
    }, { ticketId, relativePath });
  }

  private async resolveWorkspace(ticketId: string, identity: WorkspacePrincipal): Promise<WorkspaceLocation> {
    if (!ticketId) throw new Error('Workspace not found');
    const task = await this.taskStore.get(ticketId);
    const linkedOwner = task?.ownerSub ?? await this.workspaceService?.resolveTaskOwner(ticketId) ?? null;
    if (task || linkedOwner) {
      if (!identity.operator && linkedOwner !== identity.sub) throw new Error('Workspace not found');
      return this.resolveTaskWorkspace(ticketId, identity);
    }

    const workspace = await this.workspaceService?.getWorkspace(ticketId) ?? null;
    if (!workspace || !canAccessWorkspace(identity, workspace)) throw new Error('Workspace not found');
    return this.locationFromRecord(workspace);
  }

  private async resolveTaskWorkspace(ticketId: string, identity: WorkspacePrincipal): Promise<WorkspaceLocation> {
    const linked = await this.workspaceService?.resolveTaskWorkspaceRecord(ticketId, ticketId) ?? null;
    if (linked) {
      if (linked.ownerSub && !identity.operator && linked.ownerSub !== identity.sub) {
        throw new Error('Workspace not found');
      }
      return this.locationFromRecord(linked);
    }
    if (!SAFE_TASK_FOLDER_ID.test(ticketId) || ticketId === '.' || ticketId === '..') {
      throw new Error('Workspace not found');
    }
    return this.locationFromPath(path.join(this.workspaceRoot, ticketId), ticketId);
  }

  private async locationFromRecord(workspace: InternalWorkspace): Promise<WorkspaceLocation> {
    return this.locationFromPath(workspace.path, workspace.workspaceId);
  }

  private async locationFromPath(candidatePath: string, displayId: string): Promise<WorkspaceLocation> {
    const inspected = await inspectLinkFreeDirectory(this.workspaceRoot, candidatePath);
    return {
      absolutePath: inspected.absolutePath,
      displayPath: `workspace/${displayId}`,
      exists: inspected.exists,
    };
  }

  private async listAuthorizedWorkspaces(identity: WorkspacePrincipal): Promise<WorkspaceSummary[]> {
    if (!this.workspaceService) return [];
    const options = identity.operator
      ? { limit: WORKSPACE_BROWSE_LIMIT }
      : { ownerSub: identity.sub, limit: WORKSPACE_BROWSE_LIMIT };
    const records = await this.workspaceService.listWorkspaces(options);
    const summaries: WorkspaceSummary[] = [];

    for (const workspace of records) {
      if (!canAccessWorkspace(identity, workspace)) continue;
      const summary = await this.tryBuildSummary(workspace);
      if (summary) summaries.push(summary);
    }
    return summaries.sort((left, right) => right.modified.localeCompare(left.modified));
  }

  private async tryBuildSummary(workspace: InternalWorkspace): Promise<WorkspaceSummary | null> {
    try {
      const location = await this.locationFromRecord(workspace);
      if (!location.exists) return null;
      const stat = await fs.lstat(location.absolutePath);
      const scan = await countTopLevelFiles(location.absolutePath);
      return {
        name: workspace.name,
        path: workspace.workspaceId,
        fileCount: scan.fileCount,
        modified: stat.mtime.toISOString(),
        truncated: scan.truncated,
      };
    } catch (error) {
      logger.error({ err: error, workspaceId: workspace.workspaceId }, 'Skipping unsafe workspace browse record');
      return null;
    }
  }

  private async readWorkspaceEntries(
    directoryPath: string,
    rootPath: string,
    depth: number,
    budget: TreeBudget,
  ): Promise<WorkspaceEntry[]> {
    const results: WorkspaceEntry[] = [];
    await assertPlainDirectory(directoryPath);
    await assertRealpathContained(rootPath, directoryPath);
    const directory = await fs.opendir(directoryPath);
    for await (const entry of directory) {
      if (IGNORED_WORKSPACE_ENTRIES.has(entry.name)) continue;
      if (budget.entries >= TREE_MAX_ENTRIES) {
        budget.truncated = true;
        break;
      }
      const built = await this.buildWorkspaceEntry(directoryPath, rootPath, entry, depth, budget);
      if (built) results.push(built);
      if (budget.truncated) break;
    }
    return results.sort((left, right) => this.sortWorkspaceEntries(left, right));
  }

  private async buildWorkspaceEntry(
    directoryPath: string,
    rootPath: string,
    entry: Dirent,
    depth: number,
    budget: TreeBudget,
  ): Promise<WorkspaceEntry | null> {
    const absolutePath = path.join(directoryPath, entry.name);
    const stat = await fs.lstat(absolutePath);
    if (entry.isSymbolicLink() || stat.isSymbolicLink()) throw new Error('Workspace links are not supported');
    if (!stat.isFile() && !stat.isDirectory()) return null;
    await assertRealpathContained(rootPath, absolutePath);
    budget.entries += 1;

    if (stat.isDirectory()) return this.buildDirectoryEntry(absolutePath, rootPath, entry.name, stat, depth, budget);
    if (!reserveFileBudget(stat.size, budget)) return null;
    return this.buildFileEntry(rootPath, absolutePath, entry.name, stat);
  }

  private async buildDirectoryEntry(
    absolutePath: string,
    rootPath: string,
    name: string,
    stat: Stats,
    depth: number,
    budget: TreeBudget,
  ): Promise<WorkspaceEntry> {
    const atDepthLimit = depth >= TREE_MAX_DEPTH;
    if (atDepthLimit) budget.truncated = true;
    const children = atDepthLimit
      ? []
      : await this.readWorkspaceEntries(absolutePath, rootPath, depth + 1, budget);
    return {
      name,
      path: path.relative(rootPath, absolutePath),
      type: 'directory',
      extension: '',
      modified: stat.mtime.toISOString(),
      truncated: atDepthLimit,
      children,
    };
  }

  private buildFileEntry(
    rootPath: string,
    absolutePath: string,
    name: string,
    stat: Stats,
  ): WorkspaceEntry {
    return {
      name,
      path: path.relative(rootPath, absolutePath),
      type: 'file',
      extension: readExtension(name),
      size: stat.size,
      sizeFormatted: formatFileSize(stat.size),
      modified: stat.mtime.toISOString(),
    };
  }

  private async readFilePreview(workspacePath: string, filePath: string): Promise<Record<string, unknown>> {
    const extension = readExtension(filePath);
    if (!TEXT_FILE_EXTENSIONS.has(extension)) throw new Error('Binary file preview is not supported');
    const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Requested path is not a file');
      const buffer = Buffer.alloc(FILE_PREVIEW_LIMIT_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const previewLength = Math.min(bytesRead, FILE_PREVIEW_LIMIT_BYTES);
      return {
        path: path.relative(workspacePath, filePath) || path.basename(filePath),
        content: buffer.subarray(0, previewLength).toString('utf8'),
        size: stat.size,
        language: extension || 'text',
        modified: stat.mtime.toISOString(),
        truncated: bytesRead > previewLength || stat.size > FILE_PREVIEW_LIMIT_BYTES,
      };
    } finally {
      await handle.close();
    }
  }

  private sortWorkspaceEntries(left: WorkspaceEntry, right: WorkspaceEntry): number {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
    return left.name.localeCompare(right.name);
  }

  private async measure<T>(
    method: string,
    operation: () => Promise<T>,
    metadata: Record<string, unknown> = {},
  ): Promise<T> {
    const startedAt = Date.now();
    logger.info({ method, ...metadata }, 'Task explorer workspace service entry');
    try {
      const result = await operation();
      logger.info({ method, durationMs: Date.now() - startedAt, ...metadata }, 'Task explorer workspace service exit');
      return result;
    } catch (error) {
      logger.error({ err: error, method, durationMs: Date.now() - startedAt, ...metadata }, 'Task explorer workspace service failure');
      throw error;
    }
  }
}

function principal(callerSub: string, operator: boolean): WorkspacePrincipal {
  if (!callerSub || callerSub.trim().length === 0 || callerSub.includes('\0')) {
    throw new Error('Workspace not found');
  }
  return { sub: callerSub, operator };
}

function canAccessWorkspace(identity: WorkspacePrincipal, workspace: InternalWorkspace): boolean {
  return identity.operator || (workspace.ownerSub !== null && workspace.ownerSub === identity.sub);
}

function missingWorkspacePayload(displayPath: string): Record<string, unknown> {
  return { path: displayPath, exists: false, children: [], truncated: false };
}

function newTreeBudget(): TreeBudget {
  return { entries: 0, files: 0, fileBytes: 0, truncated: false };
}

function reserveFileBudget(size: number, budget: TreeBudget): boolean {
  if (budget.files >= TREE_MAX_FILES || budget.fileBytes + size > TREE_MAX_FILE_BYTES) {
    budget.truncated = true;
    return false;
  }
  budget.files += 1;
  budget.fileBytes += size;
  return true;
}

async function countTopLevelFiles(directoryPath: string): Promise<{ fileCount: number; truncated: boolean }> {
  let count = 0;
  let entries = 0;
  const directory = await fs.opendir(directoryPath);
  for await (const entry of directory) {
    if (entries >= TREE_MAX_ENTRIES) return { fileCount: count, truncated: true };
    entries += 1;
    const childPath = path.join(directoryPath, entry.name);
    const stat = await fs.lstat(childPath);
    if (entry.isSymbolicLink() || stat.isSymbolicLink()) throw new Error('Workspace links are not supported');
    await assertRealpathContained(directoryPath, childPath);
    if (stat.isFile()) count += 1;
    if (count >= TREE_MAX_FILES) return { fileCount: TREE_MAX_FILES, truncated: true };
  }
  return { fileCount: count, truncated: false };
}

async function resolveContainedRegularFile(workspacePath: string, relativePath: string): Promise<string> {
  if (!relativePath || relativePath.includes('\0')) throw new Error('Requested path is invalid');
  await assertPlainDirectory(workspacePath);
  const absolutePath = path.resolve(workspacePath, relativePath);
  assertChildPath(workspacePath, absolutePath);
  const parts = path.relative(workspacePath, absolutePath).split(path.sep).filter(Boolean);
  let current = workspacePath;

  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Workspace links are not supported');
    await assertRealpathContained(workspacePath, current);
  }
  const stat = await fs.lstat(absolutePath);
  if (!stat.isFile()) throw new Error('Requested path is not a file');
  return absolutePath;
}

function assertChildPath(workspacePath: string, targetPath: string): void {
  const relative = path.relative(path.resolve(workspacePath), path.resolve(targetPath));
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('Requested path escapes workspace root');
  }
}

async function inspectLinkFreeDirectory(workspaceRoot: string, candidatePath: string): Promise<InspectedDirectory> {
  const absolutePath = resolveContainedPath(workspaceRoot, candidatePath);
  if (!(await pathExists(workspaceRoot))) return { absolutePath, exists: false };
  await assertPlainDirectory(workspaceRoot);
  const parts = path.relative(path.resolve(workspaceRoot), absolutePath).split(path.sep).filter(Boolean);
  let current = path.resolve(workspaceRoot);

  for (const part of parts) {
    current = path.join(current, part);
    if (!(await pathExists(current))) return { absolutePath, exists: false };
    await assertPlainDirectory(current);
    await assertRealpathContained(workspaceRoot, current);
  }
  return { absolutePath, exists: true };
}

function resolveContainedPath(workspaceRoot: string, candidatePath: string): string {
  const root = path.resolve(workspaceRoot);
  const absolutePath = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(root, candidatePath);
  const relative = path.relative(root, absolutePath);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('Workspace path escapes configured root');
  }
  return absolutePath;
}

async function assertPlainDirectory(targetPath: string): Promise<void> {
  const stat = await fs.lstat(targetPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Workspace links are not supported');
}

async function assertRealpathContained(rootPath: string, targetPath: string): Promise<void> {
  const [realRoot, realTarget] = await Promise.all([fs.realpath(rootPath), fs.realpath(targetPath)]);
  const relative = path.relative(realRoot, realTarget);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('Workspace path escapes configured root');
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function readExtension(fileName: string): string {
  return path.extname(fileName).replace('.', '').toLowerCase();
}
