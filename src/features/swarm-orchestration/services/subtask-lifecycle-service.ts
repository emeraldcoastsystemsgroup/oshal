/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added subtask lifecycle service — tracks subtask state transitions, parent rollup, and queue filtering
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Refactored to use SubtaskLifecycleStore for pluggable persistence (in-memory or Postgres)
 */

import {
  MAX_ACTIVE_SUBTASKS_PER_PARENT,
  ACTIVE_SUBTASK_STATUSES,
  TERMINAL_SUBTASK_STATUSES,
  SUBTASK_STATUSES,
} from '@/entities/work-item';
import type { WorkItemStatus } from '@/entities/work-item';
import { createChildLogger } from '@/shared/logger';
import type { DecomposedWorkUnit } from './ticket-decomposition-service';
import { InMemorySubtaskLifecycleStore, type SubtaskLifecycleStore } from './subtask-lifecycle-store';

const logger = createChildLogger({ module: 'subtask-lifecycle-service' });

/* ------------------------------------------------------------------ */
/*  Tracked subtask record                                             */
/* ------------------------------------------------------------------ */

/**
 * @description A subtask with its current queue state, tracked by the lifecycle service.
 * Extends DecomposedWorkUnit with mutable state tracking.
 */
export interface TrackedSubtask {
  /** The underlying work unit */
  workUnit: DecomposedWorkUnit;
  /** Current subtask status (one of the subtask-* WorkItemStatus values) */
  state: WorkItemStatus;
  /** Timestamp of last state transition */
  lastTransitionAt: string;
  /** Optional execution output from the agent */
  executionOutput?: string;
}

/**
 * @description Parent work unit with its tracked subtask children.
 */
export interface ParentWithSubtasks {
  /** The root (depth-0) work unit */
  parent: DecomposedWorkUnit;
  /** All subtasks (active + terminal) for this parent */
  subtasks: TrackedSubtask[];
}

/**
 * @description Rollup result — summary of subtask completion for a parent.
 */
export interface SubtaskRollupResult {
  /** Parent unit ID */
  parentUnitId: string;
  /** Total subtasks ever created for this parent */
  totalCreated: number;
  /** Subtasks in terminal state (complete or closed) */
  terminalCount: number;
  /** Subtasks still active (todo or in-progress) */
  activeCount: number;
  /** Whether all subtasks are in terminal state */
  allComplete: boolean;
  /** Whether more subtasks can be spawned (active < cap) */
  canSpawnMore: boolean;
}

/* ------------------------------------------------------------------ */
/*  Valid state transitions                                            */
/* ------------------------------------------------------------------ */

const VALID_TRANSITIONS: Partial<Record<WorkItemStatus, WorkItemStatus[]>> = {
  'subtask-pending': ['subtask-assigned', 'subtask-failed'],
  'subtask-assigned': ['subtask-executing', 'subtask-failed'],
  'subtask-executing': ['subtask-completed', 'subtask-failed'],
  'subtask-completed': [],
  'subtask-failed': [],
};

/* ------------------------------------------------------------------ */
/*  Service                                                            */
/* ------------------------------------------------------------------ */

/**
 * @description Manages the lifecycle of subtasks within the swarm orchestration.
 *
 * Responsibilities:
 * - Tracks subtask state transitions (subtask-pending → assigned → executing → complete/failed)
 * - Enforces valid state transitions
 * - Provides rollup: counts active/terminal subtasks per parent
 * - Determines when a parent's subtask work is fully complete
 * - Filters subtasks out of the main ticket queue
 *
 * Delegates all storage to SubtaskLifecycleStore (in-memory or Postgres-backed).
 */
export class SubtaskLifecycleService {
  private readonly store: SubtaskLifecycleStore;

  constructor(store?: SubtaskLifecycleStore) {
    this.store = store ?? new InMemorySubtaskLifecycleStore();
  }

  /**
   * @description Register a parent work unit (depth 0) for subtask tracking.
   *
   * @param parent - The root-level work unit
   */
  async registerParent(parent: DecomposedWorkUnit): Promise<void> {
    if (parent.depth !== 0) {
      logger.warn(
        { unitId: parent.unitId, depth: parent.depth },
        'Only depth-0 units can be registered as parents — ignoring',
      );
      return;
    }

    const exists = await this.store.has(parent.unitId);
    if (!exists) {
      await this.store.set(parent.unitId, { parent, subtasks: [] });
      logger.info({ parentUnitId: parent.unitId }, 'Registered parent for subtask tracking');
    }
  }

  /**
   * @description Add newly created subtasks to a parent's tracking.
   * Subtasks start in subtask-pending state.
   *
   * @param subtasks - Array of depth-1 work units from decomposition
   */
  async addSubtasks(subtasks: DecomposedWorkUnit[]): Promise<void> {
    for (const sub of subtasks) {
      if (!sub.parentUnitId) {
        logger.warn({ unitId: sub.unitId }, 'Subtask has no parentUnitId — skipping');
        continue;
      }

      const entry = await this.store.get(sub.parentUnitId);
      if (!entry) {
        logger.warn(
          { unitId: sub.unitId, parentUnitId: sub.parentUnitId },
          'Parent not registered — skipping subtask',
        );
        continue;
      }

      const tracked: TrackedSubtask = {
        workUnit: sub,
        state: 'subtask-pending',
        lastTransitionAt: new Date().toISOString(),
      };
      entry.subtasks.push(tracked);
      await this.store.set(sub.parentUnitId, entry);

      logger.info(
        { subtaskId: sub.unitId, parentId: sub.parentUnitId, state: 'subtask-pending' },
        'Subtask added to tracking',
      );
    }
  }

  /**
   * @description Transition a subtask to a new state.
   * Validates the transition is legal. Logs all transitions.
   *
   * @param subtaskUnitId - The subtask's unitId
   * @param newState - Target state
   * @returns True if transition succeeded, false if invalid
   */
  async transitionSubtask(subtaskUnitId: string, newState: WorkItemStatus): Promise<boolean> {
    const result = await this.findSubtaskWithParent(subtaskUnitId);
    if (!result) {
      logger.error({ subtaskUnitId }, 'Subtask not found in any parent registry');
      return false;
    }

    const { tracked, parentUnitId, entry } = result;
    const allowed = VALID_TRANSITIONS[tracked.state] ?? [];
    if (!allowed.includes(newState)) {
      logger.warn(
        { subtaskId: subtaskUnitId, currentState: tracked.state, requestedState: newState },
        'Invalid subtask state transition — rejected',
      );
      return false;
    }

    const oldState = tracked.state;
    tracked.state = newState;
    tracked.lastTransitionAt = new Date().toISOString();
    await this.store.set(parentUnitId, entry);

    logger.info(
      { subtaskId: subtaskUnitId, from: oldState, to: newState },
      'Subtask state transition',
    );

    return true;
  }

  /**
   * @description Record execution output for a subtask (set during subtask-executing).
   *
   * @param subtaskUnitId - The subtask's unitId
   * @param output - Raw execution output from the agent
   */
  async recordExecutionOutput(subtaskUnitId: string, output: string): Promise<void> {
    const result = await this.findSubtaskWithParent(subtaskUnitId);
    if (result) {
      result.tracked.executionOutput = output;
      await this.store.set(result.parentUnitId, result.entry);
    }
  }

  /**
   * @description Get the rollup status for a parent — how many subtasks are
   * active, terminal, and whether more can be spawned.
   *
   * @param parentUnitId - The parent's unitId
   * @returns Rollup result, or null if parent not registered
   */
  async getRollup(parentUnitId: string): Promise<SubtaskRollupResult | null> {
    const entry = await this.store.get(parentUnitId);
    if (!entry) return null;

    const activeCount = entry.subtasks.filter((s) =>
      (ACTIVE_SUBTASK_STATUSES as readonly string[]).includes(s.state),
    ).length;
    const terminalCount = entry.subtasks.filter((s) =>
      (TERMINAL_SUBTASK_STATUSES as readonly string[]).includes(s.state),
    ).length;

    return {
      parentUnitId,
      totalCreated: entry.subtasks.length,
      terminalCount,
      activeCount,
      allComplete: activeCount === 0 && entry.subtasks.length > 0,
      canSpawnMore: activeCount < MAX_ACTIVE_SUBTASKS_PER_PARENT,
    };
  }

  /**
   * @description Get all active (non-terminal) subtasks for a parent.
   * Used by the execution loop to determine what to dispatch next.
   *
   * @param parentUnitId - The parent's unitId
   * @returns Array of tracked subtasks in active states
   */
  async getActiveSubtasks(parentUnitId: string): Promise<TrackedSubtask[]> {
    const entry = await this.store.get(parentUnitId);
    if (!entry) return [];

    return entry.subtasks.filter((s) =>
      (ACTIVE_SUBTASK_STATUSES as readonly string[]).includes(s.state),
    );
  }

  /**
   * @description Get subtasks in subtask-pending state, ready for dispatch.
   *
   * @param parentUnitId - The parent's unitId
   * @returns Array of tracked subtasks in subtask-pending state
   */
  async getTodoSubtasks(parentUnitId: string): Promise<TrackedSubtask[]> {
    const entry = await this.store.get(parentUnitId);
    if (!entry) return [];

    return entry.subtasks.filter((s) => s.state === 'subtask-pending');
  }

  /**
   * @description Get all subtasks for a parent (all states).
   * Used for reporting/debugging.
   *
   * @param parentUnitId - The parent's unitId
   * @returns Array of all tracked subtasks
   */
  async getAllSubtasks(parentUnitId: string): Promise<TrackedSubtask[]> {
    const entry = await this.store.get(parentUnitId);
    if (!entry) return [];
    return [...entry.subtasks];
  }

  /**
   * @description Check if a parent has any subtasks at all.
   *
   * @param parentUnitId - The parent's unitId
   * @returns True if at least one subtask exists
   */
  async hasSubtasks(parentUnitId: string): Promise<boolean> {
    const entry = await this.store.get(parentUnitId);
    return !!entry && entry.subtasks.length > 0;
  }

  /**
   * @description Filter a list of work items to exclude subtasks.
   * Used to keep subtasks out of the main ticket queue display.
   *
   * @param units - Array of work units (mixed depths)
   * @returns Only depth-0 (root) work units
   */
  filterMainQueueOnly(units: DecomposedWorkUnit[]): DecomposedWorkUnit[] {
    return units.filter((u) => u.depth === 0);
  }

  /**
   * @description Returns all tracked parent unit IDs.
   * Used by in-memory rollup to iterate parents without a DB query.
   *
   * @returns Array of parent unit IDs
   */
  async getAllTrackedParentIds(): Promise<string[]> {
    const entries = await this.store.values();
    return entries.map((e) => e.parent.unitId);
  }

  /**
   * @description Clear all tracking for a parent and its subtasks.
   * Called when a ticket is fully complete or closed.
   *
   * @param parentUnitId - The parent's unitId
   */
  async clearParent(parentUnitId: string): Promise<void> {
    const deleted = await this.store.delete(parentUnitId);
    if (deleted) {
      logger.info({ parentUnitId }, 'Cleared parent and all subtask tracking');
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Private helpers                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * @description Find a tracked subtask across all parents, returning its parent context.
   * @param subtaskUnitId - The subtask's unitId
   * @returns Tracked subtask with parent context, or null
   */
  private async findSubtaskWithParent(subtaskUnitId: string): Promise<{
    tracked: TrackedSubtask;
    parentUnitId: string;
    entry: ParentWithSubtasks;
  } | null> {
    const entries = await this.store.values();
    for (const entry of entries) {
      const found = entry.subtasks.find((s) => s.workUnit.unitId === subtaskUnitId);
      if (found) {
        return { tracked: found, parentUnitId: entry.parent.unitId, entry };
      }
    }
    return null;
  }
}