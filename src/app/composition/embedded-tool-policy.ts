/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Persona-backed grant source for the provider-embedded tool tier. Reuses the SAME per-agent `authorizations:` map the registry tier already seeds from (persona-authorization-seeder), so enabling or disabling a named embedded tool for one agent is one line in that agent's persona — no new table, no migration, no second policy surface to drift.
 */

import { loadPersonaFromFile } from '@/features/swarm-orchestration';
import { createChildLogger } from '@/shared/logger';
import {
  getEmbeddedTool,
  normalizeToolIdentifier,
  type EmbeddedToolPolicy,
} from '@/shared/tools/embedded-tool-tier';

const logger = createChildLogger({ module: 'embedded-tool-policy' });

/**
 * @description Spellings operators already use in persona `authorizations:` blocks, mapped onto
 * the three canonical modes. Mirrors the alias set the registry-tier seeder accepts so one persona
 * file does not mean two different things to two tiers.
 */
const MODE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['enabled', 'auto'],
  ['true', 'auto'],
  ['on', 'auto'],
  ['approval', 'ask'],
  ['approve', 'ask'],
  ['manual', 'ask'],
  ['prompt', 'ask'],
  ['confirm', 'ask'],
  ['confirmation', 'ask'],
  ['disabled', 'off'],
  ['blocked', 'off'],
  ['false', 'off'],
]);

/**
 * @description Options for the persona-backed embedded tool policy.
 */
export interface PersonaEmbeddedToolPolicyOptions {
  /** Persona directory override; defaults to the loader's own kernel + package search. */
  personaDir?: string;
}

/**
 * @description Builds the per-agent grant source for the provider-embedded tier.
 *
 * An agent enables a named embedded tool by declaring it in its persona YAML, e.g.
 * `authorizations: { web-search: auto }`; `off` (or omitting it entirely) disables it. Personas
 * are read once per agent and cached for the life of the process — the same lifetime the
 * registry-tier seeder assumes — so a hot tool loop does not stat the filesystem per call.
 *
 * @param options - Optional persona directory override (tests point this at a fixture dir).
 * @returns A policy whose resolveMode answers the agent's declared mode, or null when it declares
 *          nothing for that tool. Null denies: the decision itself is fail-closed.
 */
export function createPersonaEmbeddedToolPolicy(
  options: PersonaEmbeddedToolPolicyOptions = {},
): EmbeddedToolPolicy {
  const authorizationsByAgent = new Map<string, Record<string, string>>();

  const loadAuthorizations = (agentId: string): Record<string, string> => {
    const cached = authorizationsByAgent.get(agentId);
    if (cached) return cached;

    let authorizations: Record<string, string> = {};
    try {
      authorizations = loadPersonaFromFile(agentId, options.personaDir)?.authorizations ?? {};
    } catch (error) {
      logger.error(
        { err: error, agentId },
        'Persona load failed while resolving an embedded tool grant — treating the agent as declaring nothing (denies)',
      );
    }
    authorizationsByAgent.set(agentId, authorizations);
    return authorizations;
  };

  return {
    async resolveMode(agentId: string, toolName: string): Promise<string | null> {
      const descriptor = getEmbeddedTool(toolName);
      if (!descriptor) return null;

      const authorizations = loadAuthorizations(agentId);
      // ONLY the tool's own name. Accepting every provider operation id as a grant key meant one
      // persona line - `google_search`, which is also the platform authorization key for the Google
      // Custom Search registry tool - silently granted Anthropic's and OpenAI's server-side web
      // search too. A grant names the thing it grants.
      const accepted = new Set<string>([normalizeToolIdentifier(descriptor.name)]);

      for (const [declaredName, declaredMode] of Object.entries(authorizations)) {
        if (!accepted.has(normalizeToolIdentifier(declaredName))) continue;
        const mode = normalizeToolIdentifier(declaredMode);
        const resolved = MODE_ALIASES.get(mode) ?? mode;
        logger.debug({ agentId, tool: descriptor.name, mode: resolved }, 'Embedded tool grant resolved from persona');
        return resolved;
      }
      return null;
    },
  };
}
