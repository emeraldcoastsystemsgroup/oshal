/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of AES-256-GCM encryption utilities
 */

'use strict';

const crypto = require('crypto');
const pino = require('pino');

const logger = pino({ name: 'crypto-utils' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_DIGEST = 'sha512';
const AUTH_TAG_LENGTH = 16;
const ENCODING = 'base64';

// ---------------------------------------------------------------------------
// Key Derivation
// ---------------------------------------------------------------------------

/**
 * @description Derives a 256-bit encryption key from a password and salt using
 * PBKDF2 with 100K iterations and SHA-512. Provides brute-force resistance
 * for password-based key material.
 *
 * @param {string} password - The master password or key material
 * @param {Buffer} salt - A 32-byte random salt
 * @returns {Buffer} A 32-byte derived key suitable for AES-256
 */
function deriveKey(password, salt) {
  logger.debug({ saltLength: salt.length }, 'Deriving encryption key via PBKDF2');

  const key = crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    PBKDF2_DIGEST
  );

  logger.debug('Key derivation complete');
  return key;
}

/**
 * @description Generates a cryptographically secure random salt for use
 * with PBKDF2 key derivation. Each encryption operation should use a
 * unique salt to prevent rainbow table attacks.
 *
 * @returns {Buffer} A 32-byte random salt
 */
function generateSalt() {
  const salt = crypto.randomBytes(SALT_LENGTH);
  logger.debug({ saltLength: SALT_LENGTH }, 'Generated random salt');
  return salt;
}

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

/**
 * @description Encrypts plaintext using AES-256-GCM with a password-derived key.
 * Generates a fresh salt and IV for each encryption operation to ensure
 * semantic security. Returns a JSON-serializable envelope containing all
 * values needed for decryption.
 *
 * @param {string} plaintext - The data to encrypt (typically JSON-stringified config)
 * @param {string} masterKey - The master password or encryption key from environment
 * @returns {{ salt: string, iv: string, authTag: string, ciphertext: string }} Encrypted envelope with base64-encoded fields
 */
function encrypt(plaintext, masterKey) {
  logger.info('Encrypting data with AES-256-GCM');

  const salt = generateSalt();
  const key = deriveKey(masterKey, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  const envelope = {
    salt: salt.toString(ENCODING),
    iv: iv.toString(ENCODING),
    authTag: authTag.toString(ENCODING),
    ciphertext: encrypted.toString(ENCODING),
  };

  logger.info({ ciphertextLength: encrypted.length }, 'Encryption complete');
  return envelope;
}

// ---------------------------------------------------------------------------
// Decryption
// ---------------------------------------------------------------------------

/**
 * @description Decrypts an AES-256-GCM encrypted envelope back to plaintext.
 * Verifies the authentication tag to detect tampering. Throws an error
 * if the key is wrong or the data has been modified.
 *
 * @param {{ salt: string, iv: string, authTag: string, ciphertext: string }} envelope - The encrypted envelope from encrypt()
 * @param {string} masterKey - The master password or encryption key used during encryption
 * @returns {string} The decrypted plaintext
 * @throws {Error} If decryption fails due to wrong key or tampered data
 */
function decrypt(envelope, masterKey) {
  logger.info('Decrypting data with AES-256-GCM');

  const salt = Buffer.from(envelope.salt, ENCODING);
  const iv = Buffer.from(envelope.iv, ENCODING);
  const authTag = Buffer.from(envelope.authTag, ENCODING);
  const ciphertext = Buffer.from(envelope.ciphertext, ENCODING);

  const key = deriveKey(masterKey, salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    logger.info({ plaintextLength: decrypted.length }, 'Decryption complete');
    return decrypted.toString('utf8');
  } catch (error) {
    logger.error({ err: error }, 'Decryption failed — wrong key or tampered data');
    throw new Error(
      'Decryption failed: invalid key or corrupted data. ' +
      'Ensure ENCRYPTION_KEY matches the key used during encryption.'
    );
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  encrypt,
  decrypt,
  deriveKey,
  generateSalt,
  ALGORITHM,
  KEY_LENGTH,
  IV_LENGTH,
  SALT_LENGTH,
  PBKDF2_ITERATIONS,
};