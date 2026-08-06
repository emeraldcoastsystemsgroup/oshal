/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Security-audit: shared-secret gate for the any-bot runtime's /api/swarm-execute — sensitive execution payloads (userSub/creds/byoLlmConnection/providerIntent) fail closed; anonymous legacy calls stay compatible until SWARM_SERVICE_SECRET is configured.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Backfilled the missing change-log header. Loud fail-open posture (security audit 2026-06-16 backlog item): an anonymous allow while SWARM_SERVICE_SECRET is unset now logs a per-request WARN naming the backlog item — same posture as the TS bot-node gate (src/app/bot-node-request-auth.ts) so neither runtime is silently open.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Treat every supplied userSub property as scoped execution data so malformed, empty, whitespace, and non-string assertions cannot use the anonymous fail-open posture.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: fail startup and every protected request closed when the service secret is absent; apply one blanket any-bot API/static gate with only the health probe deliberately public.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Bind object-scoped routes to an exact authenticated service subject, preferring canonical base64url transport over the constrained legacy plain header.
 */

'use strict';

const crypto = require('crypto');
const { optionalExactUserSubject } = require('./exact-user-subject');
const PUBLIC_PATHS = new Set(['/api/health']);
const MAX_TRUSTED_SUB_BYTES = 512;
const MAX_TRUSTED_SUB_ENCODED_CHARS = Math.ceil(MAX_TRUSTED_SUB_BYTES * 4 / 3);

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
 * @description Shared-secret gate for /api/swarm-execute on the any-bot runtime. Every
 * execution requires a configured and valid X-Service-Secret. Missing server configuration
 * returns 503; a missing or invalid request credential returns 401.
 * @param {import('express').Request} req - Incoming request.
 * @param {import('express').Response} res - Response; receives 401 on rejection.
 * @param {import('express').NextFunction} next - Called only when authorized.
 * @returns {void|import('express').Response} Error response or falls through to next().
 */
function authorizeSwarmExecute(req, res, next) {
  return authorizeConfiguredServiceRequest(req, res, next);
}

/**
 * @description Blanket any-bot boundary. Health remains public for orchestrator probes;
 * every API, dashboard, workspace, and static request requires the service secret.
 */
function authorizeAnyBotRequest(req, res, next) {
  if ((req.method === 'GET' || req.method === 'HEAD') && PUBLIC_PATHS.has(req.path)) {
    return next();
  }
  return authorizeConfiguredServiceRequest(req, res, next);
}

/**
 * @description Enforces a configured, constant-time-matched X-Service-Secret. A missing
 * server configuration is an availability/configuration error, never an authentication
 * bypass. The only exception is an explicit test-only flag used by isolated route tests.
 */
function authorizeConfiguredServiceRequest(req, res, next) {
  if (!hasConfiguredServiceSecret()) {
    if (insecureTestAuthEnabled()) return next();
    return res.status(503).json({ error: 'service_auth_not_configured' });
  }
  if (!validServiceSecret(req)) return res.status(401).json({ error: 'unauthorized' });
  return next();
}

/** Fail startup before a network listener can expose a warn-open runtime. */
function assertServiceSecretConfigured() {
  if (hasConfiguredServiceSecret() || insecureTestAuthEnabled()) return;
  const error = new Error('SWARM_SERVICE_SECRET is required for the any-bot runtime');
  error.code = 'SERVICE_AUTH_NOT_CONFIGURED';
  throw error;
}

function hasConfiguredServiceSecret() {
  return String(process.env.SWARM_SERVICE_SECRET || '').trim().length > 0;
}

function insecureTestAuthEnabled() {
  return process.env.NODE_ENV === 'test'
    && process.env.OSHAL_ALLOW_INSECURE_ANY_BOT_TEST_AUTH === 'true';
}

/**
 * @description Read an exact user subject only from an authenticated internal-service
 * header. Canonical base64url preserves subjects that HTTP optional-whitespace handling
 * would otherwise alter; the legacy plain header is accepted only when already canonical.
 */
function trustedServiceUserSub(req) {
  if (!validServiceSecret(req)) return null;
  const encoded = req.headers?.['x-oshal-user-sub-b64'];
  if (encoded !== undefined) {
    if (typeof encoded !== 'string' || encoded.length === 0
      || encoded.length > MAX_TRUSTED_SUB_ENCODED_CHARS
      || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    try {
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.length === 0 || bytes.length > MAX_TRUSTED_SUB_BYTES
        || bytes.toString('base64url') !== encoded) return null;
      const subject = bytes.toString('utf8');
      if (!Buffer.from(subject, 'utf8').equals(bytes)) return null;
      return optionalExactUserSubject(subject, 'trusted service userSub') ?? null;
    } catch {
      return null;
    }
  }

  const legacy = req.headers?.['x-oshal-user-sub'];
  if (typeof legacy !== 'string' || legacy.length === 0 || legacy !== legacy.trim()) return null;
  try {
    return optionalExactUserSubject(legacy, 'trusted service userSub') ?? null;
  } catch {
    return null;
  }
}

module.exports = {
  assertServiceSecretConfigured,
  authorizeAnyBotRequest,
  authorizeConfiguredServiceRequest,
  authorizeSwarmExecute,
  carriesSensitiveExecutionData,
  hasConfiguredServiceSecret,
  insecureTestAuthEnabled,
  trustedServiceUserSub,
  validServiceSecret,
};
