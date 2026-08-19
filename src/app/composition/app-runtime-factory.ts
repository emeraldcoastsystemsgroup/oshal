/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted app runtime factory helpers from the oversized composition root
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Extended default chat-agent bootstrap metadata with selector-skill text and theme preference for dedicated profile persistence fallback
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Phase 4: Accept ticketService and workspaceService in createOrchestrator for ticket→task linking and workspace resolution
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Phase 12 S2: Wire persona authorization seeding into startup chain after baseline tool seed
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Track B S6: Create and seed DynamicToolExecutorRegistry in tool framework factory
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Pool connectionTimeoutMillis 2000→10000 — 2s connect timeout cascaded into manifest auto-load failures during full-stack cold start (20 containers racing Postgres)
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Register db-pool shutdown hook so SIGTERM/SIGINT close PG connections (2026-07-05 leak audit)
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | waitForBootstrapComplete(): awaitable (bounded) companion to isBootstrapComplete so boot consumers (swarm-app autoload, queue-manager start) can gate on migration completion instead of racing it — on a clean DB the first autoload pass ran before migration 022 created swarm_applications, logging ~40 self-healing ERROR lines (BACKLOG "Noisy first-boot logs")
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Thread the pool into ConnectorMarketplaceService so its per-user enablement OVERRIDE layer (BACKLOG.md:2718) can persist/read per-user connector on/off; deployment-global catalog + state stay file-based.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Wrapped the initializeToolRegistry bootstrap chain (migrations → tool-executor restore → baseline+connector-spec tool seed → default chat agent → persona authorizations) in runWithSystemIdentity. The detached boot chain ran with no request in scope; under OSHAL_DB_GUC_STRICT=deny that would scope its seed reads/writes anonymous (RLS zero-rows). Covered ~10 of the guc warn-audit's identity-less boot sites.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Make the primary API Postgres pool ceiling deployment-configurable and stamp application_name so a 47-backend managed cluster can be budgeted and audited without changing the existing local default.
 */

import path from 'path';
import { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { gucEnabled, wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { wrapPoolWithRuntimeDdlGuard } from '@/shared/services/database/schema-bootstrap-policy';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { postgresApplicationName, resolvePoolMax } from '@/shared/services/database/pool-sizing';
import { ToolExecutorService, TaskOrchestrator, type TaskOrchestratorDeps } from '@/features/chat-orchestration';
// eslint-disable-next-line no-restricted-imports -- two-runtimes: LLM execution runtime, deliberately off the barrel graph (barrel split, TODO-BOUNDARY-FINDING)
import { ClineRuntimeConfigSyncService } from '@/features/llm-provider/services';
import {
  DatabaseBootstrapService,
  ToolRegistryService,
  ToolController,
  DynamicToolExecutorRegistry,
  RuntimeToolRegistrationService,
} from '@/features/tool-registry';
import { AgentToolRepository, ToolRepository } from '@/entities/tool';
import { SwitchFrameworkService, AgentToolController, seedPersonaAuthorizations } from '@/features/tool-switch';
import { SelectorCompositionService } from '@/features/selector-composition';
import { ToolVerificationService, VerificationController, VerificationScheduler } from '@/features/tool-verification';
import { ApprovalWorkflowService, ToolAuthInterceptor } from '@/features/tool-approval';
import { readJsonConfig, readChatAgentProfileConfig, parseSelectorSkills, readNonEmptyString, runtimeDefaults } from './provider-runtime';
import { ConnectorSpecToolService } from '@/app/connectors/runtime/spec-tools';
import { ConnectorMarketplaceService } from '@/app/connectors/runtime/marketplace';
import { registerShutdownHook } from '@/shared/services/shutdown-hooks';
import type { InMemoryTaskStore } from '@/entities/task';
import type { InMemoryMessageStore } from '@/entities/message';
import type { StreamManager } from '@/features/streaming';
import type { LLMService, LLMToolDefinition } from '@/features/llm-provider';
import type { MemoryLayerService } from '@/features/memory';
import type { TicketService, WorkspaceService } from '@/features/ticketing';
import type { AgentConfigService } from '@/features/agent-management';

const logger = createChildLogger({ module: 'app-runtime-factory' });

/**
 * @description Creates the primary database pool used by registry and verification services.
 * @returns Configured PostgreSQL pool.
 */
export function createDatabasePool(): Pool {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  const pool =
    connectionString && connectionString.trim().length > 0
      ? new Pool({
          connectionString: connectionString.trim(),
          max: resolvePoolMax(process.env.OSHAL_DB_POOL_MAX, 20),
          application_name: postgresApplicationName(process.env.PGAPPNAME, 'oshal-api-main'),
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
        })
      : new Pool({
          host: process.env.POSTGRES_HOST || 'localhost',
          port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
          database: process.env.POSTGRES_DB || 'oshal',
          user: process.env.POSTGRES_USER || 'oshal_user',
          password: process.env.POSTGRES_PASSWORD || 'oshal_password',
          max: resolvePoolMax(process.env.OSHAL_DB_POOL_MAX, 20),
          application_name: postgresApplicationName(process.env.PGAPPNAME, 'oshal-api-main'),
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
        });

  // RLS keystone: wrap by default so every query/connect stamps the caller identity
  // (oshal.current_sub/is_operator) for row-level security. OSHAL_DB_GUC=off is
  // break-glass rollback. See docs/governance/RLS-RUNBOOK.md.
  const scopedPool = gucEnabled() ? wrapPoolWithGuc(pool) : pool;

  // Close the pool on SIGTERM/SIGINT — the controller previously exited without
  // releasing PG connections (2026-07-05 leak audit; bot-node-server already did this).
  registerShutdownHook('db-pool', () => pool.end());
  return wrapPoolWithRuntimeDdlGuard(scopedPool);
}

/**
 * @description Creates the chat task orchestrator with the runtime tool executor.
 * @param taskStore - Task persistence service.
 * @param messageStore - Message persistence service.
 * @param streamManager - Stream manager.
 * @param getProvider - Dynamic provider resolver.
 * @param getTools - Runtime tool resolver.
 * @param getSystemPrompt - Runtime prompt resolver.
 * @returns Configured task orchestrator.
 */
export function createOrchestrator(
  taskStore: InMemoryTaskStore,
  messageStore: InMemoryMessageStore,
  streamManager: StreamManager,
  getProvider: () => LLMService,
  getTools: (agentId?: string) => Promise<LLMToolDefinition[]>,
  getSystemPrompt: (agentId?: string, tools?: LLMToolDefinition[]) => Promise<string>,
  memoryService?: MemoryLayerService,
  ticketService?: TicketService,
  workspaceService?: WorkspaceService,
  agentConfigService?: AgentConfigService,
  switchFrameworkService?: SwitchFrameworkService,
  dynamicToolExecutorRegistry?: DynamicToolExecutorRegistry,
  connectorSpecToolService?: ConnectorSpecToolService,
): TaskOrchestrator {
  const toolExecutor = new ToolExecutorService({
    streamManager,
    workspaceService,
    agentConfigService,
    dynamicToolExecutorRegistry,
    connectorToolExecutor: connectorSpecToolService,
  });
  const toolAuthInterceptor = switchFrameworkService
    ? new ToolAuthInterceptor({
        approvalService: new ApprovalWorkflowService({ streamManager }),
        lookupAuthMode: async (agentId, toolName) => {
          const agentTools = await switchFrameworkService.getAgentTools(agentId);
          const match = agentTools.find((entry) => entry.tool?.name === toolName);
          return match ? { authMode: match.authMode, tool: match.tool } : null;
        },
      })
    : undefined;
  const deps: TaskOrchestratorDeps = {
    taskStore,
    messageStore,
    streamManager,
    getProvider,
    getTools,
    executeTool: (toolName, toolInput, context) => toolExecutor.executeTool(
      context?.taskId ?? 'taskless',
      toolName,
      toolInput,
      context?.agentId,
      context?.userSub,
    ),
    getSystemPrompt,
    toolAuthInterceptor,
    memoryService,
    ticketService,
  };
  return new TaskOrchestrator(deps);
}

/**
 * @description Creates the tool-registry, switch-framework, and selector-composition services/controllers.
 * @param pool - Shared database pool.
 * @returns Tool framework wiring.
 */
export function createToolFramework(pool: Pool): {
  toolController: ToolController;
  agentToolController: AgentToolController;
  toolRegistryService: ToolRegistryService;
  dynamicToolExecutorRegistry: DynamicToolExecutorRegistry;
  runtimeToolRegistrationService: RuntimeToolRegistrationService;
  connectorMarketplaceService: ConnectorMarketplaceService;
  connectorSpecToolService: ConnectorSpecToolService;
  switchFrameworkService: SwitchFrameworkService;
  selectorCompositionService: SelectorCompositionService;
} {
  const toolRepository = new ToolRepository(pool);
  const agentToolRepository = new AgentToolRepository(pool);
  const toolRegistryService = new ToolRegistryService(toolRepository, logger);
  const switchFrameworkService = new SwitchFrameworkService(agentToolRepository, toolRepository, logger);
  const selectorCompositionService = new SelectorCompositionService(agentToolRepository, pool, logger);
  const toolController = new ToolController(toolRegistryService, logger);
  const agentToolController = new AgentToolController(switchFrameworkService, selectorCompositionService, logger);

  const dynamicToolExecutorRegistry = new DynamicToolExecutorRegistry();
  dynamicToolExecutorRegistry.seedBuiltinDescriptors();
  const runtimeToolRegistrationService = new RuntimeToolRegistrationService(
    pool,
    toolRegistryService,
    dynamicToolExecutorRegistry,
  );
  // Thread the pool so the marketplace service can back its per-user enablement OVERRIDE layer
  // (enableProviderForUser / isEnabledForUser). The deployment-global catalog + state stay file-based.
  const connectorMarketplaceService = new ConnectorMarketplaceService({ pool });
  const connectorSpecToolService = new ConnectorSpecToolService({
    pool,
    providerGate: connectorMarketplaceService,
  });

  return {
    toolController,
    agentToolController,
    toolRegistryService,
    dynamicToolExecutorRegistry,
    runtimeToolRegistrationService,
    connectorMarketplaceService,
    connectorSpecToolService,
    switchFrameworkService,
    selectorCompositionService,
  };
}

/**
 * @description Creates the tool verification controller and optional scheduler.
 * @param pool - Shared database pool.
 * @param compositionLogger - Scoped logger.
 * @returns Verification wiring.
 */
export function createVerificationComponents(
  pool: Pool,
  compositionLogger: ReturnType<typeof createChildLogger>,
): { verificationController: VerificationController; verificationScheduler: VerificationScheduler } {
  const verificationService = new ToolVerificationService(pool);
  const verificationInterval = parseInt(process.env.VERIFICATION_INTERVAL_MS || '3600000', 10);
  const verificationScheduler = new VerificationScheduler(verificationService, verificationInterval);
  const verificationController = new VerificationController(verificationService, verificationScheduler);

  if (process.env.ENABLE_VERIFICATION_SCHEDULER === 'true') {
    verificationScheduler.start(true);
    compositionLogger.info('Verification scheduler started');
  }

  return { verificationController, verificationScheduler };
}

/**
 * @description Applies migrations, seeds baseline tools, and ensures the default standalone chat agent exists.
 * @param pool - Shared database pool.
 * @param toolRegistryService - Tool registry service.
 * @param compositionLogger - Scoped logger.
 * @param defaults - Default chat-agent identifiers.
 * @returns Void after background bootstrap is scheduled.
 */
/** Tracks whether DB bootstrap (migrations + seeding) has completed successfully. */
let _bootstrapComplete = false;

/** Callers parked in waitForBootstrapComplete(), flushed when bootstrap settles. */
let _bootstrapWaiters: Array<(ready: boolean) => void> = [];

/** Returns true once migrations and tool seeding have finished. Used by /health to gate readiness. */
export function isBootstrapComplete(): boolean {
  return _bootstrapComplete;
}

/**
 * @description Resolves once the DB bootstrap chain (migrations + seeding) has settled, so
 * boot-time consumers that query migration-created tables (swarm-app autoload, the queue
 * manager's crash-recovery sweep) can gate on it instead of racing it and logging
 * self-healing "relation does not exist" ERRORs on a clean database. Bounded: resolves
 * `false` after `timeoutMs` (or on a failed bootstrap) so a broken bootstrap never
 * deadlocks boot — callers proceed and the underlying retries still self-heal.
 * @param timeoutMs - maximum wait before resolving false (default 90s, covers a cold-start migration pass)
 * @returns true when bootstrap completed, false on timeout/failure
 */
export function waitForBootstrapComplete(timeoutMs = 90_000): Promise<boolean> {
  if (_bootstrapComplete) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    _bootstrapWaiters.push((ready) => { clearTimeout(timer); resolve(ready); });
  });
}

/** Settle the bootstrap state and release every parked waiter. */
function settleBootstrap(ready: boolean): void {
  if (ready) _bootstrapComplete = true;
  const waiters = _bootstrapWaiters;
  _bootstrapWaiters = [];
  for (const release of waiters) release(ready);
}

/**
 * @description Runs the database bootstrap chain in the background: applies migrations, restores runtime tool executors, seeds baseline agent tools, ensures the default chat agent, and seeds persona authorizations, then marks bootstrap complete. Failures are logged without throwing.
 * @param pool - Shared database pool.
 * @param toolRegistryService - Tool registry service used to seed baseline agent tools.
 * @param compositionLogger - Scoped logger for bootstrap progress reporting.
 * @param defaults - Default chat-agent identifiers (agentId and agentName).
 * @param runtimeToolRegistrationService - Optional service used to restore previously registered runtime tool executors.
 * @returns Void; the bootstrap work is scheduled asynchronously.
 */
export function initializeToolRegistry(
  pool: Pool,
  toolRegistryService: ToolRegistryService,
  compositionLogger: ReturnType<typeof createChildLogger>,
  defaults: { agentId: string; agentName: string },
  runtimeToolRegistrationService?: RuntimeToolRegistrationService,
  connectorSpecToolService?: ConnectorSpecToolService,
  dynamicToolExecutorRegistry?: DynamicToolExecutorRegistry,
): void {
  const bootstrapService = new DatabaseBootstrapService(pool);
  const runtimeSyncService = new ClineRuntimeConfigSyncService();

  // Boot bootstrap chain runs with NO request in scope. Mark it trusted SYSTEM so every step
  // (migrations, tool-executor restore, baseline+connector-spec tool seed, default chat agent,
  // persona authorizations) stamps operator on purpose — under OSHAL_DB_GUC_STRICT=deny an
  // identity-less connection is scoped anonymous (RLS zero-rows), which would silently starve
  // the seed reads/writes. runWithSystemIdentity propagates through the whole .then() chain.
  void runWithSystemIdentity(() => bootstrapService.applyMigrations()
    .then((migrations) => {
      compositionLogger.info({ migrations }, 'Tool registry SQL migrations applied');
      return runtimeToolRegistrationService?.restoreRuntimeExecutors() ?? Promise.resolve([]);
    })
    .then((runtimeExecutors) => {
      compositionLogger.info({ count: runtimeExecutors.length }, 'Runtime tool executors restored');
      return toolRegistryService.seedBaselineAgentTools();
    })
    .then(async (tools) => {
      compositionLogger.info({ tools }, 'Baseline tools ensured in registry');
      if (connectorSpecToolService && dynamicToolExecutorRegistry) {
        const registrations = await connectorSpecToolService.registerConnectorSpecTools(
          toolRegistryService,
          dynamicToolExecutorRegistry,
        );
        compositionLogger.info(
          { count: registrations.length },
          'Connector spec tools ensured in registry',
        );
      }
      return ensureDefaultChatAgent(pool, runtimeSyncService, compositionLogger, defaults);
    })
    .then(() => {
      compositionLogger.info({ agentId: defaults.agentId }, 'Default chat agent ensured');
      return seedPersonaAuthorizations(pool, defaults.agentId);
    })
    .then((seededCount) => {
      compositionLogger.info({ agentId: defaults.agentId, seededCount }, 'Persona authorization seeding complete');
      settleBootstrap(true);
      compositionLogger.info('Bootstrap complete — /health will now return 200');
    })
    .catch((error) => {
      compositionLogger.error({ err: error }, 'Failed to initialize tool registry database');
      // Release gated boot consumers (autoload, queue manager) — they proceed and self-heal.
      settleBootstrap(false);
    }));
}

async function ensureDefaultChatAgent(
  pool: Pool,
  runtimeSyncService: ClineRuntimeConfigSyncService,
  compositionLogger: ReturnType<typeof createChildLogger>,
  defaults: { agentId: string; agentName: string },
): Promise<void> {
  const configDir = process.env.CONFIG_OUTPUT_DIR || './output';
  const settingsPath = path.join(configDir, 'global-config.json');
  const settings = readJsonConfig(settingsPath) ?? {};
  const selection = runtimeSyncService.readRuntimeSelection(runtimeDefaults.defaultModel);
  const profile = readChatAgentProfileConfig(settings, defaults.agentId, defaults.agentName);
  const selectorSkills = parseSelectorSkills(profile.selectorSkillsText);
  const persona = {
    systemPrompt: runtimeDefaults.level0SystemPrompt,
    role: 'standalone-chat',
    capabilities: selectorSkills,
    constraints: [],
    description: 'Default standalone chat agent used by the chat tools configuration UI.',
  };
  const metadata = {
    source: 'standalone-chat',
    projectUrl: profile.projectUrl ?? '',
    avatarUrl: profile.avatarUrl ?? '',
    selectorSkillsText: profile.selectorSkillsText ?? '',
    themePreference: readThemePreference(settings) ?? 'midnight',
  };

  await pool.query(
    `
      INSERT INTO agents (
        agent_id,
        name,
        status,
        api_provider_id,
        model_id,
        provider_overrides,
        persona,
        tools,
        metadata,
        base_capabilities,
        base_selector_descriptor,
        base_routing_keywords
      ) VALUES (
        $1,
        $2,
        'active',
        $3,
        $4,
        '{}'::jsonb,
        $5::jsonb,
        '{}'::uuid[],
        $6::jsonb,
        $7::text[],
        $8,
        $9::text[]
      )
      ON CONFLICT (agent_id)
      DO UPDATE SET
        name = EXCLUDED.name,
        api_provider_id = EXCLUDED.api_provider_id,
        model_id = EXCLUDED.model_id,
        persona = EXCLUDED.persona,
        metadata = EXCLUDED.metadata,
        base_capabilities = EXCLUDED.base_capabilities,
        base_selector_descriptor = EXCLUDED.base_selector_descriptor,
        base_routing_keywords = EXCLUDED.base_routing_keywords,
        updated_at = NOW()
    `,
    [
      defaults.agentId,
      profile.name,
      selection.provider,
      selection.model,
      JSON.stringify(persona),
      JSON.stringify(metadata),
      selectorSkills,
      profile.selectorSkillsText ?? '',
      selectorSkills,
    ],
  );
  compositionLogger.info(
    { agentId: defaults.agentId, provider: selection.provider, model: selection.model },
    'Ensured default chat agent record',
  );
}

/**
 * @description Reads the legacy chat theme preference from persisted global config during bootstrap fallback.
 * @param settings - Parsed persisted settings payload.
 * @returns Theme identifier when present.
 */
function readThemePreference(settings: Record<string, unknown> | undefined): string | undefined {
  const chatAgentConfig = settings?.chatAgentConfig;
  if (!chatAgentConfig || typeof chatAgentConfig !== 'object' || Array.isArray(chatAgentConfig)) {
    return undefined;
  }
  return readNonEmptyString((chatAgentConfig as Record<string, unknown>).themePreference);
}
