/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from app.js (1000-line cap decomposition): mesh-signal endpoint (Phase 1), private mesh protocol CRUD (PHASE_24), mesh dashboard/chat UI + SSE stream + invite (PHASE_32)
 */

const path = require('path');
const logger = require('../utils/logger');

// The original code lived in any-bot/server/ — keep filesystem anchors identical.
const SERVER_ROOT = path.join(__dirname, '..');

/**
 * @description POST /api/v1/agentic/mesh-signal (lazy MeshSignalHandler + PrivateMeshManager init, re-subscription, mesh tool registration) and the private-mesh channel CRUD/transcript routes. Registration order within this block is preserved exactly (including routes shadowed by /api/mesh/:meshId).
 * @param {object} application - The Application instance (owns the express app, stores, controllers, and services).
 * @returns {void}
 */
function registerMeshChannelRoutes(application) {
    // ════════════════════════════════════════════════════════
    // ═══ MESH BROADCAST NETWORK — Phase 1 Foundation ═══════
    // ════════════════════════════════════════════════════════
    // POST /api/v1/agentic/mesh-signal — Receive mesh broadcast signals
    // Each bot evaluates incoming signals (BID_REQUEST, CAPABILITY_QUERY, HEALTH_PING)
    // using its persona + selector_descriptor + LLM self-evaluation
    application.app.post('/api/v1/agentic/mesh-signal', async (req, res) => {
      try {
        const { type, payload, source, signal_id, mesh_id } = req.body;

        if (!type) {
          return res.status(400).json({ error: 'Signal type is required', valid_types: ['BID_REQUEST', 'CAPABILITY_QUERY', 'HEALTH_PING', 'MESH_INVITE', 'MESH_MESSAGE'] });
        }

        // Lazy-init MeshSignalHandler (created once, reused for all signals)
        if (!application._meshSignalHandler) {
          const MeshSignalHandler = require('../services/MeshSignalHandler');
          const llmProvider = application.taskController?.llm || null;
          application._meshSignalHandler = new MeshSignalHandler({
            llmProvider,
            agentId: process.env.AGENT_ID || 'unknown-agent',
            timeoutMs: 8000,
          });

          // ⭐ PHASE_24 Issue #018: Initialize PrivateMeshManager and wire to MeshSignalHandler
          if (application.redisClient) {
            try {
              const PrivateMeshManager = require('../services/queue-manager/PrivateMeshManager');
              application._privateMeshManager = new PrivateMeshManager({
                redis: application.redisClient,
                agentRegistry: application.queueManagerService?.agentRegistry || null,
                meshBroadcast: application.queueManagerService?.meshBroadcast || null,
                agentId: process.env.AGENT_ID || 'unknown-agent',
              });
              await application._privateMeshManager.initialize();
              application._meshSignalHandler.setPrivateMeshManager(application._privateMeshManager);
              logger.info('✓ PrivateMeshManager initialized and wired to MeshSignalHandler');

              // ⭐ PHASE_32 Issue #030: Re-subscribe to active meshes on startup
              // If this bot was a member of any meshes before restart, re-subscribe to them
              setTimeout(async () => {
                try {
                  const agentId = application._privateMeshManager.agentId;
                  const activeMeshes = await application._privateMeshManager.listActiveMeshes(agentId);
                  
                  if (activeMeshes.length > 0) {
                    logger.info(`[MeshStartup] Found ${activeMeshes.length} active meshes for ${agentId}, re-subscribing...`);
                    
                    for (const mesh of activeMeshes) {
                      try {
                        // Re-subscribe with message handler
                        await application._privateMeshManager.subscribeToMesh(mesh.mesh_id, async (message) => {
                          await application._meshSignalHandler.processIncomingMeshMessage(mesh.mesh_id, message);
                        });
                        logger.info(`[MeshStartup] ✅ Re-subscribed to mesh ${mesh.mesh_id} (${mesh.topic})`);
                      } catch (subErr) {
                        logger.warn(`[MeshStartup] Failed to re-subscribe to mesh ${mesh.mesh_id}: ${subErr.message}`);
                      }
                    }
                    
                    logger.info(`[MeshStartup] ✅ Re-subscription complete: ${activeMeshes.length} meshes`);
                  } else {
                    logger.info(`[MeshStartup] No active meshes found for ${agentId}`);
                  }
                } catch (resubErr) {
                  logger.warn(`[MeshStartup] Mesh re-subscription failed: ${resubErr.message}`);
                }
              }, 5000); // 5s delay to let everything initialize

              // ⭐ PHASE_32 Issue #028: Register mesh collaboration tools for autonomous bot-to-bot communication
              if (application.taskController) {
                try {
                  const { registerMeshTools } = require('../services/tools/meshTools');
                  const agentId = process.env.AGENT_ID || 'unknown-agent';
                  const result = registerMeshTools(application.taskController, application._privateMeshManager, agentId);
                  if (result.success) {
                    logger.info(`✓ Mesh collaboration tools registered (${result.registered} tools available to bots)`);
                  }
                } catch (toolErr) {
                  logger.warn(`Mesh tools registration failed: ${toolErr.message}`);
                }

                // ⭐ PHASE_32 Issue #028: Wire PrivateMeshManager to TaskController for user-initiated swarm sessions
                // Enables natural language swarm invocation from dashboard chat
                application.taskController._privateMeshManager = application._privateMeshManager;
                logger.info('✓ PrivateMeshManager wired to TaskController for natural language swarm invocation');
              }
            } catch (meshErr) {
              logger.warn(`PrivateMeshManager init failed: ${meshErr.message}`);
            }
          }
        }

        const result = await application._meshSignalHandler.handleSignal({
          type,
          payload: payload || {},
          source: source || 'unknown',
          signal_id: signal_id || `sig_${Date.now()}`,
          mesh_id: mesh_id || null,
        });

        res.json(result);
      } catch (error) {
        logger.error(`[MeshSignal] Endpoint error: ${error.message}`);
        res.status(500).json({ error: error.message, agent_id: process.env.AGENT_ID || 'unknown' });
      }
    });

    // ════════════════════════════════════════════════════════
    // ═══ PRIVATE MESH PROTOCOL — Phase 24 (Issue #018) ═════
    // ════════════════════════════════════════════════════════

    // GET /api/mesh/channels — List active meshes for this agent
    application.app.get('/api/mesh/channels', async (req, res) => {
      try {
        if (!application._privateMeshManager) {
          return res.json({ channels: [], message: 'PrivateMeshManager not initialized' });
        }
        const agentId = req.query.agentId || application._privateMeshManager.agentId;
        const meshes = await application._privateMeshManager.listActiveMeshes(agentId);
        res.json({ success: true, channels: meshes, count: meshes.length });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // POST /api/mesh/create — Create a new ad-hoc mesh
    application.app.post('/api/mesh/create', async (req, res) => {
      try {
        if (!application._privateMeshManager) {
          return res.status(503).json({ error: 'PrivateMeshManager not initialized' });
        }
        const { topic, scope, inviteAgents, ticketId, taskId, ttlSeconds, capabilitiesNeeded } = req.body;
        if (!topic) {
          return res.status(400).json({ error: 'topic is required' });
        }
        const result = await application._privateMeshManager.createMesh({
          topic, scope, inviteAgents, ticketId, taskId, ttlSeconds, capabilitiesNeeded,
        });
        res.status(result.success ? 201 : 500).json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // GET /api/mesh/:meshId — Get mesh state + message history
    application.app.get('/api/mesh/:meshId', async (req, res) => {
      try {
        if (!application._privateMeshManager) {
          return res.status(503).json({ error: 'PrivateMeshManager not initialized' });
        }
        const { meshId } = req.params;
        const limit = parseInt(req.query.limit) || 50;
        const state = await application._privateMeshManager.getMeshState(meshId);
        if (!state) {
          return res.status(404).json({ error: 'Mesh not found or expired' });
        }
        const history = await application._privateMeshManager.getHistory(meshId, limit);
        res.json({ success: true, channel: state, messages: history });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // POST /api/mesh/:meshId/message — Send message to mesh
    application.app.post('/api/mesh/:meshId/message', async (req, res) => {
      try {
        if (!application._privateMeshManager) {
          return res.status(503).json({ error: 'PrivateMeshManager not initialized' });
        }
        const { meshId } = req.params;
        const { message, type } = req.body;
        if (!message) {
          return res.status(400).json({ error: 'message is required' });
        }
        const agentId = application._privateMeshManager.agentId;
        const result = await application._privateMeshManager.sendMessage(meshId, agentId, message, type || 'text');
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // DELETE /api/mesh/:meshId — Dissolve a mesh
    application.app.delete('/api/mesh/:meshId', async (req, res) => {
      try {
        if (!application._privateMeshManager) {
          return res.status(503).json({ error: 'PrivateMeshManager not initialized' });
        }
        const { meshId } = req.params;
        const result = await application._privateMeshManager.dissolveMesh(meshId);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // GET /api/mesh/stats — Get mesh manager stats
    application.app.get('/api/mesh/stats', (req, res) => {
      if (!application._privateMeshManager) {
        return res.json({ stats: null, message: 'PrivateMeshManager not initialized' });
      }
      res.json({ success: true, stats: application._privateMeshManager.getStats() });
    });

    // POST /api/mesh/:meshId/save-transcript — Save conversation transcript
    application.app.post('/api/mesh/:meshId/save-transcript', async (req, res) => {
      try {
        if (!application._privateMeshManager) {
          return res.status(503).json({ error: 'PrivateMeshManager not initialized' });
        }
        const { meshId } = req.params;
        const transcriptPath = await application._privateMeshManager.saveTranscript(meshId);
        if (!transcriptPath) {
          return res.status(404).json({ error: 'Mesh not found or no messages to save' });
        }
        res.json({ success: true, meshId, transcriptPath });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // GET /api/mesh/:meshId/transcript — Get saved transcript
    application.app.get('/api/mesh/:meshId/transcript', async (req, res) => {
      try {
        if (!application._privateMeshManager) {
          return res.status(503).json({ error: 'PrivateMeshManager not initialized' });
        }
        const { meshId } = req.params;
        const transcript = await application._privateMeshManager.getTranscript(meshId);
        if (!transcript) {
          return res.status(404).json({ error: 'No transcript found for this mesh' });
        }
        // Return as markdown or JSON based on Accept header
        if (req.headers.accept === 'text/markdown') {
          res.type('text/markdown').send(transcript);
        } else {
          res.json({ success: true, meshId, transcript });
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // GET /api/mesh/transcripts — List all saved transcripts
    application.app.get('/api/mesh/transcripts', async (req, res) => {
      try {
        if (!application._privateMeshManager) {
          return res.json({ transcripts: [], message: 'PrivateMeshManager not initialized' });
        }
        const transcripts = await application._privateMeshManager.listTranscripts();
        res.json({ success: true, transcripts, count: transcripts.length });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
}

/**
 * @description Mesh dashboard + chat UI pages, per-mesh SSE stream (Redis pub/sub bridge), and mesh invite endpoint (PHASE_32 Issue #028). Called LATER than registerMeshChannelRoutes — between the plane-config and bot-config blocks — to preserve original registration order.
 * @param {object} application - The Application instance (owns the express app, stores, controllers, and services).
 * @returns {void}
 */
function registerMeshUiRoutes(application) {
    // ═══════════════════════════════════════════
    // PHASE_32 Issue #028: Mesh Chat UI & Dashboard
    // ═══════════════════════════════════════════

    // Serve mesh dashboard
    application.app.get('/mesh-dashboard', (req, res) => {
      res.sendFile(path.join(SERVER_ROOT, '../ui-enhanced/mesh-dashboard.html'));
    });

    // Serve mesh chat UI
    application.app.get('/mesh/:meshId', (req, res) => {
      res.sendFile(path.join(SERVER_ROOT, '../ui-enhanced/mesh-chat.html'));
    });

    // SSE endpoint for real-time mesh updates
    application.app.get('/api/mesh/:meshId/stream', async (req, res) => {
      const { meshId } = req.params;
      const clientId = `mesh_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      logger.info(`[MeshSSE] Client ${clientId} connecting to mesh ${meshId}`);
      
      // Set up SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // Disable nginx buffering
      });
      
      // Send initial connection event
      res.write(`data: ${JSON.stringify({ type: 'connected', meshId, clientId })}\n\n`);
      
      // Subscribe to mesh Redis pub/sub channel
      let subscriber = null;
      
      try {
        if (!application.redisClient) {
          throw new Error('Redis not available');
        }
        
        // Create a new Redis connection for this SSE client (pub/sub requires dedicated connection)
        subscriber = application.redisClient.duplicate();
        await subscriber.subscribe(`mesh:${meshId}`);
        
        logger.info(`[MeshSSE] Client ${clientId} subscribed to mesh:${meshId}`);
        
        // Forward Redis messages to SSE client
        subscriber.on('message', (channel, message) => {
          try {
            const data = JSON.parse(message);
            
            // Determine event type based on message structure
            let eventType = 'mesh-message';
            if (data.type === 'participant-join') {
              eventType = 'mesh-participant-join';
            } else if (data.type === 'participant-leave') {
              eventType = 'mesh-participant-leave';
            } else if (data.type === 'status-change') {
              eventType = 'mesh-status-change';
            } else if (data.type === 'dissolved') {
              eventType = 'mesh-dissolved';
            }
            
            // Send SSE event
            res.write(`event: ${eventType}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
            
          } catch (err) {
            logger.error(`[MeshSSE] Failed to parse message: ${err.message}`);
          }
        });
        
        // Keep-alive ping every 30 seconds
        const keepAliveInterval = setInterval(() => {
          res.write(`: keepalive\n\n`);
        }, 30000);
        
        // Handle client disconnect
        req.on('close', async () => {
          logger.info(`[MeshSSE] Client ${clientId} disconnected from mesh ${meshId}`);
          clearInterval(keepAliveInterval);
          
          if (subscriber) {
            await subscriber.unsubscribe();
            await subscriber.quit();
          }
        });
        
      } catch (err) {
        logger.error(`[MeshSSE] Setup failed: ${err.message}`);
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      }
    });

    // POST /api/mesh/:meshId/invite — Invite additional bot to mesh
    application.app.post('/api/mesh/:meshId/invite', async (req, res) => {
      try {
        if (!application._privateMeshManager) {
          return res.status(503).json({ error: 'PrivateMeshManager not initialized' });
        }
        const { meshId } = req.params;
        const { agent_id } = req.body;
        
        if (!agent_id) {
          return res.status(400).json({ error: 'agent_id is required' });
        }
        
        // Get mesh state
        const state = await application._privateMeshManager.getMeshState(meshId);
        if (!state) {
          return res.status(404).json({ error: 'Mesh not found' });
        }
        
        // Check if already a member
        if (state.members.includes(agent_id)) {
          return res.status(400).json({ error: 'Agent already in mesh' });
        }
        
        // Add to members
        state.members.push(agent_id);
        await application._privateMeshManager.redis.set(
          `mesh:${meshId}:state`,
          JSON.stringify(state),
          'EX',
          state.ttl_seconds || 3600
        );
        
        // Broadcast participant join event
        await application._privateMeshManager.redis.publish(
          `mesh:${meshId}`,
          JSON.stringify({
            type: 'participant-join',
            agent_id: agent_id,
            timestamp: new Date().toISOString()
          })
        );
        
        logger.info(`[Mesh] Agent ${agent_id} invited to mesh ${meshId}`);
        
        res.json({ success: true, meshId, agent_id, members: state.members });
      } catch (error) {
        logger.error(`[Mesh] Invite failed: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });
}

module.exports = { registerMeshChannelRoutes, registerMeshUiRoutes };
