/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial WorkspaceService with CRUD and filesystem path resolution
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added resolveTaskOwner(taskId) for per-user task storage (ADR-060): resolves a task's owning user (OIDC sub) via the task's own ticket id or its task→ticket link, so ToolExecutorService can write the bot's files into the owner's storage namespace.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Made workspace owner/path immutable at the service boundary and confined create, ensure, and delete operations to link-free directories below the shared root before persistence changes.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { IWorkspaceStore, InternalWorkspace, CreateInternalWorkspaceInput } from '@/entities/workspace';
import type { ITicketStore } from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';
import { resolveSharedWorkspaceRoot } from '@/shared/workspace-root';

const logger = createChildLogger({ module: 'WorkspaceService' });
const MANAGED_DIRECTORY = 'managed';

type WorkspaceUpdates = Partial<Pick<InternalWorkspace, 'name' | 'projectName' | 'metadata'>>;

interface ContainedDirectory {
  absolutePath: string;
  exists: boolean;
}

/**
 * @description Manages named persistent workspaces while keeping every filesystem
 * mutation below the configured shared root and preserving the original owner/path.
 */
export class WorkspaceService {
  private readonly workspaceRoot: string;

  /**
   * @description Creates the workspace boundary with persistence and ticket-link stores.
   * @param workspaceStore - Workspace persistence boundary.
   * @param ticketStore - Ticket persistence boundary used for workspace and owner links.
   */
  constructor(
    private readonly workspaceStore: IWorkspaceStore,
    private readonly ticketStore: ITicketStore,
  ) {
    this.workspaceRoot = resolveSharedWorkspaceRoot();
  }

  /**
   * @description Creates a workspace only after its immutable path has passed containment checks.
   * Caller-omitted paths are derived by the server from the exact owner and workspace name.
   * @param input - Trusted workspace creation input; HTTP callers cannot supply path or owner.
   * @returns The created or same-owner pre-existing workspace record.
   */
  async createWorkspace(input: CreateInternalWorkspaceInput): Promise<InternalWorkspace> {
    logger.info({ name: input.name }, 'Creating workspace');
    assertOwner(input.ownerSub);
    const existing = await this.workspaceStore.getByName(input.name);
    if (existing) return this.reuseWorkspace(existing, input.ownerSub ?? null);

    const absolutePath = this.resolveCreatePath(input);
    await ensureContainedDirectory(this.workspaceRoot, absolutePath);
    const workspace = await this.workspaceStore.create({ ...input, path: absolutePath });
    assertCreatedWorkspace(workspace, absolutePath, input.ownerSub ?? null);
    logger.info({ workspaceId: workspace.workspaceId }, 'Workspace created');
    return workspace;
  }

  /**
   * @description Gets a workspace by ID without performing filesystem resolution.
   * @param workspaceId - Workspace identifier.
   * @returns Workspace record or null.
   */
  async getWorkspace(workspaceId: string): Promise<InternalWorkspace | null> {
    return this.workspaceStore.get(workspaceId);
  }

  /**
   * @description Gets a workspace by its exact persisted name.
   * @param name - Workspace name.
   * @returns Workspace record or null.
   */
  async getWorkspaceByName(name: string): Promise<InternalWorkspace | null> {
    return this.workspaceStore.getByName(name);
  }

  /**
   * @description Lists workspace records through persistence filters; authorization remains caller-owned.
   * @param options - Persistence filters, including exact owner subject.
   * @returns Matching workspace records.
   */
  async listWorkspaces(options?: Parameters<IWorkspaceStore['list']>[0]): Promise<InternalWorkspace[]> {
    return this.workspaceStore.list(options);
  }

  /**
   * @description Updates mutable presentation fields while refusing owner or path replacement at runtime.
   * @param workspaceId - Workspace identifier.
   * @param updates - Mutable name, project, or metadata fields.
   * @returns Promise resolved after persistence completes.
   */
  async updateWorkspace(workspaceId: string, updates: WorkspaceUpdates): Promise<void> {
    assertMutableUpdates(updates as Record<string, unknown>);
    logger.info({ workspaceId }, 'Updating workspace');
    await this.workspaceStore.update(workspaceId, updates);
  }

  /**
   * @description Removes a link-free contained directory before deleting its database record,
   * so an unsafe or failed filesystem operation leaves recoverable authoritative state.
   * @param workspaceId - Workspace identifier.
   * @returns Promise resolved only after filesystem and database deletion complete.
   */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    logger.info({ workspaceId }, 'Deleting workspace');
    const workspace = await this.workspaceStore.get(workspaceId);
    if (!workspace) return;

    const target = await inspectContainedDirectory(this.workspaceRoot, workspace.path);
    if (target.exists) await fs.rm(target.absolutePath, { recursive: true, force: false });
    await this.workspaceStore.delete(workspaceId);
    logger.info({ workspaceId, removedDirectory: target.exists }, 'Workspace deleted');
  }

  /**
   * @description Ensures a workspace directory exists by creating one validated component at a time.
   * @param workspaceId - Workspace identifier.
   * @returns Promise resolved after the directory is verified or created.
   */
  async ensureWorkspacePath(workspaceId: string): Promise<void> {
    const workspace = await this.workspaceStore.get(workspaceId);
    if (!workspace) throw new Error('Workspace not found');
    await ensureContainedDirectory(this.workspaceRoot, workspace.path);
    logger.info({ workspaceId }, 'Workspace directory ensured');
  }

  /**
   * @description Resolves the workspace record linked to a task or ticket without touching disk.
   * @param taskId - Task identifier used for task-to-ticket traversal.
   * @param ticketId - Optional ticket identifier for a direct workspace link lookup.
   * @returns Linked workspace record or null.
   */
  async resolveTaskWorkspaceRecord(taskId: string, ticketId?: string): Promise<InternalWorkspace | null> {
    if (ticketId) {
      const direct = await this.workspaceForTicket(ticketId);
      if (direct) return direct;
    }

    const ticketLinks = await this.ticketStore.getTicketLinksForTask(taskId);
    for (const link of ticketLinks) {
      const workspace = await this.workspaceForTicket(link.ticketId);
      if (workspace) return workspace;
    }
    return null;
  }

  /**
   * @description Resolves the filesystem path linked to a task for trusted internal consumers.
   * @param taskId - Task identifier.
   * @param ticketId - Optional direct ticket identifier.
   * @returns Linked workspace filesystem path or null.
   */
  async resolveTaskWorkspace(taskId: string, ticketId?: string): Promise<string | null> {
    const workspace = await this.resolveTaskWorkspaceRecord(taskId, ticketId);
    return workspace?.path ?? null;
  }

  /**
   * @description Resolves a task's exact owning OIDC subject through direct ticket or task links.
   * @param taskId - Task identifier.
   * @returns Exact owner subject, or null when the task has no owned ticket.
   */
  async resolveTaskOwner(taskId: string): Promise<string | null> {
    const directOwner = await this.directTicketOwner(taskId);
    if (directOwner) return directOwner;

    const ticketLinks = await this.ticketStore.getTicketLinksForTask(taskId);
    for (const link of ticketLinks) {
      const ticket = await this.ticketStore.get(link.ticketId);
      const owner = (ticket as { ownerSub?: string | null } | null)?.ownerSub;
      if (owner) return owner;
    }
    return null;
  }

  private async reuseWorkspace(existing: InternalWorkspace, requestedOwner: string | null): Promise<InternalWorkspace> {
    if (existing.ownerSub !== requestedOwner) throw new Error('Workspace name is already in use');
    await ensureContainedDirectory(this.workspaceRoot, existing.path);
    return existing;
  }

  private resolveCreatePath(input: CreateInternalWorkspaceInput): string {
    if (input.path) return resolveCandidatePath(this.workspaceRoot, input.path);
    const owner = input.ownerSub ?? 'system';
    const digest = createHash('sha256').update(owner).update('\0').update(input.name).digest('hex');
    return path.join(this.workspaceRoot, MANAGED_DIRECTORY, digest);
  }

  private async workspaceForTicket(ticketId: string): Promise<InternalWorkspace | null> {
    const links = await this.ticketStore.getWorkspaceLinks(ticketId);
    if (links.length === 0) return null;
    return this.workspaceStore.get(links[0].workspaceId);
  }

  private async directTicketOwner(taskId: string): Promise<string | null> {
    try {
      const direct = await this.ticketStore.get(taskId);
      return (direct as { ownerSub?: string | null } | null)?.ownerSub ?? null;
    } catch (error) {
      logger.debug({ err: error, taskId }, 'Direct ticket owner lookup failed; trying task links');
      return null;
    }
  }
}

function assertOwner(ownerSub: string | null | undefined): void {
  if (ownerSub === undefined || ownerSub === null) return;
  if (!ownerSub || ownerSub.trim().length === 0 || ownerSub.includes('\0')) {
    throw new Error('Workspace owner is invalid');
  }
}

function assertMutableUpdates(updates: Record<string, unknown>): void {
  if ('path' in updates || 'ownerSub' in updates) {
    throw new Error('Workspace path and owner are immutable');
  }
}

function assertCreatedWorkspace(workspace: InternalWorkspace, expectedPath: string, expectedOwner: string | null): void {
  if (path.resolve(workspace.path) !== expectedPath || workspace.ownerSub !== expectedOwner) {
    throw new Error('Workspace creation conflicted with an existing record');
  }
}

function resolveCandidatePath(workspaceRoot: string, workspacePath: string): string {
  const absolutePath = path.isAbsolute(workspacePath)
    ? path.resolve(workspacePath)
    : path.resolve(workspaceRoot, workspacePath);
  assertLexicallyContained(workspaceRoot, absolutePath);
  return absolutePath;
}

function assertLexicallyContained(workspaceRoot: string, targetPath: string): string[] {
  const root = path.resolve(workspaceRoot);
  const relative = path.relative(root, path.resolve(targetPath));
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('Workspace path must be below the shared workspace root');
  }
  return relative.split(path.sep).filter(Boolean);
}

async function ensureContainedDirectory(workspaceRoot: string, targetPath: string): Promise<void> {
  const root = path.resolve(workspaceRoot);
  const parts = assertLexicallyContained(root, targetPath);
  await fs.mkdir(root, { recursive: true });
  await assertDirectory(root);
  let current = root;

  for (const part of parts) {
    current = path.join(current, part);
    try {
      await fs.mkdir(current);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    await assertDirectory(current);
    await assertRealpathContained(root, current);
  }
}

async function inspectContainedDirectory(workspaceRoot: string, targetPath: string): Promise<ContainedDirectory> {
  const root = path.resolve(workspaceRoot);
  const absolutePath = resolveCandidatePath(root, targetPath);
  const parts = assertLexicallyContained(root, absolutePath);
  if (!(await pathExists(root))) return { absolutePath, exists: false };
  await assertDirectory(root);
  let current = root;

  for (const part of parts) {
    current = path.join(current, part);
    if (!(await pathExists(current))) return { absolutePath, exists: false };
    await assertDirectory(current);
    await assertRealpathContained(root, current);
  }
  return { absolutePath, exists: true };
}

async function assertDirectory(targetPath: string): Promise<void> {
  const stat = await fs.lstat(targetPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Workspace path contains a link or non-directory component');
  }
}

async function assertRealpathContained(rootPath: string, targetPath: string): Promise<void> {
  const [realRoot, realTarget] = await Promise.all([fs.realpath(rootPath), fs.realpath(targetPath)]);
  const relative = path.relative(realRoot, realTarget);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('Workspace path escapes the shared workspace root');
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EEXIST';
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
