/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Preserve validated package runtime declarations when registering inline application bots.
 */

import type { SwarmAppBotDeclaration } from '@/features/swarm-apps';
import type { SwarmBotDefinition } from './swarm-bot-registry';

/**
 * @description Convert one validated package declaration into an inline registry entry.
 * Legacy packages that omit both runtime fields retain the prior Claude runtime;
 * explicit declarations pass through unchanged so per-agent provider resolution works.
 * @param bot - Validated bot declaration from a loaded application manifest.
 * @returns Inline dynamic registry definition used by provider and dispatch resolution.
 */
export function manifestBotDefinition(bot: SwarmAppBotDeclaration): SwarmBotDefinition {
  return {
    agentId: bot.agentId,
    name: bot.name,
    port: 3010,
    container: 'oshal-api',
    role: bot.role ?? '',
    capabilities: bot.capabilities ?? [],
    harnessType: bot.harnessType ?? 'claude-code',
    apiType: bot.apiType ?? 'claude-code',
    accessRoles: bot.accessRoles,
  };
}
