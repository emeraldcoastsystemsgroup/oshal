/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Tool Registry - Central registry for all available tools
 * Manages tool registration, validation, and retrieval
 */

const logger = require('../utils/logger');
const { sanitizeBrokeredCreds } = require('./codebase/user-scoping');

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
    this.tools.set(name, {
      name,
      description: description || '',
      category,
      inputSchema: inputSchema || {},
      handler,
      requiresApproval,
      timeout,
      registered: Date.now(),
    });

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

    // Auto-inject gitlab_token for presentron-mcp tools if not provided
    const actualToolName = this.aliases.get(toolName) || toolName;
    if (actualToolName.includes('presentron-mcp') && actualToolName.includes('gitlab')) {
      if (!input.gitlab_token) {
        const gitlabToken = process.env.GITLAB_TOKEN;
        if (!gitlabToken) {
          throw new Error('GITLAB_TOKEN is required for GitLab-backed presentron MCP tools.');
        }
        input = { ...input, gitlab_token: gitlabToken };
        logger.info(`Auto-injected configured gitlab_token for tool: ${actualToolName}`);
      }
    }

    // Validate input
    this.validateInput(toolName, input);

    if (tool.requiresApproval && options.approved !== true && input?.approved !== true && input?._approved !== true) {
      throw new Error(`Tool '${toolName}' requires approval before execution.`);
    }

    const scopedUserSub = typeof options.extraEnv?.OSHAL_USER_SUB === 'string'
      && options.extraEnv.OSHAL_USER_SUB.trim()
      ? options.extraEnv.OSHAL_USER_SUB.trim().slice(0, 512)
      : undefined;
    const trustedContext = {
      ...options,
      taskWorkspace: typeof options.taskWorkspace === 'string' ? options.taskWorkspace : undefined,
      extraEnv: {
        ...sanitizeBrokeredCreds(options.extraEnv),
        ...(scopedUserSub ? { OSHAL_USER_SUB: scopedUserSub } : {}),
      },
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

module.exports = ToolRegistry;
