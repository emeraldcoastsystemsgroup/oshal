/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of cockpit API routes for projects, tickets, metrics, and SSE streaming
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Updated ticket hierarchy endpoint to read from internal ticket store when available
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fixed ticket activity/feed/workspace mapping so cockpit shows real timeline text and resolves workspace links when primary task links are missing
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Normalized cockpit project/ticket fallback routes to use real project identifiers and parent-child task hierarchy instead of shallow compatibility stubs
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Normalized cockpit workspace paths onto shared workspace display paths so code-server handoff no longer depends on host-local absolute paths
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Defaulted cockpit project labeling to the canonical Default project when ticket/task metadata does not explicitly name another project
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Added child-activity rollup to ticket activity endpoint so root tickets surface subtask timelines, costs, and tree context in the cockpit feed
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Added project CRUD endpoints (create/rename/archive) so operators can manage projects explicitly beyond Default + move-root
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Added ticket activity SSE endpoint for real-time feed updates without manual reload
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Fixed metrics/summary to query ticketService for ticket count instead of stale taskStore; added POST /tickets for direct ticket creation
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Changed ticket creation default status from backlog to approved so queue manager processes tickets immediately
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Extracted helper functions to cockpit-route-helpers.ts to comply with 1000-line hard cap
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Correlated cockpit hierarchy/detail responses with persisted swarm work items so child tickets show real state, activity, and shared workspace artifacts
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Extracted project CRUD routes to cockpit-project-routes.ts to satisfy 800-line refactoring trigger
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Session 109: Metrics summary now returns full ticket status breakdown (backlog, inProgress, inReview, customerAction, done, escalations) instead of just total/active
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Fix metrics/summary: removed 500-ticket cap (use 10000), fixed cost field (totalCost not actualCost), added swarm bot count from registry
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | Process tracker: subscribe ticketEvents to SSE bus; add GET /tickets/:id/history endpoint
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | WS5: Reply endpoint now persists operator message to primary task thread via TicketInteractionService — replaces SSE-only stub behavior
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | Fixed cockpit dashboard bot performance and swarm health payloads so zero-state, disabled bots, and telemetry-backed activity render truthfully
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | Exposed ticket external ids in cockpit activity payloads so escalated-ticket detail can load durable swarm escalation reasons and next-step guidance
 * 21 | maintainer@emeraldcoastsystemsgroup.com   | Repaired cockpit route decomposition and delegated ticket activity responses to a dedicated route module for per-bot ticket cost rollups
 * 22 | maintainer@emeraldcoastsystemsgroup.com   | Session 19: Added GET /metrics/swarm endpoint exposing SwarmMetricsCollector aggregated pipeline metrics for operator dashboards
 * 23 | maintainer@emeraldcoastsystemsgroup.com   | Scoped GET /tickets/hierarchy to the caller's own tickets by default (owner_sub), with ?scope=all operator override, for multi-user isolation
 * 24 | maintainer@emeraldcoastsystemsgroup.com   | Inline bots no longer show OFFLINE. /metrics/agents, swarmAgentCount, and buildSwarmHealth now (a) read getActiveRegistry() at REQUEST time (the module-load snapshot ran before app bots registered, so dnd/spaces were absent) and (b) compute online/healthy via resolveDisplayOnline(heartbeat, container) — inline/api-hosted bots (container oshal-api) are online when the api is up; only dedicated bot-nodes stay heartbeat-gated. Fixes dnd (122 real runs) rendering offline. Routing/eligibility untouched.
 * 25 | maintainer@emeraldcoastsystemsgroup.com   | Gated the ?scope=all override behind operator privilege (isOperator). Previously ANY authenticated user could pass ?scope=all to enumerate every tenant's tickets; non-operators are now always scoped to their own ownerSub regardless of the query param.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME } from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';
import { getCaller, isOperator } from '@/shared/middleware/authz';
import { ticketEvents } from '@/shared/ticket-events';
import type { AppContext } from '../composition-root';
import {
  buildInternalTicketHierarchy,
  buildTaskHierarchy,
  deleteTaskMessages,
  mapOshalTicketStateToCockpitState,
  readTaskAgentId,
} from './cockpit-route-helpers';
import { createCockpitProjectRoutes } from './cockpit-project-routes';
import { createCockpitLogRoutes } from './cockpit-log-routes';
import {
  applyWorkItemStatesToInternalTickets,
  readRecentWorkItems,
} from './cockpit-work-item-helpers';
import { handleGetCockpitEscalationSummary } from './cockpit-escalation-summary-route';
import { handleGetCockpitQueueHealth } from './cockpit-queue-health-route';
import { handleGetCockpitTicketActivity } from './cockpit-ticket-activity-route';
import { handleGetCockpitTicketDetail } from './cockpit-ticket-detail-route';
import { getActiveRegistry } from '../extensions/swarm/swarm-bot-registry';
import { resolveDisplayOnline } from '@/features/agent-management';
// Type anchor only — element type is SwarmBotDefinition. The RUNTIME reads below call
// getActiveRegistry() at REQUEST time so dynamically-registered app bots (dnd, etc.) are present;
// this module-load snapshot ran before swarmAppService.autoLoadAll() and would omit them.
const SWARM_BOT_REGISTRY = getActiveRegistry();

const logger = createChildLogger({ module: 'cockpit-routes' });

// ═══ TICKET ACTIVITY EVENT BUS ═══

type TicketActivityListener = (event: { ticketId: string; entry: Record<string, unknown> }) => void;

/** @description Module-level set of SSE listeners for ticket activity updates. */
const ticketActivityBus = new Set<TicketActivityListener>();

/**
 * @description Broadcasts a ticket activity event to all connected SSE clients watching this ticket.
 * @param ticketId - Ticket that received new activity
 * @param entry - Timeline entry to push to clients
 */
function emitTicketActivity(ticketId: string, entry: Record<string, unknown>): void {
  const event = { ticketId, entry };
  for (const listener of ticketActivityBus) {
    try {
      listener(event);
    } catch (err) {
      logger.warn({ err }, 'Ticket activity listener error, removing');
      ticketActivityBus.delete(listener);
    }
  }
  logger.debug({ ticketId, listenerCount: ticketActivityBus.size }, 'Ticket activity event emitted');
}

// Pipe ticket status transitions from the store layer into the SSE bus so the cockpit
// feed shows "moved to X" entries without a page reload.
ticketEvents.onStatusChanged((event) => {
  const label = event.toStatus.replace(/_/g, ' ');
  const from = event.fromStatus ? ` from ${event.fromStatus.replace(/_/g, ' ')}` : '';
  emitTicketActivity(event.ticketId, {
    id: `status-${event.ticketId}-${Date.now()}`,
    type: 'system',
    text: `Status changed${from} → **${label}**`,
    summary: `Status changed${from} → ${label}`,
    timestamp: event.timestamp,
    author: event.changedBy,
    actor: event.changedByLabel,
  });
});

/**
 * @description Creates Express router with cockpit-specific API endpoints
 * that the cockpit UI depends on: projects, ticket hierarchy, metrics, and SSE streaming.
 *
 * @param ctx - Application context with task store, agent profile controller, etc.
 * @returns Configured Express router
 */
export function createCockpitRoutes(ctx: AppContext): Router {
  const router = Router();

  // ═══ PROJECTS (delegated to cockpit-project-routes.ts) ═══
  router.use('/', createCockpitProjectRoutes(ctx));

  // ═══ LOGS (delegated to cockpit-log-routes.ts) ═══
  router.use('/', createCockpitLogRoutes(ctx));

  // ═══ TICKET HIERARCHY ═══

  /**
   * @description Get ticket hierarchy — returns tasks formatted as tickets for the cockpit UI.
   * GET /api/v1/tickets/hierarchy
   */
  router.get('/tickets/hierarchy', async (req: Request, res: Response) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      const ticketType =
        typeof req.query.type === 'string'
          ? req.query.type.toLowerCase()
          : typeof req.query.ticketType === 'string'
            ? req.query.ticketType.toLowerCase()
            : undefined;
      /* ── Per-user scoping (IDOR fix) ───────────────────────────────
       * Default: caller sees only their own tickets. `?scope=all` is an
       * OPERATOR-ONLY override (team dashboards) — a non-operator passing
       * scope=all is still hard-scoped to their own ownerSub. Unauthenticated
       * callers fall through unscoped, but OIDC is required in prod. */
      const ownerSub = resolveCockpitOwnerSub(req);
      logger.info({ projectId, ticketType, scoped: Boolean(ownerSub) }, 'GET /api/v1/tickets/hierarchy');

      /* ── Try internal ticket store first ──────────────────────────── */
      if (ctx.ticketService) {
        try {
          const internalTickets = await ctx.ticketService.listTickets({ limit: 200, ticketType, ownerSub });
          if (internalTickets.length > 0) {
            const recentWorkItems = await readRecentWorkItems(ctx, 2000);
            const hierarchySourceTickets = applyWorkItemStatesToInternalTickets(
              internalTickets as Array<Record<string, unknown>>,
              recentWorkItems,
            );
            const tickets = buildInternalTicketHierarchy(
              hierarchySourceTickets,
              projectId,
            );
            if (tickets.length > 0 || !projectId) {
              await enrichTicketsWithCostRollup(tickets, ctx);
              res.json({ success: true, tickets, total: tickets.length, source: 'ticket-store' });
              return;
            }
          }
        } catch (ticketError) {
          logger.warn({ err: ticketError }, 'Internal ticket store query failed, falling back to task store');
        }
      }

      /* ── Fallback to task store ───────────────────────────────────── */
      const tasks = await ctx.taskStore.list({ limit: 200, ownerSub });
      const tickets = buildTaskHierarchy(tasks as Array<Record<string, unknown>>, projectId);

      res.json({
        success: true,
        tickets,
        total: tickets.length,
        source: 'task-store',
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to get ticket hierarchy');
      res.json({ success: true, tickets: [], total: 0, source: 'error-fallback' });
    }
  });

  // Operator hygiene/health summaries.
  router.get('/tickets/escalations/summary', handleGetCockpitEscalationSummary(ctx));
  router.get('/metrics/queue-health', handleGetCockpitQueueHealth(ctx));

  router.get('/tickets/:ticketId/activity', handleGetCockpitTicketActivity(ctx));
  router.get('/tickets/:ticketId', handleGetCockpitTicketDetail(ctx));

  /**
   * @description Delete a ticket by ID.
   * DELETE /api/v1/tickets/:ticketId
   */
  router.delete('/tickets/:ticketId', async (req: Request, res: Response) => {
    try {
      const { ticketId } = req.params;
      logger.info({ ticketId }, 'DELETE /api/v1/tickets/:ticketId');

      const internalTicket = await ctx.ticketService.getTicket(ticketId as string);
      if (internalTicket) {
        const taskLinks = await ctx.ticketService.getTasksForTicket(ticketId as string).catch(() => []);
        await ctx.ticketService.deleteTicket(ticketId as string);

        for (const link of taskLinks as Array<{ taskId?: string }>) {
          if (!link?.taskId) {
            continue;
          }
          try {
            await ctx.messageStore.deleteByTask(link.taskId);
            await ctx.taskStore.delete(link.taskId);
          } catch (cleanupError) {
            logger.warn({ err: cleanupError, ticketId, taskId: link.taskId }, 'Linked task cleanup failed after ticket delete');
          }
        }

        res.json({ success: true, deleted: 'ticket' });
        return;
      }

      await deleteTaskMessages(ctx, ticketId as string);
      await ctx.taskStore.delete(ticketId as string);
      res.json({ success: true, deleted: 'task' });
    } catch (error) {
      logger.error({ err: error }, 'Failed to delete ticket');
      res.status(500).json({ success: false, error: 'Failed to delete ticket' });
    }
  });

  // ═══ METRICS ═══

  /**
   * @description Get metrics summary for the cockpit status bar and dashboard.
   * Queries ticketService for accurate ticket counts and taskStore for cost/agent data.
   * GET /api/v1/metrics/summary
   */
  router.get('/metrics/summary', async (req: Request, res: Response) => {
    try {
      const ownerSub = resolveCockpitOwnerSub(req);
      logger.info({ scoped: Boolean(ownerSub) }, 'GET /api/v1/metrics/summary');

      // Primary source: internal ticket store for ticket counts
      let ticketTotal = 0;
      let ticketActive = 0;
      let ticketBacklog = 0;
      let ticketInProgress = 0;
      let ticketInReview = 0;
      let ticketCustomerAction = 0;
      let ticketDone = 0;
      let ticketEscalations = 0;
      const uniqueAgentIds = new Set<string>();

      try {
        const allTickets = await ctx.ticketService.listTickets({ limit: 10000, ownerSub });
        // Only count root tickets — children inflate numbers and confuse operators
        const tickets = allTickets.filter((t: any) => !t.parentTicketId);
        ticketTotal = tickets.length;
        for (const ticket of tickets) {
          const state = mapOshalTicketStateToCockpitState(ticket.status);
          if (state === 'In Progress') {
            ticketActive++;
            ticketInProgress++;
          } else if (state === 'Todo' || state === 'Backlog') {
            ticketBacklog++;
          } else if (state === 'In Review') {
            ticketInReview++;
            ticketEscalations++;
          } else if (state === 'Customer Action') {
            ticketCustomerAction++;
          } else if (state === 'Done') {
            ticketDone++;
          }
          if (ticket.assignedAgentId) {
            uniqueAgentIds.add(ticket.assignedAgentId);
          }
        }
      } catch (ticketError) {
        logger.warn({ err: ticketError }, 'Ticket store query failed for metrics, falling back to task store');
      }

      // Agent count: prefer runtime registry (live heartbeats) over ticket assignment
      let swarmAgentCount = 0;
      const hasRuntimeRegistry = Boolean(ctx.swarm?.runtimeRegistryService);
      try {
        const onlineAgentIds = ctx.swarm?.runtimeRegistryService
          ? await ctx.swarm.runtimeRegistryService.listOnlineAgentIds()
          : [];
        // Inline/api-hosted bots never heartbeat; count them online too (the api is up) UNLESS the
        // operator disabled them — so this count agrees with buildSwarmHealth in the same response.
        const onlineSet = new Set(onlineAgentIds);
        const swarmStatusMap = await loadAgentStatusMap(ctx);
        for (const bot of getActiveRegistry()) {
          if (!bot.agentId || onlineSet.has(bot.agentId)) continue;
          const dbStatus = normalizeAgentStatus(swarmStatusMap.get(bot.agentId) || swarmStatusMap.get(bot.name) || 'active');
          const enabled = dbStatus !== 'inactive' && dbStatus !== 'disabled' && dbStatus !== 'paused';
          if (resolveDisplayOnline(false, bot.container, enabled)) onlineSet.add(bot.agentId);
        }
        swarmAgentCount = onlineSet.size;
      } catch { /* non-blocking */ }

      // Cost aggregation: prefer Postgres SUM for accuracy over in-memory task store
      let totalCost = 0;
      if (ctx.pool) {
        try {
          const costResult = await ctx.pool.query(
            `SELECT COALESCE(SUM(total_cost), 0) AS total
             FROM chat_tasks
             WHERE total_cost > 0
               AND ($1::text IS NULL OR owner_sub = $1)`,
            [ownerSub ?? null],
          );
          totalCost = parseFloat(costResult.rows[0]?.total ?? '0');
        } catch (costErr) {
          logger.warn({ err: costErr }, 'Postgres cost query failed — falling back to task store');
        }
      }
      if (totalCost === 0) {
        try {
          const tasks = await ctx.taskStore.list({ limit: 500, ownerSub });
          if (ticketTotal === 0) {
            ticketTotal = tasks.length;
            ticketActive = tasks.filter((t: any) => ['in_progress', 'active', 'running'].includes(t.status)).length;
          }
          for (const task of tasks as any[]) {
            totalCost += Number((task as any).totalCost || (task as any).total_cost || 0);
          }
        } catch (taskError) {
          logger.warn({ err: taskError }, 'Task store cost fallback failed');
        }
      }

      // Swarm health — online/offline from runtime registry
      const swarmHealth = await buildSwarmHealth(ctx);
      // Cost series — hourly breakdown from chat_tasks (last 24h)
      const costSeries = await buildCostSeries(ctx, ownerSub);
      // DA-5: Agent state breakdown derived from swarm health + active work items
      const agentBreakdown = await buildAgentStateBreakdown(ctx, swarmHealth.healthy);

      res.json({
        success: true,
        data: {
          total: ticketTotal,
          active: ticketActive,
          backlog: ticketBacklog,
          todo: ticketBacklog,
          inProgress: ticketInProgress,
          inReview: ticketInReview,
          customerAction: ticketCustomerAction,
          done: ticketDone,
          escalations: ticketEscalations,
          agents: {
            total: hasRuntimeRegistry ? swarmAgentCount : uniqueAgentIds.size,
            ...agentBreakdown,
          },
          estimatedTotalCost: totalCost,
          queue: ticketBacklog + ticketInProgress,
          failed: 0,
          timestamp: new Date().toISOString(),
          swarmHealth,
          costSeries,
        },
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to get metrics summary');
      res.json({
        success: true,
        data: { total: 0, active: 0, agents: { total: 1 }, estimatedTotalCost: 0, queue: 0 },
      });
    }
  });

  /**
   * @description Get per-agent metrics breakdown.
   * GET /api/v1/metrics/agents
   */
  router.get('/metrics/agents', async (req: Request, res: Response) => {
    try {
      const ownerSub = resolveCockpitOwnerSub(req);
      logger.info({ scoped: Boolean(ownerSub) }, 'GET /api/v1/metrics/agents');
      const dbMetrics = ctx.swarm?.agentMetricsService
        ? await ctx.swarm.agentMetricsService.queryFromDB()
        : [];
      const telemetryByAgent = await loadAgentTelemetrySummary(ctx, ownerSub);
      const runtimeRegistrations = ctx.swarm?.runtimeRegistryService
        ? await ctx.swarm.runtimeRegistryService.listAgentRegistrations()
        : [];
      const onlineAgentIds = new Set(
        runtimeRegistrations
          .filter((registration) => registration.status === 'online')
          .map((registration) => registration.agentId),
      );
      const onlineAgentNames = new Set(
        runtimeRegistrations
          .filter((registration) => registration.status === 'online')
          .map((registration) => registration.agentName),
      );
      // Request-time registry (dynamic-inclusive) so app-contributed bots (dnd, spaces, …) are
      // present with their container — needed for the inline online check + a real display name.
      const activeRegistry = getActiveRegistry();
      const definitionsById = new Map(activeRegistry.filter((bot) => bot.agentId).map((bot) => [bot.agentId as string, bot]));
      const definitionsByName = new Map(activeRegistry.map((bot) => [bot.name, bot]));
      // Operator enable/disable state, so a disabled inline bot reads offline (matches /metrics/summary).
      const agentsStatusMap = await loadAgentStatusMap(ctx);
      const metricsByCanonicalId = new Map(
        dbMetrics.map((metric) => [
          resolveCanonicalBotId(metric.agentId, definitionsById, definitionsByName),
          metric,
        ]),
      );
      const canonicalIds = new Set<string>();
      activeRegistry.forEach((bot) => canonicalIds.add(bot.agentId || bot.name));
      dbMetrics.forEach((metric) => {
        const canonicalId = resolveCanonicalBotId(metric.agentId, definitionsById, definitionsByName);
        if (canonicalId) {
          canonicalIds.add(canonicalId);
        }
      });
      telemetryByAgent.forEach((_value, key) => {
        const canonicalId = resolveCanonicalBotId(key, definitionsById, definitionsByName);
        if (canonicalId) {
          canonicalIds.add(canonicalId);
        }
      });

      const agents = Array.from(canonicalIds).map((canonicalId) => {
        const definition = definitionsById.get(canonicalId) || definitionsByName.get(canonicalId);
        const displayName = definition?.name || canonicalId;
        const dbStatus = normalizeAgentStatus(agentsStatusMap.get(definition?.agentId || canonicalId) || agentsStatusMap.get(displayName) || 'active');
        const enabled = dbStatus !== 'inactive' && dbStatus !== 'disabled' && dbStatus !== 'paused';
        const metric = metricsByCanonicalId.get(canonicalId) || null;
        const telemetry = telemetryByAgent.get(canonicalId)
          || telemetryByAgent.get(displayName)
          || createEmptyAgentTelemetrySummary();
        const totalEvents = metric?.totalExecutions ?? 0;
        const tasksCompleted = metric?.successCount ?? 0;
        const totalRequests = telemetry.totalRequests;
        const performanceScore = Math.max(totalEvents, totalRequests, tasksCompleted);

        return {
          agentId: definition?.agentId || canonicalId,
          name: displayName,
          totalEvents,
          tasksCompleted,
          totalRequests,
          tasksActive: 0,
          totalCost: telemetry.totalCost,
          totalInputTokens: telemetry.totalInputTokens,
          totalOutputTokens: telemetry.totalOutputTokens,
          totalTokens: telemetry.totalInputTokens + telemetry.totalOutputTokens,
          successRate: metric?.successRate ?? 0,
          avgDurationMs: metric?.avgDurationMs ?? 0,
          online: resolveDisplayOnline(
          onlineAgentIds.has(definition?.agentId || canonicalId) || onlineAgentNames.has(displayName),
          definition?.container,
          enabled,
        ),
          lastActivityAt: metric?.lastExecutionAt || telemetry.updatedAt || null,
          performanceScore,
        };
      }).sort((left, right) => {
        if (right.performanceScore !== left.performanceScore) {
          return right.performanceScore - left.performanceScore;
        }
        if (Number(right.online) !== Number(left.online)) {
          return Number(right.online) - Number(left.online);
        }
        return readTimestamp(right.lastActivityAt) - readTimestamp(left.lastActivityAt);
      });
      res.json({ success: true, agents });
    } catch (error) {
      logger.error({ err: error }, 'Failed to get agent metrics');
      res.json({ success: true, agents: [] });
    }
  });

  /**
   * @description Aggregated swarm pipeline metrics from SwarmMetricsCollector.
   * Returns processing rates, phase completion, agent performance, and loop/escalation stats.
   * GET /api/v1/metrics/swarm
   */
  router.get('/metrics/swarm', async (_req: Request, res: Response) => {
    try {
      logger.info('GET /api/v1/metrics/swarm');
      const collector = ctx.swarm?.swarmMetricsCollector;
      if (!collector) {
        res.json({ success: true, data: null, message: 'Swarm metrics collector not available' });
        return;
      }
      const aggregated = collector.getAggregatedMetrics();
      const recent = collector.getRecentMetrics(20);
      res.json({
        success: true,
        data: {
          aggregated,
          recentTickets: recent.map((m) => ({
            ticketId: m.ticketId,
            agentId: m.agentId,
            complexity: m.complexity,
            outcome: m.outcome,
            totalDurationMs: m.totalDurationMs,
            regressionCount: m.regressionCount,
            completedAt: m.completedAt,
          })),
        },
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to get swarm pipeline metrics');
      res.json({ success: true, data: null });
    }
  });

  // ═══ SSE STREAMING ═══

  /**
   * @description SSE streaming endpoint for real-time cockpit updates.
   * GET /streaming
   */
  router.get('/streaming', (req: Request, res: Response) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : 'unknown';
    logger.info({ sessionId }, 'SSE streaming connection opened');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send initial connection event
    res.write(`data: ${JSON.stringify({ type: 'connected', sessionId, timestamp: Date.now() })}\n\n`);

    // Heartbeat every 30 seconds
    const heartbeat = setInterval(() => {
      try {
        res.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: Date.now() })}\n\n`);
      } catch (e) {
        clearInterval(heartbeat);
      }
    }, 30000);

    req.on('close', () => {
      logger.info({ sessionId }, 'SSE streaming connection closed');
      clearInterval(heartbeat);
    });
  });

  // ═══ TICKET ACTIVITY SSE ═══

  /**
   * @description SSE endpoint for real-time ticket activity updates.
   * Clients connect per-ticket; when activity arrives (reply, state change, child update),
   * the new entry is pushed without requiring a full reload.
   * GET /api/v1/tickets/:ticketId/activity/stream
   */
  router.get('/tickets/:ticketId/activity/stream', (req: Request, res: Response) => {
    const { ticketId } = req.params;
    logger.info({ ticketId }, 'Ticket activity SSE connection opened');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.write(`event: connected\ndata: ${JSON.stringify({ ticketId, timestamp: Date.now() })}\n\n`);

    // Register this connection with the activity event bus
    const listener = (event: { ticketId: string; entry: Record<string, unknown> }) => {
      if (event.ticketId === ticketId || event.ticketId === '*') {
        try {
          res.write(`event: ticket-activity\ndata: ${JSON.stringify(event.entry)}\n\n`);
        } catch {
          ticketActivityBus.delete(listener);
        }
      }
    };
    ticketActivityBus.add(listener);

    // Heartbeat every 30 seconds
    const heartbeat = setInterval(() => {
      try {
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);
      } catch {
        clearInterval(heartbeat);
        ticketActivityBus.delete(listener);
      }
    }, 30000);

    req.on('close', () => {
      logger.info({ ticketId }, 'Ticket activity SSE connection closed');
      clearInterval(heartbeat);
      ticketActivityBus.delete(listener);
    });
  });

  // ═══ TICKET CREATION ═══

  /**
   * @description Create a new ticket directly from the cockpit toolbar.
   * POST /api/v1/tickets
   */
  router.post('/tickets', async (req: Request, res: Response) => {
    try {
      const { title, description, projectId, projectName, priority, labels } = req.body || {};
      if (!title || typeof title !== 'string' || !title.trim()) {
        res.status(400).json({ success: false, error: 'Ticket title is required' });
        return;
      }
      const trimmedTitle = title.trim();
      const trimmedDescription = typeof description === 'string' ? description.trim() : '';
      logger.info({ title: trimmedTitle, projectId }, 'POST /api/v1/tickets — creating ticket');

      const resolvedProjectId = typeof projectId === 'string' && projectId.trim() ? projectId.trim() : DEFAULT_PROJECT_ID;
      const resolvedProjectName = typeof projectName === 'string' && projectName.trim() ? projectName.trim() : DEFAULT_PROJECT_NAME;

      const requestedStatus = typeof req.body.status === 'string' ? req.body.status.trim() : 'backlog';
      const validStatuses = ['backlog', 'approved'];
      const resolvedStatus = validStatuses.includes(requestedStatus) ? requestedStatus : 'backlog';
      const ticketType = req.body.ticketType === 'incident' ? 'incident' : 'build';

      const ticket = await ctx.ticketService.createTicket({
        title: trimmedTitle,
        ticketType,
        description: trimmedDescription,
        priority: (typeof priority === 'string' ? priority : 'none') as 'urgent' | 'high' | 'medium' | 'low' | 'none',
        status: resolvedStatus,
        labels: Array.isArray(labels) ? labels.filter((l: unknown) => typeof l === 'string') : [],
        ownerSub: getCaller(req).sub ?? null,
        externalProvider: typeof req.body.externalProvider === 'string' ? req.body.externalProvider : null,
        externalId: typeof req.body.externalId === 'string' ? req.body.externalId : null,
        externalUrl: typeof req.body.externalUrl === 'string' ? req.body.externalUrl : null,
        metadata: {
          projectId: resolvedProjectId,
          projectName: resolvedProjectName,
          projectIdentifier: resolvedProjectId,
          workspaceSlug: resolvedProjectId,
          ...(typeof req.body.metadata === 'object' && req.body.metadata ? req.body.metadata : {}),
        },
      } as any);

      logger.info({ ticketId: ticket.ticketId, title: trimmedTitle }, 'Ticket created');

      // If submitToSwarm flag is set, submit the ticket to the swarm via internal HTTP
      const submitToSwarm = req.body?.submitToSwarm === true;
      let swarmSubmitted = false;
      if (submitToSwarm) {
        try {
          const swarmPort = process.env.PORT || '5000';
          const swarmHost = `http://localhost:${swarmPort}`;
          const workItems = [{
            id: ticket.ticketId,
            title: ticket.title,
            description: ticket.description || '',
            status: 'todo',
            priority: ticket.priority || 'medium',
            labels: ticket.labels || [],
            workflow: { stateKey: 'approved', stateGroup: 'approved', stateLabel: 'Approved', mode: 'ticket' },
          }];
          // Fire and forget via fetch — don't block the ticket creation response
          fetch(`${swarmHost}/api/swarm/tickets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tickets: workItems }),
          }).then((swarmRes) => {
            if (swarmRes.ok) {
              logger.info({ ticketId: ticket.ticketId }, 'Ticket submitted to swarm for processing');
            } else {
              logger.warn({ ticketId: ticket.ticketId, status: swarmRes.status }, 'Swarm submission returned non-OK');
            }
          }).catch((err) => {
            logger.warn({ err, ticketId: ticket.ticketId }, 'Swarm submission failed after ticket creation');
          });
          swarmSubmitted = true;
        } catch (swarmError) {
          logger.warn({ err: swarmError, ticketId: ticket.ticketId }, 'Swarm submission attempt failed');
        }
      }

      res.json({ success: true, ticket, submittedToSwarm: swarmSubmitted });
    } catch (error) {
      logger.error({ err: error }, 'Failed to create ticket');
      res.status(500).json({ success: false, error: 'Failed to create ticket' });
    }
  });

  /**
   * @description Post a reply to a ticket and broadcast it via SSE.
   * This wraps the existing reply flow to emit activity events.
   * POST /api/v1/tickets/:ticketId/reply
   */
  // ═══ TICKET STATUS HISTORY ═══

  /**
   * @description Returns the status transition history for a ticket, newest first.
   * Used by the Process tab in the cockpit ticket detail view.
   * GET /api/v1/tickets/:ticketId/history
   */
  router.get('/tickets/:ticketId/history', async (req: Request, res: Response) => {
    const { ticketId } = req.params;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    logger.info({ ticketId, limit }, 'GET /api/v1/tickets/:ticketId/history');
    try {
      const history = await ctx.ticketService.getStatusHistory(ticketId as string, limit);
      res.json({ success: true, ticketId, history });
    } catch (error) {
      logger.error({ err: error, ticketId }, 'Failed to fetch ticket status history');
      res.status(500).json({ success: false, error: 'Failed to fetch ticket history' });
    }
  });

  // ═══ TICKET REPLY ═══

  router.post('/tickets/:ticketId/reply', async (req: Request, res: Response) => {
    try {
      const { ticketId } = req.params;
      const { text } = req.body || {};
      if (!text || typeof text !== 'string' || !text.trim()) {
        res.status(400).json({ success: false, error: 'Reply text is required' });
        return;
      }
      logger.info({ ticketId }, 'POST /api/v1/tickets/:ticketId/reply');

      // Persist the operator message to the primary task thread (durable update intent)
      const interactionResult = await ctx.ticketInteractionService.processInteraction({
        ticketId: ticketId as string,
        text: text.trim(),
        intent: 'update',
        source: 'cockpit-reply',
      });

      // Broadcast via SSE regardless of persistence outcome (real-time UI feedback)
      emitTicketActivity(ticketId as string, interactionResult.activityEntry);

      res.json({ success: interactionResult.success, reply: interactionResult.activityEntry });
    } catch (error) {
      logger.error({ err: error }, 'Failed to post ticket reply');
      res.status(500).json({ success: false, error: 'Failed to post reply' });
    }
  });

  return router;
}

/** @description Build swarm health summary from runtime registry. */
async function buildSwarmHealth(ctx: AppContext): Promise<{ healthy: number; degraded: number; offline: number }> {
  const registry = ctx.swarm?.runtimeRegistryService;
  if (!registry) return { healthy: 0, degraded: 0, offline: 0 };
  try {
    const runtimeRegistrations = await registry.listAgentRegistrations();
    const runtimeByAgentId = new Map(runtimeRegistrations.map((registration) => [registration.agentId, registration]));
    const runtimeByName = new Map(runtimeRegistrations.map((registration) => [registration.agentName, registration]));
    const agentStatusMap = await loadAgentStatusMap(ctx);

    let healthy = 0;
    let degraded = 0;
    let offline = 0;

    getActiveRegistry().forEach((bot) => {
      const runtimeRegistration = (bot.agentId ? runtimeByAgentId.get(bot.agentId) : undefined)
        ?? runtimeByName.get(bot.name);
      const dbStatus = normalizeAgentStatus(
        agentStatusMap.get(bot.agentId || '')
        || agentStatusMap.get(bot.name)
        || 'active',
      );

      if (runtimeRegistration?.status === 'online') {
        healthy += 1;
        return;
      }

      if (dbStatus === 'inactive' || dbStatus === 'disabled' || dbStatus === 'paused') {
        degraded += 1;
        return;
      }

      // Inline/api-hosted bots never heartbeat; a registered, non-disabled inline bot is healthy
      // (the api is up). Only dedicated bot-nodes with no heartbeat fall through to offline.
      if (resolveDisplayOnline(false, bot.container)) {
        healthy += 1;
        return;
      }

      offline += 1;
    });

    return { healthy, degraded, offline };
  } catch {
    return { healthy: 0, degraded: 0, offline: getActiveRegistry().length };
  }
}

function resolveCockpitOwnerSub(req: Request): string | undefined {
  if (req.query.scope === 'all' && isOperator(req)) {
    return undefined;
  }
  return getCaller(req).sub ?? '__missing-caller__';
}

/** @description Query hourly cost buckets from chat_tasks for the last 24 hours. */
async function buildCostSeries(ctx: AppContext, ownerSub?: string): Promise<Array<{ hour: number; label: string; amount: number }>> {
  const pool = ctx.pool;
  if (!pool) return [];
  try {
    const result = await pool.query(`
      SELECT EXTRACT(HOUR FROM updated_at) AS hour, COALESCE(SUM(total_cost), 0) AS amount
      FROM chat_tasks
      WHERE updated_at >= NOW() - INTERVAL '24 hours'
        AND total_cost > 0
        AND ($1::text IS NULL OR owner_sub = $1)
      GROUP BY EXTRACT(HOUR FROM updated_at)
      ORDER BY hour`, [ownerSub ?? null]);
    const buckets = Array.from({ length: 24 }, (_, i) => ({
      hour: i, label: `${String(i).padStart(2, '0')}:00`, amount: 0,
    }));
    for (const row of result.rows) {
      const h = parseInt(String(row.hour), 10);
      if (h >= 0 && h < 24) buckets[h].amount = parseFloat(row.amount) || 0;
    }
    return buckets;
  } catch {
    return [];
  }
}

/** @description DA-5: Build online/busy/idle breakdown from pre-computed healthy count + work_items. */
async function buildAgentStateBreakdown(ctx: AppContext, onlineCount: number): Promise<{ online: number; busy: number; idle: number }> {
  try {
    let busy = 0;
    if (ctx.pool) {
      const result = await ctx.pool.query(
        `SELECT COUNT(DISTINCT agent_id) AS cnt FROM work_items WHERE status IN ('executing', 'subtask-executing', 'pending')`,
      );
      busy = parseInt(result.rows[0]?.cnt ?? '0', 10);
    }
    return { online: onlineCount, busy: Math.min(busy, onlineCount), idle: Math.max(onlineCount - busy, 0) };
  } catch {
    return { online: onlineCount, busy: 0, idle: onlineCount };
  }
}

async function loadAgentStatusMap(ctx: AppContext): Promise<Map<string, string>> {
  const statusMap = new Map<string, string>();
  if (!ctx.pool) {
    return statusMap;
  }

  try {
    const statusResult = await ctx.pool.query('SELECT agent_id, name, status FROM agents');
    statusResult.rows.forEach((row) => {
      if (typeof row.agent_id === 'string' && row.agent_id.trim()) {
        statusMap.set(row.agent_id.trim(), row.status);
      }
      if (typeof row.name === 'string' && row.name.trim()) {
        statusMap.set(row.name.trim(), row.status);
      }
    });
  } catch (error) {
    logger.warn({ err: error }, 'Failed to load agent statuses for cockpit metrics');
  }

  return statusMap;
}

interface AgentTelemetrySummaryEntry { totalRequests: number; totalCost: number; totalInputTokens: number; totalOutputTokens: number; updatedAt: string | null }

async function loadAgentTelemetrySummary(ctx: AppContext, ownerSub?: string): Promise<Map<string, AgentTelemetrySummaryEntry>> {
  const summaries = new Map<string, AgentTelemetrySummaryEntry>();
  if (!ctx.pool) {
    return summaries;
  }

  try {
    const result = await ctx.pool.query(`
      SELECT
        agent_id,
        COALESCE(SUM(total_requests), 0) AS total_requests,
        COALESCE(SUM(total_cost), 0) AS total_cost,
        COALESCE(SUM(total_input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(total_output_tokens), 0) AS total_output_tokens,
        MAX(updated_at) AS updated_at
      FROM chat_tasks
      WHERE agent_id IS NOT NULL
        AND ($1::text IS NULL OR owner_sub = $1)
      GROUP BY agent_id
    `, [ownerSub ?? null]);

    result.rows.forEach((row) => {
      const agentId = typeof row.agent_id === 'string' ? row.agent_id.trim() : '';
      if (!agentId) {
        return;
      }
      summaries.set(agentId, {
        totalRequests: Number.parseInt(String(row.total_requests ?? 0), 10) || 0,
        totalCost: Number.parseFloat(String(row.total_cost ?? 0)) || 0,
        totalInputTokens: Number.parseInt(String(row.total_input_tokens ?? 0), 10) || 0,
        totalOutputTokens: Number.parseInt(String(row.total_output_tokens ?? 0), 10) || 0,
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : null,
      });
    });
  } catch (error) {
    logger.warn({ err: error }, 'Failed to load chat telemetry for cockpit agent metrics');
  }

  return summaries;
}

function createEmptyAgentTelemetrySummary(): AgentTelemetrySummaryEntry {
  return {
    totalRequests: 0,
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    updatedAt: null,
  };
}

function resolveCanonicalBotId(
  agentId: string,
  definitionsById: Map<string, (typeof SWARM_BOT_REGISTRY)[number]>,
  definitionsByName: Map<string, (typeof SWARM_BOT_REGISTRY)[number]>,
): string {
  const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
  if (!normalizedAgentId) {
    return '';
  }
  return definitionsById.get(normalizedAgentId)?.agentId
    || definitionsByName.get(normalizedAgentId)?.agentId
    || definitionsByName.get(normalizedAgentId)?.name
    || normalizedAgentId;
}

function normalizeAgentStatus(status: unknown): string {
  return typeof status === 'string' ? status.trim().toLowerCase() : 'active';
}

function readTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * @description Enriches a ticket hierarchy with aggregated cost data from linked chat_tasks.
 * Root tickets use ticket_cost_rollup_with_children (recursive) to include descendant costs.
 * Child tickets use ticket_cost_rollup (direct) to show their own costs only.
 */
async function enrichTicketsWithCostRollup(
  tickets: Array<Record<string, unknown>>,
  ctx: AppContext,
): Promise<void> {
  if (!ctx.pool) {
    return;
  }
  try {
    // Recursive view for root tickets — includes all descendant costs
    const recursiveResult = await ctx.pool.query(
      `SELECT ticket_id, total_cost, total_tokens, total_requests, task_count, agent_count, child_ticket_count
       FROM ticket_cost_rollup_with_children
       WHERE total_cost > 0 OR total_tokens > 0`,
    );
    const recursiveCostMap = new Map<string, Record<string, unknown>>();
    for (const row of recursiveResult.rows) {
      recursiveCostMap.set(row.ticket_id, row);
    }
    // Direct view for child tickets — own costs only
    const directResult = await ctx.pool.query(
      `SELECT ticket_id, total_cost, total_tokens, total_requests, task_count, agent_count
       FROM ticket_cost_rollup
       WHERE total_cost > 0 OR total_tokens > 0`,
    );
    const directCostMap = new Map<string, Record<string, unknown>>();
    for (const row of directResult.rows) {
      directCostMap.set(row.ticket_id, row);
    }
    const applyToTree = (nodes: Array<Record<string, unknown>>, isChild = false): void => {
      for (const node of nodes) {
        const id = String(node.ticketId || node.id);
        const cost = isChild ? directCostMap.get(id) : (recursiveCostMap.get(id) || directCostMap.get(id));
        if (cost) {
          node.estimatedCost = Number(cost.total_cost) || 0;
          node.actualCost = Number(cost.total_cost) || 0;
          node.totalTokens = Number(cost.total_tokens) || 0;
          node.totalRequests = Number(cost.total_requests) || 0;
          if (cost.child_ticket_count != null) {
            node.childTicketCount = Number(cost.child_ticket_count) || 0;
          }
        }
        if (Array.isArray(node.children)) {
          applyToTree(node.children as Array<Record<string, unknown>>, true);
        }
      }
    };
    applyToTree(tickets);
    logger.info({ enrichedCount: recursiveCostMap.size + directCostMap.size }, 'Enriched ticket hierarchy with cost rollup');
  } catch (error) {
    logger.warn({ err: error }, 'Cost rollup enrichment failed (non-fatal)');
  }
}
