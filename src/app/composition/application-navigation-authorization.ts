/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Admit explicit browser workspace navigation and current shell-only member access without selecting a data workspace.
 */
import type { Request } from 'express';
import { resolveOperationPermissions } from '@/features/application-authorization';
import type { AuthorizationActor, AuthorizationAppRegistration, AuthorizationDecision, AuthorizationOperation } from '@/shared/application-authorization';

/** @description Read a browser GET selector using the same untrusted selection contract as the API header.
 * @param req Current request. @returns Valid selection or a closed malformed-input result.
 */
export function navigationWorkspace(req: Request): { valid: boolean; explicit: boolean; tenantId?: string } {
  const header = req.get('x-oshal-tenant-id');
  const parameters = new URL(req.originalUrl || req.url, 'http://navigation.invalid').searchParams;
  const values = req.method === 'GET' ? parameters.getAll('workspace') : [];
  if (req.method === 'GET' && (values.length > 1 || [...parameters.keys()].some(key => key.startsWith('workspace[')))) return { valid: false, explicit: true };
  const query = values[0];
  const valid = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
  if ((header !== undefined && !valid(header)) || (query !== undefined && !valid(query)) ||
    (header !== undefined && query !== undefined && header !== query)) return { valid: false, explicit: true };
  return { valid: true, explicit: header !== undefined || query !== undefined, tenantId: header || query || undefined };
}

/** @description Permit only a declared read-only application shell through current member grants when no workspace was selected.
 * @param registration Activated catalog. @param actor Verified current actor. @param operation Original HTTP operation.
 * @param explicit Whether the caller selected a workspace. @param authorize Current full policy check.
 * @returns Current decision; data operations and explicit selections never receive a fallback.
 */
export async function authorizeApplicationNavigation(registration: AuthorizationAppRegistration, actor: AuthorizationActor,
  operation: AuthorizationOperation, explicit: boolean,
  authorize: (operation: AuthorizationOperation) => Promise<AuthorizationDecision>): Promise<AuthorizationDecision> {
  const decision = await authorize(operation);
  if (decision.allowed || explicit || operation.method !== 'GET') return decision;
  const permissions = resolveOperationPermissions({ ...registration, catalogRevision: '' }, operation);
  if (permissions?.length !== 1 || permissions[0] !== 'app.open' || registration.catalog?.permissions['app.open']?.effect !== 'read') return decision;
  for (const tenantId of actor.tenantIds ?? []) {
    const candidate = await authorize({ ...operation, tenantId });
    if (candidate.allowed) return candidate;
  }
  return decision;
}
