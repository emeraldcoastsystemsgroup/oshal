/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * ToolScaffolder — Template engine for generating new bot capabilities
 * 
 * When agent-factory-bot designs a new bot with custom capabilities,
 * ToolScaffolder generates all the artifacts needed:
 * 
 * 1. Tool code file (server/services/tools/{toolName}Tool.js)
 * 2. Config schema (what credentials/endpoints the tool needs)
 * 3. Provision manifest (npm dependencies, tool files, build instructions)
 * 4. Persona YAML metadata additions (capabilities, tool references)
 * 
 * The generated tool code follows a standard pattern:
 * - Reads config from AgentConfigManager on initialization
 * - Exposes a standard execute(input) interface
 * - Returns structured results for LLM consumption
 * - Handles errors gracefully with descriptive messages
 * 
 * Layer 2: Self-Evolving Agent Factory — Tool Scaffolding
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

class ToolScaffolder {
  /**
   * @param {Object} options
   * @param {string} options.outputDir - Base directory for generated artifacts
   * @param {string} options.baseImage - Docker base image for custom builds
   */
  constructor(options = {}) {
    this.outputDir = options.outputDir || process.env.SCAFFOLD_OUTPUT_DIR || '/app/swarm-workspace';
    this.baseImage = options.baseImage || process.env.BASE_IMAGE || 'oshal-any-bot:latest';
    this.templateVersion = '1.0.0';
  }

  /**
   * Generate all artifacts for a new bot capability.
   * This is the main entry point called by CapabilityExpander.
   * 
   * @param {Object} spec - Capability specification
   * @param {string} spec.agentId - Bot agent ID (e.g., 'image-generator-bot')
   * @param {string} spec.toolName - Tool function name (e.g., 'imagen')
   * @param {string} spec.displayName - Human-readable name (e.g., 'Image Generator')
   * @param {string} spec.description - What the tool does
   * @param {Array} spec.capabilities - Capability keywords for routing
   * @param {Array} spec.npmDependencies - npm packages to install
   * @param {Object} spec.configFields - Config schema fields (array of field defs)
   * @param {Object} spec.toolLogic - Tool implementation details
   * @param {string} spec.toolLogic.apiEndpoint - API URL pattern
   * @param {string} spec.toolLogic.httpMethod - GET/POST/PUT
   * @param {Object} spec.toolLogic.inputSchema - JSON Schema for tool input
   * @param {Object} spec.toolLogic.outputSchema - Expected output format
   * @param {string} spec.toolLogic.customCode - Optional raw JS code for the handler
   * @returns {Object} { success, artifacts: { toolFile, configSchema, manifest, personaAdditions } }
   */
  async scaffold(spec) {
    const validation = this.validateSpec(spec);
    if (!validation.valid) {
      return { success: false, errors: validation.errors };
    }

    const agentDir = path.join(this.outputDir, spec.agentId);

    // Ensure directory structure
    await this._ensureDirectories(agentDir);

    const artifacts = {};

    // 1. Generate tool code
    const toolCode = this.generateToolCode(spec);
    const toolFilePath = path.join(agentDir, 'tools', `${spec.toolName}Tool.js`);
    await fs.writeFile(toolFilePath, toolCode, 'utf8');
    artifacts.toolFile = toolFilePath;

    // 2. Generate config schema
    const configSchema = this.generateConfigSchema(spec);
    const configSchemaPath = path.join(agentDir, `${spec.agentId}-config-schema.json`);
    await fs.writeFile(configSchemaPath, JSON.stringify(configSchema, null, 2), 'utf8');
    artifacts.configSchema = configSchemaPath;
    artifacts.configSchemaData = configSchema;

    // 3. Generate provision manifest
    const manifest = this.generateProvisionManifest(spec);
    const manifestPath = path.join(agentDir, 'provision-manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    artifacts.manifest = manifestPath;
    artifacts.manifestData = manifest;

    // 4. Generate tool registration metadata
    artifacts.toolRegistration = this.generateToolRegistration(spec);

    // 5. Generate persona additions
    artifacts.personaAdditions = this.generatePersonaAdditions(spec);

    logger.info(`[ToolScaffolder] ✅ Scaffolded ${spec.agentId} with tool ${spec.toolName} → ${agentDir}`);

    return {
      success: true,
      agentId: spec.agentId,
      agentDir,
      artifacts,
    };
  }

  /**
   * Validate a capability specification.
   * @param {Object} spec
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  validateSpec(spec) {
    const errors = [];

    if (!spec || typeof spec !== 'object') {
      return { valid: false, errors: ['spec must be an object'] };
    }

    if (!spec.agentId || typeof spec.agentId !== 'string') {
      errors.push('agentId is required');
    } else if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(spec.agentId)) {
      errors.push('agentId must be lowercase alphanumeric with hyphens');
    }

    if (!spec.toolName || typeof spec.toolName !== 'string') {
      errors.push('toolName is required');
    } else if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(spec.toolName)) {
      errors.push('toolName must be alphanumeric starting with a letter');
    }

    if (!spec.description || typeof spec.description !== 'string') {
      errors.push('description is required');
    }

    if (spec.capabilities && !Array.isArray(spec.capabilities)) {
      errors.push('capabilities must be an array');
    }

    if (spec.npmDependencies && !Array.isArray(spec.npmDependencies)) {
      errors.push('npmDependencies must be an array');
    }

    // Validate npm package names (basic security check)
    if (spec.npmDependencies) {
      for (const dep of spec.npmDependencies) {
        if (typeof dep !== 'string') {
          errors.push(`npm dependency must be a string, got ${typeof dep}`);
        } else if (/[;&|`$]/.test(dep)) {
          errors.push(`npm dependency "${dep}" contains suspicious characters`);
        }
      }
    }

    if (spec.configFields && !Array.isArray(spec.configFields)) {
      errors.push('configFields must be an array');
    }

    if (spec.toolLogic && typeof spec.toolLogic !== 'object') {
      errors.push('toolLogic must be an object');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Generate tool implementation code.
   * Creates a standard tool module that:
   * - Reads config from AgentConfigManager
   * - Implements execute(input) method
   * - Handles errors with descriptive messages
   * 
   * @param {Object} spec - Capability specification
   * @returns {string} Generated JavaScript code
   */
  generateToolCode(spec) {
    const toolClassName = this._toPascalCase(spec.toolName) + 'Tool';
    const hasCustomCode = spec.toolLogic && spec.toolLogic.customCode;
    const httpMethod = (spec.toolLogic && spec.toolLogic.httpMethod) || 'POST';
    const inputProperties = (spec.toolLogic && spec.toolLogic.inputSchema && spec.toolLogic.inputSchema.properties) || {};
    
    // Build input parameter list for the execute function
    const inputParams = Object.keys(inputProperties);
    const inputParamStr = inputParams.length > 0 
      ? inputParams.map(p => `input.${p}`).join(', ')
      : 'input';

    let code = `/**
 * ${toolClassName} — Auto-generated by ToolScaffolder
 * 
 * ${spec.description || 'Custom tool for ' + spec.agentId}
 * 
 * Generated: ${new Date().toISOString()}
 * Scaffolder Version: ${this.templateVersion}
 * Agent: ${spec.agentId}
 */

const logger = require('../../utils/logger');

class ${toolClassName} {
  constructor(configManager) {
    this.configManager = configManager;
    this.agentId = '${spec.agentId}';
    this.toolName = '${spec.toolName}';
    this.initialized = false;
    this.config = {};
  }

  /**
   * Initialize the tool — loads config from AgentConfigManager.
   * Called automatically on first execute if not already initialized.
   */
  async initialize() {
    if (this.configManager) {
      try {
        this.config = await this.configManager.getRawConfig(this.agentId);
        logger.info(\`[\${this.toolName}] Config loaded: \${Object.keys(this.config).length} keys\`);
      } catch (err) {
        logger.warn(\`[\${this.toolName}] Failed to load config: \${err.message}\`);
      }
    }
    this.initialized = true;
  }

  /**
   * Get the tool definition for registration with ToolRegistry.
   * @returns {Object} Tool definition
   */
  getDefinition() {
    return {
      name: '${spec.toolName}',
      description: '${(spec.description || '').replace(/'/g, "\\'")}',
      inputSchema: ${JSON.stringify(spec.toolLogic?.inputSchema || { type: 'object', properties: { input: { type: 'string', description: 'Input for the tool' } } }, null, 6).split('\n').join('\n      ')},
      category: 'dynamic',
      requiresApproval: false,
    };
  }

  /**
   * Execute the tool with the given input.
   * @param {Object} input - Tool input matching inputSchema
   * @returns {Object} Tool result
   */
  async execute(input) {
    if (!this.initialized) {
      await this.initialize();
    }

    const startTime = Date.now();

    try {
      // Validate required config
      const configCheck = this._validateConfig();
      if (!configCheck.valid) {
        return {
          success: false,
          error: \`Missing required configuration: \${configCheck.missing.join(', ')}. ` +
            `Use PUT /api/agents/${spec.agentId}/config to set these values.\`,
        };
      }

`;

    // Add custom or template execution logic
    if (hasCustomCode) {
      code += `      // Custom tool logic
      ${spec.toolLogic.customCode}
`;
    } else if (spec.toolLogic && spec.toolLogic.apiEndpoint) {
      code += `      // API call implementation
      const endpoint = this._resolveEndpoint('${spec.toolLogic.apiEndpoint}');
      
      const response = await fetch(endpoint, {
        method: '${httpMethod}',
        headers: {
          'Content-Type': 'application/json',
          ...this._getAuthHeaders(),
        },
        body: ${httpMethod !== 'GET' ? "JSON.stringify(input)" : 'undefined'},
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(\`API returned \${response.status}: \${errorText}\`);
      }

      const result = await response.json();
`;
    } else {
      code += `      // Default passthrough — replace with actual implementation
      const result = { 
        message: 'Tool executed successfully',
        input,
        timestamp: new Date().toISOString(),
      };
`;
    }

    code += `
      const duration = Date.now() - startTime;
      logger.info(\`[\${this.toolName}] Executed in \${duration}ms\`);

      return {
        success: true,
        result,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(\`[\${this.toolName}] Execution failed (\${duration}ms): \${error.message}\`);

      return {
        success: false,
        error: error.message,
        duration,
      };
    }
  }

  /**
   * Validate that all required config fields are present.
   * @returns {Object} { valid: boolean, missing: string[] }
   */
  _validateConfig() {
    const required = ${JSON.stringify((spec.configFields || []).filter(f => f.required).map(f => f.key))};
    const missing = required.filter(key => !this.config[key] || this.config[key] === '');
    return { valid: missing.length === 0, missing };
  }

  /**
   * Resolve endpoint URL with config substitution.
   * Replaces {configKey} placeholders with config values.
   * @param {string} template - URL template
   * @returns {string} Resolved URL
   */
  _resolveEndpoint(template) {
    let url = template;
    for (const [key, value] of Object.entries(this.config)) {
      url = url.replace(new RegExp(\`\\\\{\${key}\\\\}\`, 'g'), value);
    }
    return url;
  }

  /**
   * Build authentication headers from config.
   * @returns {Object} Headers object
   */
  _getAuthHeaders() {
    const headers = {};
    if (this.config.apiKey) {
      headers['Authorization'] = \`Bearer \${this.config.apiKey}\`;
    }
    if (this.config.authToken) {
      headers['Authorization'] = \`Bearer \${this.config.authToken}\`;
    }
    return headers;
  }
}

module.exports = ${toolClassName};
`;

    return code;
  }

  /**
   * Generate config schema for AgentConfigManager.
   * @param {Object} spec
   * @returns {Object} Config schema
   */
  generateConfigSchema(spec) {
    const fields = (spec.configFields || []).map(field => ({
      key: field.key,
      label: field.label || this._toTitleCase(field.key),
      type: field.type || 'string',
      required: field.required !== false,
      default: field.default || '',
      description: field.description || '',
      placeholder: field.placeholder || '',
      options: field.options || undefined,
      validation: field.validation || undefined,
    }));

    // Add standard fields if not present
    const hasApiKey = fields.some(f => f.key === 'apiKey');
    const hasEndpoint = fields.some(f => f.key === 'endpoint');

    // If tool has an API endpoint but no config fields, add defaults
    if (fields.length === 0 && spec.toolLogic && spec.toolLogic.apiEndpoint) {
      if (!hasEndpoint) {
        fields.push({
          key: 'endpoint',
          label: 'API Endpoint',
          type: 'url',
          required: true,
          default: spec.toolLogic.apiEndpoint || '',
          description: 'Base URL for the API',
          placeholder: 'https://api.example.com',
        });
      }
      if (!hasApiKey) {
        fields.push({
          key: 'apiKey',
          label: 'API Key',
          type: 'password',
          required: true,
          default: '',
          description: 'Authentication key for the API',
          placeholder: 'sk-...',
        });
      }
    }

    return {
      name: spec.displayName || spec.agentId,
      description: spec.description || `Configuration for ${spec.agentId}`,
      version: '1.0',
      fields,
    };
  }

  /**
   * Generate provision-manifest.json for ProvisioningManager.
   * @param {Object} spec
   * @returns {Object} Provision manifest
   */
  generateProvisionManifest(spec) {
    const hasCustomDeps = spec.npmDependencies && spec.npmDependencies.length > 0;

    return {
      agent_id: spec.agentId,
      version: '1.0',
      image_type: hasCustomDeps ? 'custom' : 'base',
      base_image: this.baseImage,
      npm_dependencies: spec.npmDependencies || [],
      capabilities: spec.capabilities || ['general'],
      tool_files: [`tools/${spec.toolName}Tool.js`],
      config_schema: `${spec.agentId}-config-schema.json`,
      health_check: '/api/health',
      max_concurrent: 3,
      env_overrides: {
        AGENT_ID: spec.agentId,
        AGENT_CAPABILITIES: (spec.capabilities || ['general']).join(','),
      },
      scaffolder_version: this.templateVersion,
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * Generate tool registration data for DynamicToolManager.
   * @param {Object} spec
   * @returns {Object} Tool registration payload
   */
  generateToolRegistration(spec) {
    return {
      toolName: spec.toolName,
      description: spec.description || `Tool: ${spec.toolName}`,
      inputSchema: spec.toolLogic?.inputSchema || {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Input for the tool' },
        },
      },
      registeredBy: 'agent-factory-bot',
      serverUrl: `http://swarm-${spec.agentId}:5000`,
      requiresApproval: false,
    };
  }

  /**
   * Generate persona YAML additions for the new bot.
   * These are merged into the persona YAML created by the factory.
   * @param {Object} spec
   * @returns {Object} Persona additions
   */
  generatePersonaAdditions(spec) {
    return {
      capabilities: spec.capabilities || ['general'],
      tools: [spec.toolName],
      config_required: (spec.configFields || []).some(f => f.required),
      config_endpoint: `/api/agents/${spec.agentId}/config`,
      custom_image: (spec.npmDependencies && spec.npmDependencies.length > 0),
      tool_description: spec.description,
    };
  }

  // ──────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────

  /**
   * Ensure output directory structure exists.
   * @param {string} agentDir
   */
  async _ensureDirectories(agentDir) {
    const dirs = [
      agentDir,
      path.join(agentDir, 'tools'),
    ];

    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  /**
   * Convert string to PascalCase.
   * @param {string} str
   * @returns {string}
   */
  _toPascalCase(str) {
    return str
      .replace(/[-_](.)/g, (_, c) => c.toUpperCase())
      .replace(/^(.)/, (_, c) => c.toUpperCase());
  }

  /**
   * Convert camelCase/snake_case to Title Case.
   * @param {string} str
   * @returns {string}
   */
  _toTitleCase(str) {
    return str
      .replace(/([A-Z])/g, ' $1')
      .replace(/[-_]/g, ' ')
      .replace(/^\s+/, '')
      .replace(/\b\w/g, c => c.toUpperCase());
  }
}

/**
 * @description Default export of the ToolScaffolder class so the self-evolving
 * agent factory (CapabilityExpander/ProvisioningManager) can instantiate a single
 * scaffolder to generate tool code, config schemas, provision manifests, and
 * persona metadata for newly designed bot capabilities.
 */
module.exports = ToolScaffolder;
