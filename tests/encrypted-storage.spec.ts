/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Initial implementation of encrypted storage tests
 * 2   | maintainer@emeraldcoastsystemsgroup.com     | Added per-user config envelope tests
 * 3   | maintainer@emeraldcoastsystemsgroup.com     | Guarded fail-closed encrypted storage, one-way plaintext migration, owner-only file modes, and operator config-route behavior
 */

import { test, expect, request as apiRequest, type APIRequestContext } from '@playwright/test';
import express from 'express';
import http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createConfigRoutes } from '@/app/routes/config-routes';

const ENCRYPTED_FILE = 'secrets.enc.json';
const PLAINTEXT_FILE = 'secrets.json';
const TEST_KEY = 'test-encryption-key-for-manager';
const OPERATOR_SUB = 'Encrypted-Store-Test-Operator';

interface CodedError extends Error {
  code?: string;
}

interface ConfigApiHarness {
  api: APIRequestContext;
  root: string;
  close: () => Promise<void>;
}

/** Create one disposable directory for a real filesystem boundary test. */
function createTempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `oshal-${label}-`));
}

/** Persist a deliberate legacy plaintext fixture without using the live manager. */
function writePlainSecrets(outputDir: string, data: Record<string, unknown>): void {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, PLAINTEXT_FILE), JSON.stringify(data, null, 2), 'utf8');
}

/** Capture a synchronous failure so tests can assert its stable code and message. */
function captureError(action: () => unknown): CodedError {
  try {
    action();
  } catch (error) {
    return error as CodedError;
  }
  throw new Error('Expected operation to fail');
}

/** Assert a stable manager error code without discarding its diagnostic message. */
function expectErrorCode(action: () => unknown, code: string): CodedError {
  const error = captureError(action);
  expect(error.code).toBe(code);
  expect(error.message.length).toBeGreaterThan(0);
  return error;
}

/** Require a 0600 encrypted envelope on filesystems that expose POSIX mode bits. */
function expectOwnerOnlyPermissions(filePath: string): void {
  expect(fs.existsSync(filePath)).toBe(true);
  // Node exposes synthetic mode bits on Windows; Linux CI and production containers enforce 0600.
  if (process.platform === 'win32') return;
  expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
}

/** Restore a bounded set of environment variables after an in-process API harness. */
function restoreEnvironment(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Start the real config router with an exact operator and disposable persistence paths. */
async function startConfigApi(encryptionKey: string | null): Promise<ConfigApiHarness> {
  const root = createTempDir('config-api');
  const keys = ['OSHAL_OPERATOR_SUBS', 'CONFIG_OUTPUT_DIR', 'CLINE_CONFIG_DIR',
    'OPENAI_CODEX_SHARED_SEED_PATH', 'ENCRYPTION_KEY'];
  const snapshot = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR_SUB;
  process.env.CONFIG_OUTPUT_DIR = root;
  process.env.CLINE_CONFIG_DIR = path.join(root, 'cline');
  process.env.OPENAI_CODEX_SHARED_SEED_PATH = path.join(root, 'seed', 'secrets.json');
  if (encryptionKey === null) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = encryptionKey;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).oidc = { isAuthenticated: () => true, user: { sub: OPERATOR_SUB } };
    next();
  });
  app.use('/api/config', createConfigRoutes());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const api = await apiRequest.newContext({ baseURL: `http://127.0.0.1:${port}` });

  return {
    api,
    root,
    close: async () => {
      await api.dispose();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      restoreEnvironment(snapshot);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test.describe('Unit — crypto-utils encrypt/decrypt', () => {
  test('encrypts and decrypts a simple string', () => {
    const { encrypt, decrypt } = require('../src/api/crypto-utils');
    const plaintext = 'Hello, encrypted world!';
    const envelope = encrypt(plaintext, TEST_KEY);

    expect(envelope).toHaveProperty('salt');
    expect(envelope).toHaveProperty('iv');
    expect(envelope).toHaveProperty('authTag');
    expect(envelope).toHaveProperty('ciphertext');
    expect(decrypt(envelope, TEST_KEY)).toBe(plaintext);
  });

  test('encrypts and decrypts JSON config data', () => {
    const { encrypt, decrypt } = require('../src/api/crypto-utils');
    const configData = {
      apiKey: 'provider-test-value',
      accessKey: 'cloud-access-test-value',
      secretKey: 'cloud-secret-test-value',
    };
    const envelope = encrypt(JSON.stringify(configData), TEST_KEY);
    expect(JSON.parse(decrypt(envelope, TEST_KEY))).toEqual(configData);
  });

  test('uses a unique salt and IV for each encryption', () => {
    const { encrypt } = require('../src/api/crypto-utils');
    const first = encrypt('same-data', TEST_KEY);
    const second = encrypt('same-data', TEST_KEY);

    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.salt).not.toBe(second.salt);
    expect(first.iv).not.toBe(second.iv);
  });

  test('rejects a wrong decryption key', () => {
    const { encrypt, decrypt } = require('../src/api/crypto-utils');
    const envelope = encrypt('secret data', TEST_KEY);
    expect(() => decrypt(envelope, 'wrong-key')).toThrow(/Decryption failed/);
  });

  test('rejects tampered ciphertext', () => {
    const { encrypt, decrypt } = require('../src/api/crypto-utils');
    const envelope = encrypt('secret data', TEST_KEY);
    const bytes = Buffer.from(envelope.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    envelope.ciphertext = bytes.toString('base64');
    expect(() => decrypt(envelope, TEST_KEY)).toThrow(/Decryption failed/);
  });
});

test.describe('Unit — EncryptedConfigManager fail-closed storage', () => {
  let outputDir: string;

  test.beforeEach(() => {
    outputDir = createTempDir('encrypted-manager');
  });

  test.afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  test('saves only an encrypted owner-only envelope and loads it', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(outputDir, TEST_KEY);
    const secrets = { apiKey: 'provider-test-value', secretKey: 'cloud-test-value' };
    manager.saveSecrets(secrets);

    const encryptedPath = path.join(outputDir, ENCRYPTED_FILE);
    expect(fs.existsSync(path.join(outputDir, PLAINTEXT_FILE))).toBe(false);
    expectOwnerOnlyPermissions(encryptedPath);
    const raw = JSON.parse(fs.readFileSync(encryptedPath, 'utf8'));
    expect(raw).toHaveProperty('ciphertext');
    expect(JSON.stringify(raw)).not.toContain('provider-test-value');
    expect(manager.loadSecrets()).toEqual(secrets);
  });

  test('requires an encryption key for every secret operation', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(outputDir, null);
    const operations = [
      () => manager.saveSecrets({ apiKey: 'blocked' }),
      () => manager.loadSecrets(),
      () => manager.deleteSecrets(),
      () => manager.deleteUserSecrets('user-a'),
      () => manager.migrateFromPlaintext(),
      () => manager.rotateKey('replacement-key'),
    ];

    for (const operation of operations) {
      expect(captureError(operation).message).toMatch(/ENCRYPTION_KEY|encryption key/i);
    }
    expect(manager.getSecretsPath()).toBe(path.join(outputDir, ENCRYPTED_FILE));
    expect(fs.existsSync(path.join(outputDir, PLAINTEXT_FILE))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, ENCRYPTED_FILE))).toBe(false);
  });

  test('returns an empty object only when a key is configured and no envelope exists', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(outputDir, TEST_KEY);
    expect(manager.loadSecrets()).toEqual({});
  });

  test('blocks normal reads and writes while legacy plaintext exists', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const plainSecrets = { apiKey: 'legacy-provider-value' };
    writePlainSecrets(outputDir, plainSecrets);
    const manager = new EncryptedConfigManager(outputDir, TEST_KEY);

    expectErrorCode(() => manager.loadSecrets(), 'LEGACY_PLAINTEXT_SECRETS_PRESENT');
    expectErrorCode(() => manager.saveSecrets({ apiKey: 'replacement' }), 'LEGACY_PLAINTEXT_SECRETS_PRESENT');
    expectErrorCode(() => manager.deleteSecrets(), 'LEGACY_PLAINTEXT_SECRETS_PRESENT');
    expect(fs.existsSync(path.join(outputDir, ENCRYPTED_FILE))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, PLAINTEXT_FILE), 'utf8'))).toEqual(plainSecrets);
  });

  test('rejects migration that would retain plaintext', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const plainSecrets = { apiKey: 'legacy-provider-value' };
    writePlainSecrets(outputDir, plainSecrets);
    const manager = new EncryptedConfigManager(outputDir, TEST_KEY);

    expectErrorCode(() => manager.migrateFromPlaintext(false), 'PLAINTEXT_SECRET_RETENTION_DISABLED');
    expect(fs.existsSync(path.join(outputDir, ENCRYPTED_FILE))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, PLAINTEXT_FILE), 'utf8'))).toEqual(plainSecrets);
  });

  test('performs explicit one-way migration and removes plaintext', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const plainSecrets = { apiKey: 'migrate-provider-value', token: 'migrate-token-value' };
    writePlainSecrets(outputDir, plainSecrets);
    const manager = new EncryptedConfigManager(outputDir, TEST_KEY);
    const result = manager.migrateFromPlaintext();

    expect(result).toEqual({ migrated: true, recordCount: 2 });
    expect(fs.existsSync(path.join(outputDir, PLAINTEXT_FILE))).toBe(false);
    expectOwnerOnlyPermissions(path.join(outputDir, ENCRYPTED_FILE));
    expect(manager.loadSecrets()).toEqual(plainSecrets);
  });

  test('rejects encrypted and plaintext store conflicts without changing either file', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(outputDir, TEST_KEY);
    manager.saveSecrets({ apiKey: 'encrypted-provider-value' });
    writePlainSecrets(outputDir, { apiKey: 'plaintext-provider-value' });
    const encryptedPath = path.join(outputDir, ENCRYPTED_FILE);
    const plainPath = path.join(outputDir, PLAINTEXT_FILE);
    const before = { encrypted: fs.readFileSync(encryptedPath), plain: fs.readFileSync(plainPath) };

    expectErrorCode(() => manager.loadSecrets(), 'LEGACY_PLAINTEXT_SECRETS_PRESENT');
    expectErrorCode(() => manager.migrateFromPlaintext(), 'SECRET_STORE_MIGRATION_CONFLICT');
    expect(fs.readFileSync(encryptedPath).equals(before.encrypted)).toBe(true);
    expect(fs.readFileSync(plainPath).equals(before.plain)).toBe(true);
  });

  test('reports no migration when no plaintext file exists', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(outputDir, TEST_KEY);
    expect(manager.migrateFromPlaintext()).toEqual({ migrated: false, recordCount: 0 });
  });

  test('does not migrate plaintext without an encryption key', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    writePlainSecrets(outputDir, { apiKey: 'legacy-provider-value' });
    const manager = new EncryptedConfigManager(outputDir, null);
    const error = captureError(() => manager.migrateFromPlaintext());

    expect(error.message).toContain('ENCRYPTION_KEY');
    expect(fs.existsSync(path.join(outputDir, PLAINTEXT_FILE))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, ENCRYPTED_FILE))).toBe(false);
  });

  test('rotates the key and invalidates the old key', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(outputDir, 'old-encryption-key');
    const secrets = { apiKey: 'rotate-provider-value', token: 'rotate-token-value' };
    manager.saveSecrets(secrets);
    expect(manager.rotateKey('new-encryption-key')).toEqual({ rotated: true, recordCount: 2 });

    const oldManager = new EncryptedConfigManager(outputDir, 'old-encryption-key');
    expect(() => oldManager.loadSecrets()).toThrow(/Decryption failed/);
    const newManager = new EncryptedConfigManager(outputDir, 'new-encryption-key');
    expect(newManager.loadSecrets()).toEqual(secrets);
  });

  test('rejects an empty replacement key', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(outputDir, TEST_KEY);
    expect(() => manager.rotateKey('')).toThrow(/new key is empty/);
  });

  test('deletes only the encrypted secrets file', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(outputDir, TEST_KEY);
    manager.saveSecrets({ apiKey: 'delete-provider-value' });
    expect(manager.deleteSecrets()).toBe(true);
    expect(fs.existsSync(path.join(outputDir, ENCRYPTED_FILE))).toBe(false);
    expect(manager.deleteSecrets()).toBe(false);
  });

  test('rejects corrupted encrypted envelopes', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    fs.writeFileSync(path.join(outputDir, ENCRYPTED_FILE), JSON.stringify({
      salt: 'invalid', iv: 'invalid', authTag: 'invalid', ciphertext: 'invalid',
    }), 'utf8');
    const manager = new EncryptedConfigManager(outputDir, TEST_KEY);
    expect(() => manager.loadSecrets()).toThrow();
  });

  test('reports encryption availability without enabling plaintext mode', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    expect(new EncryptedConfigManager(outputDir, TEST_KEY).isEncrypted()).toBe(true);
    expect(new EncryptedConfigManager(outputDir, null).isEncrypted()).toBe(false);
  });
});

test.describe('Unit — EncryptedConfigManager per-user envelopes', () => {
  let outputDir: string;
  const userA = 'user-a-sub-claim-123';
  const userB = 'user-b-sub-claim-456';

  test.beforeEach(() => {
    outputDir = createTempDir('encrypted-users');
  });

  test.afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  test('saves and loads different users independently', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(outputDir, TEST_KEY);
    manager.saveSecrets({ apiKey: 'user-a-provider-value' }, userA);
    manager.saveSecrets({ apiKey: 'user-b-provider-value', secretKey: 'user-b-secret-value' }, userB);

    expect(manager.loadSecrets(userA)).toEqual({ apiKey: 'user-a-provider-value' });
    expect(manager.loadSecrets(userB)).toEqual({
      apiKey: 'user-b-provider-value', secretKey: 'user-b-secret-value',
    });
  });

  test('does not leak one user partition to another', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(outputDir, TEST_KEY);
    manager.saveSecrets({ apiKey: 'user-a-only-value' }, userA);
    expect(manager.loadSecrets(userB)).toEqual({});
  });

  test('deletes only the selected user partition', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(outputDir, TEST_KEY);
    manager.saveSecrets({ apiKey: 'user-a-value' }, userA);
    manager.saveSecrets({ apiKey: 'user-b-value' }, userB);

    expect(manager.deleteUserSecrets(userA)).toBe(true);
    expect(manager.loadSecrets(userA)).toEqual({});
    expect(manager.loadSecrets(userB)).toEqual({ apiKey: 'user-b-value' });
    expect(manager.deleteUserSecrets('missing-user')).toBe(false);
  });

  test('returns all encrypted partitions only for a global load', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(outputDir, TEST_KEY);
    manager.saveSecrets({ apiKey: 'user-a-value' }, userA);
    manager.saveSecrets({ apiKey: 'user-b-value' }, userB);
    expect(manager.loadSecrets()).toEqual({
      [userA]: { apiKey: 'user-a-value' },
      [userB]: { apiKey: 'user-b-value' },
    });
  });

  test('supports caller-managed merging inside one encrypted partition', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(outputDir, TEST_KEY);
    manager.saveSecrets({ apiKey: 'user-a-value' }, userA);
    const existing = manager.loadSecrets(userA);
    manager.saveSecrets({ ...existing, secretKey: 'user-a-secret-value' }, userA);
    expect(manager.loadSecrets(userA)).toEqual({
      apiKey: 'user-a-value', secretKey: 'user-a-secret-value',
    });
  });

  test('rejects per-user persistence when the encryption key is absent', () => {
    const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');
    const manager = new EncryptedConfigManager(outputDir, null);
    expect(captureError(() => manager.saveSecrets({ apiKey: 'blocked' }, userA)).message)
      .toContain('ENCRYPTION_KEY');
    expect(captureError(() => manager.loadSecrets(userA)).message).toContain('ENCRYPTION_KEY');
    expect(fs.existsSync(path.join(outputDir, PLAINTEXT_FILE))).toBe(false);
  });
});

test.describe('API integration — encrypted global config storage', () => {
  test.describe.configure({ mode: 'serial' });

  test('saves settings separately and returns only a redacted secret', async () => {
    const harness = await startConfigApi('config-route-test-encryption-key');
    try {
      const saved = await harness.api.post('/api/config', {
        data: { provider: 'anthropic', apiKey: 'route-provider-secret-value' },
      });
      expect(saved.status()).toBe(200);
      const loaded = await harness.api.get('/api/config');
      const body = await loaded.json();
      expect(body.config.provider).toBe('anthropic');
      expect(body.config.apiKey).toBe('[REDACTED]');

      const settings = fs.readFileSync(path.join(harness.root, 'global-config.json'), 'utf8');
      const encrypted = fs.readFileSync(path.join(harness.root, ENCRYPTED_FILE), 'utf8');
      expect(settings).not.toContain('route-provider-secret-value');
      expect(encrypted).not.toContain('route-provider-secret-value');
      expectOwnerOnlyPermissions(path.join(harness.root, ENCRYPTED_FILE));
    } finally {
      await harness.close();
    }
  });

  test('returns a stable unavailable result when encrypted storage is not configured', async () => {
    const harness = await startConfigApi(null);
    try {
      const responses = [
        await harness.api.get('/api/config'),
        await harness.api.post('/api/config', { data: { apiKey: 'blocked-value' } }),
        await harness.api.delete('/api/config'),
        await harness.api.post('/api/config/migrate', { data: {} }),
      ];
      for (const response of responses) {
        expect(response.status()).toBe(503);
        expect(await response.json()).toMatchObject({
          success: false,
          error: 'encrypted_secret_storage_required',
        });
      }
      expect(fs.existsSync(path.join(harness.root, PLAINTEXT_FILE))).toBe(false);
      expect(fs.existsSync(path.join(harness.root, ENCRYPTED_FILE))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  test('requires one-way migration and removes the legacy plaintext file', async () => {
    const harness = await startConfigApi('config-route-migration-key');
    try {
      writePlainSecrets(harness.root, { apiKey: 'route-legacy-secret-value' });
      const retain = await harness.api.post('/api/config/migrate', { data: { removePlain: false } });
      expect(retain.status()).toBe(400);
      expect((await retain.json()).error).toBe('plaintext_secret_retention_disabled');
      expect(fs.existsSync(path.join(harness.root, ENCRYPTED_FILE))).toBe(false);

      const migrated = await harness.api.post('/api/config/migrate', { data: {} });
      expect(migrated.status()).toBe(200);
      expect(await migrated.json()).toMatchObject({ success: true, migrated: true, recordCount: 1 });
      expect(fs.existsSync(path.join(harness.root, PLAINTEXT_FILE))).toBe(false);
      expectOwnerOnlyPermissions(path.join(harness.root, ENCRYPTED_FILE));
    } finally {
      await harness.close();
    }
  });

  test('deletes encrypted config without recreating plaintext', async () => {
    const harness = await startConfigApi('config-route-delete-key');
    try {
      const saved = await harness.api.post('/api/config', {
        data: { provider: 'openai', apiKey: 'route-delete-secret-value' },
      });
      expect(saved.status()).toBe(200);
      const deleted = await harness.api.delete('/api/config');
      expect(deleted.status()).toBe(200);
      expect(await deleted.json()).toMatchObject({ success: true, cleared: true });
      expect(fs.existsSync(path.join(harness.root, 'global-config.json'))).toBe(false);
      expect(fs.existsSync(path.join(harness.root, ENCRYPTED_FILE))).toBe(false);
      expect(fs.existsSync(path.join(harness.root, PLAINTEXT_FILE))).toBe(false);
    } finally {
      await harness.close();
    }
  });
});
