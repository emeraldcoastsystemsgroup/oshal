/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Preserve validated package runtime declarations when registering inline application bots.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-093 Tier 2: honor an optional bots[].container/port so a package with a dedicated node service registers AS that node — createRegistryEndpointResolver then dispatches http://<container>:<port> instead of the controller-inline path, which is what lets the ADR-127 demo-CLI carve govern the bot's turns. Absent = the historical inline registration, every existing package unaffected.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-128 Amendment 1 (operator directive 2026-08-13): claude-code removed as a DEFAULT — the subscription is being cancelled, so an automatic degrade onto it turns a codex outage into silent spend on a dying account. A manifest bot that omits harnessType now inherits codex-cli/openai-codex (was claude-code/claude-code) — omitting it is the norm for store packages, so every such package was minting a Claude Code bot into a codex fleet.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | A declared `container:` now implies requiresOwnNode. Seq 2 registered the container but a package cannot set that flag, and seq 3 made codex-cli the inherited default — so the endpoint resolver's prefer-inline codex rule silently overrode every packaged node bot and ADR-093 Tier 2 never once worked (0 for 2 live packages). Live symptom: career-hunter won its bid, executed on the controller, and told the operator his resume data could not be found, because the inline session has neither the package's tools nor its per-user workspace. The loader already REFUSES `container: oshal-api`, so a declared container is always a real dedicated node — naming one IS the opt-out from inline.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-128 Amendment 2 (operator directive 2026-09-17): the inherited default for a manifest bot that omits harnessType is now cline/gemini (was codex-cli/openai-codex). The fleet's shared Codex login hit its usage limit and every packaged bot without a declared harness was dead with the core fleet; Cline is the generic wrapper any provider can back, so the packages now follow the fleet knob (FORCE_LLM_PROVIDER/FORCE_LLM_MODEL) instead of a second literal. Guard row inverted in tests/unit/fleet-default-cline-gemini.spec.ts.
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
    // Naming a container IS the opt-out from controller-inline execution: the loader refuses
    // `container: oshal-api`, so a declared container is always a real dedicated node. Without
    // this flag the resolver's prefer-inline codex rule won — and while a package that omitted
    // `harnessType:` inherited codex-cli (2026-08-13 to 2026-09-17), that rule applied to EVERY
    // packaged node bot. The flag is kept: a declared container is a dedicated node regardless.
    ...(bot.container ? { requiresOwnNode: true } : {}),
    role: bot.role ?? '',
    capabilities: bot.capabilities ?? [],
    // A manifest bot that declares no harness inherits the FLEET default (ADR-128 Amendment 2:
    // the generic Cline wrapper backed by Gemini), never a vendor CLI of its own. Every store
    // package that omits `harnessType:` — the one shape most likely to omit it, since a package
    // author has no reason to think about the controller's harness at all — lands on the same
    // engine as the core fleet, so a fleet move in .env moves the packages with it.
    harnessType: bot.harnessType ?? 'cline',
    apiType: bot.apiType ?? 'gemini',
    accessRoles: bot.accessRoles,
  };
}
