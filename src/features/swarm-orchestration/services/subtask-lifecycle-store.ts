/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added SubtaskLifecycleStore interface and InMemorySubtaskLifecycleStore for pluggable persistence
 */

import { createChildLogger } from '@/shared/logger';
import type { ParentWithSubtasks, TrackedSubtask } from './subtask-lifecycle-service';

const logger = createChildLogger({ module: 'subtask-lifecycle-store' });

/**
 * @description Persistence boundary for subtask lifecycle tracking.
 * Implementations provide storage for parent→subtask mappings.
 * The SubtaskLifecycleService delegates all storage to this interface.
 */
export interface SubtaskLifecycleStore {
  /**
   * @description Retrieves a parent entry by its unit ID.
   * @param parentUnitId - The parent's unit identifier
   * @returns Parent entry with subtasks, or null if not found
   */
  get(parentUnitId: string): Promise<ParentWithSubtasks | null>;

  /**
   * @description Stores or updates a parent entry.
   * @param parentUnitId - The parent's unit identifier
   * @param entry - Full parent-with-subtasks entry to persist
   */
  set(parentUnitId: string, entry: ParentWithSubtasks): Promise<void>;

  /**
   * @description Deletes a parent entry and all its subtask tracking.
   * @param parentUnitId - The parent's unit identifier
   * @returns True if the entry existed and was deleted
   */
  delete(parentUnitId: string): Promise<boolean>;

  /**
   * @description Checks whether a parent entry exists.
   * @param parentUnitId - The parent's unit identifier
   * @returns True if the parent is registered
   */
  has(parentUnitId: string): Promise<boolean>;

  /**
   * @description Returns all parent entries currently tracked.
   * @returns Array of all parent-with-subtasks entries
   */
  values(): Promise<ParentWithSubtasks[]>;
}

/**
 * @description In-memory Map-backed implementation of SubtaskLifecycleStore.
 * Default for local development and testing.
 */
export class InMemorySubtaskLifecycleStore implements SubtaskLifecycleStore {
  private readonly registry = new Map<string, ParentWithSubtasks>();

  /**
   * @description Retrieves a parent entry from the in-memory map.
   * @param parentUnitId - The parent's unit identifier
   * @returns Parent entry or null
   */
  async get(parentUnitId: string): Promise<ParentWithSubtasks | null> {
    return this.registry.get(parentUnitId) ?? null;
  }

  /**
   * @description Stores a parent entry in the in-memory map.
   * @param parentUnitId - The parent's unit identifier
   * @param entry - Parent-with-subtasks entry
   */
  async set(parentUnitId: string, entry: ParentWithSubtasks): Promise<void> {
    this.registry.set(parentUnitId, entry);
  }

  /**
   * @description Deletes a parent entry from the in-memory map.
   * @param parentUnitId - The parent's unit identifier
   * @returns True if deleted
   */
  async delete(parentUnitId: string): Promise<boolean> {
    return this.registry.delete(parentUnitId);
  }

  /**
   * @description Checks whether a parent entry exists in the in-memory map.
   * @param parentUnitId - The parent's unit identifier
   * @returns True if found
   */
  async has(parentUnitId: string): Promise<boolean> {
    return this.registry.has(parentUnitId);
  }

  /**
   * @description Returns all parent entries from the in-memory map.
   * @returns All tracked parent entries
   */
  async values(): Promise<ParentWithSubtasks[]> {
    return [...this.registry.values()];
  }
}