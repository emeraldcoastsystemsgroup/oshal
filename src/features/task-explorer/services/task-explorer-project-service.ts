/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted task explorer project, hierarchy, and metrics logic into a dedicated service to satisfy the Session 68 decomposition gate
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Defaulted task-explorer project labeling to the canonical Default project when metadata does not specify another project
 */

import { DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME } from '@/entities/ticket';
import type { ITaskStore } from '@/entities/task';
import { createChildLogger } from '@/shared/logger';
import type { StoredTask } from '@/shared/types';

const logger = createChildLogger({ module: 'task-explorer-project-service' });

interface ProjectSelection {
  id: string;
  name: string;
  identifier: string;
  projectId: string;
  workspaceSlug: string;
}

interface ProjectSummary extends ProjectSelection {
  ticketCount: number;
}

interface TaskExplorerTicket {
  id: string;
  ticketId: string;
  uuid: string;
  sequenceId: string;
  name: string;
  description: string;
  state: string;
  status: string;
  priority: string;
  project: string;
  project_identifier: string;
  projectId: string;
  workspaceSlug: string;
  assignee: string | null;
  created_at: string;
  updated_at: string;
  parentId: string | null;
  parent_id: string | null;
  estimatedCost: number;
  actualCost: number;
  labels: string[];
  children: TaskExplorerTicket[];
}

/**
 * @description Builds project, hierarchy, and metrics payloads for the OSHAL-native
 * task explorer using persisted task state.
 */
export class TaskExplorerProjectService {
  /**
   * @description Creates a project-oriented task explorer service.
   *
   * @param taskStore - Task persistence boundary
   */
  constructor(private readonly taskStore: ITaskStore) {}

  /**
   * @description Lists task explorer projects derived from task metadata.
   *
   * @returns Project summaries sorted by ticket count
   */
  async listProjects(): Promise<Array<{
    id: string;
    name: string;
    identifier: string;
    ticketCount: number;
    projectId: string;
    workspaceSlug: string;
  }>> {
    return this.measure('listProjects', async () => {
      const tasks = await this.taskStore.list({ limit: 500 });
      return this.buildProjectSummaries(tasks);
    });
  }

  /**
   * @description Builds the ticket hierarchy payload for one project selection.
   *
   * @param projectId - Optional project identifier filter
   * @returns Selected project metadata and hierarchical tickets
   */
  async getHierarchy(projectId?: string): Promise<{
    project: ProjectSelection;
    tickets: TaskExplorerTicket[];
    total: number;
  }> {
    return this.measure('getHierarchy', async () => {
      const tasks = await this.taskStore.list({ limit: 500 });
      const project = this.selectProject(tasks, projectId);
      const filteredTasks = this.filterTasksByProject(tasks, project.id);
      return {
        project,
        tickets: this.buildTicketHierarchy(filteredTasks, project),
        total: filteredTasks.length,
      };
    }, { projectId: projectId ?? null });
  }

  /**
   * @description Builds summary metrics for the task explorer status bar.
   *
   * @param projectId - Optional project identifier filter
   * @returns Aggregated queue, review, agent, duration, and cost metrics
   */
  async getMetricsSummary(projectId?: string): Promise<{
    queue: number;
    inProgress: number;
    review: number;
    done: number;
    agents: { total: number; busy: number };
    avgProcessingTimeMs: number;
    avgProcessingTimeFormatted: string;
    estimatedTotalCost: number;
    timestamp: string;
  }> {
    return this.measure('getMetricsSummary', async () => {
      const tasks = await this.taskStore.list({ limit: 500 });
      const filteredTasks = this.filterTasksByProject(tasks, projectId);
      const uniqueAgentIds = new Set(filteredTasks.map((task) => this.readTaskAgentId(task)).filter(Boolean));
      const busyAgentIds = new Set(filteredTasks.filter((task) => this.isInProgressTask(task)).map((task) => this.readTaskAgentId(task)).filter(Boolean));
      const totalCost = filteredTasks.reduce((sum, task) => sum + Number(task.totalCost || 0), 0);
      const averageDurationMs = this.computeAverageDurationMs(filteredTasks);

      return {
        queue: filteredTasks.filter((task) => this.isQueuedTask(task)).length,
        inProgress: filteredTasks.filter((task) => this.isInProgressTask(task)).length,
        review: filteredTasks.filter((task) => this.isReviewTask(task)).length,
        done: filteredTasks.filter((task) => this.isDoneTask(task)).length,
        agents: {
          total: uniqueAgentIds.size,
          busy: busyAgentIds.size,
        },
        avgProcessingTimeMs: averageDurationMs,
        avgProcessingTimeFormatted: this.formatDuration(averageDurationMs),
        estimatedTotalCost: totalCost,
        timestamp: new Date().toISOString(),
      };
    }, { projectId: projectId ?? null });
  }

  private async measure<T>(
    method: string,
    operation: () => Promise<T>,
    metadata: Record<string, unknown> = {},
  ): Promise<T> {
    const startedAt = Date.now();
    logger.info({ method, ...metadata }, 'Task explorer project service entry');

    try {
      const result = await operation();
      logger.info({ method, durationMs: Date.now() - startedAt, ...metadata }, 'Task explorer project service exit');
      return result;
    } catch (error) {
      logger.error({ err: error, method, durationMs: Date.now() - startedAt, ...metadata }, 'Task explorer project service failure');
      throw error;
    }
  }

  private buildProjectSummaries(tasks: StoredTask[]): ProjectSummary[] {
    const summaryMap = new Map<string, ProjectSummary>();
    tasks.forEach((task) => {
      const project = this.readProjectSelection(task);
      const existing = summaryMap.get(project.id);
      if (existing) {
        existing.ticketCount += 1;
        return;
      }

      summaryMap.set(project.id, {
        ...project,
        ticketCount: 1,
      });
    });

    return Array.from(summaryMap.values()).sort((left, right) => {
      if (right.ticketCount !== left.ticketCount) {
        return right.ticketCount - left.ticketCount;
      }
      return left.name.localeCompare(right.name);
    });
  }

  private selectProject(tasks: StoredTask[], requestedProjectId?: string): ProjectSelection {
    const projects = this.buildProjectSummaries(tasks);
    if (projects.length === 0) {
      return {
        id: DEFAULT_PROJECT_ID,
        name: DEFAULT_PROJECT_NAME,
        identifier: 'TASK',
        projectId: requestedProjectId ?? DEFAULT_PROJECT_ID,
        workspaceSlug: '',
      };
    }

    const selected = requestedProjectId
      ? projects.find((project) => project.id === requestedProjectId || project.projectId === requestedProjectId)
      : projects[0];

    return selected ?? projects[0];
  }

  private filterTasksByProject(tasks: StoredTask[], projectId?: string): StoredTask[] {
    if (!projectId) {
      return [...tasks];
    }

    return tasks.filter((task) => {
      const selection = this.readProjectSelection(task);
      return selection.id === projectId || selection.projectId === projectId;
    });
  }

  private buildTicketHierarchy(tasks: StoredTask[], project: ProjectSelection): TaskExplorerTicket[] {
    const nodeMap = new Map<string, TaskExplorerTicket>();
    tasks.forEach((task) => {
      nodeMap.set(task.taskId, this.buildTicketNode(task, project));
    });

    const roots: TaskExplorerTicket[] = [];
    nodeMap.forEach((node) => {
      if (node.parentId && nodeMap.has(node.parentId)) {
        nodeMap.get(node.parentId)?.children.push(node);
        return;
      }
      roots.push(node);
    });

    roots.sort((left, right) => this.sortTickets(left, right));
    roots.forEach((ticket) => this.sortTicketChildren(ticket));
    return roots;
  }

  private buildTicketNode(task: StoredTask, project: ProjectSelection): TaskExplorerTicket {
    const metadata = task.metadata || {};
    const labels = Array.isArray(metadata.labels)
      ? metadata.labels.filter((value): value is string => typeof value === 'string')
      : [];
    const parentId = this.readMetadataString(metadata, ['parentId', 'parent_id', 'parentTaskId', 'parent_task_id']);

    return {
      id: task.taskId,
      ticketId: task.taskId,
      uuid: task.taskId,
      sequenceId: this.readSequenceId(task),
      name: task.title || `Task ${task.taskId.slice(0, 8)}`,
      description: this.readMetadataString(metadata, ['description', 'summary']) || '',
      state: this.mapTaskStatusToState(task.status),
      status: task.status,
      priority: this.readMetadataString(metadata, ['priority']) || 'none',
      project: project.name,
      project_identifier: project.identifier,
      projectId: project.projectId,
      workspaceSlug: project.workspaceSlug,
      assignee: this.readTaskAgentId(task),
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      parentId,
      parent_id: parentId,
      estimatedCost: Number(task.totalCost || 0),
      actualCost: Number(task.totalCost || 0),
      labels,
      children: [],
    };
  }

  private sortTicketChildren(ticket: TaskExplorerTicket): void {
    ticket.children.sort((left, right) => this.sortTickets(left, right));
    ticket.children.forEach((child) => this.sortTicketChildren(child));
  }

  private sortTickets(left: TaskExplorerTicket, right: TaskExplorerTicket): number {
    const leftTime = Date.parse(left.created_at);
    const rightTime = Date.parse(right.created_at);
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.name.localeCompare(right.name);
  }

  private readProjectSelection(task: StoredTask): ProjectSelection {
    const metadata = task.metadata || {};
    const name = this.readMetadataString(metadata, ['project', 'projectName', 'folder']) || DEFAULT_PROJECT_NAME;
    const identifier = this.readMetadataString(metadata, ['projectIdentifier', 'project_identifier']) || this.buildProjectIdentifier(name);
    const projectId = this.readMetadataString(metadata, ['projectId', 'project_id']) || this.slugify(name);
    const workspaceSlug = this.readMetadataString(metadata, ['workspaceSlug', 'workspace_slug']) || this.slugify(name);
    return {
      id: projectId,
      name,
      identifier,
      projectId,
      workspaceSlug,
    };
  }

  private readMetadataString(metadata: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = metadata[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
    return null;
  }

  private buildProjectIdentifier(name: string): string {
    const words = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
    const candidate = words.slice(0, 3).map((word) => word[0]?.toUpperCase() || '').join('');
    return candidate || 'TASK';
  }

  private slugify(value: string): string {
    const normalized = value.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-+|-+$/g, '');
    return normalized || DEFAULT_PROJECT_ID;
  }

  private readSequenceId(task: StoredTask): string {
    return this.readMetadataString(task.metadata || {}, ['sequenceId', 'sequence_id']) || task.taskId.slice(0, 8);
  }

  private readTaskAgentId(task: StoredTask): string | null {
    return task.agentId?.trim() || this.readMetadataString(task.metadata || {}, ['assignee', 'assignedAgentId']);
  }

  private mapTaskStatusToState(status: string): string {
    switch (status) {
      case 'active':
      case 'processing':
        return 'in progress';
      case 'waiting_for_input':
        return 'in review';
      case 'completed':
        return 'done';
      case 'failed':
      case 'cancelled':
        return 'cancelled';
      default:
        return 'backlog';
    }
  }

  private isQueuedTask(task: StoredTask): boolean {
    return task.status === 'created';
  }

  private isInProgressTask(task: StoredTask): boolean {
    return ['active', 'processing'].includes(task.status);
  }

  private isReviewTask(task: StoredTask): boolean {
    return task.status === 'waiting_for_input';
  }

  private isDoneTask(task: StoredTask): boolean {
    return task.status === 'completed';
  }

  private computeAverageDurationMs(tasks: StoredTask[]): number {
    const durations = tasks
      .filter((task) => task.status === 'completed')
      .map((task) => Date.parse(task.updatedAt) - Date.parse(task.createdAt))
      .filter((duration) => Number.isFinite(duration) && duration > 0);
    if (durations.length === 0) {
      return 0;
    }
    return Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length);
  }

  private formatDuration(durationMs: number): string {
    if (durationMs <= 0) {
      return '—';
    }
    const totalMinutes = Math.round(durationMs / 60000);
    if (totalMinutes < 60) {
      return `${totalMinutes}m`;
    }
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${minutes}m`;
  }
}
