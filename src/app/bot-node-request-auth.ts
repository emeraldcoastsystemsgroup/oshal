/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Security-audit: authorizeBotNodeExecutionCall fails CLOSED for identity/credential-bearing payloads (userSub/creds/byoLlmConnection/providerIntent) even when SWARM_SERVICE_SECRET is unset; anonymous legacy calls stay compatible via requireServiceSecretWhenConfigured.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Backfilled the missing change-log header. Loud fail-open posture (security audit 2026-06-16 backlog item): when SWARM_SERVICE_SECRET is unset the gate still allows local-dev traffic, but now logs a per-request WARN naming the backlog item; logBotNodeAuthPosture() gives the matching one-time startup WARN. Added authorizeBotNodeInternalCall so sibling execution endpoints (/api/token-chase/replay-call) share the same warned gate instead of the silent shared middleware.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Treat every supplied userSub property as scoped execution data so empty, whitespace, malformed, and non-string identity assertions cannot bypass the fail-closed service-secret gate.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: all bot-node execution/control calls now use the strict service-secret gate and startup fails before listening when the secret is absent.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Security hardening: add a strict pre-parser machine gate for every non-health path so unauthenticated callers are rejected before JSON buffering/parsing; only deliberate GET health/metrics probes remain public.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Accept route/body/user-bound Ed25519 execution delegation as the machine credential for exact POST /api/swarm-execute so managed model nodes can omit the fleet secret; sibling privileged routes remain shared-secret-only.
 */

import type { RequestHandler } from 'express';
import { requireServiceSecret } from '@/shared/middleware/authz';
import { createChildLogger } from '@/shared/logger';
import {
  DELEGATION_HTTP_HEADER,
  SWARM_EXECUTE_DELEGATION_METHOD,
  SWARM_EXECUTE_DELEGATION_PATH,
  hasDelegationVerificationConfiguration,
} from '@/shared/security/delegation-http-policy';

const logger = createChildLogger({ module: 'bot-node-request-auth' });
const MAX_DELEGATION_HEADER_BYTES = 8_192;

/**
 * @description Whether the shared bot-node service secret is configured. When true, every
 * privileged bot-node execution endpoint fails CLOSED without a matching
 * X-Service-Secret. Startup also rejects false so no unprotected listener is created.
 * @returns True when SWARM_SERVICE_SECRET is set to a non-blank value.
 */
export function isServiceSecretConfigured(): boolean {
  return (process.env.SWARM_SERVICE_SECRET || '').trim().length > 0;
}

/**
 * @description One-time startup assertion and posture log for privileged execution
 * endpoints. Missing configuration throws before the server listener or worker starts.
 */
export function logBotNodeAuthPosture(): void {
  const delegationConfigured = hasDelegationVerificationConfiguration(process.env);
  if (!isServiceSecretConfigured() && !delegationConfigured) {
    const error = new Error('SWARM_SERVICE_SECRET or OSHAL_DELEGATION_PUBLIC_KEYS is required for bot-node execution');
    (error as Error & { code?: string }).code = 'SERVICE_AUTH_NOT_CONFIGURED';
    logger.error({ err: error }, 'Bot-node startup denied: service authentication is not configured');
    throw error;
  }
  if (delegationConfigured) {
    logger.info(
      'Bot-node /api/swarm-execute is FAIL-CLOSED with Ed25519 delegation; sibling privileged routes remain SWARM_SERVICE_SECRET-only',
    );
    return;
  }
  logger.info(
    'Bot-node execution endpoints are FAIL-CLOSED: SWARM_SERVICE_SECRET is configured — /api/swarm-execute and siblings require a matching X-Service-Secret header',
  );
}

/**
 * @description Strict shared-secret gate for `/api/swarm-execute`. Every request requires
 * a configured and valid X-Service-Secret, regardless of payload shape.
 * @param req - Express request (body already JSON-parsed by the bot-node server).
 * @param res - Express response; receives 401 on rejection.
 * @param next - Next handler; called only when the call is authorized (or warned-open).
 */
export const authorizeBotNodeExecutionCall: RequestHandler = (req, res, next) => {
  if (hasDelegationVerificationConfiguration(process.env)) {
    if (!hasBoundedDelegationHeader(req.headers[DELEGATION_HTTP_HEADER])) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    next();
    return;
  }
  requireServiceSecret(req, res, next);
};

/**
 * @description Shared-secret gate for the bot-node's OTHER privileged execution endpoints
 * (e.g. `/api/token-chase/replay-call`) that carry no per-user payload markers. Same
 * strict posture as {@link authorizeBotNodeExecutionCall}: missing configuration returns
 * 503 and missing/wrong request credentials return 401.
 * @param req - Express request.
 * @param res - Express response; receives 401 on rejection.
 * @param next - Next handler; called only when the call is authorized (or warned-open).
 */
export const authorizeBotNodeInternalCall: RequestHandler = (req, res, next) => {
  requireServiceSecret(req, res, next);
};

const PUBLIC_BOT_NODE_GET_PATHS = new Set(['/health', '/api/health', '/metrics']);

/**
 * @description Authenticate every privileged bot-node request before any body parser runs.
 * Exact GET health/metrics probes are intentionally public; alternate methods and all other
 * paths require the configured machine secret. This prevents unauthenticated large/invalid
 * JSON bodies from consuming parser memory or receiving parser-specific responses.
 * @param req - Express request whose body has not been parsed.
 * @param res - Express response used for strict 401/503 refusals.
 * @param next - Continues to the parser only for public probes or authenticated callers.
 */
export const authorizeBotNodeBeforeBody: RequestHandler = (req, res, next) => {
  if (req.method === 'GET' && PUBLIC_BOT_NODE_GET_PATHS.has(req.path)) {
    next();
    return;
  }
  if (
    req.method === SWARM_EXECUTE_DELEGATION_METHOD
    && req.path === SWARM_EXECUTE_DELEGATION_PATH
    && hasDelegationVerificationConfiguration(process.env)
  ) {
    authorizeBotNodeExecutionCall(req, res, next);
    return;
  }
  authorizeBotNodeInternalCall(req, res, next);
};

function hasBoundedDelegationHeader(value: string | string[] | undefined): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_DELEGATION_HEADER_BYTES
    && value.trim() === value;
}
