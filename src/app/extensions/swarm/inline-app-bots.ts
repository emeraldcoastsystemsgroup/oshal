/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation: inlineAppBotOwner names the installed package that owns an inline app bot, the one class of bot the concierge node may run. An app concierge registered controller-inline cannot run its caller's CLI login there (SEC-05 refuses every controller CLI), so the operator's turns answered NO_HOSTED_BRAIN whenever the hosted lane was off. The answer is deliberately narrow: the bot must be the GOVERNING definition (statics come first in getActiveRegistry, so a package can never pull a core or static id onto the concierge by re-declaring it), on a controller-inline container, without requiresOwnNode, and outside the kernel identity set.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | A reviewed static app concierge (CONCIERGE_STATIC_APP_BOT_IDS: eleven store-package concierges core also lists statically) qualifies when its static definition is controller-inline and an installed package declares it; the package's name is returned. Every other static or core id still never qualifies, and the kernel refusal comes first.
 */

import { isControllerInlineContainer } from '@/features/agent-management';
import { dynamicAppBotsByApp, getActiveRegistry, kernelBotAgentIds } from './swarm-bot-registry';
import { CONCIERGE_STATIC_APP_BOT_IDS } from './concierge-static-app-bots';

/**
 * @description The installed package that owns an inline app bot, or undefined when the bot is not
 * one. Only such a bot may be routed to the concierge node: a core or static bot keeps its own
 * runtime, a dedicated node keeps its node, and a kernel identity never leaves the controller's
 * own rules. The governing definition is the FIRST registry match, exactly what dispatch and
 * harness resolution read, so a package re-declaring a static id never qualifies.
 * @param agentId - The target bot's agent UUID.
 * @returns The owning application's name, or undefined when the bot is not an inline app bot.
 */
export function inlineAppBotOwner(agentId: string | null | undefined): string | undefined {
  if (!agentId || kernelBotAgentIds().has(agentId)) return undefined;
  const governing = getActiveRegistry().find((bot) => bot.agentId === agentId);
  if (!governing || governing.requiresOwnNode || !isControllerInlineContainer(governing.container)) return undefined;
  const reviewedStatic = CONCIERGE_STATIC_APP_BOT_IDS.has(agentId);
  for (const [app, definitions] of dynamicAppBotsByApp()) {
    // A package-governed bot, or a reviewed static app concierge that an installed package declares.
    if (definitions.includes(governing) || (reviewedStatic && definitions.some((bot) => bot.agentId === agentId))) return app;
  }
  return undefined;
}
