/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */


/**
 * ComposeGenerator — Programmatic Docker Compose service block generator
 * 
 * Replaces the broken LLM-edits-compose-file approach with deterministic,
 * template-based compose service generation from persona YAML metadata.
 * 
 * Pipeline: Parse persona YAML → Generate compose block → Append to compose file → docker compose up
 * 
 * This service runs ONLY on agent-factory-bot (which has Docker socket + docker-cli-compose).
 */

const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');
const { execSync } = require('child_process');
const logger = require('../utils/logger');

/**
 * @description Deterministic, template-based generator that turns persona YAML
 * metadata into docker-compose service blocks and drives the end-to-end deployment
 * of swarm agents (parse persona, allocate a host port, append a compose service,
 * bring the container up, await health, and self-register with the proxy/dashboard).
 * Exists to replace the unreliable approach of having an LLM hand-edit the compose
 * file; intended to run only on agent-factory-bot where the Docker socket is mounted.
 */
class ComposeGenerator {
  /**
   * @param {Object} options
   * @param {string} options.composePath - Path to docker-compose.swarm-local.yml
   * @param {string} options.personaDir - Path to bot-personas directory
   * @param {string} options.baseImage - Docker image for new agents (default: oshal-any-bot:latest)
   * @param {string[]} options.networks - Docker networks to join
   */
  constructor(options = {}) {
    // Inside agent-factory-bot container, compose is mounted at /app/swarm-compose
    this.composePath = options.composePath || 
      process.env.COMPOSE_FILE_PATH || 
      '/app/swarm-compose/docker-compose.swarm-local.yml';
    
    this.personaDir = options.personaDir || 
      process.env.BOT_CONFIGS_DIR || 
      '/app/bot-configs';
    
    this.baseImage = options.baseImage || 'oshal-any-bot:latest';
    this.networks = options.networks || ['oshal-network', 'plane-network'];
    
    // Port range for dynamically deployed agents
    this.portRangeStart = 3020;
    this.portRangeEnd = 3099;
  }

  /**
   * Parse a persona YAML file and extract deployment metadata
   * @param {string} filePath - Absolute path to persona YAML
   * @returns {Promise<Object>} Parsed persona metadata
   */
  async parsePersonaYaml(filePath) {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = yaml.load(content);

    if (!parsed || !parsed.name) {
      throw new Error(`Invalid persona YAML: missing 'name' field in ${filePath}`);
    }

    const fileName = path.basename(filePath);
    const baseName = fileName.replace(/\.(yaml|yml)$/, '');

    // ⭐ PHASE_17: Read authorizations block from persona YAML
    // Maps to TOOL_AUTH_* env vars in the compose service block
    const authorizations = parsed.authorizations || {};

    return {
      name: parsed.name,
      agent_id: parsed.agent_id || parsed.name,
      capabilities: Array.isArray(parsed.capabilities) 
        ? parsed.capabilities 
        : (parsed.capabilities ? [parsed.capabilities] : ['general']),
      max_concurrent: parsed.max_concurrent || 3,
      role: parsed.role || 'General',
      scope: parsed.scope || 'shared',
      file: fileName,
      baseName: baseName,
      authorizations,  // PHASE_17: tool authorization requirements
    };
  }

  /**
   * Get all service names AND container names currently defined in the compose file.
   * Also checks container_name values to prevent duplicate deployments when a bot
   * already exists under a different service name (e.g. swarm-3d-printing-bot vs 3d-printing-bot).
   * @returns {Promise<string[]>} Array of service names and container names (without swarm- prefix)
   */
  async getExistingServices() {
    try {
      const content = await fs.readFile(this.composePath, 'utf8');
      const services = new Set();
      
      // Parse services section — look for top-level service definitions
      // Services are indented exactly 2 spaces under the 'services:' key
      const lines = content.split('\n');
      let inServices = false;
      
      for (const line of lines) {
        if (line.match(/^services:\s*$/)) {
          inServices = true;
          continue;
        }
        
        // Once we hit another top-level key (volumes:, networks:, etc.), stop
        if (inServices && line.match(/^[a-z]/) && !line.startsWith(' ')) {
          break;
        }
        
        if (inServices) {
          // Service names are indented exactly 2 spaces
          const serviceMatch = line.match(/^  ([a-z][a-z0-9_-]*):\s*$/);
          if (serviceMatch) {
            services.add(serviceMatch[1]);
          }
          
          // Also capture container_name values — strip swarm- prefix for comparison
          // This prevents deploying "3d-printing-bot" when "swarm-3d-printing-bot" already exists
          const containerMatch = line.match(/container_name:\s*swarm-([a-z][a-z0-9_-]*)/);
          if (containerMatch) {
            services.add(containerMatch[1]); // Add without swarm- prefix
          }
        }
      }
      
      return Array.from(services);
    } catch (err) {
      logger.warn(`[ComposeGenerator] Cannot read compose file: ${err.message}`);
      return [];
    }
  }

  /**
   * Scan compose file for the highest port in the 3020+ range and return the next available
   * @returns {Promise<number>} Next available host port
   */
  async getNextPort() {
    try {
      const content = await fs.readFile(this.composePath, 'utf8');
      
      // Collect ALL used ports from the compose file (any format: "3037:5000", - "3037:5000")
      // This catches both quoted and unquoted port mappings
      const allPortRegex = /["\s](\d{4}):5000/g;
      const usedPorts = new Set();
      let match;
      
      while ((match = allPortRegex.exec(content)) !== null) {
        usedPorts.add(parseInt(match[1]));
      }
      
      // Find the highest used port in our range
      let maxPort = this.portRangeStart - 1;
      for (const port of usedPorts) {
        if (port >= this.portRangeStart && port <= this.portRangeEnd && port > maxPort) {
          maxPort = port;
        }
      }
      
      // Find next unused port starting from maxPort + 1
      let nextPort = maxPort + 1;
      while (usedPorts.has(nextPort)) {
        nextPort++;
      }
      
      if (nextPort > this.portRangeEnd) {
        throw new Error(`Port range exhausted (${this.portRangeStart}-${this.portRangeEnd})`);
      }
      
      logger.info(`[ComposeGenerator] Next available port: ${nextPort} (used ports in range: ${Array.from(usedPorts).filter(p => p >= this.portRangeStart && p <= this.portRangeEnd).sort((a,b)=>a-b).join(', ')})`);
      return nextPort;
    } catch (err) {
      if (err.message.includes('Port range exhausted')) throw err;
      logger.warn(`[ComposeGenerator] Cannot scan ports: ${err.message}`);
      return this.portRangeStart;
    }
  }

  /**
   * Generate a docker-compose service YAML block from persona metadata.
   * Pure template interpolation — NO LLM involved.
   * 
   * @param {Object} persona - Parsed persona metadata from parsePersonaYaml()
   * @param {number} port - Host port to assign
   * @returns {string} YAML service block string (properly indented for compose file)
   */
  generateServiceBlock(persona, port) {
    const serviceName = persona.agent_id;
    const containerName = `swarm-${persona.agent_id}`;
    const capabilities = persona.capabilities.join(',');
    const endpointUrl = `http://${containerName}:5000`;
    const personaFile = `/app/bot-configs/${persona.file}`;

    // Comment block for identification
    const comment = [
      ``,
      `  # ──────────────────────────────────────────────────`,
      `  # AUTO-DEPLOYED: ${persona.name} (by Agent Factory)`,
      `  # Created from persona: ${persona.file}`,
      `  # ──────────────────────────────────────────────────`,
    ].join('\n');

    // ⭐ PHASE_17: Generate TOOL_AUTH_* env vars from persona authorizations block
    // Maps persona.authorizations fields to TOOL_AUTH_* env vars
    // Values: "auto" | "ask" | "off" (default: "off" from x-bot-common)
    const AUTH_FIELD_MAP = {
      aws_cli:       'TOOL_AUTH_AWS_CLI',
      kubectl:       'TOOL_AUTH_KUBECTL',
      gcloud:        'TOOL_AUTH_GCLOUD',
      docker:        'TOOL_AUTH_DOCKER_SOCKET',
      google_search: 'TOOL_AUTH_GOOGLE_SEARCH',
      chroma_mcp:    'TOOL_AUTH_CHROMA_MCP',
      plane_mcp:     'TOOL_AUTH_PLANE_MCP',
    };

    const authEnvLines = [];
    const auth = persona.authorizations || {};
    for (const [field, envVar] of Object.entries(AUTH_FIELD_MAP)) {
      if (field in auth) {
        // Convert boolean true → "auto", false → "off", or use string value directly
        let mode = auth[field];
        if (mode === true) mode = 'auto';
        else if (mode === false) mode = 'off';
        else mode = String(mode).toLowerCase();
        authEnvLines.push(`      ${envVar}: "${mode}"`);
      }
    }

    // Service definition using YAML anchor reference
    const serviceBlock = [
      `  ${serviceName}:`,
      `    <<: *bot-common`,
      `    container_name: ${containerName}`,
      `    ports:`,
      `      - "${port}:5000"`,
      `    environment:`,
      `      <<: *bot-env-common`,
      `      AGENT_ID: ${persona.agent_id}`,
      `      AGENT_CAPABILITIES: "${capabilities}"`,
      `      AGENT_MAX_CONCURRENT: "${persona.max_concurrent}"`,
      `      AGENT_SCOPE: ${persona.scope}`,
      `      BOT_PERSONA_FILE: ${personaFile}`,
      `      ENABLE_QUEUE_MANAGER: "false"`,
      `      AGENT_ENDPOINT_URL: "${endpointUrl}"`,
      `      AGENT_EXTERNAL_PORT: "${port}"`,
      // PHASE_17: Inject TOOL_AUTH_* overrides from persona authorizations
      ...authEnvLines,
    ].join('\n');

    if (authEnvLines.length > 0) {
      logger.info(`[ComposeGenerator] PHASE_17: Added ${authEnvLines.length} TOOL_AUTH_* env vars for ${persona.agent_id}: ${authEnvLines.map(l => l.trim()).join(', ')}`);
    }

    return comment + '\n' + serviceBlock;
  }

  /**
   * Append a service block to the compose file, inserting before the code-server service.
   * Idempotent: will not add if service already exists.
   * 
   * @param {string} serviceYaml - The YAML service block to insert
   * @param {string} serviceName - The service name (for idempotency check)
   * @returns {Promise<boolean>} True if inserted, false if already exists
   */
  async appendToCompose(serviceYaml, serviceName) {
    const content = await fs.readFile(this.composePath, 'utf8');
    
    // Idempotency check: don't add if service already defined
    const serviceRegex = new RegExp(`^  ${serviceName}:`, 'm');
    if (serviceRegex.test(content)) {
      logger.info(`[ComposeGenerator] Service '${serviceName}' already exists in compose file, skipping`);
      return false;
    }

    // Insert before code-server service block
    // Look for the code-server comment/definition
    const codeServerMarker = '  # ════════════════════════════════════════════════════════════\n  # CODE-SERVER';
    const codeServerServiceMarker = '  code-server:';
    
    let insertPoint;
    let insertContent;
    
    if (content.includes(codeServerMarker)) {
      // Insert before the code-server comment block
      insertPoint = content.indexOf(codeServerMarker);
      insertContent = content.slice(0, insertPoint) + serviceYaml + '\n\n' + content.slice(insertPoint);
    } else if (content.includes(codeServerServiceMarker)) {
      // Insert before code-server: service definition
      insertPoint = content.indexOf(codeServerServiceMarker);
      insertContent = content.slice(0, insertPoint) + serviceYaml + '\n\n' + content.slice(insertPoint);
    } else {
      // Fallback: append before volumes section
      const volumesMarker = '# ============================================================\n# VOLUMES';
      if (content.includes(volumesMarker)) {
        insertPoint = content.indexOf(volumesMarker);
        insertContent = content.slice(0, insertPoint) + serviceYaml + '\n\n' + content.slice(insertPoint);
      } else {
        // Last resort: append to end of services section
        insertContent = content + '\n' + serviceYaml + '\n';
      }
    }

    await fs.writeFile(this.composePath, insertContent, 'utf8');
    logger.info(`[ComposeGenerator] ✅ Added service '${serviceName}' to compose file`);
    return true;
  }

  /**
   * Scan persona directory for YAML files that don't have matching compose services.
   * Returns array of undeployed persona metadata.
   * 
   * @returns {Promise<Object[]>} Array of persona metadata objects
   */
  async scanUndeployedPersonas() {
    const existingServices = await this.getExistingServices();
    const existingSet = new Set(existingServices);
    const undeployed = [];

    try {
      const entries = await fs.readdir(this.personaDir);

      for (const entry of entries) {
        if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;

        const filepath = path.join(this.personaDir, entry);
        try {
          const stat = await fs.stat(filepath);
          if (!stat.isFile()) continue;

          const persona = await this.parsePersonaYaml(filepath);
          
          // Check if this persona already has a compose service
          if (!existingSet.has(persona.agent_id) && !existingSet.has(persona.baseName)) {
            undeployed.push(persona);
          }
        } catch (err) {
          logger.warn(`[ComposeGenerator] Skipping ${entry}: ${err.message}`);
        }
      }
    } catch (err) {
      logger.warn(`[ComposeGenerator] Cannot scan persona directory: ${err.message}`);
    }

    return undeployed;
  }

  /**
   * Full deployment pipeline for a single agent:
   * 1. Parse persona YAML
   * 2. Generate compose service block
   * 3. Append to compose file
   * 4. Run docker compose up -d for that service
   * 5. Wait for container health
   * 6. Verify agent registration
   * 
   * @param {string} agentId - The agent_id to deploy
   * @returns {Promise<Object>} DeployResult
   */
  async deployAgent(agentId) {
    const startTime = Date.now();
    logger.info(`[ComposeGenerator] 🚀 Starting deployment pipeline for: ${agentId}`);

    try {
      // 1. Find and parse persona YAML
      const personaFile = await this._findPersonaFile(agentId);
      if (!personaFile) {
        return { success: false, agentId, error: `No persona YAML found for '${agentId}'` };
      }

      const persona = await this.parsePersonaYaml(personaFile);
      logger.info(`[ComposeGenerator] Parsed persona: ${persona.name} (${persona.capabilities.join(', ')})`);

      // 2. Check if already in compose
      const existingServices = await this.getExistingServices();
      if (existingServices.includes(agentId)) {
        logger.info(`[ComposeGenerator] Service '${agentId}' already in compose, running docker compose up`);
      } else {
        // 3. Generate and append compose block
        const port = await this.getNextPort();
        const serviceBlock = this.generateServiceBlock(persona, port);
        await this.appendToCompose(serviceBlock, agentId);
        logger.info(`[ComposeGenerator] Compose block added with port ${port}`);
      }

      // 4. Docker compose up for this specific service
      const composeUp = await this._dockerComposeUp(agentId);
      if (!composeUp.success) {
        return { success: false, agentId, error: composeUp.error };
      }

      // 5. Wait for container to become healthy
      const healthy = await this._waitForHealth(agentId, 45000);
      
      // 6. Get assigned port
      const port = await this._getServicePort(agentId);

      // 7. Auto-register with service map and health dashboard
      await this._registerWithServiceMap(agentId, port);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`[ComposeGenerator] ✅ ${agentId} deployed successfully in ${elapsed}s (port ${port})`);

      return {
        success: true,
        agentId,
        port,
        containerName: `swarm-${agentId}`,
        registered: healthy,
        dashboardRegistered: true,
        elapsed: `${elapsed}s`,
      };

    } catch (err) {
      logger.error(`[ComposeGenerator] ❌ Deploy failed for ${agentId}: ${err.message}`);
      return { success: false, agentId, error: err.message };
    }
  }

  /**
   * Deploy all undeployed personas — scan + deploy each one.
   * @returns {Promise<Object>} Summary of all deployments
   */
  async deployAllUndeployed() {
    logger.info('[ComposeGenerator] 🔍 Scanning for undeployed personas...');
    const undeployed = await this.scanUndeployedPersonas();
    
    if (undeployed.length === 0) {
      logger.info('[ComposeGenerator] All personas already have compose services ✅');
      return { deployed: [], skipped: 0, errors: [] };
    }

    logger.info(`[ComposeGenerator] Found ${undeployed.length} undeployed personas:`);
    undeployed.forEach(p => logger.info(`  → ${p.agent_id} (${p.capabilities.join(', ')})`));

    const results = { deployed: [], skipped: 0, errors: [] };

    for (const persona of undeployed) {
      const result = await this.deployAgent(persona.agent_id);
      if (result.success) {
        results.deployed.push(result);
      } else {
        results.errors.push(result);
      }
    }

    logger.info(`[ComposeGenerator] Deployment complete: ${results.deployed.length} deployed, ${results.errors.length} errors`);
    return results;
  }

  // ════════════════════════════════════════════════
  // Private helper methods
  // ════════════════════════════════════════════════

  /**
   * Find the persona YAML file for a given agent ID
   * @param {string} agentId
   * @returns {Promise<string|null>} Absolute file path or null
   */
  async _findPersonaFile(agentId) {
    try {
      const entries = await fs.readdir(this.personaDir);
      
      // Try exact match first: {agentId}.yaml
      for (const entry of entries) {
        if (entry === `${agentId}.yaml` || entry === `${agentId}.yml`) {
          return path.join(this.personaDir, entry);
        }
      }

      // Try matching by agent_id field inside YAML
      for (const entry of entries) {
        if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
        const filepath = path.join(this.personaDir, entry);
        try {
          const content = await fs.readFile(filepath, 'utf8');
          const parsed = yaml.load(content);
          if (parsed && (parsed.agent_id === agentId || parsed.name === agentId)) {
            return filepath;
          }
        } catch (e) { /* skip unparseable files */ }
      }
      
      return null;
    } catch (err) {
      logger.warn(`[ComposeGenerator] Cannot search persona files: ${err.message}`);
      return null;
    }
  }

  /**
   * Run docker compose up -d for a specific service
   * @param {string} serviceName
   * @returns {Promise<Object>} { success, output, error }
   */
  async _dockerComposeUp(serviceName) {
    try {
      const composeDir = path.dirname(this.composePath);
      const composeFile = path.basename(this.composePath);
      
      const cmd = `docker compose -f ${composeFile} up -d ${serviceName}`;
      logger.info(`[ComposeGenerator] Running: ${cmd} (in ${composeDir})`);
      
      const output = execSync(cmd, {
        encoding: 'utf8',
        timeout: 120000,
        cwd: composeDir,
      });
      
      logger.info(`[ComposeGenerator] docker compose up output: ${output.trim()}`);
      return { success: true, output: output.trim() };
    } catch (err) {
      logger.error(`[ComposeGenerator] docker compose up failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Wait for a container to pass its health check
   * @param {string} agentId
   * @param {number} timeoutMs - Maximum wait time
   * @returns {Promise<boolean>} True if healthy
   */
  async _waitForHealth(agentId, timeoutMs = 45000) {
    const containerName = `swarm-${agentId}`;
    const startTime = Date.now();
    const checkInterval = 5000;
    
    logger.info(`[ComposeGenerator] Waiting for ${containerName} to be healthy (timeout: ${timeoutMs / 1000}s)...`);
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        const status = execSync(
          `docker inspect --format '{{.State.Health.Status}}' ${containerName} 2>/dev/null`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim();
        
        if (status === 'healthy') {
          logger.info(`[ComposeGenerator] ✅ ${containerName} is healthy`);
          return true;
        }
        
        if (status === 'unhealthy') {
          logger.warn(`[ComposeGenerator] ⚠️ ${containerName} is unhealthy`);
          return false;
        }
        
        // Status is 'starting' — keep waiting
      } catch (e) {
        // Container might not exist yet
      }
      
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    
    logger.warn(`[ComposeGenerator] ⏰ Timeout waiting for ${containerName} health check`);
    return false;
  }

  /**
   * Get the host port assigned to a service from the compose file
   * @param {string} serviceName
   * @returns {Promise<number|null>}
   */
  async _getServicePort(serviceName) {
    try {
      const content = await fs.readFile(this.composePath, 'utf8');
      
      // Find the service block and extract its port
      const lines = content.split('\n');
      let inService = false;
      let serviceIndent = -1;
      
      for (const line of lines) {
        // Match service name at 2-space indent
        if (line.match(new RegExp(`^  ${serviceName}:`))) {
          inService = true;
          serviceIndent = 2;
          continue;
        }
        
        // If we're in the service block, look for port mapping
        if (inService) {
          // Detect if we've left the service block (new service at same indent)
          if (line.match(/^  [a-z]/) && !line.startsWith('    ')) {
            break;
          }
          
          const portMatch = line.match(/"(\d+):5000"/);
          if (portMatch) {
            return parseInt(portMatch[1]);
          }
        }
      }
      
      return null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Register a newly deployed agent with the service-map proxy and health dashboard.
   * Calls the local any-bot APIs so the new bot is visible in proxy-health and dashboard.
   * Non-blocking — errors are logged but do NOT fail the deployment.
   * 
   * @param {string} agentId - The agent_id that was deployed
   * @param {number} port - The host port assigned to the agent
   */
  async _registerWithServiceMap(agentId, port) {
    if (!port) {
      logger.warn(`[ComposeGenerator] Cannot register ${agentId}: no port assigned`);
      return;
    }

    const localPort = process.env.PORT || 5000;
    const http = require('http');

    const postJSON = (path, data) => {
      return new Promise((resolve, reject) => {
        const body = JSON.stringify(data);
        const req = http.request({
          hostname: 'localhost',
          port: localPort,
          path,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 5000,
        }, (res) => {
          let responseBody = '';
          res.on('data', chunk => responseBody += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(responseBody)); } catch { resolve(responseBody); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(body);
        req.end();
      });
    };

    // 1. Register in DOCKER_SERVICE_MAP for proxy-health
    try {
      const smResult = await postJSON('/api/service-map/register', {
        port: port,
        hostname: 'host.docker.internal',
      });
      logger.info(`[ComposeGenerator] ✅ Service map registered: port ${port} → host.docker.internal (${JSON.stringify(smResult)})`);
    } catch (err) {
      logger.warn(`[ComposeGenerator] ⚠️ Service map registration failed (non-fatal): ${err.message}`);
    }

    // 2. Register in health dashboard dynamic nodes
    try {
      const hdResult = await postJSON('/api/health-dashboard/nodes', {
        name: agentId,
        port: port,
        emoji: '🤖',
        type: 'agent',
        category: 'Factory-Deployed',
      });
      logger.info(`[ComposeGenerator] ✅ Health dashboard registered: ${agentId} on port ${port} (${JSON.stringify(hdResult)})`);
    } catch (err) {
      logger.warn(`[ComposeGenerator] ⚠️ Health dashboard registration failed (non-fatal): ${err.message}`);
    }
  }

  /**
   * Check if Docker CLI is available (for pre-flight checks)
   * @returns {boolean}
   */
  isDockerAvailable() {
    try {
      execSync('docker info 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Check if docker compose CLI is available
   * @returns {boolean}
   */
  isComposeAvailable() {
    try {
      execSync('docker compose version 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
      return true;
    } catch (e) {
      return false;
    }
  }
}

module.exports = ComposeGenerator;
