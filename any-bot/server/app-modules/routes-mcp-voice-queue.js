/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from app.js (1000-line cap decomposition): MCP discover/execute/resources, voice + presentations, GitLab save, Bull Board + queue monitor + agent schedules, health-dashboard registry, agent metrics
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-04: require exact service-bound user, agent, task, tool allowlist, and operation scope at the unified MCP proxy; retire unauthorizable raw resource reads.
 */

const multer = require('multer');
const VoiceController = require('../controllers/VoiceController');
const logger = require('../utils/logger');
const { trustedServiceUserSub } = require('../services/codebase/swarm-execute-auth');

/**
 * @description MCP tool discovery/execution/resource routes, voice transcribe/synthesize + presentation routes, manual GitLab save, Bull Board mount, PHASE_22 dynamic node registry, PHASE_21 agent metrics, queue monitor job APIs, and agent schedule CRUD/trigger routes. The Bull Board / QueueMonitorService / ScheduleController requires stay function-level (they open Redis connections at require time).
 * @param {object} application - The Application instance (owns the express app, stores, controllers, and services).
 * @returns {void}
 */
function registerMcpVoiceAndQueueRoutes(application) {
    // ⭐ ISSUE #026: Remediation history endpoint removed
    // AutonomousRemediator permanently disabled - created 1525+ noise tickets
    // See archive/health-checks-disabled-2026-02-19/ for archived code

    application.app.post('/api/mcp/discover', async (req, res) => {
      try {
        if (!application.mcpService) {
          return res.status(503).json({ error: 'MCP service not available' });
        }

        const results = await application.mcpService.discoverAllTools();
        res.json({
          success: true,
          results,
        });
      } catch (err) {
        logger.error(`MCP tool discovery failed: ${err.message}`);
        res.status(500).json({
          error: err.message,
        });
      }
    });

    // Get tools for specific MCP server
    application.app.get('/api/mcp/servers/:serverName/tools', async (req, res) => {
      try {
        if (!application.mcpService) {
          return res.status(503).json({ error: 'MCP service not available' });
        }

        const { serverName } = req.params;
        let tools = null;
        if (application.mcpService && application.mcpService.servers && application.mcpService.servers.has(serverName)) {
          tools = typeof application.mcpService.getServerTools === "function" ? application.mcpService.getServerTools(serverName) : [];
        } else if (application.mcpServiceHTTP && application.mcpServiceHTTP.servers && application.mcpServiceHTTP.servers.has(serverName)) {
          tools = typeof application.mcpServiceHTTP.getServerTools === "function" ? application.mcpServiceHTTP.getServerTools(serverName) : [];
        }

        if (!tools) {
          return res.status(404).json({ error: 'Server not found or no tools available' });
        }

        res.json({
          success: true,
          serverName,
          tools,
          count: tools.length,
        });
      } catch (err) {
        logger.error(`Get server tools failed: ${err.message}`);
        res.status(500).json({
          error: err.message,
        });
      }
    });

    // Execute MCP tool on specific server
    application.app.post('/api/mcp/servers/:serverName/tools/:toolName', async (req, res) => {
      try {
        const { serverName, toolName } = req.params;
        const {
          arguments: toolArgs,
          agentId,
          taskId,
          allowedTools,
          authorizedScopes,
          taskWorkspace,
        } = req.body || {};
        const userSub = trustedServiceUserSub(req);
        if (!userSub) return res.status(403).json({ error: 'MCP caller identity is required' });
        if (!application.mcpProxy) {
          return res.status(503).json({ error: 'MCP authorization proxy not available' });
        }
        if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) {
          return res.status(400).json({ error: 'arguments must be an object' });
        }

        // ⭐ PHASE_70: Route to correct MCP service (stdio or HTTP) based on serverName
        const result = await application.mcpProxy.executeTool(serverName, toolName, toolArgs, {
          userSub,
          agentId,
          taskId,
          allowedTools,
          authorizedScopes,
          taskWorkspace,
        });

        res.json({
          success: true,
          serverName,
          toolName,
          result,
        });
      } catch (err) {
        logger.error(`Execute MCP tool failed: ${err.message}`);
        const authorizationDenied = err.code === 'MCP_TOOL_AUTHORIZATION_DENIED'
          || /requires approval/i.test(String(err.message));
        res.status(authorizationDenied ? 403 : 500).json({
          error: authorizationDenied ? 'MCP tool execution denied' : err.message,
          serverName: req.params.serverName,
          toolName: req.params.toolName,
        });
      }
    });

    // Get resources for specific MCP server
    application.app.get('/api/mcp/servers/:serverName/resources', async (req, res) => {
      try {
        if (!application.mcpService) {
          return res.status(503).json({ error: 'MCP service not available' });
        }

        const { serverName } = req.params;
        const resources = application.mcpService.getServerResources(serverName);

        if (!resources) {
          return res.status(404).json({ error: 'Server not found or no resources available' });
        }

        res.json({
          success: true,
          serverName,
          resources,
          count: resources.length,
        });
      } catch (err) {
        logger.error(`Get server resources failed: ${err.message}`);
        res.status(500).json({
          error: err.message,
        });
      }
    });

    // Access specific resource on MCP server
    application.app.get('/api/mcp/servers/:serverName/resources/:uri', (_req, res) => {
      res.status(410).json({
        error: 'direct MCP resource access is retired; use a scoped ToolRegistry operation',
      });
    });

    // Configure multer for audio uploads
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: 10 * 1024 * 1024, // 10MB max
      },
      fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('audio/')) {
          cb(null, true);
        } else {
          cb(new Error('Only audio files are allowed'));
        }
      },
    });

    // Voice endpoints
    // POST /api/transcribe - Transcribe audio to text
    application.app.post('/api/transcribe', upload.single('audio'), VoiceController.transcribe.bind(VoiceController));

    // POST /api/synthesize - Synthesize text to speech
    application.app.post('/api/synthesize', VoiceController.synthesize.bind(VoiceController));

    // GET /api/voices - Get available TTS voices
    application.app.get('/api/voices', VoiceController.getVoices.bind(VoiceController));

    // Presentation endpoints
    // GET /api/presentations - List all presentations
    application.app.get('/api/presentations', VoiceController.listPresentations.bind(VoiceController));

    // GET /api/presentations/:id - Get specific presentation with all slides
    application.app.get('/api/presentations/:id', VoiceController.getPresentation.bind(VoiceController));

    // GET /api/presentations/:id/slides - Get presentation slides (legacy)
    application.app.get('/api/presentations/:id/slides', VoiceController.getSlides.bind(VoiceController));

    // Manual GitLab save endpoint
    application.app.post('/api/tasks/:taskId/save-to-gitlab', async (req, res) => {
      try {
        const { taskId } = req.params;
        const task = await application.taskController.getTask(taskId);
        
        if (!task) {
          return res.status(404).json({ error: 'Task not found' });
        }

        const workspaceDir = task.workspace_dir;
        
        // Execute git commands
        const { exec } = require('child_process');
        const util = require('util');
        const execAsync = util.promisify(exec);
        
        await execAsync('git add .', { cwd: workspaceDir });
        await execAsync(`git commit -m "Manual save for task ${taskId}" || echo "Nothing to commit"`, { cwd: workspaceDir });
        await execAsync('git push origin main', { cwd: workspaceDir });
        
        const gitlabUrl = task.gitlab_url || `https://gitlab.example.com/oshal/agent-workspaces/${taskId}`;
        
        logger.info(`Manual GitLab save completed for ${taskId}`);
        
        res.json({
          success: true,
          message: 'Workspace saved to GitLab',
          gitlabUrl,
        });
      } catch (err) {
        logger.error(`Manual GitLab save failed: ${err.message}`);
        res.status(500).json({
          error: err.message,
        });
      }
    });

    // Queue monitoring endpoints
    const { getBullBoardAdapter } = require('../middleware/bull-board');
    const queueMonitorService = require('../services/QueueMonitorService');
    const scheduleService = require('../services/ScheduleService');
    const scheduleController = require('../controllers/ScheduleController');

    // Mount Bull Board UI
    try {
      const bullBoardAdapter = getBullBoardAdapter();
      application.app.use('/queue-dashboard', bullBoardAdapter.getRouter());
      logger.info('✓ Bull Board mounted at /queue-dashboard');
    } catch (err) {
      logger.warn(`Failed to mount Bull Board: ${err.message}`);
    }

    // ⭐ PHASE_22 Issue #015: Dynamic Node Registry API
    // Merges AgentRegistry + dynamic nodes + static infra into ONE unified registry
    // Dashboard fetches this instead of hardcoding 100+ NODES[]
    application.app.get('/api/health-dashboard/registry', async (req, res) => {
      try {
        const nodes = [];
        const seenPorts = new Set();

        // ── Known compose port mapping (fallback when agents don't store port) ──
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
        };

        // ── Source 1: AgentRegistry (Redis) — every bot that registered ──
        if (application.queueManagerService && application.queueManagerService.agentRegistry) {
          try {
            const agents = await application.queueManagerService.agentRegistry.getAll();
            for (const agent of agents) {
              const agentId = agent.agent_id || 'unknown';
              const port = agent.port ? parseInt(agent.port) : (KNOWN_AGENT_PORTS[agentId] || null);
              if (!port) continue;
              const caps = Array.isArray(agent.capabilities)
                ? agent.capabilities
                : (agent.capabilities ? JSON.parse(agent.capabilities) : []);
              nodes.push({
                name: agentId.startsWith('swarm-') ? agentId : `swarm-${agentId}`,
                port,
                emoji: '🤖',
                type: 'agent',
                category: 'agent',
                capabilities: caps,
                source: 'agent-registry',
                status: agent.status || 'unknown',
                links: [
                  { label: '🏠 UI', url: `http://localhost:${port}` },
                  { label: '📊 Dashboard', url: `http://localhost:${port}/dashboard` },
                  { label: '💬 Chat', url: `http://localhost:${port}/tickets` },
                  { label: '⚙️ Config', url: `http://localhost:${port}/config` },
                ],
              });
              seenPorts.add(port);
            }
          } catch (regErr) {
            logger.warn(`[Registry] AgentRegistry read failed: ${regErr.message}`);
          }
        }

        // ── Source 2: Dynamic nodes (Redis — factory-deployed bots) ──
        if (application.redisClient) {
          try {
            const existing = await application.redisClient.get('health-dashboard:dynamic-nodes');
            const dynamicNodes = existing ? JSON.parse(existing) : [];
            for (const dn of dynamicNodes) {
              if (seenPorts.has(dn.port)) continue;
              nodes.push({
                name: dn.name,
                port: dn.port,
                emoji: dn.emoji || '🤖',
                type: dn.type || 'agent',
                category: 'agent',
                source: 'dynamic-registration',
                links: dn.links || [
                  { label: '🏠 UI', url: `http://localhost:${dn.port}` },
                  { label: '📊 Dashboard', url: `http://localhost:${dn.port}/dashboard` },
                ],
              });
              seenPorts.add(dn.port);
            }
          } catch (dynErr) {
            logger.warn(`[Registry] Dynamic nodes read failed: ${dynErr.message}`);
          }
        }

        // ── Source 3: Static infrastructure (non-agent services) ──
        const staticInfra = [
          { name: 'oshal-any-bot (Primary UI)', port: 3000, emoji: '🖥️', type: 'agent', category: 'agent',
            links: [
              { label: '🏠 UI', url: 'http://localhost:3000' },
              { label: '📊 Dashboard', url: 'http://localhost:3000/dashboard' },
              { label: '🏥 Health', url: 'http://localhost:3000/health-dashboard' },
              { label: '📦 Queues', url: 'http://localhost:3000/queue-dashboard' },
              { label: '🎫 Tickets', url: 'http://localhost:3000/tickets' },
            ] },
          { name: 'Google Search MCP', port: 8080, emoji: '🔍', type: 'mcp', category: 'mcp', healthPath: '/health',
            links: [{ label: '❤️ Health', url: 'http://localhost:8080/health' }, { label: '🔧 Tools', url: 'http://localhost:8080/tools' }] },
          { name: 'Presentron MCP', port: 8081, emoji: '📊', type: 'mcp', category: 'mcp', healthPath: '/health',
            links: [{ label: '🎬 Presentron', url: 'http://localhost:8081' }, { label: '❤️ Health', url: 'http://localhost:8081/health' }] },
          { name: 'ChromaDB MCP', port: 8091, emoji: '🧠', type: 'mcp', category: 'mcp', healthPath: '/health',
            links: [{ label: '❤️ Health', url: 'http://localhost:8091/health' }, { label: '🔧 Tools', url: 'http://localhost:8091/tools' }] },
          { name: 'Plane MCP (stdio)', port: 3002, emoji: '✈️', type: 'mcp', category: 'mcp', noHttp: true, note: 'stdio server' },
          { name: 'Redis', port: 6379, emoji: '🗄️', type: 'service', category: 'service', noHttp: true },
          { name: 'Plane Web UI', port: 3001, emoji: '✈️', type: 'plane', category: 'plane', healthPath: '/', htmlHealthCheck: true,
            links: [{ label: '✈️ Plane UI', url: 'http://localhost:3001' }] },
          { name: 'Plane Proxy (nginx)', port: 80, emoji: '🌐', type: 'plane', category: 'plane', healthPath: '/', htmlHealthCheck: true,
            links: [{ label: '🌐 Proxy', url: 'http://localhost:80' }] },
          { name: 'Plane API', port: 8000, emoji: '⚡', type: 'plane', category: 'plane', noHttp: true, note: 'internal only' },
          { name: 'Plane Worker (Celery)', port: null, emoji: '🔄', type: 'plane', category: 'plane', noHttp: true, note: 'background worker' },
          { name: 'Plane Beat Worker', port: null, emoji: '⏰', type: 'plane', category: 'plane', noHttp: true, note: 'scheduler' },
          { name: 'Plane Live', port: null, emoji: '📡', type: 'plane', category: 'plane', noHttp: true, note: 'websockets' },
          { name: 'Plane Space', port: null, emoji: '🌍', type: 'plane', category: 'plane', noHttp: true, note: 'public pages' },
          { name: 'Plane Admin', port: null, emoji: '🔑', type: 'plane', category: 'plane', noHttp: true, note: 'admin panel' },
        ];

        for (const si of staticInfra) {
          if (si.port && seenPorts.has(si.port)) continue; // skip if already from AgentRegistry
          nodes.push({ ...si, source: 'static-infra' });
          if (si.port) seenPorts.add(si.port);
        }

        // ── Auto-build DOCKER_SERVICE_MAP from merged nodes ──
        const serviceMap = {};
        for (const n of nodes) {
          if (!n.port) continue;
          if (n.category === 'agent' && n.port >= 3010) {
            serviceMap[n.port] = 'host.docker.internal';
          } else if (n.category === 'mcp') {
            // MCP servers share compose network — use container name
            const containerNames = { 8080: 'google-search-mcp', 8081: 'presentron-mcp', 8091: 'chroma-mcp' };
            serviceMap[n.port] = containerNames[n.port] || 'host.docker.internal';
          } else if (n.port === 3000) {
            serviceMap[n.port] = 'localhost';
          } else if (n.port === 6379) {
            serviceMap[n.port] = 'redis';
          } else {
            serviceMap[n.port] = 'host.docker.internal';
          }
        }

        // Update in-memory DOCKER_SERVICE_MAP so proxy-health picks up new bots
        if (application._dockerServiceMap) {
          Object.assign(application._dockerServiceMap, serviceMap);
        }

        res.json({
          success: true,
          nodes,
          serviceMap,
          count: nodes.length,
          sources: { agentRegistry: 'redis', dynamicNodes: 'redis', staticInfra: 'hardcoded' },
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error(`[Registry] Failed: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // ⭐ PHASE_21 GAP B: Agent Performance Metrics API
    application.app.get('/api/v1/metrics/agents', async (req, res) => {
      try {
        if (!application.queueManagerService || !application.queueManagerService.agentMetrics) {
          return res.status(503).json({ error: 'AgentMetricsService not available' });
        }
        const agentId = req.query.agentId;
        if (agentId) {
          const metrics = await application.queueManagerService.agentMetrics.getAgentMetrics(agentId);
          return res.json(metrics || { error: 'No metrics for agent', agentId });
        }
        const allMetrics = await application.queueManagerService.agentMetrics.getAllAgentMetrics();
        const summary = await application.queueManagerService.agentMetrics.getSummary();
        res.json({ agents: allMetrics, summary });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get queue metrics
    application.app.get('/api/v1/queue/metrics', async (req, res) => {
      try {
        const metrics = await queueMonitorService.getMetrics();
        res.json(metrics);
      } catch (error) {
        logger.error(`Get queue metrics failed: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // Get job details by ID
    application.app.get('/api/v1/queue/jobs/:jobId', async (req, res) => {
      try {
        const job = await queueMonitorService.getJobDetails(req.params.jobId);
        if (!job) {
          return res.status(404).json({ error: 'Job not found' });
        }
        res.json(job);
      } catch (error) {
        logger.error(`Get job details failed: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // List all jobs with pagination
    application.app.get('/api/v1/queue/jobs', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        const result = await queueMonitorService.getAllJobs(limit, offset);
        res.json(result);
      } catch (error) {
        logger.error(`List jobs failed: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // Retry a failed job
    application.app.post('/api/v1/queue/jobs/:jobId/retry', async (req, res) => {
      try {
        const result = await queueMonitorService.retryJob(req.params.jobId);
        res.json(result);
      } catch (error) {
        logger.error(`Retry job failed: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // Cancel a queued job
    application.app.post('/api/v1/queue/jobs/:jobId/cancel', async (req, res) => {
      try {
        const result = await queueMonitorService.cancelJob(req.params.jobId);
        res.json(result);
      } catch (error) {
        logger.error(`Cancel job failed: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // Clear all failed jobs
    application.app.post('/api/v1/queue/clear-failed', async (req, res) => {
      try {
        const result = await queueMonitorService.clearFailedJobs();
        res.json(result);
      } catch (error) {
        logger.error(`Clear failed jobs failed: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // Cleanup old jobs
    application.app.post('/api/v1/queue/cleanup', async (req, res) => {
      try {
        const retentionHours = parseInt(req.body.retentionHours) || 72;
        const result = await queueMonitorService.cleanupOldJobs(retentionHours);
        res.json(result);
      } catch (error) {
        logger.error(`Cleanup old jobs failed: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // Agent scheduling endpoints
    // Create a new schedule
    application.app.post('/api/v1/agent/schedule-task', scheduleController.createSchedule.bind(scheduleController));

    // Get all schedules
    application.app.get('/api/v1/agent/schedules', scheduleController.getAllSchedules.bind(scheduleController));

    // Get specific schedule
    application.app.get('/api/v1/agent/schedules/:id', scheduleController.getSchedule.bind(scheduleController));

    // Update schedule
    application.app.put('/api/v1/agent/schedules/:id', scheduleController.updateSchedule.bind(scheduleController));

    // Pause schedule
    application.app.post('/api/v1/agent/schedules/:id/pause', scheduleController.pauseSchedule.bind(scheduleController));

    // Resume schedule
    application.app.post('/api/v1/agent/schedules/:id/resume', scheduleController.resumeSchedule.bind(scheduleController));

    // Delete schedule
    application.app.delete('/api/v1/agent/schedules/:id', scheduleController.deleteSchedule.bind(scheduleController));

    // ⭐ PHASE_15: Trigger schedule immediately (no pause required)
    application.app.post('/api/v1/agent/schedules/:id/trigger', scheduleController.triggerSchedule.bind(scheduleController));

    // Execute scheduled task (internal callback from worker)
    application.app.post('/api/v1/agent/execute-scheduled-task', scheduleController.executeScheduledTask.bind(scheduleController));
}

module.exports = { registerMcpVoiceAndQueueRoutes };
