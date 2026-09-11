/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Isolate protected bot history by exact principal, tenant, application, bot and one controller-authorized execution.
 */
import { createHash } from 'node:crypto';
import { isExactUserSubject } from '@/shared/security/exact-user-subject';
import { canonicalBotWorkspaceId } from './bot-node-request-scope';

/** @description Controller-authorized identity and application binding, never a model-supplied workspace path. */
export interface ProtectedBotWorkspaceBinding {
  principalIssuer: string;
  userSub: string;
  app: string;
  agentId: string;
  workspaceFolderId: string;
  executionId: string;
  tenantId?: string;
}

/**
 * @description Prevent reuse of legacy, foreign-principal or earlier-execution history after grants change.
 * @param binding - Exact binding established by verified delegation and current controller policy.
 * @returns A canonical isolated directory identifier with no readable user identity in its path.
 */
export function protectedBotWorkspaceId(binding: ProtectedBotWorkspaceBinding): string {
  if (!isExactUserSubject(binding.userSub)) throw new Error('Protected workspace identity is invalid');
  for (const value of [binding.principalIssuer, binding.app, binding.agentId, binding.executionId,
    ...(binding.tenantId === undefined ? [] : [binding.tenantId])]) {
    if (!value || value !== value.trim() || value.length > 2048 || /[\u0000-\u001F\u007F]/.test(value)) {
      throw new Error('Protected workspace binding is invalid');
    }
  }
  const logicalWorkspace = canonicalBotWorkspaceId(binding.workspaceFolderId);
  const digest = createHash('sha256').update('oshal-protected-bot-workspace-v1\0').update(JSON.stringify([
    binding.principalIssuer, binding.userSub, binding.app, binding.agentId, binding.tenantId ?? null, logicalWorkspace, binding.executionId,
  ])).digest('hex');
  return `protected-${digest}`;
}
