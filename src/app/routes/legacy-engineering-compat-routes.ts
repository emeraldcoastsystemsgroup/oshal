/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of legacy engineering screen HTML routes and API compatibility stubs
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Replaced placeholder compatibility payloads with live snapshots from swarm, ticketing, scheduler, and mesh services
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Removed legacy queue-manager-admin HTML route now that native OSHAL page owns /queue-manager-admin
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Removed legacy mesh/ops HTML route ownership now that native OSHAL pages own /mesh-dashboard and /ops-dashboard
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added routing_failed visibility to compatibility activity payloads so engineering views can surface orphaned work-item failures
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added bot lifecycle status endpoint so engineering screens can query restart/rebuild target health directly
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | BF-030: Seed agent registry rows by agentId (UUID) instead of bot.name (slug) to prevent duplicate slug+UUID rows
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | A4/TD-15: Decomposed 1082-line file into types, helpers, and builders modules (governance cap compliance)
 */
import { createChildLogger } from '@/shared/logger';
import { SwarmBotLifecycleService } from '@/features/agent-management';
import type { LegacyEngineeringCompatRoutesOptions } from './legacy-engineering-compat-types';
import {
  readLifecycleTarget,
  isAllowedHealthTarget,
  parseJsonOrFallback,
} from './legacy-engineering-compat-helpers';
import {
  collectRuntimeSnapshot,
  buildLegacyAgentRegistry,
  buildHealthDashboardNodes,
  buildScheduledJobs,
  buildRoutingDecisions,
  buildQueueMetrics,
  buildRawKeyStats,
  buildTicketPhases,
  buildDispatches,
  buildModelUsageSnapshot,
  buildProjectUsageSnapshot,
  buildTicketUsageSnapshot,
  buildRoutingFailures,
  buildAgentTicketMappings,
  buildLegacyActiveTickets,
} from './legacy-engineering-compat-builders';

export type { LegacyEngineeringCompatRoutesOptions } from './legacy-engineering-compat-types';

const logger = createChildLogger({ module: 'legacy-engineering-compat-routes' });

/**
 * @description Registers legacy engineering HTML page routes and API compatibility endpoints
 * backed by live OSHAL runtime snapshots.
 */
export function registerLegacyEngineeringCompatRoutes(
  options: LegacyEngineeringCompatRoutesOptions,
): void {
  const { app, requiresAuth, ctx } = options;
  const botLifecycleService = new SwarmBotLifecycleService();
  logger.info('Registering legacy engineering compatibility API routes');

  app.get('/api/health-dashboard/registry', requiresAuth, async (_req, res) => {
    const snapshot = await collectRuntimeSnapshot(ctx);
    const agents = buildLegacyAgentRegistry(snapshot);
    const nodes = buildHealthDashboardNodes(agents);
    logger.info(
      {
        agentNodes: nodes.filter((node) => node.category === 'agent').length,
        totalNodes: nodes.length,
      },
      'GET /api/health-dashboard/registry',
    );
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      nodes,
      sources: {
        agents: agents.length,
        schedules: snapshot.schedules.length,
        runs: snapshot.runs.length,
      },
    });
  });

  app.post('/api/health-dashboard/nodes', requiresAuth, async (_req, res) => {
    const snapshot = await collectRuntimeSnapshot(ctx);
    const agents = buildLegacyAgentRegistry(snapshot);
    const nodes = agents.map((agent) => ({
      name: agent.agent_id,
      port: agent.port,
      emoji: '\u{1F916}',
      type: 'agent',
      links: agent.port
        ? [{ label: 'Health', url: `http://localhost:${agent.port}/health` }]
        : [],
    }));
    logger.info({ count: nodes.length }, 'POST /api/health-dashboard/nodes');
    res.json({ success: true, nodes, count: nodes.length });
  });

  app.get('/api/health-dashboard/nodes', requiresAuth, async (_req, res) => {
    const snapshot = await collectRuntimeSnapshot(ctx);
    const agents = buildLegacyAgentRegistry(snapshot);
    const nodes = agents.map((agent) => ({
      name: agent.agent_id,
      port: agent.port,
      emoji: '\u{1F916}',
      type: 'agent',
      links: agent.port
        ? [{ label: 'Health', url: `http://localhost:${agent.port}/health` }]
        : [],
    }));
    logger.info({ count: nodes.length }, 'GET /api/health-dashboard/nodes');
    res.json({ success: true, nodes, count: nodes.length });
  });

  app.get('/api/redis-visibility', requiresAuth, async (_req, res) => {
    const snapshot = await collectRuntimeSnapshot(ctx);
    const agentRegistry = buildLegacyAgentRegistry(snapshot);
    const scheduledJobs = buildScheduledJobs(snapshot.schedules);
    const routingDecisions = buildRoutingDecisions(snapshot.routingDecisions);
    const queueMetrics = buildQueueMetrics(snapshot);
    const rawKeyStats = buildRawKeyStats(snapshot, agentRegistry, queueMetrics);
    logger.info(
      {
        agents: agentRegistry.length,
        schedules: scheduledJobs.length,
        routingDecisions: routingDecisions.length,
      },
      'GET /api/redis-visibility',
    );
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      redisInsightUrl: process.env.REDIS_INSIGHT_URL || 'http://localhost:5540',
      agentRegistry,
      scheduledJobs,
      routingDecisions,
      queueMetrics,
      rawKeyStats,
    });
  });

  app.get('/api/qm/activity', requiresAuth, async (_req, res) => {
    const snapshot = await collectRuntimeSnapshot(ctx);
    const agents = buildLegacyAgentRegistry(snapshot);
    const ticketPhases = buildTicketPhases(snapshot.tickets);
    const dispatches = buildDispatches(snapshot.tasks);
    const routingFailures = buildRoutingFailures(snapshot.workItems);
    logger.info(
      {
        agents: agents.length,
        ticketPhases: Object.keys(ticketPhases).length,
        dispatches: Object.keys(dispatches).length,
        routingFailures: routingFailures.length,
      },
      'GET /api/qm/activity',
    );
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      agents: Object.fromEntries(
        agents.map((agent) => [agent.agent_id, agent]),
      ),
      ticketPhases,
      dispatches,
      modelUsage: buildModelUsageSnapshot(snapshot.tasks),
      projectUsage: buildProjectUsageSnapshot(snapshot.tasks),
      ticketUsage: buildTicketUsageSnapshot(snapshot.tasks),
      agentTicketMappings: buildAgentTicketMappings(ticketPhases, dispatches),
      routingFailures,
      cooldowns: {},
      locks: {},
    });
  });

  app.get('/api/proxy-health', requiresAuth, async (req, res) => {
    const target = typeof req.query.url === 'string' ? req.query.url : '';
    logger.info({ target }, 'GET /api/proxy-health');
    if (!target) {
      res.json({ success: false, error: 'No target URL provided' });
      return;
    }
    if (!isAllowedHealthTarget(target)) {
      res.status(403).json({
        success: false,
        error: 'Only localhost/swarm/oshal health checks are allowed',
      });
      return;
    }
    try {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(target, { signal: controller.signal });
      clearTimeout(timeout);
      const text = await response.text();
      const parsed = parseJsonOrFallback(text, response.ok);
      res.json({
        success: response.ok,
        status: response.status,
        target,
        latencyMs: Date.now() - startedAt,
        data: parsed,
      });
    } catch (error) {
      logger.warn({ err: error, target }, 'Proxy health check failed');
      res.json({ success: false, error: 'Health check failed', target });
    }
  });

  app.post('/api/bot/restart', requiresAuth, async (req, res) => {
    const containerName = readLifecycleTarget(req.body);
    logger.info({ containerName }, 'POST /api/bot/restart');
    try {
      const result = await botLifecycleService.restart(containerName);
      res.json({ success: true, result });
    } catch (error) {
      logger.error({ err: error, containerName }, 'POST /api/bot/restart failed');
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Bot restart failed',
      });
    }
  });

  app.post('/api/bot/rebuild', requiresAuth, async (req, res) => {
    const containerName = readLifecycleTarget(req.body);
    logger.info({ containerName }, 'POST /api/bot/rebuild');
    try {
      const result = await botLifecycleService.rebuild(containerName);
      res.json({ success: true, result });
    } catch (error) {
      logger.error({ err: error, containerName }, 'POST /api/bot/rebuild failed');
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Bot rebuild failed',
      });
    }
  });

  app.post('/api/bot/rollback', requiresAuth, async (req, res) => {
    const containerName = readLifecycleTarget(req.body);
    logger.info({ containerName }, 'POST /api/bot/rollback');
    try {
      const result = await botLifecycleService.rollback(containerName);
      res.json({ success: true, result });
    } catch (error) {
      logger.error({ err: error, containerName }, 'POST /api/bot/rollback failed');
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Bot rollback failed',
      });
    }
  });

  app.get('/api/bot/status', requiresAuth, async (req, res) => {
    const containerName = readLifecycleTarget(req.query);
    logger.info({ containerName }, 'GET /api/bot/status');
    try {
      const result = await botLifecycleService.status(containerName);
      logger.info(
        { containerName, success: result.success },
        'GET /api/bot/status complete',
      );
      res.json({ success: true, result });
    } catch (error) {
      logger.error({ err: error, containerName }, 'GET /api/bot/status failed');
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Bot status failed',
      });
    }
  });

  app.get('/api/mesh/channels', requiresAuth, async (_req, res) => {
    const snapshot = await collectRuntimeSnapshot(ctx);
    const channels = snapshot.channels.map((channel) => ({
      mesh_id: channel.channelId,
      topic: channel.channelName,
      scope: channel.ticketExternalId ? 'ticket' : 'adhoc',
      status: channel.expired ? 'dissolved' : 'active',
      members: channel.participants,
      message_count: channel.messageCount,
      ticket_id: channel.ticketExternalId ?? null,
      created_at: channel.createdAt,
      last_message: null,
    }));
    logger.info({ count: channels.length }, 'GET /api/mesh/channels');
    res.json({ success: true, channels });
  });

  app.post('/api/mesh/create', requiresAuth, (req, res) => {
    logger.info({ bodyKeys: Object.keys(req.body || {}) }, 'POST /api/mesh/create (compat no-op)');
    res.json({
      success: false,
      message:
        'Mesh channel creation is not yet wired through the compatibility layer.',
    });
  });

  app.get('/api/tickets/active', requiresAuth, async (_req, res) => {
    const tickets = await buildLegacyActiveTickets(ctx);
    logger.info({ count: tickets.length }, 'GET /api/tickets/active');
    res.json({ success: true, tickets, count: tickets.length });
  });

  logger.info('Legacy engineering compatibility routes registered');
}
