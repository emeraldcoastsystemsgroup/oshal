/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Accept the composition root's canonical conversation stores and inject them into remote manifest-worker result persistence.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added swarm extension registration for intake wiring and routes
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added swarm orchestration controller binding and /api/swarm route registration
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Wired Postgres-backed swarm run persistence into extension bindings with fallback compatibility
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added Plane ticket write-back adapter wiring for swarm lifecycle provider feedback
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Preserved default policy and verification service wiring after swarm processing constructor expansion
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Injected IntakeService into SwarmOrchestrationController for smoke test endpoint
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Wired Postgres-backed escalation store and injected into controller for escalation query API
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Wired WorkItemRepository for persistent swarm work unit tracking
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Wired RedisMeshTransport and SwarmAgentWorker for durable envelope delivery and execution
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Wired AgentProfileRepository and LLM execution handler into agent worker
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Wired PersonaLayerStore for multi-layer prompt composition in LLM execution
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Receive getProvider from composition root — reuse the same provider resolver the chat orchestrator uses
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Phase 4: Wire SwarmVerificationService with meshTransport and workItemRepository for real QA via task-manager
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Pass workItemRepository to controller for operator visibility work item queries
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Wire MeshCommunicationService and multi-channel subscriptions (agent direct + broadcast)
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | Wire AgentFactoryService for bot generation and expose in bindings
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | Per-container support: deterministic consumerId from BOT_NAME, direct channel subscription, capability announcement on startup
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | Exposed swarmTicketProcessingService in bindings for TicketService setter wiring
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | Added canonical runtime identity, Redis-backed worker heartbeat registry, and direct-channel worker subscriptions for targeted swarm assignment
 * 21 | maintainer@emeraldcoastsystemsgroup.com   | Wired QueueManagerService into PM bot startup — background polling loop that picks up approved tickets and feeds them into the swarm pipeline
 * 22 | maintainer@emeraldcoastsystemsgroup.com   | Session 91: Fixed readiness probe to handle undefined provider return from getProvider(), added diagnostic logging for provider resolution path
 * 23 | maintainer@emeraldcoastsystemsgroup.com   | Wired Stage 2-6 governance services into composition root: QueueGovernanceService, PhaseRegressionService, WorkspaceArtifactEnforcer, FailureGovernanceService, SwarmMetricsCollector into live runtime
 * 24 | maintainer@emeraldcoastsystemsgroup.com   | Wired PhaseRoutingService and MeshBidBroadcaster into composition root for legacy-parity phase-aware routing
 * 25 | maintainer@emeraldcoastsystemsgroup.com   | Session 109: Wired isTicketTerminal DB check into SwarmAgentWorker, wired workItemRepository into QueueManagerPipelineDeps for completion cascade
 * 26 | maintainer@emeraldcoastsystemsgroup.com   | Session 140: Wired validatePersonaIdentities() into boot sequence (A2)
 * 27 | maintainer@emeraldcoastsystemsgroup.com   | Governance closeout: backfilled changelog trace for session-level queue-manager pipeline wiring and persona identity boot validation updates
 * 28 | maintainer@emeraldcoastsystemsgroup.com   | BF-030: Passed resolveOnlineAgentIds into MultiRoundDispatchService.selectAgent — missing online filter allowed offline agents (business-plan-bot) to be selected for round 2
 * 29 | maintainer@emeraldcoastsystemsgroup.com   | ADR-027: Added costLinkingTicketService for per-bot swarm cost rollup task linking
 * 30 | maintainer@emeraldcoastsystemsgroup.com   | TD-20: Online resolver now cross-references DB agent status — disabled (inactive) bots excluded from routing candidates even when their container heartbeat is alive
 * 31 | maintainer@emeraldcoastsystemsgroup.com   | BF-030: Heartbeat guard now checks SWARM_MODE=container instead of just unknown-agent string — prevents host API server from publishing worker heartbeats
 * 32 | maintainer@emeraldcoastsystemsgroup.com   | Session 19: Exposed swarmMetricsCollector in SwarmExtensionBindings for cockpit metrics dashboard endpoint
 * 33 | maintainer@emeraldcoastsystemsgroup.com   | Session 20: Wired QueueGovernanceService into QueueManagerService, MeshCommunicationService into MeshBidBroadcaster, and queue-manager direct channel subscription for bid reply collection
 * 34 | maintainer@emeraldcoastsystemsgroup.com   | Wired resolveAgentIdByName into QueueManagerPipelineDeps for PM role→UUID resolution via live agent registry.
 * 35 | maintainer@emeraldcoastsystemsgroup.com   | Wired LLM routing into AgentRouter via codex exec — ~2-5s lightweight LLM call reads bot names and selector_descriptors to pick the best agent. No Cline CLI workspace overhead.
 * 36 | maintainer@emeraldcoastsystemsgroup.com   | Register queue-manager shutdown hook (clears the poll interval) for SIGTERM/SIGINT (2026-07-05 leak audit)
 * 37 | maintainer@emeraldcoastsystemsgroup.com   | ADR-083: wired the knowledge-owner call-out (buildTaskCallOutResolver → QueueManagerPipelineDeps.resolveTaskWorker); de-weighted the semantic name-token bid boost 0.2 → 0.05 (it relocated the very misrouting the ADR kills — a ticket containing a bot's name token could out-bid the real owner); node self-seed now reads selector_descriptor/routing_keywords from the persona YAML instead of dumping perspective/capabilities (the audit's declaration-defect root cause on fresh deployments).
 * 38 | maintainer@emeraldcoastsystemsgroup.com   | Wired WorkflowRunHistoryStore into QueueManagerPipelineDeps (project-manager only) so 'graph' dispatches record run history (workflow_runs / workflow_run_steps) for the studio Runs panel
 * 39 | maintainer@emeraldcoastsystemsgroup.com   | ADR-081: codexResolveEndpoint honors the new registry flag requiresOwnNode — a bot whose workspace lives only on its node (oshal-developer's /app/dev-repo clone) dispatches to that node via BotNodeClient instead of the prefer-inline codex rule (which predates the bot-node JS CodexProvider). Without this, oshal-dev tickets executed inline on the api where the clone doesn't exist.
 * 40 | maintainer@emeraldcoastsystemsgroup.com   | ADR-087: injected isBotAccessibleTo (registry accessRoles) into buildTaskCallOutResolver so jarvis-sourced task tickets are role-gated at the call-out (the feature slice can't import the app-layer registry itself).
 * 41 | maintainer@emeraldcoastsystemsgroup.com   | Queue-manager start now awaits waitForBootstrapComplete() (bounded) — its crash-recovery sweep queried the tickets table before migrations created it on a clean DB, logging self-healing ERROR lines at first boot (BACKLOG "Noisy first-boot logs"). Shutdown hook still registers immediately; stop() on a not-yet-started manager is a safe no-op.
 * 42 | maintainer@emeraldcoastsystemsgroup.com   | Wired cost-governance BudgetService into QueueManagerService (setBudgetService, project-manager only) — spend budgets + the runaway kill switch now gate queued dispatch. Fail-open service: a null pool / missing oshal_budgets table never bricks dispatch.
 * 43 | maintainer@emeraldcoastsystemsgroup.com   | Wired the queue DLQ DeadLetterService into QueueManagerService (setDeadLetterService, project-manager only) — persisted poison-ticket policy (oshal_queue_dlq, migration 081): failed dispatch + system-escalation cycles quarantine at QM_MAX_ATTEMPTS to terminal 'dead_letter' with operator alerts on topic 'queue-dlq'. Fail-open like BudgetService.
 * 44 | maintainer@emeraldcoastsystemsgroup.com   | fix(a2a): review finding (CRITICAL) — comment-only accuracy update; the SAME injected isBotAccessibleTo now also gates inbound A2A tickets (task-call-out.ts's ROLE_GATED_TICKET_SOURCES), closing the gap where a2a-gateway-sourced tickets skipped ADR-087 role scoping entirely.
 * 45 | maintainer@emeraldcoastsystemsgroup.com   | Wired launch deps (DynamicComposeService + BotContainerSpawnerService with the dynamic overlay — the agent-status-routes pairing) into AgentFactoryService so POST /api/swarm/agents/create-and-start can create+launch atomically with rollback on launch failure.
 * 46 | maintainer@emeraldcoastsystemsgroup.com   | ADR-034 boot bootstrap-pull: /api/agents (per-agent runtime config) mount requiresAuth → serviceSecretOr(requiresAuth) — the /api/graph//api/jarvis trusted-service pattern — so a bot-node can pull its own authoritative provider/model record on boot with X-Service-Secret. Secret holders (the controller + bots) already fully trust each other on this edge: the same secret authorizes swarm-execute dispatch and the bot-side PUT /api/llm-provider push-down, so exposing the read/push surface to it widens nothing.
 * 47 | maintainer@emeraldcoastsystemsgroup.com   | Persisted external provider reconciliation cursors in Postgres when the controller database is available
 * 48 | maintainer@emeraldcoastsystemsgroup.com   | Wired crash-safe intake reconciliation to idempotent internal ticket materialization
 * 49 | maintainer@emeraldcoastsystemsgroup.com   | Wrapped the boot registry→profile sync Promise.all (syncProviderModel per bot) in runWithSystemIdentity — the detached boot sync ran identity-less; under OSHAL_DB_GUC_STRICT=deny that scoped the agents-table writes to nothing (guc warn-audit: named syncProviderModel + an all-internal non-stitched sibling of the same Promise.all).
 * 50 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 * 51 | maintainer@emeraldcoastsystemsgroup.com   | ADR-119 P4 (A2): wired the SelfHealAutoApplyEngine into QueueManagerService (setAutoApplyGate, project-manager only, next to setBudgetService — the sanctioned hook shape) over the app-layer self-heal remediation executor (the deterministic HTTP seam to the self-healing bot node's docker socket). Kill switch SELF_HEAL_AUTO_APPLY stays the runtime gate (default OFF), so wiring this changes nothing until a deployment opts in.
 * 52 | maintainer@emeraldcoastsystemsgroup.com   | Preserve the durable Apply ticket owner exactly
 *   when requesting internal dispatch. The endpoint reloads ticket-bound submit authorization,
 *   posting, owner, and target server-side instead of trusting asserted request fields.
 * 53 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: wire durable swarm-memory provenance and persisted prompt tool authorization into controller-local execution.
 * 54 | maintainer@emeraldcoastsystemsgroup.com   | Document default-on authoritative provider/model stamping and its fail-closed missing-database behavior at the composition seam.
 * 55 | maintainer@emeraldcoastsystemsgroup.com   | Codex fleet default: the boot-sync codexModel fallback gpt-5.3-codex -> gpt-5.5. 5.3-codex is the API-key model name and 400s on the ChatGPT-account login this deployment mounts, so the old fallback seeded the DB with a model no bot could actually run when CODEX_MODEL was unset.
 */

import type { Pool } from 'pg';
import type { Application, RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
import { serviceSecretHeaders, serviceSecretOr } from '@/shared/middleware/authz';
import { AgentProfileRepository } from '@/entities/agent';
import { AgentToolRepository, ToolRepository } from '@/entities/tool';
import { WorkItemRepository } from '@/entities/work-item';
import {
  IntakeController,
  IntakeService,
  InMemoryIntakeCursorStore,
  PostgresIntakeCursorStore,
  PlaneWorkItemFeedAdapter,
  GitHubWorkItemFeedAdapter,
} from '@/features/intake';
import {
  RedisMeshTransport,
  AgentRuntimeRegistryService,
  MeshCommunicationService,
  AgentRouter,
  SelectionBidService,
  type MeshTransport,
  type MeshEnvelope,
  AgentFactoryService,
  BotContainerSpawnerService,
  DynamicComposeService,
  KubernetesBotRuntimeLauncher,
  isRunningInKubernetes,
  CapabilityExpansionService,
  AgentConfigService,
  createAgentConfigRuntimeParamsResolver,
  AgentMemoryService,
  SwarmMemoryService,
  PersonaLayerStore,
  MESH_CHANNELS,
  MeshBidBroadcaster,
  createMeshBidResponder,
  BotNodeClient,
  createRegistryEndpointResolver,
  isControllerInlineContainer,
} from '@/features/agent-management';
import { RagService } from '@/features/rag';
import { WorkflowRunHistoryStore } from '@/features/workflow-studio';
import type { LLMService } from '@/features/llm-provider';
import type { IMessageStore } from '@/entities/message';
import type { ITaskStore } from '@/entities/task';
import { SwitchFrameworkService } from '@/features/tool-switch';
import { SelectorCompositionService } from '@/features/selector-composition';
import { BudgetService } from '@/features/cost-governance';
import { SelfHealAutoApplyEngine } from '@/features/alert-triage';
import { createSelfHealRemediationExecutor } from '@/app/self-heal-remediation-executor';
import { createPromptAuthorizationResolver } from '@/app/prompt-authorization-resolver';
import {
  PlaneTicketWritebackAdapter,
  GitHubTicketWritebackAdapter,
  PostgresSwarmEscalationStore,
  PostgresSwarmRunStore,
  SwarmAgentWorker,
  SwarmOrchestrationController,
  SwarmTicketProcessingService,
  SwarmVerificationService,
  type SwarmRuntimeReadiness,
  createLLMExecutionHandler,
  RALFHandoverManager,
  ConsensusReviewService,
  InMemoryMeshTransport,
   QueueManagerService,
   DeadLetterService,
   TicketDecompositionService,
   SubtaskLifecycleService,
   MultiRoundDispatchService,
   normalizeCandidates,
   ensureInternalTicketForWorkItem,
  TaskFolderService,
  QueueGovernanceService,
  InMemoryGovernanceStore,
  PostgresGovernanceStore,
  PhaseRegressionService,
  FailureGovernanceService,
  SwarmMetricsCollector,
  PhaseRoutingService,
  buildTaskCallOutResolver,
  PostgresSubtaskLifecycleStore,
} from '@/features/swarm-orchestration';
import { ConfigSyncService } from '@/features/config-sync';
import { TicketService, PostgresTicketStore, WorkspaceService, PostgresWorkspaceStore } from '@/features/ticketing';
import { seedInlineControllerBotProfiles } from './inline-controller-bot-seeder';
import { seedAgentProfile } from './agent-profile-boot-seeder';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { dispatchExplicitRemoteTicket, EXPLICIT_REMOTE_TASK_ID_KEY } from '@/app/explicit-remote-ticket-dispatch';
import {
  CostTrackingService,
  AgentMetricsService,
  RoutingAuditLog,
  CompetencyRanker,
  StuckAgentWatchdog,
  FeedbackLoopService,
  PrivateMeshManager,
} from '@/features/operational-intelligence';
import {
  createIntakeRoutes,
  createSwarmOrchestrationRoutes,
  createAgentFactoryRoutes,
} from './routes';
import { createCapabilityExpansionRoutes } from './routes/capability-expansion-routes';
import { createMemoryRoutes } from './routes/memory-routes';
import { createOpsIntelligenceRoutes } from './routes/ops-intelligence-routes';
import { createBotRegistryRoutes } from './routes/bot-registry-routes';
import { createConfigPropagationRoutes } from './routes/config-propagation-routes';
import { createConfigRuntimeRoutes } from './routes/config-runtime-routes';
import { SwarmBotRegistry, validatePersonaIdentities, getActiveRegistry, isBotAccessibleTo, type SwarmRuntimeIdentity } from './swarm-bot-registry';
import { resolveHarnessForAgent } from '@/app/composition/provider-runtime';
import { waitForBootstrapComplete } from '@/app/composition/app-runtime-factory';
import { registerShutdownHook } from '@/shared/services/shutdown-hooks';
import { resolveServerOperationCreds } from '@/app/routes/connector-token-broker';
import { buildQueueDlqOperatorNotifier } from '@/app/routes/queue-dlq-routes';
import {
  canUseRuntimeRegistry,
  buildStatusAwareOnlineResolver,
  buildRuntimeAliasChannels,
  startRuntimeAgentHeartbeat,
} from './swarm-runtime-registry';

const logger = createChildLogger({ module: 'swarm-extension' });
const SWARM_READINESS_CACHE_MS = 5000;

function resolveMeshTransport(): MeshTransport {
  const configuredMode = (process.env.SWARM_MESH_TRANSPORT ?? '').trim().toLowerCase();
  const useRedis = configuredMode === 'redis'
    || (configuredMode.length === 0 && typeof process.env.REDIS_URL === 'string' && process.env.REDIS_URL.trim().length > 0);

  if (useRedis) {
    logger.info({ mode: 'redis', redisUrlConfigured: Boolean(process.env.REDIS_URL) }, 'Using Redis mesh transport');
    return new RedisMeshTransport();
  }

  logger.warn(
    { mode: configuredMode || 'memory', redisUrlConfigured: Boolean(process.env.REDIS_URL) },
    'Using in-memory mesh transport; set SWARM_MESH_TRANSPORT=redis (and REDIS_URL) for durable swarm delivery',
  );
  return new InMemoryMeshTransport();
}

function createSwarmRuntimeReadinessProbe(
  pool: Pool | null,
  getProvider?: () => LLMService,
): () => Promise<SwarmRuntimeReadiness> {
  let lastReadiness: SwarmRuntimeReadiness | null = null;
  let lastCheckedAt = 0;

  return async () => {
    const now = Date.now();
    if (lastReadiness && now - lastCheckedAt < SWARM_READINESS_CACHE_MS) {
      return lastReadiness;
    }

    const readiness = await evaluateSwarmRuntimeReadiness(pool, getProvider);
    lastReadiness = readiness;
    lastCheckedAt = now;
    return readiness;
  };
}

async function evaluateSwarmRuntimeReadiness(
  pool: Pool | null,
  getProvider?: () => LLMService,
): Promise<SwarmRuntimeReadiness> {
  if (!pool) {
    return {
      ready: false,
      dependency: 'postgres',
      message: 'Swarm processing requires Postgres-backed persistence in the current runtime',
    };
  }

  try {
    await pool.query('SELECT 1');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ready: false,
      dependency: 'postgres',
      message: 'Swarm processing cannot start because Postgres is unavailable',
      details: { error: message },
    };
  }

  if (!getProvider) {
    return {
      ready: false,
      dependency: 'provider',
      message: 'Swarm processing cannot start because no provider resolver is configured',
    };
  }

  try {
    const provider = getProvider();
    if (!provider) {
      return {
        ready: false,
        dependency: 'provider',
        message: 'Swarm processing cannot start because getProvider() returned undefined — provider not yet initialized',
        details: { providerType: typeof provider },
      };
    }
    const providerName = typeof provider.getProviderName === 'function'
      ? provider.getProviderName()
      : 'unknown';
    return {
      ready: true,
      dependency: 'none',
      message: 'Swarm runtime ready',
      details: { provider: providerName },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ error: message }, 'Swarm readiness probe — provider resolution failed');
    return {
      ready: false,
      dependency: 'provider',
      message: 'Swarm processing cannot start because the provider resolver failed',
      details: { error: message },
    };
  }
}

/**
 * @description Bound dependencies exposed by the swarm extension to the app context.
 */
export interface SwarmExtensionBindings {
  intakeController: IntakeController;
  swarmOrchestrationController: SwarmOrchestrationController;
  agentWorker: SwarmAgentWorker;
  meshCommunicationService: MeshCommunicationService;
  workItemRepository?: WorkItemRepository;
  pool?: import('pg').Pool;
  runtimeIdentity: SwarmRuntimeIdentity;
  runtimeRegistryService?: AgentRuntimeRegistryService;
  agentFactoryService?: AgentFactoryService;
  capabilityExpansionService?: CapabilityExpansionService;
  agentConfigService?: AgentConfigService;
  configSyncService?: ConfigSyncService;
  agentMemoryService?: AgentMemoryService;
  swarmMemoryService?: SwarmMemoryService;
  costTrackingService?: CostTrackingService;
  agentMetricsService?: AgentMetricsService;
  routingAuditLog?: RoutingAuditLog;
  competencyRanker?: CompetencyRanker;
  stuckAgentWatchdog?: StuckAgentWatchdog;
  feedbackLoopService?: FeedbackLoopService;
  privateMeshManager?: PrivateMeshManager;
  swarmTicketProcessingService?: SwarmTicketProcessingService;
  queueManagerService?: QueueManagerService;
  swarmMetricsCollector?: SwarmMetricsCollector;
}

/**
 * @description Creates swarm extension bindings. The getProvider closure is the same resolver
 * used by the chat orchestrator — it reads the active provider from persisted config and returns
 * the fully wired LLMService (ClineHarnessProvider with manifest, AnthropicProvider, etc.).
 * @param pool - Shared Postgres pool used for durable swarm run persistence when available
 * @param getProvider - Provider resolver from the composition root (same one the orchestrator uses)
 * @param conversationStores - Shared controller task/message stores for durable remote-worker results
 * @returns Swarm extension bindings for app context integration
 */
export function createSwarmExtensionBindings(
  pool: Pool | null = null,
  getProvider?: () => LLMService,
  conversationStores?: { taskStore: ITaskStore; messageStore: IMessageStore },
): SwarmExtensionBindings {
  // A2: Validate persona identities at boot — fail fast on collision
  validatePersonaIdentities();

  const intakeService = new IntakeService(
    [new PlaneWorkItemFeedAdapter(), new GitHubWorkItemFeedAdapter()],
    pool ? new PostgresIntakeCursorStore(pool) : new InMemoryIntakeCursorStore(),
  );

  const meshTransport = resolveMeshTransport();
  const runtimeReadinessProbe = createSwarmRuntimeReadinessProbe(pool, getProvider);
  const meshCommunicationService = new MeshCommunicationService(meshTransport);
  const runtimeIdentity = SwarmBotRegistry.resolveRuntimeIdentity(process.env);
  const runtimeRegistryService = canUseRuntimeRegistry()
    ? new AgentRuntimeRegistryService()
    : undefined;
  const swarmRunStore = new PostgresSwarmRunStore(pool);
  const escalationStore = new PostgresSwarmEscalationStore(pool);
  const ticketWritebackAdapter = new PlaneTicketWritebackAdapter();
  const githubWritebackAdapter = new GitHubTicketWritebackAdapter();
  const workItemRepository = pool ? new WorkItemRepository(pool) : undefined;
  const agentProfileRepository = pool ? new AgentProfileRepository(pool) : undefined;

  // Boot sync: write registry harnessType/apiType → DB api_provider_id/model_id so the UI
  // always reflects the correct harness config rather than the seeded defaults. Gated on
  // migration completion — on a clean-DB first boot the agents table doesn't exist yet and
  // every per-bot sync logged a self-healing ERROR. Fire-and-forget either way.
  if (agentProfileRepository) {
    const claudeCodeModel = process.env.CLAUDE_CODE_MODEL ?? 'claude-sonnet-4-6';
    const codexModel = process.env.CODEX_MODEL ?? 'gpt-5.5';
    const defaultModel = process.env.FORCE_LLM_MODEL ?? process.env.LLM_MODEL ?? 'gpt-4.1';
    void waitForBootstrapComplete().then(() => runWithSystemIdentity(() => Promise.all(
      getActiveRegistry()
        .filter((bot) => bot.agentId && bot.apiType)
        .map((bot) => {
          const modelId =
            bot.harnessType === 'claude-code'
              ? claudeCodeModel
              : bot.harnessType === 'codex-cli'
                ? codexModel
                : defaultModel;
          return agentProfileRepository.syncProviderModel(bot.agentId!, bot.apiType!, modelId);
        }),
    ))).catch((err) => logger.error({ err }, 'Boot sync: registry→profile sync failed'));
  }

  const verificationService = new SwarmVerificationService({
    meshTransport,
    workItemRepository,
  });

  // Memory services — per-agent + shared swarm memory backed by ChromaDB via RagService
  const ragService = new RagService();
  const agentMemoryService = new AgentMemoryService(ragService);
  const swarmMemoryService = new SwarmMemoryService(ragService, pool ?? undefined);

  const consensusReviewService = new ConsensusReviewService({
    meshTransport,
    workItemRepository,
    handoverManager: new RALFHandoverManager(),
  });

  // Operational intelligence — created early so competencyRanker can feed routing
  const costTrackingService = new CostTrackingService(pool);
  const agentMetricsServiceInstance = new AgentMetricsService(pool);
  const routingAuditLog = new RoutingAuditLog(pool);
  const competencyRanker = new CompetencyRanker(agentMetricsServiceInstance);

  // LLM routing: sends bot names + selector descriptions to codex exec and asks
  // it to pick the best one. ~2-5s, no workspace, no session overhead.
  const llmRoutingFunction: import('@/features/agent-management').LLMRoutingFunction =
    async (context, candidates) => {
      try {
        const botList = candidates
          .filter((c) => c.selectorDescriptor || c.name)
          .map((c) => `- ${c.name || c.agentId} (${c.agentId}): ${(c.selectorDescriptor || '').trim().split('\n')[0]}`)
          .join('\n');

        if (!botList) return null;

        const { codexQuickCall } = require('@/shared/services/codex-quick-call') as { codexQuickCall: (prompt: string) => Promise<string | null> };
        const prompt = `Pick the single best bot for this task. Respond with ONLY the agent_id value, nothing else.\n\nTask: ${context.ticketTitle || context.taskId}\n${context.taskText ? `Details: ${context.taskText.slice(0, 500)}` : ''}\n\nAvailable bots:\n${botList}`;

        const chosen = await codexQuickCall(prompt);
        if (!chosen) return null;

        const match = candidates.find((c) => chosen.includes(c.agentId));
        if (match) {
          logger.info({ taskId: context.taskId, chosenAgentId: match.agentId, chosenName: match.name }, 'LLM routing selected agent');
          return match.agentId;
        }
        logger.info({ taskId: context.taskId, llmResponse: chosen.slice(0, 80) }, 'LLM routing response did not match any candidate');
        return null;
      } catch (err) {
        logger.warn({ err: (err as Error).message, taskId: context.taskId }, 'LLM routing failed — falling through');
        return null;
      }
    };

  const agentRouter = new AgentRouter(new SelectionBidService(), llmRoutingFunction);

  const swarmProcessingService = new SwarmTicketProcessingService(
    intakeService,
    swarmRunStore,
    undefined,
    agentRouter,
    undefined,
    undefined,
    verificationService,
    [ticketWritebackAdapter, githubWritebackAdapter],
    undefined,
    escalationStore,
    workItemRepository,
    meshTransport,
    agentProfileRepository,
    undefined,
    swarmMemoryService,
    consensusReviewService,
    competencyRanker,
    undefined,
    runtimeReadinessProbe,
  );
  // ── Multi-round dispatch wiring ──────────────────────────────────
  // Map phase roles to capabilities agents actually register with.
  // Without this, routing searches for e.g. 'executor' but agents have
  // 'code-implementation' — causing fallback to PM/QA → SP-10 rejection.
  const ROLE_CAPABILITY_MAP: Record<string, string[]> = {
    'architect': ['planning', 'architecture'],
    'plan-reviewer': ['planning', 'review'],
    'domain-specialist': ['domain-expertise', 'analysis'],
    'challenge-reviewer': ['review', 'analysis'],
    'executor': ['code-implementation', 'implementation', 'code'],
    'code-improver': ['code-implementation', 'review', 'code'],
    'tester': ['testing', 'validation'],
    'qa-verifier': ['testing', 'validation', 'review'],
    'qa-gatekeeper': ['testing', 'quality-assurance'],
    'domain-specialist-review': ['domain-expertise', 'review'],
  };
  const multiRoundDispatch = new MultiRoundDispatchService({
    meshService: meshCommunicationService,
    workItemRepository,
    handoverManager: new RALFHandoverManager(),
    selectAgent: async (ticketId, phase, role, excludeAgentIds) => {
      const onlineResolver = runtimeRegistryService
        ? buildStatusAwareOnlineResolver(runtimeRegistryService, agentProfileRepository)
        : undefined;
      const candidates = await normalizeCandidates(
        undefined, undefined, role, agentProfileRepository, onlineResolver,
      );
      const filtered = candidates.filter((c) => !excludeAgentIds.includes(c.agentId));
      if (filtered.length === 0) return 'a0000000-0000-0000-0000-000000000006';
      // Map role to capabilities agents actually register with
      const capabilities = ROLE_CAPABILITY_MAP[role] ?? [role];
      const routeDecision = await agentRouter.route(
        { taskId: ticketId, requiredCapabilities: capabilities },
        filtered,
      );
      return routeDecision.winner.agentId;
    },
    recordAgentAssignment: async (ticketId, agentId, role, phase) => {
      // ticketService is created later in composition — use lazy ref via swarmProcessingService
      const svc = (swarmProcessingService as unknown as { ticketService?: { assignAgent: (t: string, a: string, r: string, p: string) => Promise<void> } }).ticketService;
      if (svc) {
        await svc.assignAgent(ticketId, agentId, role, phase);
      }
    },
  });
  swarmProcessingService.setMultiRoundDispatch(multiRoundDispatch);

  // ── Governance wiring (Stages 2-6) ──────────────────────────────
  const governanceStore = pool
    ? new PostgresGovernanceStore(pool)
    : new InMemoryGovernanceStore();
  const queueGovernanceService = new QueueGovernanceService(governanceStore);
  logger.info({ storeType: pool ? 'postgres' : 'in-memory' }, 'Governance store initialized');
  const phaseRegressionService = new PhaseRegressionService();
  const failureGovernanceService = new FailureGovernanceService();
  const swarmMetricsCollector = new SwarmMetricsCollector();

  phaseRegressionService.setGovernanceService(queueGovernanceService);
  swarmProcessingService.setGovernanceService(queueGovernanceService);
  swarmProcessingService.setPhaseRegressionService(phaseRegressionService);
  swarmProcessingService.setMetricsCollector(swarmMetricsCollector);
  logger.info('Governance services wired: QueueGovernance, PhaseRegression, FailureGovernance, Metrics');

  // ── Phase-aware routing (legacy parity) ──────────────────────────
  const meshBidBroadcaster = runtimeRegistryService
    ? new MeshBidBroadcaster(meshTransport, buildStatusAwareOnlineResolver(runtimeRegistryService, agentProfileRepository))
    : undefined;
  if (meshBidBroadcaster) {
    meshBidBroadcaster.setMeshCommunicationService(meshCommunicationService);
    // Subscribe to the queue-manager direct channel so MeshCommunicationService
    // can route BID_RESPONSE replies back to pending request() promises.
    meshCommunicationService.subscribeAgent('queue-manager', async (_envelope, _entryId) => {
      // No-op handler — replies are intercepted by pendingReplies in subscribeAgent()
    });
    logger.info('Subscribed to agent.queue-manager channel for bid reply collection');
  }
  const phaseRoutingService = new PhaseRoutingService(agentRouter, competencyRanker, meshBidBroadcaster);
  swarmProcessingService.setPhaseRoutingService(phaseRoutingService);
  logger.info('PhaseRoutingService wired with MeshBidBroadcaster for legacy-parity phase-aware routing');

  // ADR-083: the knowledge-owner call-out for the generic 'task' lane. The queue manager
  // broadcasts a BID_REQUEST to online owners (they self-score from their declared
  // capabilities/selector) and the AgentRouter cascade decides — replacing the deleted
  // free-text regex pin in jarvis-routes. Consumed by dispatch-manifest-worker.
  const resolveTaskWorker = buildTaskCallOutResolver({
    agentRouter,
    meshBidBroadcaster,
    agentProfileRepository,
    resolveOnlineAgentIds: runtimeRegistryService
      ? buildStatusAwareOnlineResolver(runtimeRegistryService, agentProfileRepository)
      : undefined,
    // ADR-087: jarvis-sourced AND a2a-gateway-sourced tickets (Plan F) only reach bots
    // whose accessRoles admit 'jarvis' — task-call-out.ts's ROLE_GATED_TICKET_SOURCES.
    isAgentAccessibleTo: isBotAccessibleTo,
  });

  if (runtimeRegistryService) {
    swarmProcessingService.setOnlineAgentIdsResolver(buildStatusAwareOnlineResolver(runtimeRegistryService, agentProfileRepository));
    // IMP-1: Wire eligibility service for adaptive rerouting
    const { AgentEligibilityService } = require('@/features/agent-management/services/agent-eligibility-service');
    swarmProcessingService.setEligibilityService(new AgentEligibilityService(runtimeRegistryService, agentProfileRepository));
  }
  const swarmOrchestrationController = new SwarmOrchestrationController(
    swarmProcessingService,
    intakeService,
    escalationStore,
    createChildLogger({ module: 'swarm-orchestration-controller' }),
    workItemRepository,
  );

  const personaLayerStore = pool ? new PersonaLayerStore(pool) : undefined;

  const handoverManager = new RALFHandoverManager();

  // Cost-linking ticket service — available to ALL bots (not just PM) so every
  // bot can create ticket_task_links entries for its cost data (ADR-027).
  const costLinkingTicketStore = pool ? new PostgresTicketStore(pool) : undefined;
  const costLinkingTicketService = costLinkingTicketStore ? new TicketService(costLinkingTicketStore) : undefined;
  const promptAgentToolRepository = pool ? new AgentToolRepository(pool) : undefined;

  // The swarm controller's execution handler only handles envelopes for the PM bot
  // (local execution via agent.processMessage). All other bots consume their own
  // envelopes directly via SwarmAgentWorker on their bot-node containers.
  const executionHandler = agentProfileRepository && getProvider
    ? createLLMExecutionHandler({
        resolveProvider: getProvider,
        agentProfileRepository,
        personaLayerStore,
        swarmMemoryService,
        handoverManager,
        recordCost: (event) => costTrackingService.recordCost(event),
        recordMetrics: (event) => agentMetricsServiceInstance.recordExecution(event),
        ticketService: costLinkingTicketService,
        resolvePromptAuthorization: createPromptAuthorizationResolver(promptAgentToolRepository),
        resolveAgentHarness: (agentId: string) => resolveHarnessForAgent(agentId, logger),
      })
    : undefined;

  // The swarm controller subscribes only to its own channels (PM direct + broadcast).
  // Each bot node subscribes to its own channel via its own SwarmAgentWorker.
  const workerChannels = [
    MESH_CHANNELS.broadcast,
    MESH_CHANNELS.capabilities,
    ...buildRuntimeAliasChannels(runtimeIdentity),
  ];
  const workerPrimaryChannel = MESH_CHANNELS.agentDirect(runtimeIdentity.agentId);

  const isTicketTerminal = pool
    ? async (ticketId: string): Promise<boolean> => {
        const result = await pool.query(
          'SELECT status FROM tickets WHERE ticket_id = $1 LIMIT 1',
          [ticketId],
        );
        const status = result.rows[0]?.status as string | undefined;
        return status === 'complete' || status === 'escalated';
      }
    : undefined;

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
    workItemRepository,
    handler: executionHandler,
    channel: workerPrimaryChannel,
    consumerId: runtimeIdentity.agentId,
    additionalChannels: workerChannels,
    directHandler: bidResponseHandler,
    isTicketTerminal,
    updateTicketStatus: costLinkingTicketService
      ? (ticketId, status, metadata) => costLinkingTicketService.updateStatus(ticketId, status, metadata)
      : undefined,
    recordTicketActivity: costLinkingTicketService
      ? (ticketId, metadata) => costLinkingTicketService.recordActivity(ticketId, metadata)
      : undefined,
    recordTicketAssignment: costLinkingTicketService
      ? async (ticketId, agentId, metadata) => {
          const phase = metadata.phase != null ? `phase-${metadata.phase}` : undefined;
          await Promise.all([
            costLinkingTicketService.updateTicket(ticketId, { assignedAgentId: agentId }),
            costLinkingTicketService.assignAgent(ticketId, agentId, 'worker', phase),
          ]);
        }
      : undefined,
  });
  logger.info(
    {
      runtimeAgentId: runtimeIdentity.agentId,
      runtimeAgentName: runtimeIdentity.agentName,
      primaryChannel: workerPrimaryChannel,
      additionalChannels: workerChannels,
    },
    'Configured swarm worker channels for runtime identity',
  );

  const agentConfigService = pool ? new AgentConfigService(pool) : undefined;
  // ADR-034 gap-b push-on-dispatch: a resolver over the SAME authoritative agent_config
  // record ConfigSyncService versions, so each bot-node dispatch can carry the expected
  // provider/model/configVersion. Consumed by the queue manager's manifest-worker + incident
  // dispatch paths. OSHAL_PUSH_ON_DISPATCH defaults on; without this DB-backed resolver the
  // request carries an unavailable-authority marker and the remote bot refuses before execution.
  const runtimeParamsResolver = agentConfigService
    ? createAgentConfigRuntimeParamsResolver(agentConfigService)
    : undefined;
  const toolRepository = pool ? new ToolRepository(pool) : undefined;
  const agentToolRepository = pool ? new AgentToolRepository(pool) : undefined;
  const switchFrameworkService = agentToolRepository && toolRepository
    ? new SwitchFrameworkService(agentToolRepository, toolRepository, logger)
    : undefined;
  const selectorCompositionService = agentToolRepository && pool
    ? new SelectorCompositionService(agentToolRepository, pool, logger)
    : undefined;

  // ADR-034: bidirectional any-bot config ownership/sync. OSHAL owns the authoritative
  // per-agent runtime-param record; this service pushes OSHAL-originated changes down to
  // live bots (via switchProvider) and reconciles bot-reported local changes broadcast on
  // the swarm.config-change mesh channel into that record (central-wins, versioned, audited).
  const configSyncService = agentConfigService
    ? new ConfigSyncService({
        mesh: meshCommunicationService,
        agentConfig: agentConfigService,
        botNodeClient: new BotNodeClient(createRegistryEndpointResolver()),
        pool: pool ?? undefined,
      })
    : undefined;
  configSyncService?.start();

  // Launch deps for createAndStartAgent (POST /api/swarm/agents/create-and-start):
  // the same DynamicComposeService + overlay-aware spawner pairing agent-status-routes
  // uses for POST /api/agents/:agentId/launch, so both launch paths stay identical.
  const factoryDynamicCompose = new DynamicComposeService();
  const agentFactoryService = agentProfileRepository
    ? new AgentFactoryService({
        agentProfileRepository,
        meshTransport,
        personaLayerStore,
        toolRepository,
        switchFramework: switchFrameworkService,
        agentConfigStore: agentConfigService,
        recomposeSelector: selectorCompositionService
          ? (agentId) => selectorCompositionService.composeSelector(agentId)
          : undefined,
        dynamicComposeService: factoryDynamicCompose,
        containerSpawner: new BotContainerSpawnerService(undefined, undefined, factoryDynamicCompose.filePath),
        // On a cluster the compose pair is inert (no compose file, no docker
        // socket), so an app that brings its own bot-node could never launch it.
        // In-pod, launch runtimes as namespaced Deployments instead.
        botLauncher: isRunningInKubernetes()
          ? (KubernetesBotRuntimeLauncher.fromEnvironment() ?? undefined)
          : undefined,
      })
    : undefined;

  // Wire agent factory into routing for capability gap auto-creation
  // autoCreate=false by default — operator must approve. Set AUTO_CREATE_AGENTS=true to enable.
  if (agentFactoryService) {
    const autoCreate = process.env.AUTO_CREATE_AGENTS === 'true';
    swarmProcessingService.setAgentFactoryForRouting(agentFactoryService, autoCreate);
  }

  const capabilityExpansionService = agentProfileRepository
    ? new CapabilityExpansionService({
        agentProfileRepository,
        meshTransport,
        agentConfigService,
      })
    : undefined;

  // Remaining operational intelligence services (WS-7) — cost/metrics/audit/ranker created above
  const stuckAgentWatchdog = pool ? new StuckAgentWatchdog(pool) : undefined;
  const feedbackLoopService = new FeedbackLoopService(pool, agentMetricsServiceInstance);
  const privateMeshManager = new PrivateMeshManager(meshTransport);

  const isProjectManager = runtimeIdentity.role === 'project-manager';
  const ticketStore = pool && isProjectManager ? new PostgresTicketStore(pool) : undefined;
  const ticketService = ticketStore ? new TicketService(ticketStore) : undefined;
  const intakeController = new IntakeController(
    intakeService,
    createChildLogger({ module: 'intake-controller' }),
    ticketService
      ? (item) => ensureInternalTicketForWorkItem(ticketService, item)
      : undefined,
  );
  const localWorkspaceStore = pool && isProjectManager ? new PostgresWorkspaceStore(pool) : undefined;
  const localWorkspaceService = localWorkspaceStore && ticketStore
    ? new WorkspaceService(localWorkspaceStore, ticketStore)
    : undefined;

  // Pipeline services for queue manager
  const decompositionService = new TicketDecompositionService();
  let subtaskLifecycleService: SubtaskLifecycleService;
  if (pool) {
    try {
      const subtaskStore = new PostgresSubtaskLifecycleStore(pool);
      subtaskLifecycleService = new SubtaskLifecycleService(subtaskStore);
    } catch {
      subtaskLifecycleService = new SubtaskLifecycleService();
    }
  } else {
    subtaskLifecycleService = new SubtaskLifecycleService();
  }

  // Create TaskFolderService for workspace directory management
  const workspaceRoot = process.env.SHARED_WORKSPACE_ROOT
    || (require('fs').existsSync('/app/workspace') ? '/app/workspace' : require('path').resolve(process.cwd(), 'workspace-shared'));
  const taskFolderService = new TaskFolderService(workspaceRoot);

  // BotNodeClient routing
  // ──────────────────────
  // Per any-bot-swarm-separation-design.md, the swarm controller should dispatch
  // via HTTP to bot-node containers. In practice the bot-node JS layer only has
  // ClineProvider + ClaudeCodeProvider — no codex provider — and claude-code
  // CLI rejects --dangerously-skip-permissions in root containers, so file
  // writes return "please approve" and ticket deliverables never land.
  //
  // Codex CLI does work end-to-end as root (validated by LM education + build
  // pipelines). It runs from inside the api container's task-orchestrator,
  // which honors the agent's harnessType from the registry. When the agent's
  // harnessType is 'codex-cli' (or apiType is 'openai-codex'), prefer that
  // legacy path. When the bot is explicitly claude-code or has no codex hint,
  // dispatch via BotNodeClient.
  const codexResolveEndpoint = (agentId: string): string | null => {
    try {
      const def = SwarmBotRegistry.listDefinitions().find((d) => d.agentId === agentId);
      if (!def || !def.container) return null;
      if (isControllerInlineContainer(def.container)) {
        logger.info(
          { agentId, botName: def.name, container: def.container },
          'Bot is controller-inline - using legacy local execution path',
        );
        return null;
      }
      // ADR-081: node-bound workspace (e.g. oshal-developer's clone) → always dispatch to the
      // node; the bot-node JS CodexProvider exists now, so the prefer-inline rule doesn't apply.
      if (def.requiresOwnNode) return `http://${def.container}:5000`;
      const wantsCodex = def.harnessType === 'codex-cli' || def.apiType === 'openai-codex';
      if (wantsCodex) {
        // Force legacy path (api task-orchestrator → codex CLI). Returning null
        // makes BotNodeClient.execute throw, which dispatchIncidentTicket /
        // dispatchManifestWorkerTicket catches and falls back to /api/send-message.
        return null;
      }
      return `http://${def.container}:5000`;
    } catch {
      return null;
    }
  };
  const botNodeClient = new BotNodeClient(codexResolveEndpoint);

  // Run-history recorder for the 'graph' dispatch path (studio Runs panel). Telemetry only —
  // every recorder method is non-throwing, so it can never gate or break a dispatch.
  const workflowRunRecorder = pool && isProjectManager ? new WorkflowRunHistoryStore(pool) : undefined;

  const queueManagerService = ticketService && isProjectManager
    ? new QueueManagerService(ticketService, swarmProcessingService, {
        taskFolderService,
        decompositionService,
        subtaskLifecycleService,
        workspaceService: localWorkspaceService!,
        workItemRepository,
        botNodeClient,
        taskStore: conversationStores?.taskStore,
        messageStore: conversationStores?.messageStore,
        resolveBotCreds: pool
          ? async (ownerSub: string, _workerAgentId: string, providerIntent) => {
              // A credential may cross this boundary only for the one validated deterministic
              // provider operation. Generic worker/model connector sets are deliberately excluded.
              const providers = providerIntent?.kind === 'priority-email'
                ? ['google']
                : providerIntent?.kind === 'walmart-catalog'
                  ? ['walmart']
                  : [];
              return providers.length > 0
                ? resolveServerOperationCreds(pool, ownerSub, providers, 'trusted-provider-intent')
                : {};
            }
          : undefined,
        workflowRunRecorder,
        resolveAgentIdByName: agentProfileRepository
          ? async (name: string) => {
              const agents = await agentProfileRepository.listAgents();
              const match = agents.find((a) => a.name?.toLowerCase() === name.toLowerCase());
              return match?.agentId;
            }
          : undefined,
        // ADR-083: knowledge-owner call-out for the 'task' lane.
        resolveTaskWorker,
        // ADR-034 gap-b push-on-dispatch: authoritative-config stamping for bot-node
        // dispatches (default-on OSHAL_PUSH_ON_DISPATCH; undefined without a DB pool becomes
        // an explicit unavailable-authority refusal rather than a silent self-selected provider).
        runtimeParamsResolver,
        // At-most-once for explicit-remote work: the dispatcher stamps the remote task id onto the
        // ticket's own metadata BEFORE enqueueing, so a controller restart mid-flight cannot lose
        // the fact that a machine was already told to do this. Postgres is the only store that
        // outlives the process — the remote-client registry is in-memory by design.
        dispatchExplicitRemoteTask: (ticket) => dispatchExplicitRemoteTicket(ticket, {
          recordDispatch: async (ticketId, taskId) => {
            await ticketService.updateTicket(ticketId, {
              metadata: {
                ...((ticket.metadata ?? {}) as Record<string, unknown>),
                [EXPLICIT_REMOTE_TASK_ID_KEY]: taskId,
              },
            });
          },
        }),
        dispatchJobApplicationTask: async (ticket) => {
          const userSub = typeof ticket.ownerSub === 'string' ? ticket.ownerSub : '';
          if (!userSub) return { handled: true, accepted: false, error: 'Application ticket has no owner identity' };
          // A durable per-résumé job-apply ticket carries its posting in metadata.postingId so THAT
          // specific packet is applied (not just "newest generated first"). Absent → legacy behaviour.
          const meta = ticket.metadata as Record<string, unknown> | undefined;
          const ticketPostingId = Number(meta?.postingId);
          // Optional pinned leaf node the operator chose in the submit dropdown — forward it so the
          // browser runs on THAT desktop/remote box (not just the auto-picked default).
          const targetRemoteClientId = meta?.targetRemoteClientId ? String(meta.targetRemoteClientId) : undefined;
          try {
            const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}/api/apply/dispatch`, {
              method: 'POST',
              headers: { ...serviceSecretHeaders(), 'content-type': 'application/json' },
              body: JSON.stringify({
                userSub,
                ticketId: ticket.ticketId,
                ...(Number.isFinite(ticketPostingId) && ticketPostingId > 0 ? { postingId: ticketPostingId } : {}),
                ...(targetRemoteClientId ? { targetRemoteClientId } : {}),
              }),
            });
            const body = await response.json() as Record<string, unknown>;
            return {
              handled: true,
              accepted: response.status === 202 && body.ok === true,
              taskId: typeof body.taskId === 'string' ? body.taskId : undefined,
              postingId: Number.isFinite(Number(body.postingId)) ? Number(body.postingId) : undefined,
              // The desktop lost a race (busy/offline) — defer, don't escalate. gatherAndDispatch tags
              // the transient statuses (409 in-flight, 429 too-many, 503 offline) with retryable.
              retryable: body.retryable === true,
              error: response.ok ? undefined : String(body.error || `dispatcher returned ${response.status}`),
            };
          } catch (error) {
            // A fetch/network error to our OWN api is transient — let the ticket retry next poll.
            return { handled: true, accepted: false, retryable: true, error: error instanceof Error ? error.message : 'application dispatch failed' };
          }
        },
      })
    : undefined;

  if (queueManagerService && ticketService) {
    queueManagerService.setGovernanceService(queueGovernanceService);
    // Cost-governance: spend budgets + runaway kill switch checked pre-dispatch each poll
    // cycle. BudgetService fails OPEN on any infra gap, so wiring it never bricks dispatch.
    queueManagerService.setBudgetService(new BudgetService(pool));
    // ADR-119 P4 (A2): the bounded auto-apply gate for Mode-A incident verdicts. The
    // engine owns every bound (kill switch SELF_HEAL_AUTO_APPLY default OFF, sanctioned
    // classes, absolute core-infra refusal, once-per-key-per-TTL, hourly cap,
    // verify-before-complete); the executor is the deterministic HTTP seam to the
    // self-healing bot node (the ONE container with the docker socket). Wiring is inert
    // until a deployment flips the kill switch — off means A1 semantics exactly.
    queueManagerService.setAutoApplyGate(
      new SelfHealAutoApplyEngine(ticketService, createSelfHealRemediationExecutor()),
    );
    // Queue DLQ (migration 081): persisted poison-ticket policy. Records failed dispatch
    // cycles (via the rollback hook) + system escalation cycles (via its own ticketEvents
    // listener — start() attaches exactly this one instance) and quarantines at
    // QM_MAX_ATTEMPTS into terminal 'dead_letter'. Fail-open like BudgetService: a null
    // pool / missing table never quarantines and never bricks dispatch. Operator alerts
    // fan out on topic 'queue-dlq' through the notification-center router (pool required).
    const deadLetterService = new DeadLetterService({
      pool,
      ticketService,
      notify: pool ? buildQueueDlqOperatorNotifier(pool) : undefined,
    });
    deadLetterService.start();
    queueManagerService.setDeadLetterService(deadLetterService);
  }

  logger.info(
    { role: runtimeIdentity.role, isProjectManager, hasQueueManager: Boolean(queueManagerService) },
    'Queue manager eligibility resolved',
  );

  return {
    intakeController,
    swarmOrchestrationController,
    agentWorker,
    meshCommunicationService,
    workItemRepository,
    pool: pool ?? undefined,
    runtimeIdentity,
    runtimeRegistryService,
    agentFactoryService,
    capabilityExpansionService,
    agentConfigService,
    configSyncService,
    agentMemoryService,
    swarmMemoryService,
    costTrackingService,
    agentMetricsService: agentMetricsServiceInstance,
    routingAuditLog,
    competencyRanker,
    stuckAgentWatchdog,
    feedbackLoopService,
    privateMeshManager,
    swarmTicketProcessingService: swarmProcessingService,
    queueManagerService,
    swarmMetricsCollector,
  };
}

/**
 * @description Registers swarm extension routes and starts the agent worker.
 * @param app - Express application instance
 * @param requiresAuth - Authentication middleware
 * @param bindings - Swarm extension bindings from composition root
 * @returns Nothing
 */
export function registerSwarmExtensionRoutes(
  app: Application,
  requiresAuth: RequestHandler,
  bindings: SwarmExtensionBindings,
): void {
  logger.info('Registering swarm extension routes');
  app.use('/api/intake', requiresAuth, createIntakeRoutes(bindings.intakeController));
  app.use('/api/swarm', requiresAuth, createSwarmOrchestrationRoutes(bindings.swarmOrchestrationController));
  if (bindings.agentFactoryService) {
    app.use('/api/swarm/agents', requiresAuth, createAgentFactoryRoutes(bindings.agentFactoryService));
  }
  if (bindings.capabilityExpansionService && bindings.agentConfigService) {
    app.use('/api/swarm/agents', requiresAuth, createCapabilityExpansionRoutes(
      bindings.capabilityExpansionService,
      bindings.agentConfigService,
    ));
  }
  if (bindings.agentMemoryService && bindings.swarmMemoryService) {
    app.use('/api/swarm/memory', requiresAuth, createMemoryRoutes(
      bindings.agentMemoryService,
      bindings.swarmMemoryService,
    ));
  }
  app.use('/api/swarm/ops', requiresAuth, createOpsIntelligenceRoutes(bindings));
  app.use('/api/swarm/bots', requiresAuth, createBotRegistryRoutes(bindings.runtimeRegistryService, bindings.pool));
  app.use('/api/swarm/config', requiresAuth, createConfigPropagationRoutes());
  // ADR-034: OSHAL-owned per-agent runtime config (provider/model) — push-down + read.
  // serviceSecretOr (the /api/graph pattern): bot-nodes pull their own authoritative record
  // on boot (bot-node-config-bootstrap.ts) with X-Service-Secret; operators use OIDC as before.
  app.use('/api/agents', serviceSecretOr(requiresAuth), createConfigRuntimeRoutes(bindings.configSyncService, bindings.agentConfigService));
  startRuntimeAgentHeartbeat(bindings);
  // Auto-seed this bot into the Postgres agents table so the router can find it.
  // Without this, only manually-created profiles are routable.
  seedAgentProfile(bindings.pool, bindings.runtimeIdentity).catch((err) =>
    logger.warn({ err }, 'Failed to seed agent profile in Postgres — bot will only be discoverable via Redis'),
  );
  seedInlineControllerBotProfiles(bindings.pool).catch((err) =>
    logger.warn({ err }, 'Failed to seed inline controller bot profiles in Postgres'),
  );
  bindings.agentWorker.start().catch((err) => logger.error({ err }, 'Failed to start swarm agent worker'));
  bindings.stuckAgentWatchdog?.start();
  bindings.privateMeshManager?.startCleanup();

  // BF-032: Routing retry ownership moved into QueueManagerService so only the
  // project-manager scheduler mutates queue state. Worker bots still execute
  // envelopes but do not run independent retry intervals.
  if (bindings.workItemRepository) {
    logger.info(
      { queueManagerOwned: Boolean(bindings.queueManagerService) },
      'Routing retry sweep is owned by QueueManagerService',
    );
  }

  // Claude Code and OpenAI Codex credential broadcast distribution are intentionally disabled.
  // Redis pub/sub has no ordered durable tombstone, so a delayed credential event could resurrect
  // revoked auth. Re-enable only behind a versioned, monotonic rail with revocation ordering.
  if (bindings.queueManagerService) {
    const qms = bindings.queueManagerService;
    // Register the shutdown hook up front (stop() on a not-yet-started manager is a safe
    // no-op), then gate start() on migration completion: its crash-recovery sweep queries
    // the tickets table, which doesn't exist yet on a clean-DB first boot. Bounded wait —
    // a failed/slow bootstrap releases the gate and the poll loop self-heals as before.
    registerShutdownHook('queue-manager', () => qms.stop());
    void waitForBootstrapComplete().then((migrated) => {
      if (!migrated) logger.warn('Queue manager starting without confirmed DB bootstrap completion');
      qms.start();
      logger.info('Queue manager started for project-manager bot');
    });
  }

  // Per-container capability announcement: broadcast agent identity on startup
  const runtimeIdentity = bindings.runtimeIdentity;
  if (runtimeIdentity.agentId.length > 0) {
    bindings.meshCommunicationService.broadcast(runtimeIdentity.agentId, {
      type: 'agent-announce',
      agentId: runtimeIdentity.agentId,
      agentName: runtimeIdentity.agentName,
      aliases: runtimeIdentity.aliases,
      role: runtimeIdentity.role,
      capabilities: runtimeIdentity.capabilities,
      endpointUrl: runtimeIdentity.endpointUrl,
      internalEndpointUrl: runtimeIdentity.internalEndpointUrl,
      externalPort: runtimeIdentity.externalPort,
      status: 'online',
      startedAt: new Date().toISOString(),
    }).then(() => {
      logger.info(
        { runtimeAgentId: runtimeIdentity.agentId, runtimeAgentName: runtimeIdentity.agentName },
        'Per-container capability announcement broadcast',
      );
    }).catch((err) => {
      logger.warn({ err, runtimeAgentId: runtimeIdentity.agentId }, 'Failed to broadcast capability announcement (non-fatal)');
    });
  }
}

// Runtime-registry + heartbeat helpers moved to ./swarm-runtime-registry, and the
// boot-time agent-profile seed to ./agent-profile-boot-seeder, to keep this file
// under the 1000-line governance cap (imported above).
