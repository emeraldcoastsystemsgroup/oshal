/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from app.js (1000-line cap decomposition): queue-manager startup, agent swarm registration (PM + worker paths), roll-call/heartbeat listeners, AGENT_MCP_TOOLS registration, SelfHealingScheduler
 */

const path = require('path');
const Redis = require('ioredis');
const { QueueManagerService } = require('../services/queue-manager');
const { UnifiedMCPProxy } = require('./unified-mcp-proxy');
const logger = require('../utils/logger');
const config = require('../utils/config');

// The original code lived in any-bot/server/ — keep filesystem anchors identical.
const SERVER_ROOT = path.join(__dirname, '..');

/**
 * @description Queue Manager Service startup (ENABLE_QUEUE_MANAGER path) or direct worker-agent Redis registration (ENABLE_AGENT_SWARM path), including DynamicToolManager, PeerCommunicationService, PM self-registration, provisioning, roll-call + heartbeat listeners, AGENT_MCP_TOOLS tool loading, and the SelfHealingScheduler gate. Mutates the Application instance exactly as the original initialize() body did.
 * @param {object} application - The Application instance (owns the express app, stores, controllers, and services).
 * @returns {Promise<void>}
 */
async function initializeSwarmRuntime(application) {
      // Initialize Queue Manager Service (Multi-Agent Routing)
      if (process.env.ENABLE_QUEUE_MANAGER === 'true') {
        logger.info('Initializing Queue Manager Service...');
        
        // Initialize Redis client for agent registry
        const redisClient = new Redis({
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379'),
          password: process.env.REDIS_PASSWORD,
          retryStrategy: (times) => {
            const delay = Math.min(times * 50, 2000);
            return delay;
          }
        });

        // Store Redis client on instance so config endpoints + ProvisioningManager can use it
        application.redisClient = redisClient;

        // Test Redis connection
        try {
          await redisClient.ping();
          logger.info('✓ Redis connection successful');
        } catch (err) {
          logger.warn(`Redis connection failed: ${err.message}`);
          logger.warn('Queue Manager will be disabled without Redis');
        }

        // ⭐ PHASE_62: Apply saved LLM config on startup (per-bot Redis key)
        // ⭐ FIX: Skip if ANTHROPIC_API_KEY is set — setup-cline-auth.sh already
        //   configured the correct Anthropic provider. Applying a stale Redis-saved
        //   Bedrock config here would overwrite the working Anthropic credentials,
        //   causing authentication failures (Issue: cline-cli auth failure).
        if (process.env.ANTHROPIC_API_KEY) {
          logger.info(`[PHASE_62] Skipping saved LLM config — ANTHROPIC_API_KEY is set (setup script handles config)`);
        } else {
          try {
            const agentId = process.env.AGENT_ID || 'any-bot';
            const savedConfig = await redisClient.get(`config:llm-provider:${agentId}`);
            if (savedConfig) {
              const cfg = JSON.parse(savedConfig);
              const registry = require('../services/llm/LLMProviderRegistry');
              const clineConfig = registry.buildClineConfig(cfg.provider, cfg.model, cfg.credentials || {});
              const globalState = registry.buildGlobalState(cfg.provider, cfg.model, cfg.credentials || {});
              if (clineConfig) {
                const fs = require('fs');
                const homeDir = process.env.HOME || '/home/node';
                const clineDir = `${homeDir}/.cline`;
                const configPath = `${clineDir}/config.json`;
                
                // CRITICAL FIX: Check if config.json already exists before overwriting
                // This prevents overwriting a working Anthropic configuration with saved Bedrock config
                if (!fs.existsSync(configPath)) {
                  fs.mkdirSync(`${clineDir}/data`, { recursive: true });
                  fs.writeFileSync(configPath, JSON.stringify(clineConfig, null, 2));
                  fs.writeFileSync(`${clineDir}/data/globalState.json`, JSON.stringify(globalState, null, 2));
                  logger.info(`[PHASE_62] ✅ Applied saved LLM config for ${agentId}: ${cfg.provider} / ${cfg.model}`);
                } else {
                  logger.info(`[PHASE_62] Config already exists at ${configPath}, preserving existing configuration`);
                }
              }
            }
          } catch (startupConfigErr) {
            logger.warn(`[PHASE_62] Failed to apply saved LLM config (non-fatal): ${startupConfigErr.message}`);
          }
        }

        // Initialize Queue Manager
        try {
          application.queueManagerService = new QueueManagerService(
            null, // Will use default Plane DB config from env
            redisClient,
            new UnifiedMCPProxy(application.mcpService, application.mcpServiceHTTP),
            application.taskController // Pass TaskController for agent processing
          );

          // NOTE: No mock agents — real agents self-register via AgentBootstrap
          // Each swarm container registers itself with correct capabilities from env vars

          // Start Queue Manager (may fail if Plane DB not reachable - non-fatal)
          try {
            await application.queueManagerService.start();
            logger.info('✓ Queue Manager Service started successfully');

            // Initialize DynamicToolManager for runtime tool registration
            const DynamicToolManager = require('../services/queue-manager/DynamicToolManager');
            application.dynamicToolManager = new DynamicToolManager(
              new UnifiedMCPProxy(application.mcpService, application.mcpServiceHTTP),
              application.toolRegistry,
              redisClient
            );
            await application.dynamicToolManager.initialize();
            logger.info('✓ DynamicToolManager initialized');

            // ⭐ PHASE_29: Initialize PeerCommunicationService for TaskController
            // Enables dashboard chat to use PEER commands (HELP_REQUEST, KNOWLEDGE_SHARE, DIRECT_MESSAGE)
            try {
              const PeerCommunicationService = require('../services/queue-manager/PeerCommunicationService');
              application.taskController.peerCommunication = new PeerCommunicationService({
                agentRegistry: application.queueManagerService.agentRegistry,
                redis: redisClient,
                meshBroadcast: application.queueManagerService.meshBroadcast,
                agentId: process.env.AGENT_ID || 'project-manager',
              });
              logger.info('✓ PeerCommunicationService initialized for TaskController (dashboard chat PEER support)');
            } catch (peerErr) {
              logger.warn(`PeerCommunicationService init failed (dashboard PEER commands disabled): ${peerErr.message}`);
            }

            // ⭐ PHASE_32 Issue #028: Wire QueueManagerService to TaskController for swarm invocation
            // Enables natural language swarm session creation from dashboard chat
            application.taskController.queueManagerService = application.queueManagerService;
            logger.info('✓ QueueManagerService wired to TaskController for swarm invocation');

            // ⭐ PHASE_61 Defect #2: Flush stale dynamic-nodes on startup
            // Remove any dynamic-node entries whose agent_id is NOT in the live AgentRegistry.
            // This clears ghost entries from old provisioning attempts.
            if (application.redisClient) {
              try {
                const existing = await application.redisClient.get('health-dashboard:dynamic-nodes');
                if (existing) {
                  const dynamicNodes = JSON.parse(existing);
                  const liveAgents = await application.queueManagerService.agentRegistry.getAll();
                  const liveNames = new Set(liveAgents.map(a => (a.agent_id || a.name || '').toLowerCase()));
                  const flushed = dynamicNodes.filter(n => liveNames.has((n.name || '').toLowerCase()));
                  const removedCount = dynamicNodes.length - flushed.length;
                  if (removedCount > 0) {
                    await application.redisClient.set('health-dashboard:dynamic-nodes', JSON.stringify(flushed), 'EX', 86400);
                    logger.info(`[HealthDashboard] Startup flush: removed ${removedCount} stale dynamic-node(s), kept ${flushed.length}`);
                  } else {
                    logger.info(`[HealthDashboard] Startup flush: all ${dynamicNodes.length} dynamic-node(s) are live, no flush needed`);
                  }
                }
              } catch (flushErr) {
                logger.warn(`[HealthDashboard] Startup flush failed (non-fatal): ${flushErr.message}`);
              }
            }
          } catch (qmStartErr) {
            logger.warn(`Queue Manager polling disabled (Plane DB unreachable): ${qmStartErr.message}`);
            logger.warn('Agent registration will still proceed - QM polling will retry when DB is available');
          }

          // Initialize Agent Swarm Mode (if enabled) - INDEPENDENT of QM start success
          // AgentBootstrap only needs Redis (already connected above), not Plane DB
          if (process.env.ENABLE_AGENT_SWARM === 'true') {
            const AgentBootstrap = require('../services/AgentBootstrap');
            application.agentBootstrap = new AgentBootstrap();

            try {
              const result = await application.agentBootstrap.initialize(application.queueManagerService);
              
              if (result.success) {
                logger.info('✓ Agent Swarm Mode: Registered as real agent');
                
                // PHASE_65: Heartbeat enabled — updates last_heartbeat timestamp every 30s
                application.agentBootstrap.startHeartbeat(30000);

                // Auto-deploy agent-factory-created personas as containers
                // Only runs on project-manager to avoid duplicate deployments
                const agentId = process.env.AGENT_ID || '';
                if (agentId === 'project-manager') {
                  try {
                    const PersonaAutoDeployer = require('../services/PersonaAutoDeployer');
                    application.personaAutoDeployer = new PersonaAutoDeployer();
                    const deployResult = await application.personaAutoDeployer.initialize();
                    if (deployResult.deployed && deployResult.deployed.length > 0) {
                      logger.info(`✓ PersonaAutoDeployer: ${deployResult.deployed.length} new bots deployed`);
                    }
                  } catch (deployErr) {
                    logger.warn(`PersonaAutoDeployer error: ${deployErr.message}`);
                  }

                  // ═══════════════════════════════════════════════════════════
                  // PHASE_20 GAP D: Deploy All Persona Bots via agent-factory-bot
                  // 13 bots have YAML personas but no containers. POST deployAll
                  // to agent-factory-bot (port 3020) which has Docker socket access.
                  // PersonaAutoDeployer above only works locally; this delegates to
                  // the factory bot which can actually create Docker containers.
                  // ═══════════════════════════════════════════════════════════
                  setTimeout(async () => {
                    try {
                      const http = require('http');
                      const factoryHost = process.env.AGENT_FACTORY_HOST || 'host.docker.internal';
                      const factoryPort = parseInt(process.env.AGENT_FACTORY_PORT || '3020');
                      const postData = JSON.stringify({ deployAll: true });
                      
                      const deployAllResult = await new Promise((resolve, reject) => {
                        const req = http.request({
                          hostname: factoryHost,
                          port: factoryPort,
                          path: '/api/agents/deploy',
                          method: 'POST',
                          headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(postData),
                          },
                          timeout: 60000, // 60s — deploying 13 containers takes time
                        }, (res) => {
                          let data = '';
                          res.on('data', chunk => { data += chunk; });
                          res.on('end', () => {
                            try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
                          });
                        });
                        req.on('error', reject);
                        req.on('timeout', () => { req.destroy(); reject(new Error('Deploy all timeout')); });
                        req.write(postData);
                        req.end();
                      });
                      
                      if (deployAllResult.deployed && deployAllResult.deployed.length > 0) {
                        logger.info(`✅ PHASE_20 GAP D: Deployed ${deployAllResult.deployed.length} persona bots via agent-factory-bot: ${deployAllResult.deployed.map(d => d.agentId || d).join(', ')}`);
                      } else if (deployAllResult.summary) {
                        logger.info(`✅ PHASE_20 GAP D: Deploy all result: ${deployAllResult.summary}`);
                      } else {
                        logger.info(`ℹ️  PHASE_20 GAP D: Deploy all — no new bots to deploy (all personas already have containers)`);
                      }
                      
                      if (deployAllResult.errors && deployAllResult.errors.length > 0) {
                        logger.warn(`⚠️  PHASE_20 GAP D: ${deployAllResult.errors.length} deploy errors: ${deployAllResult.errors.map(e => e.agentId || e).join(', ')}`);
                      }
                    } catch (deployAllErr) {
                      logger.info(`ℹ️  PHASE_20 GAP D: agent-factory-bot deploy all skipped: ${deployAllErr.message} (factory bot may not be running yet)`);
                    }
                  }, 15000); // 15s delay — wait for agent-factory-bot to start

                  // ═══════════════════════════════════════════════════════════
                  // PHASE_20 GAP A: Automated Research → RAG Loop
                  // Register a 6-hour cron schedule for research-bot to:
                  // 1. Scan recent ticket failures/escalations
                  // 2. Identify knowledge gaps
                  // 3. Research and ingest docs into ChromaDB
                  // Uses existing agent-scheduler-worker infrastructure
                  // ═══════════════════════════════════════════════════════════
                  setTimeout(async () => {
                    try {
                      // ⭐ PHASE_15 FIX: Check if research_rag_loop already exists before creating
                      // Prevents duplicate schedules accumulating on every PM restart
                      let existingSchedules = [];
                      try {
                        const http = require('http');
                        const pmPort = parseInt(process.env.PORT || '5000');
                        const checkResult = await new Promise((resolve, reject) => {
                          const req = http.request({
                            hostname: 'localhost', port: pmPort,
                            path: '/api/v1/agent/schedules', method: 'GET',
                            timeout: 5000,
                          }, (res) => {
                            let data = '';
                            res.on('data', chunk => { data += chunk; });
                            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
                          });
                          req.on('error', reject);
                          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                          req.end();
                        });
                        existingSchedules = (checkResult.schedules || []).map(s => s.taskType);
                      } catch (checkErr) {
                        logger.debug(`[PHASE_15] Could not check existing schedules: ${checkErr.message}`);
                      }

                      if (existingSchedules.includes('research_rag_loop')) {
                        logger.info('ℹ️  PHASE_20 GAP A: research_rag_loop already scheduled — skipping duplicate creation');
                        return;
                      }

                      const http = require('http');
                      const schedulePayload = JSON.stringify({
                        name: 'research-rag-loop',
                        description: 'Automated Research → RAG Loop: research-bot scans ticket failures, identifies knowledge gaps, downloads docs, ingests into ChromaDB',
                        schedule: '0 6 * * *', // Once daily at 6am
                        taskType: 'research_rag_loop',
                        taskData: {
                          action: 'research_and_ingest',
                          targetAgent: 'research-bot',
                          prompt: `You are research-bot running an automated knowledge gap analysis.

## Research → RAG Loop Protocol

1. **Scan Recent Failures:** Query the swarm-memory ChromaDB collection for tickets with gate failures or escalations in the last 24 hours.
2. **Identify Knowledge Gaps:** Analyze failure patterns — what topics did bots struggle with? What domains had the most escalations?
3. **Research Solutions:** Use Google Search MCP to find authoritative documentation, guides, and best practices for the identified knowledge gaps.
4. **Ingest into RAG:** For each relevant document found, use the rag-upload-worker to ingest it into ChromaDB so future ticket processing benefits from this knowledge.
5. **Report:** Summarize what was researched, what was ingested, and what gaps remain.

Focus on ACTIONABLE knowledge — documentation that directly helps agents handle similar tickets better next time.

Use attempt_completion with your research report.`,
                        },
                        enabled: true,
                      });

                      const pmPort = parseInt(process.env.PORT || '5000');
                      const scheduleResult = await new Promise((resolve, reject) => {
                        const req = http.request({
                          hostname: 'localhost',
                          port: pmPort,
                          path: '/api/v1/agent/schedule-task',
                          method: 'POST',
                          headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(schedulePayload),
                          },
                          timeout: 10000,
                        }, (res) => {
                          let data = '';
                          res.on('data', chunk => { data += chunk; });
                          res.on('end', () => {
                            try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
                          });
                        });
                        req.on('error', reject);
                        req.on('timeout', () => { req.destroy(); reject(new Error('Schedule timeout')); });
                        req.write(schedulePayload);
                        req.end();
                      });

                      if (scheduleResult.success || scheduleResult.schedule) {
                        logger.info(`✅ PHASE_20 GAP A: Research → RAG Loop scheduled (every 6h): ${scheduleResult.schedule?.id || 'registered'}`);
                      } else {
                        logger.info(`ℹ️  PHASE_20 GAP A: Research schedule response: ${JSON.stringify(scheduleResult).substring(0, 200)}`);
                      }
                    } catch (schedErr) {
                      logger.info(`ℹ️  PHASE_20 GAP A: Research → RAG loop schedule skipped: ${schedErr.message}`);
                    }
                  }, 45000); // 45s delay — server.listen() takes ~35s, routes must be ready first

                  // ⭐ PHASE_61 Defect #1: PM Self-Registration
                  // project-manager is the QM host and doesn't call AgentBootstrap.register() automatically.
                  // All other bots do this via AgentBootstrap. We must register PM explicitly here.
                  try {
                    if (application.queueManagerService && application.queueManagerService.agentRegistry) {
                      const pmAgentId = process.env.AGENT_ID || 'project-manager';
                      // ⭐ Use AGENT_EXTERNAL_PORT (host-mapped port) for dashboard health checks
                      // PORT is the internal container port (5000), AGENT_EXTERNAL_PORT is the host port (3010)
                      const pmPort = parseInt(process.env.AGENT_EXTERNAL_PORT || process.env.PORT || '3010');
                      const pmCaps = (process.env.AGENT_CAPABILITIES || 'project-management,coordination,routing,planning').split(',').filter(Boolean);
                      
                      await application.queueManagerService.agentRegistry.register({
                        agent_id: pmAgentId,
                        capabilities: pmCaps,
                        status: 'idle',
                        current_load: 0,
                        max_concurrent: parseInt(process.env.AGENT_MAX_CONCURRENT || '3'),
                        workspaces: ['*'],
                        agent_scope: 'shared',
                        endpoint: `http://swarm-${pmAgentId}:5000`,
                        port: pmPort,
                        selector_descriptor: process.env.AGENT_SELECTOR_DESCRIPTOR || 'Select for project management, task coordination, routing, and planning tasks',
                      });
                      logger.info(`✅ [PHASE_61] PM self-registered in AgentRegistry: ${pmAgentId} (port: ${pmPort})`);
                    }
                  } catch (pmRegErr) {
                    logger.warn(`[PHASE_61] PM self-registration failed (non-fatal): ${pmRegErr.message}`);
                  }

                  // ProvisioningManager — watches for provision-manifest.json (PHASE_52)
                  try {
                    const ProvisioningManager = require('../services/ProvisioningManager');
                    application.provisioningManager = new ProvisioningManager({
                      agentRegistry: application.queueManagerService ? application.queueManagerService.agentRegistry : null,
                      redisClient: application.redisClient,
                    });
                    const pmResult = await application.provisioningManager.initialize();
                    logger.info(`✓ ProvisioningManager: ${JSON.stringify(pmResult)}`);
                  } catch (pmErr) {
                    logger.warn(`ProvisioningManager error: ${pmErr.message}`);
                  }

                  // ═══════════════════════════════════════════════════════════
                  // ⭐ PHASE_48 Issue #048: PM subscribes to agent registry updates
                  // PM learns about new agents in real-time via Redis pub/sub
                  // ⭐ PHASE_53 Issue #053: Regenerate registered-agents.md on updates
                  // ═══════════════════════════════════════════════════════════
                  if (application.redisClient) {
                    logger.info('[PM] Setting up agent registry update listener...');
                    
                    // Wire agent registry to SlashCommandGenerator
                    if (application.slashCommandGenerator && application.queueManagerService) {
                      application.slashCommandGenerator.agentRegistry = application.queueManagerService.agentRegistry;
                      logger.info('[PM] ✓ AgentRegistry wired to SlashCommandGenerator');
                    }
                    
                    const agentUpdateSubscriber = application.redisClient.duplicate();
                    await agentUpdateSubscriber.subscribe('swarm:agent-updates');
                    
                    agentUpdateSubscriber.on('message', async (channel, message) => {
                      try {
                        const update = JSON.parse(message);
                        
                        if (update.type === 'agent-registered') {
                          logger.info(`[PM] 🆕 New agent registered: ${update.agent_id}`);
                          logger.info(`[PM]    Capabilities: ${update.capabilities.join(', ')}`);
                          logger.info(`[PM]    Port: ${update.port}, Endpoint: ${update.endpoint}`);
                          
                          // ⭐ PHASE_53: Regenerate registered-agents layer
                          if (application.slashCommandGenerator) {
                            try {
                              await application.slashCommandGenerator.regenerate('registered-agents');
                              logger.info(`[PM] ✓ Slash commands updated with new agent: ${update.agent_id}`);
                            } catch (regenErr) {
                              logger.warn(`[PM] Failed to regenerate slash commands: ${regenErr.message}`);
                            }
                          }
                          
                        } else if (update.type === 'agent-deregistered') {
                          logger.info(`[PM] 👋 Agent deregistered: ${update.agent_id}`);
                          
                          // ⭐ PHASE_53: Regenerate registered-agents layer
                          if (application.slashCommandGenerator) {
                            try {
                              await application.slashCommandGenerator.regenerate('registered-agents');
                              logger.info(`[PM] ✓ Slash commands updated (agent removed): ${update.agent_id}`);
                            } catch (regenErr) {
                              logger.warn(`[PM] Failed to regenerate slash commands: ${regenErr.message}`);
                            }
                          }
                        }
                      } catch (err) {
                        logger.error(`[PM] Failed to process agent update: ${err.message}`);
                      }
                    });
                    
                    logger.info('[PM] ✓ Subscribed to swarm:agent-updates channel');
                  }

                  // ═══════════════════════════════════════════════════════════
                  // ⭐ PHASE_48 Issue #051: Roll Call Protocol - PM and all bots listen
                  // ═══════════════════════════════════════════════════════════
                  if (application.redisClient) {
                    const agentId = process.env.AGENT_ID || 'unknown';
                    
                    logger.info(`[${agentId}] Setting up roll call listener...`);
                    
                    const rollCallSubscriber = application.redisClient.duplicate();
                    await rollCallSubscriber.subscribe('swarm:roll-call');
                    
                    rollCallSubscriber.on('message', async (channel, message) => {
                      try {
                        const rollCall = JSON.parse(message);
                        
                        if (rollCall.type === 'roll-call') {
                          logger.info(`[${agentId}] 📢 Roll call received, reporting status...`);
                          
                          // Refresh TTL via AgentRegistry.heartbeat()
                          if (application.queueManagerService && application.queueManagerService.agentRegistry) {
                            const success = await application.queueManagerService.agentRegistry.heartbeat(agentId);
                            if (success) {
                              logger.info(`[${agentId}] ✅ Roll call response: heartbeat successful (TTL refreshed)`);
                            } else {
                              logger.warn(`[${agentId}] ⚠️ Roll call heartbeat failed`);
                            }
                          }
                          
                          // Publish detailed response
                          await application.redisClient.publish('swarm:roll-call-response', JSON.stringify({
                            agent_id: agentId,
                            status: 'active',
                            capabilities: (process.env.AGENT_CAPABILITIES || '').split(',').filter(Boolean),
                            port: parseInt(process.env.PORT || '5000'),
                            timestamp: new Date().toISOString(),
                            uptime: Math.floor(process.uptime()),
                            memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024)
                          }));
                        }
                      } catch (err) {
                        logger.error(`[${agentId}] Roll call error: ${err.message}`);
                      }
                    });
                    
                    logger.info(`[${agentId}] ✓ Roll call listener active`);
                  }
                }
              } else {
                logger.warn('⚠️  Agent registration failed, continuing in non-swarm mode');
              }
            } catch (error) {
              logger.error(`Agent bootstrap error: ${error.message}`);
              logger.warn('Continuing without agent swarm mode');
            }
          } else {
            logger.info('Agent Swarm Mode disabled (ENABLE_AGENT_SWARM != true)');
          }
        } catch (err) {
          logger.warn(`Queue Manager Service initialization failed: ${err.message}`);
        }
      } else {
        logger.info('Queue Manager Service disabled (ENABLE_QUEUE_MANAGER != true)');
        
        // Swarm worker agents register directly with AgentRegistry via real Redis
        if (process.env.ENABLE_AGENT_SWARM === 'true') {
          logger.info('Agent Swarm Mode: Registering as worker agent with real Redis AgentRegistry...');

          // Retry registration with backoff — Redis may not be ready when all 10 containers start simultaneously
          const MAX_REGISTRATION_RETRIES = 5;
          const INITIAL_RETRY_DELAY_MS = 3000; // 3s initial delay to let Redis stabilize

          const attemptRegistration = async (attempt = 1) => {
            try {
              // Create a fresh Redis connection for the registry
              const registryRedis = new Redis({
                host: process.env.REDIS_HOST || 'oshal-redis',
                port: parseInt(process.env.REDIS_PORT || '6379'),
                password: process.env.REDIS_PASSWORD,
                maxRetriesPerRequest: 3,
                retryStrategy: (times) => Math.min(times * 100, 3000),
                lazyConnect: true, // Don't connect until we explicitly call .connect()
              });

              await registryRedis.connect();
              await registryRedis.ping();
              logger.info(`✓ Redis connected at ${process.env.REDIS_HOST || 'oshal-redis'}:${process.env.REDIS_PORT || '6379'} (attempt ${attempt})`);

              // Create real AgentRegistry with real Redis - no mocks
              const { AgentRegistry } = require('../services/queue-manager');
              const agentRegistry = new AgentRegistry(registryRedis);

              const AgentBootstrap = require('../services/AgentBootstrap');
              application.agentBootstrap = new AgentBootstrap();
              const result = await application.agentBootstrap.initialize({ agentRegistry });

              if (result.success) {
                logger.info(`✅ Agent registered in Redis: ${result.agentId} (capabilities: ${result.capabilities.join(', ')})`);
                return true; // Return success status
              } else {
                throw new Error(result.error || 'Registration returned false');
              }
            } catch (swarmErr) {
              logger.error(`❌ Agent registration attempt ${attempt}/${MAX_REGISTRATION_RETRIES} failed: ${swarmErr.message}`);
              if (attempt < MAX_REGISTRATION_RETRIES) {
                const delay = INITIAL_RETRY_DELAY_MS * attempt; // Linear backoff: 3s, 6s, 9s, 12s
                logger.info(`⏳ Retrying agent registration in ${delay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return attemptRegistration(attempt + 1);
              } else {
                logger.error(`❌ Agent registration FAILED after ${MAX_REGISTRATION_RETRIES} attempts: ${swarmErr.message}`);
                logger.error(swarmErr.stack);
                return false; // Return failure status
              }
            }
          };

          // Stagger startup: add a random delay (0-5s) so not all 9 workers hit Redis simultaneously
          const staggerDelay = Math.floor(Math.random() * 5000);
          logger.info(`⏳ Staggering agent registration by ${staggerDelay}ms to avoid Redis contention...`);
          await new Promise(resolve => setTimeout(resolve, staggerDelay));

          const registrationSuccess = await attemptRegistration();

          // ═══════════════════════════════════════════════════════════
          // PHASE_08 FIX: Store a Redis client on the Application instance
          // so that config GET/PUT endpoints (AgentConfigManager) work on
          // worker agents, not just the QM owner (project-manager).
          // ═══════════════════════════════════════════════════════════
          if (registrationSuccess && !application.redisClient) {
            try {
              application.redisClient = new Redis({
                host: process.env.REDIS_HOST || 'oshal-redis',
                port: parseInt(process.env.REDIS_PORT || '6379'),
                password: process.env.REDIS_PASSWORD,
                maxRetriesPerRequest: 3,
                retryStrategy: (times) => Math.min(times * 100, 3000),
              });
              await application.redisClient.ping();
              logger.info('✓ Redis client stored on Application instance for config endpoints');
            } catch (redisErr) {
              logger.warn(`Failed to create application-level Redis client: ${redisErr.message}`);
              application.redisClient = null;
            }
          }
          
          // ═══════════════════════════════════════════════════════════
          // PHASE_14: Register MCP tools from AGENT_MCP_TOOLS env var
          // Provisioned bots get AGENT_MCP_TOOLS as JSON — register each
          // tool with the local ToolRegistry so the agent can USE them.
          // ═══════════════════════════════════════════════════════════
          // PHASE_16: DYNAMIC TOOL FILE SCANNING
          // Scans ALL *Tools.js files in server/services/tools/ for matching
          // tool handler names — not just vertexAITools.js. This enables
          // factory-deployed bots to drop tool implementation files and have
          // them auto-discovered at startup.
          // ═══════════════════════════════════════════════════════════
          if (registrationSuccess && process.env.AGENT_MCP_TOOLS) {
            try {
              const mcpToolDefs = JSON.parse(process.env.AGENT_MCP_TOOLS);
              if (Array.isArray(mcpToolDefs) && mcpToolDefs.length > 0) {
                const agentId = process.env.AGENT_ID || 'unknown';
                logger.info(`🔧 [AGENT_MCP_TOOLS] Registering ${mcpToolDefs.length} MCP tools for ${agentId}...`);

                // Dynamic tool file scanning — load ALL tool implementation files
                // Convention: files in server/services/tools/**/*.js that export { 'tool-name': handlerFn }
                // Subdirectory convention: tools/{agent-name}/{agent-name}Tools.js
                //   e.g. tools/facebook/facebookTools.js, tools/slack/slackTools.js
                // Excludes cliTools.js and fileTools.js (built-in tools with different export pattern)
                let allToolHandlers = {};
                const toolsDir = path.join(SERVER_ROOT, 'services', 'tools');
                const builtInToolFiles = new Set(['cliTools.js', 'fileTools.js']);

                // Recursive scanner: collects all .js files from toolsDir and subdirectories
                function collectToolFiles(dir, baseDir) {
                  const fs = require('fs');
                  const results = [];
                  try {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                      const fullPath = path.join(dir, entry.name);
                      if (entry.isDirectory()) {
                        // Recurse into subdirectory (e.g. tools/facebook/)
                        results.push(...collectToolFiles(fullPath, baseDir));
                      } else if (entry.isFile() && entry.name.endsWith('.js') && !builtInToolFiles.has(entry.name)) {
                        results.push({ fullPath, relPath: path.relative(baseDir, fullPath) });
                      }
                    }
                  } catch (e) { /* ignore unreadable dirs */ }
                  return results;
                }

                try {
                  const toolFiles = collectToolFiles(toolsDir, toolsDir);
                  for (const { fullPath, relPath } of toolFiles) {
                    try {
                      const handlers = require(fullPath);
                      // Only merge if exports look like tool handlers (object with function values)
                      if (handlers && typeof handlers === 'object' && !Array.isArray(handlers)) {
                        const handlerNames = Object.keys(handlers).filter(k => typeof handlers[k] === 'function');
                        if (handlerNames.length > 0) {
                          Object.assign(allToolHandlers, handlers);
                          logger.info(`🔧 [AGENT_MCP_TOOLS] Loaded tool file: ${relPath} (${handlerNames.length} handlers: ${handlerNames.join(', ')})`);
                        }
                      }
                    } catch (fileErr) {
                      logger.debug(`🔧 [AGENT_MCP_TOOLS] Skipping ${relPath}: ${fileErr.message}`);
                    }
                  }
                  const totalHandlers = Object.keys(allToolHandlers).length;
                  if (totalHandlers > 0) {
                    logger.info(`🔧 [AGENT_MCP_TOOLS] Total tool implementations loaded: ${totalHandlers} from ${toolFiles.length} files`);
                  } else {
                    logger.info(`🔧 [AGENT_MCP_TOOLS] No tool implementation files found — using stub/proxy handlers`);
                  }
                } catch (scanErr) {
                  logger.info(`🔧 [AGENT_MCP_TOOLS] Tool directory scan failed: ${scanErr.message} — using stub handlers`);
                }

                for (const toolDef of mcpToolDefs) {
                  try {
                    // Use real implementation if available, otherwise fall back to stub
                    let toolHandler;
                    
                    if (allToolHandlers[toolDef.name]) {
                      // Real implementation from a scanned tool file
                      const realImpl = allToolHandlers[toolDef.name];
                      toolHandler = async (params) => {
                        logger.info(`🔧 [${toolDef.name}] REAL handler invoked with params: ${JSON.stringify(params).substring(0, 200)}`);
                        return await realImpl(params);
                      };
                      logger.info(`🔧 [AGENT_MCP_TOOLS] Using REAL implementation for: ${toolDef.name}`);
                    } else if (toolDef.serverUrl) {
                      // HTTP proxy handler for tools with serverUrl
                      toolHandler = async (params) => {
                        logger.info(`🔧 [${toolDef.name}] HTTP proxy invoked: ${toolDef.serverUrl}`);
                        const http = require('http');
                        const https = require('https');
                        const url = new URL(toolDef.serverUrl);
                        const client = url.protocol === 'https:' ? https : http;
                        return new Promise((resolve, reject) => {
                          const postData = JSON.stringify(params);
                          const req = client.request({
                            hostname: url.hostname, port: url.port, path: url.pathname,
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
                            timeout: 120000,
                          }, (res) => {
                            let data = '';
                            res.on('data', chunk => { data += chunk; });
                            res.on('end', () => {
                              try { resolve(JSON.parse(data)); } catch { resolve({ result: data }); }
                            });
                          });
                          req.on('error', reject);
                          req.on('timeout', () => { req.destroy(); reject(new Error('Tool HTTP timeout')); });
                          req.write(postData);
                          req.end();
                        });
                      };
                    } else {
                      // Stub handler — tool is registered but has no implementation
                      toolHandler = async (params) => {
                        logger.warn(`🔧 [${toolDef.name}] STUB handler — no real implementation available`);
                        return {
                          status: 'agent_native_tool',
                          tool: toolDef.name,
                          message: `Tool ${toolDef.name} is registered but has no implementation. Use execute_command with the installed SDK directly.`,
                          params,
                        };
                      };
                    }

                    // Long-running tools (e.g. generate-video) can specify timeout in manifest
                    // Default 60s, but Veo video generation needs ~120s
                    const toolTimeout = toolDef.timeout || 60000;

                    application.toolRegistry.register({
                      name: toolDef.name,
                      description: toolDef.description || `MCP tool: ${toolDef.name}`,
                      inputSchema: toolDef.inputSchema || { type: 'object', properties: {} },
                      handler: toolHandler,
                      requiresApproval: false,
                      timeout: toolTimeout,
                    });

                    // Also register with TaskController so it's available in agentic mode
                    if (application.taskController) {
                      application.taskController.registerTool(toolDef.name, toolHandler, {
                        description: toolDef.description || `MCP tool: ${toolDef.name}`,
                        requiresApproval: false,
                        inputSchema: toolDef.inputSchema || { type: 'object', properties: {} },
                        timeout: toolTimeout,
                      });
                    }

                    logger.info(`🔧 [AGENT_MCP_TOOLS] ✅ Registered tool: ${toolDef.name}`);
                  } catch (toolErr) {
                    logger.warn(`🔧 [AGENT_MCP_TOOLS] Failed to register tool ${toolDef.name}: ${toolErr.message}`);
                  }
                }

                logger.info(`🔧 [AGENT_MCP_TOOLS] Tool registration complete. Total tools in registry: ${application.toolRegistry.count()}`);
              }
            } catch (parseErr) {
              logger.warn(`🔧 [AGENT_MCP_TOOLS] Failed to parse AGENT_MCP_TOOLS: ${parseErr.message}`);
            }
          }

          // ═══════════════════════════════════════════════════════════
          // ⭐ PHASE_48 Issue #051: Roll Call Protocol - Worker bots listen
          // ═══════════════════════════════════════════════════════════
          if (registrationSuccess && application.redisClient) {
            const agentId = process.env.AGENT_ID || 'unknown';
            
            logger.info(`[${agentId}] Setting up roll call listener...`);
            
            const rollCallSubscriber = application.redisClient.duplicate();
            await rollCallSubscriber.subscribe('swarm:roll-call');
            
            rollCallSubscriber.on('message', async (channel, message) => {
              try {
                const rollCall = JSON.parse(message);
                
                if (rollCall.type === 'roll-call') {
                  logger.info(`[${agentId}] 📢 Roll call received, reporting status...`);
                  
                  // Refresh TTL via AgentRegistry.heartbeat()
                  // Worker bots don't have queueManagerService, so use Redis directly
                  if (application.redisClient) {
                    try {
                      const { AgentRegistry } = require('../services/queue-manager');
                      const registry = new AgentRegistry(application.redisClient);
                      const success = await registry.heartbeat(agentId);
                      if (success) {
                        logger.info(`[${agentId}] ✅ Roll call response: heartbeat successful (TTL refreshed)`);
                      } else {
                        logger.warn(`[${agentId}] ⚠️ Roll call heartbeat failed`);
                      }
                    } catch (hbErr) {
                      logger.error(`[${agentId}] Roll call heartbeat error: ${hbErr.message}`);
                    }
                  }
                  
                  // Publish detailed response
                  await application.redisClient.publish('swarm:roll-call-response', JSON.stringify({
                    agent_id: agentId,
                    status: 'active',
                    capabilities: (process.env.AGENT_CAPABILITIES || '').split(',').filter(Boolean),
                    port: parseInt(process.env.PORT || '5000'),
                    timestamp: new Date().toISOString(),
                    uptime: Math.floor(process.uptime()),
                    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024)
                  }));
                }
              } catch (err) {
                logger.error(`[${agentId}] Roll call error: ${err.message}`);
              }
            });
            
            logger.info(`[${agentId}] ✓ Roll call listener active`);
          }

          // ═══════════════════════════════════════════════════════════
          // PHASE_29: Agent Heartbeat Loop
          // Keep agent registration alive by refreshing TTL every 5 minutes
          // ═══════════════════════════════════════════════════════════
          if (registrationSuccess) {
            const AGENT_ID = process.env.AGENT_ID || process.env.HOSTNAME || 'unknown';
            const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
            
            logger.info(`🔄 Starting heartbeat loop for ${AGENT_ID} (every 5 minutes)`);
            
            const heartbeatInterval = setInterval(async () => {
              try {
                // Create fresh Redis connection for heartbeat
                const registryRedis = new Redis({
                  host: process.env.REDIS_HOST || 'oshal-redis',
                  port: parseInt(process.env.REDIS_PORT || '6379'),
                  password: process.env.REDIS_PASSWORD,
                  maxRetriesPerRequest: 3,
                  retryStrategy: (times) => Math.min(times * 100, 3000),
                });
                
                const { AgentRegistry } = require('../services/queue-manager');
                const agentRegistry = new AgentRegistry(registryRedis);
                
                const success = await agentRegistry.heartbeat(AGENT_ID);
                
                if (success) {
                  logger.info(`💓 Heartbeat sent: ${AGENT_ID}`);
                } else {
                  logger.warn(`❌ Heartbeat failed for ${AGENT_ID}, re-registering...`);
                  
                  // Re-register if heartbeat fails (agent may have expired)
                  const AgentBootstrap = require('../services/AgentBootstrap');
                  const bootstrap = new AgentBootstrap();
                  const reRegResult = await bootstrap.initialize({ agentRegistry });
                  
                  if (!reRegResult.success) {
                    logger.error(`❌ Re-registration failed for ${AGENT_ID}: ${reRegResult.error}`);
                  } else {
                    logger.info(`✅ Re-registration successful for ${AGENT_ID}`);
                  }
                }
                
                // Close Redis connection after heartbeat
                await registryRedis.quit();
              } catch (error) {
                logger.error(`Heartbeat error for ${AGENT_ID}: ${error.message}`);
              }
            }, HEARTBEAT_INTERVAL_MS);
            
            // Cleanup on process termination
            process.on('SIGTERM', () => {
              logger.info(`Stopping heartbeat for ${AGENT_ID}`);
              clearInterval(heartbeatInterval);
            });
            
            process.on('SIGINT', () => {
              logger.info(`Stopping heartbeat for ${AGENT_ID}`);
              clearInterval(heartbeatInterval);
            });
          }
        }
      }

      // ⭐ PHASE_61 Backlog #1: SelfHealingScheduler — autonomous container monitoring
      // PROTECTED HOOK: exactly one bot may run application. It used to gate on
      // AGENT_ID === 'self-healing-bot', but swarm routing requires AGENT_ID to be
      // the bot's framework UUID (so the mesh can deliver work) — under which this
      // literal string never matched and the scheduler silently never started.
      // Gate on an explicit opt-in flag (or the bot NAME), keeping it single-owner
      // while remaining compatible with UUID-based mesh routing.
      const currentAgentId = process.env.AGENT_ID || '';
      const currentBotName = process.env.BOT_NAME || '';
      const selfHealingEnabled =
        process.env.ENABLE_SELF_HEALING_SCHEDULER === 'true' ||
        currentAgentId === 'self-healing-bot' ||
        currentBotName === 'self-healing-bot';
      if (selfHealingEnabled) {
        try {
          const SelfHealingScheduler = require('../services/SelfHealingScheduler');
          application.selfHealingScheduler = new SelfHealingScheduler({
            agentId: currentAgentId,
            redisClient: application.redisClient || null,
          });
          application.selfHealingScheduler.start();
          logger.info('✅ [PHASE_61] SelfHealingScheduler started (autonomous container monitoring active)');
        } catch (shErr) {
          logger.warn(`[PHASE_61] SelfHealingScheduler failed to start: ${shErr.message}`);
        }
      }
}

module.exports = { initializeSwarmRuntime };
