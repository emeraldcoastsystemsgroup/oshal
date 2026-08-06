/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added fail-closed Ed25519 verification, local-agent/body binding, shared single-use replay enforcement, and explicit mesh/batch bypass prohibition for bot-node HTTP execution.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Require the independent SWARM_SERVICE_SECRET machine credential whenever public-key delegation is enabled so sibling provider-mutation and replay endpoints cannot remain fail-open.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Verify the signed canonical request-body digest before replay consumption so one valid token cannot be raced with mutated execution fields.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Bind the signed delegation to the exact UTF-8 user subject, including significant whitespace, while rejecting controls and values over 512 bytes.
 */

import type { Request, RequestHandler, Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { isExactUserSubject } from '@/shared/security/exact-user-subject';
import {
  createDelegationTokenVerifier,
  DelegationTokenError,
  type DelegationTokenVerifier,
} from '@/shared/security/delegation-token';
import {
  DelegationReplayStoreUnavailableError,
  RedisDelegationReplayStore,
  type DelegationReplayStore,
} from '@/shared/security/delegation-replay-store';
import {
  DELEGATION_HTTP_HEADER,
  DelegationHttpPolicyError,
  SWARM_EXECUTE_DELEGATION_SCOPE,
  delegationAudienceFromEnvironment,
  delegationIssuerFromEnvironment,
  hasDelegationVerificationConfiguration,
} from '@/shared/security/delegation-http-policy';
import type {
  EnvelopeExecutionHandler,
  EnvelopeExecutionResult,
} from '@/features/swarm-orchestration';
import type { DelegationTokenClaims, DelegationTokenExpectations } from '@/shared/types';
import {
  DelegationRequestBindingError,
  delegationRequestBodySha256,
} from '@/shared/security/delegation-request-binding';

const logger = createChildLogger({ module: 'bot-node-delegation' });
const MAX_REPLAY_CLOCK_SKEW_SECONDS = 300;
type DelegationEnvironment = Readonly<Record<string, string | undefined>>;

interface VerifiedDelegationLocals {
  delegationClaims?: DelegationTokenClaims;
}

/** @description Construction seams for production wiring and Redis-free behavior tests. */
export interface BotNodeDelegationOptions {
  /** Trusted local agent identity loaded from the bot runtime, never from the request body. */
  localAgentId: string;
  /** Bot environment containing the public ring, exact policy, and independent service secret. */
  env?: DelegationEnvironment;
  /** Shared Redis endpoint used by the production single-use ledger. */
  redisUrl?: string;
  /** Injected verifier for deterministic tests; supplying it enables enforcement. */
  verifier?: DelegationTokenVerifier;
  /** Injected atomic replay ledger so tests never require Redis. */
  replayStore?: DelegationReplayStore;
}

/** @description Bot-node delegation posture and middleware assembled once at startup. */
export interface BotNodeDelegationRuntime {
  /** True when public key material makes every HTTP execution require a valid token. */
  enforcementEnabled: boolean;
  /** Express middleware that verifies exact bindings then atomically consumes the nonce. */
  authorize: RequestHandler;
  /** Releases the replay-store connection during graceful shutdown. */
  close(): Promise<void>;
}

/**
 * @description Builds the bot verifier. Key material turns enforcement on; partial, malformed, or
 * private-on-bot configuration throws during startup rather than silently running without checks.
 * @param options - Trusted local identity plus verifier/replay infrastructure seams.
 * @returns One immutable posture object shared by HTTP and mesh runtime wiring.
 */
export function createBotNodeDelegationRuntime(
  options: BotNodeDelegationOptions,
): BotNodeDelegationRuntime {
  const env = options.env ?? process.env;
  const localAgentId = requireLocalAgentId(options.localAgentId);
  const enforcementEnabled = options.verifier !== undefined
    || hasDelegationVerificationConfiguration(env);
  if (enforcementEnabled) requireMachineCredential(env);
  const verifier = enforcementEnabled
    ? options.verifier ?? createDelegationTokenVerifier({ env })
    : null;
  const replayStore = enforcementEnabled
    ? options.replayStore ?? new RedisDelegationReplayStore({ redisUrl: options.redisUrl })
    : null;
  const policy = enforcementEnabled ? buildPolicy(env, localAgentId) : null;
  const authorize = createDelegationAuthorization({
    enforcementEnabled, localAgentId, verifier, replayStore, policy,
  });
  logDelegationPosture(enforcementEnabled);
  return Object.freeze({
    enforcementEnabled,
    authorize,
    close: async () => { await replayStore?.close?.(); },
  });
}

/**
 * @description Returns verified signed claims attached by the delegation middleware.
 * @param res - Express response whose locals are request-scoped.
 * @returns Verified claims, or null while rollout is disabled.
 */
export function getVerifiedDelegationClaims(res: Response): DelegationTokenClaims | null {
  return (res.locals as VerifiedDelegationLocals).delegationClaims ?? null;
}

/**
 * @description Replaces unsigned Redis execution with an explicit failure while HTTP delegation
 * enforcement is active. Bid handling remains separate; no mesh envelope can reach the LLM.
 * @param enforcementEnabled - Current public-key rollout posture.
 * @param handler - Existing execution handler used only when rollout is disabled.
 * @returns An execution handler that cannot bypass signed HTTP authorization.
 */
export function prohibitUnsignedMeshExecution(
  enforcementEnabled: boolean,
  handler: EnvelopeExecutionHandler,
): EnvelopeExecutionHandler {
  if (!enforcementEnabled) return handler;
  return async (envelope): Promise<EnvelopeExecutionResult> => {
    logger.warn({
      correlationId: safeLogValue(envelope.correlationId),
      toAgentId: safeLogValue(envelope.toAgentId),
    }, 'Unsigned Redis mesh execution rejected while HTTP delegation enforcement is active');
    return {
      success: false,
      error: 'Unsigned Redis mesh execution is prohibited while delegation enforcement is active',
    };
  };
}

/**
 * @description Prohibits the one-shot batch runtime while bot verification keys are configured,
 * because that runtime has no signed HTTP request or replay ledger in this rollout phase.
 * @param env - Batch pod environment.
 * @throws Error when delegation enforcement is active.
 */
export function assertDelegationBatchRuntimeAllowed(
  env: DelegationEnvironment = process.env,
): void {
  if (hasDelegationVerificationConfiguration(env)) {
    throw new Error('bot-node-batch is prohibited while HTTP delegation enforcement is active');
  }
}

interface AuthorizationState {
  enforcementEnabled: boolean;
  localAgentId: string;
  verifier: DelegationTokenVerifier | null;
  replayStore: DelegationReplayStore | null;
  policy: Omit<DelegationTokenExpectations, 'sub' | 'principal_iss' | 'task_id' | 'body_sha256'> | null;
}

function createDelegationAuthorization(state: AuthorizationState): RequestHandler {
  return async (req, res, next): Promise<void> => {
    const startedAt = Date.now();
    const body = readBody(req);
    if (bodyAgentMismatches(body, state.localAgentId, state.enforcementEnabled)) {
      reject(res, 403, 'target_agent_mismatch', startedAt);
      return;
    }
    const token = readToken(req);
    if (!state.enforcementEnabled) {
      if (token !== undefined) reject(res, 401, 'delegation_not_configured', startedAt);
      else next();
      return;
    }
    await verifyAndConsume(req, res, next, body, token, state, startedAt);
  };
}

async function verifyAndConsume(
  _req: Request,
  res: Response,
  next: () => void,
  body: Record<string, unknown>,
  token: string | null | undefined,
  state: AuthorizationState,
  startedAt: number,
): Promise<void> {
  if (typeof token !== 'string' || !state.verifier || !state.replayStore || !state.policy) {
    reject(res, 401, 'delegation_required', startedAt);
    return;
  }
  try {
    const expected = expectedBindings(body, state.policy);
    const claims = state.verifier.verify(token, expected);
    const accepted = await state.replayStore.consume({
      issuer: claims.iss,
      jti: claims.jti,
      retainUntilEpochSeconds: claims.exp + MAX_REPLAY_CLOCK_SKEW_SECONDS,
    });
    if (!accepted) {
      reject(res, 409, 'delegation_replayed', startedAt);
      return;
    }
    (res.locals as VerifiedDelegationLocals).delegationClaims = claims;
    logger.info({ taskId: safeLogValue(claims.task_id), durationMs: Date.now() - startedAt }, 'HTTP delegation authorized');
    next();
  } catch (error) {
    handleAuthorizationError(error, res, startedAt);
  }
}

function expectedBindings(
  body: Record<string, unknown>,
  policy: Omit<DelegationTokenExpectations, 'sub' | 'principal_iss' | 'task_id' | 'body_sha256'>,
): DelegationTokenExpectations {
  return {
    ...policy,
    task_id: requireBodyText(body.taskId, 'taskId', 256),
    body_sha256: delegationRequestBodySha256(body),
    sub: requireBodyUserSub(body.userSub),
    principal_iss: requireBodyText(body.principalIssuer, 'principalIssuer', 2_048),
  };
}

function buildPolicy(
  env: DelegationEnvironment,
  localAgentId: string,
): Omit<DelegationTokenExpectations, 'sub' | 'principal_iss' | 'task_id' | 'body_sha256'> {
  return Object.freeze({
    iss: delegationIssuerFromEnvironment(env),
    aud: delegationAudienceFromEnvironment(env),
    azp: localAgentId,
    scope: SWARM_EXECUTE_DELEGATION_SCOPE,
  });
}

function handleAuthorizationError(error: unknown, res: Response, startedAt: number): void {
  if (error instanceof DelegationReplayStoreUnavailableError) {
    reject(res, 503, 'delegation_replay_unavailable', startedAt, error);
    return;
  }
  if (error instanceof DelegationTokenError || error instanceof DelegationRequestBindingError) {
    reject(res, 401, 'invalid_delegation', startedAt, error);
    return;
  }
  const infrastructureError = error instanceof Error
    ? error
    : new Error('Unknown delegation failure');
  reject(res, 503, 'delegation_verification_unavailable', startedAt, infrastructureError);
}

function reject(
  res: Response,
  status: number,
  code: string,
  startedAt: number,
  error?: Error,
): void {
  const fields = { code, status, durationMs: Date.now() - startedAt, ...(error ? { err: error } : {}) };
  if (status >= 500) logger.error(fields, 'HTTP delegation failed closed');
  else logger.warn(fields, 'HTTP delegation rejected');
  res.status(status).json({ success: false, error: code });
}

function readBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

function bodyAgentMismatches(
  body: Record<string, unknown>,
  localAgentId: string,
  required: boolean,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(body, 'agentId')) return required;
  return typeof body.agentId !== 'string' || body.agentId !== localAgentId;
}

function readToken(req: Request): string | null | undefined {
  const value = req.headers[DELEGATION_HTTP_HEADER];
  if (value === undefined) return undefined;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requireBodyText(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
    || /[\u0000-\u001F\u007F]/.test(value)
  ) {
    throw new DelegationTokenError('invalid_binding', `Delegation ${label} binding is invalid`);
  }
  return value;
}

function requireBodyUserSub(value: unknown): string {
  if (typeof value === 'string' && isExactUserSubject(value)) return value;
  throw new DelegationTokenError('invalid_binding', 'Delegation userSub binding is invalid');
}

function requireLocalAgentId(value: string): string {
  return requireBodyText(value, 'local agent', 256);
}

function requireMachineCredential(env: DelegationEnvironment): void {
  if (typeof env.SWARM_SERVICE_SECRET !== 'string' || env.SWARM_SERVICE_SECRET.trim() === '') {
    throw new DelegationHttpPolicyError(
      'SWARM_SERVICE_SECRET is required when bot-node delegation enforcement is active',
    );
  }
}

function safeLogValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 128) : undefined;
}

function logDelegationPosture(enforcementEnabled: boolean): void {
  if (enforcementEnabled) {
    logger.info('Bot-node HTTP delegation is fail-closed with Ed25519 verification and shared single-use replay protection');
    return;
  }
  logger.warn('Bot-node HTTP delegation is disabled because no public key ring is configured; any presented delegation token is rejected');
}
