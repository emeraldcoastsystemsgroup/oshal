/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted subtask management from SwarmTicketProcessingService to enforce 1000-line governance cap
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added deterministic subtask duplicate guards so retries do not resurrect terminal work items
 */

import type { WorkItemRepository, WorkItemStatus } from '@/entities/work-item';
import type { MeshCommunicationService } from '@/features/agent-management';
import type { SubtaskLifecycleService } from './subtask-lifecycle-service';
import type { TicketDecompositionService, DecomposedWorkUnit, SubtaskDecompositionInput } from './ticket-decomposition-service';
import type { SwarmCyclePolicy } from './swarm-cycle-policy';
import { buildExecutionEnvelope, toError } from './swarm-ticket-processing-support';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'swarm-subtask-handler' });

/**
 * @description Callback signature for polling execution output from work items.
 */
export type AwaitExecutionOutputFn = (externalId: string, policy: SwarmCyclePolicy) => Promise<unknown>;

/**
 * @description Handles subtask creation, dispatch, lifecycle tracking, and parent completion rollup.
 * Extracted from SwarmTicketProcessingService to enforce the 1000-line governance cap.
 */
export class SwarmSubtaskHandler {
  constructor(
    private readonly decompositionService: TicketDecompositionService,
    private readonly subtaskLifecycleService: SubtaskLifecycleService,
    private readonly meshService: MeshCommunicationService,
    private readonly workItemRepository?: WorkItemRepository,
    private readonly awaitExecutionOutput?: AwaitExecutionOutputFn,
  ) {}

  /**
   * @description Creates subtasks for an existing parent work item.
   * Moves the parent to 'in-review' and creates child work items at depth 1.
   *
   * @param runId - Parent swarm run identifier
   * @param parentWorkItemId - UUID of the parent work item
   * @param input - Subtask decomposition input
   * @param assignedAgentId - Agent to assign subtasks to
   * @returns Created subtask work units
   */
  async createSubtasks(
    runId: string,
    parentWorkItemId: string,
    input: SubtaskDecompositionInput,
    assignedAgentId: string,
  ): Promise<DecomposedWorkUnit[]> {
    if (!this.workItemRepository) {
      return [];
    }

    const subtasks = this.decompositionService.decomposeSubtasks(input);
    if (subtasks.length === 0) {
      return [];
    }

    await this.workItemRepository.updateStatus(parentWorkItemId, 'in-review');

    for (const unit of subtasks) {
      const wi = await this.workItemRepository.create({
        swarmRunId: runId,
        externalId: input.externalId,
        provider: 'swarm',
        unitId: unit.unitId,
        title: unit.title,
        description: unit.description,
        acceptanceCriteria: unit.acceptanceCriteria,
        labels: unit.labels,
        priority: unit.priority,
        parentId: parentWorkItemId,
        depth: 1,
      });

      if (wi.status === 'completed' || wi.status === 'failed' || wi.status === 'routing_failed') {
        logger.info(
          { runId, parentWorkItemId, unitId: unit.unitId, status: wi.status },
          'Skipping subtask reassignment because a terminal work item already exists for this deterministic unit',
        );
        continue;
      }

      await this.workItemRepository.updateStatus(wi.workItemId, 'subtask-assigned', assignedAgentId);
    }

    await this.subtaskLifecycleService.registerParent({
      unitId: parentWorkItemId,
      title: `parent-${parentWorkItemId}`,
      description: '',
      acceptanceCriteria: [],
      labels: [],
      priority: input.priority ?? 'medium',
      parentUnitId: null,
      depth: 0,
    });
    await this.subtaskLifecycleService.addSubtasks(subtasks);

    logger.info(
      { runId, parentWorkItemId, subtaskCount: subtasks.length },
      'Subtasks created and parent moved to in-review',
    );

    return subtasks;
  }

  /**
   * @description Checks parents in 'in-review' and completes them if all children are done.
   *
   * @param runId - Swarm run identifier
   * @returns Number of parents that were completed
   */
  async checkAndCompleteParents(runId: string): Promise<number> {
    if (!this.workItemRepository) {
      return this.checkAndCompleteParentsInMemory();
    }

    const parentsInReview = await this.workItemRepository.findParentsInReview(runId);
    let completedCount = 0;

    for (const parent of parentsInReview) {
      const completionResult = await this.evaluateParentCompletion(parent.workItemId);
      if (completionResult) {
        completedCount += 1;
      }
    }

    return completedCount;
  }

  /**
   * @description Dispatches pending subtasks for a parent through individual execution envelopes.
   *
   * @param runId - Parent swarm run identifier
   * @param parentUnitId - The parent work unit's identifier
   * @param assignedAgentId - Agent to dispatch subtasks to
   * @param policy - Resolved run policy for timeout configuration
   * @returns Number of subtasks dispatched and completed
   */
  async dispatchSubtasksForParent(
    runId: string,
    parentUnitId: string,
    assignedAgentId: string,
    policy: SwarmCyclePolicy,
  ): Promise<{ dispatched: number; completed: number; failed: number }> {
    const pending = await this.subtaskLifecycleService.getTodoSubtasks(parentUnitId);
    if (pending.length === 0) {
      return { dispatched: 0, completed: 0, failed: 0 };
    }

    let completed = 0;
    let failed = 0;

    for (const tracked of pending) {
      const result = await this.dispatchSingleSubtask(
        runId, tracked.workUnit, assignedAgentId, policy,
      );
      if (result === 'completed') { completed += 1; }
      if (result === 'failed') { failed += 1; }
    }

    logger.info(
      { runId, parentUnitId, dispatched: pending.length, completed, failed },
      'Subtask dispatch batch completed',
    );
    return { dispatched: pending.length, completed, failed };
  }

  /**
   * @description Registers depth-0 work units as parents in the subtask lifecycle service.
   * @param workUnits - Decomposed work units from ticket decomposition
   */
  async registerParentsWithLifecycle(workUnits: DecomposedWorkUnit[]): Promise<void> {
    for (const unit of workUnits) {
      if (unit.depth === 0) {
        await this.subtaskLifecycleService.registerParent(unit);
      }
    }
  }

  /**
   * @description Persists subtask status update to the work item repository if available.
   * @param unitId - Work unit identifier
   * @param status - New status to persist
   * @param _output - Optional execution output (reserved for future use)
   */
  async persistSubtaskStatus(
    unitId: string,
    status: string,
    _output?: unknown,
  ): Promise<void> {
    if (!this.workItemRepository) return;
    try {
      const items = await this.workItemRepository.findByExternalIdAnyProvider(unitId);
      if (items.length > 0) {
        await this.workItemRepository.updateStatus(items[0].workItemId, status as WorkItemStatus);
      }
    } catch (error) {
      logger.error({ err: toError(error), unitId }, 'Failed to persist subtask status');
    }
  }

  /**
   * @description Evaluates whether a single parent's children are all done.
   * @param parentWorkItemId - UUID of the parent work item
   * @returns True if the parent was completed, false otherwise
   */
  private async evaluateParentCompletion(parentWorkItemId: string): Promise<boolean> {
    if (!this.workItemRepository) {
      return false;
    }

    const completion = await this.workItemRepository.checkChildCompletion(parentWorkItemId);
    if (!completion.allDone) {
      return false;
    }

    const finalStatus = completion.failed > 0 ? 'failed' : 'completed';
    await this.workItemRepository.updateStatus(parentWorkItemId, finalStatus);
    await this.subtaskLifecycleService.clearParent(parentWorkItemId);
    logger.info(
      {
        parentId: parentWorkItemId,
        finalStatus,
        childrenCompleted: completion.completed,
        childrenFailed: completion.failed,
      },
      'Parent work item completed — all children done',
    );
    return true;
  }

  /**
   * @description Falls back to in-memory lifecycle rollup when no DB repository is configured.
   * @returns Number of parents that were completed via in-memory rollup
   */
  private async checkAndCompleteParentsInMemory(): Promise<number> {
    const allParents = await this.subtaskLifecycleService.getAllTrackedParentIds();
    let completedCount = 0;

    for (const parentUnitId of allParents) {
      const rollup = await this.subtaskLifecycleService.getRollup(parentUnitId);
      if (!rollup || !rollup.allComplete) continue;

      await this.subtaskLifecycleService.clearParent(parentUnitId);
      logger.info(
        { parentUnitId, total: rollup.totalCreated, terminal: rollup.terminalCount },
        'Parent completed via in-memory lifecycle rollup',
      );
      completedCount += 1;
    }

    return completedCount;
  }

  /**
   * @description Dispatches a single subtask through the mesh and tracks its lifecycle.
   * @param runId - Parent swarm run identifier
   * @param subtask - The subtask work unit to dispatch
   * @param agentId - Assigned agent identifier
   * @param policy - Resolved run policy
   * @returns Final subtask state: 'completed' or 'failed'
   */
  private async dispatchSingleSubtask(
    runId: string,
    subtask: DecomposedWorkUnit,
    agentId: string,
    policy: SwarmCyclePolicy,
    workspaceTaskId?: string,
  ): Promise<'completed' | 'failed'> {
    try {
      await this.subtaskLifecycleService.transitionSubtask(subtask.unitId, 'subtask-assigned');
      await this.subtaskLifecycleService.transitionSubtask(subtask.unitId, 'subtask-executing');

      const envelope = buildExecutionEnvelope(runId, agentId, subtask.unitId, [subtask], workspaceTaskId);
      await this.meshService.send(envelope);

      const output = this.awaitExecutionOutput
        ? await this.awaitExecutionOutput(subtask.unitId, policy)
        : undefined;
      if (output) {
        await this.subtaskLifecycleService.recordExecutionOutput(subtask.unitId, String(output));
      }

      await this.subtaskLifecycleService.transitionSubtask(subtask.unitId, 'subtask-completed');
      await this.persistSubtaskStatus(subtask.unitId, 'subtask-completed', output);
      return 'completed';
    } catch (error) {
      logger.error({ err: toError(error), subtaskId: subtask.unitId }, 'Subtask dispatch failed');
      await this.subtaskLifecycleService.transitionSubtask(subtask.unitId, 'subtask-failed');
      await this.persistSubtaskStatus(subtask.unitId, 'subtask-failed');
      return 'failed';
    }
  }
}