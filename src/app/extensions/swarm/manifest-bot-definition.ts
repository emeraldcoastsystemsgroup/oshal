/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Preserve validated package runtime declarations when registering inline application bots.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-093 Tier 2: honor an optional bots[].container/port so a package with a dedicated node service registers AS that node — createRegistryEndpointResolver then dispatches http://<container>:<port> instead of the controller-inline path, which is what lets the ADR-127 demo-CLI carve govern the bot's turns. Absent = the historical inline registration, every existing package unaffected.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-128 Amendment 1 (operator directive 2026-08-13): claude-code removed as a DEFAULT — the subscription is being cancelled, so an automatic degrade onto it turns a codex outage into silent spend on a dying account. A manifest bot that omits harnessType now inherits codex-cli/openai-codex (was claude-code/claude-code) — omitting it is the norm for store packages, so every such package was minting a Claude Code bot into a codex fleet.
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
    // A manifest bot that declares no harness inherits the FLEET default (ADR-128), not
    // claude-code. Every store package that omits `harnessType:` was silently minting a
    // Claude-Code bot into a codex fleet — the one shape most likely to omit it, since a
    // package author has no reason to think about the controller's harness at all.
    harnessType: bot.harnessType ?? 'codex-cli',
    apiType: bot.apiType ?? 'openai-codex',
    accessRoles: bot.accessRoles,
  };
}
