/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added live agent startup manifest service for per-task runtime assembly and workspace persistence
 */

import fs from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
import type { LLMToolDefinition } from './llm-service';
import type { ClineRuntimeSelection } from './cline-runtime-config-sync-service';
import type { AgentTool, ComposedSelector } from '@/shared/types/tool';

const logger = createChildLogger({ module: 'agent-startup-manifest-service' });

/**
 * @description Snapshot of agent profile data used to build the runtime startup manifest.
 */
export interface AgentStartupProfile {
  agentId: string;
  name: string;
  status?: string;
  providerId?: string;
  modelId?: string;
  persona?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  projectUrl?: string;
  avatarUrl?: string;
}

/**
 * @description Dependency contract for loading manifest context from the app runtime.
 */
export interface AgentStartupManifestDeps {
  loadAgentProfile(agentId: string): Promise<AgentStartupProfile | null>;
  loadAgentTools(agentId: string): Promise<AgentTool[]>;
  loadComposedSelector(agentId: string): Promise<ComposedSelector | null>;
  readMcpSettings(): Record<string, unknown>;
  getMcpSettingsPath(): string;
}

/**
 * @description Input required to assemble and persist a startup manifest.
 */
export interface PrepareAgentStartupManifestInput {
  taskId?: string;
  agentId?: string;
  workspacePath: string;
  binaryPath: string;
  configDir: string;
  runtimeSelection: ClineRuntimeSelection;
  systemPrompt?: string;
  callableTools?: LLMToolDefinition[];
  mcpSettingsOverride?: Record<string, unknown>;
  mcpSettingsPathOverride?: string;
}

interface AgentStartupManifest {
  schemaVersion: 1;
  generatedAt: string;
  taskId: string | null;
  agentId: string | null;
  workspacePath: string;
  runtime: {
    providerAdapter: 'claude-code';
    provider: string;
    model: string;
    mode: 'act' | 'plan';
    binaryPath: string;
    configDir: string;
  };
  prompt: {
    systemPrompt: string;
    callableTools: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>;
  };
  agent: {
    profile: AgentStartupProfile | null;
    selector: {
      capabilities: string[];
      selectorDescriptor: string;
      routingKeywords: string[];
    } | null;
    enabledTools: Array<{
      toolId: string;
      name: string;
      displayName: string;
      type: string;
      authMode: string;
      description: string;
      skills: string[];
      routingTags: string[];
      selectorFragment: string;
      installed: boolean;
      installVerified: boolean;
      config: {
        authType?: string;
        authEnabled?: boolean;
        endpointUrl?: string;
        baseUrl?: string;
        metadataKeys: string[];
        configured: boolean;
      };
    }>;
  };
  mcp: {
    settingsPath: string;
    servers: Array<{
      name: string;
      transport: 'remote' | 'stdio' | 'configured';
      summary: string;
      url?: string;
      command?: string;
      args?: string[];
    }>;
  };
}

interface ManifestContext {
  profile: AgentStartupProfile | null;
  selector: ComposedSelector | null;
  agentTools: AgentTool[];
}

/**
 * @description Builds and persists the per-task startup manifest passed into the live agent runtime.
 * The manifest is stored inside the task workspace so the subprocess has one concrete artifact
 * describing the active agent, runtime selection, enabled tools, MCP servers, and selector context.
 */
export class AgentStartupManifestService {
  private readonly deps: AgentStartupManifestDeps;

  /**
   * @description Creates a manifest service with app-provided loaders.
   * @param deps - Runtime data loaders used during manifest assembly.
   */
  constructor(deps: AgentStartupManifestDeps) {
    this.deps = deps;
  }

  /**
   * @description Builds and writes the runtime startup manifest for the current request.
   * @param input - Current provider request context.
   * @returns Absolute manifest path written into the workspace.
   */
  async prepareManifest(input: PrepareAgentStartupManifestInput): Promise<string> {
    const context = await this.loadManifestContext(input.agentId);
    const mcpSettings = input.mcpSettingsOverride ?? this.deps.readMcpSettings();
    const manifest = this.buildManifest(input, context, mcpSettings);
    const manifestPath = path.join(input.workspacePath, '.oshal', 'session-manifest.json');
    this.writeManifest(manifestPath, manifest);
    logger.info(
      { manifestPath, taskId: input.taskId, agentId: input.agentId ?? null },
      'Prepared live agent startup manifest',
    );
    return manifestPath;
  }

  /**
   * @description Loads optional agent context without failing the chat request when auxiliary state is unavailable.
   * @param agentId - Active agent identifier from the request.
   * @returns Partial context for manifest assembly.
   */
  private async loadManifestContext(agentId?: string): Promise<ManifestContext> {
    if (!agentId) {
      return { profile: null, selector: null, agentTools: [] };
    }

    const [profileResult, selectorResult, toolsResult] = await Promise.allSettled([
      this.deps.loadAgentProfile(agentId),
      this.deps.loadComposedSelector(agentId),
      this.deps.loadAgentTools(agentId),
    ]);

    return {
      profile: this.readSettledValue(profileResult, 'profile', agentId),
      selector: this.readSettledValue(selectorResult, 'selector', agentId),
      agentTools: this.readSettledValue(toolsResult, 'agentTools', agentId) ?? [],
    };
  }

  /**
   * @description Reads a settled loader result and logs structured warnings on fallback.
   * @param result - Settled async result.
   * @param contextType - Logical context being loaded.
   * @param agentId - Current agent identifier.
   * @returns Resolved value or null.
   */
  private readSettledValue<T>(
    result: PromiseSettledResult<T>,
    contextType: 'profile' | 'selector' | 'agentTools',
    agentId: string,
  ): T | null {
    if (result.status === 'fulfilled') {
      return result.value;
    }

    logger.warn(
      { err: result.reason, agentId, contextType },
      'Manifest context loader failed; continuing with degraded startup manifest',
    );
    return null;
  }

  /**
   * @description Builds the JSON manifest document from runtime and agent context.
   * @param input - Provider request context.
   * @param context - Loaded agent context.
   * @param mcpSettings - Current MCP runtime settings.
   * @returns Manifest document ready for persistence.
   */
  private buildManifest(
    input: PrepareAgentStartupManifestInput,
    context: ManifestContext,
    mcpSettings: Record<string, unknown>,
  ): AgentStartupManifest {
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      taskId: input.taskId ?? null,
      agentId: input.agentId ?? null,
      workspacePath: input.workspacePath,
      runtime: {
        providerAdapter: 'claude-code',
        provider: input.runtimeSelection.provider,
        model: input.runtimeSelection.model,
        mode: input.runtimeSelection.mode,
        binaryPath: input.binaryPath,
        configDir: input.configDir,
      },
      prompt: {
        systemPrompt: input.systemPrompt?.trim() ?? '',
        callableTools: (input.callableTools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.input_schema,
        })),
      },
      agent: {
        profile: context.profile,
        selector: this.buildSelectorSnapshot(context.selector),
        enabledTools: context.agentTools
          .filter((tool) => tool.authMode !== 'off')
          .map((tool) => this.mapEnabledTool(tool)),
      },
      mcp: {
        settingsPath: input.mcpSettingsPathOverride ?? this.deps.getMcpSettingsPath(),
        servers: this.mapMcpServers(mcpSettings),
      },
    };
  }

  /**
   * @description Builds the selector snapshot included in the manifest.
   * @param selector - Composed selector from the runtime service.
   * @returns Minimal selector payload or null.
   */
  private buildSelectorSnapshot(selector: ComposedSelector | null): AgentStartupManifest['agent']['selector'] {
    if (!selector) {
      return null;
    }

    return {
      capabilities: selector.capabilities,
      selectorDescriptor: selector.selectorDescriptor,
      routingKeywords: selector.routingKeywords,
    };
  }

  /**
   * @description Maps a persisted enabled tool into the runtime manifest without leaking raw credentials.
   * @param agentTool - Enabled tool assignment.
   * @returns Sanitized manifest tool summary.
   */
  private mapEnabledTool(agentTool: AgentTool): AgentStartupManifest['agent']['enabledTools'][number] {
    const config = this.readToolConfig(agentTool.toolConfig);
    const endpoint = this.readNestedObject(config.endpoint);
    const metadata = this.readNestedObject(config.metadata);
    const auth = this.readNestedObject(config.auth);

    return {
      toolId: agentTool.toolId,
      name: agentTool.tool.name,
      displayName: agentTool.tool.displayName,
      type: agentTool.tool.type,
      authMode: agentTool.authMode,
      description: agentTool.tool.description,
      skills: agentTool.tool.skills,
      routingTags: agentTool.tool.routingTags,
      selectorFragment: agentTool.tool.selectorFragment,
      installed: agentTool.installed,
      installVerified: agentTool.installVerified,
      config: {
        authType: this.readString(auth.type),
        authEnabled: auth.enabled === true,
        endpointUrl: this.readString(endpoint.url),
        baseUrl: this.readString(endpoint.baseUrl),
        metadataKeys: Object.keys(metadata),
        configured: this.hasMeaningfulConfig(config),
      },
    };
  }

  /**
   * @description Maps the MCP settings object into a compact server summary list.
   * @param mcpSettings - Raw MCP settings payload.
   * @returns Normalized MCP server list.
   */
  private mapMcpServers(
    mcpSettings: Record<string, unknown>,
  ): AgentStartupManifest['mcp']['servers'] {
    const servers = this.readNestedObject(mcpSettings.mcpServers);

    return Object.entries(servers).map(([name, rawConfig]) => {
      const serverConfig = this.readNestedObject(rawConfig);
      const url = this.readString(serverConfig.url);
      const command = this.readString(serverConfig.command);
      const args = this.readStringArray(serverConfig.args);

      if (url) {
        return { name, transport: 'remote' as const, summary: `${name}: remote endpoint ${url}`, url };
      }
      if (command) {
        return {
          name,
          transport: 'stdio' as const,
          summary: `${name}: ${command}${args.length > 0 ? ` ${args.join(' ')}` : ''}`,
          command,
          args,
        };
      }
      return { name, transport: 'configured' as const, summary: `${name}: configured` };
    });
  }

  /**
   * @description Persists the manifest JSON to the task workspace.
   * @param manifestPath - Absolute manifest path.
   * @param manifest - Manifest payload.
   */
  private writeManifest(manifestPath: string, manifest: AgentStartupManifest): void {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  /**
   * @description Normalizes unknown tool config payloads into plain objects.
   * @param value - Raw persisted tool config.
   * @returns Object representation.
   */
  private readToolConfig(value: unknown): Record<string, unknown> {
    return this.readNestedObject(value);
  }

  /**
   * @description Returns true when a tool has non-empty runtime configuration beyond default placeholders.
   * @param config - Raw tool config object.
   * @returns Whether the tool has meaningful runtime configuration.
   */
  private hasMeaningfulConfig(config: Record<string, unknown>): boolean {
    const endpoint = this.readNestedObject(config.endpoint);
    const metadata = this.readNestedObject(config.metadata);
    const auth = this.readNestedObject(config.auth);
    return Boolean(
      this.readString(endpoint.url)
      || this.readString(endpoint.baseUrl)
      || this.readString(auth.type)
      || auth.enabled === true
      || Object.keys(metadata).length > 0,
    );
  }

  /**
   * @description Reads a nested plain object from unknown input.
   * @param value - Raw value.
   * @returns Object value or empty object.
   */
  private readNestedObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  /**
   * @description Reads a trimmed string from unknown input.
   * @param value - Raw value.
   * @returns Trimmed string or undefined.
   */
  private readString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  /**
   * @description Reads a string array from unknown input.
   * @param value - Raw value.
   * @returns Filtered string array.
   */
  private readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  }
}
