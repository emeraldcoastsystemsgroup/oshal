/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted task explorer workspace browsing and file preview logic into a dedicated service to satisfy the Session 68 decomposition gate
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Aligned workspace root discovery with shared swarm task-folder paths so cockpit artifact browsing resolves real ticket workspaces
 */

import fsSync from 'node:fs';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ITaskStore } from '@/entities/task';
import { createChildLogger } from '@/shared/logger';
import type { StoredTask } from '@/shared/types';
import type { WorkspaceService } from '@/features/ticketing';

const logger = createChildLogger({ module: 'task-explorer-workspace-service' });
const FILE_READ_LIMIT_BYTES = 256 * 1024;
const IGNORED_WORKSPACE_ENTRIES = new Set(['.git', '.oshal', 'node_modules']);
const TEXT_FILE_EXTENSIONS = new Set([
  'css', 'csv', 'html', 'js', 'json', 'jsx', 'log', 'md', 'mjs', 'sql', 'svg', 'sh', 'text', 'ts', 'tsx', 'txt', 'xml', 'yaml', 'yml',
]);

/**
 * @description Builds workspace trees, folder browse payloads, and file previews
 * for the OSHAL-native task explorer.
 */
export class TaskExplorerWorkspaceService {
  private readonly workspaceRoot: string;

  /**
   * @description Creates a workspace-oriented task explorer service.
   *
   * @param taskStore - Task persistence boundary
   * @param workspaceService - Optional workspace service for DB-backed path resolution
   */
  constructor(
    private readonly taskStore: ITaskStore,
    private readonly workspaceService?: WorkspaceService,
  ) {
    this.workspaceRoot = this.resolveWorkspaceRoot();
  }

  /**
   * @description Resolves the file tree for one task workspace or direct workspace folder.
   *
   * @param ticketId - Task identifier or workspace folder name
   * @returns Workspace existence and tree payload
   */
  async getWorkspaceFiles(ticketId: string): Promise<Record<string, unknown>> {
    return this.measure('getWorkspaceFiles', async () => {
      const workspace = await this.resolveWorkspace(ticketId);
      if (!workspace.exists) {
        return {
          path: workspace.displayPath,
          absolutePath: workspace.absolutePath,
          exists: false,
          children: [],
        };
      }

      const children = await this.readWorkspaceEntries(workspace.absolutePath, workspace.absolutePath);
      return {
        path: workspace.displayPath,
        absolutePath: workspace.absolutePath,
        exists: true,
        children,
      };
    }, { ticketId });
  }

  /**
   * @description Lists available workspace directories for fallback browsing.
   *
   * @returns Workspace folder summaries sorted by last modification time
   */
  async browseWorkspaces(): Promise<{
    basePath: string;
    workspaces: Array<{ name: string; path: string; fileCount: number; modified: string }>;
    total: number;
  }> {
    return this.measure('browseWorkspaces', async () => {
      const workspaces = await this.listWorkspaceFolders(this.workspaceRoot);
      return {
        basePath: this.workspaceRoot,
        workspaces,
        total: workspaces.length,
      };
    });
  }

  /**
   * @description Reads one workspace file as text for the explorer file viewer.
   *
   * @param ticketId - Task identifier or workspace folder name
   * @param relativePath - Relative file path within the workspace
   * @returns File metadata and bounded text content
   */
  async getWorkspaceFileContent(ticketId: string, relativePath: string): Promise<Record<string, unknown>> {
    return this.measure('getWorkspaceFileContent', async () => {
      const workspace = await this.resolveWorkspace(ticketId);
      if (!workspace.exists) {
        throw new Error('Workspace not found');
      }

      const filePath = this.resolveWorkspaceChild(workspace.absolutePath, relativePath);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        throw new Error('Requested path is not a file');
      }

      const extension = this.readExtension(filePath);
      if (!TEXT_FILE_EXTENSIONS.has(extension)) {
        throw new Error('Binary file preview is not supported');
      }

      const buffer = await fs.readFile(filePath);
      const truncated = buffer.subarray(0, FILE_READ_LIMIT_BYTES);
      return {
        path: path.relative(workspace.absolutePath, filePath) || path.basename(filePath),
        absolutePath: filePath,
        content: truncated.toString('utf8'),
        size: stat.size,
        language: extension || 'text',
        modified: stat.mtime.toISOString(),
        truncated: buffer.length > truncated.length,
      };
    }, { ticketId, relativePath });
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

  private async resolveWorkspace(ticketId: string): Promise<{
    absolutePath: string;
    displayPath: string;
    exists: boolean;
  }> {
    const task = await this.taskStore.get(ticketId);
    const directPath = this.readWorkspacePath(task);
    const fallbackPath = path.join(this.workspaceRoot, this.normalizeWorkspaceId(ticketId));
    const absolutePath = this.sanitizeWorkspacePath(this.workspaceRoot, directPath) ?? fallbackPath;

    if (await this.pathExists(absolutePath)) {
      return {
        absolutePath,
        displayPath: this.buildWorkspaceDisplayPath(absolutePath),
        exists: true,
      };
    }

    // Direct path missing — try workspace DB lookup via ticket link (handles parent/execution UUID mismatch)
    if (this.workspaceService) {
      try {
        // First: check workspace links on this ticket directly
        const dbPath = await this.workspaceService.resolveTaskWorkspace(ticketId, ticketId);
        if (dbPath) {
          const sanitized = this.sanitizeWorkspacePath(this.workspaceRoot, dbPath);
          if (sanitized && await this.pathExists(sanitized)) {
            logger.info({ ticketId, dbPath: sanitized }, 'Workspace resolved via DB ticket link');
            return {
              absolutePath: sanitized,
              displayPath: this.buildWorkspaceDisplayPath(sanitized),
              exists: true,
            };
          }
        }

        // Second: scan all workspaces for one whose path ends with this ticketId
        // (covers cases where workspace is linked to a child execution ticket, not the parent)
        const allWorkspaces = await this.workspaceService.listWorkspaces({ limit: 500 });
        const normalizedId = this.normalizeWorkspaceId(ticketId);
        const match = allWorkspaces.find((w) => {
          const name = path.basename(w.path);
          return name === ticketId || name === normalizedId;
        });
        if (match?.path) {
          const sanitized = this.sanitizeWorkspacePath(this.workspaceRoot, match.path);
          if (sanitized && await this.pathExists(sanitized)) {
            logger.info({ ticketId, dbPath: sanitized, workspaceName: match.name }, 'Workspace resolved via DB path scan');
            return {
              absolutePath: sanitized,
              displayPath: this.buildWorkspaceDisplayPath(sanitized),
              exists: true,
            };
          }
        }
      } catch (error) {
        logger.warn({ err: error, ticketId }, 'DB workspace lookup failed — returning not-found');
      }
    }

    return {
      absolutePath,
      displayPath: this.buildWorkspaceDisplayPath(absolutePath),
      exists: false,
    };
  }

  private async listWorkspaceFolders(workspaceRoot: string): Promise<Array<{ name: string; path: string; fileCount: number; modified: string }>> {
    if (!(await this.pathExists(workspaceRoot))) {
      return [];
    }

    const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory() && !IGNORED_WORKSPACE_ENTRIES.has(entry.name));
    const summaries = await Promise.all(directories.map((entry) => this.buildWorkspaceFolderSummary(workspaceRoot, entry.name)));
    return summaries.sort((left, right) => right.modified.localeCompare(left.modified));
  }

  private async buildWorkspaceFolderSummary(
    workspaceRoot: string,
    folderName: string,
  ): Promise<{ name: string; path: string; fileCount: number; modified: string }> {
    const absolutePath = path.join(workspaceRoot, folderName);
    const stat = await fs.stat(absolutePath);
    const children = await fs.readdir(absolutePath, { withFileTypes: true });
    return {
      name: folderName,
      path: folderName,
      fileCount: children.filter((entry) => entry.isFile()).length,
      modified: stat.mtime.toISOString(),
    };
  }

  private async readWorkspaceEntries(
    directoryPath: string,
    rootPath: string,
  ): Promise<Array<{
    name: string;
    path: string;
    type: 'file' | 'directory';
    extension: string;
    size?: number;
    sizeFormatted?: string;
    modified?: string;
    children?: Array<Record<string, unknown>>;
  }>> {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const visibleEntries = entries.filter((entry) => !IGNORED_WORKSPACE_ENTRIES.has(entry.name));
    const workspaceEntries = await Promise.all(visibleEntries.map((entry) => this.buildWorkspaceEntry(directoryPath, rootPath, entry)));
    return workspaceEntries.sort((left, right) => this.sortWorkspaceEntries(left, right));
  }

  private async buildWorkspaceEntry(
    directoryPath: string,
    rootPath: string,
    entry: Dirent,
  ): Promise<{
    name: string;
    path: string;
    type: 'file' | 'directory';
    extension: string;
    size?: number;
    sizeFormatted?: string;
    modified?: string;
    children?: Array<Record<string, unknown>>;
  }> {
    const absolutePath = path.join(directoryPath, entry.name);
    const relativePath = path.relative(rootPath, absolutePath) || entry.name;
    const stat = await fs.stat(absolutePath);
    if (entry.isDirectory()) {
      return {
        name: entry.name,
        path: relativePath,
        type: 'directory',
        extension: '',
        modified: stat.mtime.toISOString(),
        children: await this.readWorkspaceEntries(absolutePath, rootPath),
      };
    }

    return {
      name: entry.name,
      path: relativePath,
      type: 'file',
      extension: this.readExtension(entry.name),
      size: stat.size,
      sizeFormatted: this.formatFileSize(stat.size),
      modified: stat.mtime.toISOString(),
    };
  }

  private sortWorkspaceEntries(
    left: { type: 'file' | 'directory'; name: string },
    right: { type: 'file' | 'directory'; name: string },
  ): number {
    if (left.type !== right.type) {
      return left.type === 'directory' ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  }

  private resolveWorkspaceChild(workspacePath: string, relativePath: string): string {
    const decodedPath = decodeURIComponent(relativePath);
    const absolutePath = path.resolve(workspacePath, decodedPath);
    if (!absolutePath.startsWith(`${workspacePath}${path.sep}`) && absolutePath !== workspacePath) {
      throw new Error('Requested path escapes workspace root');
    }
    return absolutePath;
  }

  private sanitizeWorkspacePath(workspaceRoot: string, workspacePath?: string | null): string | null {
    if (!workspacePath) {
      return null;
    }

    const absolutePath = path.isAbsolute(workspacePath)
      ? path.resolve(workspacePath)
      : path.resolve(workspaceRoot, workspacePath);

    // Anchor the prefix check to the workspace ROOT directory, not the
    // bare string. Without `path.sep`, a sibling like `workspace-shared-backup`
    // would satisfy startsWith('workspace-shared') and let the task explorer
    // read files outside the intended root. Same safe pattern is already
    // used a few lines above this function.
    const normalizedRoot = path.resolve(workspaceRoot);
    if (absolutePath !== normalizedRoot && !absolutePath.startsWith(`${normalizedRoot}${path.sep}`)) {
      return null;
    }

    return absolutePath;
  }

  private buildWorkspaceDisplayPath(absolutePath: string): string {
    return `workspace/${path.basename(absolutePath)}`;
  }

  private resolveWorkspaceRoot(): string {
    const configuredRoot = process.env.SHARED_WORKSPACE_ROOT
      || process.env.CLINE_WORKSPACE_ROOT
      || process.env.WORKSPACE_ROOT;
    return configuredRoot && configuredRoot.trim().length > 0
      ? path.resolve(configuredRoot)
      : fsSync.existsSync('/app/workspace')
        ? '/app/workspace'
        : path.resolve(process.cwd(), 'workspace-shared');
  }

  private normalizeWorkspaceId(ticketId: string): string {
    return ticketId.trim().replaceAll(/[^a-zA-Z0-9-_]/g, '_');
  }

  private readWorkspacePath(task: StoredTask | null): string | null {
    if (!task) {
      return null;
    }
    const metadata = task.metadata || {};
    const value = metadata.workspacePath;
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private formatFileSize(size: number): string {
    if (size < 1024) {
      return `${size} B`;
    }
    if (size < 1024 * 1024) {
      return `${(size / 1024).toFixed(1)} KB`;
    }
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  private readExtension(fileName: string): string {
    return path.extname(fileName).replace('.', '').toLowerCase();
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch (error) {
      logger.debug({ err: error, targetPath }, 'Workspace path not accessible');
      return false;
    }
  }
}
