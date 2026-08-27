/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Share the canonical task/message stores with swarm extension bindings for durable remote-worker completions.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Passed agent-profile service into the provider resolver so bot-scoped runtime selection can inherit saved provider/model values
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — DI composition root wiring all Layer 1 components
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added Layer 1 Tools Framework components (repositories, services, controllers)
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added tool verification components
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added config-aware runtime provider selection and dynamic provider refresh to prevent env-only stub fallback
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Fixed provider precedence when mode is missing: prefer plan mode provider over act mode fallback to prevent unintended stub selection
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Enabled Cline level-0 persona prompt composition and runtime tool-definition loading from tool registry
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Added resilient non-swarm Cline tool fallback and resolver source logging when DB-backed tool registry is unavailable
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Added startup/provider-change Cline runtime config sync so persisted OpenAI Codex selection is applied after container restart
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Expanded non-swarm fallback tool catalog with MCP/browser/follow-up capabilities for broader Cline-aligned tool awareness
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Replaced stub tool execution with ToolExecutorService and added startup SQL migration/bootstrap for the tool registry path
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Split callable tools from Layer-1 capability context and seeded a default chat agent for the standalone tools configuration UI
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Updated rag-ingestion tool definition to include optional collection and built-in Chroma fallback semantics
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Decomposed provider, tool-prompt, and runtime factory helpers into src/app/composition/* to keep the composition root within governance limits
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Wired live agent startup manifest assembly into the runtime provider resolver
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | Added dedicated agent-profile persistence wiring and DB-backed profile loading for prompt/runtime assembly
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | Wired intake service/controller with Plane adapter into application context
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | Delegated swarm intake bindings to extension module for cleaner base-agent composition
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | WS5: Wired TicketInteractionService into AppContext for canonical ticket interaction processing
 * 21 | maintainer@emeraldcoastsystemsgroup.com   | Track B S6: Pass DynamicToolExecutorRegistry through to AppContext
 * 22 | maintainer@emeraldcoastsystemsgroup.com   | Switched internal ticket/workspace persistence to resilient localhost fallbacks so MOCK_OIDC development remains usable without Postgres
 * 23 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 swarm operational graph: start the ticket→graph ingestion subscription (shared ticketEvents bus → tenant graph). Engine-gated — a clean no-op per event when ARANGO_URL is unset; fire-and-forget, never back-pressures the ticket lifecycle.
 * 24 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: wire durable ticket ownership into swarm lifecycle memory persistence.
 * 25 | maintainer@emeraldcoastsystemsgroup.com   | Bind executeBotOrInline into AppContext so installed app routes can dispatch package-owned bots through the canonical node/credential/governance path.
 * 26 | maintainer@emeraldcoastsystemsgroup.com   | Bind the fixed actor-mailbox Outlook reader into AppContext for token-safe package integrations.
 * 27 | maintainer@emeraldcoastsystemsgroup.com   | Bind the fixed owner-scoped RingCentral call-log reader into AppContext (screen-pop v2 call history), mirroring the Outlook seam.
 */

import {
  PlaneSyncService,
  ResilientTicketStore,
  ResilientWorkspaceStore,
  TicketProjectAssignmentService,
  TicketService,
  WorkspaceService,
} from '@/features/ticketing';
import { createChildLogger } from '@/shared/logger';
import { InMemoryTaskStore } from '@/entities/task';
import { InMemoryMessageStore } from '@/entities/message';
import { StreamManager } from '@/features/streaming';
import { MemoryLayerService } from '@/features/memory';
import { WorkspaceBootstrapService } from '@/features/workspace-bootstrap';
import {
  type AppContext as CompositionAppContext,
  createAgentProfileComponents,
  createAgentSelectorCapabilityResolver,
  createAgentStartupManifestService,
  createDatabasePool,
  createOrchestrator,
  createProviderResolver,
  createSystemPromptResolver,
  createToolFramework,
  createToolResolver,
  createVerificationComponents,
  initializeToolRegistry,
} from '@/app/composition';
import {
  DEFAULT_CHAT_AGENT_ID,
  DEFAULT_CHAT_AGENT_NAME,
  TicketInteractionService,
} from '@/features/chat-orchestration';
import { createSwarmExtensionBindings } from '@/app/extensions';
import { AgentConfigService, BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import { startTicketGraphIngestion } from '@/features/graph';
import { executeBotOrInline } from '@/app/routes/inline-bot-execution';
import { createOutlookMailReader, createOutlookMailSyncReader } from '@/app/routes/outlook-mail-reader';
import { createRingcentralCallLogReader } from '@/app/routes/ringcentral-call-log';

const logger = createChildLogger({ module: 'composition-root' });

/**
 * @description Creates and wires all application dependencies.
 * This remains the single entrypoint for runtime DI, while detailed factory logic
 * lives in `src/app/composition/*` to keep the assembly layer readable.
 *
 * @returns Fully wired AppContext ready for HTTP route registration.
 */
export type { CompositionAppContext as AppContext };

/**
 * @description Composition root that instantiates and wires every Layer 1 runtime
 * dependency (stores, stream manager, tool framework, provider/prompt/tool resolvers,
 * agent-profile and manifest services, orchestrator, ticketing/workspace services,
 * verification, and swarm extension bindings) into a single AppContext, and triggers
 * tool-registry initialization. Acts as the sole entrypoint for runtime dependency
 * injection so callers receive a fully assembled context for HTTP route registration.
 * @returns Fully wired AppContext containing all shared runtime services and controllers.
 */
export function createAppContext(): CompositionAppContext {
  logger.info('Creating application context');

  const pool = createDatabasePool();
  const taskStore = new InMemoryTaskStore();
  const messageStore = new InMemoryMessageStore();
  const streamManager = new StreamManager();
  const toolFramework = createToolFramework(pool);
  const agentProfileComponents = createAgentProfileComponents(
    pool,
    (agentId) => toolFramework.selectorCompositionService.composeSelector(agentId),
  );
  const manifestService = createAgentStartupManifestService(
    agentProfileComponents.agentProfileService,
    toolFramework.switchFrameworkService,
    toolFramework.selectorCompositionService,
    {
      agentId: DEFAULT_CHAT_AGENT_ID,
      agentName: DEFAULT_CHAT_AGENT_NAME,
    },
  );
  const resolveAgentCapabilities = createAgentSelectorCapabilityResolver({
    getComposedSelector: (agentId) => toolFramework.selectorCompositionService.getComposedSelector(agentId),
    getAgentProfile: (agentId) => agentProfileComponents.agentProfileService.getAgentProfile(agentId),
  });
  const providerResolver = createProviderResolver(
    logger,
    manifestService,
    agentProfileComponents.agentProfileService,
    pool,
    resolveAgentCapabilities,
  );
  const memoryService = new MemoryLayerService(taskStore, messageStore);
  const workspaceBootstrapService = new WorkspaceBootstrapService();
  const getTools = createToolResolver(
    toolFramework.toolRegistryService,
    logger,
    toolFramework.dynamicToolExecutorRegistry,
    resolveAgentCapabilities,
  );
  const getSystemPrompt = createSystemPromptResolver(
    toolFramework.switchFrameworkService,
    agentProfileComponents.agentProfileService,
    logger,
    {
      agentId: DEFAULT_CHAT_AGENT_ID,
      agentName: DEFAULT_CHAT_AGENT_NAME,
    },
  );
  /* ── Internal ticketing ─────────────────────────────────────────── */
  const { PostgresTicketStore } = require('@/features/ticketing/services/ticket-store-postgres');
  const ticketStore = pool ? new PostgresTicketStore(pool) : new ResilientTicketStore(pool);
  const workspaceStore = new ResilientWorkspaceStore(pool);
  // Order matters: WorkspaceService is constructed first (depends only on
  // stores), then injected into TicketService so deleteTicket can cascade
  // to the workspace (DB row + disk directory).
  const workspaceService = new WorkspaceService(workspaceStore, ticketStore);
  const ticketService = new TicketService(ticketStore, workspaceService);
  // ADR-045 adoption: the swarm operational graph observes ticket lifecycle events off the
  // shared ticketEvents bus (created / status-changed / agent-assigned → tenant-graph upserts).
  // Engine-gated: a clean per-event no-op when ARANGO_URL is unset; fire-and-forget always.
  startTicketGraphIngestion();
  const ticketProjectAssignmentService = new TicketProjectAssignmentService(ticketService, taskStore);
  const planeSyncService = new PlaneSyncService(ticketService);
  const agentConfigService = new AgentConfigService(pool);
  const ticketInteractionService = new TicketInteractionService({ ticketService, messageStore });

  const orchestrator = createOrchestrator(
    taskStore,
    messageStore,
    streamManager,
    providerResolver.getProvider,
    getTools,
    getSystemPrompt,
    memoryService,
    ticketService,
    workspaceService,
    agentConfigService,
    toolFramework.switchFrameworkService,
    toolFramework.dynamicToolExecutorRegistry,
    toolFramework.connectorSpecToolService,
  );
  const verification = createVerificationComponents(pool, logger);
  const swarm = createSwarmExtensionBindings(pool, providerResolver.getProvider, { taskStore, messageStore });
  swarm.swarmTicketProcessingService?.setTicketService(ticketService);
  const botNodeClient = new BotNodeClient(createRegistryEndpointResolver());

  initializeToolRegistry(
    pool,
    toolFramework.toolRegistryService,
    logger,
    {
      agentId: DEFAULT_CHAT_AGENT_ID,
      agentName: DEFAULT_CHAT_AGENT_NAME,
    },
    toolFramework.runtimeToolRegistrationService,
    toolFramework.connectorSpecToolService,
    toolFramework.dynamicToolExecutorRegistry,
  );

  logger.info('Application context created successfully');

  let context: CompositionAppContext;
  context = {
    taskStore,
    messageStore,
    streamManager,
    orchestrator,
    provider: providerResolver.provider,
    getProvider: providerResolver.getProvider,
    pool,
    toolController: toolFramework.toolController,
    agentProfileController: agentProfileComponents.agentProfileController,
    agentToolController: toolFramework.agentToolController,
    swarm,
    toolRegistryService: toolFramework.toolRegistryService,
    dynamicToolExecutorRegistry: toolFramework.dynamicToolExecutorRegistry,
    runtimeToolRegistrationService: toolFramework.runtimeToolRegistrationService,
    connectorMarketplaceService: toolFramework.connectorMarketplaceService,
    connectorSpecToolService: toolFramework.connectorSpecToolService,
    switchFrameworkService: toolFramework.switchFrameworkService,
    selectorCompositionService: toolFramework.selectorCompositionService,
    verificationController: verification.verificationController,
    verificationScheduler: verification.verificationScheduler,
    memoryService,
    workspaceBootstrapService,
    ticketService,
    ticketProjectAssignmentService,
    workspaceService,
    planeSyncService,
    ticketInteractionService,
    executeBot: (agentId, request) => executeBotOrInline(context, botNodeClient, agentId, request),
    outlookMail: createOutlookMailReader(pool),
    outlookMailSync: createOutlookMailSyncReader(pool),
    ringcentralCallLog: createRingcentralCallLogReader(pool),
  };
  return context;
}
