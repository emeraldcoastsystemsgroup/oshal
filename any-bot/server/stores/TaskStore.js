/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Preserve exact durable task owners and reject invalid owner assertions on save/load/list instead of collapsing empty or malformed database values into anonymous ownership.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: add owner-filtered pagination at the durable query boundary so object lists cannot fetch another owner's rows before filtering.
 */

/**
 * Task Store - SQLite persistence for tasks
 * Handles CRUD operations and task state management
 * MIGRATED TO better-sqlite3 for synchronous, reliable operations
 */

const Database = require('better-sqlite3');
const logger = require('../utils/logger');
const config = require('../utils/config');
const path = require('path');
const fs = require('fs');
const { optionalExactUserSubject } = require('../services/codebase/exact-user-subject');

/** Validate a durable owner while preserving genuine nullish anonymous ownership. */
function durableTaskOwner(value) {
  return optionalExactUserSubject(value, 'durable task owner') ?? null;
}

/**
 * @description Encapsulates durable storage of task records so the swarm can
 * survive process restarts and recover in-flight work. Wraps a synchronous
 * better-sqlite3 connection to give callers a small, predictable CRUD surface
 * (save/load/list/update/delete) without leaking SQL or persistence concerns
 * into the rest of the server.
 */
class TaskStore {
  /**
   * @description Configures the store with the database location and defers
   * actual connection/schema setup to init(), so constructing the store is
   * cheap and side-effect free.
   * @param {string|null} [dbPath=null] Filesystem path to the SQLite database;
   *   falls back to the application's configured database path when omitted.
   */
  constructor(dbPath = null) {
    this.dbPath = dbPath || config.database.path;
    this.db = null;
    this.initialized = false;
  }

  /**
   * Initialize database and create schema
   */
  init() {
    try {
      // Ensure database directory exists
      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      // Open database connection (synchronous) with explicit read-write mode
      this.db = new Database(this.dbPath, { readonly: false, fileMustExist: false });
      logger.info(`Database opened in READ-WRITE mode: ${this.dbPath}`);

      // Enable foreign key constraints
      this.db.pragma('foreign_keys = ON');
      logger.info('Foreign key constraints enabled');

      // Set synchronous mode for immediate persistence
      this.db.pragma('synchronous = FULL');
      logger.info('Synchronous FULL mode enabled');

      // Create schema
      this.createSchema();
      
      this.initialized = true;
      logger.info('TaskStore initialized successfully');
    } catch (err) {
      logger.error(`Failed to initialize database: ${err.message}`);
      throw err;
    }
  }

  /**
   * Create database schema
   */
  createSchema() {
    const schema = `
      -- Tasks table
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        mode TEXT DEFAULT 'act',
        owner_sub TEXT,
        workspace_dir TEXT,
        gitlab_url TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        api_metrics TEXT,
        progress TEXT,
        checkpoint_id TEXT
      );

      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
    `;

    try {
      this.db.exec(schema);
      logger.info('Database schema created successfully');
      
      // Add workspace_dir column if it doesn't exist (migration for existing databases)
      try {
        this.db.exec('ALTER TABLE tasks ADD COLUMN workspace_dir TEXT');
        logger.info('Added workspace_dir column to existing tasks table');
      } catch (err) {
        // Column already exists or table just created, ignore
        if (!err.message.includes('duplicate column')) {
          logger.debug('workspace_dir column already exists or table just created');
        }
      }
      
      // Add gitlab_url column if it doesn't exist (migration for existing databases)
      try {
        this.db.exec('ALTER TABLE tasks ADD COLUMN gitlab_url TEXT');
        logger.info('Added gitlab_url column to existing tasks table');
      } catch (err) {
        // Column already exists or table just created, ignore
        if (!err.message.includes('duplicate column')) {
          logger.debug('gitlab_url column already exists or table just created');
        }
      }

      // Durable owner binding for authenticated bot-node task reuse. Existing rows remain NULL and
      // are treated as anonymous legacy tasks; authenticated callers may not claim them by id.
      try {
        this.db.exec('ALTER TABLE tasks ADD COLUMN owner_sub TEXT');
        logger.info('Added owner_sub column to existing tasks table');
      } catch (err) {
        if (!err.message.includes('duplicate column')) throw err;
        logger.debug('owner_sub column already exists or table just created');
      }
    } catch (err) {
      logger.error(`Schema creation failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Save a task
   */
  saveTask(task) {
    if (!this.initialized) {
      throw new Error('TaskStore not initialized');
    }

    const sql = `
      INSERT OR REPLACE INTO tasks (id, text, status, mode, owner_sub, workspace_dir, gitlab_url, created_at, updated_at, api_metrics, progress, checkpoint_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      task.id,
      task.text,
      task.status,
      task.mode || 'act',
      durableTaskOwner(task.userSub),
      task.workspace_dir || null,
      task.gitlab_url || null,
      task.ts || Date.now(),
      Date.now(),
      task.apiMetrics ? JSON.stringify(task.apiMetrics) : null,
      task.progress ? JSON.stringify(task.progress) : null,
      task.checkpoint?.id || null,
    ];

    try {
      const stmt = this.db.prepare(sql);
      stmt.run(...params);
      logger.debug(`Task saved: ${task.id}`);
      return task;
    } catch (err) {
      logger.error(`Failed to save task ${task.id}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Load a task by ID
   */
  loadTask(taskId) {
    if (!this.initialized) {
      throw new Error('TaskStore not initialized');
    }

    const sql = 'SELECT * FROM tasks WHERE id = ?';

    try {
      const stmt = this.db.prepare(sql);
      const row = stmt.get(taskId);
      
      if (!row) {
        return null;
      }

      // Parse JSON fields
      return {
        id: row.id,
        text: row.text,
        status: row.status,
        mode: row.mode,
        userSub: durableTaskOwner(row.owner_sub),
        workspace_dir: row.workspace_dir,
        gitlab_url: row.gitlab_url,
        ts: row.created_at,
        apiMetrics: row.api_metrics ? JSON.parse(row.api_metrics) : null,
        progress: row.progress ? JSON.parse(row.progress) : null,
        checkpoint: row.checkpoint_id ? { id: row.checkpoint_id } : null,
      };
    } catch (err) {
      logger.error(`Failed to load task ${taskId}: ${err.message}`);
      throw err;
    }
  }

  /**
   * List all tasks
   */
  listTasks(limit = 50, offset = 0) {
    if (!this.initialized) {
      throw new Error('TaskStore not initialized');
    }

    const sql = `
      SELECT * FROM tasks 
      ORDER BY updated_at DESC 
      LIMIT ? OFFSET ?
    `;

    try {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all(limit, offset);
      
      return rows.map((row) => ({
        id: row.id,
        text: row.text,
        status: row.status,
        mode: row.mode,
        userSub: durableTaskOwner(row.owner_sub),
        workspace_dir: row.workspace_dir,
        ts: row.created_at,
        updatedAt: row.updated_at,
        apiMetrics: row.api_metrics ? JSON.parse(row.api_metrics) : null,
        progress: row.progress ? JSON.parse(row.progress) : null,
      }));
    } catch (err) {
      logger.error(`Failed to list tasks: ${err.message}`);
      throw err;
    }
  }

  /**
   * List only tasks bound to one exact owner. Filtering in SQL keeps pagination and
   * row visibility aligned; callers never load another owner's records into memory.
   */
  listTasksForOwner(ownerSub, limit = 50, offset = 0) {
    if (!this.initialized) throw new Error('TaskStore not initialized');
    const owner = durableTaskOwner(ownerSub);
    if (!owner) throw new TypeError('Task owner is required');
    const rows = this.db.prepare(`
      SELECT * FROM tasks
      WHERE owner_sub = ?
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `).all(owner, limit, offset);
    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      status: row.status,
      mode: row.mode,
      userSub: durableTaskOwner(row.owner_sub),
      workspace_dir: row.workspace_dir,
      ts: row.created_at,
      updatedAt: row.updated_at,
      apiMetrics: row.api_metrics ? JSON.parse(row.api_metrics) : null,
      progress: row.progress ? JSON.parse(row.progress) : null,
    }));
  }

  /**
   * Update task status
   */
  updateTaskStatus(taskId, status) {
    if (!this.initialized) {
      throw new Error('TaskStore not initialized');
    }

    const sql = 'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?';

    try {
      const stmt = this.db.prepare(sql);
      stmt.run(status, Date.now(), taskId);
      logger.debug(`Task status updated: ${taskId} -> ${status}`);
    } catch (err) {
      logger.error(`Failed to update task status: ${err.message}`);
      throw err;
    }
  }

  /**
   * Delete a task
   */
  deleteTask(taskId) {
    if (!this.initialized) {
      throw new Error('TaskStore not initialized');
    }

    const sql = 'DELETE FROM tasks WHERE id = ?';

    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.run(taskId);
      logger.debug(`Task deleted: ${taskId}`);
      return result.changes > 0;
    } catch (err) {
      logger.error(`Failed to delete task ${taskId}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Close database connection
   */
  close() {
    try {
      if (this.db) {
        this.db.close();
        logger.info('Database connection closed');
        this.initialized = false;
      }
    } catch (err) {
      logger.error(`Failed to close database: ${err.message}`);
      throw err;
    }
  }
}

module.exports = TaskStore;
