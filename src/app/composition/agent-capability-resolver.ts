import type {
  AgentCapabilityResolver,
  AgentSelectorResolution,
  ToolCapabilityScope,
} from '@/features/llm-provider';

export type { AgentCapabilityResolver, AgentSelectorResolution };

export interface AgentSelectorResolverSources {
  getComposedSelector?: (agentId: string) => Promise<AgentSelectorResolution | null>;
  getAgentProfile?: (agentId: string) => Promise<AgentSelectorResolution | null>;
}

/**
 * @description Resolves an agent's selector signal from the active swarm registry.
 */
export function resolveAgentCapabilitiesFromSwarmRegistry(agentId?: string | null): AgentSelectorResolution | null {
  const normalizedAgentId = readIdentifier(agentId);
  const botName = readIdentifier(process.env.BOT_NAME) ?? readIdentifier(process.env.AGENT_ID);
  if (!normalizedAgentId && !botName) {
    return null;
  }

  try {
    // Dynamic import avoids making the composition helpers initialize the swarm registry eagerly.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getActiveRegistry } = require('@/app/extensions/swarm/swarm-bot-registry');
    const registry = getActiveRegistry() as Array<{
      agentId?: string;
      name?: string;
      capabilities?: string[];
      routingKeywords?: string[];
      selectorDescriptor?: string;
    }>;
    const entry = registry.find((bot) => normalizedAgentId && bot.agentId === normalizedAgentId)
      ?? registry.find((bot) => normalizedAgentId && bot.name === normalizedAgentId)
      ?? registry.find((bot) => botName && bot.name === botName)
      ?? registry.find((bot) => botName && bot.agentId === botName);

    return normalizeResolution({
      capabilities: entry?.capabilities,
      routingKeywords: entry?.routingKeywords,
      selectorDescriptor: entry?.selectorDescriptor,
    });
  } catch {
    return null;
  }
}

/**
 * @description Builds the runtime selector resolver. Persisted composed selectors win;
 * manifest/registry declarations are the fallback so boot-time agents still scope tools.
 */
export function createAgentSelectorCapabilityResolver(
  sources: AgentSelectorResolverSources = {},
  fallbackResolver: AgentCapabilityResolver = resolveAgentCapabilitiesFromSwarmRegistry,
): AgentCapabilityResolver {
  return async (agentId: string) => {
    const composed = sources.getComposedSelector
      ? await sources.getComposedSelector(agentId).catch(() => null)
      : null;
    const profile = !composed && sources.getAgentProfile
      ? await sources.getAgentProfile(agentId).catch(() => null)
      : null;
    const persisted = composed ?? profile;
    const fallback = await Promise.resolve(fallbackResolver(agentId)).catch(() => null);
    return mergeResolutions(persisted, fallback);
  };
}

/**
 * @description Builds a capability scope for one agent using an optional override resolver.
 */
export async function resolveAgentCapabilityScope(
  agentId?: string | null,
  resolver: AgentCapabilityResolver = resolveAgentCapabilitiesFromSwarmRegistry,
): Promise<ToolCapabilityScope> {
  const normalizedAgentId = readIdentifier(agentId);
  if (!normalizedAgentId) {
    return {};
  }

  const capabilities = await Promise.resolve(resolver(normalizedAgentId)).catch(() => null);
  const resolution = normalizeResolution(capabilities);
  return {
    agentId: normalizedAgentId,
    capabilities: resolution?.capabilities ?? null,
    routingKeywords: resolution?.routingKeywords ?? null,
    selectorDescriptor: resolution?.selectorDescriptor ?? null,
  };
}

function readIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readCapabilities(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const capabilities = Array.from(new Set(value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())));
  return capabilities.length > 0 ? capabilities : null;
}

function normalizeResolution(value: unknown): AgentSelectorResolution | null {
  if (Array.isArray(value)) {
    const capabilities = readCapabilities(value);
    return capabilities ? { capabilities } : null;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const capabilities = readCapabilities(record.capabilities ?? record.baseCapabilities);
  const routingKeywords = readCapabilities(record.routingKeywords);
  const selectorDescriptor = readIdentifier(record.selectorDescriptor);
  if (!capabilities && !routingKeywords && !selectorDescriptor) {
    return null;
  }
  return {
    capabilities,
    routingKeywords,
    selectorDescriptor: selectorDescriptor ?? null,
  };
}

function mergeResolutions(
  primary: unknown,
  fallback: unknown,
): AgentSelectorResolution | null {
  const primaryResolution = normalizeResolution(primary);
  const fallbackResolution = normalizeResolution(fallback);
  if (!primaryResolution) {
    return fallbackResolution;
  }
  if (!fallbackResolution) {
    return primaryResolution;
  }
  return {
    capabilities: mergeStringArrays(primaryResolution.capabilities, fallbackResolution.capabilities),
    routingKeywords: mergeStringArrays(primaryResolution.routingKeywords, fallbackResolution.routingKeywords),
    selectorDescriptor: primaryResolution.selectorDescriptor || fallbackResolution.selectorDescriptor || null,
  };
}

function mergeStringArrays(left?: string[] | null, right?: string[] | null): string[] | null {
  const merged = readCapabilities([...(left ?? []), ...(right ?? [])]);
  return merged && merged.length > 0 ? merged : null;
}
