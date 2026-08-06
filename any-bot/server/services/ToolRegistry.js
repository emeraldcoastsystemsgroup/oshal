/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Preserve exact tool caller subjects and resolve the trusted task cwd through the shared link-free workspace boundary before any handler receives it.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: add request-start handler snapshots, reject replacement/revocation, and accept approval only from trusted execution options.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 audit: freeze registered definitions and nested schemas against in-place TOCTOU mutation, and reject model-carried credential fields.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 credential containment: reject generic OSHAL_CRED_* execution context before a handler runs; only exact caller identity reaches model-selected tools.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | SEC-04: attest authorized snapshot executions with a module-private capability so MCP transports cannot be called through a raw handler reference.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Keep the attestation-minting captured-definition executor private so only registry entry points can reach it.
 */

/**
 * Tool Registry - Central registry for all available tools
 * Manages tool registration, validation, and retrieval
 */

const logger = require('../utils/logger');
const path = require('path');
const { optionalExactUserSubject } = require('./codebase/exact-user-subject');
const { resolveExistingTaskWorkspace } = require('./codebase/task-workspace-scope');

const AUTHORIZED_EXECUTION = Symbol('oshal.tool-registry.authorized-execution');

/** Workspace roots from which a trusted per-task tool cwd may be selected. */
function toolWorkspaceRoots() {
  const appRoot = path.resolve(__dirname, '../../..');
  return [
    process.env.WORKSPACE_DIR,
    process.env.SHARED_WORKSPACE_ROOT,
    process.env.CLINE_SHARED_WORKSPACE_ROOT,
    process.env.WORKSPACE_ROOT,
    path.join(appRoot, 'workspace'),
    path.join(appRoot, 'workspace-shared'),
    path.join(path.dirname(process.env.WORKSPACE_DIR || path.join(appRoot, 'workspace')), 'swarm-workspace'),
  ].filter(Boolean);
}

/**
 * @description Central in-memory registry that holds every tool the agent can
 * call, so the rest of the system has a single source of truth for tool
 * discovery, approval policy, and execution. It tracks tools by name, groups
 * them by category, and maintains aliases so MCP tools (whose canonical names
 * are prefixed like `mcp_servername_toolname`) can be referenced by their short
 * name. It also centralizes input validation, approval gating, and per-tool
 * execution timeouts so callers (e.g. the LLM tool-calling loop) do not have to
 * reimplement those concerns.
 */
class ToolRegistry {
  constructor() {
    this.tools = new Map();
    this.categories = new Map();
    this.aliases = new Map(); // Simple name -> full prefixed name
  }

  /**
   * Register a tool
   */
  register(toolDefinition) {
    const {
      name,
      description,
      category = 'general',
      inputSchema,
      handler,
      requiresApproval = true,
      timeout = 60000,
    } = toolDefinition;

    // Validate required fields
    if (!name) {
      throw new Error('Tool name is required');
    }
    if (!handler || typeof handler !== 'function') {
      throw new Error('Tool handler must be a function');
    }
    if (this.tools.has(name)) {
      logger.warn(`Tool ${name} already registered, overwriting`);
    }

    // Register tool
    const registeredTool = Object.freeze({
      name,
      description: description || '',
      category,
      inputSchema: deepCloneAndFreeze(inputSchema || {}),
      handler,
      requiresApproval,
      timeout,
      registered: Date.now(),
    });
    this.tools.set(name, registeredTool);

    // For MCP tools with prefixed names, register alias without prefix
    // Format: mcp_servername_toolname -> toolname
    if (name.startsWith('mcp_')) {
      const parts = name.split('_');
      if (parts.length >= 3) {
        // Extract simple tool name (everything after server prefix)
        const simpleName = parts.slice(2).join('_');
        if (simpleName && !this.aliases.has(simpleName)) {
          this.aliases.set(simpleName, name);
          logger.debug(`Tool alias registered: ${simpleName} -> ${name}`);
        }
      }
    }

    // Add to category
    if (!this.categories.has(category)) {
      this.categories.set(category, []);
    }
    this.categories.get(category).push(name);

    logger.info(`Tool registered: ${name} (category: ${category})`);
  }

  /**
   * Unregister a tool
   */
  unregister(name) {
    const tool = this.tools.get(name);
    if (!tool) {
      return false;
    }

    // Remove from category
    const category = tool.category;
    if (this.categories.has(category)) {
      const tools = this.categories.get(category);
      const index = tools.indexOf(name);
      if (index > -1) {
        tools.splice(index, 1);
      }
      if (tools.length === 0) {
        this.categories.delete(category);
      }
    }

    // Remove tool
    this.tools.delete(name);
    logger.info(`Tool unregistered: ${name}`);
    return true;
  }

  /**
   * Get a tool by name (with alias lookup)
   */
  get(name) {
    // Try direct lookup first
    let tool = this.tools.get(name);
    if (tool) return tool;
    
    // Try alias lookup for MCP tools
    const fullName = this.aliases.get(name);
    if (fullName) {
      tool = this.tools.get(fullName);
      if (tool) {
        logger.debug(`Tool found via alias: ${name} -> ${fullName}`);
        return tool;
      }
    }
    
    return undefined;
  }

  /**
   * Check if a tool exists (with alias lookup)
   */
  has(name) {
    // Check direct name
    if (this.tools.has(name)) return true;
    
    // Check alias
    const fullName = this.aliases.get(name);
    return fullName && this.tools.has(fullName);
  }

  /**
   * Get all tools
   */
  getAll() {
    return Array.from(this.tools.values());
  }

  /**
   * Capture the exact handler definition authorized for one request.
   * A later unregister/re-register creates a different object and invalidates this snapshot.
   */
  capture(toolName) {
    const tool = this.get(toolName);
    if (!tool) return null;
    return Object.freeze({
      requestedName: toolName,
      canonicalName: tool.name,
      registered: tool.registered,
      tool,
    });
  }

  /** Return true only while the captured name still resolves to the same immutable definition. */
  isSnapshotCurrent(snapshot) {
    return Boolean(
      snapshot
      && snapshot.tool
      && snapshot.registered === snapshot.tool.registered
      && this.get(snapshot.requestedName) === snapshot.tool,
    );
  }

  /** Return true only for context minted while this registry executed the current definition. */
  isAuthorizedExecutionContext(context, toolName) {
    if (!context || typeof context !== 'object') return false;
    const tool = context[AUTHORIZED_EXECUTION];
    return Boolean(tool && tool.name === toolName && this.get(toolName) === tool);
  }

  /**
   * Get tools by category
   */
  getByCategory(category) {
    const toolNames = this.categories.get(category) || [];
    return toolNames.map((name) => this.tools.get(name)).filter(Boolean);
  }

  /**
   * Get all categories
   */
  getCategories() {
    return Array.from(this.categories.keys());
  }

  /**
   * Get tool count
   */
  count() {
    return this.tools.size;
  }

  /**
   * Get tools that require approval
   */
  getApprovalRequired() {
    return Array.from(this.tools.values()).filter((tool) => tool.requiresApproval);
  }

  /**
   * Get tools that can auto-execute
   */
  getAutoExecutable() {
    return Array.from(this.tools.values()).filter((tool) => !tool.requiresApproval);
  }

  /**
   * Get tool names for LLM (tool calling format)
   */
  getToolDefinitionsForLLM() {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  /**
   * Validate tool input against schema
   */
  validateInput(toolName, input) {
    const tool = this.get(toolName); // Use get() with alias lookup
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    return this.validateCapturedInput(toolName, tool, input);
  }

  /** Validate input against the already captured definition, without a second name lookup. */
  validateCapturedInput(toolName, tool, input) {

    // Basic validation - check required fields
    const schema = tool.inputSchema;
    if (schema.required && Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (input[field] === undefined) {
          // Special handling for write_to_file with missing content (output token truncation)
          if (toolName === 'write_to_file' && field === 'content') {
            throw new Error(
              `write_to_file FAILED: The 'content' field was truncated/missing — your response hit the output token limit before the file content was fully transmitted. ` +
              `REQUIRED ACTION: Organize your deliverables into MULTIPLE well-structured files following project management best practices. ` +
              `For example: README.md (overview), ARCHITECTURE.md (design), implementation files (code), tests/, scripts/, etc. ` +
              `Write each file with a separate write_to_file call. Each file can be as large as needed, but use multiple calls across multiple turns. ` +
              `Start by writing the most important deliverable file FIRST, then continue with additional files in subsequent turns. ` +
              `The file path that failed was: ${input.path || 'unknown'}`
            );
          }
          throw new Error(`Missing required field: ${field} for tool ${toolName}`);
        }
      }
    }

    return true;
  }

  /**
   * Execute a tool
   */
  async execute(toolName, input, options = {}) {
    const tool = this.get(toolName); // Use get() with alias lookup
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    return this.#executeCapturedTool(toolName, tool, input, options);
  }

  /** Execute only the exact definition captured at request start. */
  async executeSnapshot(snapshot, input, options = {}) {
    if (!this.isSnapshotCurrent(snapshot)) {
      throw new Error('Tool capability was replaced or revoked after request authorization.');
    }
    return this.#executeCapturedTool(snapshot.requestedName, snapshot.tool, input, options);
  }

  /** Internal execution path shared by live and snapshot dispatch. */
  async #executeCapturedTool(toolName, tool, input, options = {}) {

    // Secrets are server-brokered context, never model/tool input. Accepting a model-supplied
    // credential value would let prompt content choose which account the operation uses.
    if (input && typeof input === 'object'
      && Object.prototype.hasOwnProperty.call(input, 'gitlab_token')) {
      throw new Error('Credential-bearing tool input is prohibited; use the server credential broker.');
    }
    if (options.extraEnv && typeof options.extraEnv === 'object'
      && Object.keys(options.extraEnv).some((key) => key.startsWith('OSHAL_CRED_'))) {
      const error = new Error(
        'Generic tool credential carriers are prohibited; use a deterministic server-side provider intent.',
      );
      error.code = 'UNSCOPED_CREDENTIAL_CARRIER';
      throw error;
    }

    // Validate input
    this.validateCapturedInput(toolName, tool, input);

    if (tool.requiresApproval && options.approved !== true) {
      throw new Error(`Tool '${toolName}' requires approval before execution.`);
    }

    const scopedUserSub = optionalExactUserSubject(
      options.extraEnv?.OSHAL_USER_SUB,
      'tool userSub',
    );
    const taskWorkspace = options.taskWorkspace === undefined
      ? undefined
      : resolveExistingTaskWorkspace(options.taskWorkspace, toolWorkspaceRoots());
    const trustedContext = {
      ...options,
      taskWorkspace,
      extraEnv: {
        ...(scopedUserSub === undefined ? {} : { OSHAL_USER_SUB: scopedUserSub }),
      },
      [AUTHORIZED_EXECUTION]: tool,
    };

    // Execute with timeout
    return Promise.race([
      tool.handler(input, trustedContext),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Tool ${toolName} timed out after ${tool.timeout}ms`)), tool.timeout)
      ),
    ]);
  }

  /**
   * Get tool metadata
   */
  getMetadata(toolName) {
    const tool = this.get(toolName); // Use get() with alias lookup
    if (!tool) {
      return null;
    }

    return {
      name: tool.name,
      description: tool.description,
      category: tool.category,
      requiresApproval: tool.requiresApproval,
      timeout: tool.timeout,
      hasSchema: Object.keys(tool.inputSchema).length > 0,
      registered: tool.registered,
    };
  }

  /**
   * Clear all tools
   */
  clear() {
    this.tools.clear();
    this.categories.clear();
    this.aliases.clear();
    logger.info('All tools cleared from registry');
  }
  
  /**
   * Get all registered aliases
   */
  getAliases() {
    return new Map(this.aliases);
  }
}

/** Clone ordinary schema/config data and recursively freeze it before publication. */
function deepCloneAndFreeze(value, seen = new WeakMap()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new TypeError('Tool definition contains a cyclic schema/config object');
  const clone = Array.isArray(value) ? [] : {};
  seen.set(value, clone);
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === 'function' || typeof nested === 'symbol') {
      throw new TypeError(`Tool definition field ${key} is not immutable data`);
    }
    clone[key] = deepCloneAndFreeze(nested, seen);
  }
  return Object.freeze(clone);
}

module.exports = ToolRegistry;
