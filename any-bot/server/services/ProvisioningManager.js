/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pre-OSS: genericized internal example paths in JSDoc (removed internal username)
 */

/**
 * ProvisioningManager — Level 2 Custom Agent Provisioning
 * 
 * Watches for provision-manifest.json files in agent workspaces,
 * builds custom Docker images with agent-specific dependencies,
 * and deploys them as containers on the swarm network.
 * 
 * Level 1 (PersonaAutoDeployer): Same base image, different YAML config
 * Level 2 (ProvisioningManager): Custom Docker images with:
 * - Custom Dockerfile support (npm install additional packages)
 * - provision-manifest.json contract with full schema validation
 * - Volume mounts for credentials (GCP service accounts, etc.)
 * - Custom MCP tool registration
 * - Health check polling until container is healthy
 * - Direct AgentRegistry registration (not just verification)
 * - Mesh broadcast network integration (selector_descriptor)
 * - Deprovision support (stop + remove container + deregister)
 * - API trigger for on-demand provisioning
 * 
 * PHASE_10: ProvisioningManager — Custom Agent Provisioning (Issue #007)
 */

const fs = require('fs').promises;
const path = require('path');
const { execSync, exec } = require('child_process');
const logger = require('../utils/logger');

class ProvisioningManager {
  constructor(options = {}) {
    this.workspaceRoot = options.workspaceRoot || process.env.WORKSPACE_ROOT || '/app/workspace';
    this.networkName = options.networkName || process.env.SWARM_NETWORK || 'oshal_default';
    this.basePort = parseInt(options.basePort || process.env.PM_BASE_PORT || '3050');
    this.agentRegistry = options.agentRegistry || null;
    this.redisClient = options.redisClient || null;

    // State tracking
    this.provisioned = new Map(); // agent_id -> { containerId, port, status, manifest }
    this.buildQueue = [];
    this.isProcessing = false;
    this.scanInterval = null;

    // Scan interval: how often to check for new manifests (default 2 min)
    this.scanIntervalMs = parseInt(process.env.PM_SCAN_INTERVAL || '120000');

    // Build timeout: max time for docker build (default 5 min)
    this.buildTimeout = parseInt(process.env.PM_BUILD_TIMEOUT || '300000');

    // ═══════════════════════════════════════════════════════════════
    // PHASE_23 FIX (Issue #016): Compose-defined bots that must NOT
    // be re-deployed by ProvisioningManager. These bots are managed
    // by docker-compose.swarm-local.yml with fixed port mappings.
    // ProvisioningManager was destroying their containers with
    // `docker rm -f` and re-deploying with dynamic ports, causing
    // port conflicts and dashboard visibility issues.
    // ═══════════════════════════════════════════════════════════════
    this.composeDefinedBots = new Set([
      'project-manager', 'task-manager', 'worker-general',
      'code-reviewer', 'rca-specialist', 'presentation-bot',
      'documentation-bot', 'research-bot', 'devops-bot',
      'general-bot', 'agent-factory-bot', 'security-auditor-bot',
      'motivational-quotes-bot', 'daily-standup-summary-bot',
      'incident-response-bot', 'data-extraction-bot', 'email-bot',
      'video-bot', 'gcp-cli-bot', 'google-bot',
      'log-analyzer-bot', 'self-healing-bot', 'weather-bot',
    ]);
  }

  /**
   * Initialize the ProvisioningManager.
   * Performs initial scan and starts periodic scanning.
   * @returns {Promise<Object>} Initialization result
   */
  async initialize() {
    if (!this._isDockerAvailable()) {
      logger.info('[ProvisioningManager] Docker socket not available, running in read-only mode');
      return { status: 'read-only', reason: 'no-docker' };
    }

    logger.info('========================================');
    logger.info('  ProvisioningManager — Starting...');
    logger.info(`  Workspace root: ${this.workspaceRoot}`);
    logger.info(`  Network: ${this.networkName}`);
    logger.info(`  Scan interval: ${this.scanIntervalMs / 1000}s`);
    logger.info('========================================');

    // Initial scan
    const result = await this.scanAndProvision();

    // Start periodic scanning
    this.scanInterval = setInterval(async () => {
      try {
        await this.scanAndProvision();
      } catch (error) {
        logger.error(`[ProvisioningManager] Periodic scan error: ${error.message}`);
      }
    }, this.scanIntervalMs);

    return result;
  }

  /**
   * Scan workspace directories for provision-manifest.json files
   * and provision any undeployed agents.
   * @returns {Promise<Object>} Scan results
   */
  async scanAndProvision() {
    try {
      const manifests = await this._findManifests();
      
      if (manifests.length === 0) {
        return { found: 0, provisioned: 0 };
      }

      logger.info(`[ProvisioningManager] Found ${manifests.length} manifests`);

      let newProvisioned = 0;

      for (const manifest of manifests) {
        // Skip if already provisioned and healthy
        if (this.provisioned.has(manifest.agent_id)) {
          const existing = this.provisioned.get(manifest.agent_id);
          if (existing.status === 'running') continue;
        }

        try {
          const result = await this.provisionAgent(manifest);
          if (result.success) newProvisioned++;
        } catch (error) {
          logger.error(`[ProvisioningManager] Failed to provision ${manifest.agent_id}: ${error.message}`);
        }
      }

      return { found: manifests.length, provisioned: newProvisioned };
    } catch (error) {
      logger.error(`[ProvisioningManager] Scan failed: ${error.message}`);
      return { found: 0, provisioned: 0, error: error.message };
    }
  }

  /**
   * Provision a single agent from its manifest.
   * @param {Object} manifest - Parsed provision-manifest.json
   * @returns {Promise<Object>} Provisioning result
   */
  async provisionAgent(manifest) {
    const agentId = manifest.agent_id;
    const containerName = `swarm-${agentId}`;

    // ═══════════════════════════════════════════════════════════════
    // PHASE_23 FIX (Issue #016): Skip compose-defined bots.
    // These are managed by docker-compose.swarm-local.yml and must
    // NOT be re-deployed by ProvisioningManager (which would destroy
    // the compose container with `docker rm -f` and recreate it on a
    // random dynamic port, breaking the health dashboard).
    // ═══════════════════════════════════════════════════════════════
    if (this.composeDefinedBots.has(agentId)) {
      logger.info(`[ProvisioningManager] ⏭️  SKIPPING ${agentId} — compose-defined bot (managed by docker-compose.swarm-local.yml)`);
      return { success: false, agentId, error: 'compose-defined-bot', skipped: true };
    }

    logger.info(`[ProvisioningManager] Provisioning ${agentId}...`);

    // Validate manifest
    const validation = this.validateManifest(manifest);
    if (!validation.valid) {
      logger.error(`[ProvisioningManager] Invalid manifest for ${agentId}: ${validation.errors.join(', ')}`);
      return { success: false, error: 'invalid-manifest', details: validation.errors };
    }

    try {
      let imageName;

      if (manifest.image_type === 'custom' && manifest.dockerfile) {
        // Build custom image
        imageName = await this._buildCustomImage(manifest);
      } else {
        // Use base image (same as PersonaAutoDeployer)
        imageName = this._getBaseImage();
      }

      // Deploy container
      const port = this._getNextAvailablePort();
      const containerId = await this._deployContainer(manifest, imageName, containerName, port);

      // Wait for health check
      const healthy = await this._waitForHealthy(containerName, manifest.health_check || '/api/health');

      // Level 2: Direct AgentRegistry registration from ProvisioningManager
      // Instead of just verifying, we register the agent directly with full manifest metadata
      let registered = false;
      if (healthy && this.agentRegistry) {
        registered = await this._registerAgent(manifest, containerName, port);
        // Fallback: if direct registration fails, wait for self-registration via AgentBootstrap
        if (!registered) {
          logger.info(`[ProvisioningManager] Direct registration failed, waiting for self-registration...`);
          registered = await this._verifyRegistration(agentId);
        }
      }

      // Track provisioned agent
      this.provisioned.set(agentId, {
        containerId,
        containerName,
        port,
        imageName,
        status: healthy ? 'running' : 'unhealthy',
        registered,
        provisionedAt: new Date().toISOString(),
        manifest,
      });

      // Register with health dashboard dynamic nodes (so it appears on the ops cockpit)
      try {
        const http = require('http');
        const dashboardData = JSON.stringify({
          name: containerName,
          port: port,
          emoji: '🤖',
          type: 'agent',
          category: 'agent',
        });
        // Register on primary any-bot (:3000 via host) for dashboard visibility
        const dashReq = http.request({
          hostname: 'host.docker.internal',
          port: 3000,
          path: '/api/health-dashboard/nodes',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dashboardData) },
          timeout: 3000,
        }, () => {});
        dashReq.on('error', () => {});
        dashReq.write(dashboardData);
        dashReq.end();

        // Also register in service-map so proxy-health can reach this port
        const smData = JSON.stringify({ port: port, hostname: 'host.docker.internal' });
        const smReq = http.request({
          hostname: 'host.docker.internal',
          port: 3000,
          path: '/api/service-map/register',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(smData) },
          timeout: 3000,
        }, () => {});
        smReq.on('error', () => {});
        smReq.write(smData);
        smReq.end();

        logger.info(`[ProvisioningManager] Registered ${agentId} with health dashboard + service-map (port ${port})`);
      } catch (e) { /* non-fatal */ }

      // ═══════════════════════════════════════════════════════════
      // PHASE_16: Auto-register config schema from manifest
      // If the manifest includes config_schema, register it via the
      // AgentConfigManager API so the config UI shows proper fields
      // without any manual PUT /api/agents/{id}/config call.
      // ═══════════════════════════════════════════════════════════
      if (manifest.config_schema && this.redisClient) {
        try {
          const AgentConfigManager = require('./AgentConfigManager');
          const configManager = new AgentConfigManager({ redisClient: this.redisClient });
          await configManager.initialize();

          // config_schema should have { fields: [...] } or be the full schema object
          const schemaPayload = manifest.config_schema.fields
            ? { schema: manifest.config_schema }
            : { schema: { fields: manifest.config_schema } };

          await configManager.setConfig(agentId, schemaPayload);
          logger.info(`[ProvisioningManager] ✅ Config schema auto-registered for ${agentId} (${(manifest.config_schema.fields || manifest.config_schema).length} fields)`);
        } catch (configErr) {
          logger.warn(`[ProvisioningManager] Config schema registration failed for ${agentId}: ${configErr.message}`);
        }
      }

      logger.info(`[ProvisioningManager] ✅ ${agentId} provisioned: ${containerName} on port ${port} (healthy: ${healthy}, registered: ${registered})`);

      return {
        success: true,
        agentId,
        containerName,
        containerId,
        port,
        healthy,
        registered,
      };
    } catch (error) {
      logger.error(`[ProvisioningManager] Provisioning failed for ${agentId}: ${error.message}`);
      
      this.provisioned.set(agentId, {
        status: 'failed',
        error: error.message,
        failedAt: new Date().toISOString(),
        manifest,
      });

      return { success: false, agentId, error: error.message };
    }
  }

  /**
   * Validate a provision-manifest.json object.
   * @param {Object} manifest - Manifest to validate
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  validateManifest(manifest) {
    const errors = [];

    if (!manifest) {
      return { valid: false, errors: ['Manifest is null or undefined'] };
    }

    if (!manifest.agent_id || typeof manifest.agent_id !== 'string') {
      errors.push('agent_id is required and must be a string');
    }

    if (manifest.agent_id && !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(manifest.agent_id)) {
      errors.push('agent_id must be lowercase alphanumeric with hyphens (no leading/trailing hyphens)');
    }

    if (!manifest.version || typeof manifest.version !== 'string') {
      errors.push('version is required (e.g., "1.0")');
    }

    const validImageTypes = ['base', 'custom'];
    if (manifest.image_type && !validImageTypes.includes(manifest.image_type)) {
      errors.push(`image_type must be one of: ${validImageTypes.join(', ')}`);
    }

    if (manifest.image_type === 'custom') {
      if (!manifest.base_image) {
        errors.push('base_image is required for custom image_type');
      }
    }

    if (manifest.max_concurrent !== undefined && manifest.max_concurrent !== null && (typeof manifest.max_concurrent !== 'number' || manifest.max_concurrent < 1)) {
      errors.push('max_concurrent must be a positive number');
    }

    if (manifest.capabilities && !Array.isArray(manifest.capabilities)) {
      errors.push('capabilities must be an array');
    }

    if (manifest.knowledge_sources && !Array.isArray(manifest.knowledge_sources)) {
      errors.push('knowledge_sources must be an array');
    }

    // Level 2: Enhanced validation
    if (manifest.volumes && !Array.isArray(manifest.volumes)) {
      errors.push('volumes must be an array of volume mount strings (e.g., "/host/path:/container/path:ro")');
    }

    if (manifest.mcp_tools && !Array.isArray(manifest.mcp_tools)) {
      errors.push('mcp_tools must be an array of MCP tool definitions');
    }

    if (manifest.npm_dependencies && !Array.isArray(manifest.npm_dependencies)) {
      errors.push('npm_dependencies must be an array of package names');
    }

    if (manifest.ports) {
      if (typeof manifest.ports !== 'object') {
        errors.push('ports must be an object with internal/external fields');
      } else {
        if (manifest.ports.internal && typeof manifest.ports.internal !== 'number') {
          errors.push('ports.internal must be a number');
        }
        if (manifest.ports.external && manifest.ports.external !== 'auto' && typeof manifest.ports.external !== 'number') {
          errors.push('ports.external must be a number or "auto"');
        }
      }
    }

    if (manifest.selector_descriptor && typeof manifest.selector_descriptor !== 'string') {
      errors.push('selector_descriptor must be a string describing when to route to this agent');
    }

    if (manifest.health_check && typeof manifest.health_check !== 'string') {
      errors.push('health_check must be a string path (e.g., "/api/health")');
    }

    if (manifest.network && typeof manifest.network !== 'string') {
      errors.push('network must be a string (Docker network name)');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get provisioning status for all agents.
   * @returns {Object} Status summary
   */
  getStatus() {
    const agents = {};
    for (const [agentId, info] of this.provisioned) {
      agents[agentId] = {
        status: info.status,
        containerName: info.containerName,
        port: info.port,
        registered: info.registered,
        provisionedAt: info.provisionedAt,
        error: info.error,
      };
    }

    return {
      total: this.provisioned.size,
      running: Array.from(this.provisioned.values()).filter(a => a.status === 'running').length,
      failed: Array.from(this.provisioned.values()).filter(a => a.status === 'failed').length,
      agents,
      workspaceRoot: this.workspaceRoot,
      scanIntervalMs: this.scanIntervalMs,
    };
  }

  /**
   * Stop the ProvisioningManager.
   */
  shutdown() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
      logger.info('[ProvisioningManager] Stopped periodic scanning');
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────

  /**
   * Find all provision-manifest.json files in workspace subdirectories.
   * @returns {Promise<Array>} Array of parsed manifest objects with _dir field
   */
  async _findManifests() {
    const manifests = [];

    try {
      const entries = await fs.readdir(this.workspaceRoot, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const manifestPath = path.join(this.workspaceRoot, entry.name, 'provision-manifest.json');

        try {
          const content = await fs.readFile(manifestPath, 'utf8');
          const manifest = JSON.parse(content);
          manifest._dir = path.join(this.workspaceRoot, entry.name);
          manifest._manifestPath = manifestPath;
          manifests.push(manifest);
        } catch (readErr) {
          // No manifest in this directory — that's fine
          if (readErr.code !== 'ENOENT') {
            logger.debug(`[ProvisioningManager] Error reading ${manifestPath}: ${readErr.message}`);
          }
        }
      }
    } catch (dirErr) {
      logger.warn(`[ProvisioningManager] Cannot read workspace root ${this.workspaceRoot}: ${dirErr.message}`);
    }

    return manifests;
  }

  /**
   * Build a custom Docker image from the manifest's build context.
   * @param {Object} manifest - Agent manifest
   * @returns {Promise<string>} Built image name
   */
  async _buildCustomImage(manifest) {
    const agentId = manifest.agent_id;
    const imageName = `swarm-${agentId}:latest`;
    const buildContext = manifest._dir || '.';
    const dockerfile = manifest.dockerfile || 'Dockerfile';
    const dockerfilePath = path.join(buildContext, dockerfile);

    // Check if Dockerfile exists
    try {
      await fs.access(dockerfilePath);
    } catch (e) {
      // No custom Dockerfile — generate one
      logger.info(`[ProvisioningManager] No Dockerfile found, generating one for ${agentId}`);
      await this._generateDockerfile(manifest, dockerfilePath);
    }

    logger.info(`[ProvisioningManager] Building custom image: ${imageName} from ${buildContext}`);

    try {
      const cmd = `docker build -t ${imageName} -f ${dockerfilePath} ${buildContext}`;
      execSync(cmd, { 
        encoding: 'utf8', 
        timeout: this.buildTimeout,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      logger.info(`[ProvisioningManager] ✅ Custom image built: ${imageName}`);
      return imageName;
    } catch (error) {
      logger.error(`[ProvisioningManager] Build failed for ${agentId}: ${error.message}`);
      throw new Error(`Docker build failed: ${error.message}`);
    }
  }

  /**
   * Generate a Dockerfile for custom agents.
   * @param {Object} manifest - Agent manifest
   * @param {string} dockerfilePath - Path to write Dockerfile
   */
  async _generateDockerfile(manifest, dockerfilePath) {
    const baseImage = manifest.base_image || 'oshal-any-bot:latest';
    const deps = manifest.npm_dependencies || [];

    let dockerfile = `FROM ${baseImage}\n\n`;
    dockerfile += `# Auto-generated by ProvisioningManager for ${manifest.agent_id}\n`;
    dockerfile += `LABEL agent_id="${manifest.agent_id}"\n`;
    dockerfile += `LABEL provisioned_by="ProvisioningManager"\n\n`;

    if (deps.length > 0) {
      dockerfile += `# Install custom dependencies\n`;
      dockerfile += `RUN npm install ${deps.join(' ')} --save\n\n`;
    }

    dockerfile += `# Copy any custom tools or configs\n`;
    dockerfile += `COPY . /app/agent-extras/\n\n`;

    // Ensure Cline CLI auth setup runs on startup (same as compose-deployed bots)
    dockerfile += `# Setup entrypoint with Cline auth (matches compose-deployed bots)\n`;
    dockerfile += `CMD ["/bin/sh", "-c", "/app/scripts/setup-cline-auth.sh 2>/dev/null; exec node server/app.js"]\n`;

    await fs.writeFile(dockerfilePath, dockerfile, 'utf8');
    logger.info(`[ProvisioningManager] Generated Dockerfile at ${dockerfilePath}`);
  }

  /**
   * Deploy a container from an image.
   * @param {Object} manifest - Agent manifest
   * @param {string} imageName - Docker image name
   * @param {string} containerName - Container name
   * @param {number} port - Host port
   * @returns {Promise<string>} Container ID
   */
  async _deployContainer(manifest, imageName, containerName, port) {
    // Remove existing container if present
    try {
      execSync(`docker rm -f ${containerName} 2>/dev/null`, { encoding: 'utf8', timeout: 10000 });
    } catch (e) {
      // Container doesn't exist — fine
    }

    const envVars = this._buildEnvVars(manifest, port);
    const network = manifest.network ? `--network ${manifest.network}` : this._getNetworkFlag();
    const volumeMounts = this._buildVolumeMounts(manifest);
    const internalPort = (manifest.ports && manifest.ports.internal) || 5000;
    const healthPath = manifest.health_check || '/api/health';

    // Level 2: Add selector_descriptor as env var for mesh broadcast integration
    if (manifest.selector_descriptor) {
      envVars.push(`AGENT_SELECTOR_DESCRIPTOR=${manifest.selector_descriptor}`);
    }

    // Level 2: Add MCP tool definitions as env var
    if (manifest.mcp_tools && manifest.mcp_tools.length > 0) {
      envVars.push(`AGENT_MCP_TOOLS=${JSON.stringify(manifest.mcp_tools)}`);
    }

    // Level 2: Pass endpoint URL for AgentRegistry
    envVars.push(`AGENT_ENDPOINT_URL=http://${containerName}:${internalPort}`);

    // Write env vars to a temporary file to avoid shell quoting issues with JSON values
    const envFilePath = path.join(manifest._dir || '/tmp', `.env.${containerName}`);
    const envFileContent = envVars.join('\n') + '\n';
    await fs.writeFile(envFilePath, envFileContent, 'utf8');

    const cmd = [
      'docker run -d',
      `--name ${containerName}`,
      `--hostname ${containerName}`,
      `-p ${port}:${internalPort}`,
      network,
      `--env-file ${envFilePath}`,
      ...volumeMounts.map(v => `-v "${v}"`),
      '--restart unless-stopped',
      `--health-cmd "curl -f http://localhost:${internalPort}${healthPath} || exit 1"`,
      '--health-interval 30s',
      '--health-timeout 10s',
      '--health-retries 3',
      '--health-start-period 60s',
      imageName,
    ].join(' \\\n  ');

    try {
      const output = execSync(cmd, { encoding: 'utf8', timeout: 60000 });
      // Clean up env file after successful run
      try { await fs.unlink(envFilePath); } catch (e) { /* ignore */ }
      return output.trim().substring(0, 12);
    } catch (error) {
      // Clean up env file on failure too
      try { await fs.unlink(envFilePath); } catch (e) { /* ignore */ }
      throw new Error(`Docker run failed: ${error.message}`);
    }
  }

  /**
   * Build environment variables for the container.
   * @param {Object} manifest - Agent manifest
   * @param {number} port - Host port
   * @returns {string[]} Array of KEY=VALUE strings
   */
  _buildEnvVars(manifest, port) {
    const envOverrides = manifest.env_overrides || {};

    const vars = [
      `ENABLE_AGENT_SWARM=true`,
      `AGENT_ID=${manifest.agent_id}`,
      `AGENT_CAPABILITIES=${(manifest.capabilities || ['general']).join(',')}`,
      `AGENT_MAX_CONCURRENT=${manifest.max_concurrent || 3}`,
      `AGENT_SCOPE=shared`,
      `AGENT_EXTERNAL_PORT=${port}`,
      `AGENT_ENDPOINT_URL=http://swarm-${manifest.agent_id}:5000`,
      `NODE_ENV=development`,
      `PORT=5000`,
      `LOG_LEVEL=info`,
      `TENANT_ID=swarm`,
      `TENANT_NAME=Agent Swarm`,
      `ENABLE_QUEUE_MANAGER=false`,
      `QUEUE_MANAGER_POLL_INTERVAL=60000`,
      // Redis — use oshal-redis (Docker Compose service name), not 'redis'
      `REDIS_HOST=${process.env.REDIS_HOST || 'oshal-redis'}`,
      `REDIS_PORT=${process.env.REDIS_PORT || '6379'}`,
      // ChromaDB — use host.docker.internal since swarm-chromadb may not be on same network
      `CHROMADB_HOST=${process.env.CHROMADB_HOST || 'host.docker.internal'}`,
      `CHROMADB_PORT=${process.env.CHROMADB_PORT || '8000'}`,
      // RAG
      `RAG_SERVICE_URL=${process.env.RAG_SERVICE_URL || 'http://swarm-rag-service:8000'}`,
      // MCP Servers
      `ENABLE_CHROMA_MCP=${process.env.ENABLE_CHROMA_MCP || 'true'}`,
      `CHROMA_MCP_HOST=${process.env.CHROMA_MCP_HOST || 'chroma-mcp'}`,
      `CHROMA_MCP_PORT=${process.env.CHROMA_MCP_PORT || '8082'}`,
      // Plane
      `PLANE_API_KEY=${process.env.PLANE_API_KEY || ''}`,
      `PLANE_BASE_URL=${process.env.PLANE_BASE_URL || 'http://plane-proxy-1:80'}`,
      `PLANE_WORKSPACE_SLUG=${process.env.PLANE_WORKSPACE_SLUG || 'devopscloud-00'}`,
      `USE_PLANE=${process.env.USE_PLANE || 'true'}`,
      `PLANE_PROJECT=${process.env.PLANE_PROJECT || 'agent-swarm'}`,
      // Plane DB (for QueueManager ticket processing)
      `PLANE_DB_HOST=${process.env.PLANE_DB_HOST || 'host.docker.internal'}`,
      `PLANE_DB_PORT=${process.env.PLANE_DB_PORT || '5433'}`,
      `PLANE_DB_NAME=${process.env.PLANE_DB_NAME || 'plane'}`,
      `PLANE_DB_USER=${process.env.PLANE_DB_USER || 'plane'}`,
      `PLANE_DB_PASSWORD=${process.env.PLANE_DB_PASSWORD || 'plane'}`,
      // AWS credentials (inherited from parent — required for Bedrock LLM)
      `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID || ''}`,
      `AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY || ''}`,
      `AWS_REGION=${process.env.AWS_REGION || 'us-gov-west-1'}`,
      `AWS_DEFAULT_REGION=${process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || 'us-gov-west-1'}`,
      // LLM config (inherited from parent)
      `LLM_PROVIDER=${process.env.LLM_PROVIDER || 'cline-cli'}`,
      `DEPLOYMENT_NAME=${process.env.DEPLOYMENT_NAME || 'gpt-4o'}`,
      `AZURE_ENDPOINT=${process.env.AZURE_ENDPOINT || ''}`,
      `AZURE_OPENAI_API_KEY=${process.env.AZURE_OPENAI_API_KEY || ''}`,
      // Disable stdio MCP servers on provisioned bots — they require npx binaries
      // that aren't available in provisioned containers. HTTP MCP servers still work.
      `ENABLE_STDIO_MCP_SERVERS=false`,
    ];

    // If manifest specifies a persona file
    if (manifest.persona_file) {
      vars.push(`BOT_PERSONA_FILE=${manifest.persona_file}`);
    } else {
      // Auto-detect: check if a matching persona YAML exists in bot-configs
      // The bot-configs volume is mounted at /app/bot-configs/ (from ai-lab/bot-personas/)
      const personaPath = `/app/bot-configs/${manifest.agent_id}.yaml`;
      if (this._fileExists(personaPath)) {
        vars.push(`BOT_PERSONA_FILE=${personaPath}`);
        logger.info(`[ProvisioningManager] Auto-detected persona file: ${personaPath}`);
      }
    }

    // If knowledge_sources are specified, pass them as JSON
    if (manifest.knowledge_sources && manifest.knowledge_sources.length > 0) {
      vars.push(`AGENT_KNOWLEDGE_SOURCES=${JSON.stringify(manifest.knowledge_sources)}`);
    }

    // Apply env overrides
    for (const [key, value] of Object.entries(envOverrides)) {
      vars.push(`${key}=${value}`);
    }

    return vars;
  }

  /**
   * Wait for a container to become healthy.
   * @param {string} containerName - Container name
   * @param {string} healthPath - Health check path
   * @param {number} [maxWaitMs=120000] - Maximum wait time
   * @returns {Promise<boolean>} True if healthy
   */
  async _waitForHealthy(containerName, healthPath, maxWaitMs = 120000) {
    const startTime = Date.now();
    const pollInterval = 5000; // 5 seconds

    logger.info(`[ProvisioningManager] Waiting for ${containerName} to become healthy...`);

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const output = execSync(
          `docker inspect --format "{{.State.Health.Status}}" ${containerName} 2>/dev/null`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim();

        if (output === 'healthy') {
          logger.info(`[ProvisioningManager] ✅ ${containerName} is healthy`);
          return true;
        }

        if (output === 'unhealthy') {
          logger.warn(`[ProvisioningManager] ⚠️ ${containerName} is unhealthy`);
          return false;
        }

        // 'starting' — keep waiting
      } catch (e) {
        // Container might not have health status yet
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    logger.warn(`[ProvisioningManager] ⏱️ Timeout waiting for ${containerName} health check`);
    return false;
  }

  /**
   * Verify that the agent has registered in AgentRegistry.
   * @param {string} agentId - Agent ID to check
   * @param {number} [maxWaitMs=30000] - Maximum wait time
   * @returns {Promise<boolean>} True if registered
   */
  async _verifyRegistration(agentId, maxWaitMs = 30000) {
    if (!this.agentRegistry) return false;

    const startTime = Date.now();
    const pollInterval = 3000;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const agents = await this.agentRegistry.getAll();
        const found = agents.find(a => a.agent_id === agentId);
        if (found) {
          logger.info(`[ProvisioningManager] ✅ ${agentId} verified in AgentRegistry`);
          return true;
        }
      } catch (e) {
        // Registry not available
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    logger.warn(`[ProvisioningManager] ⚠️ ${agentId} not found in AgentRegistry after ${maxWaitMs / 1000}s`);
    return false;
  }

  /**
   * Get the base Docker image.
   * @returns {string} Image name
   */
  _getBaseImage() {
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
   * Get the Docker network flag.
   * @returns {string} --network flag
   */
  _getNetworkFlag() {
    try {
      const networks = execSync(
        'docker network ls --format "{{.Name}}" 2>/dev/null',
        { encoding: 'utf8', timeout: 5000 }
      );
      const networkList = networks.trim().split('\n');
      const swarmNet = networkList.find(n => 
        n.includes('swarm-local') || n.includes('swarm-network')
      );
      if (swarmNet) return `--network ${swarmNet}`;
    } catch (e) {
      // ignore
    }

    return `--network ${this.networkName}`;
  }

  /**
   * Get next available port.
   * @returns {number} Available port
   */
  _getNextAvailablePort() {
    const usedPorts = new Set();

    // Collect ports from our tracked deployments
    for (const info of this.provisioned.values()) {
      if (info.port) usedPorts.add(info.port);
    }

    try {
      const output = execSync(
        'docker ps --format "{{.Ports}}" 2>/dev/null',
        { encoding: 'utf8', timeout: 5000 }
      );
      const portRegex = /0\.0\.0\.0:(\d+)->/g;
      let match;
      while ((match = portRegex.exec(output)) !== null) {
        usedPorts.add(parseInt(match[1]));
      }
    } catch (e) {
      // ignore
    }

    let port = this.basePort;
    while (usedPorts.has(port)) {
      port++;
    }
    this.basePort = port + 1;
    return port;
  }

  /**
   * Check if Docker socket is available.
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

  // ──────────────────────────────────────────────────────────────
  // Level 2: New methods
  // ──────────────────────────────────────────────────────────────

  /**
   * Build volume mount flags from manifest.
   * ⭐ CRITICAL FIX: Adds the same bind mounts that compose-defined bots get.
   * Without these, provisioned bots run old code, can't write to persistent storage,
   * fail Bedrock auth, and have no persona configs.
   * 
   * Compose bots get 7 mounts via x-bot-common:
   *   1. ./any-bot/server → /app/server (live code)
   *   2. ./swarm-workspace → /app/workspace (persistent file writes)
   *   3. ./ai-lab/bot-personas → /app/bot-configs:ro (persona YAML)
   *   4. ./ai-lab/project-configs → /app/project-configs:ro
   *   5. ~/.aws/credentials → /app/.aws/credentials:ro (Bedrock auth)
   *   6. ~/.aws/config → /app/.aws/config:ro
   *   7. ./k8s-config-css-gardener-skip-tls.yaml → /app/.kube/config:ro
   * 
   * @param {Object} manifest - Agent manifest
   * @returns {string[]} Array of volume mount strings for -v flags
   */
  _buildVolumeMounts(manifest) {
    const mounts = [];

    // ── CRITICAL SYSTEM MOUNTS ──────────────────────────────────
    // These match the compose x-bot-common volumes so provisioned bots
    // behave identically to compose-defined bots.

    // 1. Server code — enables hot-reload of latest code (fast mode, etc.)
    //    Resolve from workspace root: the ProvisioningManager runs inside
    //    swarm-project-manager which has /app/server mounted from host.
    //    We need the HOST path, not the container path, because docker run
    //    mounts are host→container. Use the known host project structure.
    const hostProjectRoot = process.env.HOST_PROJECT_ROOT || this._detectHostProjectRoot();
    
    if (hostProjectRoot) {
      // Core mounts using detected host path
      mounts.push(`${hostProjectRoot}/any-bot/server:/app/server:rw`);
      mounts.push(`${hostProjectRoot}/swarm-workspace:/app/workspace:rw`);
      mounts.push(`${hostProjectRoot}/ai-lab/bot-personas:/app/bot-configs:ro`);
      mounts.push(`${hostProjectRoot}/ai-lab/project-configs:/app/project-configs:ro`);
      mounts.push(`${hostProjectRoot}/k8s-config-css-gardener-skip-tls.yaml:/app/.kube/config:ro`);
    } else {
      logger.warn('[ProvisioningManager] Cannot detect host project root — falling back to container-relative mounts');
      // Fallback: Use Docker named volumes or container-relative paths
      // These work if the ProvisioningManager container has the correct mounts
      mounts.push('/app/server:/app/server:rw');
      mounts.push('/app/workspace:/app/workspace:rw');
      mounts.push('/app/bot-configs:/app/bot-configs:ro');
      mounts.push('/app/project-configs:/app/project-configs:ro');
    }

    // 2. AWS credentials — required for Bedrock LLM provider
    //    These are user-specific, so we detect from the running container's mounts
    //    or fall back to the standard compose paths.
    const awsCredsHost = process.env.HOST_AWS_CREDENTIALS_PATH || this._detectHostAwsPath();
    if (awsCredsHost) {
      mounts.push(`${awsCredsHost}/credentials:/app/.aws/credentials:ro`);
      mounts.push(`${awsCredsHost}/config:/app/.aws/config:ro`);
    } else {
      // Fallback: copy from our own container if AWS files exist
      if (this._fileExists('/app/.aws/credentials')) {
        mounts.push('/app/.aws/credentials:/app/.aws/credentials:ro');
      }
      if (this._fileExists('/app/.aws/config')) {
        mounts.push('/app/.aws/config:/app/.aws/config:ro');
      }
    }

    // ── CREDENTIAL VOLUME AUTO-DETECTION ────────────────────────
    // If env_overrides references GOOGLE_APPLICATION_CREDENTIALS with a container path,
    // auto-mount the host credential file to that path.
    // The host credential file lives at {hostProjectRoot}/configs/gcp-service-account.json
    const envOverrides = manifest.env_overrides || {};
    if (envOverrides.GOOGLE_APPLICATION_CREDENTIALS && hostProjectRoot) {
      const containerCredPath = envOverrides.GOOGLE_APPLICATION_CREDENTIALS;
      const containerCredDir = path.dirname(containerCredPath);
      const credFileName = path.basename(containerCredPath);
      
      // Look for the credential file in known host locations
      const hostCredPaths = [
        `${hostProjectRoot}/configs/${credFileName}`,
        `${hostProjectRoot}/configs/gcp-service-account.json`,
        `${hostProjectRoot}/swarm-workspace/${manifest.agent_id}/${credFileName}`,
      ];
      
      let hostCredFile = null;
      for (const candidate of hostCredPaths) {
        // We can't directly check host filesystem from inside a container,
        // but we CAN check the container-mapped path since configs/ may be accessible
        const containerCheckPath = candidate.replace(hostProjectRoot, '');
        const appPath = `/app${containerCheckPath}`;
        if (this._fileExists(`/app/workspace/../..${containerCheckPath}`) || 
            this._fileExists(appPath)) {
          hostCredFile = candidate;
          break;
        }
      }
      
      // Always try the first candidate path (configs/ is the standard location)
      if (!hostCredFile) {
        hostCredFile = `${hostProjectRoot}/configs/${credFileName}`;
        logger.info(`[ProvisioningManager] GCP credentials: using default path ${hostCredFile} (may not exist)`);
      }
      
      // Mount the credential file (or entire directory) to the container path
      const isDuplicate = mounts.some(m => m.split(':')[1] === containerCredPath);
      if (!isDuplicate) {
        mounts.push(`${hostCredFile}:${containerCredPath}:ro`);
        logger.info(`[ProvisioningManager] Auto-mounted GCP credentials: ${hostCredFile} → ${containerCredPath}`);
      }
    }

    // ── MANIFEST-SPECIFIED VOLUMES ──────────────────────────────
    // Additional mounts from provision-manifest.json (GCP creds, custom configs, etc.)
    if (manifest.volumes && Array.isArray(manifest.volumes)) {
      for (const vol of manifest.volumes) {
        if (typeof vol === 'string' && vol.includes(':')) {
          // Avoid duplicating system mounts
          const containerPath = vol.split(':')[1];
          const isDuplicate = mounts.some(m => m.split(':')[1] === containerPath);
          if (!isDuplicate) {
            mounts.push(vol);
          }
        } else if (typeof vol === 'object' && vol.host && vol.container) {
          const mode = vol.mode || 'rw';
          const isDuplicate = mounts.some(m => m.split(':')[1] === vol.container);
          if (!isDuplicate) {
            mounts.push(`${vol.host}:${vol.container}:${mode}`);
          }
        }
      }
    }

    logger.info(`[ProvisioningManager] Volume mounts for ${manifest.agent_id}: ${mounts.length} mounts configured`);
    return mounts;
  }

  /**
   * Detect the host project root by inspecting Docker mount metadata.
   * The project-manager container has /app/server mounted from the host.
   * We can read the mount source from `docker inspect` to find the host path.
   * @returns {string|null} Host project root path (e.g., /Users/you/Projects/oshal)
   * @private
   */
  _detectHostProjectRoot() {
    try {
      // Method 1: Read from our own container's mount info
      // `docker inspect` on swarm-project-manager to find the host source for /app/server
      const output = execSync(
        'docker inspect swarm-project-manager --format \'{{range .Mounts}}{{if eq .Destination "/app/server"}}{{.Source}}{{end}}{{end}}\' 2>/dev/null',
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      
      if (output && output.includes('/any-bot/server')) {
        // output is like /Users/.../oshal/any-bot/server → strip /any-bot/server
        const root = output.replace(/\/any-bot\/server\/?$/, '');
        if (root) {
          logger.info(`[ProvisioningManager] Detected host project root: ${root}`);
          return root;
        }
      }
    } catch (e) {
      logger.debug(`[ProvisioningManager] Mount inspection failed: ${e.message}`);
    }

    try {
      // Method 2: Read from swarm-project-manager's mount for /app/workspace
      const output = execSync(
        'docker inspect swarm-project-manager --format \'{{range .Mounts}}{{if eq .Destination "/app/workspace"}}{{.Source}}{{end}}{{end}}\' 2>/dev/null',
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      
      if (output && output.includes('/swarm-workspace')) {
        const root = output.replace(/\/swarm-workspace\/?$/, '');
        if (root) {
          logger.info(`[ProvisioningManager] Detected host project root (workspace): ${root}`);
          return root;
        }
      }
    } catch (e) {
      logger.debug(`[ProvisioningManager] Workspace mount inspection failed: ${e.message}`);
    }

    return null;
  }

  /**
   * Detect the host path to .aws directory from container mount info.
   * @returns {string|null} Host .aws directory path (e.g., /Users/you/.aws)
   * @private
   */
  _detectHostAwsPath() {
    try {
      const output = execSync(
        'docker inspect swarm-project-manager --format \'{{range .Mounts}}{{if eq .Destination "/app/.aws/credentials"}}{{.Source}}{{end}}{{end}}\' 2>/dev/null',
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      
      if (output && output.includes('credentials')) {
        // output is like /Users/you/.aws/credentials → return /Users/you/.aws
        const awsDir = path.dirname(output);
        logger.info(`[ProvisioningManager] Detected host AWS path: ${awsDir}`);
        return awsDir;
      }
    } catch (e) {
      logger.debug(`[ProvisioningManager] AWS path detection failed: ${e.message}`);
    }

    return null;
  }

  /**
   * Check if a file exists (sync, for mount detection).
   * @param {string} filePath
   * @returns {boolean}
   * @private
   */
  _fileExists(filePath) {
    try {
      require('fs').accessSync(filePath);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Level 2: Direct AgentRegistry registration from ProvisioningManager.
   * Registers the agent with full manifest metadata including selector_descriptor
   * for mesh broadcast network integration.
   * @param {Object} manifest - Agent manifest
   * @param {string} containerName - Container name (used for endpoint URL)
   * @param {number} port - Host port assigned
   * @returns {Promise<boolean>} True if registration succeeded
   */
  async _registerAgent(manifest, containerName, port) {
    if (!this.agentRegistry) return false;

    const internalPort = (manifest.ports && manifest.ports.internal) || 5000;

    try {
      const registrationData = {
        agent_id: manifest.agent_id,
        capabilities: manifest.capabilities || ['general'],
        workspaces: manifest.workspaces || ['*'],
        status: 'idle',
        current_load: 0,
        max_concurrent: manifest.max_concurrent || 3,
        agent_scope: manifest.scope || 'shared',
        success_rate: 1.0,
        endpoint: `http://${containerName}:${internalPort}`,
        routing_keywords: manifest.routing_keywords || [],
        selector_descriptor: manifest.selector_descriptor || '',
      };

      const success = await this.agentRegistry.register(registrationData);

      if (success) {
        logger.info(`[ProvisioningManager] ✅ Direct registration: ${manifest.agent_id} → AgentRegistry`);
      } else {
        logger.warn(`[ProvisioningManager] ⚠️ Direct registration returned false for ${manifest.agent_id}`);
      }

      return success;
    } catch (error) {
      logger.error(`[ProvisioningManager] Direct registration failed for ${manifest.agent_id}: ${error.message}`);
      return false;
    }
  }

  /**
   * Level 2: Deprovision an agent — stop container, remove it, deregister from AgentRegistry.
   * @param {string} agentId - Agent ID to deprovision
   * @returns {Promise<Object>} Deprovision result
   */
  async deprovisionAgent(agentId) {
    const containerName = `swarm-${agentId}`;

    logger.info(`[ProvisioningManager] Deprovisioning ${agentId}...`);

    const result = {
      agentId,
      containerStopped: false,
      containerRemoved: false,
      deregistered: false,
    };

    // 1. Stop and remove the Docker container
    try {
      execSync(`docker stop ${containerName} 2>/dev/null`, { encoding: 'utf8', timeout: 30000 });
      result.containerStopped = true;
      logger.info(`[ProvisioningManager] Stopped container: ${containerName}`);
    } catch (e) {
      logger.warn(`[ProvisioningManager] Could not stop ${containerName}: ${e.message}`);
    }

    try {
      execSync(`docker rm -f ${containerName} 2>/dev/null`, { encoding: 'utf8', timeout: 10000 });
      result.containerRemoved = true;
      logger.info(`[ProvisioningManager] Removed container: ${containerName}`);
    } catch (e) {
      logger.warn(`[ProvisioningManager] Could not remove ${containerName}: ${e.message}`);
    }

    // 2. Deregister from AgentRegistry
    if (this.agentRegistry) {
      try {
        const success = await this.agentRegistry.unregister(agentId);
        result.deregistered = success;
        if (success) {
          logger.info(`[ProvisioningManager] ✅ Deregistered ${agentId} from AgentRegistry`);
        }
      } catch (e) {
        logger.warn(`[ProvisioningManager] Could not deregister ${agentId}: ${e.message}`);
      }
    }

    // 3. Remove from internal tracking
    this.provisioned.delete(agentId);

    const allGood = result.containerRemoved && (result.deregistered || !this.agentRegistry);
    logger.info(`[ProvisioningManager] ${allGood ? '✅' : '⚠️'} Deprovision ${agentId}: ${JSON.stringify(result)}`);

    return { success: allGood, ...result };
  }

  /**
   * Level 2: Provision from a manifest file path (for API-triggered provisioning).
   * Reads, parses, validates, and provisions from a single manifest file.
   * @param {string} manifestPath - Absolute path to provision-manifest.json
   * @returns {Promise<Object>} Provisioning result
   */
  async provisionFromFile(manifestPath) {
    try {
      const content = await fs.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(content);
      manifest._dir = path.dirname(manifestPath);
      manifest._manifestPath = manifestPath;

      return await this.provisionAgent(manifest);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { success: false, error: `Manifest file not found: ${manifestPath}` };
      }
      if (error instanceof SyntaxError) {
        return { success: false, error: `Invalid JSON in manifest: ${error.message}` };
      }
      return { success: false, error: error.message };
    }
  }

  /**
   * Level 2: Provision from an inline manifest object (for API-triggered provisioning).
   * Creates a workspace directory, writes the manifest, and provisions.
   * @param {Object} manifest - Manifest object
   * @returns {Promise<Object>} Provisioning result
   */
  async provisionFromManifest(manifest) {
    if (!manifest || !manifest.agent_id) {
      return { success: false, error: 'manifest.agent_id is required' };
    }

    // Create workspace directory for this agent
    const agentDir = path.join(this.workspaceRoot, manifest.agent_id);
    try {
      await fs.mkdir(agentDir, { recursive: true });
    } catch (e) {
      // Directory already exists — fine
    }

    // Write manifest to workspace
    const manifestPath = path.join(agentDir, 'provision-manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    logger.info(`[ProvisioningManager] Wrote manifest to ${manifestPath}`);

    // Set internal directory reference
    manifest._dir = agentDir;
    manifest._manifestPath = manifestPath;

    return await this.provisionAgent(manifest);
  }

  /**
   * Level 2: Get the manifest schema definition for documentation/validation.
   * @returns {Object} JSON Schema-like definition
   */
  static getManifestSchema() {
    return {
      type: 'object',
      required: ['agent_id', 'version'],
      properties: {
        agent_id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*[a-z0-9]$', description: 'Unique agent identifier (lowercase, hyphens allowed)' },
        version: { type: 'string', description: 'Manifest version (e.g., "1.0")' },
        image_type: { type: 'string', enum: ['base', 'custom'], default: 'base', description: 'base = use shared any-bot image, custom = build custom image' },
        base_image: { type: 'string', description: 'Base Docker image for custom builds (required if image_type=custom)' },
        dockerfile: { type: 'string', default: 'Dockerfile', description: 'Path to Dockerfile relative to manifest directory' },
        npm_dependencies: { type: 'array', items: { type: 'string' }, description: 'NPM packages to install in custom image' },
        capabilities: { type: 'array', items: { type: 'string' }, description: 'Agent capabilities for routing' },
        selector_descriptor: { type: 'string', description: 'Natural language description of WHEN to select this agent (mesh broadcast)' },
        routing_keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords for capability-based routing' },
        mcp_tools: { type: 'array', description: 'Custom MCP tool definitions' },
        env_overrides: { type: 'object', description: 'Environment variable overrides (KEY: VALUE)' },
        ports: {
          type: 'object',
          properties: {
            internal: { type: 'number', default: 5000, description: 'Container internal port' },
            external: { oneOf: [{ type: 'number' }, { const: 'auto' }], default: 'auto', description: 'Host port (auto = next available)' },
          },
        },
        volumes: {
          type: 'array',
          items: { oneOf: [
            { type: 'string', description: '/host/path:/container/path:mode' },
            { type: 'object', properties: { host: { type: 'string' }, container: { type: 'string' }, mode: { type: 'string', default: 'rw' } } },
          ]},
          description: 'Volume mounts (credentials, configs, etc.)',
        },
        health_check: { type: 'string', default: '/api/health', description: 'Health check endpoint path' },
        network: { type: 'string', description: 'Docker network to join (default: auto-detected swarm network)' },
        max_concurrent: { type: 'number', default: 3, description: 'Max concurrent tasks' },
        knowledge_sources: { type: 'array', items: { type: 'string' }, description: 'Knowledge sources for AgentMemory bootstrap' },
        persona_file: { type: 'string', description: 'Path to bot persona YAML file' },
        workspaces: { type: 'array', items: { type: 'string' }, default: ['*'], description: 'Workspace access list' },
        scope: { type: 'string', default: 'shared', description: 'Agent scope (shared/workspace-dedicated)' },
        config_schema: {
          type: 'object',
          description: 'Config schema for AgentConfigManager auto-registration. If present, ProvisioningManager auto-registers the schema so the config UI shows proper fields without manual PUT /api/agents/{id}/config.',
          properties: {
            fields: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string', description: 'Config field key (e.g., "api_key")' },
                  label: { type: 'string', description: 'Human-readable label (e.g., "API Key")' },
                  type: { type: 'string', enum: ['string', 'number', 'boolean', 'select', 'textarea'], description: 'Field input type' },
                  required: { type: 'boolean', default: false },
                  default: { description: 'Default value for the field' },
                  placeholder: { type: 'string', description: 'Input placeholder text' },
                  options: { type: 'array', items: { type: 'string' }, description: 'Options for select-type fields' },
                  sensitive: { type: 'boolean', default: false, description: 'If true, value is masked in UI' },
                },
              },
              description: 'Array of config field definitions',
            },
          },
          example: {
            fields: [
              { key: 'api_key', label: 'API Key', type: 'string', required: true, sensitive: true, placeholder: 'Enter API key...' },
              { key: 'model', label: 'Model', type: 'select', options: ['gpt-4', 'gpt-3.5'], default: 'gpt-4' },
            ],
          },
        },
      },
    };
  }
}

module.exports = ProvisioningManager;
