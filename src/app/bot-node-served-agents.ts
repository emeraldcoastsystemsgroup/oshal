/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation: the served-agent policy of a bot node. A dedicated node serves exactly its own agent, as before. A node started with BOT_NODE_SERVES=inline-app-bots (the concierge node) also serves an agent that an installed application durably owns, provided it is neither a kernel identity nor a static registry entry, so a signed dispatch can never pull a core bot onto the concierge. Ownership is the same durable read the protected-execution boundary uses (oshal_application_execution_claims as oshal_bot); positive answers are cached briefly, refusals never are, and a failed read propagates so the caller fails closed.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { kernelBotAgentIds, SWARM_BOT_REGISTRY } from '@/app/extensions/swarm/swarm-bot-registry';
import { LOCAL_BOT_REGISTRY } from '@/app/extensions/swarm/swarm-bot-registry-local';
import { readApplicationExecutionOwnership } from './application-execution-ownership';

const logger = createChildLogger({ module: 'bot-node-served-agents' });

/** The one multi-agent mode a bot node may be started in. */
export const BOT_NODE_SERVES_INLINE_APP_BOTS = 'inline-app-bots';
/** How long a positive served answer stands before the ownership is read again. */
const SERVED_CACHE_TTL_MS = 30_000;

type ServedAgentEnvironment = Readonly<Record<string, string | undefined>>;

/** @description Which agents this node may execute for, decided once at startup from its environment. */
export interface ServedAgentPolicy {
  /** True only for a node started with BOT_NODE_SERVES=inline-app-bots. */
  readonly multiAgent: boolean;
  /**
   * Whether this node may execute for the agent. Always true for the local agent. A read that fails
   * rejects, so a caller refuses rather than guessing.
   */
  serves(agentId: string): Promise<boolean>;
}

/**
 * @description Builds the node's served-agent policy. With BOT_NODE_SERVES unset or blank the node is a
 * dedicated node and serves its own agent only (behaviour unchanged). `inline-app-bots` makes it the
 * concierge node: it also serves an agent an installed application durably owns, never a kernel
 * identity or a static registry entry (the floor). Any other value refuses to start.
 * @param options - The node's own identity, its database pool and its environment.
 * @returns The policy shared by the delegation gate, the protected boundary and the handler.
 * @throws Error when BOT_NODE_SERVES names an unknown mode.
 */
export function createServedAgentPolicy(options: {
  localAgentId: string;
  pool: Pick<Pool, 'query'> | null;
  env?: ServedAgentEnvironment;
  now?: () => number;
}): ServedAgentPolicy {
  const env = options.env ?? process.env;
  const mode = (env.BOT_NODE_SERVES ?? '').trim();
  const local = options.localAgentId;
  if (!mode) return Object.freeze({ multiAgent: false, serves: async (agentId: string) => agentId === local });
  if (mode !== BOT_NODE_SERVES_INLINE_APP_BOTS) {
    throw new Error(`BOT_NODE_SERVES must be empty or '${BOT_NODE_SERVES_INLINE_APP_BOTS}'`);
  }
  const floor = new Set<string>(kernelBotAgentIds());
  for (const bot of [...LOCAL_BOT_REGISTRY, ...SWARM_BOT_REGISTRY]) if (bot.agentId) floor.add(bot.agentId);
  const now = options.now ?? Date.now;
  const servedUntil = new Map<string, number>();
  const authorizationMode = env.OSHAL_APPLICATION_AUTHORIZATION_MODE?.trim().toLowerCase() === 'legacy' ? 'legacy' : 'enforce';
  logger.info({ localAgentId: local, mode, floorSize: floor.size }, 'Bot node serves installed inline application bots');
  return Object.freeze({
    multiAgent: true,
    serves: async (agentId: string): Promise<boolean> => {
      if (agentId === local) return true;
      if (typeof agentId !== 'string' || !agentId || floor.has(agentId)) {
        logger.warn({ agentId: typeof agentId === 'string' ? agentId.slice(0, 64) : null }, 'Served-agent refusal: a kernel or static identity, or no identity');
        return false;
      }
      if ((servedUntil.get(agentId) ?? 0) > now()) return true;
      const ownership = await readApplicationExecutionOwnership(options.pool, { kind: 'bots', id: agentId, mode: authorizationMode });
      if (!ownership?.app) {
        logger.warn({ agentId }, 'Served-agent refusal: no installed application owns this agent');
        return false;
      }
      servedUntil.set(agentId, now() + SERVED_CACHE_TTL_MS);
      return true;
    },
  });
}
