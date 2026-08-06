/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the bot-node HTTP execution identity boundary into an import-safe seam for production wiring and real-HTTP RLS regression tests.
 */

import { runWithSystemIdentity } from '@/shared/services/database/request-identity';

/**
 * @description Runs one already-authorized bot-node execution under the explicit platform system
 * sentinel. Bot nodes have no controller request-identity middleware, but their cost/task writes
 * must remain visible under strict RLS without relying on an identity-less compatibility branch.
 * @param operation - Authorized execution operation; synchronous and async return types are preserved.
 * @returns The operation result while the system identity is active in AsyncLocalStorage.
 */
export function runBotNodeExecutionWithSystemIdentity<T>(operation: () => T): T {
  return runWithSystemIdentity(operation);
}
