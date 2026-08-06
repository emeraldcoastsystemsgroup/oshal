/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Security-audit: shared-secret gate for the any-bot runtime's /api/swarm-execute — sensitive execution payloads (userSub/creds/byoLlmConnection/providerIntent) fail closed; anonymous legacy calls stay compatible until SWARM_SERVICE_SECRET is configured.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Backfilled the missing change-log header. Loud fail-open posture (security audit 2026-06-16 backlog item): an anonymous allow while SWARM_SERVICE_SECRET is unset now logs a per-request WARN naming the backlog item — same posture as the TS bot-node gate (src/app/bot-node-request-auth.ts) so neither runtime is silently open.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Treat every supplied userSub property as scoped execution data so malformed, empty, whitespace, and non-string assertions cannot use the anonymous fail-open posture.
 */

'use strict';

const crypto = require('crypto');
const logger = require('../../utils/logger');

const BACKLOG_ITEM =
  'docs/BACKLOG.md § "Bot-node /api/swarm-execute is unauthenticated + host-published (security audit 2026-06-16)"';

/**
 * @description Constant-time check that the request carries the configured shared service
 * secret. Always false when SWARM_SERVICE_SECRET is unset — the header cannot grant
 * anything that the env has not provisioned.
 * @param {import('express').Request} req - Incoming request.
 * @returns {boolean} True only when the secret is configured AND the header matches.
 */
function validServiceSecret(req) {
  const expected = String(process.env.SWARM_SERVICE_SECRET || '').trim();
  if (!expected) return false;
  const provided = String(req.get?.('x-service-secret') || req.headers?.['x-service-secret'] || '');
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * @description Whether the body carries identity/credential-bearing execution data that
 * must NEVER run unauthenticated (per-user sub scoping, brokered connector tokens, a
 * BYO-LLM key, or a trusted provider intent). These mark the payload as per-user work.
 * @param {unknown} body - Parsed JSON request body.
 * @returns {boolean} True when the payload is sensitive and must fail closed.
 */
function carriesSensitiveExecutionData(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const hasUserSub = Object.prototype.hasOwnProperty.call(body, 'userSub');
  const hasCreds = body.creds && typeof body.creds === 'object' && Object.keys(body.creds).length > 0;
  const hasByo = body.byoLlmConnection && typeof body.byoLlmConnection === 'object'
    && Object.keys(body.byoLlmConnection).length > 0;
  const hasProviderIntent = Object.prototype.hasOwnProperty.call(body, 'providerIntent');
  return Boolean(hasUserSub || hasCreds || hasByo || hasProviderIntent);
}

/**
 * @description Shared-secret gate for /api/swarm-execute on the any-bot runtime. Sensitive
 * bot execution fails closed (401 without a valid X-Service-Secret, whether or not the env
 * secret is set); anonymous legacy calls remain compatible while SWARM_SERVICE_SECRET is
 * unset, but each such allow logs a WARN naming the security-audit backlog item so the
 * open posture is visible — the secure posture is one env var away.
 * @param {import('express').Request} req - Incoming request.
 * @param {import('express').Response} res - Response; receives 401 on rejection.
 * @param {import('express').NextFunction} next - Called only when authorized (or warned-open).
 * @returns {void|import('express').Response} 401 response or falls through to next().
 */
function authorizeSwarmExecute(req, res, next) {
  const configured = Boolean(String(process.env.SWARM_SERVICE_SECRET || '').trim());
  const valid = validServiceSecret(req);
  if ((carriesSensitiveExecutionData(req.body) || configured) && !valid) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!configured) {
    logger.warn(
      `SECURITY: allowing UNAUTHENTICATED ${req.method || 'POST'} ${req.path || '/api/swarm-execute'} — `
      + `SWARM_SERVICE_SECRET is unset (local-dev fail-open). Set it in .env to fail closed. See ${BACKLOG_ITEM}`,
    );
  }
  return next();
}

module.exports = { authorizeSwarmExecute, carriesSensitiveExecutionData, validServiceSecret };
