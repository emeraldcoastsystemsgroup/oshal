/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * AgentBootstrap - Container self-registration service
 * Enables any-bot containers to register as real agents with AgentRegistry on startup
 * Transforms virtual agents (perspectives) into physical agents (containers)
 */

const fs = require('fs').promises;
const yaml = require('js-yaml');
const logger = require('../utils/logger');
const AgentMemory = require('./AgentMemory');

/**
 * @description Self-registration lifecycle manager for an any-bot container so it
 * can join the agent swarm as a first-class, addressable agent rather than a mere
 * perspective. On startup it resolves identity/capabilities/ports from environment
 * and an optional persona, registers with the AgentRegistry, then keeps that
 * registration alive (heartbeat plus TTL-expiry re-registration) and deregisters
 * cleanly on shutdown. The goal is resilient, hands-off presence in the swarm even
 * across Redis key expiry, with graceful degradation when registration fails.
 */
class AgentBootstrap {
  constructor() {
    this.registered = false;
    this.agentId = null;
    this.queueManager = null;
    this.config = null;
    this.agentMemory = null;
  }

  /**
   * Load configuration from environment variables
   * @returns {Object} Agent configuration
   */
  loadConfig() {
    const config = {
      agentId: process.env.AGENT_ID || this.generateUniqueId(),
      capabilities: this.parseCapabilities(process.env.AGENT_CAPABILITIES),
      workspaces: this.parseWorkspaces(process.env.AGENT_WORKSPACES),
      maxConcurrent: parseInt(process.env.AGENT_MAX_CONCURRENT || '3'),
      scope: process.env.AGENT_SCOPE || 'shared',
      personaFile: process.env.BOT_PERSONA_FILE || null,
    };

    // Validate required fields
    if (!config.agentId) {
      throw new Error('AGENT_ID is required for agent swarm mode');
    }

    if (!config.capabilities || config.capabilities.length === 0) {
      logger.warn('No capabilities specified, defaulting to [general]');
      config.capabilities = ['general'];
    }

    logger.info(`Agent config loaded: ${config.agentId}`);
    logger.info(`  Capabilities: ${config.capabilities.join(', ')}`);
    logger.info(`  Workspaces: ${config.workspaces.join(', ')}`);
    logger.info(`  Max concurrent: ${config.maxConcurrent}`);
    logger.info(`  Scope: ${config.scope}`);

    return config;
  }

  /**
   * Parse capabilities from comma-separated string
   * @param {string} capabilitiesStr - Comma-separated capabilities
   * @returns {string[]} Array of capabilities
   */
  parseCapabilities(capabilitiesStr) {
    if (!capabilitiesStr) {
      return [];
    }

    return capabilitiesStr
      .split(',')
      .map(cap => cap.trim())
      .filter(cap => cap.length > 0);
  }

  /**
   * Parse workspaces from comma-separated string
   * @param {string} workspacesStr - Comma-separated workspace IDs
   * @returns {string[]} Array of workspace IDs
   */
  parseWorkspaces(workspacesStr) {
    if (!workspacesStr) {
      return ['*']; // Default: shared agent serving all workspaces
    }

    return workspacesStr
      .split(',')
      .map(ws => ws.trim())
      .filter(ws => ws.length > 0);
  }

  /**
   * Load bot persona from YAML file (optional)
   * @param {string} filepath - Path to YAML persona file
   * @returns {Promise<Object|null>} Persona configuration or null
   */
  async loadPersona(filepath) {
    if (!filepath) {
      logger.info('No persona file specified, using defaults');
      return null;
    }

    try {
      const fileContent = await fs.readFile(filepath, 'utf8');
      const persona = yaml.load(fileContent);

      logger.info(`Persona loaded: ${persona.name || 'Unnamed'}`);
      logger.info(`  Role: ${persona.role || 'Not specified'}`);
      
      if (persona.capabilities) {
        logger.info(`  Persona capabilities: ${persona.capabilities.join(', ')}`);
      }

      return persona;
    } catch (error) {
      logger.warn(`Failed to load persona file ${filepath}: ${error.message}`);
      logger.warn('Continuing with environment-based configuration');
      return null;
    }
  }

  /**
   * Generate unique agent ID
   * @returns {string} Unique agent identifier
   */
  generateUniqueId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 9);
    return `agent-${timestamp}-${random}`;
  }

  /**
   * Initialize agent and register with AgentRegistry
   * @param {Object} queueManagerService - QueueManagerService instance
   * @returns {Promise<Object>} Registration result
   */
  async initialize(queueManagerService) {
    try {
      logger.info('========================================');
      logger.info('  Agent Bootstrap - Self-Registration');
      logger.info('========================================');

      // Store reference to queue manager
      this.queueManager = queueManagerService;

      // Load configuration
      this.config = this.loadConfig();
      this.agentId = this.config.agentId;

      // Load persona if provided
      const persona = await this.loadPersona(this.config.personaFile);

      // Merge persona capabilities with env capabilities
      let finalCapabilities = [...this.config.capabilities];
      if (persona && persona.capabilities) {
        finalCapabilities = [...new Set([...finalCapabilities, ...persona.capabilities])];
      }

      // Override max_concurrent if persona specifies it
      let maxConcurrent = this.config.maxConcurrent;
      if (persona && persona.max_concurrent) {
        maxConcurrent = persona.max_concurrent;
      }

      // Determine this container's endpoint URL for HTTP dispatch
      // Uses container hostname (Docker DNS) or explicit env var
      const containerHostname = process.env.HOSTNAME || require('os').hostname();
      const containerPort = process.env.PORT || '5000';
      const endpointUrl = process.env.AGENT_ENDPOINT_URL || `http://${containerHostname}:${containerPort}`;

      // Extract external port for dashboard (from docker-compose port mapping)
      // Format: "3033:5000" means external 3033 maps to internal 5000
      // We need the external port for health dashboard
      //
      // ⭐ PHASE_15 FIX: Three-tier fallback for port resolution
      // 1. AGENT_EXTERNAL_PORT env var (set by static bots + fixed ComposeGenerator)
      // 2. PORT_MAPPING env var (legacy)
      // 3. KNOWN_AGENT_PORTS map — derive from agent name (covers dynamic bots)
      const KNOWN_AGENT_PORTS = {
        'project-manager': 3010, 'task-manager': 3011, 'worker-general': 3012,
        'code-reviewer': 3013, 'rca-specialist': 3014, 'presentation-bot': 3015,
        'documentation-bot': 3016, 'research-bot': 3017, 'devops-bot': 3018,
        'general-bot': 3019, 'agent-factory-bot': 3020, 'security-auditor-bot': 3021,
        'motivational-quotes-bot': 3022, 'daily-standup-summary-bot': 3023,
        'incident-response-bot': 3024, 'data-extraction-bot': 3025, 'email-bot': 3026,
        'video-bot': 3027, 'gcp-cli-bot': 3028, 'google-bot': 3029,
        'log-analyzer-bot': 3030, 'self-healing-bot': 3031, 'weather-bot': 3032,
        'facebook-bot': 3033, 'slack-bot': 3034, 'hephaestus': 3035,
        'news-aggregator-bot': 3036,
        // Maker/engineering bots — run on 3037-3044 (swarm-* service names in compose)
        '3d-printing-bot': 3037, 'physics-bot': 3038, 'small-motors-bot': 3039,
        'drives-specialist-bot': 3040, 'electrical-specialist-bot': 3041,
        'welding-specialist-bot': 3042, 'robotics-bot': 3043, 'animatronics-bot': 3044,
      };

      let externalPort = null;
      if (process.env.AGENT_EXTERNAL_PORT) {
        // Tier 1: Explicit env var (static bots + ComposeGenerator-deployed bots)
        externalPort = parseInt(process.env.AGENT_EXTERNAL_PORT);
      } else {
        // Tier 2: PORT_MAPPING env var (legacy)
        const portMapping = process.env.PORT_MAPPING || '';
        const match = portMapping.match(/^(\d+):/);
        if (match) {
          externalPort = parseInt(match[1]);
        }
      }

      // Tier 3: Known ports map (covers bots that don't have AGENT_EXTERNAL_PORT set)
      if (!externalPort && this.config && this.config.agentId) {
        externalPort = KNOWN_AGENT_PORTS[this.config.agentId] || null;
        if (externalPort) {
          logger.info(`  External port derived from known map: ${externalPort}`);
        }
      }

      if (externalPort) {
        logger.info(`  External port: ${externalPort} (for dashboard)`);
      } else {
        logger.warn(`  External port: unknown — agent will not appear in health dashboard with port link`);
        logger.warn(`  Fix: set AGENT_EXTERNAL_PORT env var in docker-compose for this bot`);
      }

      // Extract selector_descriptor for mesh broadcast network (Phase 1)
      const selectorDescriptor = (persona && persona.selector_descriptor) || '';
      if (selectorDescriptor) {
        logger.info(`  Selector descriptor: ${selectorDescriptor.substring(0, 80).trim()}...`);
      }

      // Register with AgentRegistry
      const registrationData = {
        agent_id: this.agentId,
        capabilities: finalCapabilities,
        workspaces: this.config.workspaces,
        status: 'idle',
        current_load: 0,
        max_concurrent: maxConcurrent,
        agent_scope: this.config.scope,
        success_rate: 1.0,
        endpoint: endpointUrl,
        port: externalPort, // External port for dashboard health checks
        routing_keywords: (persona && persona.routing_keywords) || [],
        selector_descriptor: selectorDescriptor,
        persona: persona ? {
          name: persona.name,
          role: persona.role,
          prompt: persona.persona_prompt,
        } : null,
      };

      logger.info('Registering with AgentRegistry...');
      const success = await this.queueManager.agentRegistry.register(registrationData);

      if (success) {
        this.registered = true;
        logger.info('========================================');
        logger.info(`✅ Agent registered: ${this.agentId}`);
        logger.info(`   Capabilities: ${finalCapabilities.join(', ')}`);
        logger.info(`   Workspaces: ${this.config.workspaces.join(', ')}`);
        logger.info(`   Status: Ready for work`);
        logger.info('========================================');

        // Start heartbeat to prevent TTL expiration (Redis keys have 1-hour TTL)
        // Heartbeat every 30 minutes = well within 1-hour TTL window
        this.startHeartbeat(30 * 60 * 1000);

        // Initialize AgentMemory (per-agent ChromaDB collection) — PHASE_52
        try {
          const redisClient = this.queueManager.redis || null;
          this.agentMemory = new AgentMemory(this.agentId, { redisClient });
          const memInitOk = await this.agentMemory.initialize();
          if (memInitOk) {
            logger.info(`✅ AgentMemory initialized for ${this.agentId}`);

            // Bootstrap knowledge from persona's knowledge_sources (if any)
            const knowledgeSources = (persona && persona.knowledge_sources) || [];
            // Also check AGENT_KNOWLEDGE_SOURCES env var (set by ProvisioningManager)
            const envKnowledge = process.env.AGENT_KNOWLEDGE_SOURCES;
            if (envKnowledge) {
              try {
                const parsed = JSON.parse(envKnowledge);
                if (Array.isArray(parsed)) knowledgeSources.push(...parsed);
              } catch (e) {
                // Not valid JSON, treat as comma-separated
                knowledgeSources.push(...envKnowledge.split(',').map(s => s.trim()).filter(Boolean));
              }
            }

            if (knowledgeSources.length > 0) {
              const bootstrapResult = await this.agentMemory.bootstrapKnowledge(knowledgeSources);
              logger.info(`AgentMemory bootstrap: ${JSON.stringify(bootstrapResult)}`);
            }
          } else {
            logger.warn(`AgentMemory init failed for ${this.agentId} — continuing without memory`);
            this.agentMemory = null;
          }
        } catch (memErr) {
          logger.warn(`AgentMemory error for ${this.agentId}: ${memErr.message} — continuing without memory`);
          this.agentMemory = null;
        }

        return {
          success: true,
          agentId: this.agentId,
          capabilities: finalCapabilities,
          message: 'Agent successfully registered',
        };
      } else {
        throw new Error('Registration returned false');
      }
    } catch (error) {
      logger.error('========================================');
      logger.error('❌ Agent registration failed');
      logger.error(`   Error: ${error.message}`);
      logger.error('   Continuing in degraded mode (non-swarm)');
      logger.error('========================================');

      return {
        success: false,
        error: error.message,
        message: 'Agent registration failed, operating in degraded mode',
      };
    }
  }

  /**
   * Graceful shutdown - deregister from AgentRegistry
   * @returns {Promise<boolean>} Success status
   */
  async shutdown() {
    if (!this.registered || !this.queueManager || !this.agentId) {
      logger.info('Agent not registered, skipping deregistration');
      return true;
    }

    try {
      logger.info(`Deregistering agent: ${this.agentId}`);
      
      const success = await this.queueManager.agentRegistry.unregister(this.agentId);
      
      if (success) {
        this.registered = false;
        logger.info(`✓ Agent deregistered: ${this.agentId}`);
        return true;
      } else {
        logger.warn(`Failed to deregister agent: ${this.agentId}`);
        return false;
      }
    } catch (error) {
      logger.error(`Deregistration error: ${error.message}`);
      return false;
    }
  }

  /**
   * Get current registration status
   * @returns {Object} Status information
   */
  getStatus() {
    return {
      registered: this.registered,
      agentId: this.agentId,
      config: this.config,
    };
  }

  /**
   * Send heartbeat to maintain registration.
   * If the key has expired (TTL lapsed), automatically re-registers.
   * @returns {Promise<boolean>} Success status
   */
  async heartbeat() {
    if (!this.registered || !this.queueManager || !this.agentId) {
      return false;
    }

    try {
      const success = await this.queueManager.agentRegistry.heartbeat(this.agentId);
      if (!success) {
        // Key expired — auto-re-register
        logger.warn(`Heartbeat: agent key expired for ${this.agentId}, re-registering...`);
        await this._reRegister();
      }
      return true;
    } catch (error) {
      logger.error(`Heartbeat error: ${error.message}`);
      // Attempt re-registration on any heartbeat error
      try {
        await this._reRegister();
        return true;
      } catch (reRegErr) {
        logger.error(`Re-registration also failed: ${reRegErr.message}`);
        return false;
      }
    }
  }

  /**
   * Re-register the agent using cached config (called when TTL expires)
   * @returns {Promise<void>}
   */
  async _reRegister() {
    if (!this.config || !this.queueManager) {
      throw new Error('Cannot re-register: no cached config or queueManager');
    }

    const containerHostname = process.env.HOSTNAME || require('os').hostname();
    const containerPort = process.env.PORT || '5000';
    const endpointUrl = process.env.AGENT_ENDPOINT_URL || `http://${containerHostname}:${containerPort}`;

    const registrationData = {
      agent_id: this.agentId,
      capabilities: this.config.capabilities,
      workspaces: this.config.workspaces,
      status: 'idle',
      current_load: 0,
      max_concurrent: this.config.maxConcurrent,
      agent_scope: this.config.scope,
      success_rate: 1.0,
      endpoint: endpointUrl,
    };

    const ok = await this.queueManager.agentRegistry.register(registrationData);
    if (ok) {
      logger.info(`✅ Agent re-registered after TTL expiry: ${this.agentId}`);
    } else {
      logger.error(`❌ Agent re-registration failed: ${this.agentId}`);
    }
  }

  /**
   * Start heartbeat interval — keeps agent registered by refreshing TTL.
   * If key has expired, automatically re-registers.
   * Default: every 5 minutes (well within 1-hour TTL)
   * @param {number} intervalMs - Heartbeat interval in milliseconds
   */
  startHeartbeat(intervalMs = 5 * 60 * 1000) {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(async () => {
      const success = await this.heartbeat();
      if (!success) {
        logger.warn(`Heartbeat failed for ${this.agentId} — will retry next interval`);
      }
    }, intervalMs);

    logger.info(`Heartbeat started (interval: ${Math.round(intervalMs / 1000)}s)`);
  }

  /**
   * Stop heartbeat interval
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      logger.info('Heartbeat stopped');
    }
  }
}

/**
 * @description Default export of the AgentBootstrap class so a container's startup
 * code can instantiate a single bootstrap instance to manage its swarm lifecycle.
 */
module.exports = AgentBootstrap;