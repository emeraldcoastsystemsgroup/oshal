/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Leak fix: _directDispatchFallback disconnects its ioredis client on the failure path (2026-07-05 leak audit)
 */

const ScheduleService = require('../services/ScheduleService');
const PlaneDatabase = require('../services/queue-manager/PlaneDatabase');
const { Client } = require('pg');
const logger = require('../utils/logger');

/**
 * @description Express controller for the agent task-scheduling API. It exposes
 * CRUD plus lifecycle operations (pause/resume/trigger) over cron-style schedules
 * and the internal callback the agent-scheduler-worker invokes when a cron job
 * fires. Its purpose is to keep scheduled work inside the QueueManager pipeline:
 * rather than dispatching directly to a bot (which skips cost tracking and the
 * audit trail), fired schedules are turned into Plane tickets that the
 * QueueManager later routes, with a direct-HTTP fallback only when Plane DB is
 * unavailable so jobs never silently fail. HTTP request handling is delegated to
 * a shared ScheduleService; this class owns validation, ticket creation, and
 * response shaping.
 */
class ScheduleController {
  constructor() {
    this.scheduleService = new ScheduleService();
  }
  /**
   * Create a new schedule
   * POST /api/v1/agent/schedule-task
   */
  async createSchedule(req, res) {
    try {
      const scheduleData = req.body;
      
      // Validate required top-level fields
      if (!scheduleData.taskType || !scheduleData.schedule || !scheduleData.taskData) {
        return res.status(400).json({
          error: 'Missing required fields: taskType, schedule, taskData'
        });
      }

      // ── PHASE_16: taskData validation ─────────────────────────────────────
      // Collect warnings for missing-but-not-fatal fields
      const warnings = [];

      // Warn if prompt is missing — dispatcher will silently do nothing without it
      if (!scheduleData.taskData.prompt) {
        warnings.push(
          'taskData.prompt is missing. The dispatcher sends this prompt to the target agent. ' +
          'Without it the schedule will fire but the agent will receive no instruction and do nothing. ' +
          'Add taskData.prompt with the full text the agent should receive.'
        );
      }

      // Warn if targetAgent is missing — dispatcher cannot route without it
      if (!scheduleData.taskData.targetAgent) {
        warnings.push(
          'taskData.targetAgent is missing. The dispatcher uses this to look up the agent port in Redis. ' +
          'Without it the schedule will fire but no agent will be called. ' +
          'Add taskData.targetAgent with the agent_id of the bot that should handle this task.'
        );
      }

      // Validate cron expression — must be exactly 5 space-separated fields
      const cronParts = (scheduleData.schedule || '').trim().split(/\s+/);
      if (cronParts.length !== 5) {
        return res.status(400).json({
          error: `Invalid cron expression "${scheduleData.schedule}": must have exactly 5 fields ` +
                 '(minute hour day-of-month month day-of-week). ' +
                 'Examples: "0 */3 * * *" (every 3h), "0 9 * * 1-5" (weekdays 9am), "*/30 * * * *" (every 30min).'
        });
      }

      // Validate each cron field range
      const [minute, hour, dom, month, dow] = cronParts;
      const cronFieldErrors = [];
      const validateCronField = (val, name, min, max) => {
        if (val === '*') return;
        // Handle step values like */3 or 1-5/2
        const stepMatch = val.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
        if (stepMatch) {
          const step = parseInt(stepMatch[2], 10);
          if (step === 0) cronFieldErrors.push(`${name}: step value cannot be 0 (got "${val}")`);
          return;
        }
        // Handle ranges like 1-5
        const rangeMatch = val.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
          const lo = parseInt(rangeMatch[1], 10), hi = parseInt(rangeMatch[2], 10);
          if (lo < min || hi > max || lo > hi) cronFieldErrors.push(`${name}: range "${val}" out of bounds (${min}-${max})`);
          return;
        }
        // Handle lists like 1,3,5
        const listParts = val.split(',');
        listParts.forEach(p => {
          const n = parseInt(p, 10);
          if (isNaN(n) || n < min || n > max) cronFieldErrors.push(`${name}: value "${p}" out of bounds (${min}-${max})`);
        });
      };
      validateCronField(minute, 'minute', 0, 59);
      validateCronField(hour,   'hour',   0, 23);
      validateCronField(dom,    'day-of-month', 1, 31);
      validateCronField(month,  'month',  1, 12);
      validateCronField(dow,    'day-of-week', 0, 7);
      if (cronFieldErrors.length > 0) {
        return res.status(400).json({
          error: `Invalid cron expression "${scheduleData.schedule}": ${cronFieldErrors.join('; ')}`
        });
      }

      // Log warnings so they appear in server logs even if we proceed
      if (warnings.length > 0) {
        logger.warn(`[ScheduleController] createSchedule warnings for "${scheduleData.taskType}": ${warnings.join(' | ')}`);
      }
      // ── end PHASE_16 validation ────────────────────────────────────────────

      // Add created by from request context if available
      if (req.user) {
        scheduleData.createdBy = req.user.id || req.user.name || 'agent';
      }

      const schedule = await this.scheduleService.createSchedule(scheduleData);

      res.status(201).json({
        success: true,
        scheduleId: schedule.scheduleId,
        nextExecution: schedule.nextExecution,
        pattern: schedule.pattern,
        schedule
      });
    } catch (error) {
      logger.error('Error in createSchedule:', error);
      res.status(500).json({
        error: error.message || 'Failed to create schedule'
      });
    }
  }

  /**
   * Get all schedules
   * GET /api/v1/agent/schedules
   */
  async getAllSchedules(req, res) {
    try {
      const schedules = await this.scheduleService.getAllSchedules();

      res.json({
        success: true,
        count: schedules.length,
        schedules
      });
    } catch (error) {
      logger.error('Error in getAllSchedules:', error);
      res.status(500).json({
        error: error.message || 'Failed to get schedules'
      });
    }
  }

  /**
   * Get schedule by ID
   * GET /api/v1/agent/schedules/:id
   */
  async getSchedule(req, res) {
    try {
      const { id } = req.params;
      const schedule = await this.scheduleService.getSchedule(id);

      if (!schedule) {
        return res.status(404).json({
          error: 'Schedule not found'
        });
      }

      res.json({
        success: true,
        schedule
      });
    } catch (error) {
      logger.error('Error in getSchedule:', error);
      res.status(500).json({
        error: error.message || 'Failed to get schedule'
      });
    }
  }

  /**
   * Update schedule
   * PUT /api/v1/agent/schedules/:id
   */
  async updateSchedule(req, res) {
    try {
      const { id } = req.params;
      const updates = req.body;

      const schedule = await this.scheduleService.updateSchedule(id, updates);

      res.json({
        success: true,
        schedule
      });
    } catch (error) {
      logger.error('Error in updateSchedule:', error);
      res.status(500).json({
        error: error.message || 'Failed to update schedule'
      });
    }
  }

  /**
   * Pause a schedule
   * POST /api/v1/agent/schedules/:id/pause
   */
  async pauseSchedule(req, res) {
    try {
      const { id } = req.params;
      const schedule = await this.scheduleService.pauseSchedule(id);

      res.json({
        success: true,
        message: 'Schedule paused',
        schedule
      });
    } catch (error) {
      logger.error('Error in pauseSchedule:', error);
      res.status(500).json({
        error: error.message || 'Failed to pause schedule'
      });
    }
  }

  /**
   * Resume a paused schedule
   * POST /api/v1/agent/schedules/:id/resume
   */
  async resumeSchedule(req, res) {
    try {
      const { id } = req.params;
      const schedule = await this.scheduleService.resumeSchedule(id);

      res.json({
        success: true,
        message: 'Schedule resumed',
        schedule
      });
    } catch (error) {
      logger.error('Error in resumeSchedule:', error);
      res.status(500).json({
        error: error.message || 'Failed to resume schedule'
      });
    }
  }

  /**
   * Trigger a schedule immediately (one-shot, no pause required)
   * POST /api/v1/agent/schedules/:id/trigger
   */
  async triggerSchedule(req, res) {
    try {
      const { id } = req.params;
      const result = await this.scheduleService.triggerNow(id);

      res.json({
        success: true,
        message: 'Schedule triggered immediately — job queued for agent-scheduler-worker',
        ...result,
      });
    } catch (error) {
      logger.error('Error in triggerSchedule:', error);
      res.status(500).json({
        error: error.message || 'Failed to trigger schedule'
      });
    }
  }

  /**
   * Delete a schedule
   * DELETE /api/v1/agent/schedules/:id
   */
  async deleteSchedule(req, res) {
    try {
      const { id } = req.params;
      const result = await this.scheduleService.deleteSchedule(id);

      res.json({
        success: true,
        message: 'Schedule deleted',
        scheduleId: result.scheduleId
      });
    } catch (error) {
      logger.error('Error in deleteSchedule:', error);
      res.status(500).json({
        error: error.message || 'Failed to delete schedule'
      });
    }
  }

  /**
   * Execute a scheduled task (internal callback from worker)
   * POST /api/v1/agent/execute-scheduled-task
   *
   * ⭐ PHASE_66 FIX: Creates a Plane ticket instead of dispatching directly to the bot.
   * The agent-scheduler-worker calls this endpoint when a cron job fires.
   * Instead of bypassing the QueueManager (no cost tracking, no audit trail),
   * we now create a Plane ticket in "Todo" state. The QueueManager picks it up
   * on its next poll cycle and routes it through the standard pipeline:
   *   Capability matching → Agent dispatch → Cost tracking → Audit trail
   *
   * Previous behavior (PHASE_15): Direct HTTP dispatch to bot → no Plane ticket → $0.00 cost
   * New behavior (PHASE_66): Create Plane ticket → QM polls → routes → cost tracked → audit trail
   */
  async executeScheduledTask(req, res) {
    try {
      const {
        scheduleId,
        taskType,
        taskData,
        executionTime,
        attemptNumber
      } = req.body;

      logger.info(`[ScheduleController] ⭐ PHASE_66: Executing scheduled task via Plane ticket creation: ${scheduleId} (${taskType}), attempt ${attemptNumber}`);

      const targetAgent = taskData?.targetAgent;
      const prompt = taskData?.prompt;
      const action = taskData?.action;

      let ticketResult = null;
      let dispatchMethod = 'none';

      // ── PHASE_66: Create Plane ticket instead of direct bot dispatch ───
      // This ensures scheduled jobs go through the QueueManager pipeline:
      // 1. Ticket created in "Todo" state
      // 2. QueueManager polls and finds it
      // 3. CapabilityMatcher/MeshBroadcast routes to best agent
      // 4. Agent processes ticket with full cost tracking and audit trail
      if (prompt) {
        const planeDbConfig = {
          host: process.env.PLANE_DB_HOST || 'plane-plane-db-1',
          port: parseInt(process.env.PLANE_DB_PORT || '5432'),
          database: process.env.PLANE_DB_NAME || 'plane',
          user: process.env.PLANE_DB_USER || 'plane',
          password: process.env.PLANE_DB_PASSWORD || 'plane',
        };

        const planeDb = new PlaneDatabase(planeDbConfig);
        const client = new Client(planeDbConfig);

        try {
          await client.connect();

          // Resolve workspace ID from slug
          const workspaceSlug = process.env.PLANE_WORKSPACE_SLUG || 'devopscloud-01';
          const wsResult = await client.query(
            `SELECT id FROM workspaces WHERE slug = $1 LIMIT 1`,
            [workspaceSlug]
          );

          if (wsResult.rows.length === 0) {
            throw new Error(`Workspace '${workspaceSlug}' not found in Plane DB`);
          }
          const workspaceId = wsResult.rows[0].id;

          // Resolve project ID — use first project in workspace (or env override)
          let projectId = process.env.PLANE_PROJECT_ID || null;
          if (!projectId) {
            const projResult = await client.query(
              `SELECT id FROM projects WHERE workspace_id = $1 LIMIT 1`,
              [workspaceId]
            );
            if (projResult.rows.length === 0) {
              throw new Error(`No projects found in workspace '${workspaceSlug}'`);
            }
            projectId = projResult.rows[0].id;
          }

          // Build ticket title and description
          const ticketTitle = `[Scheduled] ${taskType}${targetAgent ? ` → ${targetAgent}` : ''}`;
          const ticketDescription = [
            `## Scheduled Task Execution`,
            ``,
            `**Schedule ID:** ${scheduleId}`,
            `**Task Type:** ${taskType}`,
            `**Target Agent:** ${targetAgent || 'auto-route (QueueManager decides)'}`,
            `**Execution Time:** ${executionTime || new Date().toISOString()}`,
            `**Attempt:** ${attemptNumber}`,
            ``,
            `---`,
            ``,
            `## Task Instructions`,
            ``,
            prompt,
            ``,
            `---`,
            `*This ticket was automatically created by the agent-scheduler-worker (PHASE_66).*`,
            `*It will be picked up by the QueueManager and routed through the standard pipeline.*`,
          ].join('\n');

          // Determine priority based on task type
          let priority = 'medium';
          if (taskType === 'research_rag_loop' || taskType === 'maintenance') {
            priority = 'low';
          } else if (taskType === 'urgent' || taskData?.priority === 'urgent') {
            priority = 'urgent';
          } else if (taskData?.priority) {
            priority = taskData.priority;
          }

          // ⭐ SESSION_06 FIX: Dedup check — skip if active research ticket already exists for this bot
          // Prevents flooding: one research ticket per bot per day maximum
          if (taskType === 'research_rag_loop') {
            const dedupCheck = await client.query(`
              SELECT i.id FROM issues i
              JOIN states s ON i.state_id = s.id
              WHERE i.project_id = $1
                AND i.name LIKE $2
                AND s."group" NOT IN ('completed','cancelled')
                AND i.archived_at IS NULL
              LIMIT 1
            `, [projectId, `%[Scheduled] research_rag_loop → ${targetAgent || 'research-bot'}%`]);
            
            if (dedupCheck.rows.length > 0) {
              logger.info(`[ScheduleController] ⏭️ SESSION_06: Skipping research_rag_loop ticket creation — active ticket already exists for ${targetAgent || 'research-bot'} (id: ${dedupCheck.rows[0].id})`);
              await client.end();
              ticketResult = {
                skipped: true,
                reason: 'dedup',
                existingTicketId: dedupCheck.rows[0].id,
              };
              dispatchMethod = 'skipped-dedup';
              return; // Skip ticket creation — jump to result reporting
            }
          }

          // ⭐ SESSION_06 FIX: Write research tasks to Backlog state (not Todo)
          // Backlog = visible in Plane but NOT picked up by QueueManager polling (which watches Todo/In Progress)
          // This gives human visibility without flooding the active work queue
          let stateIdOverride = null;
          if (taskType === 'research_rag_loop') {
            try {
              const backlogStateResult = await client.query(
                `SELECT id FROM states WHERE project_id = $1 AND name = 'Backlog' LIMIT 1`,
                [projectId]
              );
              if (backlogStateResult.rows.length > 0) {
                stateIdOverride = backlogStateResult.rows[0].id;
                logger.info(`[ScheduleController] 📥 SESSION_06: Creating research ticket in Backlog state (not Todo) for ${targetAgent}`);
              }
            } catch (stateErr) {
              logger.warn(`[ScheduleController] Could not find Backlog state: ${stateErr.message} — falling back to Todo`);
            }
          }

          // Create the Plane ticket (Backlog for research, Todo for others)
          const issueResult = await planeDb.createRootIssue(
            client,
            ticketTitle,
            ticketDescription,
            projectId,
            workspaceId,
            priority
          );

          // Override state to Backlog if applicable
          if (issueResult && stateIdOverride) {
            await client.query(
              `UPDATE issues SET state_id = $1, updated_at = NOW() WHERE id = $2`,
              [stateIdOverride, issueResult.id]
            );
            logger.info(`[ScheduleController] ✅ SESSION_06: Research ticket ${issueResult.id} moved to Backlog`);
          }

          if (issueResult) {
            ticketResult = {
              planeTicketId: issueResult.id,
              sequenceId: issueResult.sequenceId,
              title: ticketTitle,
              status: 'Todo',
              pipeline: 'QueueManager will route on next poll cycle',
            };
            dispatchMethod = 'plane-ticket';
            logger.info(`[ScheduleController] ✅ PHASE_66: Plane ticket created for scheduled task ${scheduleId}: ${issueResult.id} (seq: ${issueResult.sequenceId}) — "${ticketTitle}"`);
          } else {
            logger.error(`[ScheduleController] ❌ PHASE_66: Failed to create Plane ticket for ${scheduleId} — createRootIssue returned null`);
            dispatchMethod = 'plane-ticket-failed';
          }

          await client.end();
        } catch (dbErr) {
          logger.error(`[ScheduleController] ❌ PHASE_66: Plane DB error for ${scheduleId}: ${dbErr.message}`);
          dispatchMethod = 'plane-ticket-error';
          try { await client.end(); } catch (e) { /* ignore */ }

          // ── FALLBACK: Direct dispatch if Plane DB is unavailable ──────
          // If Plane DB is down, fall back to the old direct HTTP dispatch
          // so scheduled tasks don't silently fail. This is a safety net.
          logger.warn(`[ScheduleController] ⚠️ PHASE_66 FALLBACK: Attempting direct dispatch for ${scheduleId} (Plane DB unavailable)`);
          if (targetAgent && prompt) {
            try {
              const fallbackResult = await this._directDispatchFallback(targetAgent, prompt, scheduleId, taskType);
              if (fallbackResult) {
                ticketResult = fallbackResult;
                dispatchMethod = 'direct-http-fallback';
              }
            } catch (fallbackErr) {
              logger.error(`[ScheduleController] ❌ PHASE_66 FALLBACK also failed: ${fallbackErr.message}`);
            }
          }
        }
      } else if (targetAgent && !prompt) {
        logger.warn(`[ScheduleController] Schedule ${scheduleId} has targetAgent '${targetAgent}' but no prompt in taskData — cannot create ticket. Update the schedule to include taskData.prompt.`);
      } else {
        logger.warn(`[ScheduleController] Schedule ${scheduleId} has no prompt — cannot create Plane ticket or dispatch.`);
      }

      const result = {
        success: !!ticketResult,
        summary: ticketResult
          ? `Plane ticket created: ${ticketResult.planeTicketId || ticketResult.taskId || 'unknown'} — QueueManager will route`
          : `Scheduled task ${scheduleId} could not be dispatched (no prompt or Plane DB error)`,
        executedAt: new Date().toISOString(),
        taskData,
        attemptNumber,
        dispatchMethod,
        targetAgent,
        ticket: ticketResult,
      };

      // Record execution in schedule metadata
      await this.scheduleService.recordExecution(scheduleId, result);

      res.json(result);
    } catch (error) {
      logger.error('Error in executeScheduledTask:', error);

      // Record failed execution
      try {
        await this.scheduleService.recordExecution(req.body.scheduleId, {
          success: false,
          error: error.message,
          executedAt: new Date().toISOString()
        });
      } catch (recordError) {
        logger.error('Error recording failed execution:', recordError);
      }

      res.status(500).json({
        success: false,
        error: error.message || 'Failed to execute scheduled task'
      });
    }
  }

  /**
   * ⭐ PHASE_66: Fallback direct dispatch when Plane DB is unavailable
   * This preserves the old PHASE_15 behavior as a safety net so scheduled
   * tasks don't silently fail if Plane DB is temporarily down.
   * @private
   */
  async _directDispatchFallback(targetAgent, prompt, scheduleId, taskType) {
    const http = require('http');
    const Redis = require('ioredis');

    // Resolve target agent port from Redis AgentRegistry
    let agentPort = null;
    let redis = null;
    try {
      redis = new Redis({
        host: process.env.REDIS_HOST || 'oshal-redis',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        maxRetriesPerRequest: 2,
        connectTimeout: 3000,
      });
      const agentData = await redis.get(`queue-manager:agent:${targetAgent}`);
      await redis.quit();
      if (agentData) {
        const agent = JSON.parse(agentData);
        agentPort = agent.port ? parseInt(agent.port) : null;
      }
    } catch (redisErr) {
      logger.warn(`[ScheduleController] FALLBACK: Redis lookup failed for ${targetAgent}: ${redisErr.message}`);
      // Leak guard (2026-07-05): this is the Redis-unhealthy path — without disconnect the
      // abandoned client kept reconnecting forever, one per failed fallback dispatch.
      try { if (redis) redis.disconnect(); } catch (_) { /* already closed */ }
      return null;
    }

    if (!agentPort) {
      logger.warn(`[ScheduleController] FALLBACK: Cannot resolve port for agent: ${targetAgent}`);
      return null;
    }

    // Create task on target agent (old PHASE_15 behavior)
    const taskPayload = JSON.stringify({ text: prompt, mode: 'act' });
    const taskResult = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'host.docker.internal',
        port: agentPort,
        path: '/api/tasks',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(taskPayload) },
        timeout: 10000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(taskPayload);
      req.end();
    });

    if (taskResult.task?.id) {
      const taskId = taskResult.task.id;
      const msgPayload = JSON.stringify({ text: prompt, agenticMode: true, autoApprove: { use_mcp_tool: true } });

      // Fire-and-forget — agent processes asynchronously
      http.request({
        hostname: 'host.docker.internal',
        port: agentPort,
        path: `/api/tasks/${taskId}/messages`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(msgPayload) },
        timeout: 300000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          logger.info(`[ScheduleController] FALLBACK: ${targetAgent} completed scheduled task ${scheduleId}: ${data.length} chars`);
        });
      }).on('error', (err) => {
        logger.warn(`[ScheduleController] FALLBACK: ${targetAgent} task message error (non-fatal): ${err.message}`);
      }).end(msgPayload);

      logger.info(`[ScheduleController] ⚠️ FALLBACK: Dispatched ${taskType} to ${targetAgent}:${agentPort} (task: ${taskId}) — NO Plane ticket, NO cost tracking`);
      return { taskId, agent: targetAgent, port: agentPort, method: 'direct-http-fallback' };
    }

    return null;
  }
}

/**
 * @description Default export: a singleton ScheduleController instance. A single
 * instance is shared across all route registrations so every schedule request is
 * served by the same ScheduleService, avoiding redundant service construction.
 */
module.exports = new ScheduleController();
