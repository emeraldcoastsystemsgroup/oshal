/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Facebook Credential Store
 *
 * Manages Facebook OAuth credentials using the existing EncryptedConfigManager.
 * Credentials persist across restarts in secrets.enc.json (or secrets.json in
 * plain mode). The bot loads credentials on startup and hot-reloads when a
 * Redis pubsub message arrives on the facebook.credentials.update channel.
 *
 * @module facebookCredentialStore
 * @agent facebook-bot
 */

'use strict';

const path = require('path');
const pino = require('pino');

const logger = pino({ name: 'facebook-credential-store' });

// Keys stored in encrypted config — all contain "token"/"secret" patterns
// so isSecretKey() in config-routes.ts routes them to encrypted storage.
/**
 * @description Canonical secret-store key names for every Facebook credential
 * field. Centralized here so write (saveCredentials), delete (clearCredentials),
 * and read (extractFacebookCredentials) all reference the same identifiers, and
 * so the names deliberately embed "token"/"secret" patterns that cause
 * isSecretKey() to route them into encrypted storage. Exported so callers can
 * key into the secrets envelope without hardcoding strings.
 */
const CREDENTIAL_KEYS = {
  PAGE_ACCESS_TOKEN: 'facebookPageAccessToken',
  PAGE_ID: 'facebookPageId',
  PAGE_NAME: 'facebookPageName',
  USER_ID: 'facebookUserId',
  USER_ACCESS_TOKEN: 'facebookUserAccessToken',
  TOKEN_EXPIRES_AT: 'facebookTokenExpiresAt',
  CONNECTED_AT: 'facebookConnectedAt',
};

// In-memory cache for fast reads
let cachedCredentials = null;
let configManager = null;

/**
 * Initialize the credential store with the encrypted config manager.
 * Called once on bot startup.
 *
 * @param {object} encryptedConfigManager - Instance of EncryptedConfigManager
 */
function init(encryptedConfigManager) {
  configManager = encryptedConfigManager;
  cachedCredentials = null;
  logger.info('Facebook credential store initialized');
}

/**
 * Lazily resolve the config manager if init() hasn't been called.
 * Falls back to creating one from the standard output directory.
 */
function getConfigManager() {
  if (configManager) return configManager;

  try {
    const EncryptedConfigManager = require('../../../../src/api/encrypted-config-manager');
    const outputDir = process.env.OUTPUT_DIR || path.join(process.cwd(), 'output');
    const encryptionKey = process.env.ENCRYPTION_KEY || null;
    configManager = new EncryptedConfigManager(outputDir, encryptionKey);
    logger.info({ outputDir, encrypted: !!encryptionKey }, 'Auto-initialized config manager');
    return configManager;
  } catch (err) {
    logger.warn({ err: err.message }, 'Could not auto-initialize config manager, using env var fallback');
    return null;
  }
}

/**
 * Load Facebook credentials from encrypted storage.
 * Returns null if not connected.
 *
 * @returns {object|null} Credential envelope or null
 */
function loadCredentials() {
  // Try encrypted config manager first
  const mgr = getConfigManager();
  if (mgr) {
    try {
      const secrets = mgr.loadSecrets();
      const creds = extractFacebookCredentials(secrets);
      if (creds && creds.facebookPageAccessToken) {
        cachedCredentials = creds;
        logger.debug({ pageId: creds.facebookPageId, pageName: creds.facebookPageName }, 'Loaded Facebook credentials from encrypted config');
        return creds;
      }
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to load credentials from encrypted config');
    }
  }

  // Fallback: environment variables (legacy path)
  const envToken = process.env.FACEBOOK_ACCESS_TOKEN;
  const envPageId = process.env.FACEBOOK_PAGE_ID;
  if (envToken && envPageId) {
    const creds = {
      facebookPageAccessToken: envToken,
      facebookPageId: envPageId,
      facebookPageName: process.env.FACEBOOK_PAGE_NAME || 'Unknown (env var)',
      facebookUserId: null,
      facebookUserAccessToken: null,
      facebookTokenExpiresAt: null,
      facebookConnectedAt: null,
    };
    cachedCredentials = creds;
    logger.info({ pageId: envPageId }, 'Using Facebook credentials from environment variables');
    return creds;
  }

  cachedCredentials = null;
  return null;
}

/**
 * Save Facebook credentials to encrypted storage.
 *
 * @param {object} credentials - The credential envelope to persist
 * @param {string} credentials.facebookPageAccessToken - Page access token
 * @param {string} credentials.facebookPageId - Page ID
 * @param {string} credentials.facebookPageName - Page display name
 * @param {string} [credentials.facebookUserId] - Facebook user ID
 * @param {string} [credentials.facebookUserAccessToken] - Long-lived user token (for refresh)
 * @param {number} [credentials.facebookTokenExpiresAt] - User token expiry timestamp
 */
function saveCredentials(credentials) {
  const mgr = getConfigManager();
  if (!mgr) {
    throw new Error('Config manager not initialized — cannot persist Facebook credentials');
  }

  // Load existing secrets, merge Facebook creds, save back
  const secrets = mgr.loadSecrets();
  Object.assign(secrets, {
    [CREDENTIAL_KEYS.PAGE_ACCESS_TOKEN]: credentials.facebookPageAccessToken,
    [CREDENTIAL_KEYS.PAGE_ID]: credentials.facebookPageId,
    [CREDENTIAL_KEYS.PAGE_NAME]: credentials.facebookPageName || '',
    [CREDENTIAL_KEYS.USER_ID]: credentials.facebookUserId || '',
    [CREDENTIAL_KEYS.USER_ACCESS_TOKEN]: credentials.facebookUserAccessToken || '',
    [CREDENTIAL_KEYS.TOKEN_EXPIRES_AT]: credentials.facebookTokenExpiresAt || null,
    [CREDENTIAL_KEYS.CONNECTED_AT]: credentials.facebookConnectedAt || Date.now(),
  });

  mgr.saveSecrets(secrets);
  cachedCredentials = credentials;
  logger.info({ pageId: credentials.facebookPageId, pageName: credentials.facebookPageName }, 'Facebook credentials saved to encrypted config');
}

/**
 * Remove Facebook credentials from encrypted storage.
 */
function clearCredentials() {
  const mgr = getConfigManager();
  if (mgr) {
    const secrets = mgr.loadSecrets();
    for (const key of Object.values(CREDENTIAL_KEYS)) {
      delete secrets[key];
    }
    mgr.saveSecrets(secrets);
  }
  cachedCredentials = null;
  logger.info('Facebook credentials cleared');
}

/**
 * Get cached credentials (fast path, no disk read).
 * Call loadCredentials() first to prime the cache.
 *
 * @returns {object|null}
 */
function getCachedCredentials() {
  return cachedCredentials;
}

/**
 * Hot-reload credentials into the cache (called from Redis pubsub handler).
 *
 * @param {object} credentials - New credential envelope
 */
function hotReload(credentials) {
  if (credentials === null) {
    cachedCredentials = null;
    logger.info('Facebook credentials hot-reloaded: disconnected');
  } else {
    cachedCredentials = credentials;
    logger.info({ pageId: credentials.facebookPageId }, 'Facebook credentials hot-reloaded');
  }
}

/**
 * Check if the stored token is nearing expiry.
 * Returns true if the user token expires within 10 days.
 *
 * @returns {boolean}
 */
function needsRefresh() {
  const creds = cachedCredentials || loadCredentials();
  if (!creds || !creds.facebookTokenExpiresAt) return false;
  const tenDays = 10 * 24 * 60 * 60 * 1000;
  return (creds.facebookTokenExpiresAt - Date.now()) < tenDays;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractFacebookCredentials(secrets) {
  if (!secrets) return null;
  const token = secrets[CREDENTIAL_KEYS.PAGE_ACCESS_TOKEN];
  if (!token) return null;

  return {
    facebookPageAccessToken: token,
    facebookPageId: secrets[CREDENTIAL_KEYS.PAGE_ID] || '',
    facebookPageName: secrets[CREDENTIAL_KEYS.PAGE_NAME] || '',
    facebookUserId: secrets[CREDENTIAL_KEYS.USER_ID] || '',
    facebookUserAccessToken: secrets[CREDENTIAL_KEYS.USER_ACCESS_TOKEN] || '',
    facebookTokenExpiresAt: secrets[CREDENTIAL_KEYS.TOKEN_EXPIRES_AT] || null,
    facebookConnectedAt: secrets[CREDENTIAL_KEYS.CONNECTED_AT] || null,
  };
}

module.exports = {
  init,
  loadCredentials,
  saveCredentials,
  clearCredentials,
  getCachedCredentials,
  hotReload,
  needsRefresh,
  CREDENTIAL_KEYS,
};
