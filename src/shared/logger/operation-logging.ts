/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Observe authorization and streaming operations without logging principal, request, result or error-message content.
 */
import type { Logger } from 'pino';
import { locationSafeError } from './location-safe-error';

type OperationLogger = Pick<Logger, 'info' | 'error'>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @description Candidate bindings; runtime projection also rejects unexpected fields and arbitrary identifier text. */
export interface OperationLogContext {
  agentId?: string;
  taskId?: string;
  executionId?: string;
  clientId?: string;
  workspaceId?: string;
  phase?: string;
  attempt?: number;
}

/**
 * @description Keep only canonical identifiers and bounded control metadata; TypeScript types alone do not sanitize callers.
 * @param context Candidate operation bindings, never a request or result object.
 * @returns A fresh allowlisted structured log object.
 */
function safeContext(context: OperationLogContext): Record<string, string | number | boolean> {
  const fields: Record<string, string | number | boolean> = {};
  for (const key of ['agentId', 'taskId', 'executionId', 'clientId', 'workspaceId'] as const) {
    const value = context[key];
    if (typeof value === 'string' && UUID.test(value)) fields[key] = value;
  }
  // Workspace identifiers may be filesystem paths; their contents must not enter logs.
  if (context.workspaceId !== undefined) fields.hasWorkspace = Boolean(context.workspaceId);
  if (['start', 'work', 'action', 'complete'].includes(context.phase ?? '')) fields.phase = context.phase!;
  if (Number.isInteger(context.attempt) && context.attempt! >= 0 && context.attempt! <= 4) fields.attempt = context.attempt!;
  return fields;
}

/**
 * @description Diagnose an observed catch with scrubbed stack frames instead of secret-bearing error messages.
 * @param log Existing module logger.
 * @param operation Fixed code-defined operation name.
 * @param context Allowlisted operation bindings.
 * @param error Original caught value; never serialized directly.
 * @param startedAt Operation start in Date.now milliseconds.
 * @returns Nothing; callers retain their existing refusal, retry or rethrow behavior.
 */
export function logOperationError(log: OperationLogger, operation: string, context: OperationLogContext,
  error: unknown, startedAt: number): void {
  log.error({ ...safeContext(context), operation, event: 'error', durationMs: Date.now() - startedAt,
    err: locationSafeError(error) }, 'Operation failed');
}

/**
 * @description Observe a synchronous boundary without changing its return value or exception identity.
 * @param log Existing module logger.
 * @param operation Fixed code-defined operation name.
 * @param context Candidate safe bindings; request and result content is excluded.
 * @param execute Existing work, executed exactly once.
 * @returns The unchanged result, with false classified as a denied decision in the exit log.
 */
export function observeOperation<T>(log: OperationLogger, operation: string, context: OperationLogContext, execute: () => T): T {
  const startedAt = Date.now(), fields = safeContext(context);
  let outcome = 'completed';
  log.info({ ...fields, operation, event: 'entry' }, 'Operation started');
  try {
    const result = execute();
    if (result === false) outcome = 'denied';
    return result;
  } catch (error) {
    outcome = 'failed';
    logOperationError(log, operation, context, error, startedAt);
    throw error;
  } finally {
    log.info({ ...fields, operation, event: 'exit', outcome, durationMs: Date.now() - startedAt }, 'Operation finished');
  }
}

/**
 * @description Observe asynchronous work without logging results or changing authorization, request identity or error behavior.
 * @param log Existing module logger.
 * @param operation Fixed code-defined operation name.
 * @param context Candidate safe bindings; principal and payload objects are excluded.
 * @param execute Existing work, executed exactly once in the caller's asynchronous context.
 * @returns The unchanged result; denied decisions and thrown failures retain terminal duration logs.
 */
export async function observeAsyncOperation<T>(log: OperationLogger, operation: string, context: OperationLogContext,
  execute: () => Promise<T>): Promise<T> {
  const startedAt = Date.now(), fields = safeContext(context);
  let outcome = 'completed';
  log.info({ ...fields, operation, event: 'entry' }, 'Operation started');
  try {
    const result = await execute();
    if (result === false) outcome = 'denied';
    return result;
  } catch (error) {
    outcome = 'failed';
    logOperationError(log, operation, context, error, startedAt);
    throw error;
  } finally {
    log.info({ ...fields, operation, event: 'exit', outcome, durationMs: Date.now() - startedAt }, 'Operation finished');
  }
}
