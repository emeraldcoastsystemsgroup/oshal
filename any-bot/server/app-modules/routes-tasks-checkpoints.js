/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from app.js (1000-line cap decomposition): /api/health, task CRUD/messages/tools, checkpoint create/list/get/restore/delete
 */

const logger = require('../utils/logger');

/**
 * @description Health check, task lifecycle (create/get/message/execute-tool/list), and checkpoint lifecycle (create/list/get/restore/delete) routes.
 * @param {object} application - The Application instance (owns the express app, stores, controllers, and services).
 * @returns {void}
 */
function registerTaskAndCheckpointRoutes(application) {
    // Health check
    application.app.get('/api/health', async (req, res) => {
      try {
        const stats = application.streamController.getStats();
        
        // Get agent status if swarm mode enabled
        let agentStatus = null;
        if (application.agentBootstrap) {
          agentStatus = application.agentBootstrap.getStatus();
        }
        
        res.json({
          status: 'ok',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          components: {
            database: application.initialized,
            taskController: !!application.taskController,
            messageController: !!application.messageController,
            streamController: !!application.streamController,
            toolRegistry: application.toolRegistry.count(),
            mcpService: !!application.mcpService,
            agentSwarm: agentStatus ? {
              registered: agentStatus.registered,
              agentId: agentStatus.agentId,
              capabilities: agentStatus.config?.capabilities || [],
            } : null,
          },
          connections: stats,
        });
      } catch (err) {
        res.status(500).json({
          status: 'error',
          error: err.message,
        });
      }
    });

    // Create task
    application.app.post('/api/tasks', async (req, res) => {
      try {
        const { text, mode = 'act' } = req.body;

        if (!text) {
          return res.status(400).json({ error: 'Task text is required' });
        }

        const task = await application.taskController.createTask(text, mode);
        // Issue #022: Associate new task with session SSE clients so events reach the dashboard
        application.streamController.associateTaskWithSession(task.id);
        application.streamController.broadcastTaskUpdate(task.id, task);

        res.status(201).json({
          success: true,
          task,
        });
      } catch (err) {
        logger.error(`Create task failed: ${err.message}`);
        res.status(500).json({
          error: err.message,
        });
      }
    });

    // Get task
    application.app.get('/api/tasks/:taskId', async (req, res) => {
      try {
        const { taskId } = req.params;
        const task = await application.taskController.getTask(taskId);

        if (!task) {
          return res.status(404).json({ error: 'Task not found' });
        }

        res.json({
          success: true,
          task,
        });
      } catch (err) {
        logger.error(`Get task failed: ${err.message}`);
        res.status(500).json({
          error: err.message,
        });
      }
    });

    // Send message to task
    application.app.post('/api/tasks/:taskId/messages', async (req, res) => {
      try {
        const { taskId } = req.params;
        const { text, images = [], files = [], autoApprove = {}, agenticMode = true, source } = req.body;

        if (!text) {
          return res.status(400).json({ error: 'Message text is required' });
        }

        // Issue #022 fix: Associate taskId with session SSE clients on every message POST.
        // This handles the case where the cockpit restores a session from sessionStorage
        // (uses existing taskId, never calls POST /api/tasks) — without this, SSE events
        // for the restored task are silently dropped because the session client's
        // knownTaskIds set never includes the taskId.
        application.streamController.associateTaskWithSession(taskId);

        const result = await application.taskController.processMessage(taskId, {
          text,
          images,
          files,
        }, {
          autoApprove,
          agenticMode,
          source,  // PHASE_23: Pass 'dashboard' source for proper context filtering
        });

        // Broadcast to connected clients
        application.streamController.broadcastMessage(taskId, result.message);

        res.json({
          success: true,
          result,
        });
      } catch (err) {
        logger.error(`Send message failed: ${err.message}`);
        res.status(500).json({
          error: err.message,
        });
      }
    });

    // Execute tool
    application.app.post('/api/tasks/:taskId/tools/:toolName', async (req, res) => {
      try {
        const { taskId, toolName } = req.params;
        const { input, approved = false } = req.body;

        const result = await application.taskController.executeTool(taskId, toolName, input, approved);

        // Check if requires approval
        if (result.requiresApproval) {
          return res.json({
            success: false,
            requiresApproval: true,
            tool: result.tool,
          });
        }

        // Broadcast tool execution
        application.streamController.broadcastToolExecution(taskId, { name: toolName }, 'success');

        res.json({
          success: true,
          result,
        });
      } catch (err) {
        logger.error(`Tool execution failed: ${err.message}`);
        application.streamController.broadcastToolExecution(
          req.params.taskId,
          { name: req.params.toolName },
          'error'
        );
        res.status(500).json({
          error: err.message,
        });
      }
    });

    // List tasks
    application.app.get('/api/tasks', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;

        const tasks = await application.taskController.listTasks(limit, offset);

        res.json({
          success: true,
          tasks,
          count: tasks.length,
        });
      } catch (err) {
        logger.error(`List tasks failed: ${err.message}`);
        res.status(500).json({
          error: err.message,
        });
      }
    });

    // Create checkpoint for task
    application.app.post('/api/tasks/:taskId/checkpoints', async (req, res) => {
      try {
        const { taskId } = req.params;

        const checkpoint = await application.taskController.createCheckpoint(taskId);

        application.streamController.broadcastTaskUpdate(taskId, { checkpointCreated: checkpoint.id });

        res.status(201).json({
          success: true,
          checkpoint,
        });
      } catch (err) {
        logger.error(`Create checkpoint failed: ${err.message}`);
        res.status(500).json({
          error: err.message,
        });
      }
    });

    // List checkpoints for task
    application.app.get('/api/tasks/:taskId/checkpoints', async (req, res) => {
      try {
        const { taskId } = req.params;

        const checkpoints = await application.checkpointStore.listCheckpoints(taskId);

        res.json({
          success: true,
          checkpoints,
          count: checkpoints.length,
        });
      } catch (err) {
        logger.error(`List checkpoints failed: ${err.message}`);
        res.status(500).json({
          error: err.message,
        });
      }
    });

    // Get specific checkpoint
    application.app.get('/api/checkpoints/:checkpointId', async (req, res) => {
      try {
        const { checkpointId } = req.params;

        logger.info(`[DEBUG] GET /api/checkpoints/${checkpointId} - Starting retrieval`);

        const checkpoint = await application.checkpointStore.getCheckpoint(checkpointId);

        logger.info(`[DEBUG] GET /api/checkpoints/${checkpointId} - Result: ${checkpoint ? 'FOUND' : 'NOT FOUND'}`);

        if (!checkpoint) {
          return res.status(404).json({ error: 'Checkpoint not found' });
        }

        res.json({
          success: true,
          checkpoint,
        });
      } catch (err) {
        logger.error(`Get checkpoint failed: ${err.message}`);
        res.status(500).json({
          error: err.message,
        });
      }
    });

    // Restore from checkpoint
    application.app.post('/api/checkpoints/:checkpointId/restore', async (req, res) => {
      try {
        const { checkpointId } = req.params;

        const task = await application.taskController.restoreCheckpoint(checkpointId);

        application.streamController.broadcastTaskUpdate(task.id, task);

        res.json({
          success: true,
          task,
          message: 'Task restored from checkpoint',
        });
      } catch (err) {
        logger.error(`Restore checkpoint failed: ${err.message}`);
        res.status(500).json({
          error: err.message,
        });
      }
    });

    // Delete checkpoint
    application.app.delete('/api/checkpoints/:checkpointId', async (req, res) => {
      try {
        const { checkpointId } = req.params;

        const deleted = await application.checkpointStore.deleteCheckpoint(checkpointId);

        if (!deleted) {
          return res.status(404).json({ error: 'Checkpoint not found' });
        }

        res.json({
          success: true,
          message: 'Checkpoint deleted',
        });
      } catch (err) {
        logger.error(`Delete checkpoint failed: ${err.message}`);
        res.status(500).json({
          error: err.message,
        });
      }
    });
}

module.exports = { registerTaskAndCheckpointRoutes };
