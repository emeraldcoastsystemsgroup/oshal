/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of encrypted storage tests
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added per-user config envelope tests
 */

import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const OUTPUT_DIR = path.resolve(__dirname, '../output');
const SECRETS_PLAIN = path.join(OUTPUT_DIR, 'secrets.json');
const SECRETS_ENCRYPTED = path.join(OUTPUT_DIR, 'secrets.enc.json');
const GLOBAL_CONFIG = path.join(OUTPUT_DIR, 'global-config.json');
const CLINE_CONFIG = path.join(OUTPUT_DIR, 'cline-config.json');

// ============================================================
// Helpers
// ============================================================

function cleanOutput() {
  const files = [SECRETS_PLAIN, SECRETS_ENCRYPTED, GLOBAL_CONFIG, CLINE_CONFIG];
  for (const f of files) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

function writeSecretsPlain(data: Record<string, string>) {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(SECRETS_PLAIN, JSON.stringify(data, null, 2), 'utf-8');
}

// ============================================================
// 1. UNIT TESTS — crypto-utils encrypt/decrypt round-trip
// ============================================================

test.describe('Unit — crypto-utils encrypt/decrypt', () => {
  test('encrypts and decrypts a simple string', () => {
    const { encrypt, decrypt } = require('../src/api/crypto-utils');
    const masterKey = 'test-master-key-12345';
    const plaintext = 'Hello, encrypted world!';

    const envelope = encrypt(plaintext, masterKey);

    expect(envelope).toHaveProperty('salt');
    expect(envelope).toHaveProperty('iv');
    expect(envelope).toHaveProperty('authTag');
    expect(envelope).toHaveProperty('ciphertext');

    const decrypted = decrypt(envelope, masterKey);
    expect(decrypted).toBe(plaintext);
  });

  test('encrypts and decrypts JSON config data', () => {
    const { encrypt, decrypt } = require('../src/api/crypto-utils');
    const masterKey = 'my-secret-encryption-key';
    const configData = {
      apiKey: 'sk-ant-api03-abc123',
      awsAccessKey: 'AKIAIOSFODNN7EXAMPLE',
      awsSecretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    };

    const plaintext = JSON.stringify(configData);
    const envelope = encrypt(plaintext, masterKey);
    const decrypted = decrypt(envelope, masterKey);

    expect(JSON.parse(decrypted)).toEqual(configData);
  });

  test('each encryption produces different ciphertext (unique salt/IV)', () => {
    const { encrypt } = require('../src/api/crypto-utils');
    const masterKey = 'test-key';
    const plaintext = 'same-data';

    const envelope1 = encrypt(plaintext, masterKey);
    const envelope2 = encrypt(plaintext, masterKey);

    expect(envelope1.ciphertext).not.toBe(envelope2.ciphertext);
    expect(envelope1.salt).not.toBe(envelope2.salt);
    expect(envelope1.iv).not.toBe(envelope2.iv);
  });

  test('wrong key fails to decrypt', () => {
    const { encrypt, decrypt } = require('../src/api/crypto-utils');
    const masterKey = 'correct-key';
    const wrongKey = 'wrong-key';

    const envelope = encrypt('secret data', masterKey);

    expect(() => decrypt(envelope, wrongKey)).toThrow(/Decryption failed/);
  });

  test('tampered ciphertext fails to decrypt', () => {
    const { encrypt, decrypt } = require('../src/api/crypto-utils');
    const masterKey = 'test-key';

    const envelope = encrypt('secret data', masterKey);

    // Tamper with the ciphertext
    const buf = Buffer.from(envelope.ciphertext, 'base64');
    buf[0] = buf[0] ^ 0xff;
    envelope.ciphertext = buf.toString('base64');

    expect(() => decrypt(envelope, masterKey)).toThrow(/Decryption failed/);
  });
});

// ============================================================
// 2. UNIT TESTS — EncryptedConfigManager
// ============================================================

test.describe('Unit — EncryptedConfigManager', () => {
  const TEST_KEY = 'test-encryption-key-for-manager';

  test.beforeEach(() => {
    cleanOutput();
  });

  test.afterAll(() => {
    cleanOutput();
  });

  test('saves and loads encrypted secrets', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(OUTPUT_DIR, TEST_KEY);

    const secrets = { apiKey: 'sk-test-123', awsSecretKey: 'aws-secret' };
    manager.saveSecrets(secrets);

    expect(fs.existsSync(SECRETS_ENCRYPTED)).toBe(true);
    expect(fs.existsSync(SECRETS_PLAIN)).toBe(false);

    // Verify encrypted file is not readable as plain JSON secrets
    const raw = JSON.parse(fs.readFileSync(SECRETS_ENCRYPTED, 'utf-8'));
    expect(raw).toHaveProperty('salt');
    expect(raw).toHaveProperty('ciphertext');
    expect(raw).not.toHaveProperty('apiKey');

    const loaded = manager.loadSecrets();
    expect(loaded).toEqual(secrets);
  });

  test('falls back to plain JSON when no key', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(OUTPUT_DIR, null);

    const secrets = { apiKey: 'sk-plain-123' };
    manager.saveSecrets(secrets);

    expect(fs.existsSync(SECRETS_PLAIN)).toBe(true);
    expect(fs.existsSync(SECRETS_ENCRYPTED)).toBe(false);

    const raw = JSON.parse(fs.readFileSync(SECRETS_PLAIN, 'utf-8'));
    expect(raw).toEqual(secrets);

    const loaded = manager.loadSecrets();
    expect(loaded).toEqual(secrets);
  });

  test('returns empty object when no secrets file exists', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(OUTPUT_DIR, TEST_KEY);

    const loaded = manager.loadSecrets();
    expect(loaded).toEqual({});
  });

  test('migrates plain secrets to encrypted', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');

    // Write plain secrets
    const plainSecrets = { apiKey: 'sk-migrate-me', token: 'tok-123' };
    writeSecretsPlain(plainSecrets);
    expect(fs.existsSync(SECRETS_PLAIN)).toBe(true);

    // Migrate
    const manager = new EncryptedConfigManager(OUTPUT_DIR, TEST_KEY);
    const result = manager.migrateFromPlaintext(false);

    expect(result.migrated).toBe(true);
    expect(result.recordCount).toBe(2);
    expect(fs.existsSync(SECRETS_ENCRYPTED)).toBe(true);
    // Plain file still exists (removePlain = false)
    expect(fs.existsSync(SECRETS_PLAIN)).toBe(true);

    // Verify encrypted data is correct
    const loaded = manager.loadSecrets();
    expect(loaded).toEqual(plainSecrets);
  });

  test('migrates and removes plain file', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');

    writeSecretsPlain({ apiKey: 'remove-me' });
    const manager = new EncryptedConfigManager(OUTPUT_DIR, TEST_KEY);

    manager.migrateFromPlaintext(true);

    expect(fs.existsSync(SECRETS_ENCRYPTED)).toBe(true);
    expect(fs.existsSync(SECRETS_PLAIN)).toBe(false);
  });

  test('migration with no plain file returns not-migrated', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(OUTPUT_DIR, TEST_KEY);

    const result = manager.migrateFromPlaintext(false);
    expect(result.migrated).toBe(false);
    expect(result.recordCount).toBe(0);
  });

  test('migration without encryption key throws', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(OUTPUT_DIR, null);

    expect(() => manager.migrateFromPlaintext(false)).toThrow(/no encryption key/);
  });

  test('key rotation re-encrypts with new key', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const oldKey = 'old-encryption-key';
    const newKey = 'new-encryption-key';

    const manager = new EncryptedConfigManager(OUTPUT_DIR, oldKey);
    const secrets = { apiKey: 'sk-rotate-me', token: 'tok-rotate' };
    manager.saveSecrets(secrets);

    // Rotate key
    const result = manager.rotateKey(newKey);
    expect(result.rotated).toBe(true);
    expect(result.recordCount).toBe(2);

    // Old key should fail
    const oldManager = new EncryptedConfigManager(OUTPUT_DIR, oldKey);
    expect(() => oldManager.loadSecrets()).toThrow(/Decryption failed/);

    // New key should work
    const newManager = new EncryptedConfigManager(OUTPUT_DIR, newKey);
    const loaded = newManager.loadSecrets();
    expect(loaded).toEqual(secrets);
  });

  test('key rotation without encryption key throws', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(OUTPUT_DIR, null);

    expect(() => manager.rotateKey('new-key')).toThrow(/no encryption key/);
  });

  test('key rotation with empty new key throws', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(OUTPUT_DIR, 'current-key');

    expect(() => manager.rotateKey('')).toThrow(/new key is empty/);
  });

  test('deleteSecrets removes the secrets file', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(OUTPUT_DIR, TEST_KEY);

    manager.saveSecrets({ apiKey: 'delete-me' });
    expect(fs.existsSync(SECRETS_ENCRYPTED)).toBe(true);

    const deleted = manager.deleteSecrets();
    expect(deleted).toBe(true);
    expect(fs.existsSync(SECRETS_ENCRYPTED)).toBe(false);
  });

  test('deleteSecrets returns false when no file', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(OUTPUT_DIR, TEST_KEY);

    const deleted = manager.deleteSecrets();
    expect(deleted).toBe(false);
  });

  test('corrupted encrypted file throws on load', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(OUTPUT_DIR, TEST_KEY);

    // Write a corrupted envelope
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(SECRETS_ENCRYPTED, JSON.stringify({
      salt: 'invalid',
      iv: 'invalid',
      authTag: 'invalid',
      ciphertext: 'invalid',
    }), 'utf-8');

    expect(() => manager.loadSecrets()).toThrow();
  });

  test('isEncrypted returns correct status', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');

    const encrypted = new EncryptedConfigManager(OUTPUT_DIR, 'key');
    expect(encrypted.isEncrypted()).toBe(true);

    const plain = new EncryptedConfigManager(OUTPUT_DIR, null);
    expect(plain.isEncrypted()).toBe(false);
  });
});

// ============================================================
// 2b. UNIT TESTS — Per-user config envelopes
// ============================================================

test.describe('Unit — EncryptedConfigManager per-user envelopes', () => {
  const TEST_KEY = 'test-encryption-key-per-user';
  const USER_A = 'user-a-sub-claim-123';
  const USER_B = 'user-b-sub-claim-456';

  test.beforeEach(() => {
    cleanOutput();
  });

  test.afterAll(() => {
    cleanOutput();
  });

  test('saves and loads secrets for different users independently', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(OUTPUT_DIR, TEST_KEY);

    const secretsA = { apiKey: 'sk-user-a-key' };
    const secretsB = { apiKey: 'sk-user-b-key', awsSecretKey: 'aws-b' };

    manager.saveSecrets(secretsA, USER_A);
    manager.saveSecrets(secretsB, USER_B);

    const loadedA = manager.loadSecrets(USER_A);
    const loadedB = manager.loadSecrets(USER_B);

    expect(loadedA).toEqual(secretsA);
    expect(loadedB).toEqual(secretsB);
  });

  test('user secrets do not leak between users', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(OUTPUT_DIR, TEST_KEY);

    manager.saveSecrets({ apiKey: 'sk-a-only' }, USER_A);

    const loadedB = manager.loadSecrets(USER_B);
    expect(loadedB).toEqual({});
    expect(loadedB).not.toHaveProperty('apiKey');
  });

  test('returns empty object for user with no secrets', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(OUTPUT_DIR, TEST_KEY);

    const loaded = manager.loadSecrets('nonexistent-user');
    expect(loaded).toEqual({});
  });

  test('deleteUserSecrets removes only specified user', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(OUTPUT_DIR, TEST_KEY);

    manager.saveSecrets({ apiKey: 'sk-a' }, USER_A);
    manager.saveSecrets({ apiKey: 'sk-b' }, USER_B);

    const deleted = manager.deleteUserSecrets(USER_A);
    expect(deleted).toBe(true);

    const loadedA = manager.loadSecrets(USER_A);
    expect(loadedA).toEqual({});

    const loadedB = manager.loadSecrets(USER_B);
    expect(loadedB).toEqual({ apiKey: 'sk-b' });
  });

  test('deleteUserSecrets returns false for nonexistent user', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(OUTPUT_DIR, TEST_KEY);

    manager.saveSecrets({ apiKey: 'sk-a' }, USER_A);

    const deleted = manager.deleteUserSecrets('nonexistent-user');
    expect(deleted).toBe(false);
  });

  test('per-user works with plain mode (no encryption)', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(OUTPUT_DIR, null);

    manager.saveSecrets({ apiKey: 'sk-plain-a' }, USER_A);
    manager.saveSecrets({ apiKey: 'sk-plain-b' }, USER_B);

    expect(manager.loadSecrets(USER_A)).toEqual({ apiKey: 'sk-plain-a' });
    expect(manager.loadSecrets(USER_B)).toEqual({ apiKey: 'sk-plain-b' });
  });

  test('global load returns all user partitions when no userId', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(OUTPUT_DIR, TEST_KEY);

    manager.saveSecrets({ apiKey: 'sk-a' }, USER_A);
    manager.saveSecrets({ apiKey: 'sk-b' }, USER_B);

    const allData = manager.loadSecrets(null);
    expect(allData[USER_A]).toEqual({ apiKey: 'sk-a' });
    expect(allData[USER_B]).toEqual({ apiKey: 'sk-b' });
  });

  test('saveSecrets merges with existing user secrets', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(OUTPUT_DIR, TEST_KEY);

    manager.saveSecrets({ apiKey: 'sk-a' }, USER_A);

    // Load, merge, and save again (simulating ConfigManager behavior)
    const existing = manager.loadSecrets(USER_A);
    manager.saveSecrets({ ...existing, awsSecretKey: 'aws-a' }, USER_A);

    const loaded = manager.loadSecrets(USER_A);
    expect(loaded).toEqual({ apiKey: 'sk-a', awsSecretKey: 'aws-a' });
  });
});

// ============================================================
// 3. API INTEGRATION — server endpoints with encryption
// ============================================================

test.describe('API Integration — encrypted storage via server', () => {
  test.beforeEach(async ({ request }) => {
    // Clear config before each test
    await request.delete('/api/config');
  });

  test('POST /api/config saves and GET retrieves with secrets', async ({ request }) => {
    const config = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'sk-ant-test-123',
    };

    const postRes = await request.post('/api/config', { data: config });
    expect(postRes.ok()).toBe(true);

    const postBody = await postRes.json();
    expect(postBody.success).toBe(true);

    const getRes = await request.get('/api/config');
    expect(getRes.ok()).toBe(true);

    const getBody = await getRes.json();
    expect(getBody.success).toBe(true);
    expect(getBody.config.provider).toBe('anthropic');
    expect(getBody.config.apiKey).toBe('sk-ant-test-123');
  });

  test('GET /api/status includes encryption status', async ({ request }) => {
    const res = await request.get('/api/status');
    expect(res.ok()).toBe(true);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body).toHaveProperty('encrypted');
    expect(typeof body.encrypted).toBe('boolean');
    expect(body).toHaveProperty('writeMode');
    expect(body).toHaveProperty('outputDir');
  });

  test('DELETE /api/config clears all files', async ({ request }) => {
    // Save something first
    await request.post('/api/config', {
      data: { provider: 'openai', apiKey: 'sk-test-delete' },
    });

    const delRes = await request.delete('/api/config');
    expect(delRes.ok()).toBe(true);

    const delBody = await delRes.json();
    expect(delBody.cleared).toBe(true);

    // Verify config is empty
    const getRes = await request.get('/api/config');
    const getBody = await getRes.json();
    expect(Object.keys(getBody.config).length).toBe(0);
  });

  test('POST /api/config/migrate endpoint responds', async ({ request }) => {
    const res = await request.post('/api/config/migrate', {
      data: { removePlain: false },
    });

    const body = await res.json();

    // Without ENCRYPTION_KEY set, migrate returns 500 with error
    // With ENCRYPTION_KEY set, it returns 200 with migrated status
    if (res.ok()) {
      expect(body.success).toBe(true);
      expect(body).toHaveProperty('migrated');
    } else {
      expect(res.status()).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toContain('no encryption key');
    }
  });
});