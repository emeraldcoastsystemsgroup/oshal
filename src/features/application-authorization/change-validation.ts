/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 */
import type { AuthorizationChange, AuthorizationApplyInput } from '@/shared/application-authorization';
import { ApplicationAuthorizationError } from './types';
import { validSubject } from './policy';
function reject(): never { throw new ApplicationAuthorizationError(400, 'invalid_authorization_change'); }
export function parseAuthorizationChange(input: unknown): AuthorizationChange {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return reject();
  const value = input as Record<string, unknown>;
  const keys = ['action','app','targetSub','targetIssuer','tenantId','role','permission','expiresAt','reason','expectedRevision','group'];
  if (Object.keys(value).some(key => !keys.includes(key))) return reject();
  if (!['grant','revoke','deny','clear-deny','group-map','group-unmap'].includes(String(value.action))) return reject();
  if (typeof value.app !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(value.app)) return reject();
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) return reject();
  if (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 2000) return reject();
  for (const key of ['targetSub','targetIssuer','tenantId','role','permission']) if (value[key] !== undefined && !validSubject(value[key])) return reject();
  if (value.expiresAt !== undefined && (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)))) return reject();
  const groupAction = String(value.action).startsWith('group-');
  if (value.group !== undefined) {
    if (!value.group || typeof value.group !== 'object' || Array.isArray(value.group)) return reject();
    const group = value.group as Record<string, unknown>;
    if (Object.keys(group).some(key => !['issuer','tenantId','id'].includes(key)) || !['issuer','tenantId','id'].every(key => validSubject(group[key]))) return reject();
    if (value.targetSub !== undefined || value.targetIssuer !== undefined) return reject();
  } else if (!validSubject(value.targetSub) || !validSubject(value.targetIssuer)) return reject();
  if (groupAction !== Boolean(value.group) && !['deny','clear-deny'].includes(String(value.action))) return reject();
  if (['grant','revoke','group-map','group-unmap'].includes(String(value.action)) && (!value.role || value.permission !== undefined)) return reject();
  if (['deny','clear-deny'].includes(String(value.action)) && value.role !== undefined) return reject();
  return structuredClone(value) as unknown as AuthorizationChange;
}
export function parseAuthorizationApply(input: unknown): AuthorizationApplyInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return reject();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['previewId','idempotencyKey','approvalReference'].includes(key))) return reject();
  for (const field of ['previewId','idempotencyKey']) if (typeof value[field] !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value[field] as string)) return reject();
  if (value.approvalReference !== undefined && !validSubject(value.approvalReference)) return reject();
  return structuredClone(value) as unknown as AuthorizationApplyInput;
}
