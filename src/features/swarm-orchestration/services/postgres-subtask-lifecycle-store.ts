/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Postgres-backed subtask lifecycle store with in-memory fallback
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { createOptionalPostgresPool, ensureSubtaskLifecycleSchema } from '@/shared/services/database';
import type { ParentWithSubtasks, TrackedSubtask } from './subtask-lifecycle-service';
import type { DecomposedWorkUnit } from './ticket-decomposition-service';
import { InMemorySubtaskLifecycleStore, type SubtaskLifecycleStore } from './subtask-lifecycle-store';

const logger = createChildLogger({ module: 'postgres-subtask-lifecycle-store' });

/**
 * @description Postgres row shape for parent entries.
 */
interface ParentRow {
  parent_unit_id: string;
  parent_data: string | DecomposedWorkUnit;
}

/**
 * @description Postgres row shape for subtask entries.
 */
interface SubtaskRow {
  subtask_unit_id: string;
  parent_unit_id: string;
  work_unit: string | DecomposedWorkUnit;
  state: string;
  last_transition_at: string | Date;
  execution_output: string | null;
}

/**
 * @description Subtask lifecycle store with Postgres persistence and in-memory fallback.
 * Follows the same dual-mode pattern as PostgresSwarmEscalationStore.
 */
export class PostgresSubtaskLifecycleStore implements SubtaskLifecycleStore {
  private readonly fallbackStore = new InMemorySubtaskLifecycleStore();
  private persistentMode = false;
  private readonly initPromise: Promise<void>;

  constructor(private pool: Pool | null = createOptionalPostgresPool('subtask-lifecycle-store')) {
    this.initPromise = this.initializePersistence();
    logger.info({ hasPool: Boolean(this.pool) }, 'Postgres subtask lifecycle store initialized');
  }

  /**
   * @description Retrieves a parent entry with all its subtasks.
   * @param parentUnitId - The parent's unit identifier
   * @returns Parent entry with subtasks, or null
   */
  async get(parentUnitId: string): Promise<ParentWithSubtasks | null> {
    await this.awaitInitialization();
    if (!this.persistentMode) {
      return this.fallbackStore.get(parentUnitId);
    }
    return this.getPersistent(parentUnitId);
  }

  /**
   * @description Stores or updates a parent entry with all its subtasks.
   * @param parentUnitId - The parent's unit identifier
   * @param entry - Full parent-with-subtasks entry
   */
  async set(parentUnitId: string, entry: ParentWithSubtasks): Promise<void> {
    await this.awaitInitialization();
    if (!this.persistentMode) {
      return this.fallbackStore.set(parentUnitId, entry);
    }
    await this.setPersistent(parentUnitId, entry);
  }

  /**
   * @description Deletes a parent entry and cascades to subtasks.
   * @param parentUnitId - The parent's unit identifier
   * @returns True if deleted
   */
  async delete(parentUnitId: string): Promise<boolean> {
    await this.awaitInitialization();
    if (!this.persistentMode) {
      return this.fallbackStore.delete(parentUnitId);
    }
    return this.deletePersistent(parentUnitId);
  }

  /**
   * @description Checks whether a parent entry exists.
   * @param parentUnitId - The parent's unit identifier
   * @returns True if found
   */
  async has(parentUnitId: string): Promise<boolean> {
    await this.awaitInitialization();
    if (!this.persistentMode) {
      return this.fallbackStore.has(parentUnitId);
    }
    const result = await this.pool!.query(
      'SELECT 1 FROM subtask_lifecycle_parents WHERE parent_unit_id = $1',
      [parentUnitId],
    );
    return result.rowCount! > 0;
  }

  /**
   * @description Returns all parent entries with their subtasks.
   * @returns All tracked parent entries
   */
  async values(): Promise<ParentWithSubtasks[]> {
    await this.awaitInitialization();
    if (!this.persistentMode) {
      return this.fallbackStore.values();
    }
    return this.valuesPersistent();
  }

  /**
   * @description Initializes Postgres persistence when the database is reachable.
   */
  private async initializePersistence(): Promise<void> {
    if (!this.pool) {
      return;
    }

    try {
      await ensureSubtaskLifecycleSchema(this.pool);
      this.persistentMode = true;
      logger.info('Subtask lifecycle store persistence mode enabled (postgres)');
    } catch (error) {
      logger.error({ err: error }, 'Subtask lifecycle store persistence init failed; falling back to memory');
      this.persistentMode = false;
      this.pool = null;
    }
  }

  /**
   * @description Waits for async persistence initialization.
   */
  private async awaitInitialization(): Promise<void> {
    await this.initPromise;
  }

  /**
   * @description Retrieves a parent with subtasks from Postgres.
   * @param parentUnitId - Parent unit ID
   * @returns Parent entry or null
   */
  private async getPersistent(parentUnitId: string): Promise<ParentWithSubtasks | null> {
    const parentResult = await this.pool!.query<ParentRow>(
      'SELECT parent_unit_id, parent_data FROM subtask_lifecycle_parents WHERE parent_unit_id = $1',
      [parentUnitId],
    );
    if (parentResult.rows.length === 0) {
      return null;
    }

    const parentData = parseJsonField<DecomposedWorkUnit>(parentResult.rows[0].parent_data);

    const subtaskResult = await this.pool!.query<SubtaskRow>(
      'SELECT subtask_unit_id, work_unit, state, last_transition_at, execution_output FROM subtask_lifecycle_subtasks WHERE parent_unit_id = $1',
      [parentUnitId],
    );

    const subtasks: TrackedSubtask[] = subtaskResult.rows.map(mapSubtaskRow);

    return { parent: parentData, subtasks };
  }

  /**
   * @description Upserts a parent and replaces all its subtasks in Postgres.
   * @param parentUnitId - Parent unit ID
   * @param entry - Full parent-with-subtasks entry
   */
  private async setPersistent(parentUnitId: string, entry: ParentWithSubtasks): Promise<void> {
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO subtask_lifecycle_parents (parent_unit_id, parent_data, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (parent_unit_id) DO UPDATE SET parent_data = $2::jsonb, updated_at = NOW()`,
        [parentUnitId, JSON.stringify(entry.parent)],
      );

      await client.query(
        'DELETE FROM subtask_lifecycle_subtasks WHERE parent_unit_id = $1',
        [parentUnitId],
      );

      for (const tracked of entry.subtasks) {
        await client.query(
          `INSERT INTO subtask_lifecycle_subtasks
           (subtask_unit_id, parent_unit_id, work_unit, state, last_transition_at, execution_output)
           VALUES ($1, $2, $3::jsonb, $4, $5::timestamptz, $6)`,
          [
            tracked.workUnit.unitId,
            parentUnitId,
            JSON.stringify(tracked.workUnit),
            tracked.state,
            tracked.lastTransitionAt,
            tracked.executionOutput ?? null,
          ],
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ err: error, parentUnitId }, 'Failed to persist subtask lifecycle entry');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * @description Deletes a parent and cascading subtasks from Postgres.
   * @param parentUnitId - Parent unit ID
   * @returns True if the parent existed
   */
  private async deletePersistent(parentUnitId: string): Promise<boolean> {
    const result = await this.pool!.query(
      'DELETE FROM subtask_lifecycle_parents WHERE parent_unit_id = $1',
      [parentUnitId],
    );
    const deleted = (result.rowCount ?? 0) > 0;
    if (deleted) {
      logger.info({ parentUnitId }, 'Deleted subtask lifecycle parent from Postgres');
    }
    return deleted;
  }

  /**
   * @description Retrieves all parents with their subtasks from Postgres.
   * @returns All parent entries
   */
  private async valuesPersistent(): Promise<ParentWithSubtasks[]> {
    const parentResult = await this.pool!.query<ParentRow>(
      'SELECT parent_unit_id, parent_data FROM subtask_lifecycle_parents ORDER BY created_at',
    );

    const entries: ParentWithSubtasks[] = [];
    for (const row of parentResult.rows) {
      const entry = await this.getPersistent(row.parent_unit_id);
      if (entry) {
        entries.push(entry);
      }
    }
    return entries;
  }
}

/**
 * @description Parses a JSON field that may already be parsed by the pg driver.
 * @param value - Raw JSON string or already-parsed object
 * @returns Parsed value
 */
function parseJsonField<T>(value: string | T): T {
  if (typeof value === 'string') {
    return JSON.parse(value) as T;
  }
  return value;
}

/**
 * @description Maps a database subtask row to a TrackedSubtask.
 * @param row - Database row
 * @returns Tracked subtask record
 */
function mapSubtaskRow(row: SubtaskRow): TrackedSubtask {
  return {
    workUnit: parseJsonField<DecomposedWorkUnit>(row.work_unit),
    state: row.state as TrackedSubtask['state'],
    lastTransitionAt: row.last_transition_at instanceof Date
      ? row.last_transition_at.toISOString()
      : String(row.last_transition_at),
    executionOutput: row.execution_output ?? undefined,
  };
}