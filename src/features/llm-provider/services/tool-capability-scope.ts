import type { LLMToolDefinition } from './llm-service';
import type { Tool } from '@/shared/types/tool';

/**
 * @description Capability scope used to keep prompts and MCP sessions lean for a bot.
 */
export interface ToolCapabilityScope {
  agentId?: string | null;
  capabilities?: string[] | null;
  routingKeywords?: string[] | null;
  selectorDescriptor?: string | null;
}

export interface AgentSelectorResolution {
  capabilities?: string[] | null;
  routingKeywords?: string[] | null;
  selectorDescriptor?: string | null;
}

export type AgentCapabilityResolver = (
  agentId: string,
) => Promise<string[] | AgentSelectorResolution | null> | string[] | AgentSelectorResolution | null;

const CORE_RUNTIME_TOOL_NAMES = new Set([
  'list_directory',
  'read_file',
  'search_files',
  'write_to_file',
  'replace_in_file',
  'execute_command',
  'ask_followup_question',
  'attempt_completion',
]);

const CAPABILITY_ALIASES: Record<string, string[]> = {
  qa: ['testing', 'verification', 'test-automation'],
  testing: ['qa', 'verification', 'test-automation'],
  documentation: ['readme', 'adr', 'technical-writing', 'knowledge-management'],
  research: ['analysis', 'investigation', 'web-search'],
  presentation: ['slides', 'presentation-outline', 'pitch-decks', 'deck-guidance'],
  slides: ['presentation'],
  finance: ['financial-analysis', 'financial-aggregation', 'spending-analysis', 'budgeting'],
  devops: ['infrastructure', 'cicd', 'deployment', 'monitoring'],
  infrastructure: ['devops', 'monitoring', 'deployment'],
  coding: ['implementation', 'debugging', 'refactoring', 'feature-development'],
  implementation: ['coding', 'debugging', 'feature-development'],
  orchestration: ['workflow', 'workflow-studio', 'task-decomposition'],
  workflow: ['orchestration', 'workflow-studio', 'process-design'],
  'rag-query': ['research', 'knowledge-management', 'knowledge-indexing'],
};

const RUNTIME_TOOL_CAPABILITY_TAGS: Record<string, string[]> = {
  presentron: ['presentation', 'slides', 'presentation-outline', 'pitch-decks', 'reporting', 'visualization'],
  'rag-ingestion': ['rag-ingestion', 'knowledge-indexing', 'content-indexing', 'knowledge-management', 'pdf-ingestion'],
  'rag-query': ['rag-query', 'research', 'knowledge-management', 'knowledge-indexing', 'tutoring'],
  gogcli: ['google-workspace', 'gmail', 'docs', 'sheets', 'slides', 'drive', 'calendar', 'scheduling'],
  'finance-import': ['finance', 'financial-aggregation', 'spending-analysis', 'portfolio-review'],
  'finance-report': ['finance', 'financial-analysis', 'reporting', 'spending-analysis'],
  'analyze-spending': ['finance', 'spending-analysis', 'budgeting'],
  'check-budget': ['finance', 'budgeting', 'spending-analysis'],
  'workflow-studio': ['workflow', 'workflow-studio', 'orchestration', 'architecture', 'design', 'system-modeling'],
};

const MCP_SERVER_CAPABILITY_TAGS: Record<string, string[]> = {
  filesystem: ['coding', 'implementation', 'debugging', 'documentation', 'architecture', 'devops', 'testing'],
  fetch: ['web-search', 'research', 'product-search', 'restaurant-search', 'travel', 'news-ingestion'],
  playwright: ['testing', 'test-automation', 'qa', 'ats-scraping', 'browser-automation', 'web-search'],
  context7: ['coding', 'documentation', 'architecture', 'research'],
  'google-search-mcp': ['web-search', 'research', 'competitive-analysis', 'market-research', 'world-query', 'news-ingestion'],
  'presentron-mcp': ['presentation', 'slides', 'presentation-outline', 'pitch-decks', 'reporting', 'visualization'],
  'plane-mcp': ['workflow', 'orchestration', 'planning', 'ticket', 'project-management'],
  'chroma-mcp': ['rag-query', 'research', 'knowledge-management', 'knowledge-indexing', 'content-indexing'],
  'splunk-mcp': ['splunk-query', 'log-analysis', 'incident', 'monitoring', 'root-cause-analysis'],
  'servicenow-mcp': ['servicenow-query', 'incident-response', 'runbook-execution', 'stakeholder-communication'],
};

/**
 * @description Normalizes capability identifiers for set comparisons.
 */
export function normalizeCapability(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

/**
 * @description Returns true when a bot supplied a non-empty capability scope.
 */
export function hasCapabilityScope(scope?: ToolCapabilityScope | null): boolean {
  return buildCapabilitySet(scope).size > 0;
}

/**
 * @description Filters LLM tool definitions by bot capability scope.
 */
export function filterRuntimeToolDefinitionsByCapabilities<T extends LLMToolDefinition>(
  tools: T[],
  scope?: ToolCapabilityScope | null,
): T[] {
  const capabilities = buildCapabilitySet(scope);
  if (capabilities.size === 0) {
    return tools;
  }
  return tools.filter((tool) => runtimeToolMatchesCapabilities(tool, capabilities));
}

/**
 * @description Filters persisted registry tools by bot capability scope.
 */
export function filterRegistryToolsByCapabilities<T extends Tool>(
  tools: T[],
  scope?: ToolCapabilityScope | null,
): T[] {
  const capabilities = buildCapabilitySet(scope);
  if (capabilities.size === 0) {
    return tools;
  }
  return tools.filter((tool) => runtimeToolMatchesCapabilities(tool, capabilities));
}

/**
 * @description Filters MCP settings to only the servers matching the bot capability scope.
 */
export function filterMcpSettingsByCapabilities(
  settings: Record<string, unknown>,
  scope?: ToolCapabilityScope | null,
): Record<string, unknown> {
  const capabilities = buildCapabilitySet(scope);
  if (capabilities.size === 0) {
    return settings;
  }

  const rawServers = settings.mcpServers;
  if (!rawServers || typeof rawServers !== 'object' || Array.isArray(rawServers)) {
    return settings;
  }

  const scopedServers: Record<string, unknown> = {};
  for (const [name, config] of Object.entries(rawServers as Record<string, unknown>)) {
    if (mcpServerMatchesCapabilities(name, config, capabilities)) {
      scopedServers[name] = config;
    }
  }

  return {
    ...settings,
    mcpServers: scopedServers,
  };
}

function runtimeToolMatchesCapabilities(tool: LLMToolDefinition | Tool, capabilities: Set<string>): boolean {
  const name = readString((tool as { name?: unknown }).name);
  if (!name) {
    return false;
  }
  if (CORE_RUNTIME_TOOL_NAMES.has(name)) {
    return true;
  }

  const tags = [
    ...identifierTags(name),
    ...(RUNTIME_TOOL_CAPABILITY_TAGS[normalizeCapability(name)] ?? []),
    ...readStringArray((tool as Partial<Tool>).skills),
    ...readStringArray((tool as Partial<Tool>).routingTags),
    ...readStringArray((tool as Partial<Tool>).tags),
    readString((tool as Partial<Tool>).category),
    readString((tool as Partial<Tool>).authGroup),
  ].filter((value): value is string => Boolean(value));

  return tagsMatchCapabilities(tags, capabilities);
}

function mcpServerMatchesCapabilities(name: string, rawConfig: unknown, capabilities: Set<string>): boolean {
  const config = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
    ? rawConfig as Record<string, unknown>
    : {};
  const tags = [
    ...identifierTags(name),
    ...(MCP_SERVER_CAPABILITY_TAGS[normalizeCapability(name)] ?? []),
    ...readStringArray(config.capabilities),
    ...readStringArray(config.oshalCapabilities),
    readString(config.category),
  ].filter((value): value is string => Boolean(value));

  return tagsMatchCapabilities(tags, capabilities);
}

function buildCapabilitySet(scope?: ToolCapabilityScope | null): Set<string> {
  const values = [
    ...(scope?.capabilities ?? []),
    ...(scope?.routingKeywords ?? []),
  ];
  const normalized = new Set<string>();
  for (const value of values) {
    const capability = normalizeCapability(value);
    if (!capability) {
      continue;
    }
    normalized.add(capability);
    for (const alias of CAPABILITY_ALIASES[capability] ?? []) {
      normalized.add(normalizeCapability(alias));
    }
  }
  return normalized;
}

function tagsMatchCapabilities(tags: string[], capabilities: Set<string>): boolean {
  const normalizedTags = new Set<string>();
  for (const tag of tags) {
    const normalized = normalizeCapability(tag);
    if (!normalized) {
      continue;
    }
    normalizedTags.add(normalized);
    for (const alias of CAPABILITY_ALIASES[normalized] ?? []) {
      normalizedTags.add(normalizeCapability(alias));
    }
  }

  for (const tag of normalizedTags) {
    for (const capability of capabilities) {
      if (tag === capability || tag.startsWith(`${capability}-`) || capability.startsWith(`${tag}-`)) {
        return true;
      }
    }
  }
  return false;
}

function identifierTags(value: string): string[] {
  const normalized = normalizeCapability(value);
  return [
    normalized,
    ...normalized.split(/[-:./]+/).filter(Boolean),
  ];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}
