/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Formalize the third tool tier: a named provider-embedded catalog (tool name -> the provider's own operation id), a fail-closed per-agent grant decision, and the run-trace entry shape that names the tier and the provider operation. Previously an embedded tool had no home at all — the registry interceptor denied it as "not registered", which is indistinguishable from a typo and carries no tier or operation in the trace.
 */

/**
 * @description The three tool tiers a bot can reach.
 * - `framework-registry`: the shared OSHAL tool registry, governed per agent by the switch framework.
 * - `harness-native`: the tools the local harness runtime supplies to itself (file/shell primitives).
 * - `provider-embedded`: tools the model provider executes INSIDE its own service (server-side
 *   web search, code execution, file search). The platform never runs these; it decides whether
 *   the agent may reach them and records which provider operation was involved.
 */
export const TOOL_TIERS = ['framework-registry', 'harness-native', 'provider-embedded'] as const;

/**
 * @description One of the three tool tiers.
 */
export type ToolTier = (typeof TOOL_TIERS)[number];

/**
 * @description Stable refusal code emitted when an agent reaches for an embedded tool it is not
 * granted. Kept as the FIRST token of the refusal reason so escalation metadata stays matchable.
 */
export const EMBEDDED_TOOL_DENIED_CODE = 'embedded_tool_denied';

/**
 * @description The harness's own runtime primitives. These are supplied by the harness process,
 * not by the shared registry and not by the provider, so they are their own tier in a run trace.
 */
export const HARNESS_NATIVE_TOOL_NAMES: readonly string[] = [
  'list_directory',
  'read_file',
  'search_files',
  'write_to_file',
  'replace_in_file',
  'execute_command',
  'ask_followup_question',
  'attempt_completion',
];

/**
 * @description A named embedded tool and the operation identifier each provider knows it by.
 * The platform name is the stable identity an agent grants or denies; the operation is what the
 * provider actually runs and what a run trace has to name to be auditable.
 */
export interface EmbeddedToolDescriptor {
  /** Stable platform-side name an agent grants (kebab-case). */
  name: string;
  /** Human-facing label for surfaces. */
  displayName: string;
  /** What the provider does when the model reaches for it. */
  description: string;
  /** providerId -> that provider's own operation identifier. */
  providerOperations: Readonly<Record<string, string>>;
}

/**
 * @description The embedded tools the platform recognizes, with each provider's operation id.
 * Membership here is what makes a tool name an EMBEDDED tool rather than an unknown one; adding a
 * provider means adding its operation id, never widening any execution path.
 */
export const EMBEDDED_TOOL_CATALOG: readonly EmbeddedToolDescriptor[] = [
  {
    name: 'web-search',
    displayName: 'Provider web search',
    description: 'The provider searches the web inside its own service and returns cited results.',
    providerOperations: {
      anthropic: 'web_search_20250305',
      openai: 'web_search',
      google: 'google_search',
    },
  },
  {
    name: 'code-execution',
    displayName: 'Provider code execution',
    description: 'The provider runs model-authored code in its own sandbox and returns the output.',
    providerOperations: {
      anthropic: 'code_execution_20250522',
      openai: 'code_interpreter',
      google: 'code_execution',
    },
  },
  {
    name: 'file-search',
    displayName: 'Provider file search',
    description: 'The provider retrieves over files it already holds for the account.',
    providerOperations: {
      openai: 'file_search',
    },
  },
];

/**
 * @description Normalizes a tool identifier so a provider operation id (`web_search_20250305`),
 * a snake_case call (`web_search`) and the platform name (`web-search`) all compare equal.
 *
 * @param value - Raw tool name as the model or provider spelled it.
 * @returns Lower-cased, dash-separated identifier; empty string when there is nothing to compare.
 */
export function normalizeToolIdentifier(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

const CATALOG_BY_IDENTIFIER: ReadonlyMap<string, EmbeddedToolDescriptor> = buildCatalogIndex();

/**
 * @description Builds the lookup that resolves every spelling of an embedded tool — its platform
 * name and every provider operation id — to the single descriptor.
 *
 * @returns Identifier -> descriptor map.
 */
function buildCatalogIndex(): ReadonlyMap<string, EmbeddedToolDescriptor> {
  const index = new Map<string, EmbeddedToolDescriptor>();
  for (const descriptor of EMBEDDED_TOOL_CATALOG) {
    index.set(normalizeToolIdentifier(descriptor.name), descriptor);
    for (const operation of Object.values(descriptor.providerOperations)) {
      index.set(normalizeToolIdentifier(operation), descriptor);
    }
  }
  return index;
}

/**
 * @description Resolves a tool name to its embedded-tier descriptor.
 *
 * @param toolName - Name the model invoked, in any of the accepted spellings.
 * @returns The descriptor, or null when the name is not an embedded tool.
 */
export function getEmbeddedTool(toolName: string): EmbeddedToolDescriptor | null {
  return CATALOG_BY_IDENTIFIER.get(normalizeToolIdentifier(toolName)) ?? null;
}

/**
 * @description Resolves the concrete provider operation behind an embedded tool invocation.
 *
 * @param toolName - Name the model invoked.
 * @param providerId - Active provider identifier (e.g. `anthropic`); optional.
 * @returns The provider and its operation id, or null when the tool is not embedded or the
 *          active provider does not expose it.
 */
export function resolveEmbeddedToolOperation(
  toolName: string,
  providerId?: string | null,
): { providerId: string; operation: string } | null {
  const descriptor = getEmbeddedTool(toolName);
  if (!descriptor) return null;

  const requested = (providerId ?? '').trim().toLowerCase();
  if (requested) {
    const operation = descriptor.providerOperations[requested];
    return operation ? { providerId: requested, operation } : null;
  }

  // No active provider named (a trace assembled outside a live turn): fall back to the spelling
  // the model actually used when it IS a provider operation, so the trace still names a real one.
  const spelled = normalizeToolIdentifier(toolName);
  // The platform name itself names no provider. One provider spelling can normalize onto it
  // (openai's `web_search` -> `web-search`); attributing that to openai would be a guess.
  if (spelled === normalizeToolIdentifier(descriptor.name)) return null;
  for (const [provider, operation] of Object.entries(descriptor.providerOperations)) {
    if (normalizeToolIdentifier(operation) === spelled) return { providerId: provider, operation };
  }
  return null;
}

/**
 * @description Classifies a tool name into its tier for the run trace.
 *
 * @param toolName - Name the model invoked.
 * @returns The tier that owns the tool.
 */
export function classifyToolTier(toolName: string): ToolTier {
  if (getEmbeddedTool(toolName)) return 'provider-embedded';
  const normalized = normalizeToolIdentifier(toolName);
  const harnessNative = HARNESS_NATIVE_TOOL_NAMES.some(
    (name) => normalizeToolIdentifier(name) === normalized,
  );
  return harnessNative ? 'harness-native' : 'framework-registry';
}

/**
 * @description One row of the run's tool trace. `tier` and, for the embedded tier,
 * `providerOperation` are what make a run auditable after the fact.
 */
export interface ToolRunTraceEntry {
  name: string;
  tier: ToolTier;
  providerId?: string;
  providerOperation?: string;
}

/**
 * @description Builds the trace row for one tool invocation.
 *
 * @param toolName - Name the model invoked.
 * @param providerId - Active provider identifier, when the caller knows it.
 * @returns A trace row naming the tier and, for an embedded tool, the provider operation.
 */
export function buildToolRunTraceEntry(toolName: string, providerId?: string | null): ToolRunTraceEntry {
  const tier = classifyToolTier(toolName);
  if (tier !== 'provider-embedded') return { name: toolName, tier };

  const descriptor = getEmbeddedTool(toolName);
  const resolved = resolveEmbeddedToolOperation(toolName, providerId);
  return {
    name: descriptor?.name ?? toolName,
    tier,
    ...(resolved ? { providerId: resolved.providerId, providerOperation: resolved.operation } : {}),
  };
}

/**
 * @description Per-agent grant source for the embedded tier. Returns the mode the agent declares
 * for a named embedded tool, or null when the agent declares nothing (which denies).
 */
export interface EmbeddedToolPolicy {
  resolveMode(agentId: string, toolName: string): Promise<string | null>;
}

/**
 * @description The outcome of an embedded-tier authorization check.
 */
export interface EmbeddedToolAuthorization {
  allowed: boolean;
  tier: 'provider-embedded';
  tool: string;
  mode: string;
  providerId?: string;
  providerOperation?: string;
  reason?: string;
}

/**
 * @description Decides whether an agent may reach a named embedded tool. Fail-closed: an absent
 * policy, an absent declaration and any mode other than exactly `auto` all deny.
 *
 * `ask` denies here on purpose. An embedded tool runs INSIDE the provider's own turn, so there is
 * no point at which the platform could hold the call open for a human decision — the tier supports
 * enable (`auto`) and disable (`off`), and anything else is a disable with a reason.
 *
 * @param input - The invoked tool name, the agent, the active provider and the declared mode.
 * @returns The authorization outcome, always naming the tier and (when resolvable) the operation.
 */
export function decideEmbeddedToolUse(input: {
  toolName: string;
  agentId: string;
  providerId?: string | null;
  mode: string | null;
}): EmbeddedToolAuthorization {
  const descriptor = getEmbeddedTool(input.toolName);
  const name = descriptor?.name ?? input.toolName;
  const resolved = resolveEmbeddedToolOperation(input.toolName, input.providerId);
  const mode = normalizeToolIdentifier(input.mode ?? '') || 'unset';
  const operationPart = resolved
    ? `provider=${resolved.providerId}, operation=${resolved.operation}`
    : `provider=${(input.providerId ?? 'unknown').trim() || 'unknown'}, operation=unavailable`;

  const base = {
    tier: 'provider-embedded' as const,
    tool: name,
    mode,
    ...(resolved ? { providerId: resolved.providerId, providerOperation: resolved.operation } : {}),
  };

  if (!descriptor) {
    return {
      ...base,
      allowed: false,
      reason: `${EMBEDDED_TOOL_DENIED_CODE}: '${input.toolName}' is not a known embedded tool (tier=provider-embedded, ${operationPart})`,
    };
  }

  if (mode !== 'auto') {
    const declared = mode === 'unset' ? 'no declaration' : `mode=${mode}`;
    return {
      ...base,
      allowed: false,
      reason: `${EMBEDDED_TOOL_DENIED_CODE}: embedded tool '${name}' (tier=provider-embedded, ${operationPart}) is not enabled for agent '${input.agentId}' (${declared}). Declare it as 'auto' in that agent's persona authorizations to enable it.`,
    };
  }

  if (!resolved) {
    return {
      ...base,
      allowed: false,
      reason: `${EMBEDDED_TOOL_DENIED_CODE}: embedded tool '${name}' (tier=provider-embedded, ${operationPart}) is enabled for agent '${input.agentId}' but the active provider exposes no operation for it.`,
    };
  }

  return { ...base, allowed: true };
}
