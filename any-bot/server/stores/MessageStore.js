/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Message Store - SQLite persistence for messages
 * Handles message history and retrieval
 * MIGRATED TO better-sqlite3 for synchronous, reliable operations
 */

const logger = require('../utils/logger');

/**
 * @description Persistence layer for chat/task messages backed by a synchronous
 * better-sqlite3 connection. Centralizes the messages-table schema, serialization
 * of arbitrary extra fields into a JSON column, and history retrieval so callers
 * never embed SQL directly and message history survives process restarts. Exported
 * as the sole module member for injection with an already-opened database handle.
 */
class MessageStore {
  /**
   * @description Wraps an existing database connection without performing any I/O;
   * schema creation is deferred to init() so construction stays side-effect free and
   * the store can be created before the database is ready.
   * @param {object} db - An open better-sqlite3 database handle used for all queries.
   */
  constructor(db) {
    this.db = db;
    this.initialized = false;
  }

  /**
   * Initialize message store and create schema
   */
  init() {
    const schema = `
      -- Messages table
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        say TEXT,
        ts INTEGER NOT NULL,
        text TEXT,
        data TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_messages_task_id ON messages(task_id);
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
      CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
    `;

    try {
      this.db.exec(schema);
      logger.info('Message schema created successfully');
      this.initialized = true;
    } catch (err) {
      logger.error(`Message schema creation failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Save a message
   */
  saveMessage(taskId, message) {
    if (!this.initialized) {
      throw new Error('MessageStore not initialized');
    }

    const sql = `
      INSERT INTO messages (task_id, type, say, ts, text, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    // Extract core fields
    const { type, say, ts, text, ...extraData } = message;

    const params = [
      taskId,
      type || say || 'unknown',
      say || type || 'unknown',
      ts || Date.now(),
      text || '',
      Object.keys(extraData).length > 0 ? JSON.stringify(extraData) : null,
    ];

    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.run(...params);
      logger.debug(`Message saved: ${result.lastInsertRowid} for task ${taskId}`);
      return { id: result.lastInsertRowid, ...message };
    } catch (err) {
      logger.error(`Failed to save message: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get all messages for a task
   */
  getMessages(taskId) {
    if (!this.initialized) {
      throw new Error('MessageStore not initialized');
    }

    const sql = `
      SELECT * FROM messages 
      WHERE task_id = ? 
      ORDER BY ts ASC
    `;

    try {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all(taskId);
      
      // Reconstruct message objects
      const messages = rows.map((row) => {
        const message = {
          type: row.type,
          say: row.say,
          ts: row.ts,
          text: row.text,
        };

        // Merge in extra data if present
        if (row.data) {
          try {
            const extraData = JSON.parse(row.data);
            Object.assign(message, extraData);
          } catch (err) {
            logger.warn(`Failed to parse message data for id ${row.id}`);
          }
        }

        return message;
      });

      return messages;
    } catch (err) {
      logger.error(`Failed to get messages for task ${taskId}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get message count for a task
   */
  getMessageCount(taskId) {
    if (!this.initialized) {
      throw new Error('MessageStore not initialized');
    }

    const sql = 'SELECT COUNT(*) as count FROM messages WHERE task_id = ?';

    try {
      const stmt = this.db.prepare(sql);
      const row = stmt.get(taskId);
      return row.count;
    } catch (err) {
      logger.error(`Failed to count messages: ${err.message}`);
      throw err;
    }
  }

  /**
   * Delete all messages for a task
   */
  deleteMessages(taskId) {
    if (!this.initialized) {
      throw new Error('MessageStore not initialized');
    }

    const sql = 'DELETE FROM messages WHERE task_id = ?';

    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.run(taskId);
      logger.debug(`Deleted ${result.changes} messages for task ${taskId}`);
      return result.changes;
    } catch (err) {
      logger.error(`Failed to delete messages for task ${taskId}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get latest message for a task
   */
  getLatestMessage(taskId) {
    if (!this.initialized) {
      throw new Error('MessageStore not initialized');
    }

    const sql = `
      SELECT * FROM messages 
      WHERE task_id = ? 
      ORDER BY ts DESC 
      LIMIT 1
    `;

    try {
      const stmt = this.db.prepare(sql);
      const row = stmt.get(taskId);
      
      if (!row) {
        return null;
      }

      const message = {
        type: row.type,
        say: row.say,
        ts: row.ts,
        text: row.text,
      };

      if (row.data) {
        try {
          const extraData = JSON.parse(row.data);
          Object.assign(message, extraData);
        } catch (err) {
          logger.warn(`Failed to parse message data`);
        }
      }

      return message;
    } catch (err) {
      logger.error(`Failed to get latest message: ${err.message}`);
      throw err;
    }
  }

  /**
   * Save multiple messages in a transaction
   */
  saveMessages(taskId, messages) {
    if (!this.initialized) {
      throw new Error('MessageStore not initialized');
    }

    const sql = `
      INSERT INTO messages (task_id, type, say, ts, text, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    try {
      // Use transaction for bulk insert
      const insertMany = this.db.transaction((msgs) => {
        const stmt = this.db.prepare(sql);
        
        for (const message of msgs) {
          const { type, say, ts, text, ...extraData } = message;
          const params = [
            taskId,
            type || say || 'unknown',
            say || type || 'unknown',
            ts || Date.now(),
            text || '',
            Object.keys(extraData).length > 0 ? JSON.stringify(extraData) : null,
          ];
          stmt.run(...params);
        }
      });

      insertMany(messages);
      logger.debug(`Saved ${messages.length} messages for task ${taskId}`);
      return messages;
    } catch (err) {
      logger.error(`Failed to save messages: ${err.message}`);
      throw err;
    }
  }
}

module.exports = MessageStore;
