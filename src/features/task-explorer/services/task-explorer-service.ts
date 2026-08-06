/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Rebuilt task explorer service as a thin facade over decomposed project, activity, and workspace services for Session 68
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Tightened facade method signatures to preserve concrete payload types after service decomposition
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Threaded exact authenticated subjects and explicit operator authority into every workspace filesystem operation.
 */

import type { IMessageStore } from '@/entities/message';
import type { ITaskStore } from '@/entities/task';
import { createChildLogger } from '@/shared/logger';
import type { WorkspaceService } from '@/features/ticketing';
import { TaskExplorerActivityService } from './task-explorer-activity-service';
import { TaskExplorerProjectService } from './task-explorer-project-service';
import { TaskExplorerWorkspaceService } from './task-explorer-workspace-service';

const logger = createChildLogger({ module: 'task-explorer-service' });

/**
 * @description Thin facade that preserves the task explorer route contract while
 * delegating project, activity, and workspace responsibilities to smaller services.
 */
export class TaskExplorerService {
  private readonly projectService: TaskExplorerProjectService;
  private readonly activityService: TaskExplorerActivityService;
  private readonly workspaceService: TaskExplorerWorkspaceService;

  /**
   * @description Creates a task explorer facade bound to task and message persistence.
   *
   * @param taskStore - Task persistence boundary
   * @param messageStore - Message persistence boundary
   * @param workspaceService - Optional workspace service for DB-backed path resolution
   */
  constructor(taskStore: ITaskStore, messageStore: IMessageStore, workspaceService?: WorkspaceService) {
    this.projectService = new TaskExplorerProjectService(taskStore);
    this.activityService = new TaskExplorerActivityService(taskStore, messageStore);
    this.workspaceService = new TaskExplorerWorkspaceService(taskStore, workspaceService);
  }

  /**
   * @description Lists task explorer projects derived from task metadata.
   *
   * @returns Project summaries sorted by ticket count
   */
  async listProjects(): ReturnType<TaskExplorerProjectService['listProjects']> {
    return this.measure('listProjects', () => this.projectService.listProjects());
  }

  /**
   * @description Builds the task explorer hierarchy payload for one project.
   *
   * @param projectId - Optional project identifier filter
   * @returns Selected project metadata and ticket hierarchy
   */
  async getHierarchy(projectId?: string): ReturnType<TaskExplorerProjectService['getHierarchy']> {
    return this.measure('getHierarchy', () => this.projectService.getHierarchy(projectId), { projectId: projectId ?? null });
  }

  /**
   * @description Builds the task explorer summary metrics payload.
   *
   * @param projectId - Optional project identifier filter
   * @returns Queue, review, completion, and cost rollups
   */
  async getMetricsSummary(projectId?: string): ReturnType<TaskExplorerProjectService['getMetricsSummary']> {
    return this.measure('getMetricsSummary', () => this.projectService.getMetricsSummary(projectId), { projectId: projectId ?? null });
  }

  /**
   * @description Builds the task explorer activity payload for one ticket.
   *
   * @param ticketId - Ticket/task identifier
   * @returns Activity payload or null when the task is missing
   */
  async getTicketActivity(ticketId: string): ReturnType<TaskExplorerActivityService['getTicketActivity']> {
    return this.measure('getTicketActivity', () => this.activityService.getTicketActivity(ticketId), { ticketId });
  }

  /**
   * @description Resolves the workspace tree for one ticket or direct workspace folder.
   *
   * @param ticketId - Persisted task, ticket, or workspace identifier
   * @param callerSub - Exact authenticated OIDC subject
   * @param operator - Whether the caller is explicitly operator-authorized
   * @returns Workspace tree payload
   */
  async getWorkspaceFiles(
    ticketId: string,
    callerSub: string,
    operator = false,
  ): ReturnType<TaskExplorerWorkspaceService['getWorkspaceFiles']> {
    return this.measure(
      'getWorkspaceFiles',
      () => this.workspaceService.getWorkspaceFiles(ticketId, callerSub, operator),
      { ticketId },
    );
  }

  /**
   * @description Lists workspace folders for fallback browsing.
   *
   * @param callerSub - Exact authenticated OIDC subject
   * @param operator - Whether the caller is explicitly operator-authorized
   * @returns Owner-scoped workspace summaries
   */
  async browseWorkspaces(
    callerSub: string,
    operator = false,
  ): ReturnType<TaskExplorerWorkspaceService['browseWorkspaces']> {
    return this.measure('browseWorkspaces', () => this.workspaceService.browseWorkspaces(callerSub, operator));
  }

  /**
   * @description Reads one workspace file preview as bounded text.
   *
   * @param ticketId - Persisted task, ticket, or workspace identifier
   * @param relativePath - Relative file path inside the workspace
   * @param callerSub - Exact authenticated OIDC subject
   * @param operator - Whether the caller is explicitly operator-authorized
   * @returns File preview payload
   */
  async getWorkspaceFileContent(
    ticketId: string,
    relativePath: string,
    callerSub: string,
    operator = false,
  ): ReturnType<TaskExplorerWorkspaceService['getWorkspaceFileContent']> {
    return this.measure(
      'getWorkspaceFileContent',
      () => this.workspaceService.getWorkspaceFileContent(ticketId, relativePath, callerSub, operator),
      { ticketId, relativePath },
    );
  }

  private async measure<T>(
    method: string,
    operation: () => Promise<T>,
    metadata: Record<string, unknown> = {},
  ): Promise<T> {
    const startedAt = Date.now();
    logger.info({ method, ...metadata }, 'Task explorer facade entry');

    try {
      const result = await operation();
      logger.info({ method, durationMs: Date.now() - startedAt, ...metadata }, 'Task explorer facade exit');
      return result;
    } catch (error) {
      logger.error({ err: error, method, durationMs: Date.now() - startedAt, ...metadata }, 'Task explorer facade failure');
      throw error;
    }
  }
}
