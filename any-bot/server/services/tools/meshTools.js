/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Mesh Collaboration Tools — PHASE_32 Issue #028
 * 
 * Enables bots to autonomously create and manage private mesh sessions
 * for bot-to-bot collaboration. These tools are registered with the
 * TaskController and available to all bots via Cline CLI.
 * 
 * Use Cases:
 * - Bot realizes it needs expertise from another bot
 * - Bot creates mesh, invites expert, collaborates
 * - Bot synthesizes mesh conversation into user response
 * - Mesh transcript saved automatically for audit trail
 * 
 * Created: 2026-02-20
 */

const logger = require('../../utils/logger');

/**
 * Mesh collaboration tools for autonomous bot-to-bot communication
 * Each tool is registered with TaskController and available to bots
 */
const meshTools = {
  /**
   * Create a private mesh for bot-to-bot collaboration
   * 
   * Example usage by bot:
   * "I need video generation expertise. Let me create a mesh with video-bot."
   * → Bot calls create_mesh({ topic: "Video generation help", inviteAgents: ["video-bot"] })
   */
  create_mesh: {
    name: 'create_mesh',
    description: 'Create a private mesh channel for bot-to-bot collaboration. Use this when you need help from other bots. Automatically invites specified bots and returns mesh ID for further communication.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'What this mesh collaboration is about (e.g., "Security review needed", "Video generation help")',
        },
        inviteAgents: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of bot agent IDs to invite (e.g., ["video-bot", "security-auditor-bot"]). Use bot names without "swarm-" prefix.',
        },
        ttlSeconds: {
          type: 'number',
          description: 'How long the mesh should live in seconds (default: 3600 = 1 hour)',
        },
      },
      required: ['topic', 'inviteAgents'],
    },
    handler: async (input, context) => {
      try {
        if (!context.privateMeshManager) {
          return {
            success: false,
            error: 'PrivateMeshManager not available. Mesh collaboration requires Redis.',
          };
        }

        const agentId = context.agentId || process.env.AGENT_ID || 'unknown-agent';
        
        logger.info(`[MeshTools] ${agentId} creating mesh: "${input.topic}" with ${input.inviteAgents.join(', ')}`);

        const mesh = await context.privateMeshManager.createMesh({
          topic: input.topic,
          scope: 'adhoc',
          inviteAgents: input.inviteAgents,
          ttlSeconds: input.ttlSeconds || 3600,
        });

        if (!mesh.success) {
          return {
            success: false,
            error: mesh.error || 'Failed to create mesh',
          };
        }

        logger.info(`[MeshTools] ✅ Mesh created: ${mesh.meshId} by ${agentId}`);

        return {
          success: true,
          meshId: mesh.meshId,
          topic: input.topic,
          members: [agentId, ...input.inviteAgents],
          message: `Mesh created successfully. ID: ${mesh.meshId}. Invited: ${input.inviteAgents.join(', ')}. Use send_mesh_message to communicate.`,
          inviteResults: mesh.inviteResults || [],
        };
      } catch (err) {
        logger.error(`[MeshTools] create_mesh error: ${err.message}`);
        return {
          success: false,
          error: err.message,
        };
      }
    },
  },

  /**
   * Send a message to a mesh channel
   * 
   * Example usage:
   * Bot: "Let me ask the video-bot for help"
   * → send_mesh_message({ meshId: "mesh:adhoc:abc123", message: "Can you generate a 30-second video about AI?" })
   */
  send_mesh_message: {
    name: 'send_mesh_message',
    description: 'Send a message to a mesh channel. Use this to communicate with other bots in a mesh you created or joined.',
    inputSchema: {
      type: 'object',
      properties: {
        meshId: {
          type: 'string',
          description: 'The mesh ID (returned from create_mesh or received in invitation)',
        },
        message: {
          type: 'string',
          description: 'The message to send to all mesh participants',
        },
        type: {
          type: 'string',
          enum: ['text', 'delegation', 'result'],
          description: 'Message type (default: text)',
        },
      },
      required: ['meshId', 'message'],
    },
    handler: async (input, context) => {
      try {
        if (!context.privateMeshManager) {
          return {
            success: false,
            error: 'PrivateMeshManager not available',
          };
        }

        const agentId = context.agentId || process.env.AGENT_ID || 'unknown-agent';
        const messageType = input.type || 'text';

        logger.info(`[MeshTools] ${agentId} sending message to ${input.meshId}: "${input.message.substring(0, 80)}..."`);

        const result = await context.privateMeshManager.sendMessage(
          input.meshId,
          agentId,
          input.message,
          messageType
        );

        if (!result.success) {
          return {
            success: false,
            error: result.error || 'Failed to send message',
          };
        }

        return {
          success: true,
          meshId: input.meshId,
          messageId: result.messageId,
          message: 'Message sent successfully',
        };
      } catch (err) {
        logger.error(`[MeshTools] send_mesh_message error: ${err.message}`);
        return {
          success: false,
          error: err.message,
        };
      }
    },
  },

  /**
   * Get conversation history from a mesh
   * 
   * Example usage:
   * Bot: "Let me review what was discussed in the mesh"
   * → get_mesh_transcript({ meshId: "mesh:adhoc:abc123" })
   */
  get_mesh_transcript: {
    name: 'get_mesh_transcript',
    description: 'Retrieve the conversation history from a mesh. Use this to review what was discussed before synthesizing a response.',
    inputSchema: {
      type: 'object',
      properties: {
        meshId: {
          type: 'string',
          description: 'The mesh ID to get history from',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of messages to retrieve (default: 100)',
        },
      },
      required: ['meshId'],
    },
    handler: async (input, context) => {
      try {
        if (!context.privateMeshManager) {
          return {
            success: false,
            error: 'PrivateMeshManager not available',
          };
        }

        const limit = input.limit || 100;
        const history = await context.privateMeshManager.getHistory(input.meshId, limit);

        if (!history) {
          return {
            success: false,
            error: 'Mesh not found or no messages',
          };
        }

        // Format messages for easy reading
        const formattedMessages = history.map(msg => ({
          from: msg.from,
          type: msg.type,
          content: msg.content,
          timestamp: msg.timestamp,
        }));

        return {
          success: true,
          meshId: input.meshId,
          messages: formattedMessages,
          count: formattedMessages.length,
          summary: `Retrieved ${formattedMessages.length} messages from mesh ${input.meshId}`,
        };
      } catch (err) {
        logger.error(`[MeshTools] get_mesh_transcript error: ${err.message}`);
        return {
          success: false,
          error: err.message,
        };
      }
    },
  },

  /**
   * Delegate a task to a specific bot in the mesh
   * 
   * Example usage:
   * Bot: "I need video-bot to handle the video generation part"
   * → delegate_mesh_task({ meshId: "mesh:adhoc:abc123", toAgent: "video-bot", task: "Generate 30-second AI video" })
   */
  delegate_mesh_task: {
    name: 'delegate_mesh_task',
    description: 'Delegate a specific task to another bot in the mesh. Use this for explicit task assignment within a collaboration.',
    inputSchema: {
      type: 'object',
      properties: {
        meshId: {
          type: 'string',
          description: 'The mesh ID',
        },
        toAgent: {
          type: 'string',
          description: 'The agent ID to delegate to',
        },
        task: {
          type: 'string',
          description: 'Description of the task to delegate',
        },
      },
      required: ['meshId', 'toAgent', 'task'],
    },
    handler: async (input, context) => {
      try {
        if (!context.privateMeshManager) {
          return {
            success: false,
            error: 'PrivateMeshManager not available',
          };
        }

        const agentId = context.agentId || process.env.AGENT_ID || 'unknown-agent';

        logger.info(`[MeshTools] ${agentId} delegating to ${input.toAgent} in ${input.meshId}: "${input.task}"`);

        const result = await context.privateMeshManager.delegateTask(
          input.meshId,
          agentId,
          input.toAgent,
          input.task
        );

        if (!result.success) {
          return {
            success: false,
            error: result.error || 'Failed to delegate task',
          };
        }

        return {
          success: true,
          meshId: input.meshId,
          from: agentId,
          to: input.toAgent,
          task: input.task,
          message: `Task delegated to ${input.toAgent}`,
        };
      } catch (err) {
        logger.error(`[MeshTools] delegate_mesh_task error: ${err.message}`);
        return {
          success: false,
          error: err.message,
        };
      }
    },
  },

  /**
   * Dissolve a mesh when collaboration is complete
   * 
   * Example usage:
   * Bot: "Collaboration complete, let me close the mesh"
   * → dissolve_mesh({ meshId: "mesh:adhoc:abc123" })
   */
  dissolve_mesh: {
    name: 'dissolve_mesh',
    description: 'Dissolve (close) a mesh when collaboration is complete. Automatically saves transcript. Only the mesh creator can dissolve.',
    inputSchema: {
      type: 'object',
      properties: {
        meshId: {
          type: 'string',
          description: 'The mesh ID to dissolve',
        },
      },
      required: ['meshId'],
    },
    handler: async (input, context) => {
      try {
        if (!context.privateMeshManager) {
          return {
            success: false,
            error: 'PrivateMeshManager not available',
          };
        }

        const agentId = context.agentId || process.env.AGENT_ID || 'unknown-agent';

        logger.info(`[MeshTools] ${agentId} dissolving mesh ${input.meshId}`);

        const result = await context.privateMeshManager.dissolveMesh(input.meshId, agentId);

        if (!result.success) {
          return {
            success: false,
            error: result.error || 'Failed to dissolve mesh (you may not be the owner)',
          };
        }

        return {
          success: true,
          meshId: input.meshId,
          transcriptPath: result.transcriptPath,
          message: `Mesh dissolved successfully. Transcript saved: ${result.transcriptPath || 'N/A'}`,
        };
      } catch (err) {
        logger.error(`[MeshTools] dissolve_mesh error: ${err.message}`);
        return {
          success: false,
          error: err.message,
        };
      }
    },
  },

  /**
   * List active meshes for this bot
   * 
   * Example usage:
   * Bot: "What meshes am I currently in?"
   * → list_my_meshes({})
   */
  list_my_meshes: {
    name: 'list_my_meshes',
    description: 'List all active meshes this bot is a member of. Use this to see ongoing collaborations.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async (input, context) => {
      try {
        if (!context.privateMeshManager) {
          return {
            success: false,
            error: 'PrivateMeshManager not available',
          };
        }

        const agentId = context.agentId || process.env.AGENT_ID || 'unknown-agent';
        const meshes = await context.privateMeshManager.listActiveMeshes(agentId);

        const meshSummaries = meshes.map(m => ({
          meshId: m.mesh_id,
          topic: m.topic,
          members: m.members,
          status: m.status,
          createdAt: m.created_at,
        }));

        return {
          success: true,
          meshes: meshSummaries,
          count: meshSummaries.length,
          message: `You are in ${meshSummaries.length} active mesh(es)`,
        };
      } catch (err) {
        logger.error(`[MeshTools] list_my_meshes error: ${err.message}`);
        return {
          success: false,
          error: err.message,
        };
      }
    },
  },
};

/**
 * Register all mesh tools with TaskController
 * Called from app.js after PrivateMeshManager initialization
 * 
 * @param {TaskController} taskController - TaskController instance
 * @param {PrivateMeshManager} privateMeshManager - PrivateMeshManager instance
 * @param {string} agentId - This bot's agent ID
 */
function registerMeshTools(taskController, privateMeshManager, agentId) {
  if (!taskController || !privateMeshManager) {
    logger.warn('[MeshTools] Cannot register: TaskController or PrivateMeshManager missing');
    return { success: false, registered: 0 };
  }

  let registered = 0;

  for (const [name, tool] of Object.entries(meshTools)) {
    try {
      // Wrap handler to inject context
      const wrappedHandler = async (input) => {
        const context = {
          privateMeshManager,
          agentId,
        };
        return await tool.handler(input, context);
      };

      taskController.registerTool(name, wrappedHandler, {
        description: tool.description,
        inputSchema: tool.inputSchema,
        requiresApproval: false, // Bots can use autonomously
      });

      registered++;
      logger.debug(`[MeshTools] Registered tool: ${name}`);
    } catch (err) {
      logger.error(`[MeshTools] Failed to register ${name}: ${err.message}`);
    }
  }

  logger.info(`[MeshTools] ✅ Registered ${registered}/${Object.keys(meshTools).length} mesh collaboration tools`);
  return { success: true, registered };
}

module.exports = {
  meshTools,
  registerMeshTools,
};
