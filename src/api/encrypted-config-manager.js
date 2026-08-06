/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of encrypted configuration manager
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added per-user config envelope support (userId partitioning)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Session 109: Demoted routine I/O logs from info to debug. Constructor, read/write/load/save operations no longer flood bot logs. Migration, rotation, and delete remain at info.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: remove plaintext secret mode, require encryption for every secret read/write/delete, write envelopes with owner-only permissions, and require one-way removal of legacy plaintext during explicit migration.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { encrypt, decrypt } = require('./crypto-utils');

const logger = pino({ name: 'encrypted-config-manager' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENCRYPTED_SECRETS_FILE = 'secrets.enc.json';
const PLAIN_SECRETS_FILE = 'secrets.json';

// ---------------------------------------------------------------------------
// File I/O Helpers
// ---------------------------------------------------------------------------

/**
 * @description Reads a JSON file from disk and parses it. Logs the operation
 * and throws with context if the file cannot be read or parsed.
 *
 * @param {string} filePath - Absolute path to the JSON file
 * @returns {object} Parsed JSON content
 * @throws {Error} If the file does not exist or contains invalid JSON
 */
function readJsonFile(filePath) {
  logger.debug({ path: filePath }, 'Reading JSON file');

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    logger.debug({ path: filePath }, 'JSON file read successfully');
    return parsed;
  } catch (error) {
    logger.error({ err: error, path: filePath }, 'Failed to read JSON file');
    throw error;
  }
}

/**
 * @description Writes a JavaScript object to disk as formatted JSON. Creates
 * parent directories if they do not exist. Logs success or failure.
 *
 * @param {string} filePath - Absolute path to write the JSON file
 * @param {object} data - The data to serialize and write
 * @returns {void}
 * @throws {Error} If the file cannot be written
 */
function writeJsonFile(filePath, data) {
  logger.debug({ path: filePath }, 'Writing JSON file');

  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.debug({ dir }, 'Created output directory');
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    // mode is applied only on creation, so also tighten files created by older releases.
    fs.chmodSync(filePath, 0o600);
    logger.debug({ path: filePath }, 'JSON file written successfully');
  } catch (error) {
    logger.error({ err: error, path: filePath }, 'Failed to write JSON file');
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Encrypted Config Manager
// ---------------------------------------------------------------------------

/**
 * @description Manages encrypted persistence of API configuration secrets.
 * When an encryption key is provided, secrets are stored as AES-256-GCM
 * encrypted envelopes in `secrets.enc.json`. Without a key every secret
 * operation fails closed; legacy `secrets.json` files can only be consumed by
 * the explicit one-way migration method.
 *
 * @param {string} outputDir - Directory where config files are stored
 * @param {string|null} encryptionKey - Master encryption key from the controller environment
 */
class EncryptedConfigManager {
  constructor(outputDir, encryptionKey = null) {
    this.outputDir = outputDir;
    this.encryptionKey = typeof encryptionKey === 'string' && encryptionKey.trim().length > 0
      ? encryptionKey
      : null;

    logger.debug({
      outputDir,
      encrypted: !!encryptionKey,
    }, 'EncryptedConfigManager initialized');
  }

  /**
   * @description Returns the encrypted secrets-envelope path. Plaintext is
   * never selected as a live store, even when the encryption key is absent.
   *
   * @returns {string} Absolute path to the secrets file
   */
  getSecretsPath() {
    return path.join(this.outputDir, ENCRYPTED_SECRETS_FILE);
  }

  /**
   * @description Returns the full file path for the plain secrets file,
   * regardless of encryption configuration. Used during migration.
   *
   * @returns {string} Absolute path to the plain secrets file
   */
  getPlainSecretsPath() {
    return path.join(this.outputDir, PLAIN_SECRETS_FILE);
  }

  /**
   * @description Returns the full file path for the encrypted secrets file,
   * regardless of encryption configuration. Used during migration.
   *
   * @returns {string} Absolute path to the encrypted secrets file
   */
  getEncryptedSecretsPath() {
    return path.join(this.outputDir, ENCRYPTED_SECRETS_FILE);
  }

  /**
   * @description Saves secrets to disk. When a userId is provided, secrets are
   * stored inside a per-user envelope keyed by userId. When encryption is
   * enabled, the entire envelope is encrypted with AES-256-GCM before writing.
   * Missing encryption configuration fails before any filesystem mutation.
   *
   * @param {object} secretsData - The secrets object to persist
   * @param {string|null} userId - The user identifier (JWT sub claim) for per-user storage, or null for global
   * @returns {void}
   * @throws {Error} If encryption or file write fails
   */
  saveSecrets(secretsData, userId = null) {
    this._requireEncryptionKey('save secrets');
    this._rejectLegacyPlaintextStore();
    const filePath = this.getSecretsPath();

    let dataToWrite = secretsData;

    if (userId) {
      logger.debug({ path: filePath, userId }, 'Saving per-user secrets');
      const allData = this._loadRawData();
      allData[userId] = secretsData;
      dataToWrite = allData;
    }

    logger.debug({ path: filePath, userId: userId || 'global' }, 'Saving encrypted secrets');
    const plaintext = JSON.stringify(dataToWrite);
    const envelope = encrypt(plaintext, this.encryptionKey);
    writeJsonFile(filePath, envelope);
  }

  /**
   * @description Loads secrets from disk. When a userId is provided, returns
   * only the per-user partition. When encryption is enabled, reads the
   * encrypted envelope and decrypts it. Returns an empty object if the file
   * does not exist or the user has no stored secrets.
   *
   * @param {string|null} userId - The user identifier (JWT sub claim) for per-user loading, or null for global
   * @returns {object} The decrypted or plain secrets object for the user (or global)
   * @throws {Error} If decryption fails (wrong key or corrupted data)
   */
  loadSecrets(userId = null) {
    const allData = this._loadRawData();

    if (userId) {
      const userData = allData[userId] || {};
      logger.debug({ userId, keyCount: Object.keys(userData).length }, 'Loaded per-user secrets');
      return userData;
    }

    return allData;
  }

  /**
   * @description Loads the raw (decrypted) data from disk without user filtering.
   * Returns an empty object if the file does not exist. This is the internal
   * method used by saveSecrets and loadSecrets for envelope management.
   *
   * @returns {object} The full raw data object from disk
   * @throws {Error} If decryption fails (wrong key or corrupted data)
   */
  _loadRawData() {
    this._requireEncryptionKey('load secrets');
    this._rejectLegacyPlaintextStore();
    const filePath = this.getSecretsPath();

    if (!fs.existsSync(filePath)) {
      logger.debug({ path: filePath }, 'Secrets file not found, returning empty');
      return {};
    }

    logger.debug({ path: filePath }, 'Loading encrypted secrets');
    const envelope = readJsonFile(filePath);
    const plaintext = decrypt(envelope, this.encryptionKey);
    return JSON.parse(plaintext);
  }

  /**
   * @description Deletes secrets for a specific user from the envelope. If no
   * userId is provided, behaves like deleteSecrets (deletes entire file).
   *
   * @param {string} userId - The user identifier whose secrets should be removed
   * @returns {boolean} True if the user's secrets were found and removed
   */
  deleteUserSecrets(userId) {
    this._requireEncryptionKey('delete user secrets');
    this._rejectLegacyPlaintextStore();
    if (!userId) {
      return this.deleteSecrets();
    }

    const allData = this._loadRawData();

    if (!allData[userId]) {
      logger.info({ userId }, 'No secrets found for user to delete');
      return false;
    }

    delete allData[userId];
    logger.info({ userId }, 'Deleted per-user secrets from envelope');

    // Re-save the envelope without this user
    const filePath = this.getSecretsPath();
    const plaintext = JSON.stringify(allData);
    const envelope = encrypt(plaintext, this.encryptionKey);
    writeJsonFile(filePath, envelope);

    return true;
  }

  /**
   * @description Migrates existing plain JSON secrets to encrypted format.
   * Reads `secrets.json`, encrypts its contents, writes `secrets.enc.json`,
   * and optionally removes the original plain file. Requires an encryption
   * key to be configured.
   *
   * @param {boolean} removePlain - Must remain true; retaining plaintext is disabled
   * @returns {{ migrated: boolean, recordCount: number }} Migration result
   * @throws {Error} If no encryption key is configured or migration fails
   */
  migrateFromPlaintext(removePlain = true) {
    logger.info('Starting migration from plain to encrypted secrets');

    this._requireEncryptionKey('migrate plaintext secrets');
    if (removePlain !== true) {
      const error = new Error('Cannot migrate while retaining plaintext secrets');
      error.code = 'PLAINTEXT_SECRET_RETENTION_DISABLED';
      throw error;
    }

    const plainPath = this.getPlainSecretsPath();

    if (!fs.existsSync(plainPath)) {
      logger.info({ path: plainPath }, 'No plain secrets file found — nothing to migrate');
      return { migrated: false, recordCount: 0 };
    }

    const encryptedPath = this.getEncryptedSecretsPath();
    if (fs.existsSync(encryptedPath)) {
      const error = new Error(
        'Cannot migrate: encrypted and plaintext secret stores both exist; reconcile them offline',
      );
      error.code = 'SECRET_STORE_MIGRATION_CONFLICT';
      throw error;
    }

    const plainData = readJsonFile(plainPath);
    const recordCount = Object.keys(plainData).length;

    try {
      const envelope = encrypt(JSON.stringify(plainData), this.encryptionKey);
      writeJsonFile(encryptedPath, envelope);
      // Verify the new envelope before removing the only legacy copy.
      const verified = JSON.parse(decrypt(readJsonFile(encryptedPath), this.encryptionKey));
      if (JSON.stringify(verified) !== JSON.stringify(plainData)) {
        throw new Error('Encrypted secret migration verification failed');
      }
    } catch (error) {
      // A partial target must not block a safe retry or masquerade as a successful migration.
      if (fs.existsSync(encryptedPath)) fs.unlinkSync(encryptedPath);
      throw error;
    }
    fs.unlinkSync(plainPath);
    logger.info({ path: plainPath }, 'Removed plain secrets file after migration');

    logger.info({ recordCount, removedPlain: true }, 'Migration complete');
    return { migrated: true, recordCount };
  }

  /**
   * @description Re-encrypts all secrets with a new master key. Decrypts
   * using the current key, then re-encrypts and saves with the new key.
   * Updates the instance's encryption key to the new value.
   *
   * @param {string} newKey - The new encryption key to use
   * @returns {{ rotated: boolean, recordCount: number }} Rotation result
   * @throws {Error} If the current key is invalid or rotation fails
   */
  rotateKey(newKey) {
    logger.info('Starting key rotation');

    if (!this.encryptionKey) {
      const msg = 'Cannot rotate key: no encryption key currently configured';
      logger.error(msg);
      throw new Error(msg);
    }

    if (!newKey) {
      const msg = 'Cannot rotate key: new key is empty';
      logger.error(msg);
      throw new Error(msg);
    }

    const secrets = this.loadSecrets();
    const recordCount = Object.keys(secrets).length;

    this.encryptionKey = newKey;
    this.saveSecrets(secrets);

    logger.info({ recordCount }, 'Key rotation complete');
    return { rotated: true, recordCount };
  }

  /**
   * @description Deletes the secrets file (encrypted or plain) from disk.
   * Logs the operation and the file path removed.
   *
   * @returns {boolean} True if a file was deleted, false if no file existed
   */
  deleteSecrets() {
    this._requireEncryptionKey('delete secrets');
    this._rejectLegacyPlaintextStore();
    const filePath = this.getSecretsPath();

    if (!fs.existsSync(filePath)) {
      logger.info({ path: filePath }, 'No secrets file to delete');
      return false;
    }

    try {
      fs.unlinkSync(filePath);
      logger.info({ path: filePath }, 'Secrets file deleted');
      return true;
    } catch (error) {
      logger.error({ err: error, path: filePath }, 'Failed to delete secrets file');
      throw error;
    }
  }

  /**
   * @description Checks whether encryption is currently enabled (an encryption
   * key has been configured).
   *
   * @returns {boolean} True if encryption is active
   */
  isEncrypted() {
    return !!this.encryptionKey;
  }

  /**
   * @description Refuses secret operations when the controller has no master key.
   * @param {string} operation - Bounded operation name for diagnostics
   * @returns {void}
   * @throws {Error} With stable ENCRYPTION_KEY_REQUIRED code
   */
  _requireEncryptionKey(operation) {
    if (this.encryptionKey) return;
    const error = new Error(`ENCRYPTION_KEY is required to ${operation}`);
    error.code = 'ENCRYPTION_KEY_REQUIRED';
    throw error;
  }

  /**
   * @description Prevents a legacy plaintext store from being silently ignored or overwritten.
   * Operators must run the explicit one-way migration before normal secret operations resume.
   * @returns {void}
   * @throws {Error} With stable LEGACY_PLAINTEXT_SECRETS_PRESENT code
   */
  _rejectLegacyPlaintextStore() {
    const plainPath = this.getPlainSecretsPath();
    if (!fs.existsSync(plainPath)) return;
    const error = new Error(
      'Legacy plaintext secrets.json is present; run encrypted migration before secret operations',
    );
    error.code = 'LEGACY_PLAINTEXT_SECRETS_PRESENT';
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  EncryptedConfigManager,
  ENCRYPTED_SECRETS_FILE,
  PLAIN_SECRETS_FILE,
};
