/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Settings Store - SQLite persistence for user settings
 * Handles configuration storage and retrieval
 * MIGRATED TO better-sqlite3 for synchronous, reliable operations
 */

const logger = require('../utils/logger');

/**
 * @description Encapsulates durable persistence of application/user settings so
 * that configuration survives restarts and is shared across the server. Wraps a
 * single SQLite table behind a small key/value API, keeping callers decoupled
 * from storage details (schema, JSON encoding, transactions) and providing a
 * single source of truth for runtime configuration such as the API provider,
 * model, and auto-approve policies.
 */
class SettingsStore {
  /**
   * @description Constructs the store around an existing database handle without
   * touching the schema; defers table creation to init() so that ownership of
   * the connection lifecycle stays with the caller and construction is cheap.
   * @param {object} db - An open better-sqlite3 database handle used for all queries.
   */
  constructor(db) {
    this.db = db;
    this.initialized = false;
  }

  /**
   * Initialize settings store and create schema
   */
  init() {
    const schema = `
      -- Settings table
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Insert default settings if not exist
      INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
        ('apiProvider', 'anthropic', ${Date.now()}),
        ('model', 'claude-3-5-sonnet-20241022', ${Date.now()}),
        ('maxTokens', '4096', ${Date.now()}),
        ('temperature', '0.7', ${Date.now()}),
        ('theme', 'dark', ${Date.now()}),
        ('autoApprove.read', 'false', ${Date.now()}),
        ('autoApprove.write', 'false', ${Date.now()}),
        ('autoApprove.execute', 'false', ${Date.now()}),
        ('autoApprove.browser', 'false', ${Date.now()}),
        ('autoApprove.mcp', 'false', ${Date.now()});
    `;

    try {
      this.db.exec(schema);
      logger.info('Settings schema created successfully');
      this.initialized = true;
    } catch (err) {
      logger.error(`Settings schema creation failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get a setting value
   */
  get(key) {
    if (!this.initialized) {
      throw new Error('SettingsStore not initialized');
    }

    const sql = 'SELECT value FROM settings WHERE key = ?';

    try {
      const stmt = this.db.prepare(sql);
      const row = stmt.get(key);
      
      if (!row) {
        return null;
      }

      // Only parse if it looks like JSON object/array
      const value = row.value;
      if ((value.startsWith('{') && value.endsWith('}')) || 
          (value.startsWith('[') && value.endsWith(']'))) {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      } else {
        // Return as-is for primitives stored as strings
        return value;
      }
    } catch (err) {
      logger.error(`Failed to get setting ${key}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Set a setting value
   */
  set(key, value) {
    if (!this.initialized) {
      throw new Error('SettingsStore not initialized');
    }

    const sql = `
      INSERT OR REPLACE INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
    `;

    // Convert value to string (JSON if object/array)
    const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);

    const params = [key, valueStr, Date.now()];

    try {
      const stmt = this.db.prepare(sql);
      stmt.run(...params);
      logger.debug(`Setting updated: ${key} = ${valueStr}`);
    } catch (err) {
      logger.error(`Failed to set setting ${key}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get all settings
   */
  getAll() {
    if (!this.initialized) {
      throw new Error('SettingsStore not initialized');
    }

    const sql = 'SELECT key, value FROM settings';

    try {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all();
      
      const settings = {};
      
      rows.forEach((row) => {
        // Only parse if it looks like JSON object/array
        const value = row.value;
        if ((value.startsWith('{') && value.endsWith('}')) || 
            (value.startsWith('[') && value.endsWith(']'))) {
          try {
            settings[row.key] = JSON.parse(value);
          } catch {
            settings[row.key] = value;
          }
        } else {
          // Return as-is for primitives stored as strings
          settings[row.key] = value;
        }
      });

      return settings;
    } catch (err) {
      logger.error(`Failed to get all settings: ${err.message}`);
      throw err;
    }
  }

  /**
   * Set multiple settings at once
   */
  setMultiple(settingsObj) {
    if (!this.initialized) {
      throw new Error('SettingsStore not initialized');
    }

    const sql = `
      INSERT OR REPLACE INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
    `;

    try {
      const timestamp = Date.now();

      // Use transaction for bulk update
      const updateMany = this.db.transaction((settings) => {
        const stmt = this.db.prepare(sql);
        
        for (const [key, value] of Object.entries(settings)) {
          const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
          stmt.run(key, valueStr, timestamp);
        }
      });

      updateMany(settingsObj);
      logger.debug(`Updated ${Object.keys(settingsObj).length} settings`);
    } catch (err) {
      logger.error(`Failed to set settings: ${err.message}`);
      throw err;
    }
  }

  /**
   * Delete a setting
   */
  delete(key) {
    if (!this.initialized) {
      throw new Error('SettingsStore not initialized');
    }

    const sql = 'DELETE FROM settings WHERE key = ?';

    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.run(key);
      logger.debug(`Setting deleted: ${key}`);
      return result.changes > 0;
    } catch (err) {
      logger.error(`Failed to delete setting ${key}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Check if a setting exists
   */
  exists(key) {
    if (!this.initialized) {
      throw new Error('SettingsStore not initialized');
    }

    const sql = 'SELECT 1 FROM settings WHERE key = ? LIMIT 1';

    try {
      const stmt = this.db.prepare(sql);
      const row = stmt.get(key);
      return !!row;
    } catch (err) {
      logger.error(`Failed to check setting ${key}: ${err.message}`);
      throw err;
    }
  }
}

module.exports = SettingsStore;
