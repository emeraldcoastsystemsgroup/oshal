/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted task explorer activity and timeline logic into a dedicated service to satisfy the Session 68 decomposition gate
 */

import type { IMessageStore } from '@/entities/message';
import type { ITaskStore } from '@/entities/task';
import { createChildLogger } from '@/shared/logger';
import type { StoredMessage, StoredTask } from '@/shared/types';

const logger = createChildLogger({ module: 'task-explorer-activity-service' });

/**
 * @description Builds ticket detail and timeline payloads for the OSHAL-native
 * task explorer activity pane.
 */
export class TaskExplorerActivityService {
  /**
   * @description Creates an activity-oriented task explorer service.
   *
   * @param taskStore - Task persistence boundary
   * @param messageStore - Message persistence boundary
   */
  constructor(
    private readonly taskStore: ITaskStore,
    private readonly messageStore: IMessageStore,
  ) {}

  /**
   * @description Builds the explorer activity payload for one ticket.
   *
   * @param ticketId - Ticket/task identifier
   * @returns Ticket detail, timeline, processing, and cost payload or null when missing
   */
  async getTicketActivity(ticketId: string): Promise<Record<string, unknown> | null> {
    return this.measure('getTicketActivity', async () => {
      const task = await this.taskStore.get(ticketId);
      if (!task) {
        return null;
      }

      const [messages, allTasks] = await Promise.all([
        this.messageStore.getByTask(ticketId),
        this.taskStore.list({ limit: 500 }),
      ]);
      const descendants = this.collectDescendants(allTasks, ticketId);
      const routeCount = this.countToolUses(messages);
      const project = this.readProjectSelection(task);

      return {
        ticket: this.buildActivityTicket(task, project.identifier, messages),
        timeline: messages.map((message) => this.buildTimelineEntry(message)),
        routeCount,
        processing: {
          complexity: this.classifyComplexity(task, messages, descendants.length),
        },
        activityStats: {
          totalMessages: messages.length,
          toolUseCount: routeCount,
          subtaskCount: descendants.length,
          aggregatedCost: this.sumTaskCost([task, ...descendants]),
          subtaskCost: this.sumTaskCost(descendants),
          realCostData: Number(task.totalTokens || 0) > 0,
        },
        cost: {
          totalTokens: Number(task.totalTokens || 0),
          estimatedCost: Number(task.totalCost || 0),
        },
      };
    }, { ticketId });
  }

  private async measure<T>(
    method: string,
    operation: () => Promise<T>,
    metadata: Record<string, unknown> = {},
  ): Promise<T> {
    const startedAt = Date.now();
    logger.info({ method, ...metadata }, 'Task explorer activity service entry');

    try {
      const result = await operation();
      logger.info({ method, durationMs: Date.now() - startedAt, ...metadata }, 'Task explorer activity service exit');
      return result;
    } catch (error) {
      logger.error({ err: error, method, durationMs: Date.now() - startedAt, ...metadata }, 'Task explorer activity service failure');
      throw error;
    }
  }

  private buildActivityTicket(task: StoredTask, projectIdentifier: string, messages: StoredMessage[]): Record<string, unknown> {
    const metadata = task.metadata || {};
    const description = this.readMetadataString(metadata, ['description', 'summary']) || this.deriveDescription(messages);
    return {
      id: task.taskId,
      name: task.title || `Task ${task.taskId.slice(0, 8)}`,
      project_identifier: projectIdentifier,
      sequence_id: this.readSequenceId(task),
      state: this.mapTaskStatusToState(task.status),
      priority: this.readMetadataString(metadata, ['priority']) || 'none',
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      parent_id: this.readMetadataString(metadata, ['parentId', 'parent_id', 'parentTaskId', 'parent_task_id']),
      description_stripped: description,
    };
  }

  private buildTimelineEntry(message: StoredMessage): Record<string, unknown> {
    return {
      id: message.messageId,
      type: this.mapMessageTypeToTimelineType(message),
      summary: this.summarizeMessage(message),
      timestamp: message.createdAt,
      author: message.role,
    };
  }

  private collectDescendants(tasks: StoredTask[], ticketId: string): StoredTask[] {
    const childMap = new Map<string, StoredTask[]>();
    tasks.forEach((task) => {
      const parentId = this.readMetadataString(task.metadata || {}, ['parentId', 'parent_id', 'parentTaskId', 'parent_task_id']);
      if (!parentId) {
        return;
      }
      const children = childMap.get(parentId) ?? [];
      children.push(task);
      childMap.set(parentId, children);
    });

    return this.collectDescendantList(childMap, ticketId);
  }

  private collectDescendantList(childMap: Map<string, StoredTask[]>, ticketId: string): StoredTask[] {
    const children = childMap.get(ticketId) ?? [];
    return children.flatMap((child) => [child, ...this.collectDescendantList(childMap, child.taskId)]);
  }

  private countToolUses(messages: StoredMessage[]): number {
    return messages.reduce((count, message) => {
      const contentBlockCount = Array.isArray(message.contentBlocks)
        ? message.contentBlocks.filter((block) => block.type === 'tool_use').length
        : 0;
      return count + contentBlockCount + (message.type === 'tool_use' ? 1 : 0);
    }, 0);
  }

  private classifyComplexity(task: StoredTask, messages: StoredMessage[], subtaskCount: number): string {
    const score = Number(task.turnCount || 0) + messages.length + (subtaskCount * 3);
    if (score >= 20) {
      return 'high';
    }
    if (score >= 10) {
      return 'medium';
    }
    return 'low';
  }

  private sumTaskCost(tasks: StoredTask[]): number {
    return tasks.reduce((sum, task) => sum + Number(task.totalCost || 0), 0);
  }

  private deriveDescription(messages: StoredMessage[]): string {
    const firstUserMessage = messages.find((message) => message.role === 'user' && message.text.trim().length > 0);
    return firstUserMessage?.text.trim() || '';
  }

  private summarizeMessage(message: StoredMessage): string {
    const summary = message.text.trim() || this.summarizeContentBlocks(message);
    return summary.length > 180 ? `${summary.slice(0, 177)}...` : summary;
  }

  private summarizeContentBlocks(message: StoredMessage): string {
    if (!Array.isArray(message.contentBlocks) || message.contentBlocks.length === 0) {
      return message.type;
    }

    const firstBlock = message.contentBlocks[0];
    if (firstBlock.type === 'tool_use') {
      return `Tool used: ${firstBlock.name}`;
    }
    if (firstBlock.type === 'tool_result') {
      return `Tool result: ${firstBlock.content.slice(0, 120)}`;
    }
    if (firstBlock.type === 'thinking') {
      return 'Thinking step recorded';
    }
    return firstBlock.text.slice(0, 120);
  }

  private mapMessageTypeToTimelineType(message: StoredMessage): string {
    if (message.type === 'tool_use') {
      return 'routing';
    }
    if (message.type === 'tool_result') {
      return 'system';
    }
    if (message.type === 'completion') {
      return 'completion';
    }
    if (message.type === 'error') {
      return 'stall';
    }
    return message.role === 'user' ? 'brief' : 'continuation';
  }

  private readProjectSelection(task: StoredTask): { identifier: string } {
    const metadata = task.metadata || {};
    const name = this.readMetadataString(metadata, ['project', 'projectName', 'folder']) || 'Unassigned';
    const identifier = this.readMetadataString(metadata, ['projectIdentifier', 'project_identifier']) || this.buildProjectIdentifier(name);
    return { identifier };
  }

  private buildProjectIdentifier(name: string): string {
    const words = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
    const candidate = words.slice(0, 3).map((word) => word[0]?.toUpperCase() || '').join('');
    return candidate || 'TASK';
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

  private readSequenceId(task: StoredTask): string {
    return this.readMetadataString(task.metadata || {}, ['sequenceId', 'sequence_id']) || task.taskId.slice(0, 8);
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
}
