/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial WorkspaceService with CRUD and filesystem path resolution
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added resolveTaskOwner(taskId) for per-user task storage (ADR-060): resolves a task's owning user (OIDC sub) via the task's own ticket id or its task→ticket link, so ToolExecutorService can write the bot's files into the owner's storage namespace.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IWorkspaceStore, InternalWorkspace, CreateInternalWorkspaceInput } from '@/entities/workspace';
import type { ITicketStore } from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'WorkspaceService' });

/**
 * @description Manages named persistent workspaces: CRUD, filesystem directory creation,
 * and workspace path resolution for tasks via ticket→workspace links.
 */
export class WorkspaceService {
  constructor(
    private readonly workspaceStore: IWorkspaceStore,
    private readonly ticketStore: ITicketStore,
  ) {}

  /**
   * @description Creates a named workspace and ensures its filesystem directory exists.
   * @param input - Workspace creation input
   * @returns The created workspace record
   */
  async createWorkspace(input: CreateInternalWorkspaceInput): Promise<InternalWorkspace> {
    logger.info({ name: input.name, path: input.path }, 'Creating workspace');
    const workspace = await this.workspaceStore.create(input);
    await this.ensureWorkspacePath(workspace.workspaceId);
    logger.info({ workspaceId: workspace.workspaceId }, 'Workspace created');
    return workspace;
  }

  /**
   * @description Gets a workspace by ID.
   * @param workspaceId - Workspace identifier
   * @returns Workspace record or null
   */
  async getWorkspace(workspaceId: string): Promise<InternalWorkspace | null> {
    return this.workspaceStore.get(workspaceId);
  }

  /**
   * @description Gets a workspace by name.
   * @param name - Workspace name
   * @returns Workspace record or null
   */
  async getWorkspaceByName(name: string): Promise<InternalWorkspace | null> {
    return this.workspaceStore.getByName(name);
  }

  /**
   * @description Lists workspaces with optional filtering.
   * @param options - Filter options
   * @returns Array of workspaces
   */
  async listWorkspaces(options?: Parameters<IWorkspaceStore['list']>[0]): Promise<InternalWorkspace[]> {
    return this.workspaceStore.list(options);
  }

  /**
   * @description Updates a workspace's fields.
   * @param workspaceId - Workspace identifier
   * @param updates - Partial workspace fields
   */
  async updateWorkspace(
    workspaceId: string,
    updates: Partial<Omit<InternalWorkspace, 'workspaceId' | 'createdAt'>>,
  ): Promise<void> {
    logger.info({ workspaceId }, 'Updating workspace');
    await this.workspaceStore.update(workspaceId, updates);
  }

  /**
   * @description Deletes a workspace record AND its filesystem directory.
   * The disk delete is gated on the resolved path being inside
   * SHARED_WORKSPACE_ROOT (or its default `/app/workspace-shared`) — a malformed
   * path that escapes that root is logged and skipped, never deleted.
   * @param workspaceId - Workspace identifier
   */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    logger.info({ workspaceId }, 'Deleting workspace');
    const workspace = await this.workspaceStore.get(workspaceId);
    await this.workspaceStore.delete(workspaceId);

    if (!workspace?.path) return;
    const resolved = path.resolve(workspace.path);
    const root = path.resolve(process.env.SHARED_WORKSPACE_ROOT || '/app/workspace-shared');
    // Path-prefix check protects against accidental rm of paths outside the
    // workspace root (e.g. if the row had a malformed or absolute path stored).
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      logger.warn({ workspaceId, resolved, root }, 'Workspace path outside root — skipping disk delete');
      return;
    }
    if (resolved === root) {
      logger.warn({ workspaceId }, 'Workspace path equals root — refusing to delete root');
      return;
    }
    try {
      if (fs.existsSync(resolved)) {
        fs.rmSync(resolved, { recursive: true, force: true });
        logger.info({ workspaceId, path: resolved }, 'Workspace directory removed');
      }
    } catch (err) {
      logger.warn({ err, workspaceId, path: resolved }, 'Failed to remove workspace directory');
    }
  }

  /**
   * @description Ensures the filesystem directory for a workspace exists.
   * @param workspaceId - Workspace identifier
   */
  async ensureWorkspacePath(workspaceId: string): Promise<void> {
    const workspace = await this.workspaceStore.get(workspaceId);
    if (!workspace) {
      logger.warn({ workspaceId }, 'Workspace not found for path creation');
      return;
    }

    const resolvedPath = path.resolve(workspace.path);
    if (!fs.existsSync(resolvedPath)) {
      logger.info({ workspaceId, path: resolvedPath }, 'Creating workspace directory');
      fs.mkdirSync(resolvedPath, { recursive: true });
    }
  }

  /**
   * @description Resolves the workspace path for a task. Checks ticket→workspace link
   * first, falls back to null if no workspace is associated.
   * @param taskId - Task identifier
   * @param ticketId - Optional ticket identifier for direct lookup
   * @returns Workspace filesystem path or null
   */
  async resolveTaskWorkspace(taskId: string, ticketId?: string): Promise<string | null> {
    logger.debug({ taskId, ticketId }, 'Resolving task workspace');

    if (ticketId) {
      const workspaceLinks = await this.ticketStore.getWorkspaceLinks(ticketId);
      if (workspaceLinks.length > 0) {
        const workspace = await this.workspaceStore.get(workspaceLinks[0].workspaceId);
        if (workspace) {
          logger.info({ taskId, ticketId, workspaceId: workspace.workspaceId }, 'Resolved workspace via ticket');
          return workspace.path;
        }
      }
    }

    const ticketLinks = await this.ticketStore.getTicketLinksForTask(taskId);
    for (const link of ticketLinks) {
      const workspaceLinks = await this.ticketStore.getWorkspaceLinks(link.ticketId);
      if (workspaceLinks.length > 0) {
        const workspace = await this.workspaceStore.get(workspaceLinks[0].workspaceId);
        if (workspace) {
          logger.info({ taskId, ticketId: link.ticketId, workspaceId: workspace.workspaceId }, 'Resolved workspace via task ticket link');
          return workspace.path;
        }
      }
    }

    logger.debug({ taskId }, 'No workspace found for task');
    return null;
  }

  /**
   * @description Resolves the owning user (OIDC sub) of a task for per-user storage (ADR-060).
   * A task inherits its owner from its ticket: the taskId may itself be a ticket id, or it is
   * linked to a ticket. Returns null for system/swarm tasks with no owning ticket.
   * @param taskId - Task identifier
   * @returns The owner's OIDC sub, or null if none can be resolved
   */
  async resolveTaskOwner(taskId: string): Promise<string | null> {
    try {
      const direct = await this.ticketStore.get(taskId);
      const directOwner = (direct as { ownerSub?: string | null } | null)?.ownerSub;
      if (directOwner) return directOwner;
    } catch (error) {
      logger.debug({ err: error, taskId }, 'Direct ticket owner lookup failed; trying task links');
    }

    const ticketLinks = await this.ticketStore.getTicketLinksForTask(taskId);
    for (const link of ticketLinks) {
      const ticket = await this.ticketStore.get(link.ticketId);
      const owner = (ticket as { ownerSub?: string | null } | null)?.ownerSub;
      if (owner) return owner;
    }

    return null;
  }
}