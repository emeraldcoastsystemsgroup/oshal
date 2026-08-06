/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from app.js (1000-line cap decomposition): dynamic tool registration API, provisioning manager API, agent registry/deploy/expand-capability/config APIs
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: retire any-bot HTTP tool mutation so arbitrary outbound handlers cannot be registered or replaced outside the canonical controller tool plane.
 */

const path = require('path');
const logger = require('../utils/logger');

// The original code lived in any-bot/server/ — keep filesystem anchors identical.
const SERVER_ROOT = path.join(__dirname, '..');

/**
 * @description Dynamic tool registration (Layer B), ProvisioningManager API (PHASE_10/52), agent-memory stats, agent registry list/enable/update, queue-manager admin UI, agent-factory deploy, and Layer-2 capability-expansion + per-agent config APIs.
 * @param {object} application - The Application instance (owns the express app, stores, controllers, and services).
 * @returns {void}
 */
function registerAgentAndProvisioningRoutes(application) {
    // Trigger MCP tool discovery
    // === Dynamic Tool Registration API (Layer B: Self-Expanding Capability) ===

    const retiredToolMutation = (_req, res) => res.status(410).json({
      error: 'tool mutation is owned by the authenticated controller tool plane',
    });
    application.app.post('/api/tools/register', retiredToolMutation);
    application.app.delete('/api/tools/register/:toolName', retiredToolMutation);

    application.app.get('/api/tools/dynamic', async (req, res) => {
      try {
        if (!application.dynamicToolManager) {
          return res.status(503).json({ error: 'DynamicToolManager not initialized' });
        }
        res.json({ tools: application.dynamicToolManager.listTools() });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // === Health Check Status API ===
    // ⭐ ISSUE #026: Health checks permanently disabled
    // Endpoint removed - health checks created 1525+ noise tickets
    // See archive/health-checks-disabled-2026-02-19/ for archived code

    // === Provisioning Manager API (Level 2 — PHASE_10) ===

    application.app.get('/api/provisioning/status', async (req, res) => {
      try {
        if (!application.provisioningManager) {
          return res.json({ status: 'not-initialized', agents: {} });
        }
        res.json(application.provisioningManager.getStatus());
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // POST /api/provisioning/provision — Provision from inline manifest
    application.app.post('/api/provisioning/provision', async (req, res) => {
      try {
        if (!application.provisioningManager) {
          return res.status(503).json({ error: 'ProvisioningManager not initialized' });
        }
        const manifest = req.body;
        if (!manifest || !manifest.agent_id) {
          return res.status(400).json({ error: 'Request body must include agent_id' });
        }
        logger.info(`[API] Provisioning request for: ${manifest.agent_id}`);
        const result = await application.provisioningManager.provisionFromManifest(manifest);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // DELETE /api/provisioning/:agentId — Deprovision an agent
    application.app.delete('/api/provisioning/:agentId', async (req, res) => {
      try {
        if (!application.provisioningManager) {
          return res.status(503).json({ error: 'ProvisioningManager not initialized' });
        }
        const { agentId } = req.params;
        logger.info(`[API] Deprovision request for: ${agentId}`);
        const result = await application.provisioningManager.deprovisionAgent(agentId);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // POST /api/provisioning/scan — Trigger immediate manifest scan
    application.app.post('/api/provisioning/scan', async (req, res) => {
      try {
        if (!application.provisioningManager) {
          return res.status(503).json({ error: 'ProvisioningManager not initialized' });
        }
        logger.info('[API] Manual provisioning scan triggered');
        const result = await application.provisioningManager.scanAndProvision();
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // GET /api/provisioning/schema — Return manifest schema for documentation
    application.app.get('/api/provisioning/schema', (req, res) => {
      try {
        const ProvisioningManager = require('../services/ProvisioningManager');
        res.json(ProvisioningManager.getManifestSchema());
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // POST /api/provisioning/validate — Validate a manifest without provisioning
    application.app.post('/api/provisioning/validate', (req, res) => {
      try {
        if (!application.provisioningManager) {
          return res.status(503).json({ error: 'ProvisioningManager not initialized' });
        }
        const manifest = req.body;
        const validation = application.provisioningManager.validateManifest(manifest);
        res.json(validation);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    application.app.get('/api/agent-memory/stats', async (req, res) => {
      try {
        if (!application.agentBootstrap || !application.agentBootstrap.agentMemory) {
          return res.json({ status: 'not-initialized', agentId: process.env.AGENT_ID || 'unknown' });
        }
        const stats = await application.agentBootstrap.agentMemory.getCollectionStats();
        res.json(stats);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ════════════════════════════════════════════════════════
    // Agent Registry API — List agents, enable/disable toggles
    // ════════════════════════════════════════════════════════
    application.app.get('/api/agents', async (req, res) => {
      try {
        if (!application.queueManagerService || !application.queueManagerService.agentRegistry) {
          return res.json({ agents: [], error: 'QueueManager not initialized' });
        }
        const agents = await application.queueManagerService.agentRegistry.getAll();
        res.json({ agents, count: agents.length });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    application.app.put('/api/agents/:agentId/enabled', async (req, res) => {
      try {
        const { agentId } = req.params;
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') {
          return res.status(400).json({ error: 'enabled must be a boolean' });
        }
        if (!application.queueManagerService || !application.queueManagerService.agentRegistry) {
          return res.status(503).json({ error: 'QueueManager not initialized' });
        }
        const success = await application.queueManagerService.agentRegistry.setEnabled(agentId, enabled);
        if (success) {
          res.json({ success: true, agent_id: agentId, enabled });
        } else {
          res.status(404).json({ error: `Agent ${agentId} not found` });
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // PUT /api/agents/:agentId/update — Update agent properties in Redis
    application.app.put('/api/agents/:agentId/update', async (req, res) => {
      try {
        const { agentId } = req.params;
        const updates = req.body;
        
        if (!application.queueManagerService || !application.queueManagerService.agentRegistry) {
          return res.status(503).json({ error: 'QueueManager not initialized' });
        }
        
        // Get current agent data
        const agent = await application.queueManagerService.agentRegistry.getAgent(agentId);
        if (!agent) {
          return res.status(404).json({ error: `Agent ${agentId} not found` });
        }
        
        // Merge updates
        const updated = {
          ...agent,
          ...updates,
          agent_id: agentId, // Preserve agent_id
          last_updated: new Date().toISOString(),
        };
        
        // Re-register with updated data
        const success = await application.queueManagerService.agentRegistry.register(updated);
        
        if (success) {
          res.json({ success: true, agent_id: agentId, updated });
        } else {
          res.status(500).json({ error: 'Failed to update agent' });
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Serve Queue Manager Admin UI
    application.app.get('/queue-manager-admin', (req, res) => {
      res.sendFile(path.join(SERVER_ROOT, '../ui-enhanced/queue-manager-admin.html'));
    });

    // ════════════════════════════════════════════════════════
    // Agent Factory: Deploy endpoint
    // POST /api/agents/deploy — Programmatic agent deployment via ComposeGenerator
    // Called by agent-factory-bot after creating a persona YAML
    // ════════════════════════════════════════════════════════
    application.app.post('/api/agents/deploy', async (req, res) => {
      try {
        const { agentId, deployAll } = req.body;
        
        if (!agentId && !deployAll) {
          return res.status(400).json({ 
            error: 'Must provide agentId or deployAll: true',
            usage: 'POST /api/agents/deploy { "agentId": "my-bot" } or { "deployAll": true }'
          });
        }

        const ComposeGenerator = require('../services/ComposeGenerator');
        const generator = new ComposeGenerator();

        // Pre-flight check: Docker must be available
        if (!generator.isDockerAvailable()) {
          return res.status(503).json({ 
            error: 'Docker socket not available. This endpoint only works on agent-factory-bot.',
            hint: 'Call this endpoint on the agent-factory-bot container (port 3020)'
          });
        }

        if (deployAll) {
          logger.info('[API] POST /api/agents/deploy — deploying all undeployed personas');
          const result = await generator.deployAllUndeployed();
          return res.json({
            success: true,
            deployed: result.deployed,
            errors: result.errors,
            summary: `${result.deployed.length} deployed, ${result.errors.length} errors`
          });
        }

        // Deploy single agent
        logger.info(`[API] POST /api/agents/deploy — deploying agent: ${agentId}`);
        const result = await generator.deployAgent(agentId);
        
        if (result.success) {
          res.json(result);
        } else {
          res.status(500).json(result);
        }
      } catch (error) {
        logger.error(`[API] Deploy error: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // ════════════════════════════════════════════════════════
    // Layer 2: Self-Evolving Agent Factory — Capability Expansion + Config APIs
    // ════════════════════════════════════════════════════════

    // POST /api/agents/expand-capability — Full capability expansion pipeline
    application.app.post('/api/agents/expand-capability', async (req, res) => {
      try {
        const AgentConfigManager = require('../services/AgentConfigManager');
        const CapabilityExpander = require('../services/CapabilityExpander');

        const configManager = new AgentConfigManager({ redisClient: application.redisClient });
        await configManager.initialize();

        const expander = new CapabilityExpander({
          configManager,
          outputDir: process.env.SCAFFOLD_OUTPUT_DIR || '/app/swarm-workspace',
        });

        const spec = req.body;
        if (!spec || !spec.agentId || !spec.toolName) {
          return res.status(400).json({
            error: 'Must provide agentId, toolName, and description',
            usage: 'POST /api/agents/expand-capability { "agentId": "image-gen-bot", "toolName": "generateImage", "description": "...", "capabilities": [...], "configFields": [...] }',
          });
        }

        logger.info(`[API] POST /api/agents/expand-capability — ${spec.agentId}/${spec.toolName}`);
        const result = await expander.expand(spec);
        const statusCode = result.status === 'failed' ? 500 : 200;
        res.status(statusCode).json(result);
      } catch (error) {
        logger.error(`[API] Expand capability error: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // POST /api/agents/expand-capability/validate — Dry-run validation
    application.app.post('/api/agents/expand-capability/validate', async (req, res) => {
      try {
        const CapabilityExpander = require('../services/CapabilityExpander');
        const expander = new CapabilityExpander();
        const result = await expander.validate(req.body);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // GET /api/agents/:agentId/config — Get agent config + schema
    application.app.get('/api/agents/:agentId/config', async (req, res) => {
      try {
        const AgentConfigManager = require('../services/AgentConfigManager');
        const configManager = new AgentConfigManager({ redisClient: application.redisClient });
        await configManager.initialize();
        const result = await configManager.getConfig(req.params.agentId);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // PUT /api/agents/:agentId/config — Set agent config values
    application.app.put('/api/agents/:agentId/config', async (req, res) => {
      try {
        const AgentConfigManager = require('../services/AgentConfigManager');
        const configManager = new AgentConfigManager({ redisClient: application.redisClient });
        await configManager.initialize();
        const result = await configManager.setConfig(req.params.agentId, req.body);
        res.json(result);
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    // GET /api/agents/configs/list — List all agents with config schemas
    application.app.get('/api/agents/configs/list', async (req, res) => {
      try {
        const AgentConfigManager = require('../services/AgentConfigManager');
        const configManager = new AgentConfigManager({ redisClient: application.redisClient });
        await configManager.initialize();
        const agents = await configManager.listConfiguredAgents();
        res.json({ agents, count: agents.length });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
}

module.exports = { registerAgentAndProvisioningRoutes };
