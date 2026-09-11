/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify fresh controller-signed application permits against exact worker challenges and dispatch bindings.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { REMOTE_EXECUTION_PATH, REMOTE_PERMIT_AUDIENCE, REMOTE_PERMIT_SCOPE,
  type RemoteExecutionBinding, type RemoteExecutionCheck, type RemoteExecutionPermit } from '@/shared/application-remote-execution';
import { createDelegationTokenVerifier, type DelegationTokenVerifier } from '@/shared/security/delegation-token';
import { delegationIssuerFromEnvironment } from '@/shared/security/delegation-http-policy';
import { delegationRequestBodySha256 } from '@/shared/security/delegation-request-binding';
import type { DelegationTokenClaims } from '@/shared/types';

const text = z.string().min(1).max(2048);
const action = z.object({ kind: z.enum(['tools','bots']), operation: text, resourceId: text.optional(), fields: z.array(text).max(128).optional() }).strict();
const PermitSchema = z.object({ executionId: z.string().uuid(), app: text, agentId: text, taskId: text, workspaceId: text,
  sub: text, issuer: text, tenantId: text.optional(), phase: z.enum(['start','work','action','complete']), nonce: z.string().uuid(),
  dispatchJti: text, allowedPermissions: z.array(z.string().min(1).max(256)).max(512), expiresAt: text, action: action.optional() }).strict();
const ResponseSchema = z.object({ permit: PermitSchema, token: z.string().min(1).max(8192) }).strict();

/** @description A fixed-destination current-policy query with independently verified signed responses. */
export interface BotControllerPermitOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  verifier?: DelegationTokenVerifier;
  now?: () => number;
  nonce?: () => string;
  timeoutMs?: number;
}

/**
 * @description Construct a worker-only verifier; requests never choose the destination or signed actor.
 * @param options - Trusted process configuration and isolated test seams.
 * @returns A bounded phase check that rejects unsigned, stale or mismatched decisions.
 */
export function createBotControllerPermitCheck(options: BotControllerPermitOptions = {}) {
  const env = options.env ?? process.env;
  const base = new URL(env.SWARM_CONTROLLER_URL || 'http://oshal-api:5000');
  if (!['http:','https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('Remote authorization controller configuration is invalid');
  }
  const url = new URL(REMOTE_EXECUTION_PATH, base).href;
  const verifier = options.verifier ?? createDelegationTokenVerifier({ env });
  const now = options.now ?? Date.now;
  return async (binding: RemoteExecutionBinding, dispatch: DelegationTokenClaims, token: string,
    phase: Exclude<RemoteExecutionCheck['phase'], 'action'>): Promise<RemoteExecutionPermit> => {
    const request: RemoteExecutionCheck = { executionId: binding.executionId, token, phase, nonce: (options.nonce ?? randomUUID)() };
    const result = ResponseSchema.parse(await postCheck(url, request, env, options));
    const permit = result.permit;
    verifier.verify(result.token, { iss: delegationIssuerFromEnvironment(env), aud: REMOTE_PERMIT_AUDIENCE,
      sub: binding.sub, principal_iss: binding.issuer, azp: binding.agentId, task_id: binding.taskId,
      method: 'POST', path: REMOTE_EXECUTION_PATH, scope: REMOTE_PERMIT_SCOPE, body_sha256: delegationRequestBodySha256(permit) });
    for (const key of ['executionId','app','agentId','taskId','workspaceId','sub','issuer','tenantId'] as const) {
      if (key === 'tenantId' && phase === 'start' && binding.tenantId === undefined) continue;
      if (permit[key] !== binding[key]) throw new Error('Remote authorization binding changed');
    }
    const expires = Date.parse(permit.expiresAt);
    if (permit.phase !== phase || permit.nonce !== request.nonce || permit.dispatchJti !== dispatch.jti || permit.action !== undefined
      || !Number.isFinite(expires) || expires <= now() || expires > now() + 15_000 || now() >= dispatch.exp * 1000) {
      throw new Error('Remote authorization permit is stale or mismatched');
    }
    return permit;
  };
}

async function postCheck(url: string, input: RemoteExecutionCheck, env: NodeJS.ProcessEnv, options: BotControllerPermitOptions): Promise<unknown> {
  if (!env.SWARM_SERVICE_SECRET?.trim()) throw new Error('Remote authorization machine credential is unavailable');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 5000);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, { method: 'POST', redirect: 'error', signal: abort.signal,
      headers: { 'Content-Type': 'application/json', 'X-Service-Secret': env.SWARM_SERVICE_SECRET }, body: JSON.stringify(input) });
    if (!response.ok) throw new Error('Remote application authorization denied');
    return JSON.parse(await boundedResponse(response));
  } finally { clearTimeout(timer); }
}

async function boundedResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) throw new Error('Remote authorization response is empty');
  const parts: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 32_768) throw new Error('Remote authorization response is too large');
      parts.push(chunk.value);
    }
    return Buffer.concat(parts).toString('utf8');
  } finally { await reader.cancel(); }
}
