/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted tool prompt/context assembly helpers from the oversized composition root
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Switched Layer-1 chat profile context loading to dedicated persisted agent-profile service with legacy fallback
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added direct rag-query runtime tool and aligned executable registry with Chroma-backed retrieval
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Wrapped loadPromptProfile Postgres call with try/catch fallback so agentic loop survives without database
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added dynamic persona YAML loading in createSystemPromptResolver — loads bot identity from ai-lab/bot-personas/ when agentId differs from default
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Exported writePersonaContextFile for swarm execution path integration — enables role context file generation in swarm processing
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Included persona system_prompt in workspace context files so spec-driven swarm personas keep their operating procedure
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import type { AgentProfileService } from '@/features/agent-profile';
import {
  filterRegistryToolsByCapabilities,
  filterRuntimeToolDefinitionsByCapabilities,
  type LLMToolDefinition,
  type ToolCapabilityScope,
} from '@/features/llm-provider';
import type { Tool, AgentTool } from '@/shared/types/tool';
import type { SwitchFrameworkService } from '@/features/tool-switch';
// eslint-disable-next-line no-restricted-imports -- two-runtimes: LLM execution runtime, deliberately off the barrel graph (barrel split, TODO-BOUNDARY-FINDING)
import { ClineRuntimeConfigSyncService } from '@/features/llm-provider/services';
import { readChatAgentProfileConfig, readJsonConfig, parseSelectorSkills, readNonEmptyString, runtimeDefaults } from './provider-runtime';
import fs from 'fs';
import path from 'path';
import { loadPersonaFromFile } from '@/features/swarm-orchestration';
import { createChildLogger } from '@/shared/logger';
import type { DynamicToolExecutorRegistry } from '@/features/tool-registry';
import {
  resolveAgentCapabilityScope,
  resolveAgentCapabilitiesFromSwarmRegistry,
  type AgentCapabilityResolver,
} from './agent-capability-resolver';

const personaLogger = createChildLogger({ module: 'persona-prompt-resolver' });

const DEFAULT_TOOL_CACHE_TTL_MS = 15000;
const MAX_PROMPT_TOOLS = 24;
const EXECUTABLE_REGISTRY_TOOL_NAMES = new Set([
  'presentron',
  'rag-ingestion',
  'rag-query',
  'gogcli',
  'finance-import',
  'finance-report',
  'analyze-spending',
  'check-budget',
  'workflow-studio',
]);
const SERVER_EXECUTABLE_TOOL_FALLBACKS: LLMToolDefinition[] = [
  {
    name: 'list_directory',
    description: 'List files and folders at a path to inspect workspace structure.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'read_file',
    description: 'Read file contents from the workspace.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'search_files',
    description: 'Search workspace files by pattern or glob.',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
  },
  {
    name: 'write_to_file',
    description: 'Create or overwrite a file with complete content.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'replace_in_file',
    description: 'Perform targeted search/replace edits inside an existing file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        search: { type: 'string' },
        replace: { type: 'string' },
      },
      required: ['path', 'search', 'replace'],
    },
  },
  {
    name: 'execute_command',
    description: 'Run shell commands in the task workspace and inspect output.',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  {
    name: 'ask_followup_question',
    description: 'Ask the user a focused clarification question before proceeding.',
    input_schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  },
  {
    name: 'presentron',
    description: 'Generate presentation artifacts through the Presentron integration.',
    input_schema: { type: 'object', properties: { request: { type: 'object' } } },
  },
  {
    name: 'rag-ingestion',
    description: 'Ingest content into the configured RAG ingestion endpoint, or the built-in ChromaDB-backed RAG service when no endpoint override is set.',
    input_schema: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        format: { type: 'string' },
        content: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['format', 'content'],
    },
  },
  {
    name: 'rag-query',
    description: 'Query the built-in ChromaDB-backed RAG search engine directly. When no collection is supplied, search runs across all collections.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        collection: { type: 'string' },
        topK: { type: 'integer' },
      },
      required: ['query'],
    },
  },
  {
    name: 'gogcli',
    description: 'Execute Google Workspace actions through the repo-native Google Workspace CLI. Supports Gmail, Docs, Sheets, Slides, Drive, Calendar, and related Google Workspace products.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        json: { type: 'boolean' },
        timeoutMs: { type: 'integer' },
      },
    },
  },
  {
    name: 'finance-import',
    description: 'Import transaction data into the personal-finance bot ledger from workspace CSV/JSON files or inline transaction objects.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' } },
        source: { type: 'string' },
        transactions: { type: 'array', items: { type: 'object' } },
      },
    },
  },
  {
    name: 'finance-report',
    description: 'Generate a Markdown finance report from the imported personal-finance ledger and write it to the task workspace.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        category: { type: 'string' },
        lookbackDays: { type: 'integer' },
        alertThreshold: { type: 'integer' },
        outputPath: { type: 'string' },
      },
    },
  },
  {
    name: 'analyze-spending',
    description: 'Analyze category totals, merchant concentration, monthly spend, and unusual transactions from the personal-finance ledger.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        lookbackDays: { type: 'integer' },
        alertThreshold: { type: 'integer' },
      },
    },
  },
  {
    name: 'check-budget',
    description: 'Compare personal-finance spending against configured budget targets and return an at-a-glance budget status summary.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        lookbackDays: { type: 'integer' },
        alertThreshold: { type: 'integer' },
      },
    },
  },
  {
    name: 'workflow-studio',
    description: 'Design, validate, compile, and manage swarm workflow definitions. Actions: getCatalog, listDefinitions, createDefinition, getDefinition, saveDefinition, validateDefinition, compileDefinition, duplicateDefinition, listVersions, getVersion, forkVersion. Every workflow needs one start node and at least one deliver or escalate terminal. Parallel-split nodes need matching parallel-join nodes. AI-decision and logic-gate nodes need 2+ labeled outgoing edges. Always validate before compiling.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['getCatalog', 'listDefinitions', 'getDefinition', 'createDefinition', 'saveDefinition', 'validateDefinition', 'compileDefinition', 'duplicateDefinition', 'listVersions', 'getVersion', 'forkVersion'],
          description: 'The workflow studio operation to perform',
        },
        definitionId: { type: 'string', description: 'Workflow definition UUID (required for most operations)' },
        version: { type: 'number', description: 'Version number (for version-specific operations)' },
        name: { type: 'string', description: 'Workflow name (for create/duplicate)' },
        description: { type: 'string', description: 'Workflow description' },
        nodes: { type: 'array', description: 'Array of workflow nodes with id, type, title, position, config' },
        edges: { type: 'array', description: 'Array of workflow edges with id, source, target, optional label/condition' },
      },
      required: ['action'],
    },
  },
  {
    name: 'attempt_completion',
    description: 'Report task completion once implementation and verification are done.',
    input_schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
  },
];

/**
 * @description Parses positive integers with fallback.
 * @param rawValue - Raw env string.
 * @param fallback - Default integer.
 * @returns Positive integer.
 */
export function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) {
    return fallback;
  }
  const parsed = parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * @description Normalizes raw tool schemas into LLM-compatible JSON schema objects.
 * @param schema - Raw input schema.
 * @param logger - Scoped logger.
 * @returns Tool schema object.
 */
export function normalizeToolInputSchema(
  schema: unknown,
  logger: { error: (payload: Record<string, unknown>, message: string) => void },
): Record<string, unknown> {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    return schema as Record<string, unknown>;
  }
  if (typeof schema === 'string' && schema.trim().length > 0) {
    try {
      const parsed = JSON.parse(schema) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (error) {
      logger.error({ err: error as Error, schemaPreview: schema.slice(0, 200) }, 'Failed to parse tool input schema');
    }
  }
  return { type: 'object', properties: {} };
}

/**
 * @description Maps a persisted tool row into an LLM tool definition.
 * @param tool - Tool registry record.
 * @param logger - Scoped logger.
 * @returns LLM tool definition.
 */
export function mapToolToLLMDefinition(
  tool: Tool,
  logger: { error: (payload: Record<string, unknown>, message: string) => void },
): LLMToolDefinition {
  const skillText = tool.skills.length > 0 ? ` Skills: ${tool.skills.join(', ')}.` : '';
  const usageText = tool.usageInstructions ? ` Usage: ${tool.usageInstructions}` : '';
  return {
    name: tool.name,
    description: `${tool.description}${skillText}${usageText}`.trim(),
    input_schema: normalizeToolInputSchema(tool.inputSchema, logger),
  };
}

/**
 * @description Merges registry and fallback tool definitions by unique name.
 * @param registryTools - Persisted tool definitions.
 * @param fallbackTools - Built-in tool definitions.
 * @returns Deduplicated merged tool list.
 */
export function mergeToolDefinitions(
  registryTools: LLMToolDefinition[],
  fallbackTools: LLMToolDefinition[],
): LLMToolDefinition[] {
  const merged = new Map<string, LLMToolDefinition>();
  for (const tool of registryTools) {
    merged.set(tool.name, tool);
  }
  for (const tool of fallbackTools) {
    if (!merged.has(tool.name)) {
      merged.set(tool.name, tool);
    }
  }
  return Array.from(merged.values());
}

/**
 * @description Formats callable runtime tools for the Layer-0 prompt section.
 * @param tools - Runtime tools.
 * @returns Compact prompt appendix.
 */
export function formatToolsForPrompt(tools: LLMToolDefinition[]): string {
  if (tools.length === 0) {
    return 'Callable runtime tools:\nNo callable runtime tools are currently enabled.';
  }

  const limited = tools.slice(0, MAX_PROMPT_TOOLS);
  const lines = limited.map((tool, index) => `${index + 1}. ${tool.name}: ${tool.description}`);
  const overflow = tools.length > limited.length
    ? `\nAdditional tools available: ${tools.length - limited.length} (not listed to keep prompt compact).`
    : '';
  return `Callable runtime tools:\n${lines.join('\n')}${overflow}`;
}

/**
 * @description Summarizes one MCP server config for prompt/UI diagnostics.
 * @param serverName - MCP server name.
 * @param serverConfig - MCP server config.
 * @returns Human-readable summary.
 */
export function summarizeMcpServer(serverName: string, serverConfig: Record<string, unknown>): string {
  const url = readNonEmptyString(serverConfig.url);
  if (url) {
    return `${serverName}: remote endpoint ${url}`;
  }

  const command = readNonEmptyString(serverConfig.command);
  const args = Array.isArray(serverConfig.args)
    ? serverConfig.args.filter((value): value is string => typeof value === 'string')
    : [];

  if (command) {
    return `${serverName}: ${command}${args.length > 0 ? ` ${args.join(' ')}` : ''}`;
  }

  return `${serverName}: configured`;
}

/**
 * @description Formats the layered system prompt from runtime tools, chat profile, enabled tools, and MCP settings.
 * @param tools - Callable runtime tools.
 * @param profile - Chat profile settings.
 * @param enabledAgentTools - Enabled switch-framework tools.
 * @param mcpSettings - MCP settings payload.
 * @returns Full layered prompt string.
 */
export function formatLayeredSystemPrompt(
  tools: LLMToolDefinition[],
  profile: { name: string; projectUrl?: string; selectorSkillsText?: string; avatarUrl?: string },
  enabledAgentTools: AgentTool[],
  mcpSettings: Record<string, unknown>,
  basePrompt?: string,
): string {
  const sections = [
    basePrompt ?? runtimeDefaults.level0SystemPrompt,
    formatToolsForPrompt(tools),
  ];

  const contextLines: string[] = [];
  const selectorSkills = parseSelectorSkills(profile.selectorSkillsText);

  contextLines.push(`Chat agent profile: ${profile.name}`);
  if (profile.projectUrl) {
    contextLines.push(`Project URL: ${profile.projectUrl}`);
  }
  if (selectorSkills.length > 0) {
    contextLines.push(`Additional selector skills: ${selectorSkills.join(', ')}`);
  }
  if (profile.avatarUrl) {
    contextLines.push(`Profile avatar reference: ${profile.avatarUrl}`);
  }

  if (enabledAgentTools.length > 0) {
    const toolLines = enabledAgentTools.slice(0, MAX_PROMPT_TOOLS).map((tool, index) => {
      const skillText = tool.tool.skills.length > 0 ? ` Skills: ${tool.tool.skills.join(', ')}.` : '';
      return `${index + 1}. ${tool.tool.displayName} [${tool.authMode}] - ${tool.tool.description}.${skillText}`;
    });

    contextLines.push(
      'Enabled framework tools inform planning. Use `execute_command` when these CLIs are available in the workspace shell:\n'
      + toolLines.join('\n'),
    );
  }

  const rawMcpServers = mcpSettings.mcpServers;
  if (rawMcpServers && typeof rawMcpServers === 'object' && !Array.isArray(rawMcpServers)) {
    const mcpServers = Object.entries(rawMcpServers as Record<string, Record<string, unknown>>);
    if (mcpServers.length > 0) {
      const mcpLines = mcpServers
        .slice(0, MAX_PROMPT_TOOLS)
        .map(([name, config], index) => `${index + 1}. ${summarizeMcpServer(name, config)}`);
      contextLines.push(
        'Configured MCP servers (informational context for this server-side loop):\n'
        + mcpLines.join('\n'),
      );
    }
  }

  sections.push(
    contextLines.length > 0
      ? `Layer-1 environment and skill context:\n${contextLines.join('\n')}`
      : 'Layer-1 environment and skill context:\nNo additional environment context configured.',
  );

  return sections.join('\n\n');
}

/**
 * @description Creates an async tool resolver with a short-lived cache.
 * @param toolRegistryService - Registry service dependency.
 * @param compositionLogger - Scoped logger.
 * @returns Resolver function for runtime LLM tools.
 */
export function createToolResolver(
  toolRegistryService: { getAllTools: (filters: { enabled: boolean; limit: number; offset: number }) => Promise<Tool[]> },
  compositionLogger: {
    info: (payload: Record<string, unknown>, message: string) => void;
    error: (payload: Record<string, unknown>, message: string) => void;
  },
  dynamicToolExecutorRegistry?: DynamicToolExecutorRegistry,
  agentCapabilityResolver: AgentCapabilityResolver = resolveAgentCapabilitiesFromSwarmRegistry,
): (agentId?: string) => Promise<LLMToolDefinition[]> {
  const cacheTtlMs = parsePositiveInt(process.env.TOOL_PROMPT_CACHE_TTL_MS, DEFAULT_TOOL_CACHE_TTL_MS);
  const cache = new Map<string, { expiresAt: number; tools: LLMToolDefinition[] }>();
  const fallbackTools = mergeToolDefinitions([], SERVER_EXECUTABLE_TOOL_FALLBACKS);

  return async (agentId?: string): Promise<LLMToolDefinition[]> => {
    const scope = await resolveAgentCapabilityScope(agentId, agentCapabilityResolver);
    const cacheKey = buildToolCacheKey(scope);
    const now = Date.now();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.tools;
    }

    try {
      const tools = await toolRegistryService.getAllTools({ enabled: true, limit: 500, offset: 0 });
      const executableToolNames = new Set(EXECUTABLE_REGISTRY_TOOL_NAMES);
      for (const descriptor of dynamicToolExecutorRegistry?.listAll() ?? []) {
        executableToolNames.add(descriptor.toolName);
      }
      const registryTools = filterRegistryToolsByCapabilities(
        tools.filter((tool) => executableToolNames.has(tool.name)),
        scope,
      )
        .map((tool) => mapToolToLLMDefinition(tool, compositionLogger));
      const scopedFallbackTools = filterRuntimeToolDefinitionsByCapabilities(SERVER_EXECUTABLE_TOOL_FALLBACKS, scope);
      const mergedTools = mergeToolDefinitions(registryTools, scopedFallbackTools);
      cache.set(cacheKey, { expiresAt: now + cacheTtlMs, tools: mergedTools });
      compositionLogger.info(
        {
          source: 'registry',
          agentId: scope.agentId ?? null,
          scopedCapabilityCount: scope.capabilities?.length ?? 0,
          scopedRoutingKeywordCount: scope.routingKeywords?.length ?? 0,
          registryToolCount: registryTools.length,
          fallbackToolCount: scopedFallbackTools.length,
          mergedToolCount: mergedTools.length,
          cacheTtlMs,
        },
        'Loaded runtime tool definitions',
      );
      return mergedTools;
    } catch (error) {
      const scopedFallbackTools = filterRuntimeToolDefinitionsByCapabilities(
        cached?.tools ?? fallbackTools,
        scope,
      );
      cache.set(cacheKey, { expiresAt: now + Math.floor(cacheTtlMs / 2), tools: scopedFallbackTools });
      compositionLogger.error(
        {
          err: error as Error,
          source: 'fallback',
          agentId: scope.agentId ?? null,
          scopedCapabilityCount: scope.capabilities?.length ?? 0,
          fallbackToolCount: scopedFallbackTools.length,
          cachedToolCount: cached?.tools.length ?? 0,
          cacheTtlMs: Math.floor(cacheTtlMs / 2),
        },
        'Failed to load runtime tool definitions; using fallback tool set',
      );
      return scopedFallbackTools;
    }
  };
}

function buildToolCacheKey(scope: ToolCapabilityScope): string {
  const capabilities = [
    ...(scope.capabilities ?? []),
    ...(scope.routingKeywords ?? []),
  ]
    .map((capability) => capability.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  if (capabilities.length === 0) {
    return 'legacy-unscoped';
  }
  return `${scope.agentId ?? 'scoped'}:${capabilities.join('|')}`;
}

/**
 * @description Creates the async system prompt resolver used by the orchestrator.
 * @param switchFrameworkService - Tool-switch service.
 * @param agentProfileService - Dedicated persisted agent-profile service.
 * @param compositionLogger - Scoped logger.
 * @param defaults - Default agent identifiers.
 * @returns Layered system prompt resolver.
 */
export function createSystemPromptResolver(
  switchFrameworkService: SwitchFrameworkService,
  agentProfileService: AgentProfileService,
  compositionLogger: { error: (payload: Record<string, unknown>, message: string) => void },
  defaults: { agentId: string; agentName: string },
): (agentId?: string, tools?: LLMToolDefinition[], taskId?: string) => Promise<string> {
  const runtimeConfigSyncService = new ClineRuntimeConfigSyncService();

  return async (agentId = defaults.agentId, tools: LLMToolDefinition[] = [], taskId?: string): Promise<string> => {
    const profile = await loadPromptProfile(agentProfileService, agentId, defaults);
    const mcpSettings = runtimeConfigSyncService.readMcpSettings();
    let enabledAgentTools: AgentTool[] = [];

    try {
      const agentTools = await switchFrameworkService.getAgentTools(agentId);
      enabledAgentTools = agentTools.filter((tool) => tool.authMode !== 'off');
    } catch (error) {
      compositionLogger.error({ err: error as Error, agentId }, 'Failed to load switch-framework tool context for prompt');
    }

    /* ── Dynamic persona loading from YAML files ──────────────── */
    let basePrompt: string | undefined;

    if (agentId !== defaults.agentId) {
      try {
        const persona = loadPersonaFromFile(agentId);
        if (persona && persona.perspective) {
          /* ── Write persona to workspace file (legacy pattern) ─── */
          const contextFileName = `${persona.name || agentId}-context.md`;
          const fileWritten = writePersonaContextFile(agentId, persona, contextFileName, taskId);

          if (fileWritten) {
            /* Minimal system prompt — agent reads full identity from file */
            basePrompt = [
              `# YOUR IDENTITY`,
              `You are **${persona.name || agentId}** — ${persona.role || 'AI assistant'}.`,
              '',
              `Your detailed role and perspective are in \`${contextFileName}\` — read it with the read_file tool to ground yourself, then engage naturally.`,
              '',
              `You are a skilled professional with a personality. When someone talks to you, talk back like a human colleague would.`,
              `If someone says hi, say hi back. Have a conversation. You are not a robot reporting status — you are a team member.`,
            ].join('\n');
            personaLogger.info(
              { agentId, personaName: persona.name, contextFileName, perspectiveLength: persona.perspective.length },
              'Wrote persona context file to workspace — system prompt uses read-file instruction',
            );
          } else {
            /* Fallback: embed full persona in prompt when file write fails */
            const parts: string[] = [];
            parts.push(`# YOUR IDENTITY AND ROLE`);
            parts.push(`You are **${persona.name || agentId}** — ${persona.role || 'AI assistant'}.`);
            parts.push('');
            parts.push(persona.perspective);
            parts.push('');
            if (persona.systemPrompt && persona.systemPrompt.trim().length > 0) {
              parts.push('## REQUIRED OPERATING PROCEDURE');
              parts.push(persona.systemPrompt.trim());
              parts.push('');
            }
            if (persona.capabilities && persona.capabilities.length > 0) {
              parts.push('## YOUR CAPABILITIES');
              persona.capabilities.forEach((cap: string) => parts.push(`- ${cap}`));
              parts.push('');
            }
            basePrompt = parts.join('\n');
            personaLogger.warn(
              { agentId, personaName: persona.name },
              'Failed to write persona context file — embedding full persona in system prompt',
            );
          }
        }
      } catch (error) {
        personaLogger.warn(
          { err: error as Error, agentId },
          'Failed to load persona YAML — falling back to default system prompt',
        );
      }
    }

    return formatLayeredSystemPrompt(tools, profile, enabledAgentTools, mcpSettings, basePrompt);
  };
}

/**
 * @description Writes the full persona content to a context file in the shared workspace
 * so the agent can read it via read_file tool (legacy pattern — keeps system prompt small).
 *
 * @param agentId - Agent identifier for logging.
 * @param persona - Loaded persona object with perspective and capabilities.
 * @param contextFileName - Filename to write (e.g., 'devops-bot-context.md').
 * @param taskId - Optional task identifier for scoped workspace directory
 * @returns True when the file was written successfully.
 */
export function writePersonaContextFile(
  agentId: string,
  persona: { name: string; role: string; perspective: string; systemPrompt?: string; capabilities?: string[] },
  contextFileName: string,
  taskId?: string,
): boolean {
  try {
    const workspaceRoot = process.env.CLINE_WORKSPACE_ROOT
      || process.env.WORKSPACE_ROOT
      || path.resolve(process.cwd(), 'workspace');

    /* Write to the per-task workspace so the agent's sandboxed read_file can find it */
    const targetDir = taskId
      ? path.join(workspaceRoot, taskId.trim().replace(/[^a-zA-Z0-9-_]/g, '_'))
      : workspaceRoot;
    fs.mkdirSync(targetDir, { recursive: true });
    const contextFilePath = path.join(targetDir, contextFileName);

    const parts: string[] = [];
    parts.push(`# YOUR IDENTITY AND ROLE`);
    parts.push(`You are **${persona.name || agentId}** — ${persona.role || 'AI assistant'}.`);
    parts.push('');
    parts.push(persona.perspective);
    parts.push('');
    if (persona.systemPrompt && persona.systemPrompt.trim().length > 0) {
      parts.push('## REQUIRED OPERATING PROCEDURE');
      parts.push(persona.systemPrompt.trim());
      parts.push('');
    }
    if (persona.capabilities && persona.capabilities.length > 0) {
      parts.push('## YOUR CAPABILITIES');
      persona.capabilities.forEach((cap: string) => parts.push(`- ${cap}`));
      parts.push('');
    }
    parts.push('---');
    parts.push('');
    parts.push('After reading this file, respond to the user in character according to the identity and guidelines above.');

    fs.writeFileSync(contextFilePath, parts.join('\n'), 'utf8');
    personaLogger.info(
      { agentId, contextFilePath, contentLength: parts.join('\n').length },
      'Wrote persona context file to workspace',
    );
    return true;
  } catch (error) {
    personaLogger.error(
      { err: error as Error, agentId, contextFileName },
      'Failed to write persona context file to workspace',
    );
    return false;
  }
}

/**
 * @description Loads the Layer-1 prompt profile from persisted agent storage with legacy config fallback.
 * @param agentProfileService - Dedicated persisted agent-profile service.
 * @param agentId - Active agent identifier.
 * @param defaults - Default standalone chat agent identity.
 * @returns Prompt-ready profile context.
 */
async function loadPromptProfile(
  agentProfileService: AgentProfileService,
  agentId: string,
  defaults: { agentId: string; agentName: string },
): Promise<{ name: string; projectUrl?: string; selectorSkillsText?: string; avatarUrl?: string }> {
  try {
    const profile = await agentProfileService.getAgentProfile(agentId);
    if (profile) {
      return {
        name: profile.name || defaults.agentName,
        projectUrl: profile.projectUrl,
        selectorSkillsText: profile.selectorSkillsText,
        avatarUrl: profile.avatarUrl,
      };
    }
  } catch (_error) {
    /* Postgres unavailable — fall through to config-based profile */
  }

  const configDir = process.env.CONFIG_OUTPUT_DIR || './output';
  const settingsPath = `${configDir}/global-config.json`;
  const settings = readJsonConfig(settingsPath) ?? {};
  return readChatAgentProfileConfig(settings, defaults.agentId, defaults.agentName);
}
