/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise real qualified AES-GCM/HKDF with explicit SQL-map and logger doubles: exact identity, AAD, races, corruption and fail-closed storage. Not PostgreSQL/RLS/provider evidence.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decryptQualifiedConnectorToken as decrypt, encryptQualifiedConnectorToken as encrypt,
  QUALIFIED_CONNECTOR_DEK_PREFIX, QUALIFIED_CONNECTOR_TOKEN_PREFIX,
  type QualifiedConnectorPrincipal,
} from '@/app/routes/connector-qualified-token-crypto';

const logger = vi.hoisted(() => ({ debug: vi.fn(), error: vi.fn() }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => logger }));
const SECRET = 'qualified-crypto-test-secret-sentinel';
const A = { sub: 'same-sub-sentinel', principalIssuer: 'https://issuer-a.example.com' };
const B = { ...A, principalIssuer: 'https://issuer-b.example.com' };
const TOKEN = 'synthetic-token-sentinel-α';
const key = (who: QualifiedConnectorPrincipal) => JSON.stringify([who.sub, who.principalIssuer]);

/** SQL double only: does not implement sessions, RLS, database constraints or transaction semantics. */
function sqlDouble() {
  const rows = new Map<string, string>();
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    expect(sql).not.toMatch(/\boshal_(?:connections|user_deks)\b/);
    const id = JSON.stringify(values.slice(0, 2));
    if (sql.startsWith('SELECT wrapped_dek')) {
      expect(sql).toBe('SELECT wrapped_dek FROM oshal_qualified_deks WHERE owner_sub = $1 AND principal_issuer = $2');
      return { rows: rows.has(id) ? [{ wrapped_dek: rows.get(id)! }] : [] };
    }
    expect(sql).toBe('INSERT INTO oshal_qualified_deks (owner_sub, principal_issuer, wrapped_dek) '
      + 'VALUES ($1, $2, $3) ON CONFLICT (principal_issuer, owner_sub) DO NOTHING');
    if (!rows.has(id)) rows.set(id, String(values[2]));
    return { rows: [] };
  });
  return { rows, query };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SESSION_SECRET', SECRET);
});
afterEach(() => vi.unstubAllEnvs());

/** Deliberately mint fixture envelopes with a known DEK to isolate AAD from random-key separation. */
function fixtureEnvelope(who: QualifiedConnectorPrincipal, purpose: 'token' | 'dek', secretKey: Buffer, bytes: Buffer): string {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secretKey, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(['oshal:qualified-connector', 1, purpose, who.principalIssuer, who.sub])));
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const prefix = purpose === 'token' ? QUALIFIED_CONNECTOR_TOKEN_PREFIX : QUALIFIED_CONNECTOR_DEK_PREFIX;
  return prefix + [nonce, cipher.getAuthTag(), encrypted].map(part => part.toString('base64')).join(':');
}

const fixtureKek = () => Buffer.from(hkdfSync('sha256', Buffer.from(SECRET),
  Buffer.from('oshal:qualified-connector:kek:salt:v1'), Buffer.from('oshal:qualified-connector:kek:wrap:v1'), 32));
const writes = (db: ReturnType<typeof sqlDouble>) => db.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT'));

/** Inspect synthetic stored DEKs independently so fresh wrapper nonces cannot disguise a shared DEK. */
function fixtureUnwrap(who: QualifiedConnectorPrincipal, wrapped: string): Buffer {
  const [, nonce, tag, bytes] = wrapped.split(':');
  const decipher = createDecipheriv('aes-256-gcm', fixtureKek(), Buffer.from(nonce, 'base64'));
  decipher.setAAD(Buffer.from(JSON.stringify(['oshal:qualified-connector', 1, 'dek', who.principalIssuer, who.sub])));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(bytes, 'base64')), decipher.final()]);
}

describe('qualified token primitives: real crypto with named SQL doubles', () => {
  it('round-trips UTF-8, wraps one random 32-byte DEK and uses fresh token nonces', async () => {
    const db = sqlDouble();
    const one = await encrypt(db, A, TOKEN), two = await encrypt(db, A, TOKEN);
    expect(one).toMatch(/^qct1:/); expect(one).not.toBe(two);
    expect(db.rows.get(key(A))).toMatch(/^qdk1:/);
    expect(Buffer.from(db.rows.get(key(A))!.split(':')[3], 'base64')).toHaveLength(32);
    expect(await decrypt(db, A, one)).toBe(TOKEN); expect(await decrypt(db, A, two)).toBe(TOKEN);
    expect(writes(db)).toHaveLength(1);
    expect(db.query.mock.calls.every(([, params]) => params?.[0] === A.sub && params?.[1] === A.principalIssuer)).toBe(true);
  });

  it('stores distinct actual 32-byte DEKs for same-sub issuers, not one shared key with random wrappers', async () => {
    const db = sqlDouble();
    await encrypt(db, A, TOKEN); await encrypt(db, B, TOKEN);
    const first = fixtureUnwrap(A, db.rows.get(key(A))!), second = fixtureUnwrap(B, db.rows.get(key(B))!);
    expect(first).toHaveLength(32); expect(second).toHaveLength(32); expect(first.equals(second)).toBe(false);
  });

  it('separates same-sub issuers and distinct subjects, including case/trailing-slash issuer spelling', async () => {
    const db = sqlDouble();
    const identities = [A, B, { ...A, sub: 'other-sub-sentinel' },
      { ...A, principalIssuer: A.principalIssuer + '/' }, { ...A, principalIssuer: 'https://ISSUER-a.example.com' }];
    const tokens = await Promise.all(identities.map(who => encrypt(db, who, TOKEN)));
    expect(db.rows.size).toBe(identities.length);
    expect(new Set(db.rows.values()).size).toBe(identities.length);
    for (let i = 0; i < identities.length; i++) {
      expect(await decrypt(db, identities[i], tokens[i])).toBe(TOKEN);
      await expect(decrypt(db, identities[(i + 1) % identities.length], tokens[i])).rejects.toThrow('decrypt failed');
    }
  });

  it('authenticates token identity even when two qualified principals deliberately have the same fixture DEK', async () => {
    const db = sqlDouble(), dek = randomBytes(32), kek = fixtureKek();
    for (const who of [A, B]) db.rows.set(key(who), fixtureEnvelope(who, 'dek', kek, dek));
    const blob = fixtureEnvelope(A, 'token', dek, Buffer.from(TOKEN));
    expect(await decrypt(db, A, blob)).toBe(TOKEN);
    await expect(decrypt(db, B, blob)).rejects.toThrow('decrypt failed');
    expect(writes(db)).toHaveLength(0);
  });

  it('rejects a copied other-issuer wrapper and never replaces it', async () => {
    const db = sqlDouble(), token = await encrypt(db, A, TOKEN);
    db.rows.set(key(B), db.rows.get(key(A))!); db.query.mockClear();
    await expect(encrypt(db, B, TOKEN)).rejects.toThrow('encrypt failed');
    await expect(decrypt(db, B, token)).rejects.toThrow('decrypt failed');
    expect(writes(db)).toHaveLength(0);
  });

  it('binds key-wrap purpose, not just prefix, even for a 32-byte ciphertext under the same fixture KEK', async () => {
    const db = sqlDouble(), forged = fixtureEnvelope(A, 'token', fixtureKek(), randomBytes(32));
    db.rows.set(key(A), forged.replace(/^qct1:/, 'qdk1:'));
    await expect(encrypt(db, A, TOKEN)).rejects.toThrow('encrypt failed');
    expect(writes(db)).toHaveLength(0);
  });

  it('re-reads the insertion winner during concurrent first encryption', async () => {
    const db = sqlDouble();
    const tokens = await Promise.all([encrypt(db, A, 'first-sentinel'), encrypt(db, A, 'second-sentinel')]);
    expect(db.rows.size).toBe(1); expect(writes(db)).toHaveLength(2);
    expect(await decrypt(db, A, tokens[0])).toBe('first-sentinel');
    expect(await decrypt(db, A, tokens[1])).toBe('second-sentinel');
  });

  it('snapshots identity before a query wait; a mutable caller object cannot retarget insertion/AAD', async () => {
    const db = sqlDouble(), who = { ...A };
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      who.principalIssuer = B.principalIssuer;
      return db.query(sql, values);
    });
    const blob = await encrypt({ query }, who, TOKEN);
    expect(db.rows.has(key(A))).toBe(true); expect(db.rows.has(key(B))).toBe(false);
    expect(await decrypt(db, A, blob)).toBe(TOKEN);
  });

  it.each([undefined, '', ' ', '\n'])('refuses unavailable deployment key %j before any SQL, regardless of legacy downgrade flags', async value => {
    const db = sqlDouble(), blob = await encrypt(db, A, TOKEN); db.query.mockClear();
    vi.stubEnv('SESSION_SECRET', value);
    vi.stubEnv('OSHAL_ENVELOPE_CRYPTO', 'false');
    vi.stubEnv('OSHAL_ENVELOPE_DEK_FAILURE', 'shared-hkdf');
    await expect(encrypt(db, A, TOKEN)).rejects.toThrow('encrypt failed');
    await expect(decrypt(db, A, blob)).rejects.toThrow('decrypt failed');
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each([
    { ...A, sub: '' }, { ...A, principalIssuer: '' }, { ...A, sub: ' spaced' },
    { ...A, principalIssuer: A.principalIssuer + ' ' }, { ...A, sub: 'x\u0000y' },
    { ...A, principalIssuer: 'x\ny' }, { ...A, sub: '\ud800' },
    { ...A, sub: 'x'.repeat(1025) }, { ...A, principalIssuer: 'x'.repeat(2049) },
  ])('rejects malformed identity before SQL without normalization: %j', async principal => {
    const db = sqlDouble();
    await expect(encrypt(db, principal, TOKEN)).rejects.toThrow('encrypt failed');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('refuses missing principal fields at the JavaScript boundary', async () => {
    const db = sqlDouble();
    for (const who of [null, undefined, {}, { sub: A.sub }]) {
      await expect(encrypt(db, who as QualifiedConnectorPrincipal, TOKEN)).rejects.toThrow('encrypt failed');
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  it('never creates a missing DEK on decryption', async () => {
    const db = sqlDouble(), source = sqlDouble(), blob = await encrypt(source, A, TOKEN);
    await expect(decrypt(db, A, blob)).rejects.toThrow('decrypt failed');
    expect(db.query).toHaveBeenCalledOnce(); expect(writes(db)).toHaveLength(0); expect(db.rows.size).toBe(0);
  });

  it('refuses a changed wrapping secret and leaves the stored key intact', async () => {
    const db = sqlDouble(), blob = await encrypt(db, A, TOKEN), before = db.rows.get(key(A));
    db.query.mockClear(); vi.stubEnv('SESSION_SECRET', 'different-test-secret-sentinel');
    await expect(decrypt(db, A, blob)).rejects.toThrow('decrypt failed');
    await expect(encrypt(db, A, TOKEN)).rejects.toThrow('encrypt failed');
    expect(db.rows.get(key(A))).toBe(before); expect(writes(db)).toHaveLength(0);
  });

  it.each(['select', 'insert', 'reread'])('denies %s storage failure without fallback or sensitive error disclosure', async phase => {
    const db = sqlDouble(); let reads = 0;
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('SELECT')) reads++;
      if ((phase === 'select' && reads === 1) || (phase === 'insert' && sql.startsWith('INSERT')) || (phase === 'reread' && reads === 2)) {
        throw new Error('sensitive-db-detail-' + TOKEN);
      }
      return db.query(sql, params);
    });
    vi.stubEnv('OSHAL_ENVELOPE_DEK_FAILURE', 'shared-hkdf');
    await expect(encrypt({ query }, A, TOKEN)).rejects.toThrow(/^qualified connector token encrypt failed$/);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(TOKEN);
    expect(logger.error.mock.calls[0][0].err.message).not.toContain('sensitive-db-detail');
    expect(logger.error.mock.calls[0][0].err.cause).toBeUndefined();
  });

  it('denies an unreadable insert winner instead of using its local candidate', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(encrypt({ query }, A, TOKEN)).rejects.toThrow('encrypt failed');
    expect(query).toHaveBeenCalledTimes(3);
  });

  it.each(['legacy:iv:cipher', 'k2:iv:tag:cipher', 'v2:iv:tag:cipher', 'qct2:iv:tag:cipher', 'QCT1:iv:tag:cipher'])(
    'refuses unsupported format %s without querying keys', async blob => {
      const db = sqlDouble();
      await expect(decrypt(db, A, blob)).rejects.toThrow('decrypt failed');
      expect(db.query).not.toHaveBeenCalled();
    });

  it.each(['nonce', 'tag', 'cipher', 'extra', 'base64', 'truncated', 'oversize'])('refuses %s envelope tampering', async mode => {
    const db = sqlDouble(), blob = await encrypt(db, A, TOKEN), parts = blob.split(':');
    if (['nonce', 'tag', 'cipher'].includes(mode)) {
      const index = { nonce: 1, tag: 2, cipher: 3 }[mode as 'nonce' | 'tag' | 'cipher'];
      const bytes = Buffer.from(parts[index], 'base64'); bytes[0] ^= 1; parts[index] = bytes.toString('base64');
    }
    if (mode === 'extra') parts.push('AAAA');
    if (mode === 'base64') parts[1] = '!' + parts[1].slice(1);
    if (mode === 'truncated') parts[2] = Buffer.alloc(15).toString('base64');
    if (mode === 'oversize') parts[3] = 'A'.repeat(88_000);
    db.query.mockClear();
    await expect(decrypt(db, A, parts.join(':'))).rejects.toThrow('decrypt failed');
    expect(writes(db)).toHaveLength(0);
  });

  it.each(['hkdf1:legacy-wrap', 'qdk1:bad', ''])('does not repair corrupt/legacy wrapper %j', async wrapped => {
    const db = sqlDouble(); db.rows.set(key(A), wrapped);
    await expect(encrypt(db, A, TOKEN)).rejects.toThrow('encrypt failed');
    expect(writes(db)).toHaveLength(0); expect(db.rows.get(key(A))).toBe(wrapped);
  });

  it('bounds token bytes and rejects empty or invalid UTF-8 input before minting', async () => {
    const db = sqlDouble();
    for (const value of ['', 'x'.repeat(65_537), '\ud800']) await expect(encrypt(db, A, value)).rejects.toThrow('encrypt failed');
    expect(db.query).not.toHaveBeenCalled();
    const value = 'x'.repeat(65_536); expect(await decrypt(db, A, await encrypt(db, A, value))).toBe(value);
  });
});

describe('qualified migration source guards (not database execution)', () => {
  it('is additive with forced exact-owner policies and no operator/legacy adoption branch', () => {
    const sql = readFileSync(resolve(__dirname, '../../scripts/migrations/181-qualified-connector-credentials.sql'), 'utf8');
    for (const table of ['oshal_qualified_deks', 'oshal_qualified_connections']) {
      expect(sql).toContain('ALTER TABLE ' + table + ' ENABLE ROW LEVEL SECURITY');
      expect(sql).toContain('ALTER TABLE ' + table + ' FORCE ROW LEVEL SECURITY');
    }
    expect(sql).toContain('PRIMARY KEY (principal_issuer, owner_sub)');
    expect(sql).toContain('UNIQUE (principal_issuer, owner_sub, provider, account_key)');
    expect(sql).toContain("principal_issuer = current_setting('oshal.current_issuer', true)");
    expect(sql).not.toMatch(/\boshal_(?:connections|user_deks|tenant_memberships)\b|oshal\.is_operator|SECURITY DEFINER/i);
    expect(sql).toContain('NEW.revision := OLD.revision + 1');
  });
});
