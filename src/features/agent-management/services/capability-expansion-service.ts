/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added CapabilityExpansionService — ported from the legacy CapabilityExpander + ToolScaffolder
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import { createChildLogger } from '@/shared/logger';
import type { AgentProfileRepository } from '@/entities/agent';
import type { MeshTransport } from './mesh-communication-service';
import { MESH_CHANNELS } from './mesh-communication-service';
import type { AgentConfigService } from './agent-config-service';

const logger = createChildLogger({ module: 'capability-expansion-service' });

/**
 * @description Tool specification for scaffolding a new tool definition.
 * Adapted from the legacy implementation's ToolScaffolder — in OSHAL, tools are metadata definitions
 * stored in the agent's persona/metadata (no physical JS files to scaffold).
 */
export interface ToolSpec {
  /** Snake-case tool name (e.g., 'query_database', 'send_notification') */
  toolName: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** Input parameters the tool accepts */
  inputSchema: ToolInputField[];
  /** Capabilities this tool provides to the agent */
  capabilities: string[];
}

/**
 * @description Input field definition for a scaffolded tool.
 */
export interface ToolInputField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required: boolean;
}

/**
 * @description Config field definition for an agent's external service credentials.
 * Adapted from the legacy implementation's AgentConfigManager schema fields.
 */
export interface ConfigField {
  /** Field key used in config store (e.g., 'API_KEY', 'BASE_URL') */
  name: string;
  /** Field type for UI rendering */
  type: 'string' | 'password' | 'url' | 'number' | 'boolean' | 'select' | 'textarea';
  /** Human-readable label */
  label: string;
  /** Whether the field must be filled before the tool works */
  required: boolean;
  /** Default value */
  defaultValue?: string;
  /** Options for select-type fields */
  options?: string[];
  /** Placeholder text */
  placeholder?: string;
  /** Optional operator-facing help copy */
  description?: string;
}

/**
 * @description Full capability expansion request — combines tool scaffolding
 * with config schema registration in a single pipeline step.
 */
export interface CapabilityExpansionSpec {
  /** Target agent ID (must already exist) */
  agentId: string;
  /** Tool definition to scaffold */
  tool: ToolSpec;
  /** Config fields the tool needs (API keys, URLs, etc.) */
  configFields?: ConfigField[];
}

/**
 * @description Result of a capability expansion pipeline run.
 */
export interface CapabilityExpansionResult {
  success: boolean;
  agentId: string;
  toolName: string;
  steps: {
    validateAgent: 'ok' | 'failed';
    scaffoldTool: 'ok' | 'failed' | 'skipped';
    registerConfig: 'ok' | 'failed' | 'skipped';
    updateCapabilities: 'ok' | 'failed';
    announceExpansion: 'ok' | 'failed';
  };
  error?: string;
}

/**
 * @description Dependencies for CapabilityExpansionService.
 */
export interface CapabilityExpansionServiceDeps {
  agentProfileRepository: AgentProfileRepository;
  meshTransport: MeshTransport;
  agentConfigService?: AgentConfigService;
}

/**
 * @description Service that expands an existing agent's capabilities by scaffolding
 * new tool definitions, registering config schemas, and updating the agent's capability
 * set. Ported from the legacy implementation's CapabilityExpander (5-step pipeline) + ToolScaffolder,
 * adapted for OSHAL's Postgres-backed architecture.
 *
 * In the legacy implementation, expansion meant: scaffold JS file → register Redis config → build Docker
 * image → deploy container → register tool in MCP server.
 *
 * In OSHAL, expansion means: validate agent → store tool metadata in agent persona →
 * register config schema in Postgres → update agent capabilities → announce on mesh.
 * No Docker builds, no physical file scaffolding.
 */
export class CapabilityExpansionService {
  private readonly agentProfileRepository: AgentProfileRepository;
  private readonly meshTransport: MeshTransport;
  private readonly agentConfigService?: AgentConfigService;
  private readonly expansionHistory: Map<string, CapabilityExpansionResult[]> = new Map();

  constructor(deps: CapabilityExpansionServiceDeps) {
    this.agentProfileRepository = deps.agentProfileRepository;
    this.meshTransport = deps.meshTransport;
    this.agentConfigService = deps.agentConfigService;
  }

  /**
   * @description Expands an agent's capabilities by adding a new tool definition.
   * Pipeline: validate → scaffold → config → update capabilities → announce.
   * @param spec - Capability expansion specification
   * @returns Pipeline result with step-by-step status
   */
  async expand(spec: CapabilityExpansionSpec): Promise<CapabilityExpansionResult> {
    const result: CapabilityExpansionResult = {
      success: false,
      agentId: spec.agentId,
      toolName: spec.tool.toolName,
      steps: {
        validateAgent: 'failed',
        scaffoldTool: 'skipped',
        registerConfig: 'skipped',
        updateCapabilities: 'failed',
        announceExpansion: 'failed',
      },
    };

    try {
      // Step 1: Validate the target agent exists
      const agent = await this.agentProfileRepository.getAgentProfile(spec.agentId);
      if (!agent) {
        result.error = `Agent "${spec.agentId}" not found`;
        return result;
      }
      result.steps.validateAgent = 'ok';

      // Step 2: Scaffold tool metadata into agent's persona
      try {
        await this.scaffoldTool(spec.agentId, agent, spec.tool);
        result.steps.scaffoldTool = 'ok';
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown scaffold error';
        logger.error({ err, agentId: spec.agentId, tool: spec.tool.toolName }, 'Tool scaffolding failed');
        result.steps.scaffoldTool = 'failed';
        result.error = msg;
        return result;
      }

      // Step 3: Register config schema (if config fields provided)
      if (spec.configFields && spec.configFields.length > 0 && this.agentConfigService) {
        try {
          await this.agentConfigService.setConfigSchema(spec.agentId, spec.configFields);
          result.steps.registerConfig = 'ok';
        } catch (err) {
          logger.warn({ err, agentId: spec.agentId }, 'Config schema registration failed — continuing');
          result.steps.registerConfig = 'failed';
        }
      }

      // Step 4: Update agent capabilities with the new tool's capabilities
      try {
        await this.updateAgentCapabilities(spec.agentId, agent, spec.tool.capabilities);
        result.steps.updateCapabilities = 'ok';
      } catch (err) {
        logger.error({ err, agentId: spec.agentId }, 'Capability update failed');
        result.steps.updateCapabilities = 'failed';
        result.error = err instanceof Error ? err.message : 'Update failed';
        return result;
      }

      // Step 5: Announce the expansion on mesh
      try {
        await this.announceExpansion(spec.agentId, spec.tool);
        result.steps.announceExpansion = 'ok';
      } catch (err) {
        logger.warn({ err, agentId: spec.agentId }, 'Mesh announcement failed — expansion still persisted');
        result.steps.announceExpansion = 'failed';
      }

      result.success = true;
      this.trackExpansion(spec.agentId, result);
      logger.info(
        { agentId: spec.agentId, tool: spec.tool.toolName, steps: result.steps },
        'Capability expansion completed',
      );
      return result;
    } catch (err) {
      result.error = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ err, agentId: spec.agentId }, 'Capability expansion pipeline failed');
      return result;
    }
  }

  /**
   * @description Validates an expansion spec without executing it (dry-run).
   * @param spec - Capability expansion specification
   * @returns Validation result with issues
   */
  async validate(spec: CapabilityExpansionSpec): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];

    if (!spec.agentId) issues.push('agentId is required');
    if (!spec.tool.toolName) issues.push('tool.toolName is required');
    if (!spec.tool.description) issues.push('tool.description is required');
    if (!spec.tool.capabilities || spec.tool.capabilities.length === 0) {
      issues.push('tool.capabilities must have at least one capability');
    }

    // Validate tool name is kebab-case/snake_case
    if (spec.tool.toolName && !/^[a-z][a-z0-9_-]*$/.test(spec.tool.toolName)) {
      issues.push('tool.toolName must be lowercase alphanumeric with underscores/hyphens');
    }

    // Check agent exists
    if (spec.agentId) {
      const agent = await this.agentProfileRepository.getAgentProfile(spec.agentId);
      if (!agent) {
        issues.push(`Agent "${spec.agentId}" not found`);
      }
    }

    return { valid: issues.length === 0, issues };
  }

  /**
   * @description Gets the expansion history for an agent.
   * @param agentId - Agent identifier
   * @returns List of past expansion results
   */
  getExpansionHistory(agentId: string): CapabilityExpansionResult[] {
    return this.expansionHistory.get(agentId) || [];
  }

  /**
   * @description Scaffolds tool metadata into the agent's persona JSONB.
   * In the legacy implementation this generated physical JS files; in OSHAL we store the tool
   * definition as metadata in the agent's persona for prompt injection.
   */
  private async scaffoldTool(
    agentId: string,
    agent: { persona: Record<string, unknown>; name: string },
    tool: ToolSpec,
  ): Promise<void> {
    const currentAgent = await this.agentProfileRepository.getAgentProfile(agentId);
    if (!currentAgent) throw new Error(`Agent ${agentId} not found`);

    const persona = { ...agent.persona };
    const tools: Record<string, unknown>[] = (persona.tools as Record<string, unknown>[]) || [];

    // Check for duplicate tool
    if (tools.some((t) => t.toolName === tool.toolName)) {
      throw new Error(`Tool "${tool.toolName}" already exists on agent "${agent.name}"`);
    }

    tools.push({
      toolName: tool.toolName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      capabilities: tool.capabilities,
      scaffoldedAt: new Date().toISOString(),
      scaffoldedBy: 'capability-expansion-service',
    });

    persona.tools = tools;

    // Update persona in database
    await this.agentProfileRepository.updateAgentProfile({
      agentId,
      name: agent.name,
      status: currentAgent.status,
      providerId: currentAgent.providerId,
      modelId: currentAgent.modelId,
      metadata: agent.persona.metadata as Record<string, unknown> || {},
      baseCapabilities: [],
      baseSelectorDescriptor: '',
      baseRoutingKeywords: [],
    });

    logger.info({ agentId, toolName: tool.toolName }, 'Tool scaffolded into agent persona');
  }

  /**
   * @description Merges new capabilities into the agent's existing capability set.
   */
  private async updateAgentCapabilities(
    agentId: string,
    agent: { name: string; persona: Record<string, unknown> },
    newCapabilities: string[],
  ): Promise<void> {
    // Read current capabilities from the agents table
    const currentAgent = await this.agentProfileRepository.getAgentProfile(agentId);
    if (!currentAgent) throw new Error(`Agent ${agentId} not found`);

    const currentCaps: string[] = (currentAgent.metadata?.baseCapabilities as string[]) || [];
    const mergedCaps = [...new Set([...currentCaps, ...newCapabilities])];

    await this.agentProfileRepository.updateAgentProfile({
      agentId,
      name: agent.name,
      status: currentAgent.status,
      providerId: currentAgent.providerId,
      modelId: currentAgent.modelId,
      metadata: { ...currentAgent.metadata, baseCapabilities: mergedCaps },
      baseCapabilities: mergedCaps,
      baseSelectorDescriptor: currentAgent.selectorSkillsText || '',
      baseRoutingKeywords: (currentAgent.metadata?.baseRoutingKeywords as string[]) || [],
    });

    logger.info({ agentId, added: newCapabilities, total: mergedCaps.length }, 'Agent capabilities updated');
  }

  /**
   * @description Announces the capability expansion on the mesh.
   */
  private async announceExpansion(agentId: string, tool: ToolSpec): Promise<void> {
    await this.meshTransport.publish({
      correlationId: `expand-${agentId}-${tool.toolName}-${Date.now()}`,
      fromAgentId: 'agent-factory',
      toAgentId: 'project-manager',
      channel: MESH_CHANNELS.capabilities,
      payload: {
        type: 'capability-expanded',
        agentId,
        toolName: tool.toolName,
        capabilities: tool.capabilities,
        description: tool.description,
      },
      messageType: 'event',
    });
  }

  /**
   * @description Tracks expansion result in memory for history queries.
   */
  private trackExpansion(agentId: string, result: CapabilityExpansionResult): void {
    const history = this.expansionHistory.get(agentId) || [];
    history.push(result);
    this.expansionHistory.set(agentId, history);
  }
}
