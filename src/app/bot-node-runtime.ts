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
 */

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

import { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { gucEnabled, wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import type { MeshEnvelope } from '@/features/agent-management';
import { PersonaLayerStore } from '@/features/agent-management';
import { RALFHandoverManager, type EnvelopeExecutionResult } from '@/features/swarm-orchestration';
import { SwarmBotRegistry } from '@/app/extensions/swarm/swarm-bot-registry';
import { AgentProfileRepository } from '@/entities/agent';
import { WorkItemRepository } from '@/entities/work-item';
import { TicketService, PostgresTicketStore } from '@/features/ticketing';
import { CostTrackingService } from '@/features/operational-intelligence';
import { createBotNodeExecutionHandler } from './bot-node-execution-handler';
import { applyPulledBotConfigToEnv, runBootConfigBootstrap } from './bot-node-config-bootstrap';
import { UnknownBotNodeProviderError, type ActiveBotNodeProvider } from './bot-node-llm-provider-route';

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
 * @returns The constructed runtime. Degrades gracefully to a DB-less runtime when Postgres
 *   never answers (repositories are then undefined; cost capture becomes a no-op).
 */
export async function createBotNodeRuntime(): Promise<BotNodeRuntime> {
  const runtimeIdentity = SwarmBotRegistry.resolveRuntimeIdentity(process.env);
  const agentId = runtimeIdentity.agentId;
  const botName = runtimeIdentity.agentName;
  logger.info({ agentId, botName, role: runtimeIdentity.role }, 'Resolved runtime identity');

  const pool = await connectPool();

  const agentProfileRepository = pool ? new AgentProfileRepository(pool) : undefined;
  const personaLayerStore = pool ? new PersonaLayerStore(pool) : undefined;
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
  } = await buildLlmStack();

  const executionHandler = createBotNodeExecutionHandler({
    anyBotTaskController: taskController,
    agentProfileRepository,
    personaLayerStore,
    handoverManager: new RALFHandoverManager(),
    recordCost: (event: Parameters<typeof costTrackingService.recordCost>[0]) => costTrackingService.recordCost(event),
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
    pool, agentProfileRepository, personaLayerStore, workItemRepository,
    costTrackingService, ticketService, executionHandler, providerName, modelName,
    getActiveProvider, setActiveProvider, agenticController,
  };
}

/**
 * @description Connects Postgres with cold-start retries and wraps the pool with the RLS GUC
 * stamper. Bots have no request identity, so the wrapper stamps trusted system context —
 * without it they'd be starved to zero rows under restrictive RLS.
 * @returns The pool, or null when the DB never answered (the bot still runs, DB-less).
 */
export async function connectPool(): Promise<Pool | null> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;

  let pool: Pool | null = new Pool({ connectionString: dbUrl, max: 5 });
  const maxAttempts = Math.max(1, Number(process.env.BOT_DB_CONNECT_ATTEMPTS ?? 10));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query('SELECT 1');
      if (gucEnabled()) pool = wrapPoolWithGuc(pool);
      logger.info('Postgres connected');
      return pool;
    } catch (err) {
      if (attempt === maxAttempts) {
        logger.warn({ err, attempts: maxAttempts }, 'Postgres not available after retries — running without DB');
        try { await pool.end(); } catch { /* failed pool — ignore cleanup error */ }
        return null;
      }
      logger.info({ attempt, maxAttempts }, 'Postgres not ready — retrying in 2s');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  return null;
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
  claudeCodeProvider = maybeWrapBotNodeProviderFailover(claudeCodeProvider, 'claude-code', baseProviderMap);
  codexProvider = maybeWrapBotNodeProviderFailover(codexProvider, 'openai-codex', baseProviderMap);
  clineProvider = maybeWrapBotNodeProviderFailover(clineProvider, 'cline-cli', baseProviderMap);

  // ADR-034 mutable seam: the AgenticController's getCurrentProvider closes over these
  // `let`s, so setActiveProvider changes take effect on the NEXT provider resolution.
  // CAUTION: the AgenticController resolves the provider LIVE on every turn, so an in-flight
  // execution does NOT keep its provider — a concurrent setActiveProvider would switch a running
  // task mid-loop. The gap-b dispatch reconcile therefore only switches when no other execution is
  // in flight (bot-node-execution-handler activeExecutions guard); the PUT /api/llm-provider push
  // path is operator-initiated and expected to be quiescent.
  let activeProviderName = resolveCurrentProvider({ clineProvider, claudeCodeProvider, codexProvider });
  let activeModelName = resolveModelName(activeProviderName);

  const agenticController = new AgenticController(
    { bedrockProvider: null, clineProvider, claudeCodeProvider, codexProvider, getCurrentProvider: () => activeProviderName },
    toolRegistry, streamController,
  );
  const taskController = new TaskController(
    taskStore, messageStore, checkpointStore, agenticController, null, streamController, toolRegistry,
  );
  taskController.setLLMProvider(activeProviderName);

  const getActiveProvider = (): ActiveBotNodeProvider => ({ provider: activeProviderName, model: activeModelName });

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
    const normalized = normalizeProviderName(requested) as 'claude-code' | 'openai-codex' | 'cline-cli' | string;
    const builtProviders: Record<string, unknown> = {
      'claude-code': claudeCodeProvider,
      'openai-codex': codexProvider,
      'cline-cli': clineProvider,
    };
    if (!(normalized in builtProviders) || !builtProviders[normalized]) {
      throw new UnknownBotNodeProviderError(
        requested,
        Object.keys(builtProviders).filter((name) => Boolean(builtProviders[name])),
      );
    }
    const trimmedModel = typeof model === 'string' && model.trim().length > 0 ? model.trim() : undefined;
    applyPulledBotConfigToEnv({ providerId: normalized, modelId: trimmedModel ?? null, configVersion: null });
    taskController.setLLMProvider(normalized);
    activeProviderName = normalized;
    activeModelName = trimmedModel ?? resolveModelName(normalized);
    logger.info(
      { provider: activeProviderName, model: activeModelName },
      'Bot-node active LLM provider switched (ADR-034)',
    );
    return getActiveProvider();
  };

  logger.info({ providerName: activeProviderName, modelName: activeModelName }, 'Any-bot LLM stack initialized');
  return {
    taskController: taskController as AnyBotTaskController,
    providerName: activeProviderName, modelName: activeModelName,
    getActiveProvider, setActiveProvider, agenticController,
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

/** @description Picks the active provider: FORCE_LLM_PROVIDER when it resolved, else first available. */
function resolveCurrentProvider(p: { clineProvider: any; claudeCodeProvider: any; codexProvider: any }): string {
  const forced = process.env.FORCE_LLM_PROVIDER || '';
  if ((forced === 'openai-codex' || forced === 'codex-cli') && p.codexProvider) return 'openai-codex';
  if (forced === 'claude-code' && p.claudeCodeProvider) return 'claude-code';
  if (p.clineProvider) return 'cline-cli';
  if (p.claudeCodeProvider) return 'claude-code';
  if (p.codexProvider) return 'openai-codex';
  return 'cline-cli';
}

/** @description Resolves the model name for cost attribution and prompt-assembly decisions. */
function resolveModelName(currentProvider: string): string {
  if (currentProvider === 'claude-code') return process.env.CLAUDE_CODE_MODEL || 'claude-sonnet-4-6';
  if (currentProvider === 'openai-codex') return process.env.CODEX_MODEL || 'gpt-5.5';
  return process.env.FORCE_LLM_MODEL || process.env.LLM_MODEL || 'default';
}

/**
 * @description Wraps a provider so a runtime stall/failure fails over to a sibling provider.
 * @returns The wrapped provider, or the original when no usable fallback is configured.
 */
export function maybeWrapBotNodeProviderFailover(
  primaryProvider: any,
  primaryName: 'claude-code' | 'openai-codex' | 'cline-cli',
  providers: Record<'claude-code' | 'openai-codex' | 'cline-cli', any>,
): any {
  if (!primaryProvider) return primaryProvider;
  const fallbackName = resolveBotNodeProviderStallFallbackName(primaryName, providers);
  if (!fallbackName) return primaryProvider;

  let fallbackProvider: any = null;
  let resolvedFallbackName = fallbackName;
  if (fallbackName === 'codex-cli' || fallbackName === 'openai-codex') {
    fallbackProvider = providers['openai-codex'];
    resolvedFallbackName = 'openai-codex';
  } else if (fallbackName === 'cline-cli' || fallbackName === 'cline') {
    fallbackProvider = providers['cline-cli'];
    resolvedFallbackName = 'cline-cli';
  } else if (fallbackName === 'claude-code') {
    fallbackProvider = providers['claude-code'];
    resolvedFallbackName = 'claude-code';
  }

  if (!fallbackProvider) {
    logger.warn({ fallbackName }, 'Bot-node provider stall fallback requested but no initialized fallback provider is available');
    return primaryProvider;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ProviderFailoverProvider } = require('../../any-bot/server/services/llm/ProviderFailoverProvider');
    logger.info({ primaryProvider: primaryName, fallbackProvider: resolvedFallbackName }, 'Bot-node provider runtime fallback enabled');
    return new ProviderFailoverProvider({
      primary: primaryProvider, fallback: fallbackProvider,
      primaryName, fallbackName: resolvedFallbackName, reason: 'provider_runtime_failure',
    });
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Failed to initialize bot-node provider runtime fallback');
    return primaryProvider;
  }
}

/** @description Resolves which provider a stalled primary should fail over to (explicit env, else auto-order). */
function resolveBotNodeProviderStallFallbackName(
  primaryName: 'claude-code' | 'openai-codex' | 'cline-cli',
  providers: Record<'claude-code' | 'openai-codex' | 'cline-cli', any>,
): string | null {
  const raw = process.env.OSHAL_PROVIDER_RUNTIME_FALLBACK_PROVIDER
    ?? process.env.CLAUDE_CODE_STALL_FALLBACK_PROVIDER
    ?? process.env.OSHAL_PROVIDER_STALL_FALLBACK_PROVIDER
    ?? process.env.OSHAL_PROVIDER_STALL_FALLBACK
    ?? '';
  const normalized = raw.trim().toLowerCase();
  if (normalized && normalized !== 'none' && normalized !== 'off' && normalized !== 'false') {
    if (normalizeProviderName(normalized) === primaryName) {
      logger.warn({ primaryName, fallbackName: normalized }, 'Ignoring recursive bot-node provider runtime fallback');
      return null;
    }
    return normalized;
  }

  const autoFailover = String(process.env.OSHAL_PROVIDER_AUTO_FAILOVER ?? 'true').trim().toLowerCase();
  if (autoFailover === 'false' || autoFailover === 'off' || autoFailover === 'none') return null;

  const fallbackOrder: Record<typeof primaryName, Array<'claude-code' | 'openai-codex' | 'cline-cli'>> = {
    'openai-codex': ['claude-code', 'cline-cli'],
    'claude-code': ['openai-codex', 'cline-cli'],
    'cline-cli': ['claude-code', 'openai-codex'],
  };
  return fallbackOrder[primaryName].find((name) => Boolean(providers[name])) ?? null;
}

/** @description Normalizes legacy provider aliases (`codex-cli` → `openai-codex`, `cline` → `cline-cli`). */
export function normalizeProviderName(value: string): 'claude-code' | 'openai-codex' | 'cline-cli' | string {
  if (value === 'codex-cli') return 'openai-codex';
  if (value === 'cline') return 'cline-cli';
  return value;
}
