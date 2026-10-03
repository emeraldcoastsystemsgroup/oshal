/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Parse bounded composite requests and per-preview approval references without accepting caller-built authority or installation provenance.
 */
import type { CompositeRoleInput, CompositeRoleApplyInput } from '@/shared/application-authorization';
import { ApplicationAuthorizationError } from './types';
import { validSubject } from './policy';

const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;
const TOKEN = /^[A-Za-z0-9_-]{8,128}$/;
function reject(): never { throw new ApplicationAuthorizationError(400, 'invalid_composite_role_request'); }
function record(input: unknown, allowed: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return reject();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !allowed.includes(key))) return reject();
  return value;
}
/** @description Reject forged authority and ambiguous qualified lifecycle targets.
 * @param input Untrusted body. @returns Closed bounded selection. */
export function parseCompositeRoleInput(input: unknown): CompositeRoleInput {
  const v = record(input, ['action', 'app', 'template', 'assignmentId', 'targetSub', 'targetIssuer', 'group', 'tenantId', 'optionalApps', 'expiresAt', 'reason', 'expectedRevision']);
  if (!['assign', 'upgrade', 'revoke'].includes(String(v.action)) || typeof v.app !== 'string' || !SLUG.test(v.app)) return reject();
  if (!Number.isSafeInteger(v.expectedRevision) || (v.expectedRevision as number) < 0) return reject();
  if (typeof v.reason !== 'string' || !v.reason.trim() || v.reason.length > 2000) return reject();
  for (const key of ['targetSub', 'targetIssuer', 'tenantId']) if (v[key] !== undefined && !validSubject(v[key])) return reject();
  if (v.action === 'assign') {
    if (v.assignmentId !== undefined || typeof v.template !== 'string' || !SLUG.test(v.template)) return reject();
    if (v.group !== undefined) {
      const group = record(v.group, ['issuer', 'tenantId', 'id']);
      if (!['issuer', 'tenantId', 'id'].every(key => validSubject(group[key])) || v.targetSub !== undefined || v.targetIssuer !== undefined) return reject();
      if (v.tenantId !== undefined && v.tenantId !== group.tenantId) return reject();
    } else if (!validSubject(v.targetSub) || !validSubject(v.targetIssuer)) return reject();
  } else {
    if (typeof v.assignmentId !== 'string' || !TOKEN.test(v.assignmentId)
      || ['targetSub', 'targetIssuer', 'group', 'tenantId', 'template'].some(key => v[key] !== undefined)) return reject();
  }
  if (v.action === 'revoke' && (v.optionalApps !== undefined || v.expiresAt !== undefined)) return reject();
  if (v.expiresAt !== undefined && !(v.action === 'upgrade' && v.expiresAt === null)
    && (typeof v.expiresAt !== 'string' || !Number.isFinite(Date.parse(v.expiresAt)))) return reject();
  if (v.optionalApps !== undefined && (!Array.isArray(v.optionalApps) || v.optionalApps.length > 128
    || v.optionalApps.some(app => typeof app !== 'string' || !SLUG.test(app)) || new Set(v.optionalApps).size !== v.optionalApps.length)) return reject();
  return structuredClone(v) as unknown as CompositeRoleInput;
}
/** @description Accept only server review identifiers and explicit existing approval references.
 * @param input Untrusted body. @returns Bounded apply selection. */
export function parseCompositeRoleApply(input: unknown): CompositeRoleApplyInput {
  const v = record(input, ['previewId', 'idempotencyKey', 'approvals']);
  if (typeof v.previewId !== 'string' || !TOKEN.test(v.previewId) || typeof v.idempotencyKey !== 'string' || !TOKEN.test(v.idempotencyKey)) return reject();
  if (v.approvals !== undefined) {
    if (!v.approvals || typeof v.approvals !== 'object' || Array.isArray(v.approvals)) return reject();
    const entries = Object.entries(v.approvals);
    if (entries.length > 256 || entries.some(([key, value]) => !TOKEN.test(key) || !validSubject(value))) return reject();
  }
  return structuredClone(v) as unknown as CompositeRoleApplyInput;
}
/** @description Keep metadata filters separate from authority or subject claims.
 * @param input Untrusted filters. @returns Closed app/tenant filters. */
export function parseCompositeRoleList(input: unknown): { app?: string; tenantId?: string } {
  const v = record(input, ['app', 'tenantId']);
  if (v.app !== undefined && (typeof v.app !== 'string' || !SLUG.test(v.app))) return reject();
  if (v.tenantId !== undefined && !validSubject(v.tenantId)) return reject();
  return structuredClone(v) as { app?: string; tenantId?: string };
}
