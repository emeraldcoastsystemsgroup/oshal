/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * AgentConfigManager — Redis-backed configuration store for factory-created bots
 * 
 * Every factory-created bot gets a configuration screen pattern:
 * - Config schema defines what fields are needed (API keys, endpoints, model IDs)
 * - Config values stored in Redis: `agent-config:{agentId}` → JSON
 * - Schema stored in Redis: `agent-config-schema:{agentId}` → JSON
 * - GET/PUT /api/agents/:agentId/config endpoints for reading/writing
 * - Tools read their config from this store on startup
 * 
 * Layer 2: Self-Evolving Agent Factory — Config Screen Pattern
 */

const logger = require('../utils/logger');

// Field types supported in config schemas
/**
 * @description Whitelist of input types a config-schema field may declare. Acts as
 * the single source of truth so schema validation can reject unknown field types
 * before they ever reach the config screen or downstream tool consumption.
 * @type {string[]}
 */
const VALID_FIELD_TYPES = ['string', 'password', 'url', 'number', 'boolean', 'select', 'textarea'];

/**
 * @description Manages per-agent configuration screens for the self-evolving agent
 * factory. Persists field schemas and their entered values in Redis (falling back to
 * an in-memory store when no client is supplied) so factory-created bots can describe
 * what they need, validate operator input, and have their tools read live config at
 * runtime. Centralizing this keeps secret handling (password masking) and required-field
 * checks consistent across every generated bot.
 */
class AgentConfigManager {
  /**
   * @param {Object} options
   * @param {Object} options.redisClient - ioredis client
   */
  constructor(options = {}) {
    this.redisClient = options.redisClient || null;
    this.CONFIG_PREFIX = 'agent-config:';
    this.SCHEMA_PREFIX = 'agent-config-schema:';
    this.CONFIG_TTL = 0; // No expiry — config persists until deleted
  }

  /**
   * Initialize the config manager.
   * @returns {Object} { status: string }
   */
  async initialize() {
    if (!this.redisClient) {
      logger.warn('[AgentConfigManager] No Redis client — running in memory-only mode');
      this._memoryStore = new Map();
      this._schemaStore = new Map();
      return { status: 'memory-only' };
    }

    logger.info('[AgentConfigManager] Initialized with Redis backend');
    return { status: 'ready' };
  }

  // ──────────────────────────────────────────────────────────────
  // Schema operations
  // ──────────────────────────────────────────────────────────────

  /**
   * Register a config schema for an agent.
   * Schema defines the fields that appear on the config screen.
   * 
   * @param {string} agentId - Agent identifier
   * @param {Object} schema - Config schema definition
   * @param {string} schema.name - Display name
   * @param {string} schema.description - What this config is for
   * @param {Array} schema.fields - Array of field definitions
   * @returns {Object} { success: boolean, fieldCount: number }
   * 
   * Field definition format:
   * {
   *   key: 'apiKey',           // Redis hash field name
   *   label: 'API Key',        // Display label
   *   type: 'password',        // string|password|url|number|boolean|select|textarea
   *   required: true,          // Is field required?
   *   default: '',             // Default value
   *   description: 'Your API key for the service',
   *   options: ['opt1','opt2'] // Only for type='select'
   *   placeholder: 'sk-...',   // Input placeholder
   *   validation: '^sk-.*'     // Optional regex validation pattern
   * }
   */
  async registerSchema(agentId, schema) {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('agentId is required and must be a string');
    }

    const validation = this.validateSchema(schema);
    if (!validation.valid) {
      throw new Error(`Invalid schema: ${validation.errors.join(', ')}`);
    }

    const schemaData = {
      agentId,
      name: schema.name || agentId,
      description: schema.description || '',
      fields: schema.fields || [],
      version: schema.version || '1.0',
      createdAt: new Date().toISOString(),
      createdBy: schema.createdBy || 'agent-factory-bot',
    };

    const key = `${this.SCHEMA_PREFIX}${agentId}`;

    if (this.redisClient) {
      await this.redisClient.set(key, JSON.stringify(schemaData));
    } else if (this._schemaStore) {
      this._schemaStore.set(agentId, schemaData);
    }

    logger.info(`[AgentConfigManager] Schema registered for ${agentId} with ${schemaData.fields.length} fields`);

    return { success: true, fieldCount: schemaData.fields.length };
  }

  /**
   * Get config schema for an agent.
   * @param {string} agentId
   * @returns {Object|null} Schema or null if not found
   */
  async getSchema(agentId) {
    if (!agentId) return null;

    const key = `${this.SCHEMA_PREFIX}${agentId}`;

    if (this.redisClient) {
      const data = await this.redisClient.get(key);
      return data ? JSON.parse(data) : null;
    } else if (this._schemaStore) {
      return this._schemaStore.get(agentId) || null;
    }

    return null;
  }

  /**
   * Validate a config schema definition.
   * @param {Object} schema
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  validateSchema(schema) {
    const errors = [];

    if (!schema || typeof schema !== 'object') {
      return { valid: false, errors: ['Schema must be an object'] };
    }

    if (!schema.fields || !Array.isArray(schema.fields)) {
      errors.push('schema.fields must be an array');
      return { valid: false, errors };
    }

    if (schema.fields.length === 0) {
      errors.push('schema.fields must have at least one field');
    }

    const seenKeys = new Set();

    for (let i = 0; i < schema.fields.length; i++) {
      const field = schema.fields[i];
      const prefix = `fields[${i}]`;

      if (!field.key || typeof field.key !== 'string') {
        errors.push(`${prefix}.key is required and must be a string`);
        continue;
      }

      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field.key)) {
        errors.push(`${prefix}.key "${field.key}" must be alphanumeric with underscores`);
      }

      if (seenKeys.has(field.key)) {
        errors.push(`${prefix}.key "${field.key}" is duplicated`);
      }
      seenKeys.add(field.key);

      if (!field.label || typeof field.label !== 'string') {
        errors.push(`${prefix}.label is required`);
      }

      if (!field.type || !VALID_FIELD_TYPES.includes(field.type)) {
        errors.push(`${prefix}.type must be one of: ${VALID_FIELD_TYPES.join(', ')}`);
      }

      if (field.type === 'select' && (!field.options || !Array.isArray(field.options) || field.options.length === 0)) {
        errors.push(`${prefix}: select type requires options array`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // ──────────────────────────────────────────────────────────────
  // Config value operations
  // ──────────────────────────────────────────────────────────────

  /**
   * Get all config values for an agent.
   * @param {string} agentId
   * @param {Object} options
   * @param {boolean} options.maskPasswords - Replace password values with '***' (default true)
   * @returns {Object} { config: Object, schema: Object|null }
   */
  async getConfig(agentId, options = {}) {
    if (!agentId) throw new Error('agentId is required');

    const maskPasswords = options.maskPasswords !== false;

    const key = `${this.CONFIG_PREFIX}${agentId}`;
    let config = {};

    if (this.redisClient) {
      const data = await this.redisClient.get(key);
      config = data ? JSON.parse(data) : {};
    } else if (this._memoryStore) {
      config = this._memoryStore.get(agentId) || {};
    }

    const schema = await this.getSchema(agentId);

    // Apply defaults from schema for missing keys
    if (schema && schema.fields) {
      for (const field of schema.fields) {
        if (config[field.key] === undefined && field.default !== undefined) {
          config[field.key] = field.default;
        }
      }
    }

    // Mask password fields if requested
    if (maskPasswords && schema && schema.fields) {
      const passwordFields = schema.fields
        .filter(f => f.type === 'password')
        .map(f => f.key);

      for (const key of passwordFields) {
        if (config[key] && config[key].length > 0) {
          config[key] = '***';
        }
      }
    }

    return { config, schema };
  }

  /**
   * Get raw config values (unmasked, for tool consumption).
   * @param {string} agentId
   * @returns {Object} Raw config values
   */
  async getRawConfig(agentId) {
    if (!agentId) throw new Error('agentId is required');

    const key = `${this.CONFIG_PREFIX}${agentId}`;

    if (this.redisClient) {
      const data = await this.redisClient.get(key);
      return data ? JSON.parse(data) : {};
    } else if (this._memoryStore) {
      return { ...(this._memoryStore.get(agentId) || {}) };
    }

    return {};
  }

  /**
   * Set config values for an agent.
   * Validates against schema if one exists.
   * 
   * @param {string} agentId
   * @param {Object} values - Key-value pairs to set
   * @returns {Object} { success: boolean, updated: string[], warnings: string[] }
   */
  async setConfig(agentId, values) {
    if (!agentId) throw new Error('agentId is required');
    if (!values || typeof values !== 'object') throw new Error('values must be an object');

    const schema = await this.getSchema(agentId);
    const warnings = [];
    const updated = [];

    // Validate against schema if present
    if (schema && schema.fields) {
      const validKeys = new Set(schema.fields.map(f => f.key));

      for (const key of Object.keys(values)) {
        if (!validKeys.has(key)) {
          warnings.push(`Unknown field "${key}" — not in schema`);
        }
      }

      // Validate field types and required
      for (const field of schema.fields) {
        const value = values[field.key];

        if (value !== undefined && value !== null) {
          // Type validation
          if (field.type === 'number' && typeof value !== 'number' && isNaN(Number(value))) {
            throw new Error(`Field "${field.key}" must be a number`);
          }
          if (field.type === 'boolean' && typeof value !== 'boolean') {
            throw new Error(`Field "${field.key}" must be a boolean`);
          }
          if (field.type === 'url' && typeof value === 'string' && value.length > 0) {
            try {
              new URL(value);
            } catch (e) {
              throw new Error(`Field "${field.key}" must be a valid URL`);
            }
          }
          if (field.type === 'select' && field.options && !field.options.includes(value)) {
            throw new Error(`Field "${field.key}" must be one of: ${field.options.join(', ')}`);
          }
          if (field.validation && typeof value === 'string') {
            const regex = new RegExp(field.validation);
            if (!regex.test(value)) {
              throw new Error(`Field "${field.key}" failed validation pattern: ${field.validation}`);
            }
          }
        }
      }
    }

    // Merge with existing config
    const existing = await this.getRawConfig(agentId);
    const merged = { ...existing };

    for (const [key, value] of Object.entries(values)) {
      if (value === null || value === undefined) {
        delete merged[key]; // Allow deletion by setting null
      } else {
        merged[key] = value;
        updated.push(key);
      }
    }

    // Save
    const redisKey = `${this.CONFIG_PREFIX}${agentId}`;

    if (this.redisClient) {
      await this.redisClient.set(redisKey, JSON.stringify(merged));
    } else if (this._memoryStore) {
      this._memoryStore.set(agentId, merged);
    }

    logger.info(`[AgentConfigManager] Config updated for ${agentId}: ${updated.join(', ')}`);

    return { success: true, updated, warnings };
  }

  /**
   * Delete all config and schema for an agent.
   * @param {string} agentId
   * @returns {Object} { deleted: boolean }
   */
  async deleteConfig(agentId) {
    if (!agentId) throw new Error('agentId is required');

    if (this.redisClient) {
      await this.redisClient.del(`${this.CONFIG_PREFIX}${agentId}`);
      await this.redisClient.del(`${this.SCHEMA_PREFIX}${agentId}`);
    } else if (this._memoryStore) {
      this._memoryStore.delete(agentId);
      this._schemaStore.delete(agentId);
    }

    logger.info(`[AgentConfigManager] Config and schema deleted for ${agentId}`);
    return { deleted: true };
  }

  /**
   * Check if an agent's required config fields are all filled.
   * @param {string} agentId
   * @returns {Object} { configured: boolean, missing: string[] }
   */
  async isConfigured(agentId) {
    const schema = await this.getSchema(agentId);
    if (!schema) return { configured: true, missing: [] }; // No schema = no config needed

    const config = await this.getRawConfig(agentId);
    const missing = [];

    for (const field of schema.fields) {
      if (field.required && (!config[field.key] || config[field.key] === '')) {
        missing.push(field.key);
      }
    }

    return { configured: missing.length === 0, missing };
  }

  /**
   * List all agents that have config schemas registered.
   * @returns {Array} Array of { agentId, name, fieldCount, configured }
   */
  async listConfiguredAgents() {
    const agents = [];

    if (this.redisClient) {
      const keys = await this.redisClient.keys(`${this.SCHEMA_PREFIX}*`);

      for (const key of keys) {
        const agentId = key.replace(this.SCHEMA_PREFIX, '');
        const schema = await this.getSchema(agentId);
        const configStatus = await this.isConfigured(agentId);

        agents.push({
          agentId,
          name: schema?.name || agentId,
          description: schema?.description || '',
          fieldCount: schema?.fields?.length || 0,
          configured: configStatus.configured,
          missingFields: configStatus.missing,
        });
      }
    } else if (this._schemaStore) {
      for (const [agentId, schema] of this._schemaStore) {
        const configStatus = await this.isConfigured(agentId);
        agents.push({
          agentId,
          name: schema.name || agentId,
          description: schema.description || '',
          fieldCount: schema.fields?.length || 0,
          configured: configStatus.configured,
          missingFields: configStatus.missing,
        });
      }
    }

    return agents;
  }
}

module.exports = AgentConfigManager;
