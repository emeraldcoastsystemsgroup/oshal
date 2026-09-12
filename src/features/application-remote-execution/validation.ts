/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Reject ambiguous or oversized remote phase inputs and preserve exact signed identity bindings.
 */
import { z } from 'zod';
import type { AuthorizationActor } from '@/shared/application-authorization';
import type { RemoteExecutionCheck, PrepareRemoteExecutionInput } from '@/shared/application-remote-execution';
import { RemoteExecutionError } from './types';

const text = z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const reference = z.string().uuid();
const action = z.object({ kind: z.enum(['bots', 'tools']), operation: text,
  resourceId: text.optional(), fields: z.array(text).max(100).optional() }).strict();
const check = z.object({ executionId: reference, token: z.string().min(16).max(16384),
  phase: z.enum(['start', 'work', 'action', 'complete']), nonce: z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/),
  action: action.optional() }).strict().refine(value => (value.phase === 'action') === Boolean(value.action));
const preparation = z.object({ agentId: text, taskId: text, workspaceId: text, tenantId: text.optional() }).strict();

/** @description Parse the closed worker phase protocol without accepting a caller-supplied actor or app.
 * @param value Untrusted JSON request. @returns Validated phase input.
 */
export function parseRemoteExecutionCheck(value: unknown): RemoteExecutionCheck {
  const parsed = check.safeParse(value);
  if (!parsed.success) throw new RemoteExecutionError('invalid_remote_execution_request', 400);
  return parsed.data;
}
/** @description Validate exact controller dispatch identifiers before creating provenance.
 * @param value Trusted composition input. @returns Checked identifiers.
 */
export function parseRemotePreparation(value: unknown): PrepareRemoteExecutionInput {
  const parsed = preparation.safeParse(value);
  if (!parsed.success) throw new RemoteExecutionError('invalid_remote_execution_binding', 400);
  return parsed.data;
}
/** @description Validate opaque references before sending them to a UUID database column.
 * @param value Candidate execution ID. @returns The checked reference.
 */
export function requireExecutionId(value: string): string {
  if (!reference.safeParse(value).success) throw new RemoteExecutionError('remote_execution_unavailable');
  return value;
}
/** @description Copy only authenticated business evidence, never management authority, into execution state.
 * @param actor Trusted current actor. @param ceiling Original allowed permissions. @returns Restricted actor copy.
 */
export function executionActor(actor: AuthorizationActor, ceiling?: readonly string[]): AuthorizationActor {
  if (!actor.isActive || !text.safeParse(actor.sub).success || !text.safeParse(actor.issuer).success) {
    throw new RemoteExecutionError('remote_execution_identity_required');
  }
  if ((actor.directory?.length ?? 0) > 16 || (actor.allowedPermissions?.length ?? 0) > 1024) throw new RemoteExecutionError('remote_execution_evidence_unavailable');
  const allowedPermissions = ceiling === undefined ? actor.allowedPermissions : [...ceiling].filter(permission =>
    actor.allowedPermissions === undefined || actor.allowedPermissions.includes(permission));
  return structuredClone({ sub: actor.sub, issuer: actor.issuer, isActive: true, isSwarmAdmin: false,
    tenantIds: actor.tenantIds ?? [], directory: actor.directory ?? [], ...(allowedPermissions ? { allowedPermissions } : {}) });
}
