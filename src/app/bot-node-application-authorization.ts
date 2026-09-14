/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Resolve durable protected ownership for verified hosted execution while keeping unbound transports unavailable.
 */
/** Protected package execution requires both durable ownership and current caller permits. */
import type { Pool } from 'pg';
import { readApplicationExecutionOwnership } from './application-execution-ownership';
export class BotApplicationAuthorizationError extends Error {
  readonly status = 503;
  constructor(public readonly code: string) { super(code); this.name = 'BotApplicationAuthorizationError'; }
}
/**
 * @description Keep alternate transports unavailable when they lack the verified current-policy boundary.
 * @param pool - Trusted ownership database pool.
 * @param localAgentId - Actual runtime identity.
 * @param requestedAgentId - Requested bot target.
 * @returns Completion only for unprotected execution; request body flags never confer authority.
 */
export async function assertBotNodeApplicationTransport(pool: Pick<Pool, 'query'> | null, localAgentId: string, requestedAgentId: string): Promise<void> {
  if (await readProtectedBotApplication(pool, localAgentId, requestedAgentId)) {
    throw new BotApplicationAuthorizationError('authorization_bot_transport_unavailable');
  }
}

/**
 * @description Resolve durable protection for both local and requested bots before accepting execution authority.
 * @param pool - Worker database pool; absence and ambiguous ownership fail closed.
 * @param localAgentId - Agent identity loaded by worker composition.
 * @param requestedAgentId - Target receiving this execution.
 * @returns The protected owning application, or null for an unprotected execution.
 */
export async function readProtectedBotApplication(pool: Pick<Pool, 'query'> | null, localAgentId: string, requestedAgentId: string): Promise<string | null> {
  if (!pool || !localAgentId || !requestedAgentId) throw new BotApplicationAuthorizationError('authorization_bot_posture_unavailable');
  try {
    const mode = process.env.OSHAL_APPLICATION_AUTHORIZATION_MODE?.trim().toLowerCase() === 'legacy' ? 'legacy' : 'enforce';
    const ownership = await Promise.all([...new Set([localAgentId, requestedAgentId])].map(id =>
      readApplicationExecutionOwnership(pool, { kind: 'bots', id, mode })));
    const protectedApps = new Set(ownership.filter(row => row?.protected).map(row => row!.app));
    if (protectedApps.size > 1) throw new Error('Conflicting protected bot ownership');
    return [...protectedApps][0] ?? null;
  } catch { throw new BotApplicationAuthorizationError('authorization_bot_posture_unavailable'); }
}
