/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of API key authentication middleware
 */

'use strict';

const pino = require('pino');
const crypto = require('crypto');

const logger = pino({ name: 'auth-middleware' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTH_HEADER = 'authorization';
const BEARER_PREFIX = 'Bearer ';
const AUTH_DISABLED_MSG = 'Authentication disabled — AUTH_API_KEY not configured';

// ---------------------------------------------------------------------------
// Core Authentication
// ---------------------------------------------------------------------------

/**
 * @description Extracts the Bearer token from the Authorization header.
 * Returns null if the header is missing or does not use the Bearer scheme.
 *
 * @param {import('http').IncomingMessage} req - The incoming HTTP request
 * @returns {string|null} The extracted token or null
 */
function extractBearerToken(req) {
  const authHeader = req.headers[AUTH_HEADER];

  if (!authHeader || typeof authHeader !== 'string') {
    return null;
  }

  if (!authHeader.startsWith(BEARER_PREFIX)) {
    logger.debug('Authorization header present but not Bearer scheme');
    return null;
  }

  return authHeader.slice(BEARER_PREFIX.length).trim();
}

/**
 * @description Compares two strings in constant time to prevent timing attacks.
 * Uses Node.js crypto.timingSafeEqual for side-channel resistance.
 *
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} True if the strings are equal
 */
function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');

  if (bufA.length !== bufB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * @description Validates an incoming request against the configured API key.
 * Returns an object with `authenticated` boolean and optional `error` message.
 *
 * When `configuredKey` is null/undefined, authentication is disabled and all
 * requests are allowed through (backward compatible with existing deployments).
 *
 * @param {import('http').IncomingMessage} req - The incoming HTTP request
 * @param {string|null} configuredKey - The expected API key from environment
 * @returns {{ authenticated: boolean, error?: string }} Authentication result
 */
function validateRequest(req, configuredKey) {
  if (!configuredKey) {
    logger.debug(AUTH_DISABLED_MSG);
    return { authenticated: true };
  }

  const token = extractBearerToken(req);

  if (!token) {
    logger.warn(
      { method: req.method, url: req.url },
      'Authentication failed — missing or invalid Authorization header'
    );
    return {
      authenticated: false,
      error: 'Missing or invalid Authorization header. Use: Authorization: Bearer <api-key>',
    };
  }

  if (!timingSafeCompare(token, configuredKey)) {
    logger.warn(
      { method: req.method, url: req.url },
      'Authentication failed — invalid API key'
    );
    return {
      authenticated: false,
      error: 'Invalid API key',
    };
  }

  logger.debug(
    { method: req.method, url: req.url },
    'Authentication successful'
  );
  return { authenticated: true };
}

/**
 * @description Sends a 401 Unauthorized JSON response with CORS headers.
 *
 * @param {import('http').ServerResponse} res - The HTTP response object
 * @param {string} errorMessage - The error message to include in the response
 * @returns {void}
 */
function sendUnauthorized(res, errorMessage) {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'WWW-Authenticate': 'Bearer realm="api"',
  });
  res.end(JSON.stringify({ success: false, error: errorMessage }, null, 2));
}

/**
 * @description Creates an authentication guard function bound to the given
 * API key. The returned function checks if a request is authenticated and
 * sends a 401 response if not. Returns true if the request should proceed,
 * false if it was rejected (response already sent).
 *
 * @param {string|null} apiKey - The configured API key (null = auth disabled)
 * @returns {function(import('http').IncomingMessage, import('http').ServerResponse): boolean}
 *   Guard function: returns true if request is authorized, false if rejected
 */
function createAuthGuard(apiKey) {
  if (!apiKey) {
    logger.info(AUTH_DISABLED_MSG);
  } else {
    logger.info('Authentication enabled — API key required for /api/* routes');
  }

  return function authGuard(req, res) {
    const result = validateRequest(req, apiKey);

    if (!result.authenticated) {
      sendUnauthorized(res, result.error);
      return false;
    }

    return true;
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createAuthGuard,
  validateRequest,
  extractBearerToken,
  timingSafeCompare,
  sendUnauthorized,
};