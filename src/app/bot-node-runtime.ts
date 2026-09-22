/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — extracted the bot-node bootstrap (identity → Postgres+GUC → repos → any-bot LLM stack → execution handler) out of bot-node-server.ts's unexported start(), so the long-lived server AND the new one-shot batch runner (ADR-078 §1, BOT_RUNTIME=bot-node-batch) share ONE construction path instead of duplicating ~250 lines of provider wiring. Mesh transport, heartbeats, profile seeding and the HTTP surface stay in bot-node-server.ts — a batch pod needs none of them. Behaviour-preserving move; the only reorder is that providers are now built before the profile seed (they have no dependency on it).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-034 boot bootstrap-pull (env-as-seed): createBotNodeRuntime now pulls this agent's authoritative provider/model record from the controller (bot-node-config-bootstrap.ts → GET /api/agents/:id/runtime) and overlays it onto the env seeds BEFORE buildLlmStack, so FORCE_LLM_PROVIDER/FORCE_LLM_MODEL/CODEX_MODEL/CLAUDE_CODE_MODEL defer to the pulled record. Fail-open: unreachable/no-record/disabled (OSHAL_BOT_CONFIG_BOOTSTRAP=off) → identical legacy self-resolve. Both entrypoints (server + batch) inherit it through this shared path.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Renamed the task-controller bridge parameter to anyBotTaskController: the identifier still carried the retired pre-OSHAL product name, contradicting the rename rollout the docs describe. Pure rename, no behavior change.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Cline default timeout 600000→3600000 (60-min ceiling, operator idle-timeout directive 2026-07-24): batch output can't do idle semantics, but the duration bound must not kill long actively-working runs. CLINE_TIMEOUT_MS overrides.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-034 push-down seam: the boot-resolved provider/model are now MUTABLE — buildLlmStack closes getCurrentProvider over a `let`, and the runtime exposes getActiveProvider/setActiveProvider. setActiveProvider validates against the built provider map (unknown/unavailable → UnknownBotNodeProviderError, no switch), updates the TaskController toggle, and overlays FORCE_LLM_PROVIDER/FORCE_LLM_MODEL(+CODEX_MODEL/CLAUDE_CODE_MODEL) via the SAME applyPulledBotConfigToEnv the boot pull uses, so every downstream env resolver agrees. The execution handler's cost-attribution fallbacks read the LIVE values through property getters. In-flight executions keep their already-selected provider (same semantics as any-bot).
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | ADR-034 gap-b LIVE WIRING: pass the mutable provider seam (getActiveProvider/setActiveProvider) into the execution handler as dispatchConfigRuntime, so a dispatch carrying an authoritative provider/model/configVersion is reconciled against the active provider before executing (bot self-corrects on drift). Additive — the seam already existed; this just hands it to the handler.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: wire durable provenance-aware swarm memory and the persisted enabled-tool resolver into bot-node prompt containment.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | ADR-128 Amendment 1 (operator directive 2026-08-13): claude-code removed as a DEFAULT — the subscription is being cancelled, so an automatic degrade onto it turns a codex outage into silent spend on a dying account. The unforced provider order leads with codex (was cline -> claude -> codex) and codex's auto-failover chain drops claude-code (now ['cline-cli']). Naming claude-code in OSHAL_PROVIDER_RUNTIME_FALLBACK_PROVIDER still works — that is a deliberate operator choice, not a default.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Honor DB_MAX_CONNECTIONS for the bot-node Postgres pool and stamp a per-bot application_name, making the existing fleet knob effective for managed-database connection budgets.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Guard protected package execution with current caller policy, restricted business identity and durable node ownership.
 * 11 | maintainer@emeraldcoastsystemsgroup.com | Admit verified hosted protected execution and keep only cost bookkeeping in explicit system context.
 * 12 | maintainer@emeraldcoastsystemsgroup.com | A lost cold-start race no longer leaves the long-lived bot pool-less for life. connectPool moved to bot-node-database-pool.ts (re-exported here for the one-shot callers, contract unchanged); createBotNodeRuntime takes { recoverDatabase } and, when the server sets it, builds every repository and the protected-execution boundary over a pool that is KEPT through boot-window exhaustion and recovered in the background, and exposes `database` (status + whenReady) so the health route can refuse 200 while there is no database. The batch runner does not set it: a Job pod must exit, not wait.
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | "A bot's LLM provider is a row in a table" — the bot-node half: setActiveProvider (the ADR-034 reconcile and PUT /api/llm-provider both land here) now translates a switch row's id through resolveBotNodeSwitch: a runtime name/alias as before, or a Cline-backed API provider id (gemini, anthropic, openrouter, ... from the same ProviderRegistry the api validates against) onto the cline-cli runtime with CLINE_API_PROVIDER/CLINE_API_MODEL set to the row's id and model (the wrapper's precedence-1 keys, read before every spawn) and restored to the container's seeds on the way back. getActiveProvider reports the backing provider as apiProvider. Boot: a pulled Cline-backed id (FORCE_LLM_PROVIDER=gemini after the bootstrap overlay) used to be silently ignored and the bot booted codex; resolveCurrentProvider now lands it on cline-cli fronting that id. An id nothing knows still throws UnknownBotNodeProviderError with no state change.
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | The fallback CHAIN is configuration, not a literal (operator, 2026-09-18). Deleted: a `'claude-code' | 'openai-codex' | 'cline-cli'` union on the wrapper's parameters and a Record literal mapping each of those three names to its hardcoded successors. A provider outside those three could not be a fallback at all, an administrator could not reorder the chain, and that vendor exclusion of 2026-08-13 lived as a missing array entry - so when the single remaining name ran out of tokens, recovery required editing and redeploying code. Now: resolveBotNodeProviderFallbackOrder reads an ordered list from configuration (the fallback_order column of the bot or fleet switch row, carried to the node as OSHAL_PROVIDER_FALLBACK_ORDER; the legacy single-name variables still parse), the wrapper walks the WHOLE order by folding one ProviderFailoverProvider per rung so a chain of four is a chain of four, and no provider is named in this file. With nothing configured there is no failover, which is the honest answer - inventing a chain here is what caused the outage.
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Three defects an adversarial review measured. (1) The wrapping loop mutated baseProviderMap while iterating, so later runtimes wrapped ALREADY-WRAPPED providers: replayed with three throwing providers, cline-cli realized a NINE-attempt sequence and a two-rung chain made it fail over to itself - each attempt a real subprocess against a vendor that had just returned 429. It now snapshots first and rungs are always raw providers. (2) The new env key sat at the head of a ?? chain while compose defines it as an EMPTY STRING on every bot, and ?? does not fall through on '', so it permanently shadowed all four legacy variables and disabled a working configuration; the chain is truthiness-based now. (3) Rung matching lost its lowercasing while the route kept it, so a capitalised entry vanished at the node.
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | A fallback rung may name ANY provider the catalog knows. Rungs were resolved by indexing the three-key runtime map, so every id that is not a native runtime name - openrouter, anthropic, gemini, the ids the api accepts, the row stores, the cockpit renders and the boot pull carries - missed, landed in `unavailable`, and became one logger.warn nothing surfaces: the chain .env.example and the cockpit placeholder both advertise realized as a SINGLE rung. Rungs now resolve through resolveBotNodeSwitch, the same translator the primary already used, and a Cline-backed rung is wrapped by createClineBackedRungProvider so it fronts its OWN vendor for the duration of the call and restores what it found on entry (not the container seeds, so a Cline-backed primary keeps its backing when a rung returns); CLINE_API_MODEL is cleared rather than carried, because fallback_order stores provider ids only and one vendor's model id fails on another as a wrong-model error that looks nothing like a failover. Dedupe is on runtime+apiProvider, never the runtime alone, which had discarded the second of two Cline-backed vendors. resolveBotNodeProviderFallbackOrder also takes an injectable env so a guard can establish "unconfigured" across all five variables it reads instead of inheriting the ambient shell.
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | The bot's swarm memory is constructed with the 'reader-helper' ledger reach. oshal_bot holds no privilege on oshal_swarm_memory at all, so recall raised permission denied inside its own catch and every bot ran with zero memory behind one warning. The helper (migration 152) returns shared memories plus the reader's own, with the owner rule enforced in SQL, so the fix does not hand a bot the table.
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | The bot-node's any-bot ToolRegistry was built empty and stayed empty. registerFileTools/registerCLITools run only from any-bot/server/app.js, the retired BOT_RUNTIME=any-bot server, so on every real worker registry.getAll() returned NOTHING - captureDispatchCapabilities therefore advertised attempt_completion and nothing else, and a granted, mapped, scoped tool still had no handler to reach. buildLlmStack now returns the registry it constructed and createBotNodeRuntime registers the read-only question tools on it (bot-node-read-only-tools.ts), which is the first point in the boot where the GUC-wrapped pool, the RagService and a graph connector all exist. Registration only makes a tool a CANDIDATE: authority is still declared set n allowlist n exact operation scope, resolved before any handler is reached.
 */
import { createProtectedBotExecutionBoundary } from './bot-node-protected-execution';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';

/**
 * Shared bot-node runtime bootstrap.
 *
 * ONE construction path, two entrypoints:
 *   - `bot-node-server.ts`  → long-lived worker: adds mesh transport, heartbeat, HTTP, SwarmAgentWorker
 *   - `bot-node-batch.ts`   → one-shot Job pod: runs a single phase envelope and exits
 *
 * Everything here is what BOTH need: which agent am I, a DB pool under the RLS
 * GUC wrapper, the repositories, the any-bot provider stack, and the envelope
 * execution handler that turns a MeshEnvelope into real LLM work with cost capture.
 *
 * @module bot-node-runtime
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { MeshEnvelope } from '@/features/agent-management';
import { PersonaLayerStore, SwarmMemoryService } from '@/features/agent-management';
import { RagService } from '@/features/rag';
import { RALFHandoverManager, type EnvelopeExecutionResult } from '@/features/swarm-orchestration';
import { SwarmBotRegistry } from '@/app/extensions/swarm/swarm-bot-registry';
import { AgentProfileRepository } from '@/entities/agent';
import { AgentToolRepository } from '@/entities/tool';
import { WorkItemRepository } from '@/entities/work-item';
import { TicketService, PostgresTicketStore } from '@/features/ticketing';
import { CostTrackingService } from '@/features/operational-intelligence';
import { createBotNodeExecutionHandler } from './bot-node-execution-handler';
import { applyPulledBotConfigToEnv, runBootConfigBootstrap } from './bot-node-config-bootstrap';
import { UnknownBotNodeProviderError, type ActiveBotNodeProvider } from './bot-node-llm-provider-route';
import { createClineBackingEnv, resolveBotNodeSwitch } from './bot-node-provider-switch';
import { ProviderRegistry } from '@/features/llm-provider';
import { createPromptAuthorizationResolver } from './prompt-authorization-resolver';
import { connectPool, connectRecoverableBotNodeDatabase, type BotNodeDatabase } from './bot-node-database-pool';
import { registerBotNodeReadOnlyTools, type ReadOnlyToolRegistration } from './bot-node-read-only-tools';
import { createGraphConnector } from '@/features/graph';

export { connectPool };

const logger = createChildLogger({ module: 'bot-node-runtime' });

/** Everything a bot-node entrypoint needs, however it is driven. */
export interface BotNodeRuntime {
  agentId: string;
  botName: string;
  role: string;
  capabilities: string[];
  /** Full resolved identity — the server reads aliases/endpoints from it for heartbeats. */
  identity: ReturnType<typeof SwarmBotRegistry.resolveRuntimeIdentity>;
  pool: Pool | null;
  /** Whether the pool has ever answered, and when it first does. The health route reads this. */
  database: Pick<BotNodeDatabase, 'status' | 'whenReady' | 'stop'>;
  agentProfileRepository?: AgentProfileRepository;
  personaLayerStore?: PersonaLayerStore;
  workItemRepository?: WorkItemRepository;
  costTrackingService: CostTrackingService;
  ticketService?: TicketService;
  /** Turns one MeshEnvelope into real LLM work (prompt assembly + any-bot execution + cost capture). */
  executionHandler: (envelope: MeshEnvelope) => Promise<EnvelopeExecutionResult>;
  /** Boot-resolved snapshot. For the LIVE value after a switch, read {@link getActiveProvider}. */
  providerName: string;
  /** Boot-resolved snapshot. For the LIVE value after a switch, read {@link getActiveProvider}. */
  modelName: string;
  /** Live active provider/model — reflects any setActiveProvider switch since boot. */
  getActiveProvider: () => ActiveBotNodeProvider;
  /**
   * ADR-034 push-down / local-change seam: validates the provider against the built
   * provider map and switches the active provider (+ optional model). Throws
   * UnknownBotNodeProviderError (no switch) on an unknown/unavailable provider.
   */
  setActiveProvider: (provider: string, model?: string) => ActiveBotNodeProvider;
  /** any-bot AgenticController — the server's Token Chase replay route calls getActiveProvider(). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agenticController: any;
}

/**
 * @description Builds the shared bot-node runtime: resolves this container's agent identity,
 * connects Postgres (retrying a cold start) under the RLS GUC wrapper, constructs the
 * repositories, initializes the any-bot LLM provider stack with runtime failover, and wires
 * the envelope execution handler.
 * @param options - `recoverDatabase: true` (the long-lived server) keeps the pool through a lost
 *   cold-start race and recovers it in the background; omitted (one-shot batch) keeps the bounded
 *   connect that returns null so the process can exit.
 * @returns The constructed runtime. DB-less (repositories undefined, cost capture a no-op) only
 *   when DATABASE_URL is unset, or for a one-shot caller whose bounded connect was exhausted.
 */
export async function createBotNodeRuntime(options: { recoverDatabase?: boolean } = {}): Promise<BotNodeRuntime> {
  const runtimeIdentity = SwarmBotRegistry.resolveRuntimeIdentity(process.env);
  const agentId = runtimeIdentity.agentId;
  const botName = runtimeIdentity.agentName;
  logger.info({ agentId, botName, role: runtimeIdentity.role }, 'Resolved runtime identity');

  const database = options.recoverDatabase ? await connectRecoverableBotNodeDatabase() : await connectOneShotDatabase();
  const pool = database.pool;

  const agentProfileRepository = pool ? new AgentProfileRepository(pool) : undefined;
  const agentToolRepository = pool ? new AgentToolRepository(pool) : undefined;
  const personaLayerStore = pool ? new PersonaLayerStore(pool) : undefined;
  // 'reader-helper': oshal_bot holds no privilege on oshal_swarm_memory, so durable recall goes
  // through the derived helper (migration 152), which scopes the rows to shared memories plus the
  // reader's own in SQL. Reading the table directly here is what returned permission denied inside
  // the recall path's own catch, leaving every bot with no memory and one warning.
  const ragService = new RagService();
  const swarmMemoryService = new SwarmMemoryService(ragService, pool ?? undefined, 'reader-helper');
  const workItemRepository = pool ? new WorkItemRepository(pool) : undefined;
  const costTrackingService = new CostTrackingService(pool);
  const ticketStore = pool ? new PostgresTicketStore(pool) : undefined;
  const ticketService = ticketStore ? new TicketService(ticketStore) : undefined;

  // ADR-034 boot bootstrap-pull (env-as-seed): overlay the controller's authoritative
  // provider/model record onto the env seeds BEFORE the LLM stack resolves them, so a
  // reachable-OSHAL bot boots on the pulled record and env vars act as first-boot seeds.
  // Fail-open — any pull failure leaves the legacy self-resolve behavior untouched.
  await runBootConfigBootstrap(agentId);

  const {
    taskController, providerName, modelName, agenticController, getActiveProvider, setActiveProvider,
    toolRegistry,
  } = await buildLlmStack();

  // The read-only question tools. This is the only place the registry, the GUC-wrapped pool, the
  // RagService and the graph connector are all in scope, and it runs before the first dispatch can
  // capture capabilities. A null pool / absent graph engine is not an error here: each handler
  // reports its own unavailability rather than being silently missing from the advertised set.
  registerBotNodeReadOnlyTools(toolRegistry, {
    pool,
    ragService,
    graphConnector: createGraphConnector(),
  });

  const executionHandler = createBotNodeExecutionHandler({
    runApplicationExecution: createProtectedBotExecutionBoundary(pool, agentId),
    anyBotTaskController: taskController,
    agentProfileRepository,
    personaLayerStore,
    swarmMemoryService,
    handoverManager: new RALFHandoverManager(),
    resolvePromptAuthorization: createPromptAuthorizationResolver(agentToolRepository),
    recordCost: (event: Parameters<typeof costTrackingService.recordCost>[0]) => runWithSystemIdentity(() => costTrackingService.recordCost(event)),
    ticketService,
    // ADR-034 gap-b push-on-dispatch (bot half): the live provider seam so the handler can
    // reconcile a carried authoritative config against the active provider before executing.
    dispatchConfigRuntime: { getActiveProvider, setActiveProvider },
    // LIVE cost-attribution fallbacks: property getters so a setActiveProvider switch
    // (ADR-034 push-down) is reflected in subsequent executions' provider/model
    // attribution without rebuilding the handler.
    get providerName(): string { return getActiveProvider().provider; },
    get modelName(): string { return getActiveProvider().model; },
  });

  return {
    agentId, botName, role: runtimeIdentity.role, capabilities: runtimeIdentity.capabilities,
    identity: runtimeIdentity,
    pool, database, agentProfileRepository, personaLayerStore, workItemRepository,
    costTrackingService, ticketService, executionHandler, providerName, modelName,
    getActiveProvider, setActiveProvider, agenticController,
  };
}

/** One-shot callers get connectPool's bounded contract, described in the same status shape. */
async function connectOneShotDatabase(): Promise<BotNodeDatabase> {
  const pool = await connectPool();
  const status = { configured: Boolean(process.env.DATABASE_URL), ready: Boolean(pool), attempts: 0 };
  return {
    pool, status: () => ({ ...status }), stop: () => undefined,
    whenReady: pool ? Promise.resolve() : new Promise<void>(() => undefined),
  };
}

/** The any-bot TaskController shape the execution handler depends on. */
type AnyBotTaskController = Parameters<typeof createBotNodeExecutionHandler>[0]['anyBotTaskController'];

/**
 * @description Initializes the any-bot LLM provider stack (Cline / Claude Code / Codex), applies
 * runtime failover wrapping, resolves which provider and model are active, and returns the
 * TaskController the execution handler drives — plus the ADR-034 mutable-provider seam
 * (getActiveProvider/setActiveProvider) that lets a controller push-down or local change
 * switch the active provider without a container respawn.
 * @returns The task controller, boot-resolved provider/model names (cost attribution), and
 *   the live provider accessors.
 */
async function buildLlmStack(): Promise<{
  taskController: AnyBotTaskController; providerName: string; modelName: string;
  getActiveProvider: () => ActiveBotNodeProvider;
  setActiveProvider: (provider: string, model?: string) => ActiveBotNodeProvider;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agenticController: any;
  /** The registry BOTH controllers dispatch from — returned so the caller can register on it. */
  toolRegistry: ReadOnlyToolRegistration;
}> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const config = require('../../any-bot/server/utils/config');
  const TaskStore = require('../../any-bot/server/stores/TaskStore');
  const MessageStore = require('../../any-bot/server/stores/MessageStore');
  const CheckpointStore = require('../../any-bot/server/stores/CheckpointStore');
  const ToolRegistry = require('../../any-bot/server/services/ToolRegistry');
  const StreamController = require('../../any-bot/server/controllers/StreamController');
  const AgenticController = require('../../any-bot/server/controllers/AgenticController');
  const TaskController = require('../../any-bot/server/controllers/TaskController');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const taskStore = new TaskStore();
  taskStore.init();
  const messageStore = new MessageStore(taskStore.db);
  messageStore.init();
  const checkpointStore = new CheckpointStore(taskStore.db);
  checkpointStore.init();
  const toolRegistry = new ToolRegistry();
  const streamController = new StreamController();

  let clineProvider = initCline(config);
  let claudeCodeProvider = await initClaudeCode();
  let codexProvider = await initCodex();

  const baseProviderMap = {
    'claude-code': claudeCodeProvider,
    'openai-codex': codexProvider,
    'cline-cli': clineProvider,
  };
  // Every initialized runtime is wrappable and every one can be a rung of someone else's chain.
  // The names below are the RUNTIME keys this node constructed, not a policy about who falls back
  // to whom — that is entirely the administrator's ordered list.
  // Snapshot FIRST. Wrapping in place while iterating made every later runtime resolve its rungs
  // against ALREADY-WRAPPED providers: a nested tree whose shape depends on key order, in which a
  // two-rung chain could make a provider fail over to itself and a three-rung chain re-spawned a
  // just-429'd vendor up to nine times in one request. Rungs must always be the RAW providers.
  // The ids a switch row may name beyond the three runtimes: the Cline-backed API providers the
  // platform defines. Read once from the same definitions the api validates a row against, and
  // read BEFORE the failover wrap, because a rung may name any of them.
  const clineApiProviders = new ProviderRegistry().getAll().map((p) => p.id);
  const clineBackingEnv = createClineBackingEnv();

  const rawProviders: Record<string, any> = { ...baseProviderMap };
  for (const runtimeName of Object.keys(rawProviders)) {
    (baseProviderMap as Record<string, any>)[runtimeName] = maybeWrapBotNodeProviderFailover(
      rawProviders[runtimeName], runtimeName, rawProviders, undefined, { clineApiProviders },
    );
  }
  claudeCodeProvider = baseProviderMap['claude-code'];
  codexProvider = baseProviderMap['openai-codex'];
  clineProvider = baseProviderMap['cline-cli'];

  // ADR-034 mutable seam: the AgenticController's getCurrentProvider closes over these
  // `let`s, so setActiveProvider changes take effect on the NEXT provider resolution.
  // CAUTION: the AgenticController resolves the provider LIVE on every turn, so an in-flight
  // execution does NOT keep its provider — a concurrent setActiveProvider would switch a running
  // task mid-loop. The gap-b dispatch reconcile therefore only switches when no other execution is
  // in flight (bot-node-execution-handler activeExecutions guard); the PUT /api/llm-provider push
  // path is operator-initiated and expected to be quiescent.
  const builtProviders: Record<string, unknown> = {
    'claude-code': claudeCodeProvider,
    'openai-codex': codexProvider,
    'cline-cli': clineProvider,
  };
  const boot = resolveCurrentProvider({ clineProvider, claudeCodeProvider, codexProvider }, builtProviders, clineApiProviders);
  let activeProviderName: string = boot.provider;
  let activeApiProvider: string | null = boot.apiProvider;
  if (activeApiProvider) {
    // A boot pull that named a Cline-backed id: point Cline at it before the first spawn.
    clineBackingEnv.apply(activeApiProvider, process.env.FORCE_LLM_MODEL || undefined);
  }
  let activeModelName = resolveModelName(activeProviderName);

  const agenticController = new AgenticController(
    { bedrockProvider: null, clineProvider, claudeCodeProvider, codexProvider, getCurrentProvider: () => activeProviderName },
    toolRegistry, streamController,
  );
  const taskController = new TaskController(
    taskStore, messageStore, checkpointStore, agenticController, null, streamController, toolRegistry,
  );
  taskController.setLLMProvider(activeProviderName);

  const getActiveProvider = (): ActiveBotNodeProvider => ({
    provider: activeProviderName, model: activeModelName, apiProvider: activeApiProvider,
  });

  /**
   * ADR-034 push-down / local-change switch. Validates against the BUILT provider map
   * (the failover-wrapped instances actually driving executions) — an unknown name or a
   * known harness that failed to initialize at boot throws with NO state change. On a
   * valid switch it updates the TaskController toggle, overlays the env seeds through the
   * same applyPulledBotConfigToEnv path the boot pull uses (so resolveModelName,
   * CodexProvider env reads, and any future resolveCurrentProvider all agree), and
   * repoints the getCurrentProvider closure.
   */
  const setActiveProvider = (provider: string, model?: string): ActiveBotNodeProvider => {
    const requested = String(provider ?? '').trim();
    // A switch row's id: a runtime name/alias, or a Cline-backed API provider the cline-cli
    // runtime fronts (bot-node-provider-switch.ts). Unknown → refused by name, nothing switched.
    const target = resolveBotNodeSwitch(requested, builtProviders, clineApiProviders);
    if (!target) {
      throw new UnknownBotNodeProviderError(
        requested,
        Object.keys(builtProviders).filter((name) => Boolean(builtProviders[name])),
      );
    }
    const trimmedModel = typeof model === 'string' && model.trim().length > 0 ? model.trim() : undefined;
    // fallbackOrder null: a live provider switch changes the PROVIDER, never the administrator's
    // chain. Passing [] here would silently delete failover on every switch.
    applyPulledBotConfigToEnv({
      providerId: target.runtime, modelId: trimmedModel ?? null, fallbackOrder: null, configVersion: null,
    });
    const backingKeys = clineBackingEnv.apply(target.apiProvider, trimmedModel);
    taskController.setLLMProvider(target.runtime);
    activeProviderName = target.runtime;
    activeApiProvider = target.apiProvider;
    activeModelName = trimmedModel ?? resolveModelName(target.runtime);
    logger.info(
      { provider: activeProviderName, apiProvider: activeApiProvider, model: activeModelName, requested, backingKeys },
      'Bot-node active LLM provider switched (ADR-034)',
    );
    return getActiveProvider();
  };

  logger.info({ providerName: activeProviderName, modelName: activeModelName }, 'Any-bot LLM stack initialized');
  return {
    taskController: taskController as AnyBotTaskController,
    providerName: activeProviderName, modelName: activeModelName,
    getActiveProvider, setActiveProvider, agenticController,
    toolRegistry: toolRegistry as ReadOnlyToolRegistration,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** @description Constructs the Cline provider (the general harness — any model, any API). */
function initCline(config: unknown): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ClineCLIWrapper = require('../../any-bot/server/services/codebase/ClineCLIWrapper');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ClineProvider = require('../../any-bot/server/services/llm/ClineProvider');
    const wrapper = new ClineCLIWrapper(process.env.CLINE_CLI_PATH || 'cline', {
      // 60-min ceiling (operator directive 2026-07-24): cline output is batch, so
      // idle semantics can't apply — but the duration bound must not kill long,
      // actively-working runs. CLINE_TIMEOUT_MS overrides.
      timeout: parseInt(process.env.CLINE_TIMEOUT_MS || '3600000', 10),
      maxConcurrent: 5,
    });
    logger.info('ClineProvider initialized');
    return new ClineProvider(wrapper, config);
  } catch (err: unknown) {
    logger.warn({ err: (err as Error).message }, 'ClineProvider not available');
    return null;
  }
}

/** @description Constructs the Claude Code provider when a Claude login or API key is present. */
async function initClaudeCode(): Promise<any> {
  try {
    const fs = await import('fs');
    const path = await import('path');
    const hasAuth = process.env.ANTHROPIC_API_KEY || fs.existsSync(path.join(process.env.HOME || '/root', '.claude'));
    if (!hasAuth) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ClaudeCodeProvider = require('../../any-bot/server/services/llm/ClaudeCodeProvider');
    logger.info('ClaudeCodeProvider initialized');
    return new ClaudeCodeProvider({
      claudeCommand: process.env.CLAUDE_CODE_CLI_PATH || process.env.CLAUDE_CLI_PATH || 'claude',
    });
  } catch (err: unknown) {
    logger.warn({ err: (err as Error).message }, 'ClaudeCodeProvider not available');
    return null;
  }
}

/** @description Constructs the Codex provider when a ChatGPT login or OPENAI_API_KEY is present. */
async function initCodex(): Promise<any> {
  try {
    const fs = await import('fs');
    const hasCodexAuth = !!process.env.OPENAI_API_KEY || fs.existsSync('/root/.codex/auth.json');
    if (!hasCodexAuth) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const CodexProvider = require('../../any-bot/server/services/llm/CodexProvider');
    logger.info('CodexProvider initialized');
    return new CodexProvider({
      model: process.env.CODEX_MODEL || 'gpt-5.5',
      codexCommand: process.env.CODEX_CLI_PATH || 'codex',
      sandboxMode: process.env.CODEX_SANDBOX_MODE || 'read-only',
      timeoutMs: parseInt(process.env.CODEX_INACTIVITY_TIMEOUT_MS || process.env.CODEX_TIMEOUT_MS || '600000', 10),
    });
  } catch (err: unknown) {
    logger.warn({ err: (err as Error).message }, 'CodexProvider not available');
    return null;
  }
}

/**
 * @description Picks the active provider: FORCE_LLM_PROVIDER when it resolved (a runtime name, or a
 * Cline-backed API provider id the boot pull applied from a switch row), else first available.
 */
function resolveCurrentProvider(
  p: { clineProvider: any; claudeCodeProvider: any; codexProvider: any },
  built: Record<string, unknown>,
  clineApiProviders: readonly string[],
): { provider: string; apiProvider: string | null } {
  const forced = process.env.FORCE_LLM_PROVIDER || '';
  if ((forced === 'openai-codex' || forced === 'codex-cli') && p.codexProvider) return { provider: 'openai-codex', apiProvider: null };
  if (forced === 'claude-code' && p.claudeCodeProvider) return { provider: 'claude-code', apiProvider: null };
  // A switch row's Cline-backed id (gemini, anthropic, ...) reaches boot through the pulled record.
  const switched = forced ? resolveBotNodeSwitch(forced, built, clineApiProviders) : null;
  if (switched?.apiProvider) return { provider: switched.runtime, apiProvider: switched.apiProvider };
  // Unforced order follows the fleet default (ADR-128; claude-code dropped as a default rung
  // 2026-08-13). Codex leads: a bot node with no FORCE_LLM_PROVIDER must not silently pick a
  // Claude subscription that is being cancelled just because that provider constructed first.
  if (p.codexProvider) return { provider: 'openai-codex', apiProvider: null };
  if (p.clineProvider) return { provider: 'cline-cli', apiProvider: null };
  if (p.claudeCodeProvider) return { provider: 'claude-code', apiProvider: null };
  return { provider: 'cline-cli', apiProvider: null };
}

/** @description Resolves the model name for cost attribution and prompt-assembly decisions. */
function resolveModelName(currentProvider: string): string {
  if (currentProvider === 'claude-code') return process.env.CLAUDE_CODE_MODEL || 'claude-sonnet-4-6';
  if (currentProvider === 'openai-codex') return process.env.CODEX_MODEL || 'gpt-5.5';
  return process.env.FORCE_LLM_MODEL || process.env.LLM_MODEL || 'default';
}

/**
 * @description A fallback rung that runs on the cline-cli runtime while fronting a specific
 * Cline-backed API provider, so a chain like "claude-code, openrouter, anthropic" reaches three
 * distinct vendors instead of collapsing onto whichever backing happened to be set.
 *
 * The backing must travel through the environment because `ClineCLIWrapper._resolveBackingProvider`
 * reads `CLINE_API_PROVIDER` at spawn time (precedence 1) and accepts no per-call override. The
 * value is therefore applied immediately before delegating and restored in a `finally` — restored
 * to what was there on entry, NOT to the container seeds, so an active primary that is itself
 * Cline-backed keeps its own backing when a rung returns.
 *
 * `CLINE_API_MODEL` is CLEARED rather than carried: `fallback_order` stores provider ids only, so
 * there is no per-rung model, and passing the primary vendor's model id to a different vendor
 * would fail on a wrong-model error that looks nothing like the failover it actually is.
 *
 * Concurrency: this mutates process env around an await, exactly as the primary switch path
 * already does (`clineBackingEnv.apply`). Two dispatches executing concurrently on one node share
 * that env; the bot-node guards concurrent switches with `activeExecutions`, and the same
 * constraint applies here.
 * @param runtime - The cline-cli runtime instance this rung executes on.
 * @param apiProvider - The catalog provider id this rung fronts.
 * @param env - Environment to mutate (process.env in production; a plain object in tests).
 * @returns A provider-shaped object delegating every other member to the runtime.
 */
export function createClineBackedRungProvider(
  runtime: any,
  apiProvider: string,
  env: NodeJS.ProcessEnv = process.env,
): any {
  const generateResponse = async (messages: unknown, options: unknown = {}): Promise<unknown> => {
    const priorProvider = env.CLINE_API_PROVIDER;
    const priorModel = env.CLINE_API_MODEL;
    env.CLINE_API_PROVIDER = apiProvider;
    delete env.CLINE_API_MODEL;
    try {
      return await runtime.generateResponse(messages, options);
    } finally {
      if (priorProvider === undefined) delete env.CLINE_API_PROVIDER;
      else env.CLINE_API_PROVIDER = priorProvider;
      if (priorModel === undefined) delete env.CLINE_API_MODEL;
      else env.CLINE_API_MODEL = priorModel;
    }
  };
  return new Proxy(runtime, {
    get(target: any, prop: string | symbol) {
      if (prop === 'generateResponse') return generateResponse;
      if (prop === 'oshalRungApiProvider') return apiProvider;
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * @description Wraps a provider so a runtime stall/failure fails over to a sibling provider.
 * @returns The wrapped provider, or the original when no usable fallback is configured.
 */
export function maybeWrapBotNodeProviderFailover(
  primaryProvider: any,
  primaryName: string,
  providers: Record<string, any>,
  chain?: readonly string[],
  deps: { clineApiProviders?: readonly string[]; env?: NodeJS.ProcessEnv } = {},
): any {
  if (!primaryProvider) return primaryProvider;
  const order = (chain ?? resolveBotNodeProviderFallbackOrder(primaryName, deps.env)).filter(Boolean);
  if (order.length === 0) return primaryProvider;
  const clineApiProviders = deps.clineApiProviders ?? [];

  // Walk the WHOLE administrator-defined order and keep every rung that can execute here, so a
  // chain of four is a chain of four. The previous implementation took one name and stopped, which
  // is why an exhausted vendor could strand the fleet: its single named backup was exhausted too.
  //
  // A rung is resolved through the SAME translator the primary uses (resolveBotNodeSwitch), not by
  // indexing the three-key runtime map. Indexing was why a chain an administrator wrote as
  // "claude-code, openrouter, anthropic" - accepted by the api, stored, rendered in the cockpit,
  // carried on the boot pull - realized here as a single rung: every id that is not a native
  // runtime name fell into `unavailable` and became one log line nothing surfaced.
  const rungs: Array<{ name: string; provider: any }> = [];
  const unavailable: string[] = [];
  const seen = new Set<string>();
  const primaryTarget = resolveBotNodeSwitch(primaryName, providers, clineApiProviders);
  const targetKey = (target: { runtime: string; apiProvider: string | null }): string =>
    `${target.runtime}|${target.apiProvider ?? ''}`;
  if (primaryTarget) seen.add(targetKey(primaryTarget));
  for (const configured of order) {
    const requested = String(configured).trim();
    const target = requested ? resolveBotNodeSwitch(requested, providers, clineApiProviders) : null;
    if (!target) {
      if (requested) unavailable.push(requested.toLowerCase());
      continue;
    }
    // Two Cline-backed rungs share the runtime key and must stay distinct - deduping on the
    // runtime alone silently discarded the second vendor in the administrator's order.
    const key = targetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    const runtime = providers[target.runtime];
    if (!runtime) { unavailable.push(requested.toLowerCase()); continue; }
    rungs.push({
      name: target.apiProvider ?? target.runtime,
      provider: target.apiProvider
        ? createClineBackedRungProvider(runtime, target.apiProvider, deps.env)
        : runtime,
    });
  }
  if (unavailable.length > 0) {
    logger.warn(
      { primaryProvider: primaryName, unavailable },
      'Configured fallback providers have no initialized runtime on this node and were skipped',
    );
  }
  if (rungs.length === 0) {
    logger.warn(
      { primaryProvider: primaryName, configured: order },
      'Provider fallback is configured but no configured provider has an initialized runtime here',
    );
    return primaryProvider;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ProviderFailoverProvider } = require('../../any-bot/server/services/llm/ProviderFailoverProvider');
    // Fold right: each rung becomes the fallback of the one before it, so an N-provider chain is
    // N-1 nested wrappers and a failure walks the order the administrator wrote.
    let wrapped = rungs[rungs.length - 1].provider;
    let wrappedName = rungs[rungs.length - 1].name;
    for (let i = rungs.length - 2; i >= 0; i -= 1) {
      wrapped = new ProviderFailoverProvider({
        primary: rungs[i].provider, fallback: wrapped,
        primaryName: rungs[i].name, fallbackName: wrappedName, reason: 'provider_runtime_failure',
      });
      wrappedName = rungs[i].name;
    }
    logger.info(
      { primaryProvider: primaryName, fallbackChain: rungs.map((r) => r.name) },
      'Bot-node provider runtime fallback enabled',
    );
    return new ProviderFailoverProvider({
      primary: primaryProvider, fallback: wrapped,
      primaryName, fallbackName: rungs[0].name, reason: 'provider_runtime_failure',
    });
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Failed to initialize bot-node provider runtime fallback');
    return primaryProvider;
  }
}

/**
 * @description Resolves the ordered fallback chain for a primary provider FROM CONFIGURATION.
 *
 * No fallback POLICY is named in this file, and none may be. The three RUNTIME KEYS this node
 * builds are named here (claude-code, openai-codex, cline-cli) - they have to be, they are what
 * the node constructs - and the earlier wording of this line said "no provider is named in this
 * file", which was literally false about its own module. The rule that matters is narrower and
 * is the one that was actually broken: no code decides who falls back to whom. The order is
 * whatever an administrator wrote — any number of providers, any order — supplied by the boot pull as
 * `OSHAL_PROVIDER_FALLBACK_ORDER` from the `fallback_order` column of this bot's switch row or the
 * fleet-default row (migration 148), resolved by `resolveProviderFallbackChain`. The legacy
 * single-name variables remain readable so an existing deployment keeps working.
 *
 * What this replaced, and why: a `Record` literal mapping three hardcoded provider names to their
 * hardcoded successors. A provider outside those three could not be a fallback at all, the order
 * could not be changed by any setting, and one vendor's exclusion was encoded as a missing array
 * entry. When that chain's only remaining name ran out of tokens there was nothing an
 * administrator could change to recover — the fix required editing and redeploying code.
 *
 * @param primaryName - The provider being wrapped.
 * @param env - Environment to read (injectable so a guard can establish "unconfigured" exactly,
 *   rather than inheriting whatever five variables the ambient shell happens to carry).
 * @returns Provider ids to try, in order. Empty means no failover, which is a valid answer.
 */
export function resolveBotNodeProviderFallbackOrder(
  primaryName: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  // Truthiness, NOT `??`: compose defines OSHAL_PROVIDER_FALLBACK_ORDER as an EMPTY STRING on
  // every bot, and `??` does not fall through on '' - so the new key at the head of the chain
  // permanently shadowed all four legacy variables and silently disabled a working configuration.
  const rawOrder = [
    env.OSHAL_PROVIDER_FALLBACK_ORDER,
    env.OSHAL_PROVIDER_RUNTIME_FALLBACK_PROVIDER,
    env.CLAUDE_CODE_STALL_FALLBACK_PROVIDER,
    env.OSHAL_PROVIDER_STALL_FALLBACK_PROVIDER,
    env.OSHAL_PROVIDER_STALL_FALLBACK,
  ].find((value) => typeof value === 'string' && value.trim() !== '') ?? '';
  const parsed = String(rawOrder).split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
  const isOff = (value: string): boolean => ['none', 'off', 'false'].includes(value.toLowerCase());

  // The node-local kill switch, consulted BEFORE the configured order and not after it. Read
  // after, as it was, it could never fire: a configured order had already returned, and an
  // unconfigured node returns the same [] either way - so the variable was inert in both arms
  // while .env.example described it as disabling failover "whatever is configured above" and
  // compose passed it to every bot. It now means what that line says.
  const autoFailover = String(env.OSHAL_PROVIDER_AUTO_FAILOVER ?? 'true').trim().toLowerCase();
  if (isOff(autoFailover)) {
    if (parsed.length > 0) {
      logger.warn(
        { primaryName, configured: parsed },
        'A provider fallback order is configured but OSHAL_PROVIDER_AUTO_FAILOVER is off on this node; no failover will run here.',
      );
    }
    return [];
  }

  if (parsed.length > 0) {
    if (parsed.length === 1 && isOff(parsed[0])) return [];
    const order = parsed
      .map((entry) => normalizeProviderName(entry))
      .filter((entry) => entry !== normalizeProviderName(primaryName));
    if (order.length !== parsed.length) {
      logger.warn({ primaryName, configured: parsed }, 'Dropped the primary provider from its own fallback order');
    }
    return order;
  }

  // Nothing configured. With no order to walk the honest answer is "no fallback", not a chain
  // this file invented.
  logger.info(
    { primaryName },
    'No provider fallback order is configured for this node; a failover-eligible failure will surface instead of switching provider. Set the fleet-default row\'s fallback_order (or OSHAL_PROVIDER_FALLBACK_ORDER) to define one.',
  );
  return [];
}

/** @description Normalizes legacy provider aliases (`codex-cli` → `openai-codex`, `cline` → `cline-cli`). */
export function normalizeProviderName(value: string): 'claude-code' | 'openai-codex' | 'cline-cli' | string {
  if (value === 'codex-cli') return 'openai-codex';
  if (value === 'cline') return 'cline-cli';
  return value;
}
