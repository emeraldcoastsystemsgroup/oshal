/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * PersonaAutoDeployer — Auto-deploys agent-factory-created bots as Docker containers
 * 
 * REFACTORED: Now delegates to ComposeGenerator for compose-based deployment.
 * The old approach used `docker run` directly which missed network/volume configs.
 * The new approach uses ComposeGenerator to programmatically add services to
 * docker-compose.swarm-local.yml and runs `docker compose up -d` for consistency.
 * 
 * This bridges the gap between agent-factory creating persona YAMLs and
 * those bots actually running as containers in the swarm.
 */

const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');
const { execSync } = require('child_process');
const logger = require('../utils/logger');

/**
 * @description Bridges agent-factory persona generation and the live swarm by
 * ensuring every persona YAML in the bot-configs directory has a corresponding
 * running container. It exists because creating a persona file alone does not
 * make a bot run; this service closes that gap on startup, preferring the
 * compose-based path (correct network/volume/env inheritance) and degrading to
 * a direct `docker run` fallback only when the compose CLI is unavailable.
 */
class PersonaAutoDeployer {
  /**
   * @description Initializes runtime configuration from environment variables and
   * seeds the set of personas that are intentionally excluded from auto-deploy
   * because they already have dedicated, hardcoded containers in docker-compose.
   * Centralizing these defaults here keeps deployment behavior consistent and
   * environment-overridable without touching call sites.
   */
  constructor() {
    this.botConfigsDir = process.env.BOT_CONFIGS_DIR || '/app/bot-configs';
    this.networkName = process.env.SWARM_NETWORK || 'oshal_swarm-local';
    this.basePort = parseInt(process.env.AUTO_DEPLOY_BASE_PORT || '3030');
    this.deployed = [];
    
    // Known personas that are already hardcoded in docker-compose
    // These have dedicated containers and should NOT be auto-deployed
    this.hardcodedPersonas = new Set([
      'project-manager',
      'task-manager',
      'worker-general',
      'code-reviewer-bot',
      'rca-specialist-bot',
      'presentation-bot',
      'documentation-bot',
      'research-bot',
      'devops-bot',
      'everything-default',
      'agent-factory-bot',
      'task-manager-bot',  // legacy name
    ]);
  }

  /**
   * Run auto-deploy scan on startup.
   * REFACTORED: Delegates to ComposeGenerator when Docker + docker compose are available.
   * Falls back to legacy docker run approach if compose CLI is unavailable.
   * @returns {Promise<Object>} Deployment results
   */
  async initialize() {
    // Only run if Docker socket is available and we're in swarm mode
    if (!this._isDockerAvailable()) {
      logger.info('[PersonaAutoDeployer] Docker socket not available, skipping auto-deploy');
      return { deployed: [], skipped: 'no-docker' };
    }

    if (process.env.ENABLE_AGENT_SWARM !== 'true') {
      logger.info('[PersonaAutoDeployer] Not in swarm mode, skipping auto-deploy');
      return { deployed: [], skipped: 'not-swarm' };
    }

    // ═══════════════════════════════════════════════════════
    // NEW: Try ComposeGenerator-based deployment first
    // This uses docker compose (not docker run) for correct
    // network, volume, and env var inheritance from x-bot-common
    // ═══════════════════════════════════════════════════════
    try {
      const ComposeGenerator = require('./ComposeGenerator');
      const generator = new ComposeGenerator();
      
      if (generator.isComposeAvailable()) {
        logger.info('[PersonaAutoDeployer] Using ComposeGenerator for deployment (preferred)');
        const result = await generator.deployAllUndeployed();
        
        if (result.deployed && result.deployed.length > 0) {
          this.deployed = result.deployed.map(d => d.agentId);
        }
        
        return {
          deployed: this.deployed,
          total: result.deployed.length + result.errors.length,
          method: 'compose-generator',
          errors: result.errors,
        };
      }
      
      logger.info('[PersonaAutoDeployer] docker compose CLI not available, falling back to legacy docker run');
    } catch (composeErr) {
      logger.warn(`[PersonaAutoDeployer] ComposeGenerator failed, falling back to legacy: ${composeErr.message}`);
    }

    // ═══════════════════════════════════════════════════════
    // LEGACY FALLBACK: docker run approach (kept for backwards compatibility)
    // ═══════════════════════════════════════════════════════
    logger.info('========================================');
    logger.info('  PersonaAutoDeployer — Scanning (legacy mode)...');
    logger.info('========================================');

    try {
      // 1. Find all persona YAML files
      const personaFiles = await this._scanPersonaFiles();
      logger.info(`Found ${personaFiles.length} persona files`);

      // 2. Get running containers
      const runningContainers = this._getRunningContainers();
      logger.info(`Found ${runningContainers.length} running swarm containers`);

      // 3. Find personas without containers
      const undeployed = this._findUndeployedPersonas(personaFiles, runningContainers);
      
      if (undeployed.length === 0) {
        logger.info('[PersonaAutoDeployer] All personas have running containers ✅');
        return { deployed: [], message: 'all-deployed' };
      }

      logger.info(`[PersonaAutoDeployer] Found ${undeployed.length} undeployed personas:`);
      undeployed.forEach(p => logger.info(`  → ${p.name} (${p.file})`));

      // 4. Deploy each missing persona
      for (const persona of undeployed) {
        try {
          await this._deployPersona(persona);
          this.deployed.push(persona.name);
        } catch (err) {
          logger.error(`[PersonaAutoDeployer] Failed to deploy ${persona.name}: ${err.message}`);
        }
      }

      logger.info('========================================');
      logger.info(`  Auto-deployed: ${this.deployed.length}/${undeployed.length} bots`);
      this.deployed.forEach(name => logger.info(`  ✅ ${name}`));
      logger.info('========================================');

      return { deployed: this.deployed, total: undeployed.length };
    } catch (error) {
      logger.error(`[PersonaAutoDeployer] Scan failed: ${error.message}`);
      return { deployed: [], error: error.message };
    }
  }

  /**
   * Scan bot-configs directory for persona YAML files
   * @returns {Promise<Array>} Array of persona objects
   */
  async _scanPersonaFiles() {
    const personas = [];

    try {
      const entries = await fs.readdir(this.botConfigsDir);

      for (const entry of entries) {
        // Only process .yaml files, skip directories and non-yaml
        if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;

        const filepath = path.join(this.botConfigsDir, entry);
        const stat = await fs.stat(filepath);
        if (!stat.isFile()) continue;

        try {
          const content = await fs.readFile(filepath, 'utf8');
          const parsed = yaml.load(content);

          if (parsed && parsed.name) {
            // Derive the base name without extension for comparison
            const baseName = entry.replace(/\.(yaml|yml)$/, '');

            personas.push({
              name: parsed.name || baseName,
              agent_id: parsed.agent_id || parsed.name || baseName,
              role: parsed.role || 'General',
              capabilities: parsed.capabilities || ['general'],
              max_concurrent: parsed.max_concurrent || 3,
              scope: parsed.scope || 'shared',
              file: entry,
              filepath: filepath,
              baseName: baseName,
            });
          }
        } catch (parseErr) {
          logger.warn(`[PersonaAutoDeployer] Failed to parse ${entry}: ${parseErr.message}`);
        }
      }
    } catch (dirErr) {
      logger.warn(`[PersonaAutoDeployer] Cannot read ${this.botConfigsDir}: ${dirErr.message}`);
    }

    return personas;
  }

  /**
   * Get list of running swarm containers
   * @returns {string[]} Array of container names
   */
  _getRunningContainers() {
    try {
      const output = execSync(
        'docker ps --format "{{.Names}}" 2>/dev/null',
        { encoding: 'utf8', timeout: 10000 }
      );
      return output.trim().split('\n').filter(n => n.startsWith('swarm-'));
    } catch (err) {
      logger.warn(`[PersonaAutoDeployer] Cannot list containers: ${err.message}`);
      return [];
    }
  }

  /**
   * Find persona files that don't have running containers
   * @param {Array} personaFiles - All persona objects
   * @param {string[]} runningContainers - Running container names
   * @returns {Array} Undeployed persona objects
   */
  _findUndeployedPersonas(personaFiles, runningContainers) {
    const undeployed = [];

    // Build set of running agent IDs from container names
    // Container names follow pattern: swarm-{agent-id}
    const runningAgentIds = new Set(
      runningContainers.map(name => name.replace('swarm-', ''))
    );

    for (const persona of personaFiles) {
      // Skip hardcoded personas — they're in docker-compose already
      if (this.hardcodedPersonas.has(persona.baseName)) {
        continue;
      }

      // Check if this persona's agent ID has a running container
      const agentId = persona.agent_id;
      const containerName = `swarm-${agentId}`;

      // Check by both agent_id and baseName
      if (runningAgentIds.has(agentId) || 
          runningAgentIds.has(persona.baseName) ||
          runningContainers.includes(containerName)) {
        continue;
      }

      undeployed.push(persona);
    }

    return undeployed;
  }

  /**
   * Deploy a persona as a new Docker container
   * @param {Object} persona - Persona configuration
   * @returns {Promise<boolean>} Success
   */
  async _deployPersona(persona) {
    const containerName = `swarm-${persona.agent_id}`;
    const port = this._getNextAvailablePort();

    logger.info(`[PersonaAutoDeployer] Deploying ${persona.name} as ${containerName} on port ${port}...`);

    // Build the docker run command
    // Uses the same image as the current container (any-bot dev image)
    const envVars = this._buildEnvVars(persona, port);
    const volumes = this._buildVolumes();
    const network = this._getNetworkFlag();

    const cmd = [
      'docker run -d',
      `--name ${containerName}`,
      `--hostname ${containerName}`,
      `-p ${port}:5000`,
      network,
      ...envVars.map(e => `-e "${e}"`),
      ...volumes.map(v => `-v "${v}"`),
      '--restart unless-stopped',
      `--health-cmd "curl -f http://localhost:5000/api/health || exit 1"`,
      `--health-interval 30s`,
      `--health-timeout 10s`,
      `--health-retries 3`,
      `--health-start-period 60s`,
      this._getDockerImage(),
      'npm run dev',
    ].join(' \\\n  ');

    try {
      logger.info(`[PersonaAutoDeployer] Running: docker run --name ${containerName} ...`);
      const output = execSync(cmd, { encoding: 'utf8', timeout: 60000 });
      const containerId = output.trim().substring(0, 12);
      logger.info(`[PersonaAutoDeployer] ✅ ${persona.name} deployed: ${containerId} on port ${port}`);
      return true;
    } catch (err) {
      // If container already exists (stopped), remove and retry
      if (err.message.includes('already in use')) {
        logger.info(`[PersonaAutoDeployer] Removing stopped container ${containerName}...`);
        try {
          execSync(`docker rm -f ${containerName}`, { encoding: 'utf8', timeout: 10000 });
          const output = execSync(cmd, { encoding: 'utf8', timeout: 60000 });
          const containerId = output.trim().substring(0, 12);
          logger.info(`[PersonaAutoDeployer] ✅ ${persona.name} re-deployed: ${containerId}`);
          return true;
        } catch (retryErr) {
          throw retryErr;
        }
      }
      throw err;
    }
  }

  /**
   * Build environment variables for the new container
   * @param {Object} persona - Persona configuration
   * @param {number} port - Host port
   * @returns {string[]} Array of KEY=VALUE strings
   */
  _buildEnvVars(persona, port) {
    // Core env vars — inherit from current process where possible
    return [
      `ENABLE_AGENT_SWARM=true`,
      `AGENT_ID=${persona.agent_id}`,
      `AGENT_CAPABILITIES=${persona.capabilities.join(',')}`,
      `AGENT_MAX_CONCURRENT=${persona.max_concurrent}`,
      `AGENT_SCOPE=${persona.scope}`,
      `BOT_PERSONA_FILE=/app/bot-configs/${persona.file}`,
      `NODE_ENV=development`,
      `PORT=5000`,
      `LOG_LEVEL=info`,
      `TENANT_ID=swarm`,
      `TENANT_NAME=Agent Swarm`,
      `ENABLE_QUEUE_MANAGER=true`,
      `QUEUE_MANAGER_POLL_INTERVAL=60000`,
      // Redis
      `REDIS_HOST=${process.env.REDIS_HOST || 'redis'}`,
      `REDIS_PORT=${process.env.REDIS_PORT || '6379'}`,
      // ChromaDB
      `CHROMADB_HOST=${process.env.CHROMADB_HOST || 'chromadb'}`,
      `CHROMADB_PORT=${process.env.CHROMADB_PORT || '8000'}`,
      // RAG
      `RAG_SERVICE_URL=${process.env.RAG_SERVICE_URL || 'http://rag-service:8000'}`,
      // Presentron
      `PRESENTRON_API_URL=${process.env.PRESENTRON_API_URL || 'http://presentron:80/api/v1/ppt'}`,
      // MCP Servers
      `ENABLE_PRESENTRON_MCP=${process.env.ENABLE_PRESENTRON_MCP || 'true'}`,
      `PRESENTRON_MCP_HOST=${process.env.PRESENTRON_MCP_HOST || 'presentron-mcp'}`,
      `PRESENTRON_MCP_PORT=${process.env.PRESENTRON_MCP_PORT || '8080'}`,
      `ENABLE_CHROMA_MCP=${process.env.ENABLE_CHROMA_MCP || 'true'}`,
      `CHROMA_MCP_HOST=${process.env.CHROMA_MCP_HOST || 'chroma-mcp'}`,
      `CHROMA_MCP_PORT=${process.env.CHROMA_MCP_PORT || '8082'}`,
      // Plane
      `ENABLE_PLANE_MCP=${process.env.ENABLE_PLANE_MCP || 'true'}`,
      `PLANE_API_KEY=${process.env.PLANE_API_KEY || ''}`,
      `PLANE_BASE_URL=${process.env.PLANE_BASE_URL || 'http://plane-proxy-1:80'}`,
      `PLANE_WORKSPACE_SLUG=${process.env.PLANE_WORKSPACE_SLUG || 'devopscloud-00'}`,
      `USE_PLANE=${process.env.USE_PLANE || 'true'}`,
      `PLANE_PROJECT=${process.env.PLANE_PROJECT || 'agent-swarm'}`,
      // LLM - pass through from current environment
      `AZURE_ENDPOINT=${process.env.AZURE_ENDPOINT || ''}`,
      `AZURE_OPENAI_API_KEY=${process.env.AZURE_OPENAI_API_KEY || ''}`,
      `DEPLOYMENT_NAME=${process.env.DEPLOYMENT_NAME || 'gpt-4o'}`,
    ];
  }

  /**
   * Build volume mounts matching the docker-compose pattern
   * @returns {string[]} Array of volume mount strings
   */
  _buildVolumes() {
    // Detect if we're running inside Docker or on the host
    const isDocker = this._isRunningInDocker();
    
    if (isDocker) {
      // Inside Docker — use named volumes and bind mounts from compose
      return [
        // Source code and configs are typically bind-mounted from host
        // We need the same volumes as other swarm containers
        // The bot-configs are mounted read-only
      ];
    }

    // On host — use absolute paths
    return [];
  }

  /**
   * Get the Docker network flag
   * @returns {string} Network flag for docker run
   */
  _getNetworkFlag() {
    // Try to detect the actual network name
    try {
      const networks = execSync(
        'docker network ls --format "{{.Name}}" 2>/dev/null',
        { encoding: 'utf8', timeout: 5000 }
      );
      const networkList = networks.trim().split('\n');
      
      // Look for swarm network
      const swarmNet = networkList.find(n => 
        n.includes('swarm-local') || n.includes('swarm-network')
      );
      
      if (swarmNet) {
        return `--network ${swarmNet}`;
      }
    } catch (e) {
      // ignore
    }

    return `--network ${this.networkName}`;
  }

  /**
   * Get the Docker image to use for new bot containers
   * Uses the same image as the current container
   * @returns {string} Docker image name
   */
  _getDockerImage() {
    // Try to detect our own image
    try {
      const hostname = require('os').hostname();
      const output = execSync(
        `docker inspect --format "{{.Config.Image}}" ${hostname} 2>/dev/null`,
        { encoding: 'utf8', timeout: 5000 }
      );
      const image = output.trim();
      if (image) return image;
    } catch (e) {
      // ignore
    }

    // Fallback: use the compose project image
    // In swarm-local, all bots use oshal-any-bot-dev image
    try {
      const output = execSync(
        'docker inspect --format "{{.Config.Image}}" swarm-project-manager 2>/dev/null',
        { encoding: 'utf8', timeout: 5000 }
      );
      const image = output.trim();
      if (image) return image;
    } catch (e) {
      // ignore
    }

    return 'oshal-any-bot-dev:latest';
  }

  /**
   * Get next available port for auto-deployed containers
   * Starts at basePort and increments
   * @returns {number} Available port
   */
  _getNextAvailablePort() {
    const usedPorts = new Set();

    try {
      const output = execSync(
        'docker ps --format "{{.Ports}}" 2>/dev/null',
        { encoding: 'utf8', timeout: 5000 }
      );

      // Parse port mappings like "0.0.0.0:3010->5000/tcp"
      const portRegex = /0\.0\.0\.0:(\d+)->/g;
      let match;
      while ((match = portRegex.exec(output)) !== null) {
        usedPorts.add(parseInt(match[1]));
      }
    } catch (e) {
      // ignore
    }

    // Find next available port starting from basePort
    let port = this.basePort;
    while (usedPorts.has(port)) {
      port++;
    }

    // Update basePort for next call
    this.basePort = port + 1;
    return port;
  }

  /**
   * Check if Docker socket is available
   * @returns {boolean}
   */
  _isDockerAvailable() {
    try {
      execSync('docker info 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Check if we're running inside a Docker container
   * @returns {boolean}
   */
  _isRunningInDocker() {
    try {
      const cgroup = require('fs').readFileSync('/proc/1/cgroup', 'utf8');
      return cgroup.includes('docker') || cgroup.includes('containerd');
    } catch (e) {
      // /proc/1/cgroup doesn't exist on macOS
      return false;
    }
  }

  /**
   * Get deployment status
   * @returns {Object} Status info
   */
  getStatus() {
    return {
      deployed: this.deployed,
      count: this.deployed.length,
      botConfigsDir: this.botConfigsDir,
      basePort: this.basePort,
    };
  }
}

module.exports = PersonaAutoDeployer;
