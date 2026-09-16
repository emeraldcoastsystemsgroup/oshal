/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Resolve durable protected ownership for verified hosted execution while keeping unbound transports unavailable.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Say WHY the posture is unavailable. readProtectedBotApplication ended in a bare `catch { throw ... }` that discarded the cause, so a bot answered 503 authorization_bot_posture_unavailable for every execution with nothing anywhere recording the reason. That is not hypothetical: migration 140 exists because oshal_bot could not SELECT the tables this guard reads, the 42501 was swallowed here, the api surfaced "Bot node returned 500", and the page spoke a generic apology. The refusal is CORRECT and both throws keep their exact code and 503 status — what changes is that the cause is logged at ERROR and attached to the error, and a conflicting-ownership refusal (a real posture decision) is distinguished in the log from an infrastructure fault (undetermined). Guard: tests/unit/bot-node-application-authorization.spec.ts.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Correct the live comment that named migration 140. That migration is deleted by this change - the bot reads the derived helper oshal_application_execution_claims instead - and a comment pointing at a file that no longer exists is how a later lane gets misdirected. The Change Log entries above are left exactly as written: they record what was true when each change landed.
 */
/** Protected package execution requires both durable ownership and current caller permits. */
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { readApplicationExecutionOwnership } from './application-execution-ownership';

const logger = createChildLogger({ module: 'bot-node-application-authorization' });
export class BotApplicationAuthorizationError extends Error {
  readonly status = 503;
  /** The underlying failure, when this refusal was caused by one rather than decided. */
  readonly reason?: unknown;
  constructor(public readonly code: string, reason?: unknown) {
    super(code);
    this.name = 'BotApplicationAuthorizationError';
    if (reason !== undefined) this.reason = reason;
  }
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
  if (!pool || !localAgentId || !requestedAgentId) {
    // Same fail-closed throw as before. Logged because this code reaches the operator as a
    // bare 503 and a missing pool is indistinguishable from a denial without it.
    logger.error({ hasPool: Boolean(pool), localAgentId, requestedAgentId },
      'bot posture undetermined: missing pool or agent identity; failing closed');
    throw new BotApplicationAuthorizationError('authorization_bot_posture_unavailable');
  }
  try {
    const mode = process.env.OSHAL_APPLICATION_AUTHORIZATION_MODE?.trim().toLowerCase() === 'legacy' ? 'legacy' : 'enforce';
    const ownership = await Promise.all([...new Set([localAgentId, requestedAgentId])].map(id =>
      readApplicationExecutionOwnership(pool, { kind: 'bots', id, mode })));
    const protectedApps = new Set(ownership.filter(row => row?.protected).map(row => row!.app));
    if (protectedApps.size > 1) throw new Error('Conflicting protected bot ownership');
    return [...protectedApps][0] ?? null;
  } catch (err) {
    // Fail closed, unchanged — the code and the 503 are the contract. What was missing is the
    // reason. A conflicting-ownership throw is a real posture DECISION; anything else is an
    // infrastructure fault (a 42501 from the ownership read) and is merely UNDETERMINED.
    // Both refuse; only the log tells them apart.
    const conflicting = err instanceof Error && err.message === 'Conflicting protected bot ownership';
    logger.error({ err, localAgentId, requestedAgentId, conflicting },
      conflicting
        ? 'bot posture refused: conflicting protected bot ownership'
        : 'bot posture undetermined; failing closed');
    throw new BotApplicationAuthorizationError('authorization_bot_posture_unavailable', err);
  }
}
