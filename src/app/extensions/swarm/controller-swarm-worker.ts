/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from extensions/swarm/index.ts, which had crossed 800 code lines: the controller's own swarm worker wiring (the execution handler deps, the cost-linking ticket service, the worker channels, the ticket-terminal check, the bid responder and the SwarmAgentWorker). Pure move with no behaviour change; the handler deps are returned so later composition can reuse them.
 */

import type { Pool } from 'pg';
import type { createChildLogger } from '@/shared/logger';
import type { AgentProfileRepository } from '@/entities/agent';
import { AgentToolRepository } from '@/entities/tool';
import type { WorkItemRepository } from '@/entities/work-item';
import type { LLMService } from '@/features/llm-provider';
import {
  MESH_CHANNELS,
  PersonaLayerStore,
  createMeshBidResponder,
  type MeshTransport,
  type SwarmMemoryService,
} from '@/features/agent-management';
import {
  RALFHandoverManager,
  SwarmAgentWorker,
  createLLMExecutionHandler,
  type LLMExecutionHandlerDeps,
  type SwarmAgentWorkerOptions,
} from '@/features/swarm-orchestration';
import { PostgresTicketStore, TicketService } from '@/features/ticketing';
import type { AgentMetricsService, CostTrackingService } from '@/features/operational-intelligence';
import { createPromptAuthorizationResolver } from '@/app/prompt-authorization-resolver';
import { resolveHarnessForAgent } from '@/app/composition/provider-runtime';
import { buildRuntimeAliasChannels } from './swarm-runtime-registry';
import type { SwarmRuntimeIdentity } from './swarm-bot-registry';

type CompositionLogger = ReturnType<typeof createChildLogger>;

/** @description What the controller's swarm worker is built from; every value comes from the extension's composition. */
export interface ControllerSwarmWorkerDeps {
  pool: Pool | null;
  getProvider?: () => LLMService;
  agentProfileRepository?: AgentProfileRepository;
  swarmMemoryService: SwarmMemoryService;
  costTrackingService: CostTrackingService;
  agentMetricsService: AgentMetricsService;
  meshTransport: MeshTransport;
  workItemRepository?: WorkItemRepository;
  runtimeIdentity: SwarmRuntimeIdentity;
  /** The extension's logger, so these lines keep the module name they always had. */
  logger: CompositionLogger;
}

/** @description The controller's swarm worker plus the pieces later composition still uses. */
export interface ControllerSwarmWorker {
  agentWorker: SwarmAgentWorker;
  personaLayerStore?: PersonaLayerStore;
  /** The deps the worker's execution handler was built from; undefined when no handler exists. */
  handlerDeps?: LLMExecutionHandlerDeps;
}

/**
 * @description Builds the execution-handler deps for the controller worker. The controller's handler
 * only handles envelopes for the PM bot (local execution via agent.processMessage); every other bot
 * consumes its own envelopes through the SwarmAgentWorker on its bot-node container.
 * @param deps - The extension's composition values.
 * @param personaLayerStore - The persona layer store, when Postgres is available.
 * @param costLinkingTicketService - The ADR-027 cost-linking ticket service, when Postgres is available.
 * @returns The handler deps, or undefined without an agent profile repository or provider resolver.
 */
function buildControllerHandlerDeps(
  deps: ControllerSwarmWorkerDeps,
  personaLayerStore: PersonaLayerStore | undefined,
  costLinkingTicketService: TicketService | undefined,
): LLMExecutionHandlerDeps | undefined {
  const { pool, getProvider, agentProfileRepository, logger } = deps;
  if (!agentProfileRepository || !getProvider) return undefined;
  const promptAgentToolRepository = pool ? new AgentToolRepository(pool) : undefined;
  return {
    resolveProvider: getProvider,
    agentProfileRepository,
    personaLayerStore,
    swarmMemoryService: deps.swarmMemoryService,
    handoverManager: new RALFHandoverManager(),
    recordCost: (event) => deps.costTrackingService.recordCost(event),
    recordMetrics: (event) => deps.agentMetricsService.recordExecution(event),
    ticketService: costLinkingTicketService,
    resolvePromptAuthorization: createPromptAuthorizationResolver(promptAgentToolRepository),
    resolveAgentHarness: (agentId: string) => resolveHarnessForAgent(agentId, logger),
  };
}

/**
 * @description The worker's stale-envelope check: a ticket that already reached a terminal state is
 * not worked again.
 * @param pool - The Postgres pool, when available.
 * @returns The check, or undefined without Postgres.
 */
function buildTicketTerminalCheck(pool: Pool | null): ((ticketId: string) => Promise<boolean>) | undefined {
  if (!pool) return undefined;
  return async (ticketId: string): Promise<boolean> => {
    const result = await pool.query(
      'SELECT status FROM tickets WHERE ticket_id = $1 LIMIT 1',
      [ticketId],
    );
    const status = result.rows[0]?.status as string | undefined;
    return status === 'complete' || status === 'escalated' || status === 'dead_letter';
  };
}

/**
 * @description The worker's ticket write-back callbacks over the cost-linking ticket service.
 * @param service - The cost-linking ticket service, when Postgres is available.
 * @returns Status, activity and assignment callbacks, each undefined without the service.
 */
function buildWorkerTicketCallbacks(
  service: TicketService | undefined,
): Pick<SwarmAgentWorkerOptions, 'updateTicketStatus' | 'recordTicketActivity' | 'recordTicketAssignment'> {
  return {
    updateTicketStatus: service
      ? (ticketId, status, metadata) => service.updateStatus(ticketId, status, metadata)
      : undefined,
    recordTicketActivity: service
      ? (ticketId, metadata) => service.recordActivity(ticketId, metadata)
      : undefined,
    recordTicketAssignment: service
      ? async (ticketId, agentId, metadata) => {
          const phase = metadata.phase != null ? `phase-${metadata.phase}` : undefined;
          await Promise.all([
            service.updateTicket(ticketId, { assignedAgentId: agentId }),
            service.assignAgent(ticketId, agentId, 'worker', phase),
          ]);
        }
      : undefined,
  };
}

/**
 * @description Creates the controller's SwarmAgentWorker. The controller subscribes only to its own
 * channels (its direct channel, broadcast, capabilities and its runtime aliases); each bot node
 * subscribes to its own channel through its own worker.
 * @param deps - The extension's composition values.
 * @returns The worker, the persona layer store and the handler deps it was built from.
 */
export function createControllerSwarmWorker(deps: ControllerSwarmWorkerDeps): ControllerSwarmWorker {
  const { pool, runtimeIdentity, meshTransport, logger } = deps;
  const personaLayerStore = pool ? new PersonaLayerStore(pool) : undefined;
  // Cost-linking ticket service — available to ALL bots (not just PM) so every
  // bot can create ticket_task_links entries for its cost data (ADR-027).
  const costLinkingTicketService = pool ? new TicketService(new PostgresTicketStore(pool)) : undefined;
  const handlerDeps = buildControllerHandlerDeps(deps, personaLayerStore, costLinkingTicketService);
  const workerChannels = [
    MESH_CHANNELS.broadcast,
    MESH_CHANNELS.capabilities,
    ...buildRuntimeAliasChannels(runtimeIdentity),
  ];
  const workerPrimaryChannel = MESH_CHANNELS.agentDirect(runtimeIdentity.agentId);
  // SP-3 / ADR-083: bid responder — this participant answers BID_REQUEST envelopes with a
  // self-scored confidence (its OWN routing keywords + required-capability overlap; a
  // name-token match is only a 0.05 tie-breaker). Shared with bot-node-server so every
  // swarm participant scores call-outs identically (mesh-bid-responder.ts).
  const bidResponseHandler = createMeshBidResponder({
    meshTransport,
    agentId: runtimeIdentity.agentId,
    agentName: runtimeIdentity.agentName,
    capabilities: runtimeIdentity.capabilities,
    personaPath: process.env.BOT_PERSONA_FILE,
  });
  const agentWorker = new SwarmAgentWorker({
    transport: meshTransport,
    workItemRepository: deps.workItemRepository,
    handler: handlerDeps ? createLLMExecutionHandler(handlerDeps) : undefined,
    channel: workerPrimaryChannel,
    consumerId: runtimeIdentity.agentId,
    additionalChannels: workerChannels,
    directHandler: bidResponseHandler,
    isTicketTerminal: buildTicketTerminalCheck(pool),
    ...buildWorkerTicketCallbacks(costLinkingTicketService),
  });
  logger.info({
    runtimeAgentId: runtimeIdentity.agentId,
    runtimeAgentName: runtimeIdentity.agentName,
    primaryChannel: workerPrimaryChannel,
    additionalChannels: workerChannels,
  }, 'Configured swarm worker channels for runtime identity');
  return { agentWorker, personaLayerStore, handlerDeps };
}
