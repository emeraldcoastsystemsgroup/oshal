/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Header backfill + communications-bot connector scope += 'twilio' (phone/text leg, BYO account via the token broker).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: remove Twilio from worker credential scope; controller-owned fixed operations retain authorized per-user SMS without exposing the account secret to a bot.
 */

import { SwarmBotRegistry } from './extensions/swarm/swarm-bot-registry';

/** Connector scopes supported by both bot runtimes, granted per worker role. */
const PROVIDERS_BY_WORKER_NAME: Readonly<Record<string, readonly string[]>> = {
  'communications-bot': ['google', 'twitter'],
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
