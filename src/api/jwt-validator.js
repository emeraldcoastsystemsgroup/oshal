/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of JWT validation middleware
 */

'use strict';

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const pino = require('pino');

const logger = pino({ name: 'jwt-validator' });

/**
 * @description In-memory cache for JWKS (JSON Web Key Sets) fetched from
 * the Keycloak OIDC discovery endpoint. Keys are cached to avoid fetching
 * on every request. Cache is refreshed when a key ID is not found.
 */
const jwksCache = {
  keys: {},
  lastFetch: 0,
  ttlMs: 300000, // 5 minutes
};

/**
 * @description Fetches JSON from an HTTP/HTTPS URL. Returns parsed JSON.
 *
 * @param {string} url - The URL to fetch
 * @returns {Promise<object>} Parsed JSON response
 * @throws {Error} If the request fails or returns non-200
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const startTime = Date.now();

    logger.debug({ url }, 'Fetching JSON');

    client.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const durationMs = Date.now() - startTime;
        if (res.statusCode !== 200) {
          logger.error({ url, statusCode: res.statusCode, durationMs }, 'HTTP fetch failed');
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          logger.debug({ url, durationMs }, 'JSON fetched successfully');
          resolve(parsed);
        } catch (error) {
          logger.error({ err: error, url }, 'Failed to parse JSON response');
          reject(error);
        }
      });
      res.on('error', (error) => {
        logger.error({ err: error, url }, 'HTTP response error');
        reject(error);
      });
    }).on('error', (error) => {
      logger.error({ err: error, url }, 'HTTP request error');
      reject(error);
    });
  });
}

/**
 * @description Decodes a base64url-encoded string to a Buffer.
 *
 * @param {string} str - Base64url-encoded string
 * @returns {Buffer} Decoded buffer
 */
function base64urlDecode(str) {
  const padded = str + '='.repeat((4 - str.length % 4) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * @description Decodes a JWT without verifying the signature. Extracts
 * the header and payload for inspection.
 *
 * @param {string} token - The JWT string
 * @returns {{ header: object, payload: object, signature: string }} Decoded parts
 * @throws {Error} If the token format is invalid
 */
function decodeJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format: expected 3 parts');
  }

  const header = JSON.parse(base64urlDecode(parts[0]).toString('utf-8'));
  const payload = JSON.parse(base64urlDecode(parts[1]).toString('utf-8'));

  return { header, payload, signature: parts[2] };
}

/**
 * @description Converts a JWK RSA public key to PEM format for use with
 * Node.js crypto verification.
 *
 * @param {object} jwk - The JWK object with n and e properties
 * @returns {string} PEM-formatted public key
 */
function jwkToPem(jwk) {
  const key = crypto.createPublicKey({
    key: jwk,
    format: 'jwk',
  });
  return key.export({ type: 'spki', format: 'pem' });
}

/**
 * @description Fetches JWKS from the Keycloak endpoint and caches the keys.
 * Uses cache if within TTL. Force-refreshes if a specific kid is not found.
 *
 * @param {string} jwksUri - The JWKS endpoint URL
 * @param {string} [kid] - Optional key ID to look for
 * @returns {Promise<object>} Map of kid → PEM public key
 */
async function getJwks(jwksUri, kid) {
  const now = Date.now();
  const cacheValid = (now - jwksCache.lastFetch) < jwksCache.ttlMs;

  if (cacheValid && (!kid || jwksCache.keys[kid])) {
    logger.debug({ cached: true, kid }, 'Using cached JWKS');
    return jwksCache.keys;
  }

  logger.info({ jwksUri, reason: cacheValid ? 'kid-not-found' : 'cache-expired' }, 'Fetching JWKS');

  const jwks = await fetchJson(jwksUri);

  jwksCache.keys = {};
  for (const key of jwks.keys) {
    if (key.kty === 'RSA' && key.use === 'sig') {
      jwksCache.keys[key.kid] = jwkToPem(key);
    }
  }
  jwksCache.lastFetch = now;

  logger.info({ keyCount: Object.keys(jwksCache.keys).length }, 'JWKS cached');
  return jwksCache.keys;
}

/**
 * @description Verifies a JWT's RS256 signature against the public key.
 *
 * @param {string} token - The full JWT string
 * @param {string} publicKeyPem - PEM-formatted RSA public key
 * @returns {boolean} True if signature is valid
 */
function verifySignature(token, publicKeyPem) {
  const parts = token.split('.');
  const signedContent = `${parts[0]}.${parts[1]}`;
  const signature = base64urlDecode(parts[2]);

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(signedContent);
  return verifier.verify(publicKeyPem, signature);
}

/**
 * @description Validates JWT claims: issuer, audience, expiration, not-before.
 *
 * @param {object} payload - The decoded JWT payload
 * @param {object} options - Validation options
 * @param {string} options.issuer - Expected issuer
 * @param {string} options.clientId - Expected audience (client_id)
 * @returns {{ valid: boolean, error?: string }} Validation result
 */
function validateClaims(payload, options) {
  const now = Math.floor(Date.now() / 1000);

  if (payload.iss !== options.issuer) {
    return { valid: false, error: `Invalid issuer: ${payload.iss}` };
  }

  // Audience can be a string or array
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(options.clientId) && !aud.includes('account')) {
    return { valid: false, error: `Invalid audience: ${payload.aud}` };
  }

  if (payload.exp && payload.exp < now) {
    return { valid: false, error: 'Token expired' };
  }

  if (payload.nbf && payload.nbf > now) {
    return { valid: false, error: 'Token not yet valid' };
  }

  return { valid: true };
}

/**
 * @description Creates a JWT validation function configured for a specific
 * Keycloak realm. Returns a function that validates Bearer tokens from
 * the Authorization header.
 *
 * @param {object} config - Keycloak configuration
 * @param {string} config.keycloakUrl - Keycloak base URL (e.g., http://localhost:8080)
 * @param {string} config.realm - Keycloak realm name
 * @param {string} config.clientId - OIDC client ID
 * @returns {Function} Async function (req) => { valid, user, error }
 */
function createJwtValidator(config) {
  const { keycloakUrl, realm, clientId } = config;
  const issuer = `${keycloakUrl}/realms/${realm}`;
  const jwksUri = `${issuer}/protocol/openid-connect/certs`;

  logger.info({ issuer, jwksUri, clientId }, 'JWT validator configured');

  /**
   * @description Validates a JWT from the request Authorization header.
   *
   * @param {http.IncomingMessage} req - The HTTP request
   * @returns {Promise<{ valid: boolean, user?: object, error?: string }>}
   */
  return async function validateToken(req) {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { valid: false, error: 'Missing or invalid Authorization header' };
    }

    const token = authHeader.slice(7);

    try {
      const { header, payload } = decodeJwt(token);

      if (header.alg !== 'RS256') {
        return { valid: false, error: `Unsupported algorithm: ${header.alg}` };
      }

      // Get public key for this kid
      const keys = await getJwks(jwksUri, header.kid);
      const publicKey = keys[header.kid];

      if (!publicKey) {
        logger.warn({ kid: header.kid }, 'Key ID not found in JWKS');
        return { valid: false, error: 'Unknown signing key' };
      }

      // Verify signature
      if (!verifySignature(token, publicKey)) {
        logger.warn('JWT signature verification failed');
        return { valid: false, error: 'Invalid signature' };
      }

      // Validate claims
      const claimsResult = validateClaims(payload, { issuer, clientId });
      if (!claimsResult.valid) {
        logger.warn({ error: claimsResult.error }, 'JWT claims validation failed');
        return claimsResult;
      }

      // Extract user info
      const user = {
        sub: payload.sub,
        email: payload.email,
        name: payload.name || payload.preferred_username,
        username: payload.preferred_username,
        roles: payload.realm_roles || payload.realm_access?.roles || [],
        emailVerified: payload.email_verified,
      };

      logger.info({ sub: user.sub, username: user.username }, 'JWT validated');
      return { valid: true, user };
    } catch (error) {
      logger.error({ err: error }, 'JWT validation error');
      return { valid: false, error: error.message };
    }
  };
}

/**
 * @description Clears the JWKS cache. Useful for testing or key rotation.
 *
 * @returns {void}
 */
function clearJwksCache() {
  jwksCache.keys = {};
  jwksCache.lastFetch = 0;
  logger.info('JWKS cache cleared');
}

module.exports = {
  createJwtValidator,
  clearJwksCache,
  decodeJwt,
  base64urlDecode,
};