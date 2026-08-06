/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add legacy-shadow-enforce user-route authentication that verifies route-bound bearer delegations, atomically consumes PostgreSQL authority, and derives database identity only from signed claims.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Include sanitized unverified workload attribution when shadow/enforce observes a legacy fleet-secret call.
 */

import type { Pool } from 'pg';
import type { Request, RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
import {
  hasAuthenticatedUserIdentity,
  hasValidServiceSecret,
} from '@/shared/middleware/authz';
import { delegationRequestBodySha256 } from '@/shared/security/delegation-request-binding';
import {
  createDelegationRouteTokenVerifier,
  DelegationTokenError,
  type DelegationRouteTokenVerifier,
} from '@/shared/security/delegation-token';
import {
  delegationIssuerFromEnvironment,
  workloadDelegationAudienceFromEnvironment,
} from '@/shared/security/delegation-http-policy';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import type { DelegationTokenClaims } from '@/shared/types';
import { PostgresWorkloadDelegationStore } from './postgres-workload-delegation-store';
import { legacyWorkloadLogContext } from './legacy-service-identity-containment';
import type {
  WorkloadDelegationConsumeOutcome,
  WorkloadDelegationMode,
  WorkloadDelegationStore,
} from './workload-delegation-types';
import {
  delegationPathFromOriginalUrl,
  resolveWorkloadDelegationRoute,
} from './workload-delegation-route-policy';

const logger = createChildLogger({ module: 'workload-delegation-middleware' });
const VERIFIED_DELEGATION = Symbol('oshal.verifiedWorkloadDelegation');

type DelegationEnvironment = Readonly<Record<string, string | undefined>>;
type DelegatedRequest = Request & { [VERIFIED_DELEGATION]?: DelegationTokenClaims };

/** @description Construction boundaries for the controller API delegation gate. */
export interface WorkloadDelegationMiddlewareOptions {
  pool?: Pool | null;
  store?: WorkloadDelegationStore;
  verifier?: DelegationRouteTokenVerifier;
  fallback: RequestHandler;
  env?: DelegationEnvironment;
  nowEpochSeconds?: () => number;
}

/**
 * @description Reads verified claims attached only after signature, route, durable binding,
 * revocation, workload lifecycle, and one-time consumption checks all succeed.
 * @param req - Current Express request.
 * @returns Defensive claim copy, or null for ordinary browser/PAT/legacy requests.
 */
export function getVerifiedWorkloadDelegation(req: Request): DelegationTokenClaims | null {
  const claims = (req as DelegatedRequest)[VERIFIED_DELEGATION];
  return claims ? { ...claims, scope: [...claims.scope] } : null;
}

/**
 * @description Parses the explicit SEC-01 migration stage. Unknown values fail closed to enforce;
 * compatibility requires naming `legacy` or `shadow` deliberately.
 * @param env - Controller environment containing OSHAL_WORKLOAD_DELEGATION_MODE.
 * @returns Exact legacy, shadow, or enforce posture.
 */
export function workloadDelegationMode(
  env: DelegationEnvironment = process.env,
): WorkloadDelegationMode {
  const value = (env.OSHAL_WORKLOAD_DELEGATION_MODE ?? 'legacy').trim().toLowerCase();
  if (value === 'legacy' || value === 'shadow' || value === 'enforce') return value;
  return 'enforce';
}

/**
 * @description Creates the Graph/Jarvis authentication boundary. Browser OIDC/PAT remains on the
 * supplied fallback. In shadow, legacy machine calls continue with telemetry; in enforce, a fleet
 * secret never asserts a user and only a signed, durable, route-bound token reaches user data.
 * @param options - Pool/store, public verifier, fallback auth, environment, and clock seams.
 * @returns Express middleware suitable for both `/api/graph` and `/api/jarvis` mounts.
 */
export function createWorkloadDelegationMiddleware(
  options: WorkloadDelegationMiddlewareOptions,
): RequestHandler {
  const env = options.env ?? process.env;
  const mode = workloadDelegationMode(env);
  const nowEpochSeconds = options.nowEpochSeconds ?? (() => Math.floor(Date.now() / 1_000));
  const store = buildStore(mode, options);
  const verifier = buildVerifier(mode, options, env, nowEpochSeconds);
  logger.info({ mode }, 'Workload delegation route posture initialized');
  return async (req, res, next): Promise<void> => {
    const startedAt = Date.now();
    try {
      const path = delegationPathFromOriginalUrl(req.originalUrl);
      const policy = resolveWorkloadDelegationRoute(req.method, path);
      if (!policy || mode === 'legacy' || hasAuthenticatedUserIdentity(req)) {
        options.fallback(req, res, next);
        return;
      }
      const token = readDelegationBearer(req);
      if (!token) {
        handleMissingDelegation(req, res, next, mode, policy.routeTemplate, options.fallback);
        return;
      }
      if (!store || !verifier) throw new Error('Workload delegation authority is unavailable');
      const claims = verifier.verify(token, {
        iss: delegationIssuerFromEnvironment(env),
        aud: workloadDelegationAudienceFromEnvironment(env),
        method: policy.method,
        path,
        body_sha256: delegationRequestBodySha256(req.body ?? null),
        scope: policy.requiredScopes,
      });
      const outcome = await store.consumeDelegation(claims, new Date(nowEpochSeconds() * 1_000));
      if (outcome !== 'authorized') {
        rejectOutcome(res, outcome, startedAt, policy.routeTemplate);
        return;
      }
      (req as DelegatedRequest)[VERIFIED_DELEGATION] = Object.freeze({
        ...claims,
        scope: Object.freeze([...claims.scope]),
      }) as DelegationTokenClaims;
      logger.info({ workloadId: claims.azp, method: policy.method, route: policy.routeTemplate, durationMs: Date.now() - startedAt }, 'Workload delegation authorized');
      runWithRequestIdentity({
        sub: claims.sub,
        principalIssuer: claims.principal_iss,
        isOperator: false,
      }, () => next());
    } catch (error) {
      handleMiddlewareError(error, res, startedAt);
    }
  };
}

function buildStore(
  mode: WorkloadDelegationMode,
  options: WorkloadDelegationMiddlewareOptions,
): WorkloadDelegationStore | null {
  if (mode === 'legacy') return null;
  if (options.store) return options.store;
  if (!options.pool) throw new Error('Workload delegation shadow/enforce mode requires PostgreSQL');
  return new PostgresWorkloadDelegationStore(options.pool);
}

function buildVerifier(
  mode: WorkloadDelegationMode,
  options: WorkloadDelegationMiddlewareOptions,
  env: DelegationEnvironment,
  nowEpochSeconds: () => number,
): DelegationRouteTokenVerifier | null {
  if (mode === 'legacy') return null;
  if (options.verifier) return options.verifier;
  return createDelegationRouteTokenVerifier({
    env: {
      OSHAL_DELEGATION_PUBLIC_KEYS: env.OSHAL_WORKLOAD_DELEGATION_PUBLIC_KEYS,
      OSHAL_DELEGATION_CLOCK_SKEW_SECONDS: env.OSHAL_DELEGATION_CLOCK_SKEW_SECONDS,
    },
    nowEpochSeconds,
  });
}

function readDelegationBearer(req: Request): string | null {
  const value = req.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return null;
  const token = value.slice('Bearer '.length);
  if (!token || token !== token.trim() || !looksLikeDelegationToken(token)) return null;
  return token;
}

function looksLikeDelegationToken(token: string): boolean {
  const segments = token.split('.');
  if (segments.length !== 3 || segments[0].length > 684) return false;
  try {
    const header = JSON.parse(Buffer.from(segments[0], 'base64url').toString('utf8')) as { typ?: unknown };
    return header?.typ === 'OSHAL-DLG';
  } catch {
    return false;
  }
}

function handleMissingDelegation(
  req: Request,
  res: Parameters<RequestHandler>[1],
  next: Parameters<RequestHandler>[2],
  mode: WorkloadDelegationMode,
  route: string,
  fallback: RequestHandler,
): void {
  if (mode === 'enforce' && hasValidServiceSecret(req)) {
    logger.warn({ method: req.method, route, ...legacyWorkloadLogContext(req) }, 'Legacy fleet secret refused on delegated user route');
    res.status(403).json({ error: 'legacy_service_identity_not_allowed' });
    return;
  }
  if (mode === 'shadow' && hasValidServiceSecret(req)) {
    logger.warn({ method: req.method, route, posture: 'shadow', ...legacyWorkloadLogContext(req) }, 'Legacy fleet secret observed without user delegation');
  }
  fallback(req, res, next);
}

function rejectOutcome(
  res: Parameters<RequestHandler>[1],
  outcome: WorkloadDelegationConsumeOutcome,
  startedAt: number,
  route: string,
): void {
  const response = outcomeResponse(outcome);
  logger.warn({ outcome, status: response.status, route, durationMs: Date.now() - startedAt }, 'Durable workload delegation rejected');
  res.status(response.status).json({ error: response.code });
}

function outcomeResponse(outcome: WorkloadDelegationConsumeOutcome): { status: number; code: string } {
  if (outcome === 'replayed') return { status: 409, code: 'delegation_replayed' };
  if (outcome === 'binding_mismatch' || outcome === 'insufficient_scope' || outcome === 'not_active') {
    return { status: 403, code: 'delegation_forbidden' };
  }
  return { status: 401, code: 'invalid_delegation' };
}

function handleMiddlewareError(error: unknown, res: Parameters<RequestHandler>[1], startedAt: number): void {
  if (error instanceof DelegationTokenError) {
    logger.warn({ code: error.code, durationMs: Date.now() - startedAt }, 'Workload delegation token rejected');
    res.status(401).json({ error: 'invalid_delegation' });
    return;
  }
  logger.error({ err: error, durationMs: Date.now() - startedAt }, 'Workload delegation verification unavailable');
  res.status(503).json({ error: 'delegation_verification_unavailable' });
}
