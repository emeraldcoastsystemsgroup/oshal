/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Preserve validated package runtime declarations when registering inline application bots.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-093 Tier 2: honor an optional bots[].container/port so a package with a dedicated node service registers AS that node — createRegistryEndpointResolver then dispatches http://<container>:<port> instead of the controller-inline path, which is what lets the ADR-127 demo-CLI carve govern the bot's turns. Absent = the historical inline registration, every existing package unaffected.
 */

import type { SwarmAppBotDeclaration } from '@/features/swarm-apps';
import type { SwarmBotDefinition } from './swarm-bot-registry';

/**
 * @description Convert one validated package declaration into a dynamic registry entry.
 * Legacy packages that omit both runtime fields retain the prior Claude runtime;
 * explicit declarations pass through unchanged so per-agent provider resolution works.
 * A declared `container:` registers the bot as its own dedicated node (loader-validated,
 * ADR-093 Tier 2); otherwise the bot registers controller-inline as before.
 * @param bot - Validated bot declaration from a loaded application manifest.
 * @returns Dynamic registry definition used by provider and dispatch resolution.
 */
export function manifestBotDefinition(bot: SwarmAppBotDeclaration): SwarmBotDefinition {
  return {
    agentId: bot.agentId,
    name: bot.name,
    port: bot.container ? bot.port ?? 5000 : 3010,
    container: bot.container ?? 'oshal-api',
    role: bot.role ?? '',
    capabilities: bot.capabilities ?? [],
    harnessType: bot.harnessType ?? 'claude-code',
    apiType: bot.apiType ?? 'claude-code',
    accessRoles: bot.accessRoles,
  };
}
