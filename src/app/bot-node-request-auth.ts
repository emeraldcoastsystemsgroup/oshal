/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Security-audit: authorizeBotNodeExecutionCall fails CLOSED for identity/credential-bearing payloads (userSub/creds/byoLlmConnection/providerIntent) even when SWARM_SERVICE_SECRET is unset; anonymous legacy calls stay compatible via requireServiceSecretWhenConfigured.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Backfilled the missing change-log header. Loud fail-open posture (security audit 2026-06-16 backlog item): when SWARM_SERVICE_SECRET is unset the gate still allows local-dev traffic, but now logs a per-request WARN naming the backlog item; logBotNodeAuthPosture() gives the matching one-time startup WARN. Added authorizeBotNodeInternalCall so sibling execution endpoints (/api/token-chase/replay-call) share the same warned gate instead of the silent shared middleware.
 */

import type { Request, RequestHandler } from 'express';
import { hasValidServiceSecret, requireServiceSecretWhenConfigured } from '@/shared/middleware/authz';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'bot-node-request-auth' });

/** Backlog reference logged on every fail-open allow so operators can find the remediation. */
const BACKLOG_ITEM =
  'docs/BACKLOG.md § "Bot-node /api/swarm-execute is unauthenticated + host-published (security audit 2026-06-16)"';

function carriesScopedExecutionData(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  const hasUserSub = typeof record.userSub === 'string' && record.userSub.trim().length > 0;
  const creds = record.creds;
  const hasCreds = Boolean(creds && typeof creds === 'object' && Object.keys(creds).length > 0);
  const byo = record.byoLlmConnection;
  const hasByo = Boolean(byo && typeof byo === 'object' && Object.keys(byo).length > 0);
  const hasProviderIntent = Object.prototype.hasOwnProperty.call(record, 'providerIntent');
  return hasUserSub || hasCreds || hasByo || hasProviderIntent;
}

/**
 * @description Whether the shared bot-node service secret is configured. When true, every
 * privileged bot-node execution endpoint fails CLOSED (401 without a matching
 * X-Service-Secret). When false the endpoints stay open for stock local-dev boots, but
 * loudly (see {@link logBotNodeAuthPosture} and the per-request WARN in the gates) —
 * the secure posture is one env var away.
 * @returns True when SWARM_SERVICE_SECRET is set to a non-blank value.
 */
export function isServiceSecretConfigured(): boolean {
  return (process.env.SWARM_SERVICE_SECRET || '').trim().length > 0;
}

/**
 * @description One-time startup posture log for the bot-node's privileged execution
 * endpoints. Configured secret → INFO (fail-closed, X-Service-Secret enforced).
 * Unconfigured → loud WARN naming the security-audit backlog item, so a local-dev boot
 * keeps working but the open posture is impossible to miss in the logs. Call once from
 * bot-node-server start().
 */
export function logBotNodeAuthPosture(): void {
  if (isServiceSecretConfigured()) {
    logger.info(
      'Bot-node execution endpoints are FAIL-CLOSED: SWARM_SERVICE_SECRET is configured — /api/swarm-execute and siblings require a matching X-Service-Secret header',
    );
    return;
  }
  logger.warn(
    { backlogItem: BACKLOG_ITEM },
    'SECURITY: SWARM_SERVICE_SECRET is NOT set — bot-node execution endpoints (/api/swarm-execute, /api/token-chase/replay-call) accept UNAUTHENTICATED calls (local-dev fail-open). Set SWARM_SERVICE_SECRET in .env (same value on controller + every bot) to fail closed.',
  );
}

/**
 * @description Per-request WARN emitted when a privileged call is allowed only because no
 * service secret is configured (fail-open). Kept separate so both execution gates share
 * one message shape and the backlog reference.
 * @param req - The request being allowed without authentication.
 */
function warnFailOpenAllow(req: Request): void {
  logger.warn(
    { method: req.method, path: req.path, backlogItem: BACKLOG_ITEM },
    'Allowing UNAUTHENTICATED bot-node execution call — SWARM_SERVICE_SECRET is unset (local-dev fail-open). Configure the secret to enforce X-Service-Secret.',
  );
}

/**
 * @description Shared-secret gate for `/api/swarm-execute`. Identity/credential-bearing
 * work (userSub, brokered creds, BYO-LLM connection, trusted provider intent) ALWAYS
 * requires a configured and valid X-Service-Secret — fail-closed regardless of env.
 * Anonymous legacy execution stays available when no secret is configured, but each such
 * allow logs a WARN naming the security-audit backlog item; once SWARM_SERVICE_SECRET is
 * set, everything without the matching header is 401.
 * @param req - Express request (body already JSON-parsed by the bot-node server).
 * @param res - Express response; receives 401 on rejection.
 * @param next - Next handler; called only when the call is authorized (or warned-open).
 */
export const authorizeBotNodeExecutionCall: RequestHandler = (req, res, next) => {
  if (carriesScopedExecutionData(req.body) && !hasValidServiceSecret(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (!isServiceSecretConfigured()) {
    warnFailOpenAllow(req);
    next();
    return;
  }
  requireServiceSecretWhenConfigured(req, res, next);
};

/**
 * @description Shared-secret gate for the bot-node's OTHER privileged execution endpoints
 * (e.g. `/api/token-chase/replay-call`) that carry no per-user payload markers. Same
 * posture as {@link authorizeBotNodeExecutionCall} minus the sensitive-payload check:
 * fail-closed 401 when SWARM_SERVICE_SECRET is configured and the header is missing or
 * wrong; warned fail-open when unconfigured so a stock local boot keeps working.
 * @param req - Express request.
 * @param res - Express response; receives 401 on rejection.
 * @param next - Next handler; called only when the call is authorized (or warned-open).
 */
export const authorizeBotNodeInternalCall: RequestHandler = (req, res, next) => {
  if (!isServiceSecretConfigured()) {
    warnFailOpenAllow(req);
    next();
    return;
  }
  requireServiceSecretWhenConfigured(req, res, next);
};
