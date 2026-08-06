/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from app.js (1000-line cap decomposition): /api/health, task CRUD/messages/tools, checkpoint create/list/get/restore/delete
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: bind every task/checkpoint object route to an authenticated exact owner, filter lists at storage, retire client-approved direct tool execution, and constrain messages to completion-only authority.
 */

const logger = require('../utils/logger');
const { trustedServiceUserSub } = require('../services/codebase/swarm-execute-auth');
const { canonicalWorkspaceId } = require('../services/codebase/task-workspace-scope');
const { assertUnattendedProviderSelection } = require('../services/llm/assert-cli-tool-boundary');

const COMPLETION_ONLY_TOOLS = Object.freeze(['attempt_completion']);
const COMPLETION_ONLY_SCOPES = Object.freeze(['control:attempt_completion']);

function requireCallerSubject(req, res) {
  const userSub = trustedServiceUserSub(req);
  if (userSub) return userSub;
  res.status(403).json({ error: 'caller_identity_required' });
  return null;
}

async function requireOwnedTask(application, req, res, rawTaskId) {
  const userSub = requireCallerSubject(req, res);
  if (!userSub) return null;
  let taskId;
  try { taskId = canonicalWorkspaceId(rawTaskId); }
  catch { res.status(404).json({ error: 'Task not found' }); return null; }
  const task = await application.taskController.getTask(taskId);
  if (!task) { res.status(404).json({ error: 'Task not found' }); return null; }
  try { application.taskController.assertTaskOwner(task, userSub); }
  catch { res.status(404).json({ error: 'Task not found' }); return null; }
  return { task, taskId, userSub };
}

async function requireOwnedCheckpoint(application, req, res, checkpointId) {
  const userSub = requireCallerSubject(req, res);
  if (!userSub) return null;
  const checkpoint = await application.checkpointStore.getCheckpoint(checkpointId);
  if (!checkpoint) { res.status(404).json({ error: 'Checkpoint not found' }); return null; }
  const owned = await requireOwnedTask(application, req, res, checkpoint.taskId);
  return owned ? { ...owned, checkpoint } : null;
}

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
        const userSub = requireCallerSubject(req, res);
        if (!userSub) return;

        if (!text) {
          return res.status(400).json({ error: 'Task text is required' });
        }

        const task = await application.taskController.createTask(text, mode, { userSub });
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
        const owned = await requireOwnedTask(application, req, res, taskId);
        if (!owned) return;
        res.json({
          success: true,
          task: owned.task,
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
        const { text, images = [], files = [], agenticMode = true } = req.body;

        if (!text) {
          return res.status(400).json({ error: 'Message text is required' });
        }
        const owned = await requireOwnedTask(application, req, res, taskId);
        if (!owned) return;
        assertUnattendedProviderSelection(
          application.currentLLMProvider || process.env.LLM_PROVIDER,
        );

        // Issue #022 fix: Associate taskId with session SSE clients on every message POST.
        // This handles the case where the cockpit restores a session from sessionStorage
        // (uses existing taskId, never calls POST /api/tasks) — without this, SSE events
        // for the restored task are silently dropped because the session client's
        // knownTaskIds set never includes the taskId.
        application.streamController.associateTaskWithSession(owned.taskId);

        const result = await application.taskController.processMessage(owned.taskId, {
          text,
          images,
          files,
        }, {
          autoApprove: {},
          agenticMode: agenticMode === true,
          source: 'authenticated-task-api',
          allowedTools: COMPLETION_ONLY_TOOLS,
          authorizedScopes: COMPLETION_ONLY_SCOPES,
        });

        // Broadcast to connected clients
        application.streamController.broadcastMessage(owned.taskId, result.message);

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
        const { taskId } = req.params;
        const owned = await requireOwnedTask(application, req, res, taskId);
        if (!owned) return;
        res.status(410).json({
          error: 'direct tool execution is retired; use the server authorization broker',
        });
      } catch (err) {
        logger.error(`Tool execution failed: ${err.message}`);
        res.status(500).json({
          error: err.message,
        });
      }
    });

    // List tasks
    application.app.get('/api/tasks', async (req, res) => {
      try {
        const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
        const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);

        const userSub = requireCallerSubject(req, res);
        if (!userSub) return;
        const tasks = await application.taskController.listTasksForOwner(userSub, limit, offset);

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
        const owned = await requireOwnedTask(application, req, res, taskId);
        if (!owned) return;

        const checkpoint = await application.taskController.createCheckpoint(owned.taskId);

        application.streamController.broadcastTaskUpdate(owned.taskId, { checkpointCreated: checkpoint.id });

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
        const owned = await requireOwnedTask(application, req, res, taskId);
        if (!owned) return;

        const checkpoints = await application.checkpointStore.listCheckpoints(owned.taskId);

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

        const owned = await requireOwnedCheckpoint(application, req, res, checkpointId);
        if (!owned) return;

        res.json({
          success: true,
          checkpoint: owned.checkpoint,
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
        const owned = await requireOwnedCheckpoint(application, req, res, checkpointId);
        if (!owned) return;

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
        const owned = await requireOwnedCheckpoint(application, req, res, checkpointId);
        if (!owned) return;

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
