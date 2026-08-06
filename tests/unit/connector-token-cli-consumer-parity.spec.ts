/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Inventory every JavaScript CLI that reads
 *   | connector tokens directly from oshal_connections and require the shared format-aware codec.
 *   | Pin legacy, k2, v2, and hkdf1 parity with the TypeScript controller; refreshed-token writes
 *   | must pass through encryptToken so no CLI can silently restore plaintext or legacy formats.
 */

import crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONNECTOR_TOKEN_ENVELOPE_V2,
  CONNECTOR_TOKEN_SHARED_HKDF_V2,
  CONNECTOR_WRAPPED_DEK_HKDF_V1,
  decryptToken as decryptControllerToken,
} from '../../src/app/routes/connector-token-crypto';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');
const SCRIPTS = path.join(ROOT, 'scripts');
const SHARED_CODEC_MODULE = /require\s*\(\s*['"][^'"]*connector-token-crypto(?:\.js)?['"]\s*\)/;
const PRIVATE_CODEC_PRIMITIVE = /\bcreate(?:Cipheriv|Decipheriv)\s*\(/;
const STORED_ACCESS_TOKEN_DECRYPT = /\bdecryptToken\s*\([\s\S]{0,300}?\.access_token\b[\s\S]{0,40}?\)/;
const STORED_REFRESH_TOKEN_DECRYPT = /\bdecryptToken\s*\([\s\S]{0,300}?\.refresh_token\b[\s\S]{0,40}?\)/;
const CONNECTION_ACCESS_TOKEN_WRITE = /\b(?:UPDATE|INSERT\s+INTO)\s+oshal_connections[\s\S]{0,300}?\baccess_token\b/i;
const REFRESHED_ACCESS_TOKEN_ENCRYPT = /\bencryptToken\s*\([\s\S]{0,300}?\.access_token\b[\s\S]{0,40}?\)/;

/**
 * Reviewed inventory. A newly added direct database consumer must be audited and deliberately
 * added here even when it already uses the shared codec; that keeps this security boundary owned.
 */
const EXPECTED_DIRECT_CONSUMERS = [
  'scripts/oshal-apply.js',
  'scripts/oshal-duffel.js',
  'scripts/oshal-gcp-diag.js',
  'scripts/oshal-gcp.js',
  'scripts/oshal-gmail-send.js',
  'scripts/oshal-gmail.js',
  'scripts/oshal-linkedin.js',
  'scripts/oshal-outlook-imap.js',
  'scripts/oshal-outlook.js',
  'scripts/oshal-recap-email.js',
  'scripts/oshal-send-alert.js',
  'scripts/oshal-smartthings.js',
  'scripts/oshal-spotify.js',
  'scripts/oshal-tmdb.js',
  'scripts/oshal-uber-rides.js',
  'scripts/oshal-uber.js',
  'scripts/oshal-walmart.js',
  'scripts/oshal-x-read.js',
  'scripts/oshal-x.js',
  'scripts/schwab-live-smoke.js',
] as const;

interface ScriptSource {
  relativePath: string;
  source: string;
}

interface CliCodec {
  TOKEN_ENVELOPE_V2: string;
  TOKEN_SHARED_HKDF_V2: string;
  WRAPPED_DEK_HKDF_V1: string;
  legacyKey: () => Buffer;
  currentKey: () => Buffer;
  gcmEncryptRaw: (key: Buffer, plain: Buffer | string) => string;
  wrapDek: (dek: Buffer) => string;
  decryptToken: (pool: QueryablePool, userSub: string | undefined, blob: string) => Promise<string>;
}

interface QueryablePool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

const cliCodec = require('../../scripts/lib/connector-token-crypto.js') as CliCodec;

/** Walk only executable JavaScript; migrations, TypeScript utilities, and docs are separate rails. */
function* javascriptFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* javascriptFiles(absolute);
    else if (entry.isFile() && path.extname(entry.name) === '.js') yield absolute;
  }
}

/**
 * A direct consumer both names the connector-token table and handles an access_token. Provider
 * payload-only scripts (for example an OAuth refresher) therefore do not enter this inventory.
 */
function directConsumers(): ScriptSource[] {
  return [...javascriptFiles(SCRIPTS)]
    .map((file) => ({
      relativePath: path.relative(ROOT, file).replaceAll('\\', '/'),
      source: fs.readFileSync(file, 'utf8'),
    }))
    .filter(({ source }) => /\boshal_connections\b/i.test(source) && /\baccess_token\b/.test(source))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

const ENV_KEYS = ['SESSION_SECRET', 'OSHAL_ENVELOPE_CRYPTO', 'OSHAL_ENVELOPE_DEK_FAILURE'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.SESSION_SECRET = 'connector-token-cli-parity-test-secret';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('JavaScript connector-token consumer inventory', () => {
  it('keeps every direct oshal_connections consumer in the reviewed inventory', () => {
    expect(directConsumers().map(({ relativePath }) => relativePath)).toEqual(
      [...EXPECTED_DIRECT_CONSUMERS].sort((left, right) => left.localeCompare(right)),
    );
  });

  it('requires the shared codec and decrypts stored access/refresh tokens through it', () => {
    const violations: string[] = [];
    for (const consumer of directConsumers()) {
      if (!SHARED_CODEC_MODULE.test(consumer.source)) {
        violations.push(`${consumer.relativePath}: does not require scripts/lib/connector-token-crypto`);
      }
      if (PRIVATE_CODEC_PRIMITIVE.test(consumer.source)) {
        violations.push(`${consumer.relativePath}: carries a private AES-GCM codec`);
      }
      if (!STORED_ACCESS_TOKEN_DECRYPT.test(consumer.source)) {
        violations.push(`${consumer.relativePath}: stored access_token does not pass through decryptToken`);
      }
      if (/\brow\.refresh_token\b/.test(consumer.source) && !STORED_REFRESH_TOKEN_DECRYPT.test(consumer.source)) {
        violations.push(`${consumer.relativePath}: stored refresh_token does not pass through decryptToken`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('encrypts every refreshed access token before writing it to oshal_connections', () => {
    const violations = directConsumers()
      .filter(({ source }) => CONNECTION_ACCESS_TOKEN_WRITE.test(source))
      .filter(({ source }) => !REFRESHED_ACCESS_TOKEN_ENCRYPT.test(source))
      .map(({ relativePath }) => `${relativePath}: oshal_connections access_token write bypasses encryptToken`);
    expect(violations).toEqual([]);
  });
});

describe('JavaScript and TypeScript connector-token format parity', () => {
  it('shares the version prefixes used by the controller', () => {
    expect(cliCodec.TOKEN_ENVELOPE_V2).toBe(CONNECTOR_TOKEN_ENVELOPE_V2);
    expect(cliCodec.TOKEN_SHARED_HKDF_V2).toBe(CONNECTOR_TOKEN_SHARED_HKDF_V2);
    expect(cliCodec.WRAPPED_DEK_HKDF_V1).toBe(CONNECTOR_WRAPPED_DEK_HKDF_V1);
  });

  it('reads legacy, k2, and v2/hkdf1 fixtures identically to the controller', async () => {
    const dek = crypto.randomBytes(32);
    const wrappedDek = cliCodec.wrapDek(dek);
    const pool: QueryablePool = {
      async query(sql: string) {
        if (sql.includes('SELECT wrapped_dek FROM oshal_user_deks')) {
          return { rows: [{ wrapped_dek: wrappedDek }] };
        }
        throw new Error(`unexpected parity-pool query: ${sql}`);
      },
    };
    const fixtures = [
      {
        label: 'legacy',
        userSub: undefined,
        blob: cliCodec.gcmEncryptRaw(cliCodec.legacyKey(), 'legacy-token'),
        plain: 'legacy-token',
      },
      {
        label: 'k2',
        userSub: undefined,
        blob: cliCodec.TOKEN_SHARED_HKDF_V2 + cliCodec.gcmEncryptRaw(cliCodec.currentKey(), 'k2-token'),
        plain: 'k2-token',
      },
      {
        label: 'v2/hkdf1',
        userSub: 'format-parity-user',
        blob: cliCodec.TOKEN_ENVELOPE_V2 + cliCodec.gcmEncryptRaw(dek, 'v2-token'),
        plain: 'v2-token',
      },
    ];

    for (const fixture of fixtures) {
      expect(await cliCodec.decryptToken(pool, fixture.userSub, fixture.blob), fixture.label).toBe(fixture.plain);
      expect(await decryptControllerToken(pool, fixture.userSub, fixture.blob), fixture.label).toBe(fixture.plain);
    }
  });
});
