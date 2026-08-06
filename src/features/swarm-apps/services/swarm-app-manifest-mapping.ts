/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extract the manifest-to-runtime translation helpers verbatim out of swarm-app-service.ts, which reached 1082 code lines against the 1000-line hard cap. Everything here turns declared manifest text into a runtime value — tool-registry input, a selector seed read off persona YAML, a parameterised WHERE fragment, an interpolated label — and none of it touches service state, so it belongs beside the manifest schema rather than inside the orchestrator.
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';
import { createChildLogger } from '@/shared/logger';
import type { CreateToolInput } from '@/entities/tool';
import { AuthMode, InstallMethod, ToolType } from '@/shared/types/tool';
import type {
  SwarmAppBotDeclaration,
  SwarmAppManifest,
  SwarmAppToolDeclaration,
} from '../types';

const logger = createChildLogger({ module: 'swarm-app-manifest-mapping' });

/**
 * @description Extracts the toolNames the manifest will register statically at load time.
 * @param manifest - The parsed app manifest.
 * @returns De-duplicated tool names contributed by static UI tiles and tool declarations.
 */
export function staticToolNames(manifest: SwarmAppManifest): string[] {
  return Array.from(new Set([
    ...(manifest.ui?.static ?? []).map(s => s.toolName),
    ...(manifest.tools ?? []).map(t => t.name),
  ]));
}

/**
 * @description Resolve a bot's routing seed, preferring explicit manifest values and otherwise
 * reading the persona YAML the manifest points at. A missing or unreadable persona degrades to an
 * empty seed rather than failing the load — routing falls back to its own defaults.
 * @param bot - The manifest's bot declaration.
 * @returns The selector descriptor and de-duplicated routing keywords.
 */
export function readBotSelectorSeed(bot: SwarmAppBotDeclaration): {
  selectorDescriptor: string;
  routingKeywords: string[];
} {
  const explicitDescriptor = typeof bot.selectorDescriptor === 'string' ? bot.selectorDescriptor.trim() : '';
  const explicitKeywords = Array.isArray(bot.routingKeywords)
    ? bot.routingKeywords.filter((keyword): keyword is string => typeof keyword === 'string' && keyword.trim().length > 0)
    : [];
  if (explicitDescriptor || explicitKeywords.length > 0) {
    return {
      selectorDescriptor: explicitDescriptor,
      routingKeywords: Array.from(new Set(explicitKeywords.map((keyword) => keyword.trim()))),
    };
  }

  const personaPath = typeof bot.persona === 'string' ? bot.persona.trim() : '';
  if (!personaPath) {
    return { selectorDescriptor: '', routingKeywords: [] };
  }

  try {
    const resolvedPath = resolve(process.cwd(), personaPath);
    if (!existsSync(resolvedPath)) {
      return { selectorDescriptor: '', routingKeywords: [] };
    }
    const doc = yaml.load(readFileSync(resolvedPath, 'utf8')) as Record<string, unknown> | null;
    const selectorDescriptor = String(doc?.selector_descriptor ?? doc?.selectorDescriptor ?? '').trim();
    const rawRoutingKeywords = doc?.routing_keywords ?? doc?.routingKeywords;
    const routingKeywords = Array.isArray(rawRoutingKeywords)
      ? rawRoutingKeywords
        .filter((keyword): keyword is string => typeof keyword === 'string' && keyword.trim().length > 0)
        .map((keyword) => keyword.trim())
      : [];
    return { selectorDescriptor, routingKeywords: Array.from(new Set(routingKeywords)) };
  } catch (err) {
    logger.warn({ err, agentId: bot.agentId, persona: bot.persona }, 'Failed to read bot selector seed from persona YAML');
    return { selectorDescriptor: '', routingKeywords: [] };
  }
}

/**
 * @description Resolves `{column}` tokens in a manifest template against a DB row.
 * Supports a special alias `{class_id_prefix}` that expands to the first
 * 8 chars of `row.class_id` — lets a manifest reference a short readable
 * ID suffix without requiring a generated column.
 * @param template - The manifest-declared label template.
 * @param row - The database row supplying token values.
 * @returns The template with every token replaced (unknown/null tokens become empty).
 */
export function interpolate(template: string, row: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    // Derived/computed tokens first — must be checked BEFORE looking up the
    // raw column, since e.g. `class_id_prefix` is not a real column.
    if (key === 'class_id_prefix' && typeof row.class_id === 'string') {
      return row.class_id.substring(0, 8);
    }
    const raw = row[key];
    if (raw === undefined || raw === null) return '';
    return String(raw);
  });
}

/**
 * @description Parse a manifest's dynamic-UI `where` string into a parameterised
 * SQL fragment + params array. Only accepts a tiny allowlist:
 *   - `col = 'literal'` or `col = "literal"` — string equality
 *   - Multiple clauses joined by AND
 * Column names must match `[a-z_][a-z0-9_]*`. Literals are bound as $N params.
 * Anything else → whereSql = null (caller should reject the manifest clause).
 *
 * @param where - The raw where string from the manifest (may be undefined)
 * @returns { whereSql: 'WHERE col1 = $1 AND col2 = $2' | '' | null, params: unknown[] }
 */
export function parseSafeWhere(where?: string): { whereSql: string | null; params: unknown[] } {
  if (!where) return { whereSql: '', params: [] };
  const trimmed = where.trim();
  if (!trimmed) return { whereSql: '', params: [] };

  const clauseRe = /^\s*([a-z_][a-z0-9_]*)\s*=\s*(?:'([^']*)'|"([^"]*)")\s*$/i;
  const parts = trimmed.split(/\s+AND\s+/i);
  const fragments: string[] = [];
  const params: unknown[] = [];
  for (const part of parts) {
    const m = clauseRe.exec(part);
    if (!m) return { whereSql: null, params: [] };
    const col = m[1];
    const lit = m[2] ?? m[3];
    fragments.push(`${col} = $${params.length + 1}`);
    params.push(lit);
  }
  return { whereSql: `WHERE ${fragments.join(' AND ')}`, params };
}

/**
 * @description Resolve the registry tool type, defaulting from the executor when the manifest
 * leaves `type` unset.
 * @param type - The declared tool type, if any.
 * @param executorType - The declared executor kind.
 * @returns The concrete registry tool type.
 */
export function toToolType(type: SwarmAppToolDeclaration['type'], executorType: SwarmAppToolDeclaration['executor']['executorType']): ToolType {
  if (type) return type as ToolType;
  if (executorType === 'api') return ToolType.API;
  if (executorType === 'mcp') return ToolType.MCP;
  if (executorType === 'builtin') return ToolType.CLI;
  return ToolType.CLI;
}

/**
 * @description Resolve the default auth mode, defaulting from the executor when unset. Builtin
 * executors are AUTO; everything else must be asked for.
 * @param authMode - The declared default auth mode, if any.
 * @param executorType - The declared executor kind.
 * @returns The concrete auth mode.
 */
export function toAuthMode(
  authMode: SwarmAppToolDeclaration['defaultAuthMode'],
  executorType: SwarmAppToolDeclaration['executor']['executorType'],
): AuthMode {
  if (authMode) return authMode as AuthMode;
  return executorType === 'builtin' ? AuthMode.AUTO : AuthMode.ASK;
}

/**
 * @description Translate a manifest tool declaration into the tool-registry create input,
 * applying the manifest's own defaults and stamping the owning app into tags and registeredBy.
 * @param tool - The manifest's tool declaration.
 * @param appName - The owning application name.
 * @returns The registry create input for this tool.
 */
export function manifestToolToCreateInput(tool: SwarmAppToolDeclaration, appName: string): CreateToolInput {
  return {
    name: tool.name,
    displayName: tool.displayName ?? tool.name,
    type: toToolType(tool.type, tool.executor.executorType),
    category: tool.category ?? appName,
    version: tool.version ?? '1.0.0',
    installSpec: (tool.installSpec as CreateToolInput['installSpec']) ?? { method: InstallMethod.NONE },
    skills: tool.skills ?? [],
    selectorFragment: tool.selectorFragment ?? '',
    routingTags: tool.routingTags ?? [],
    authGroup: tool.authGroup ?? '',
    defaultAuthMode: toAuthMode(tool.defaultAuthMode, tool.executor.executorType),
    description: tool.description,
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    outputSchema: tool.outputSchema,
    usageInstructions: tool.usageInstructions,
    examples: tool.examples ?? [],
    requiresApproval: tool.requiresApproval ?? tool.executor.executorType !== 'builtin',
    timeoutMs: tool.timeoutMs ?? 30000,
    tags: Array.from(new Set([...(tool.tags ?? []), 'swarm-app-tool', `swarm-app:${appName}`])),
    enabled: tool.enabled ?? true,
    registeredBy: tool.registeredBy ?? `swarm-app:${appName}`,
  };
}
