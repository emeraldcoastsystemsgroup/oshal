/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the bot-node endpoint decision out of the swarm composition closure so the one branch that silently sends a dedicated-node bot inline is unit-testable. Verbatim behavior move plus ONE addition: forcing a bot that owns a real container onto the inline path now WARNS instead of returning null in silence. That silence is what made a live misroute take an hour to trace — the career-hunter bot won its bid, executed on the controller, and no log line anywhere said why.
 */

import type { SwarmBotDefinition } from './swarm-bot-registry';

/** The internal execution port every bot-node listens on inside the compose network. */
const INTERNAL_NODE_PORT = 5000;

/** Minimal logger surface — matches the Pino child logger the composition root passes in. */
export interface EndpointResolutionLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * @description Decides where one agent's turn executes: a dedicated bot-node URL, or null
 * meaning "run inline on the controller".
 *
 * The codex branch is the subtle one. Bots on the codex harness are forced onto the legacy
 * inline path (the api task-orchestrator drives the codex CLI) because that rule predates the
 * bot-node JS CodexProvider. `requiresOwnNode` is the ADR-081 override for a bot whose
 * WORKSPACE only exists on its node — running it inline silently produces a session with none
 * of its files or tools, which reads to a user as "the data is missing" rather than "the bot
 * ran in the wrong place".
 *
 * A bot that declares a real container and does NOT set `requiresOwnNode` still takes the
 * inline path — that is existing behavior and is preserved — but it is now reported at WARN,
 * because it is almost always a declaration bug rather than an intent.
 *
 * @param agentId - The agent whose endpoint is being resolved.
 * @param definitions - The active bot registry (statics + dynamically registered app bots).
 * @param isControllerInline - Predicate identifying controller-hosted inline containers.
 * @param logger - Optional logger for the two explainable inline decisions.
 * @returns The bot-node base URL, or null to run inline on the controller.
 */
export function resolveBotNodeEndpoint(
  agentId: string,
  definitions: readonly SwarmBotDefinition[],
  isControllerInline: (container?: string | null) => boolean,
  logger?: EndpointResolutionLogger,
): string | null {
  const def = definitions.find((d) => d.agentId === agentId);
  if (!def || !def.container) return null;

  if (isControllerInline(def.container)) {
    logger?.info(
      { agentId, botName: def.name, container: def.container },
      'Bot is controller-inline - using legacy local execution path',
    );
    return null;
  }

  // ADR-081: node-bound workspace (e.g. oshal-developer's clone) → always dispatch to the
  // node; the bot-node JS CodexProvider exists now, so the prefer-inline rule doesn't apply.
  if (def.requiresOwnNode) return `http://${def.container}:${INTERNAL_NODE_PORT}`;

  const wantsCodex = def.harnessType === 'codex-cli' || def.apiType === 'openai-codex';
  if (wantsCodex) {
    // Force legacy path (api task-orchestrator → codex CLI). Returning null makes
    // BotNodeClient.execute throw, which dispatchIncidentTicket / dispatchManifestWorkerTicket
    // catches and falls back to /api/send-message.
    //
    // This bot names a dedicated node, so running it on the controller contradicts its own
    // declaration. Say so: the failure it produces downstream ("no tools", "no files") looks
    // nothing like its cause.
    logger?.warn(
      { agentId, botName: def.name, container: def.container, harnessType: def.harnessType },
      'Bot declares a dedicated node but is being forced inline by the codex rule — set requiresOwnNode on its registry definition',
    );
    return null;
  }

  return `http://${def.container}:${INTERNAL_NODE_PORT}`;
}
