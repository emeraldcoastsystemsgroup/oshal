/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Checkpoint Store - SQLite persistence for task checkpoints
 * Handles checkpoint creation, restoration, and management
 * MIGRATED TO better-sqlite3 for synchronous, reliable operations
 */

const logger = require('../utils/logger');

/**
 * @description Encapsulates all SQLite-backed persistence for task checkpoints so
 * that an in-progress task's conversation/state can be snapshotted and later
 * restored. Centralizing this logic keeps checkpoint schema, durability
 * guarantees (synchronous writes via better-sqlite3, WAL flushing), and lifecycle
 * management (create/get/list/delete/count) in one place rather than scattered
 * across callers.
 */
class CheckpointStore {
  /**
   * @description Wires the store to an existing better-sqlite3 database handle.
   * Construction is intentionally side-effect free; schema creation is deferred to
   * init() so the caller controls when the database is touched.
   * @param {object} db - An open better-sqlite3 database connection used for all queries.
   */
  constructor(db) {
    this.db = db;
    this.initialized = false;
  }

  /**
   * Initialize checkpoint store and create schema
   */
  init() {
    const schema = `
      -- Checkpoints table
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        data TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_checkpoints_task_id ON checkpoints(task_id);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_created_at ON checkpoints(created_at);
    `;

    try {
      this.db.exec(schema);
      logger.info('Checkpoint schema created successfully');
      this.initialized = true;
    } catch (err) {
      logger.error(`Checkpoint schema creation failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Create a checkpoint
   */
  createCheckpoint(taskId, messages, metadata = {}) {
    if (!this.initialized) {
      throw new Error('CheckpointStore not initialized');
    }

    // Generate unique ID with timestamp + random component to avoid collisions
    const checkpointId = `checkpoint_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const timestamp = Date.now();
    const checkpointData = {
      messages: messages,
      metadata: metadata,
      version: '1.0',
    };

    const sql = `
      INSERT INTO checkpoints (id, task_id, created_at, message_count, data)
      VALUES (?, ?, ?, ?, ?)
    `;

    const params = [
      checkpointId,
      taskId,
      timestamp,
      messages.length,
      JSON.stringify(checkpointData),
    ];

    try {
      // Execute INSERT synchronously
      const stmt = this.db.prepare(sql);
      const result = stmt.run(...params);
      
      if (result.changes === 0) {
        logger.error(`Checkpoint insert affected 0 rows`);
        throw new Error('Checkpoint insert affected 0 rows');
      }
      
      logger.info(`Checkpoint created: ${checkpointId} for task ${taskId} (${result.changes} rows affected)`);
      
      // Verify checkpoint exists (synchronous)
      const verifyStmt = this.db.prepare('SELECT id, task_id, message_count FROM checkpoints WHERE id = ?');
      const row = verifyStmt.get(checkpointId);
      
      if (!row) {
        logger.error(`Checkpoint ${checkpointId} not found after INSERT`);
        throw new Error('Checkpoint not readable after INSERT');
      }
      
      logger.info(`Checkpoint verified: ${row.id} | Task: ${row.task_id} | Messages: ${row.message_count}`);
      
      // CRITICAL FIX: Force database write to disk
      // Execute PRAGMA as a statement to ensure it actually runs
      try {
        this.db.prepare('PRAGMA wal_checkpoint(FULL)').run();
        logger.info(`Checkpoint ${checkpointId}: WAL checkpoint executed`);
      } catch (walErr) {
        logger.warn(`WAL checkpoint failed (non-critical): ${walErr.message}`);
      }
      
      // Return checkpoint summary
      return {
        id: checkpointId,
        taskId: taskId,
        messageCount: messages.length,
        timestamp: timestamp,
      };
    } catch (err) {
      logger.error(`Failed to create checkpoint: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get checkpoint by ID
   */
  getCheckpoint(checkpointId) {
    if (!this.initialized) {
      throw new Error('CheckpointStore not initialized');
    }

    const sql = 'SELECT * FROM checkpoints WHERE id = ?';

    logger.info(`[DEBUG] getCheckpoint called for: ${checkpointId}`);

    try {
      const stmt = this.db.prepare(sql);
      const row = stmt.get(checkpointId);
      
      if (!row) {
        logger.error(`[DEBUG] getCheckpoint: No row found for ${checkpointId}, checking all checkpoints...`);
        
        // Count total checkpoints for debugging
        const countStmt = this.db.prepare('SELECT id FROM checkpoints LIMIT 5');
        const rows = countStmt.all();
        logger.error(`[DEBUG] Total checkpoints in DB: ${rows.length}`);
        
        if (rows.length > 0) {
          logger.error(`[DEBUG] Sample checkpoint IDs: ${rows.map(r => r.id).join(', ')}`);
        }
        
        return null;
      }

      logger.info(`[DEBUG] getCheckpoint: Found checkpoint ${row.id}`);
      
      try {
        const data = JSON.parse(row.data);
        return {
          id: row.id,
          taskId: row.task_id,
          timestamp: row.created_at,
          messageCount: row.message_count,
          messages: data.messages,
          metadata: data.metadata,
        };
      } catch (parseErr) {
        logger.error(`Failed to parse checkpoint data: ${parseErr.message}`);
        throw parseErr;
      }
    } catch (err) {
      logger.error(`Failed to get checkpoint: ${err.message}`);
      throw err;
    }
  }

  /**
   * List checkpoints for a task
   */
  listCheckpoints(taskId) {
    if (!this.initialized) {
      throw new Error('CheckpointStore not initialized');
    }

    const sql = `
      SELECT id, task_id, created_at, message_count 
      FROM checkpoints 
      WHERE task_id = ? 
      ORDER BY created_at DESC
    `;

    try {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all(taskId);
      
      const checkpoints = rows.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        timestamp: row.created_at,
        messageCount: row.message_count,
      }));
      
      return checkpoints;
    } catch (err) {
      logger.error(`Failed to list checkpoints: ${err.message}`);
      throw err;
    }
  }

  /**
   * Delete a checkpoint
   */
  deleteCheckpoint(checkpointId) {
    if (!this.initialized) {
      throw new Error('CheckpointStore not initialized');
    }

    const sql = 'DELETE FROM checkpoints WHERE id = ?';

    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.run(checkpointId);
      logger.debug(`Checkpoint deleted: ${checkpointId}`);
      return result.changes > 0;
    } catch (err) {
      logger.error(`Failed to delete checkpoint: ${err.message}`);
      throw err;
    }
  }

  /**
   * Delete all checkpoints for a task
   */
  deleteTaskCheckpoints(taskId) {
    if (!this.initialized) {
      throw new Error('CheckpointStore not initialized');
    }

    const sql = 'DELETE FROM checkpoints WHERE task_id = ?';

    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.run(taskId);
      logger.debug(`Deleted ${result.changes} checkpoints for task ${taskId}`);
      return result.changes;
    } catch (err) {
      logger.error(`Failed to delete checkpoints for task: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get checkpoint count for a task
   */
  getCheckpointCount(taskId) {
    if (!this.initialized) {
      throw new Error('CheckpointStore not initialized');
    }

    const sql = 'SELECT COUNT(*) as count FROM checkpoints WHERE task_id = ?';

    try {
      const stmt = this.db.prepare(sql);
      const row = stmt.get(taskId);
      return row.count;
    } catch (err) {
      logger.error(`Failed to count checkpoints: ${err.message}`);
      throw err;
    }
  }
}

module.exports = CheckpointStore;
