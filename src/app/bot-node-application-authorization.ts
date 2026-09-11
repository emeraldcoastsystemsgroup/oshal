/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 */
/** Protected package bots remain unavailable until the node supports current per-user policy checks. */
import type { Pool } from 'pg';
import { readApplicationExecutionOwnership } from './application-execution-ownership';
export class BotApplicationAuthorizationError extends Error {
  readonly status = 503;
  constructor(public readonly code: string) { super(code); this.name = 'BotApplicationAuthorizationError'; }
}
/** Read controller-owned posture and remembered ownership; request body roles/flags are never evidence. */
export async function assertBotNodeApplicationTransport(pool: Pick<Pool, 'query'> | null, localAgentId: string, requestedAgentId: string): Promise<void> {
  if (!pool || !localAgentId || !requestedAgentId) throw new BotApplicationAuthorizationError('authorization_bot_posture_unavailable');
  let blocked: boolean;
  try {
    const mode = process.env.OSHAL_APPLICATION_AUTHORIZATION_MODE?.trim().toLowerCase() === 'legacy' ? 'legacy' : 'enforce';
    const ownership = await Promise.all([...new Set([localAgentId, requestedAgentId])].map(id =>
      readApplicationExecutionOwnership(pool, { kind: 'bots', id, mode })));
    blocked = ownership.some(row => row?.protected);
  } catch { throw new BotApplicationAuthorizationError('authorization_bot_posture_unavailable'); }
  if (blocked) throw new BotApplicationAuthorizationError('authorization_bot_transport_unavailable');
}
