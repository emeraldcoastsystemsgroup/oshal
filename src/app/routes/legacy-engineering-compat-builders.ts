/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | A4/TD-15: Extracted builder functions from legacy-engineering-compat-routes.ts (1082 → <1000 decomposition)
 */
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { RedisScheduleStore, type ScheduleRecord } from '@/features/scheduling';
import { SWARM_BOT_REGISTRY } from '@/app/extensions/swarm/routes/bot-registry-routes';
import type { ModelUsageStats, StoredTask } from '@/shared/types';
import type { InternalTicket } from '@/entities/ticket';
import type { RoutingAuditEntry } from '@/features/operational-intelligence';
import type { SwarmRunRecord } from '@/features/swarm-orchestration';
import type {
  LegacyAgentRegistryRow,
  LegacyHealthDashboardNode,
  RuntimeSnapshot,
} from './legacy-engineering-compat-types';
import {
  TASK_STATUS_ACTIVE,
  ROUTING_FAILED_STATUS,
  readOptionalString,
  readOptionalNumber,
  readRecord,
  chooseLatestTimestamp,
  humanizeTicketState,
  mapOshalStateToLegacyGroup,
  mapTaskStateToLegacyGroup,
  normalizeUsageByModel,
  mergeModelUsageMaps,
  pickPrimaryModel,
  pickLatestModel,
  readTaskTotalTokens,
  readTaskTicketId,
  resolveProjectSelection,
  normalizeModelUsageNumber,
  normalizeModelUsageFloat,
  humanizeTaskState,
} from './legacy-engineering-compat-helpers';

const logger = createChildLogger({ module: 'legacy-engineering-compat-builders' });

// ---------------------------------------------------------------------------
// Snapshot Collection
// ---------------------------------------------------------------------------

/**
 * @description Collects an aggregated runtime snapshot from all OSHAL subsystems.
 */
export async function collectRuntimeSnapshot(
  ctx: Pick<AppContext, 'taskStore' | 'ticketService' | 'swarm'>,
): Promise<RuntimeSnapshot> {
  const [tasks, tickets, runs, workItems, schedules] = await Promise.all([
    safeListTasks(ctx),
    safeListTickets(ctx),
    safeListRuns(ctx),
    safeListWorkItems(ctx),
    safeListSchedules(),
  ]);
  const routingDecisions =
    ctx.swarm.routingAuditLog?.query({ limit: 100 }) ?? [];
  const channels =
    ctx.swarm.privateMeshManager?.getActiveChannels() ?? [];
  return {
    tasks,
    tickets,
    runs,
    workItems,
    schedules,
    routingDecisions,
    channels,
  };
}

async function safeListTasks(
  ctx: Pick<AppContext, 'taskStore'>,
): Promise<StoredTask[]> {
  try {
    return await ctx.taskStore.list({ limit: 500 });
  } catch (error) {
    logger.warn({ err: error }, 'Failed to load tasks for compatibility snapshot');
    return [];
  }
}

async function safeListTickets(
  ctx: Pick<AppContext, 'ticketService'>,
): Promise<InternalTicket[]> {
  try {
    return await ctx.ticketService.listTickets({ limit: 300 });
  } catch (error) {
    logger.warn({ err: error }, 'Failed to load tickets for compatibility snapshot');
    return [];
  }
}

async function safeListRuns(
  ctx: Pick<AppContext, 'swarm'>,
): Promise<SwarmRunRecord[]> {
  try {
    return await (ctx.swarm.swarmTicketProcessingService?.listRuns(100) ??
      Promise.resolve([]));
  } catch (error) {
    logger.warn({ err: error }, 'Failed to load swarm runs for compatibility snapshot');
    return [];
  }
}

async function safeListWorkItems(
  ctx: Pick<AppContext, 'swarm'>,
): Promise<Array<Record<string, unknown>>> {
  try {
    const repository = (
      ctx.swarm as {
        workItemRepository?: {
          listRecent?: (limit?: number) => Promise<unknown[]>;
        };
      }
    ).workItemRepository;
    if (!repository?.listRecent) {
      return [];
    }
    const items = await repository.listRecent(300);
    return Array.isArray(items)
      ? (items as Array<Record<string, unknown>>)
      : [];
  } catch (error) {
    logger.warn({ err: error }, 'Failed to load work items for compatibility snapshot');
    return [];
  }
}

async function safeListSchedules(): Promise<ScheduleRecord[]> {
  const scheduleStore = new RedisScheduleStore();
  try {
    return await scheduleStore.listSchedules();
  } catch (error) {
    logger.warn({ err: error }, 'Failed to load schedules for compatibility snapshot');
    return [];
  } finally {
    await scheduleStore.close();
  }
}

// ---------------------------------------------------------------------------
// Agent Registry Builder
// ---------------------------------------------------------------------------

/**
 * @description Builds a legacy-format agent registry from the runtime snapshot,
 * merging swarm bot definitions with live task/ticket/schedule/routing data.
 */
export function buildLegacyAgentRegistry(
  snapshot: RuntimeSnapshot,
): LegacyAgentRegistryRow[] {
  const knownById = new Map<
    string,
    (typeof SWARM_BOT_REGISTRY)[number]
  >();
  for (const bot of SWARM_BOT_REGISTRY) {
    knownById.set(bot.name, bot);
    if (bot.agentId) {
      knownById.set(bot.agentId, bot);
    }
  }

  const rows = new Map<string, LegacyAgentRegistryRow>();

  const ensureRow = (agentId: string): LegacyAgentRegistryRow => {
    const existing = rows.get(agentId);
    if (existing) {
      return existing;
    }
    const known = knownById.get(agentId);
    const row: LegacyAgentRegistryRow = {
      agent_id: agentId,
      agent_name: known?.name,
      status: 'idle',
      enabled: true,
      capabilities: known?.capabilities ?? [],
      current_load: 0,
      max_concurrent: 3,
      port: known?.port,
      workspaces: ['*'],
      ttl_seconds: 300,
      ttl: 300,
      total_tokens: 0,
      total_cost: 0,
      total_requests: 0,
      latest_model: null,
      usage_by_model: {},
    };
    rows.set(agentId, row);
    return row;
  };

  SWARM_BOT_REGISTRY.forEach((bot) => {
    ensureRow(bot.agentId ?? bot.name);
  });

  enrichFromTasks(snapshot.tasks, ensureRow);
  enrichFromTickets(snapshot.tickets, ensureRow);
  enrichFromSchedules(snapshot.schedules, ensureRow);
  enrichFromRoutingDecisions(snapshot.routingDecisions, ensureRow);
  enrichFromChannels(snapshot.channels, ensureRow);

  rows.forEach((row) => {
    row.status = row.current_load > 0 ? 'busy' : 'idle';
    row.ttl_seconds = row.current_load > 0 ? 120 : 300;
    row.ttl = row.ttl_seconds;
    row.lastHeartbeat = row.last_heartbeat;
  });

  return [...rows.values()].sort((left, right) => {
    const leftPort = left.port ?? Number.MAX_SAFE_INTEGER;
    const rightPort = right.port ?? Number.MAX_SAFE_INTEGER;
    if (leftPort !== rightPort) {
      return leftPort - rightPort;
    }
    return left.agent_id.localeCompare(right.agent_id);
  });
}

function enrichFromTasks(
  tasks: StoredTask[],
  ensureRow: (agentId: string) => LegacyAgentRegistryRow,
): void {
  tasks.forEach((task) => {
    const agentId = readOptionalString(task.agentId);
    if (!agentId) {
      return;
    }
    const row = ensureRow(agentId);
    row.total_tokens = (row.total_tokens || 0) + readTaskTotalTokens(task);
    row.total_cost =
      (row.total_cost || 0) + (readOptionalNumber(task.totalCost) || 0);
    row.total_requests =
      (row.total_requests || 0) +
      (readOptionalNumber(task.totalRequests) || 0);
    row.usage_by_model = mergeModelUsageMaps(
      row.usage_by_model || {},
      normalizeUsageByModel(task.usageByModel),
    );
    row.latest_model = pickLatestModel(row.latest_model, task);
    if (TASK_STATUS_ACTIVE.has(task.status)) {
      row.current_load += 1;
    }
    row.last_heartbeat = chooseLatestTimestamp(
      row.last_heartbeat,
      task.updatedAt,
    );
  });
}

function enrichFromTickets(
  tickets: InternalTicket[],
  ensureRow: (agentId: string) => LegacyAgentRegistryRow,
): void {
  tickets.forEach((ticket) => {
    const agentId = readOptionalString(ticket.assignedAgentId);
    if (!agentId) {
      return;
    }
    const row = ensureRow(agentId);
    row.last_heartbeat = chooseLatestTimestamp(
      row.last_heartbeat,
      ticket.updatedAt,
    );
  });
}

function enrichFromSchedules(
  schedules: ScheduleRecord[],
  ensureRow: (agentId: string) => LegacyAgentRegistryRow,
): void {
  schedules.forEach((schedule) => {
    const agentId = readOptionalString(schedule.taskData?.targetAgent);
    if (!agentId) {
      return;
    }
    ensureRow(agentId);
  });
}

function enrichFromRoutingDecisions(
  decisions: RoutingAuditEntry[],
  ensureRow: (agentId: string) => LegacyAgentRegistryRow,
): void {
  decisions.forEach((decision) => {
    const agentId = readOptionalString(decision.winnerAgentId);
    if (!agentId) {
      return;
    }
    const row = ensureRow(agentId);
    row.last_heartbeat = chooseLatestTimestamp(
      row.last_heartbeat,
      decision.createdAt,
    );
  });
}

function enrichFromChannels(
  channels: RuntimeSnapshot['channels'],
  ensureRow: (agentId: string) => LegacyAgentRegistryRow,
): void {
  channels.forEach((channel) => {
    channel.participants.forEach((agentId) => {
      if (!agentId) {
        return;
      }
      const row = ensureRow(agentId);
      row.last_heartbeat = chooseLatestTimestamp(
        row.last_heartbeat,
        channel.createdAt,
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Health Dashboard Builder
// ---------------------------------------------------------------------------

/**
 * @description Builds an array of health dashboard nodes from the agent registry,
 * adding static service nodes (Redis, Postgres, Plane).
 */
export function buildHealthDashboardNodes(
  agents: LegacyAgentRegistryRow[],
): LegacyHealthDashboardNode[] {
  const agentNodes = agents.map((agent) => ({
    name: agent.agent_id,
    port: agent.port ?? null,
    emoji: '\u{1F916}',
    type: 'agent',
    category: 'agent' as const,
    links: agent.port
      ? [
          { label: 'Health', url: `http://localhost:${agent.port}/health` },
          { label: 'Chat', url: `http://localhost:${agent.port}/chat` },
        ]
      : [],
    source: 'swarm-registry',
    status: agent.status,
    capabilities: agent.capabilities,
    healthPath: '/health',
  }));

  const serviceNodes: LegacyHealthDashboardNode[] = [
    {
      name: 'OSHAL Control Plane',
      port: parseInt(process.env.PORT || '3456', 10),
      emoji: '\u{1F9E0}',
      type: 'control-plane',
      category: 'service',
      links: [{ label: 'Health', url: '/api/health' }],
      source: 'OSHAL',
      status: 'active',
      capabilities: ['chat', 'swarm', 'config', 'scheduling'],
      healthPath: '/api/health',
    },
    {
      name: 'Redis',
      port: 6379,
      emoji: '\u{1F5C4}\uFE0F',
      type: 'redis',
      category: 'service',
      links: [
        {
          label: 'RedisInsight',
          url: process.env.REDIS_INSIGHT_URL || 'http://localhost:5540',
        },
      ],
      source: 'infra',
      status: 'unknown',
      noHttp: true,
    },
    {
      name: 'Postgres',
      port: 5432,
      emoji: '\u{1F418}',
      type: 'postgres',
      category: 'service',
      links: [],
      source: 'infra',
      status: 'unknown',
      noHttp: true,
    },
  ];

  const planeBaseUrl = readOptionalString(process.env.PLANE_API_URL);
  const planeNode = planeBaseUrl
    ? [
        {
          name: 'Plane API',
          port: null,
          emoji: '\u2708\uFE0F',
          type: 'plane',
          category: 'plane' as const,
          links: [{ label: 'Plane API', url: planeBaseUrl }],
          source: 'config',
          status: 'configured',
          noHttp: false,
        },
      ]
    : [];

  return [...agentNodes, ...serviceNodes, ...planeNode];
}

// ---------------------------------------------------------------------------
// Activity / Metrics Builders
// ---------------------------------------------------------------------------

/**
 * @description Transforms schedule records into the legacy scheduled-jobs payload shape.
 */
export function buildScheduledJobs(
  schedules: ScheduleRecord[],
): Array<Record<string, unknown>> {
  return schedules.map((schedule) => ({
    id: schedule.id,
    name: schedule.taskType,
    taskType: schedule.taskType,
    targetAgent:
      readOptionalString(schedule.taskData.targetAgent) || null,
    cron: schedule.cron,
    status: schedule.status,
    executionCount: schedule.executionCount,
    nextRun: schedule.nextRunAt,
    nextRunAt: schedule.nextRunAt,
    lastExecution: schedule.lastRunAt,
    lastRunAt: schedule.lastRunAt,
    description: buildScheduleDescription(schedule),
  }));
}

function buildScheduleDescription(schedule: ScheduleRecord): string {
  const prompt = readOptionalString(schedule.taskData.prompt) || '';
  if (!prompt) {
    return '';
  }
  return prompt.length > 120 ? `${prompt.slice(0, 117)}...` : prompt;
}

/**
 * @description Transforms routing audit entries into the legacy routing-decisions payload shape.
 */
export function buildRoutingDecisions(
  entries: RoutingAuditEntry[],
): Array<Record<string, unknown>> {
  return entries.map((entry) => ({
    ticketId: entry.ticketExternalId || entry.taskId,
    selectedAgent: entry.winnerAgentId,
    score: entry.winnerScore,
    strategy: entry.strategy,
    reason: `strategy=${entry.strategy}; tiers=${entry.tiersAttempted.join(' > ')}`,
    timestamp: entry.createdAt,
  }));
}

/**
 * @description Computes queue metrics across swarm runs, tasks, schedules, and tickets.
 */
export function buildQueueMetrics(
  snapshot: RuntimeSnapshot,
): Record<string, Record<string, number>> {
  const runCounts = snapshot.runs.reduce(
    (acc, run) => {
      acc[run.status] += 1;
      return acc;
    },
    { in_progress: 0, completed: 0, failed: 0 } as Record<string, number>,
  );

  const taskActiveCount = snapshot.tasks.filter((task) =>
    TASK_STATUS_ACTIVE.has(task.status),
  ).length;
  const taskFailedCount = snapshot.tasks.filter(
    (task) => task.status === 'failed',
  ).length;
  const scheduleActiveCount = snapshot.schedules.filter(
    (schedule) => schedule.status === 'active',
  ).length;
  const schedulePausedCount = snapshot.schedules.filter(
    (schedule) => schedule.status === 'paused',
  ).length;
  const scheduleRuns = snapshot.schedules.reduce(
    (total, schedule) => total + (schedule.executionCount || 0),
    0,
  );

  return {
    'swarm-runs': {
      waiting: runCounts.in_progress,
      active: taskActiveCount,
      completed: runCounts.completed,
      failed: runCounts.failed,
      delayed: 0,
      repeatJobs: 0,
    },
    'agent-scheduler': {
      waiting: scheduleActiveCount,
      active: scheduleActiveCount,
      completed: scheduleRuns,
      failed: 0,
      delayed: schedulePausedCount,
      repeatJobs: snapshot.schedules.length,
    },
    'ticketing-state': {
      waiting: snapshot.tickets.filter(
        (ticket) =>
          ticket.stateGroup === 'backlog' ||
          ticket.stateGroup === 'approved',
      ).length,
      active: snapshot.tickets.filter(
        (ticket) => ticket.stateGroup === 'in_process',
      ).length,
      completed: snapshot.tickets.filter(
        (ticket) => ticket.stateGroup === 'complete',
      ).length,
      failed: snapshot.tickets.filter(
        (ticket) => ticket.stateGroup === 'escalated',
      ).length,
      delayed: snapshot.tickets.filter(
        (ticket) => ticket.stateGroup === 'customer_action',
      ).length,
      repeatJobs: 0,
    },
    'task-execution': {
      waiting: snapshot.tasks.filter(
        (task) => task.status === 'created',
      ).length,
      active: taskActiveCount,
      completed: snapshot.tasks.filter(
        (task) => task.status === 'completed',
      ).length,
      failed: taskFailedCount,
      delayed: snapshot.tasks.filter(
        (task) => task.status === 'waiting_for_input',
      ).length,
      repeatJobs: 0,
    },
  };
}

/**
 * @description Builds a raw-key-stats summary for the Redis visibility dashboard.
 */
export function buildRawKeyStats(
  snapshot: RuntimeSnapshot,
  agents: LegacyAgentRegistryRow[],
  queueMetrics: Record<string, Record<string, number>>,
): Record<string, unknown> {
  const namespaces: Record<string, number> = {
    swarm_agents: agents.length,
    swarm_runs: snapshot.runs.length,
    swarm_mesh_channels: snapshot.channels.length,
    swarm_routing_decisions: snapshot.routingDecisions.length,
    scheduler_jobs: snapshot.schedules.length,
    ticket_records: snapshot.tickets.length,
    task_records: snapshot.tasks.length,
  };
  const totalKeys = Object.values(namespaces).reduce(
    (sum, value) => sum + value,
    0,
  );
  return {
    totalKeys,
    namespaces,
    agentKeys: agents.length,
    schedulerKeys: snapshot.schedules.length,
    scheduleKeys: snapshot.schedules.length,
    activeDispatches: snapshot.tasks.filter((task) =>
      TASK_STATUS_ACTIVE.has(task.status),
    ).length,
    ticketPhases: snapshot.tickets.length,
    queueMetrics,
  };
}

/**
 * @description Builds a ticket-phase map keyed by ticket ID.
 */
export function buildTicketPhases(
  tickets: InternalTicket[],
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    tickets.map((ticket) => [
      ticket.ticketId,
      {
        phase: ticket.executionPhase || ticket.status,
        phaseName: humanizeTicketState(ticket.status),
        complexity:
          readOptionalNumber(ticket.metadata?.complexity) ?? null,
        executingAgent:
          readOptionalString(ticket.assignedAgentId) || null,
      },
    ]),
  );
}

/**
 * @description Builds an active-dispatch map keyed by task ID.
 */
export function buildDispatches(
  tasks: StoredTask[],
): Record<string, Record<string, unknown>> {
  const activeTasks = tasks.filter((task) =>
    TASK_STATUS_ACTIVE.has(task.status),
  );
  return Object.fromEntries(
    activeTasks.map((task) => [
      task.taskId,
      {
        ticketId:
          readOptionalString(task.metadata?.ticketId) || task.taskId,
        agentId: readOptionalString(task.agentId) || null,
        providerId: readOptionalString(task.providerId) || null,
        modelId: pickPrimaryModel(
          normalizeUsageByModel(task.usageByModel),
        ),
        status: task.status,
        totalTokens: readTaskTotalTokens(task),
        totalCost: readOptionalNumber(task.totalCost) || 0,
        requestCount: readOptionalNumber(task.totalRequests) || 0,
        ttlSeconds: 120,
        updatedAt: task.updatedAt,
      },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Usage Snapshot Builders
// ---------------------------------------------------------------------------

/**
 * @description Aggregates token/cost usage grouped by LLM model.
 */
export function buildModelUsageSnapshot(
  tasks: StoredTask[],
): Record<string, Record<string, unknown>> {
  const modelUsage: Record<string, Record<string, unknown>> = {};
  tasks.forEach((task) => {
    const agentId = readOptionalString(task.agentId) || 'unknown';
    const usageByModel = normalizeUsageByModel(task.usageByModel);
    Object.entries(usageByModel).forEach(([modelId, stats]) => {
      const current = modelUsage[modelId] || {
        modelId,
        totalTokens: 0,
        totalCost: 0,
        requestCount: 0,
        agentCount: 0,
        agents: [],
      };
      current.totalTokens =
        Number(current.totalTokens) +
        normalizeModelUsageNumber(stats.totalTokens);
      current.totalCost =
        Number(current.totalCost) +
        normalizeModelUsageFloat(stats.totalCost);
      current.requestCount =
        Number(current.requestCount) +
        normalizeModelUsageNumber(stats.requestCount);
      const currentAgents = new Set(
        Array.isArray(current.agents) ? current.agents : [],
      );
      if (agentId) {
        currentAgents.add(agentId);
      }
      current.agents = [...currentAgents];
      current.agentCount = currentAgents.size;
      modelUsage[modelId] = current;
    });
  });
  return modelUsage;
}

/**
 * @description Aggregates token/cost usage grouped by project.
 */
export function buildProjectUsageSnapshot(
  tasks: StoredTask[],
): Record<string, Record<string, unknown>> {
  const projectUsage: Record<string, Record<string, unknown>> = {};
  tasks.forEach((task) => {
    const project = resolveProjectSelection(task);
    const current = projectUsage[project.projectId] || {
      projectId: project.projectId,
      projectName: project.projectName,
      totalTokens: 0,
      totalCost: 0,
      requestCount: 0,
      taskCount: 0,
      ticketCount: 0,
      tickets: [],
      usageByModel: {},
    };
    current.usageByModel = mergeModelUsageMaps(
      normalizeUsageByModel(current.usageByModel),
      normalizeUsageByModel(task.usageByModel),
    );
    current.totalTokens =
      Number(current.totalTokens) + readTaskTotalTokens(task);
    current.totalCost =
      Number(current.totalCost) +
      (readOptionalNumber(task.totalCost) || 0);
    current.requestCount =
      Number(current.requestCount) +
      (readOptionalNumber(task.totalRequests) || 0);
    current.taskCount = Number(current.taskCount) + 1;
    const ticketId = readTaskTicketId(task);
    const tickets = new Set(
      Array.isArray(current.tickets) ? current.tickets : [],
    );
    if (ticketId) {
      tickets.add(ticketId);
    }
    current.tickets = [...tickets];
    current.ticketCount = tickets.size;
    projectUsage[project.projectId] = current;
  });
  return projectUsage;
}

/**
 * @description Aggregates token/cost usage grouped by ticket.
 */
export function buildTicketUsageSnapshot(
  tasks: StoredTask[],
): Record<string, Record<string, unknown>> {
  const ticketUsage: Record<string, Record<string, unknown>> = {};
  tasks.forEach((task) => {
    const ticketId = readTaskTicketId(task) || task.taskId;
    const project = resolveProjectSelection(task);
    const current = ticketUsage[ticketId] || {
      ticketId,
      projectId: project.projectId,
      projectName: project.projectName,
      agentId: readOptionalString(task.agentId) || null,
      modelId: pickPrimaryModel(
        normalizeUsageByModel(task.usageByModel),
      ),
      totalTokens: 0,
      totalCost: 0,
      requestCount: 0,
      taskCount: 0,
      updatedAt: null,
      usageByModel: {},
    };
    current.agentId =
      current.agentId || readOptionalString(task.agentId) || null;
    current.usageByModel = mergeModelUsageMaps(
      normalizeUsageByModel(current.usageByModel),
      normalizeUsageByModel(task.usageByModel),
    );
    current.modelId =
      current.modelId ||
      pickPrimaryModel(normalizeUsageByModel(task.usageByModel));
    current.totalTokens =
      Number(current.totalTokens) + readTaskTotalTokens(task);
    current.totalCost =
      Number(current.totalCost) +
      (readOptionalNumber(task.totalCost) || 0);
    current.requestCount =
      Number(current.requestCount) +
      (readOptionalNumber(task.totalRequests) || 0);
    current.taskCount = Number(current.taskCount) + 1;
    current.updatedAt =
      chooseLatestTimestamp(
        typeof current.updatedAt === 'string'
          ? current.updatedAt
          : undefined,
        task.updatedAt,
      ) || current.updatedAt;
    ticketUsage[ticketId] = current;
  });
  return ticketUsage;
}

// ---------------------------------------------------------------------------
// Routing & Ticket Compatibility Builders
// ---------------------------------------------------------------------------

/**
 * @description Extracts routing_failed work items into a structured failure list.
 */
export function buildRoutingFailures(
  workItems: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return workItems
    .filter(
      (workItem) =>
        readOptionalString(workItem.status) === ROUTING_FAILED_STATUS,
    )
    .map((workItem) => {
      const metadata = readRecord(workItem.metadata);
      const routingFailure = readRecord(metadata.routingFailure);
      return {
        workItemId:
          readOptionalString(workItem.workItemId) ||
          readOptionalString(workItem.work_item_id),
        ticketId:
          readOptionalString(workItem.externalId) ||
          readOptionalString(workItem.external_id),
        unitId:
          readOptionalString(workItem.unitId) ||
          readOptionalString(workItem.unit_id),
        assignedAgentId:
          readOptionalString(workItem.assignedAgentId) ||
          readOptionalString(workItem.assigned_agent_id) ||
          null,
        reason:
          readOptionalString(routingFailure.reason) || 'routing_failed',
        staleMinutes:
          readOptionalNumber(routingFailure.staleMinutes) || null,
        updatedAt:
          readOptionalString(workItem.updatedAt) ||
          readOptionalString(workItem.updated_at) ||
          null,
      };
    });
}

/**
 * @description Builds an agent-to-ticket-IDs mapping from ticket phases and active dispatches.
 */
export function buildAgentTicketMappings(
  ticketPhases: Record<string, Record<string, unknown>>,
  dispatches: Record<string, Record<string, unknown>>,
): Record<string, string[]> {
  const mappings = new Map<string, Set<string>>();

  Object.entries(ticketPhases).forEach(([ticketId, phase]) => {
    const agentId = readOptionalString(phase.executingAgent);
    if (!agentId) {
      return;
    }
    if (!mappings.has(agentId)) {
      mappings.set(agentId, new Set());
    }
    mappings.get(agentId)?.add(ticketId);
  });

  Object.values(dispatches).forEach((dispatch) => {
    const agentId = readOptionalString(dispatch.agentId);
    const ticketId = readOptionalString(dispatch.ticketId);
    if (!agentId || !ticketId) {
      return;
    }
    if (!mappings.has(agentId)) {
      mappings.set(agentId, new Set());
    }
    mappings.get(agentId)?.add(ticketId);
  });

  return Object.fromEntries(
    [...mappings.entries()].map(([agentId, ticketIds]) => [
      agentId,
      [...ticketIds],
    ]),
  );
}

// ---------------------------------------------------------------------------
// Legacy Active Tickets Builder
// ---------------------------------------------------------------------------

/**
 * @description Builds an array of legacy-format active tickets from the runtime snapshot.
 * Falls back to task-based tickets if no internal tickets exist.
 */
export async function buildLegacyActiveTickets(
  ctx: Pick<AppContext, 'taskStore' | 'ticketService'>,
): Promise<Array<Record<string, unknown>>> {
  const tickets = await safeListTickets(ctx);
  if (tickets.length > 0) {
    return tickets.map((ticket, index) =>
      mapInternalTicketToLegacyTicket(ticket, index),
    );
  }
  const tasks = await safeListTasks(ctx);
  return tasks.map((task, index) => mapTaskToLegacyTicket(task, index));
}

function mapInternalTicketToLegacyTicket(
  ticket: InternalTicket,
  index: number,
): Record<string, unknown> {
  const stateGroup = mapOshalStateToLegacyGroup(ticket.status);
  return {
    id: ticket.ticketId,
    sequence_id: index + 1,
    name: ticket.title,
    description: ticket.description,
    priority: ticket.priority,
    state_detail: {
      name: humanizeTicketState(ticket.status),
      group: stateGroup,
    },
    assignee_detail: {
      display_name:
        readOptionalString(ticket.assignedAgentId) || 'unassigned',
    },
    updated_at: ticket.updatedAt,
    created_at: ticket.createdAt,
  };
}

function mapTaskToLegacyTicket(
  task: StoredTask,
  index: number,
): Record<string, unknown> {
  const stateGroup = mapTaskStateToLegacyGroup(task.status);
  return {
    id: task.taskId,
    sequence_id: index + 1,
    name: task.title || task.taskId,
    priority: 'medium',
    state_detail: {
      name: humanizeTaskState(task.status),
      group: stateGroup,
    },
    assignee_detail: {
      display_name:
        readOptionalString(task.agentId) || 'unassigned',
    },
    updated_at: task.updatedAt,
    created_at: task.createdAt,
  };
}
