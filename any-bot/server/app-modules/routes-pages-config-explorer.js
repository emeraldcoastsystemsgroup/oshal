/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from app.js (1000-line cap decomposition): ticket/health/redis/config UI pages, Plane project config sync API + auto-sync, /api/config, task explorer API, PHASE_67 cost metrics
 */

const path = require('path');
const logger = require('../utils/logger');

// The original code lived in any-bot/server/ — keep filesystem anchors identical.
const SERVER_ROOT = path.join(__dirname, '..');

/**
 * @description Ticket hot-swap chat / health-dashboard / redis-visibility / agent-config UI pages and the Plane Project Config Sync API (sync, dry-run, per-project, status) including the optional auto-sync scheduler.
 * @param {object} application - The Application instance (owns the express app, stores, controllers, and services).
 * @returns {void}
 */
function registerUiAndPlaneConfigRoutes(application) {
    // ═══════════════════════════════════════════
    // Ticket Hot-Swap Chat: Human ↔ Bot conversation on tickets
    // ═══════════════════════════════════════════

    // Serve ticket chat UI
    application.app.get('/tickets', (req, res) => {
      res.sendFile(path.join(SERVER_ROOT, '../ui-enhanced/ticket-chat.html'));
    });

    // Serve health dashboard UI
    application.app.get('/health-dashboard', (req, res) => {
      res.sendFile(path.join(SERVER_ROOT, '../ui-enhanced/health-dashboard.html'));
    });

    // ⭐ PHASE_15: Redis Visibility UI
    application.app.get('/redis-visibility', (req, res) => {
      res.sendFile(path.join(SERVER_ROOT, '../ui-enhanced/redis-visibility.html'));
    });

    // Serve agent config UI
    application.app.get('/config', (req, res) => {
      res.sendFile(path.join(SERVER_ROOT, '../ui-enhanced/agent-config.html'));
    });

    // ═══════════════════════════════════════════
    // PLANE PROJECT CONFIG SYNC — Ensures all projects have correct states, labels, descriptions
    // POST /api/plane-config/sync        — Run sync now (returns full report)
    // POST /api/plane-config/sync/dry-run — Preview what would be created (no changes)
    // GET  /api/plane-config/status      — Show required states + labels (no API calls)
    // POST /api/plane-config/sync/:projectId — Sync a single project by ID
    // ═══════════════════════════════════════════
    (() => {
      let PlaneProjectConfigSync;
      try {
        PlaneProjectConfigSync = require('../services/PlaneProjectConfigSync');
      } catch (e) {
        logger.warn('[PlaneConfigSync] Service not available:', e.message);
        return;
      }

      // POST /api/plane-config/sync — Run full sync across all projects
      application.app.post('/api/plane-config/sync', async (req, res) => {
        try {
          const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;
          const workspaceSlug = req.body?.workspaceSlug || process.env.PLANE_WORKSPACE_SLUG;
          const apiKey = process.env.PLANE_API_KEY;

          if (!apiKey) {
            return res.status(400).json({ error: 'PLANE_API_KEY not configured' });
          }

          logger.info(`[PlaneConfigSync] API triggered sync (dryRun=${dryRun}, workspace=${workspaceSlug})`);

          const sync = new PlaneProjectConfigSync({ dryRun, workspaceSlug });
          const result = await sync.syncAll();

          res.json({
            success: true,
            dryRun,
            ...result,
          });
        } catch (err) {
          logger.error('[PlaneConfigSync] Sync failed:', err.message);
          res.status(500).json({ error: err.message });
        }
      });

      // POST /api/plane-config/sync/dry-run — Preview only
      application.app.post('/api/plane-config/sync/dry-run', async (req, res) => {
        try {
          const workspaceSlug = req.body?.workspaceSlug || process.env.PLANE_WORKSPACE_SLUG;
          const apiKey = process.env.PLANE_API_KEY;

          if (!apiKey) {
            return res.status(400).json({ error: 'PLANE_API_KEY not configured' });
          }

          const sync = new PlaneProjectConfigSync({ dryRun: true, workspaceSlug });
          const result = await sync.syncAll();

          res.json({ success: true, dryRun: true, ...result });
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      });

      // POST /api/plane-config/sync/:projectId — Sync a single project
      application.app.post('/api/plane-config/sync/:projectId', async (req, res) => {
        try {
          const { projectId } = req.params;
          const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;
          const workspaceSlug = req.body?.workspaceSlug || process.env.PLANE_WORKSPACE_SLUG;
          const apiKey = process.env.PLANE_API_KEY;

          if (!apiKey) {
            return res.status(400).json({ error: 'PLANE_API_KEY not configured' });
          }

          const sync = new PlaneProjectConfigSync({ dryRun, workspaceSlug });
          const result = await sync.syncProject(projectId);

          res.json({ success: true, dryRun, ...result });
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      });

      // GET /api/plane-config/status — Return required config (no API calls, instant)
      application.app.get('/api/plane-config/status', (req, res) => {
        try {
          const sync = new PlaneProjectConfigSync({
            apiKey: process.env.PLANE_API_KEY || 'not-configured',
          });
          res.json({
            workspace: process.env.PLANE_WORKSPACE_SLUG || 'devopscloud-00',
            requiredStates: sync.getRequiredStates(),
            requiredLabels: sync.getRequiredLabels(),
            stateCount: sync.getRequiredStates().length,
            labelCount: sync.getRequiredLabels().length,
            usage: {
              syncAll: 'POST /api/plane-config/sync',
              dryRun: 'POST /api/plane-config/sync/dry-run',
              singleProject: 'POST /api/plane-config/sync/:projectId',
              status: 'GET /api/plane-config/status',
            },
          });
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      });

      logger.info('✓ Plane Project Config Sync routes registered: POST /api/plane-config/sync, GET /api/plane-config/status');

      // ⭐ AUTO-SYNC: Start background scheduler if PLANE_CONFIG_SYNC_INTERVAL_MS is set
      // Polls Plane every N minutes, discovers new projects, ensures all have correct
      // states (including "Approval Required"), labels, and descriptions.
      // Set env var: PLANE_CONFIG_SYNC_INTERVAL_MS=300000 (5 minutes)
      // Redis key: 'plane-config-sync:last-run' (24h TTL) — viewable in RedisInsight
      const syncIntervalMs = parseInt(process.env.PLANE_CONFIG_SYNC_INTERVAL_MS || '0');
      if (syncIntervalMs >= 60000 && process.env.PLANE_API_KEY) {
        try {
          const autoSync = new PlaneProjectConfigSync({
            pollIntervalMs: syncIntervalMs,
            redis: application.redisClient || null,
          });
          autoSync.startAutoSync(application.redisClient || null);
          logger.info(`✓ PlaneProjectConfigSync auto-sync started (every ${syncIntervalMs / 60000} min)`);
        } catch (autoSyncErr) {
          logger.warn(`[PlaneConfigSync] Auto-sync startup failed (non-fatal): ${autoSyncErr.message}`);
        }
      } else if (syncIntervalMs > 0) {
        logger.info('[PlaneConfigSync] Auto-sync disabled: PLANE_API_KEY not set or interval < 60s');
      }
    })();
}

/**
 * @description /api/config bot-configuration snapshot, Task Explorer UI + lazy-init API (projects, ticket hierarchy/activity, workspace browsing, metrics summary), and PHASE_67 per-project/per-ticket cost endpoints.
 * @param {object} application - The Application instance (owns the express app, stores, controllers, and services).
 * @returns {void}
 */
function registerConfigAndTaskExplorerRoutes(application) {
    // ⭐ /api/config — JSON endpoint returning this bot's running configuration
    // Available on EVERY bot (not just PM). Shows agent identity, env vars, service connections.
    application.app.get('/api/config', (req, res) => {
      const agentId = process.env.AGENT_ID || 'unknown';
      const config = {
        agent: {
          id: agentId,
          capabilities: (process.env.AGENT_CAPABILITIES || '').split(',').filter(Boolean),
          maxConcurrent: parseInt(process.env.AGENT_MAX_CONCURRENT || '3'),
          scope: process.env.AGENT_SCOPE || 'shared',
          endpointUrl: process.env.AGENT_ENDPOINT_URL || null,
          personaFile: process.env.BOT_PERSONA_FILE || null,
          selectorDescriptor: process.env.AGENT_SELECTOR_DESCRIPTOR || null,
        },
        server: {
          port: parseInt(process.env.PORT || '5000'),
          nodeEnv: process.env.NODE_ENV || 'development',
          logLevel: process.env.LOG_LEVEL || 'info',
          uptime: Math.floor(process.uptime()),
          uptimeHuman: `${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m`,
          nodeVersion: process.version,
          memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        },
        swarm: {
          enabled: process.env.ENABLE_AGENT_SWARM === 'true',
          queueManager: process.env.ENABLE_QUEUE_MANAGER === 'true',
          pollInterval: parseInt(process.env.QUEUE_MANAGER_POLL_INTERVAL || '60000'),
        },
        llm: {
          provider: process.env.LLM_PROVIDER || 'cline-cli',
          model: process.env.DEPLOYMENT_NAME || 'gpt-4o',
          region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'unknown',
          hasAwsKey: !!(process.env.AWS_ACCESS_KEY_ID),
          hasAwsSecret: !!(process.env.AWS_SECRET_ACCESS_KEY),
        },
        services: {
          redis: { host: process.env.REDIS_HOST || 'unknown', port: process.env.REDIS_PORT || '6379' },
          chromadb: { host: process.env.CHROMADB_HOST || 'unknown', port: process.env.CHROMADB_PORT || '8000' },
          plane: {
            dbHost: process.env.PLANE_DB_HOST || 'unknown',
            dbPort: process.env.PLANE_DB_PORT || '5432',
            workspaceSlug: process.env.PLANE_WORKSPACE_SLUG || 'unknown',
          },
        },
        mcp: {
          chromaMcp: process.env.ENABLE_CHROMA_MCP === 'true',
          googleSearch: process.env.ENABLE_GOOGLE_SEARCH === 'true',
          planeMcp: process.env.ENABLE_PLANE_MCP === 'true',
          presentronMcp: process.env.ENABLE_PRESENTRON_MCP === 'true',
        },
        features: {
          planeMonitoring: process.env.ENABLE_PLANE_MONITORING === 'true',
          gitlabIntegration: process.env.ENABLE_GITLAB_INTEGRATION === 'true',
        },
      };
      res.json(config);
    });

    // ═══════════════════════════════════════════════
    // Task Explorer — Ticket Hierarchy & Workspace Browser (PHASE_03 Issue #009)
    // ═══════════════════════════════════════════════
    application.app.get('/task-explorer', (req, res) => {
      res.sendFile(path.join(SERVER_ROOT, '../ui-enhanced/task-explorer.html'));
    });

    // Task Explorer API endpoints - lazy-init controller
    // Works with QueueManager deps if available, or creates standalone PlaneDatabase from env
    const taskExplorerHandler = (method) => async (req, res) => {
      try {
        if (!application._taskExplorerController) {
          const TaskExplorerController = require('../controllers/TaskExplorerController');
          const PlaneDatabase = require('../services/queue-manager/PlaneDatabase');
          const qms = application.queueManagerService;

          let planeDb, agentReg, redis;
          if (qms && qms.planeDb) {
            // Use QueueManager's existing connections
            planeDb = qms.planeDb;
            agentReg = qms.agentRegistry;
            redis = qms.redis;
          } else {
            // Standalone: create PlaneDatabase directly from env vars
            const dbConfig = {
              host: process.env.PLANE_DB_HOST || 'localhost',
              port: parseInt(process.env.PLANE_DB_PORT || '5432'),
              database: process.env.PLANE_DB_NAME || 'plane',
              user: process.env.PLANE_DB_USER || 'plane',
              password: process.env.PLANE_DB_PASSWORD || 'plane',
            };
            planeDb = new PlaneDatabase(dbConfig);
            // AgentRegistry needs Redis — create if REDIS_HOST available
            try {
              const { AgentRegistry } = require('../services/queue-manager');
              const Redis = require('ioredis');
              redis = new Redis({
                host: process.env.REDIS_HOST || 'localhost',
                port: parseInt(process.env.REDIS_PORT || '6379'),
                password: process.env.REDIS_PASSWORD,
                maxRetriesPerRequest: 2,
                lazyConnect: true,
              });
              await redis.connect();
              agentReg = new AgentRegistry(redis);
            } catch (_) {
              agentReg = { getAll: async () => [] };
              redis = null;
            }
          }

          application._taskExplorerController = new TaskExplorerController({
            planeDatabase: planeDb,
            agentRegistry: agentReg,
            redisClient: redis
          });
        }
        await application._taskExplorerController[method](req, res);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    };

    application.app.get('/api/v1/projects', taskExplorerHandler('getProjects'));
    application.app.get('/api/v1/tickets/hierarchy', taskExplorerHandler('getTicketHierarchy'));
    application.app.get('/api/v1/tickets/:id/activity', taskExplorerHandler('getTicketActivity'));
    application.app.get('/api/v1/workspace/browse', taskExplorerHandler('getAllWorkspaces'));
    application.app.get('/api/v1/workspace/:ticketId/files', taskExplorerHandler('getWorkspaceFiles'));
    application.app.get('/api/v1/workspace/:ticketId/files/*', taskExplorerHandler('getFileContent'));
    application.app.get('/api/v1/metrics/summary', taskExplorerHandler('getMetricsSummary'));

    // ⭐ PHASE_67: Per-project and per-ticket cost API endpoints
    application.app.get('/api/v1/metrics/projects', async (req, res) => {
      try {
        if (!application.queueManagerService || !application.queueManagerService.agentMetrics) {
          return res.status(503).json({ error: 'AgentMetricsService not available' });
        }
        const projectId = req.query.projectId;
        if (projectId) {
          const cost = await application.queueManagerService.agentMetrics.getProjectCost(projectId);
          return res.json({ success: true, data: cost || { projectId, totalCost: 0, totalTokens: 0, ticketCount: 0 } });
        }
        const allCosts = await application.queueManagerService.agentMetrics.getAllProjectCosts();
        res.json({ success: true, data: allCosts });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    application.app.get('/api/v1/metrics/tickets/:ticketId/cost', async (req, res) => {
      try {
        if (!application.queueManagerService || !application.queueManagerService.agentMetrics) {
          return res.status(503).json({ error: 'AgentMetricsService not available' });
        }
        const { ticketId } = req.params;
        const includeSubtasks = req.query.includeSubtasks !== 'false';
        
        // Get subtask IDs from Plane DB if needed
        let subtaskIds = [];
        if (includeSubtasks && application.queueManagerService.planeDb) {
          try {
            const { Client } = require('pg');
            const client = application.queueManagerService.planeDb.createClient();
            await client.connect();
            const result = await client.query('SELECT id FROM issues WHERE parent_id = $1 AND deleted_at IS NULL', [ticketId]);
            subtaskIds = result.rows.map(r => r.id);
            await client.end();
          } catch (_) {}
        }
        
        const cost = await application.queueManagerService.agentMetrics.getTicketCost(ticketId, { subtaskIds });
        res.json({ success: true, data: cost || { ticketId, totalCost: 0, totalTokens: 0, realCostData: false } });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
}

module.exports = { registerUiAndPlaneConfigRoutes, registerConfigAndTaskExplorerRoutes };
