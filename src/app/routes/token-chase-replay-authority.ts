/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bind replay spend to the verified caller and reuse the normal hosted-brain ladder for non-carved CLI callers.
 */
import type { RequestHandler } from 'express';
import type { AppContext } from '@/app/composition/app-context';
import { BotNodeClient, BotNodeTailReplayClient, createRegistryEndpointResolver, type ReplayCallRequest, type ReplayCallResponse } from '@/features/agent-management';
import type { TailReplayer } from '@/features/token-chase';
import { getCaller, isOperator } from '@/shared/middleware/authz';
import { getAuthenticatedPrincipalIssuer } from '@/shared/middleware/principal-issuer';
import { getRequestIdentity, runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { agentRequiresHostedBrain, resolveHostedBrainMeta } from './inline-bot-execution';
import { cliBrainAvailable } from './user-brain-resolution';

/** @description Establishes spend authority from verified authentication even when the optional global DB identity middleware is disabled. */
export const bindTokenChaseReplayCaller: RequestHandler = (req, res, next) => {
  const sub = getCaller(req).sub;
  const principalIssuer = getAuthenticatedPrincipalIssuer(req);
  if (!sub || !principalIssuer) { res.status(401).json({ error: 'Replay requires a verified caller and issuer' }); return; }
  runWithRequestIdentity({ sub, principalIssuer, isOperator: isOperator(req) }, next);
};

/** @description Binds the optional spending pass while preserving the token-free tail restore contract. */
export const bindTokenChaseTailCaller: RequestHandler = (req, res, next) => {
  if (req.body?.refire === true) bindTokenChaseReplayCaller(req, res, next);
  else next();
};

/** @description Resolves a non-carved CLI caller's normal hosted connection; an unavailable ladder refuses before dispatch. */
async function replayBrain(pool: AppContext['pool'], agentId: string, sub: string): Promise<ReplayCallRequest['byoLlmConnection']> {
  const { getActiveRegistry } = await import('../extensions/swarm/swarm-bot-registry.js');
  const registry = getActiveRegistry();
  if (!agentRequiresHostedBrain(agentId, registry) || cliBrainAvailable(sub)) return undefined;
  const connection = await resolveHostedBrainMeta(pool, agentId, sub, { loadRegistry: () => registry });
  if (!connection) throw new Error('Replay hosted brain unavailable');
  return { baseUrl: connection.baseUrl, apiKey: connection.apiKey, model: connection.model };
}

/** @description Supplies caller-bound replay requests while retaining the established node transport and frame ownership checks. */
export class CallerBoundTokenChaseClient extends BotNodeClient {
  constructor(private readonly pool: AppContext['pool']) { super(createRegistryEndpointResolver()); }

  /** @description Overwrites producer identity with the current verified request and resolves an implicit CLI brain before any node dispatch. */
  override async replayCall(agentId: string, request: ReplayCallRequest): Promise<ReplayCallResponse> {
    const caller = getRequestIdentity();
    if (!caller?.sub || !caller.principalIssuer || caller.system) throw new Error('Replay caller authority missing');
    const byoLlmConnection = request.byoLlmConnection ?? await replayBrain(this.pool, agentId, caller.sub);
    return super.replayCall(agentId, { ...request, byoLlmConnection, userSub: caller.sub, principalIssuer: caller.principalIssuer });
  }
}

/** @description Reuses the normal hermetic tail transport and the same caller-bound client for its optional paid re-fire pass. */
export function callerBoundTailReplayer(client: CallerBoundTokenChaseClient): TailReplayer {
  const tail = new BotNodeTailReplayClient(createRegistryEndpointResolver());
  return { hasEndpoint: agentId => tail.hasEndpoint(agentId), replayTail: (agentId, request) => tail.replayTail(agentId, request),
    replayCall: (agentId, request) => client.replayCall(agentId, request) };
}
