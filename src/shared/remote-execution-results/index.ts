/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Carry controller-owned result lineage through concurrent remote calls into the durable parent result boundary.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthorizationActor } from '@/shared/application-authorization';
import type { ApplicationRemoteExecutionAuthority } from '@/shared/application-remote-execution';

/** @description Controller-only result destination; never constructed from a worker response or model output. */
export interface RemoteExecutionResultSink {
  taskId: string;
  record(executionId: string): Promise<void>;
}
const destinations = new AsyncLocalStorage<RemoteExecutionResultSink>();

/**
 * @description Retain the parent result destination across async specialist calls without mixing concurrent users.
 * @param sink Trusted route/queue destination and persistence callback.
 * @param execute Work whose protected outputs contribute to this destination.
 * @returns The work's result after any protected remote output has been durably linked.
 */
export function runWithRemoteExecutionResults<T>(sink: RemoteExecutionResultSink, execute: () => T): T {
  return destinations.run(sink, execute);
}

/**
 * @description Link a validated execution before returning its output to a parent that can persist or cache it.
 * @param authority Controller-owned durable authority.
 * @param executionId Locally prepared and signed execution identifier.
 * @param actor Original verified caller, never a response-supplied identity.
 * @returns Completion after both durable linkage and parent metadata persistence.
 */
export async function captureRemoteExecutionResult(authority: ApplicationRemoteExecutionAuthority, executionId: string, actor: AuthorizationActor): Promise<void> {
  const sink = destinations.getStore();
  if (!sink) return;
  await authority.linkResult(executionId, sink.taskId, actor);
  await sink.record(executionId);
}
