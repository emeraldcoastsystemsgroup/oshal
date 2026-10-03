/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Add fail-closed exact-principal envelope primitives for fresh qualified connector grants, independent of every legacy token/DEK format and broker.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { createChildLogger } from '@/shared/logger';

const log = createChildLogger({ module: 'connector-qualified-token-crypto' });

/** @description Exact verified identity. Authentication belongs to the caller; no field is normalized. */
export interface QualifiedConnectorPrincipal {
  readonly sub: string;
  readonly principalIssuer: string;
}

/** @description Already identity-bound query port. The caller owns transaction/session lifetime. */
export interface QualifiedConnectorQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** @description Only accepted token envelope; legacy and shared-key formats are never read. */
export const QUALIFIED_CONNECTOR_TOKEN_PREFIX = 'qct1:';
/** @description Only accepted DEK wrapper, distinct from the legacy connector key namespace. */
export const QUALIFIED_CONNECTOR_DEK_PREFIX = 'qdk1:';

const MAX_TOKEN_BYTES = 65_536;
const KEK_SALT = Buffer.from('oshal:qualified-connector:kek:salt:v1');
const KEK_INFO = Buffer.from('oshal:qualified-connector:kek:wrap:v1');
const SELECT_DEK = 'SELECT wrapped_dek FROM oshal_qualified_deks WHERE owner_sub = $1 AND principal_issuer = $2';
const INSERT_DEK = 'INSERT INTO oshal_qualified_deks (owner_sub, principal_issuer, wrapped_dek) '
  + 'VALUES ($1, $2, $3) ON CONFLICT (principal_issuer, owner_sub) DO NOTHING';

/** Reject ambiguous/ill-formed text rather than trimming, lowercasing or canonicalizing it. */
function exactText(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || !value.length || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value, 'utf8') > maxBytes
    || Buffer.from(value, 'utf8').toString('utf8') !== value) throw new Error('invalid qualified principal');
  return value;
}

/** Snapshot the identity before the first await so a mutable caller object cannot retarget a key. */
function exactPrincipal(principal: QualifiedConnectorPrincipal): QualifiedConnectorPrincipal {
  return { sub: exactText(principal?.sub, 1024), principalIssuer: exactText(principal?.principalIssuer, 2048) };
}

/** Require the deployment key even on read; no development key, envelope flag or availability downgrade. */
function wrappingKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !secret.trim()) throw new Error('qualified connector key unavailable');
  const input = Buffer.from(secret, 'utf8');
  try { return Buffer.from(hkdfSync('sha256', input, KEK_SALT, KEK_INFO, 32)); }
  finally { input.fill(0); }
}

/** Length-delimited JSON binds purpose/version and the exact identity, including issuer spelling. */
function aad(principal: QualifiedConnectorPrincipal, purpose: 'token' | 'dek'): Buffer {
  return Buffer.from(JSON.stringify(['oshal:qualified-connector', 1, purpose, principal.principalIssuer, principal.sub]), 'utf8');
}

/** Authenticated encryption uses a fresh nonce on every token and DEK wrap. */
function seal(key: Buffer, bytes: Buffer, associated: Buffer, prefix: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(associated);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return prefix + [nonce, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64')).join(':');
}

/** Buffer's permissive base64 decoder is not a wire-format validator. */
function decodePart(text: string, min: number, max: number): Buffer {
  if (text.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(text)) {
    throw new Error('invalid qualified envelope');
  }
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length < min || bytes.length > max || bytes.toString('base64') !== text) throw new Error('invalid qualified envelope');
  return bytes;
}

/** Parse only this namespace/version, with fixed nonce/tag and bounded ciphertext lengths. */
function open(key: Buffer, blob: string, associated: Buffer, prefix: string, min: number, max: number): Buffer {
  if (typeof blob !== 'string' || blob.length > 87_500 || !blob.startsWith(prefix)) throw new Error('invalid qualified envelope');
  const parts = blob.slice(prefix.length).split(':');
  if (parts.length !== 3) throw new Error('invalid qualified envelope');
  const nonce = decodePart(parts[0], 12, 12), tag = decodePart(parts[1], 16, 16);
  const ciphertext = decodePart(parts[2], min, max);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  decipher.setAAD(associated); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Read exactly the requested principal; never recover an invisible/missing key from another store. */
async function readDek(db: QualifiedConnectorQueryable, who: QualifiedConnectorPrincipal): Promise<string | undefined> {
  const result = await db.query(SELECT_DEK, [who.sub, who.principalIssuer]);
  if (result.rows.length > 1) throw new Error('ambiguous qualified key');
  if (!result.rows.length) return undefined;
  if (typeof result.rows[0].wrapped_dek !== 'string') throw new Error('invalid qualified key');
  return result.rows[0].wrapped_dek;
}

/** On first encryption, use INSERT DO NOTHING then re-read the winning DEK under the same bound port. */
async function principalDek(
  db: QualifiedConnectorQueryable, who: QualifiedConnectorPrincipal, kek: Buffer, create: boolean,
): Promise<Buffer> {
  let wrapped = await readDek(db, who);
  if (wrapped === undefined && create) {
    const candidate = randomBytes(32);
    try {
      await db.query(INSERT_DEK, [who.sub, who.principalIssuer,
        seal(kek, candidate, aad(who, 'dek'), QUALIFIED_CONNECTOR_DEK_PREFIX)]);
    } finally { candidate.fill(0); }
    wrapped = await readDek(db, who);
  }
  if (wrapped === undefined) throw new Error('qualified key unavailable');
  return open(kek, wrapped, aad(who, 'dek'), QUALIFIED_CONNECTOR_DEK_PREFIX, 32, 32);
}

/** Never attach raw DB/crypto errors: a query adapter can embed bound ciphertext or secrets in them. */
function denied(op: 'encrypt' | 'decrypt', started: number): Error {
  const error = new Error('qualified connector token ' + op + ' failed');
  log.error({ op, durationMs: Date.now() - started, err: error }, 'qualified connector crypto refused');
  return error;
}

/**
 * @description Encrypt one fresh token under the exact principal's independent random DEK.
 * No connection row, identity stamp, transaction, provider request or legacy credential is touched.
 * @param db Already-bound query port; same verified issuer/sub on every query.
 * @param principal Verified exact principal, never an identity inferred from a stored legacy row.
 * @param plaintext Nonempty UTF-8 token, at most 65536 bytes.
 * @returns A qct1 envelope. Errors expose no underlying token, principal, SQL or database message.
 */
export async function encryptQualifiedConnectorToken(
  db: QualifiedConnectorQueryable, principal: QualifiedConnectorPrincipal, plaintext: string,
): Promise<string> {
  const started = Date.now();
  let kek: Buffer | undefined, dek: Buffer | undefined, bytes: Buffer | undefined;
  log.debug({ op: 'encrypt' }, 'qualified connector crypto started');
  try {
    const who = exactPrincipal(principal);
    if (typeof plaintext !== 'string' || !plaintext.length || Buffer.byteLength(plaintext, 'utf8') > MAX_TOKEN_BYTES) {
      throw new Error('invalid qualified plaintext');
    }
    bytes = Buffer.from(plaintext, 'utf8');
    if (bytes.toString('utf8') !== plaintext) throw new Error('invalid qualified plaintext');
    kek = wrappingKey();
    dek = await principalDek(db, who, kek, true);
    const result = seal(dek, bytes, aad(who, 'token'), QUALIFIED_CONNECTOR_TOKEN_PREFIX);
    log.debug({ op: 'encrypt', durationMs: Date.now() - started }, 'qualified connector crypto completed');
    return result;
  } catch { throw denied('encrypt', started); }
  finally { kek?.fill(0); dek?.fill(0); bytes?.fill(0); }
}

/**
 * @description Decrypt only qct1 using an existing qualified DEK; never mint or repair keys on read.
 * @param db Already-bound query port, under the exact verified principal.
 * @param principal Exact authenticated principal; token and key-wrap AAD independently bind it.
 * @param ciphertext Qualified envelope; legacy/shared versions and malformed encodings are refused.
 * @returns Plaintext for an authorized controller boundary, never a model/log/browser payload.
 */
export async function decryptQualifiedConnectorToken(
  db: QualifiedConnectorQueryable, principal: QualifiedConnectorPrincipal, ciphertext: string,
): Promise<string> {
  const started = Date.now();
  let kek: Buffer | undefined, dek: Buffer | undefined, bytes: Buffer | undefined;
  log.debug({ op: 'decrypt' }, 'qualified connector crypto started');
  try {
    const who = exactPrincipal(principal);
    if (typeof ciphertext !== 'string' || !ciphertext.startsWith(QUALIFIED_CONNECTOR_TOKEN_PREFIX)
      || ciphertext.length > 87_500) throw new Error('invalid qualified envelope');
    kek = wrappingKey();
    dek = await principalDek(db, who, kek, false);
    bytes = open(dek, ciphertext, aad(who, 'token'), QUALIFIED_CONNECTOR_TOKEN_PREFIX, 1, MAX_TOKEN_BYTES);
    const result = bytes.toString('utf8');
    if (!Buffer.from(result, 'utf8').equals(bytes)) throw new Error('invalid qualified plaintext');
    log.debug({ op: 'decrypt', durationMs: Date.now() - started }, 'qualified connector crypto completed');
    return result;
  } catch { throw denied('decrypt', started); }
  finally { kek?.fill(0); dek?.fill(0); bytes?.fill(0); }
}
