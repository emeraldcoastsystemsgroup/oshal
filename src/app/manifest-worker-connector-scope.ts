/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Header backfill + communications-bot connector scope += 'twilio' (phone/text leg, BYO account via the token broker).
 */

import { SwarmBotRegistry } from './extensions/swarm/swarm-bot-registry';

/** Connector scopes supported by both bot runtimes, granted per worker role. */
const PROVIDERS_BY_WORKER_NAME: Readonly<Record<string, readonly string[]>> = {
  // twilio: the user's own "SID:AuthToken" secret, so the comms bot's phone/text leg
  // (scripts/oshal-twilio.js) acts on THEIR Twilio account — BYO, never a platform key.
  'communications-bot': ['google', 'twitter', 'twilio'],
  'google-bot': ['google'],
  'social-writer': ['google', 'twitter'],
  'home-bot': ['smartthings'],
  'shopping-concierge': ['walmart'],
  'eats-concierge': ['uber'],
};

export function connectorProvidersForManifestWorker(workerAgentId: string): readonly string[] {
  const workerName = SwarmBotRegistry.listDefinitions()
    .find((definition) => definition.agentId === workerAgentId)?.name;
  return workerName ? PROVIDERS_BY_WORKER_NAME[workerName] ?? [] : [];
}
