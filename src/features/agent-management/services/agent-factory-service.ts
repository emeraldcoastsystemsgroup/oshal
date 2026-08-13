/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added AgentFactoryService — creates, persists, and announces new agents in the swarm
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Extended with persona-only deployment (filesystem YAML + DB) and knowledge-enhanced deployment (RAG bootstrap)
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | deployWithContainer — writes persona YAML, registers dynamic compose service, starts container
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | createAndStartAgent — the atomic one-call create+launch behind POST /api/swarm/agents/create-and-start. Reuses deployWithContainer, and on ANY launch failure (compose registration, container start, or spawner not configured) rolls the creation back (removeService + deleteAgent; falls back to marking the profile inactive when deletion fails) so a failed launch can never leave a routable persona-only zombie.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import { randomUUID } from 'crypto';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { createChildLogger } from '@/shared/logger';
import type { AgentProfileRepository, CreateAgentInput } from '@/entities/agent';
import { AuthMode, type Tool, type ToolRuntimeConfig } from '@/shared/types/tool';
import type { PersonaLayerStore } from './persona-layer-store';
import type { ConfigField } from './capability-expansion-service';
import type { MeshTransport } from './mesh-communication-service';
import { MESH_CHANNELS } from './mesh-communication-service';
import type { DynamicComposeService } from './dynamic-compose-service';
import type { BotContainerSpawnerService } from './bot-container-spawner-service';
import { ComposeBotRuntimeLauncher, type BotRuntimeLauncher } from './bot-runtime-launcher';

const logger = createChildLogger({ module: 'agent-factory-service' });

/**
 * @description Reference to an operator-facing configuration guide document that
 * is surfaced alongside an agent so humans know how to finish provisioning it.
 */
export interface AgentConfigGuideSpec {
  title?: string;
  summary?: string;
  docPath: string;
}

/**
 * @description Structured agent specification produced by the agent-factory bot
 * or submitted directly via the API.
 */
export interface AgentSpecification {
  name: string;
  systemPrompt: string;
  role: string;
  topology: 'localhost' | 'swarm';
  constraints: string[];
  capabilities: string[];
  routingKeywords: string[];
  selectorDescriptor: string;
  providerId?: string;
  modelId?: string;
  knowledgeSources?: string[];
  toolAssignments?: AgentToolAssignmentSpec[];
  configFields?: ConfigField[];
  configValues?: Record<string, unknown>;
  configGuide?: AgentConfigGuideSpec;
}

/**
 * @description Optional tool binding applied during agent creation so the new bot
 * is immediately usable without a second provisioning pass.
 */
export interface AgentToolAssignmentSpec {
  toolId?: string;
  toolName?: string;
  authMode?: AuthMode;
  toolConfig?: ToolRuntimeConfig | Record<string, unknown>;
}

/**
 * @description Provisioning summary returned with agent creation responses.
 */
export interface AgentProvisioningSummary {
  appliedToolAssignments: Array<{
    toolId: string;
    toolName: string;
    authMode: AuthMode;
    configured: boolean;
  }>;
  missingToolAssignments: Array<{
    toolId?: string;
    toolName?: string;
    reason: string;
  }>;
  configSchemaFieldCount: number;
  configValueKeys: string[];
  selectorRecomposed: boolean;
  knowledgeSources: string[];
  warnings: string[];
  readiness: AgentOperationalReadiness;
}

/**
 * @description Operator-facing assessment of whether a freshly provisioned agent
 * is ready to run, including how it is classified and what still must be done.
 */
export interface AgentOperationalReadiness {
  classification: 'persona-only' | 'knowledge-enhanced' | 'tool-dependent' | 'hybrid';
  status: 'operational' | 'needs-configuration' | 'needs-tooling' | 'needs-knowledge' | 'partially-provisioned';
  requiredConfigFieldsMissingValues: string[];
  nextActions: string[];
}

/**
 * @description Result of an agent creation operation.
 */
export interface AgentCreationResult {
  success: boolean;
  agentId?: string;
  name: string;
  error?: string;
  duplicate?: boolean;
  knowledgeChunks?: number;
  provisioning?: AgentProvisioningSummary;
}

/**
 * @description Dependencies for AgentFactoryService.
 */
/**
 * @description Callback for bootstrapping agent knowledge via RAG ingestion.
 */
export type RagBootstrapFn = (agentId: string, sources: string[]) => Promise<{ totalChunks: number }>;

/**
 * @description Narrow tool repository contract used during factory provisioning.
 */
export interface AgentFactoryToolRepository {
  getToolById(toolId: string): Promise<Tool | null>;
  getAllTools(filters?: { enabled?: boolean; limit?: number; offset?: number }): Promise<Tool[]>;
}

/**
 * @description Narrow switch-framework contract used during factory provisioning.
 */
export interface AgentFactorySwitchFramework {
  setToolAuthMode(
    agentId: string,
    toolId: string,
    authMode: AuthMode,
  ): Promise<{ success: boolean; message?: string; installed?: boolean }>;
  setToolConfig(agentId: string, toolId: string, toolConfig: Record<string, unknown>): Promise<unknown>;
}

/**
 * @description Narrow config-store contract used during factory provisioning.
 */
export interface AgentFactoryConfigStore {
  setConfigSchema(agentId: string, schema: ConfigField[]): Promise<void>;
  setConfigValues(agentId: string, values: Record<string, unknown>): Promise<void>;
}

/**
 * @description Dependencies for AgentFactoryService.
 */
export interface AgentFactoryServiceDeps {
  agentProfileRepository: AgentProfileRepository;
  meshTransport: MeshTransport;
  personaLayerStore?: PersonaLayerStore;
  personaDir?: string;
  ragBootstrap?: RagBootstrapFn;
  toolRepository?: AgentFactoryToolRepository;
  switchFramework?: AgentFactorySwitchFramework;
  agentConfigStore?: AgentFactoryConfigStore;
  recomposeSelector?: (agentId: string) => Promise<unknown>;
  /** When provided, deployWithContainer writes a dynamic compose service entry before spawning */
  /**
   * Substrate-agnostic bot runtime launcher. When present it OWNS the launch and
   * rollback steps, so the same create-and-start works under compose and on a
   * cluster. The two compose-specific deps below remain for callers that still
   * construct them directly.
   */
  botLauncher?: BotRuntimeLauncher;
  dynamicComposeService?: DynamicComposeService;
  /** When provided, deployWithContainer calls startBot() after writing the compose entry */
  containerSpawner?: BotContainerSpawnerService;
}

/**
 * @description Service that creates, persists, and announces new agents in the swarm.
 * Ported from the legacy implementation's agent-factory-bot concept — adapted for OSHAL's Postgres-backed
 * agent registry and Redis mesh transport.
 */
export class AgentFactoryService {
  private readonly agentProfileRepository: AgentProfileRepository;
  private readonly meshTransport: MeshTransport;
  private readonly personaLayerStore?: PersonaLayerStore;
  private readonly personaDir: string;
  private readonly ragBootstrap?: RagBootstrapFn;
  private readonly toolRepository?: AgentFactoryToolRepository;
  private readonly switchFramework?: AgentFactorySwitchFramework;
  private readonly agentConfigStore?: AgentFactoryConfigStore;
  private readonly recomposeSelector?: (agentId: string) => Promise<unknown>;
  private readonly botLauncher?: BotRuntimeLauncher;
  private readonly dynamicComposeService?: DynamicComposeService;
  private readonly containerSpawner?: BotContainerSpawnerService;

  constructor(deps: AgentFactoryServiceDeps) {
    this.agentProfileRepository = deps.agentProfileRepository;
    this.meshTransport = deps.meshTransport;
    this.personaLayerStore = deps.personaLayerStore;
    this.personaDir = deps.personaDir ?? resolve(__dirname, '..', '..', '..', '..', 'ai-lab', 'bot-personas');
    this.ragBootstrap = deps.ragBootstrap;
    this.toolRepository = deps.toolRepository;
    this.switchFramework = deps.switchFramework;
    this.agentConfigStore = deps.agentConfigStore;
    this.recomposeSelector = deps.recomposeSelector;
    this.dynamicComposeService = deps.dynamicComposeService;
    this.containerSpawner = deps.containerSpawner;
    // Prefer an injected launcher; otherwise fall back to composing one from the
    // legacy compose pair so existing callers behave exactly as before.
    this.botLauncher =
      deps.botLauncher ??
      (deps.dynamicComposeService && deps.containerSpawner
        ? new ComposeBotRuntimeLauncher(deps.dynamicComposeService, deps.containerSpawner)
        : undefined);
  }

  /**
   * @description Creates a new agent from a structured specification.
   * Checks for duplicates, persists the agent record and persona layer,
   * then announces the new agent on the capabilities mesh channel.
   * @param spec - Agent specification
   * @returns Creation result with the new agent ID
   */
  async createAgentFromSpec(spec: AgentSpecification): Promise<AgentCreationResult> {
    try {
      const duplicate = await this.checkDuplicate(spec.name);
      if (duplicate) {
        logger.warn({ name: spec.name }, 'Agent already exists — skipping creation');
        return { success: false, name: spec.name, duplicate: true, error: `Agent "${spec.name}" already exists` };
      }

      const input: CreateAgentInput = {
        name: spec.name,
        status: 'active',
        apiProviderId: spec.providerId || 'auto',
        modelId: spec.modelId || 'auto',
        persona: {
          systemPrompt: spec.systemPrompt,
          role: spec.role,
          constraints: spec.constraints,
        },
        baseCapabilities: spec.capabilities,
        baseSelectorDescriptor: spec.selectorDescriptor,
        baseRoutingKeywords: spec.routingKeywords,
        metadata: {
          topology: spec.topology,
          role: spec.role,
          createdBy: 'agent-factory',
          createdAt: new Date().toISOString(),
          ...(spec.configGuide ? { configGuide: spec.configGuide } : {}),
        },
      };

      const profile = await this.agentProfileRepository.createAgent(input);

      if (this.personaLayerStore) {
        await this.createRoleLayer(profile.agentId, spec);
      }

      const provisioning = await this.provisionAgent(profile.agentId, spec);
      const knowledgeChunks = await this.bootstrapKnowledge(
        profile.agentId,
        spec.knowledgeSources ?? [],
        provisioning.warnings,
      );
      this.finalizeProvisioningReadiness(spec, provisioning);

      await this.announceAgent(profile.agentId, spec);

      logger.info(
        {
          agentId: profile.agentId,
          name: spec.name,
          capabilities: spec.capabilities,
          toolAssignments: provisioning.appliedToolAssignments.length,
          configSchemaFieldCount: provisioning.configSchemaFieldCount,
          readinessStatus: provisioning.readiness.status,
          knowledgeChunks: knowledgeChunks ?? 0,
        },
        'Agent created and announced',
      );

      return {
        success: true,
        agentId: profile.agentId,
        name: spec.name,
        knowledgeChunks,
        provisioning,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error, name: spec.name }, 'Failed to create agent');
      return { success: false, name: spec.name, error: message };
    }
  }

  /**
   * @description Persona-only deployment: creates agent in DB + writes YAML to filesystem.
   * Agent is immediately routable — no container or process needed.
   * @param spec - Agent specification
   * @returns Creation result
   */
  async deployPersonaOnly(spec: AgentSpecification): Promise<AgentCreationResult> {
    const result = await this.createAgentFromSpec(spec);
    if (!result.success || !result.agentId) return result;

    this.writePersonaYaml(spec);
    logger.info({ agentId: result.agentId, name: spec.name }, 'Persona-only deployment complete');
    return result;
  }

  /**
   * @description Knowledge-enhanced deployment: creates agent + triggers RAG bootstrap.
   * @param spec - Agent specification
   * @param knowledgeSources - URLs or file paths for RAG ingestion
   * @returns Creation result with knowledge bootstrap info
   */
  async deployWithKnowledge(
    spec: AgentSpecification,
    knowledgeSources: string[],
  ): Promise<AgentCreationResult & { knowledgeChunks?: number }> {
    return this.deployPersonaOnly({ ...spec, knowledgeSources });
  }

  /**
   * @description Full container deployment: creates agent in DB, writes persona YAML,
   * registers a docker compose service entry in docker-compose.dynamic.yml, and starts
   * the container.  Falls back gracefully at each step — if compose or spawner deps are
   * not configured the agent is still created and routable via the mesh (persona-only mode).
   *
   * Requires `dynamicComposeService` and `containerSpawner` to be injected at construction.
   * Safe to call when they are absent — logs a warning and returns the persona-only result.
   *
   * @param spec - Agent specification
   * @returns Creation result enriched with container spawn outcome
   */
  async deployWithContainer(
    spec: AgentSpecification,
  ): Promise<AgentCreationResult & { containerStarted?: boolean; containerError?: string }> {
    // Step 1: create persona in DB + YAML (same as deployPersonaOnly)
    const result = await this.deployPersonaOnly(spec);
    if (!result.success || !result.agentId) {
      return result;
    }

    if (!this.botLauncher) {
      logger.warn(
        { name: spec.name },
        'deployWithContainer: no bot runtime launcher configured — agent created as persona-only',
      );
      return { ...result, containerStarted: false, containerError: 'Container spawner not configured' };
    }

    // Step 2+3: create the runtime on whichever substrate this controller runs on
    // (compose service + `docker compose up`, or a namespaced k8s Deployment).
    const launch = await this.botLauncher.launch({
      agentName: spec.name,
      agentId: result.agentId,
      capabilities: spec.capabilities?.join(','),
    });
    if (!launch.success) {
      logger.error({ name: spec.name, runtime: launch.runtime, error: launch.error }, 'Failed to launch bot runtime');
      return { ...result, containerStarted: false, containerError: launch.error };
    }

    logger.info({ name: spec.name, agentId: result.agentId, runtime: launch.runtime }, 'Agent deployed with runtime');
    return { ...result, containerStarted: true };
  }

  /**
   * @description Atomic create-and-start: creates the agent and launches its
   * container in one call, and — unlike deployWithContainer, which leaves a
   * routable persona-only agent behind when the launch step fails — rolls the
   * creation back on ANY launch failure (compose registration failure, container
   * start failure, or spawner not configured) so a half-launched agent never
   * lingers as a zombie. Rollback = remove the dynamic compose entry + delete the
   * agent profile; if deletion itself fails the profile is marked `inactive` and
   * the failure is surfaced in the result (never silent).
   * @param spec - Agent specification.
   * @returns Creation result enriched with launch + rollback outcome.
   */
  async createAndStartAgent(
    spec: AgentSpecification,
  ): Promise<AgentCreationResult & {
    containerStarted?: boolean;
    containerError?: string;
    rolledBack?: boolean;
    rollbackError?: string;
  }> {
    const result = await this.deployWithContainer(spec);
    if (!result.success || !result.agentId) {
      return result; // creation itself failed — nothing persisted to roll back
    }
    if (result.containerStarted) {
      return result;
    }

    const launchError = result.containerError ?? 'Container start failed';
    logger.warn({ name: spec.name, agentId: result.agentId, launchError }, 'Launch failed after creation — rolling back');
    const rollback = await this.rollbackCreatedAgent(result.agentId, spec.name);
    return {
      ...result,
      ...rollback,
      success: false,
      error: rollback.rolledBack
        ? `Agent created but launch failed (${launchError}) — creation rolled back`
        : `Agent created but launch failed (${launchError}) — ROLLBACK ALSO FAILED (${rollback.rollbackError ?? 'unknown'}); agent marked inactive`,
    };
  }

  /**
   * @description Undoes a creation whose launch failed: best-effort runtime
   * cleanup on whichever substrate is in play, then agent profile deletion; when
   * deletion fails the profile is marked inactive so the failed agent can never
   * be routed to.
   * @param agentId - The created agent's ID.
   * @param agentName - The created agent's name (service/Deployment key).
   * @returns Rollback outcome for the caller's response.
   */
  private async rollbackCreatedAgent(
    agentId: string,
    agentName: string,
  ): Promise<{ rolledBack: boolean; rollbackError?: string }> {
    try {
      const removal = await this.botLauncher?.remove(agentName);
      if (removal && !removal.success) {
        logger.error({ agentName, runtime: removal.runtime, error: removal.error }, 'Rollback: bot runtime removal failed (continuing to profile deletion)');
      }
    } catch (error) {
      logger.error({ err: error, agentName }, 'Rollback: dynamic compose removal threw (continuing to profile deletion)');
    }

    let deletionError: string | undefined;
    try {
      if (await this.deleteAgent(agentId)) {
        logger.info({ agentId, agentName }, 'Rollback complete — created agent deleted after launch failure');
        return { rolledBack: true };
      }
      deletionError = 'deleteAgent reported no row deleted';
    } catch (error) {
      deletionError = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, agentId, agentName }, 'Rollback: agent deletion threw');
    }

    try {
      await this.agentProfileRepository.updateAgentStatus(agentId, 'inactive');
      logger.error({ agentId, agentName, deletionError }, 'Rollback deletion failed — agent marked inactive instead (NOT silent: surfaced in the API result)');
    } catch (error) {
      logger.error({ err: error, agentId, agentName }, 'Rollback: marking agent inactive ALSO failed — operator attention required');
    }
    return { rolledBack: false, rollbackError: deletionError };
  }

  /**
   * @description Writes a persona YAML file to the filesystem for the PersonaFileLoader.
   * @param spec - Agent specification
   */
  private writePersonaYaml(spec: AgentSpecification): void {
    try {
      if (!existsSync(this.personaDir)) {
        mkdirSync(this.personaDir, { recursive: true });
      }
      const yaml = buildPersonaYaml(spec);
      const filePath = join(this.personaDir, `${spec.name}.yaml`);
      writeFileSync(filePath, yaml, 'utf8');
      logger.info({ path: filePath, name: spec.name }, 'Persona YAML written');
    } catch (err) {
      logger.warn({ err, name: spec.name }, 'Failed to write persona YAML — agent still in DB');
    }
  }

  /**
   * @description Deletes an agent by ID, removing it from the registry.
   * @param agentId - Agent identifier
   * @returns True if deleted
   */
  async deleteAgent(agentId: string): Promise<boolean> {
    return this.agentProfileRepository.deleteAgent(agentId);
  }

  /**
   * @description Lists all existing agents for duplicate checking.
   * @returns Agent names
   */
  async listAgentNames(): Promise<string[]> {
    const agents = await this.agentProfileRepository.listAgents();
    return agents.map((a) => a.name);
  }

  /**
   * @description Checks whether an agent with the given name already exists.
   * @param name - Agent name to check
   * @returns True if a duplicate exists
   */
  private async checkDuplicate(name: string): Promise<boolean> {
    const agents = await this.agentProfileRepository.listAgents();
    return agents.some((a) => a.name.toLowerCase() === name.toLowerCase());
  }

  /**
   * @description Applies optional tool bindings, config schema, and startup metadata so
   * newly created agents are ready for dynamic runtime assembly.
   * @param agentId - Newly created agent ID.
   * @param spec - Agent specification.
   * @returns Provisioning summary for operator visibility.
   */
  private async provisionAgent(agentId: string, spec: AgentSpecification): Promise<AgentProvisioningSummary> {
    const summary: AgentProvisioningSummary = {
      appliedToolAssignments: [],
      missingToolAssignments: [],
      configSchemaFieldCount: 0,
      configValueKeys: Object.keys(spec.configValues ?? {}),
      selectorRecomposed: false,
      knowledgeSources: [...(spec.knowledgeSources ?? [])],
      warnings: [],
      readiness: {
        classification: classifyAgentSpecification(spec),
        status: 'operational',
        requiredConfigFieldsMissingValues: [],
        nextActions: [],
      },
    };

    if (spec.configFields && spec.configFields.length > 0) {
      if (this.agentConfigStore) {
        await this.agentConfigStore.setConfigSchema(agentId, spec.configFields);
        summary.configSchemaFieldCount = spec.configFields.length;
      } else {
        summary.warnings.push('Agent config store unavailable; config schema was not persisted.');
      }
    }

    if (summary.configValueKeys.length > 0) {
      if (this.agentConfigStore) {
        await this.agentConfigStore.setConfigValues(agentId, spec.configValues ?? {});
      } else {
        summary.warnings.push('Agent config store unavailable; config defaults were not persisted.');
      }
    }

    let toolBindingsChanged = false;
    for (const assignment of spec.toolAssignments ?? []) {
      const resolvedTool = await this.resolveToolAssignment(assignment);
      if (!resolvedTool) {
        summary.missingToolAssignments.push({
          toolId: assignment.toolId,
          toolName: assignment.toolName,
          reason: 'Tool not found in registry.',
        });
        continue;
      }

      if (!this.switchFramework) {
        summary.missingToolAssignments.push({
          toolId: resolvedTool.toolId,
          toolName: resolvedTool.name,
          reason: 'Switch framework unavailable; tool assignment could not be applied.',
        });
        continue;
      }

      const authMode = assignment.authMode ?? resolvedTool.defaultAuthMode ?? AuthMode.OFF;
      await this.switchFramework.setToolAuthMode(agentId, resolvedTool.toolId, authMode);
      toolBindingsChanged = true;

      let configured = false;
      if (assignment.toolConfig && Object.keys(assignment.toolConfig).length > 0) {
        await this.switchFramework.setToolConfig(
          agentId,
          resolvedTool.toolId,
          assignment.toolConfig as Record<string, unknown>,
        );
        configured = true;
      }

      summary.appliedToolAssignments.push({
        toolId: resolvedTool.toolId,
        toolName: resolvedTool.name,
        authMode,
        configured,
      });
    }

    if (toolBindingsChanged) {
      if (this.recomposeSelector) {
        await this.recomposeSelector(agentId);
        summary.selectorRecomposed = true;
      } else {
        summary.warnings.push('Selector recomposer unavailable; computed selector fields may be stale until next refresh.');
      }
    }

    return summary;
  }

  /**
   * @description Seeds optional knowledge sources through the configured RAG bootstrap.
   * @param agentId - Newly created agent ID.
   * @param knowledgeSources - Knowledge source URLs or paths.
   * @returns Total chunks ingested, when available.
   */
  private async bootstrapKnowledge(
    agentId: string,
    knowledgeSources: string[],
    warnings: string[],
  ): Promise<number | undefined> {
    if (knowledgeSources.length === 0) {
      return undefined;
    }

    if (!this.ragBootstrap) {
      logger.warn({ agentId, sourceCount: knowledgeSources.length }, 'Knowledge sources requested but no RAG bootstrap is configured');
      warnings.push('Knowledge sources were declared, but no RAG bootstrap is configured.');
      return undefined;
    }

    try {
      const bootstrap = await this.ragBootstrap(agentId, knowledgeSources);
      logger.info({ agentId, sources: knowledgeSources.length, chunks: bootstrap.totalChunks }, 'Knowledge bootstrap complete');
      return bootstrap.totalChunks;
    } catch (err) {
      logger.warn({ err, agentId }, 'Knowledge bootstrap failed — agent still usable');
      return undefined;
    }
  }

  /**
   * @description Converts provisioning facts into an operator-facing readiness assessment.
   * @param spec - Agent specification submitted to the factory.
   * @param summary - Provisioning summary to enrich.
   */
  private finalizeProvisioningReadiness(spec: AgentSpecification, summary: AgentProvisioningSummary): void {
    const missingRequiredConfig = getMissingRequiredConfigFields(spec);
    const needsTooling = summary.missingToolAssignments.length > 0;
    const needsConfig = missingRequiredConfig.length > 0;
    const needsKnowledge = summary.warnings.some((warning) => warning.toLowerCase().includes('knowledge'));

    summary.readiness.requiredConfigFieldsMissingValues = missingRequiredConfig;
    summary.readiness.nextActions = buildProvisioningNextActions(summary, missingRequiredConfig);

    if (needsConfig) {
      summary.warnings.push(`Required config fields still need values: ${missingRequiredConfig.join(', ')}.`);
    }

    const activeIssues = [needsTooling, needsConfig, needsKnowledge].filter(Boolean).length;
    if (activeIssues === 0) {
      summary.readiness.status = 'operational';
      return;
    }
    if (activeIssues > 1) {
      summary.readiness.status = 'partially-provisioned';
      return;
    }
    if (needsTooling) {
      summary.readiness.status = 'needs-tooling';
      return;
    }
    if (needsConfig) {
      summary.readiness.status = 'needs-configuration';
      return;
    }
    summary.readiness.status = 'needs-knowledge';
  }

  /**
   * @description Resolves a tool assignment by canonical tool ID or exact registry name.
   * @param assignment - Requested tool assignment.
   * @returns Matching tool row or null when no registry entry exists.
   */
  private async resolveToolAssignment(assignment: AgentToolAssignmentSpec): Promise<Tool | null> {
    if (!this.toolRepository) {
      return null;
    }

    if (assignment.toolId) {
      return this.toolRepository.getToolById(assignment.toolId);
    }

    const requestedName = assignment.toolName?.trim().toLowerCase();
    if (!requestedName) {
      return null;
    }

    const tools = await this.toolRepository.getAllTools({ enabled: true, limit: 1000, offset: 0 });
    return tools.find((tool) => tool.name.trim().toLowerCase() === requestedName) ?? null;
  }

  /**
   * @description Creates a role persona layer for the new agent.
   * @param agentId - New agent's ID
   * @param spec - Agent specification
   */
  private async createRoleLayer(agentId: string, spec: AgentSpecification): Promise<void> {
    if (!this.personaLayerStore) {
      return;
    }
    try {
      await (this.personaLayerStore as PersonaLayerStoreWithInsert).insertLayer({
        layerType: 'role',
        scope: 'agent',
        agentId,
        priority: 30,
        promptFragment: [
          `## ${spec.name} Role Layer`,
          '',
          spec.systemPrompt,
          '',
          '## Constraints',
          ...spec.constraints.map((c) => `- ${c}`),
        ].join('\n'),
        metadata: { generatedBy: 'agent-factory', createdAt: new Date().toISOString() },
      });
      logger.info({ agentId, name: spec.name }, 'Role persona layer created');
    } catch (error) {
      logger.warn({ err: error, agentId }, 'Failed to create role persona layer — agent still usable');
    }
  }

  /**
   * @description Announces the new agent on the swarm capabilities channel.
   * @param agentId - New agent's ID
   * @param spec - Agent specification
   */
  private async announceAgent(agentId: string, spec: AgentSpecification): Promise<void> {
    try {
      await this.meshTransport.publish({
        correlationId: `factory-${agentId}-${Date.now()}`,
        fromAgentId: 'agent-factory',
        toAgentId: 'project-manager',
        channel: MESH_CHANNELS.capabilities,
        payload: {
          type: 'agent-created',
          agentId,
          name: spec.name,
          capabilities: spec.capabilities,
          routingKeywords: spec.routingKeywords,
          selectorDescriptor: spec.selectorDescriptor,
          topology: spec.topology,
          role: spec.role,
        },
        messageType: 'event',
      });
    } catch (error) {
      logger.warn({ err: error, agentId }, 'Failed to announce new agent on mesh — agent still persisted');
    }
  }
}

/**
 * @description Extended PersonaLayerStore interface with insert capability.
 * The base store is read-only — the factory needs write access.
 */
/**
 * @description Builds a persona YAML string from an agent specification.
 */
function buildPersonaYaml(spec: AgentSpecification): string {
  const lines = [
    `# ${spec.name} — Auto-generated by AgentFactoryService`,
    `# Created: ${new Date().toISOString()}`,
    '',
    `name: ${spec.name}`,
    `role: ${spec.role}`,
    `agent_id: ${spec.name}`,
    '',
    'perspective: |',
    ...spec.systemPrompt.split('\n').map((l) => `  ${l}`),
    '',
    'capabilities:',
    ...spec.capabilities.map((c) => `  - ${c}`),
    '',
    `max_concurrent: 3`,
    `scope: shared`,
    '',
    'selector_descriptor: |',
    ...spec.selectorDescriptor.split('\n').map((l) => `  ${l}`),
    '',
    'routing_keywords:',
    ...spec.routingKeywords.map((k) => `  - ${k}`),
    '',
    ...buildConfigGuideYaml(spec.configGuide),
    'authorizations:',
    '  aws_cli: "off"',
    '  kubectl: "off"',
    '  gcloud: "off"',
    '  docker: "off"',
    '  google_search: "off"',
    '  chroma_mcp: "off"',
    '  plane_mcp: "off"',
  ];
  return lines.join('\n') + '\n';
}

function buildConfigGuideYaml(configGuide?: AgentConfigGuideSpec): string[] {
  if (!configGuide?.docPath) {
    return [];
  }

  const lines = [
    'config_guide:',
    `  doc_path: ${configGuide.docPath}`,
  ];

  if (configGuide.title) {
    lines.push(`  title: ${configGuide.title}`);
  }

  if (configGuide.summary) {
    lines.push('  summary: |-');
    lines.push(...configGuide.summary.split('\n').map((line) => `    ${line}`));
  }

  lines.push('');
  return lines;
}

function classifyAgentSpecification(
  spec: AgentSpecification,
): AgentOperationalReadiness['classification'] {
  const hasKnowledge = (spec.knowledgeSources?.length ?? 0) > 0;
  const hasTools = (spec.toolAssignments?.length ?? 0) > 0;

  if (hasKnowledge && hasTools) {
    return 'hybrid';
  }
  if (hasTools) {
    return 'tool-dependent';
  }
  if (hasKnowledge) {
    return 'knowledge-enhanced';
  }
  return 'persona-only';
}

function getMissingRequiredConfigFields(spec: AgentSpecification): string[] {
  const values = spec.configValues ?? {};
  return (spec.configFields ?? [])
    .filter((field) => {
      if (!field.required) {
        return false;
      }

      const value = values[field.name];
      const hasValue = value !== undefined && value !== null && (typeof value !== 'string' || value.trim().length > 0);
      const hasDefault = typeof field.defaultValue === 'string' && field.defaultValue.trim().length > 0;
      return !hasValue && !hasDefault;
    })
    .map((field) => field.name);
}

function buildProvisioningNextActions(
  summary: AgentProvisioningSummary,
  missingRequiredConfig: string[],
): string[] {
  const actions: string[] = [];

  if (summary.missingToolAssignments.length > 0) {
    const missingTools = summary.missingToolAssignments
      .map((entry) => entry.toolName || entry.toolId || 'unknown-tool')
      .join(', ');
    actions.push(`Register or seed missing tools before marking the agent operational: ${missingTools}.`);
  }

  if (missingRequiredConfig.length > 0) {
    actions.push(`Set required agent config values: ${missingRequiredConfig.join(', ')}.`);
  }

  if (summary.warnings.some((warning) => warning.toLowerCase().includes('knowledge'))) {
    actions.push('Complete knowledge bootstrap before relying on retrieval-backed behavior.');
  }

  return actions;
}

interface PersonaLayerStoreWithInsert extends PersonaLayerStore {
  insertLayer(input: {
    layerType: string;
    scope: string;
    agentId: string;
    priority: number;
    promptFragment: string;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}
