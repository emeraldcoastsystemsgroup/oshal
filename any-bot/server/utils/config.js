/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Configuration Management
 * Centralized configuration for the application
 */

const path = require('path');
const fs = require('fs');

/**
 * @description Centralized application configuration. Reads all tunables from
 * environment variables once at construction so the rest of the codebase has a
 * single, validated source of truth instead of scattered `process.env` lookups.
 * Grouped namespaces (server, database, llm, mcp, plane, etc.) keep related
 * settings together and make defaults explicit for local/dev versus production.
 */
class Config {
  /**
   * @description Resolves the active environment and eagerly loads every
   * configuration namespace so the singleton is fully populated as soon as it
   * is instantiated (fail-fast on missing/invalid settings at startup).
   */
  constructor() {
    this.env = process.env.NODE_ENV || 'development';
    this.loadConfig();
  }

  /**
   * @description Builds every configuration namespace from environment
   * variables, applying sane defaults that differ by environment where it
   * matters (e.g. log level). Centralizing this here means env parsing/coercion
   * happens exactly once and directories are provisioned before first use.
   */
  loadConfig() {
    // Server configuration
    this.server = {
      port: parseInt(process.env.PORT || '5000', 10),
      host: process.env.HOST || '0.0.0.0',
      baseUrl: process.env.BASE_URL || 'http://localhost:5000',
    };

    // Database configuration
    this.database = {
      path: process.env.DATABASE_PATH || path.join(__dirname, '../../data/cline.db'),
      maxConnections: parseInt(process.env.DB_MAX_CONNECTIONS || '10', 10),
    };

    // Logging configuration
    this.logging = {
      level: process.env.LOG_LEVEL || (this.env === 'production' ? 'info' : 'debug'),
      dir: process.env.LOG_DIR || path.join(__dirname, '../../logs'),
    };

    // LLM configuration (defaults, can be overridden per-user)
    this.llm = {
      defaultProvider: process.env.LLM_PROVIDER || 'cline-cli',
      // Claude 3.7 Sonnet - Latest available in GovCloud (verified working)
      defaultModel: process.env.LLM_MODEL || 'anthropic.claude-3-7-sonnet-20250219-v1:0',
      // Previous model (Claude 3.5): 'anthropic.claude-3-5-sonnet-20241022-v2:0'
      // Note: Claude 4.5 does NOT exist in GovCloud - do not use as fallback
      maxTokens: parseInt(process.env.LLM_MAX_TOKENS || '4096', 10),
      temperature: parseFloat(process.env.LLM_TEMPERATURE || '0.7'),
      timeout: parseInt(process.env.LLM_TIMEOUT || '300000', 10), // 5 minutes
    };

    // Cline Agent Mode configuration
    // When enabled, any-bot delegates to Cline CLI instead of BedrockProvider/AgenticController
    this.clineAgent = {
      enabled: process.env.USE_CLINE_AGENT === 'true' || process.env.USE_CLINE_AGENT === '1',
      timeout: parseInt(process.env.CLINE_AGENT_TIMEOUT || '300', 10), // 5 min default (in seconds)
      customInstructions: process.env.CLINE_CUSTOM_INSTRUCTIONS || '',
    };

    // MCP server configuration (stdio-based and HTTP-based)
    this.mcp = {
      enabled: process.env.MCP_ENABLED !== 'false',
      servers: {
        // HTTP-based MCP servers
        // Opt-in only: the bundled google-search-mcp container was retired 2026-07-23
        // (its npm package no longer resolves and it ran in no active stack). Point
        // GOOGLE_SEARCH_MCP_HOST at your own endpoint to re-enable.
        'google-search': {
          host: process.env.GOOGLE_SEARCH_MCP_HOST || '',
          port: parseInt(process.env.GOOGLE_SEARCH_MCP_PORT || '8080', 10),
          enabled: process.env.ENABLE_GOOGLE_SEARCH === 'true' && !!process.env.GOOGLE_SEARCH_MCP_HOST,
          description: 'Google Custom Search microservice (HTTP)'
        },
        'presentron-mcp': {
          host: process.env.PRESENTRON_MCP_HOST || 'presentron-mcp',
          port: parseInt(process.env.PRESENTRON_MCP_PORT || '8081', 10),
          enabled: process.env.ENABLE_PRESENTRON_MCP !== 'false',
          description: 'AI-powered presentation generation via Presentron MCP'
        },
        // stdio-based MCP servers
        // context7 REMOVED (2026-03-05) — never used, added to BACKLOG.md
        'filesystem': {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/app/workspace'],
          env: {},
          enabled: true,
          description: 'File system operations'
        },
        'fetch': {
          command: 'npx',
          args: ['-y', 'mcp-fetch-server'],
          env: {},
          enabled: true,
          description: 'Web content fetching'
        },
        // DISABLED: stdio chroma server (conflicts with HTTP chroma-mcp service)
        // 'chroma': {
        //   command: 'node',
        //   args: ['/home/ec2_user/Documents/Cline/MCP/chroma-mcp/build/index.js'],
        //   env: {
        //     CHROMA_HOST: 'localhost',
        //     CHROMA_PORT: '8001',
        //   },
        //   enabled: false,
        //   description: 'RAG knowledge base via Chroma vector database (DISABLED - use HTTP chroma-mcp instead)'
        // },
        'chroma-mcp': {
          host: process.env.CHROMA_MCP_HOST || 'chroma-mcp',
          port: parseInt(process.env.CHROMA_MCP_PORT || '8091', 10),
          enabled: true,
          description: 'RAG knowledge base via Chroma MCP HTTP service'
        },
        'plane-mcp': {
          host: process.env.PLANE_MCP_HOST || 'plane-mcp',
          port: parseInt(process.env.PLANE_MCP_PORT || '3000', 10),
          enabled: process.env.ENABLE_PLANE_MCP === 'true', // PHASE_25: HTTP server mode — enabled on PM bot
          description: 'Plane project management - 23 tools for tickets, projects, cycles, comments (HTTP)'
        },
        'aws-docs': {
          command: 'uvx',
          args: ['awslabs.aws-documentation-mcp-server@latest'],
          env: {},
          enabled: true,
          description: 'AWS documentation retrieval'
        },
        'aws-diagrams': {
          command: 'uvx',
          args: ['awslabs.aws-diagram-mcp-server'],
          env: {},
          enabled: true,
          description: 'AWS diagram generation'
        },
        'sequential-thinking': {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
          env: {},
          enabled: true,
          description: 'Step-by-step problem solving'
        },
        'plane': {
          command: 'node',
          args: ['/app/plane-mcp/build/index.js'],
          env: {
            PLANE_API_KEY: process.env.PLANE_API_KEY,
            PLANE_BASE_URL: process.env.PLANE_BASE_URL || 'http://host.docker.internal:80',
            PLANE_WORKSPACE_SLUG: process.env.PLANE_WORKSPACE_SLUG || 'devopscloud-00',
          },
          enabled: false, // PHASE_25: DISABLED — replaced by HTTP plane-mcp service above
          description: 'Plane project management - stdio mode (DEPRECATED — use HTTP plane-mcp instead)'
        }
      },
      timeout: parseInt(process.env.MCP_TIMEOUT || '60000', 10), // 1 minute
      retryAttempts: parseInt(process.env.MCP_RETRY_ATTEMPTS || '3', 10),
    };

    // File system configuration
    this.filesystem = {
      workspaceDir: process.env.WORKSPACE_DIR || '/app/workspace',
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760', 10), // 10MB
      allowedExtensions: (process.env.ALLOWED_EXTENSIONS || '*').split(','),
    };

    // Security configuration
    this.security = {
      jwtSecret: process.env.JWT_SECRET || this.generateSecret(),
      jwtExpiry: process.env.JWT_EXPIRY || '24h',
      rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW || '900000', 10), // 15 minutes
      rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
      corsOrigins: (process.env.CORS_ORIGINS || '*').split(','),
    };

    // Streaming configuration
    this.streaming = {
      chunkSize: parseInt(process.env.STREAM_CHUNK_SIZE || '1024', 10),
      heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || '30000', 10), // 30 seconds
      reconnectAttempts: parseInt(process.env.RECONNECT_ATTEMPTS || '5', 10),
    };

    // Task configuration
    this.task = {
      maxConcurrent: parseInt(process.env.MAX_CONCURRENT_TASKS || '5', 10),
      defaultTimeout: parseInt(process.env.TASK_TIMEOUT || '3600000', 10), // 1 hour
      checkpointInterval: parseInt(process.env.CHECKPOINT_INTERVAL || '10', 10), // Every 10 messages
    };

    // Plane Monitor configuration
    this.planeMonitor = {
      enabled: process.env.ENABLE_PLANE_MONITORING === 'true',
      pollInterval: parseInt(process.env.PLANE_POLL_INTERVAL || '60000', 10), // 1 minute
      workspaceSlug: process.env.PLANE_WORKSPACE_SLUG || 'devopscloud-00',
      projectId: process.env.PLANE_PROJECT_ID || null,
      assigneeId: process.env.PLANE_USER_ID || null,
      monitorStates: process.env.PLANE_MONITOR_STATES || 'TODO,IN_PROGRESS',
      approvalTimeout: parseInt(process.env.PLANE_APPROVAL_TIMEOUT || '3600000', 10) // 1 hour
    };

    // Plane Integration Configuration (Auto-Registration)
    this.plane = {
      enabled: process.env.USE_PLANE === 'true',
      workspace: process.env.PLANE_WORKSPACE_SLUG,
      project: process.env.PLANE_PROJECT,
      apiKey: process.env.PLANE_API_KEY,
      baseUrl: process.env.PLANE_BASE_URL || 'http://plane-proxy-1:80',
    };

    // Bot Persona Configuration (loaded from YAML file if BOT_PERSONA_FILE is set)
    this.persona = this._loadPersona();

    // GCP / Vertex AI (Gemini) Configuration
    this.gcp = {
      enabled: process.env.ENABLE_GCP_VERTEX === 'true',
      projectId: process.env.GCP_PROJECT_ID || process.env.VERTEX_PROJECT || null,
      location: process.env.GCP_LOCATION || process.env.VERTEX_LOCATION || 'us-central1',
      serviceAccountKeyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GCP_SERVICE_ACCOUNT_KEY_FILE || path.join(__dirname, '../../../configs/gcp-service-account.json'),
      serviceAccountEmail: process.env.GCP_SERVICE_ACCOUNT_EMAIL || null,
    };

    // GitLab Integration Configuration (Optional)
    this.gitlab = {
      enabled: process.env.ENABLE_GITLAB_INTEGRATION === 'true',
      url: process.env.GITLAB_URL,
      token: process.env.GITLAB_TOKEN,
      projectNamespace: process.env.GITLAB_PROJECT_NAMESPACE || 'ai-lab'
    };

    // Ensure directories exist
    this.ensureDirectories();
  }

  /**
   * Load bot persona from YAML file (BOT_PERSONA_FILE env var)
   * Returns { name, role, perspective, agentId } or null if not configured
   */
  _loadPersona() {
    const personaFile = process.env.BOT_PERSONA_FILE;
    if (!personaFile) return null;

    try {
      if (!fs.existsSync(personaFile)) {
        console.warn(`⚠️ BOT_PERSONA_FILE not found: ${personaFile}`);
        return null;
      }
      const yaml = require('js-yaml');
      const content = fs.readFileSync(personaFile, 'utf8');
      const parsed = yaml.load(content);
      if (parsed && parsed.perspective) {
        console.log(`✅ Bot persona loaded: ${parsed.name || 'unknown'} (${parsed.role || 'no role'})`);
        return {
          name: parsed.name || process.env.AGENT_ID || 'agent',
          role: parsed.role || '',
          agentId: parsed.agent_id || process.env.AGENT_ID || 'agent',
          perspective: parsed.perspective,
          systemPromptPrefix: `## YOUR IDENTITY AND ROLE\nYou are **${parsed.name || 'an AI agent'}** — ${parsed.role || 'AI assistant'}.\n\n${parsed.perspective}\n\n---\n\n`,
        };
      }
      return null;
    } catch (err) {
      console.warn(`⚠️ Failed to load persona: ${err.message}`);
      return null;
    }
  }

  /**
   * @description Creates any required runtime directories (logs, workspace,
   * database parent) up front so downstream writes never fail on a missing
   * path. Idempotent: existing directories are skipped.
   */
  ensureDirectories() {
    const dirs = [
      this.logging.dir,
      this.filesystem.workspaceDir,
      path.dirname(this.database.path),
    ];

    dirs.forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  /**
   * @description Supplies a JWT secret when none is configured. Throws in
   * production to prevent shipping with a weak/ephemeral key, while returning a
   * throwaway random value in dev so local runs work without setup.
   * @returns {string} A randomly generated secret (development only).
   */
  generateSecret() {
    // Generate a random secret if none provided
    if (this.env === 'production') {
      throw new Error('JWT_SECRET must be set in production');
    }
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  }

  /**
   * @description Safely reads a nested setting via a dot-delimited path so
   * callers can request deep values without manual null-checking each level.
   * @param {string} path Dot-delimited key path (e.g. "mcp.servers.fetch").
   * @param {*} [defaultValue=null] Value returned when the path does not resolve.
   * @returns {*} The resolved configuration value, or defaultValue if absent.
   */
  // Get configuration value by path
  get(path, defaultValue = null) {
    const keys = path.split('.');
    let value = this;

    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        return defaultValue;
      }
    }

    return value;
  }

  /**
   * @description Asserts that critical settings are usable before the app
   * starts (valid port, creatable database and workspace directories), failing
   * loudly with an aggregated error rather than crashing later mid-request.
   * @returns {boolean} True when all checks pass.
   * @throws {Error} If any validation check fails, with all issues collected.
   */
  // Validate configuration
  validate() {
    const errors = [];

    // Validate server port
    if (this.server.port < 1 || this.server.port > 65535) {
      errors.push('Invalid server port');
    }

    // Validate database path
    const dbDir = path.dirname(this.database.path);
    if (!fs.existsSync(dbDir)) {
      try {
        fs.mkdirSync(dbDir, { recursive: true });
      } catch (err) {
        errors.push(`Cannot create database directory: ${err.message}`);
      }
    }

    // Validate workspace directory
    if (!fs.existsSync(this.filesystem.workspaceDir)) {
      try {
        fs.mkdirSync(this.filesystem.workspaceDir, { recursive: true });
      } catch (err) {
        errors.push(`Cannot create workspace directory: ${err.message}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }

    return true;
  }

  /**
   * @description Produces a redacted, log-safe snapshot of key settings for
   * startup diagnostics. Deliberately omits secrets/tokens and emits only the
   * fields useful for confirming how the service is wired.
   * @returns {Object} A summary object of non-sensitive configuration values.
   */
  // Get configuration summary for logging
  getSummary() {
    return {
      environment: this.env,
      server: {
        port: this.server.port,
        host: this.server.host,
      },
      database: {
        path: this.database.path,
      },
      logging: {
        level: this.logging.level,
      },
      mcp: {
        enabled: this.mcp.enabled,
        serverCount: Object.keys(this.mcp.servers).length,
      },
      plane: {
        enabled: this.plane.enabled,
        workspace: this.plane.workspace,
        project: this.plane.project,
      },
      clineAgent: {
        enabled: this.clineAgent.enabled,
        timeout: this.clineAgent.timeout,
      },
      gcp: {
        enabled: this.gcp.enabled,
        projectId: this.gcp.projectId,
        location: this.gcp.location,
      },
    };
  }
}

/**
 * @description Shared singleton configuration instance. Exported (and validated
 * immediately below) so every module imports the same already-loaded settings,
 * guaranteeing consistent values and a single startup-time failure point.
 * @type {Config}
 */
// Create singleton instance
const config = new Config();

// Validate on load
try {
  config.validate();
} catch (err) {
  console.error('Configuration validation failed:', err.message);
  process.exit(1);
}

module.exports = config;