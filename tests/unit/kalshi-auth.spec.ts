/**
 * Kalshi auth — PEM normalization + request signing (ADR-094).
 *
 * Regression coverage for the 2026-07-13 incident: a user's paste came from a temporarily
 * line-commented `.env` (every line prefixed `#`, an artifact of unblocking Docker Compose's
 * .env parser), which corrupted the reconstructed PEM and surfaced as "token rejected by
 * provider" with no useful detail. normalizePem must tolerate this specific artifact.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — normalizePem: newline-collapsed paste, line-commented paste (the incident), a real key round-trips through crypto.sign; signKalshiRequest message construction; parseKalshiSecret split-on-first-colon.
 */

import { describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import { normalizePem, parseKalshiSecret, signKalshiRequest } from '../../src/features/prediction-markets/services/kalshi-auth';

function generateTestKeyPem(): string {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return privateKey as unknown as string;
}

describe('normalizePem', () => {
  it('passes a well-formed PEM through unchanged in substance', () => {
    const pem = generateTestKeyPem();
    const normalized = normalizePem(pem);
    expect(normalized).toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(normalized).toContain('-----END RSA PRIVATE KEY-----');
    expect(() => crypto.sign('sha256', Buffer.from('x'), {
      key: normalized, padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    })).not.toThrow();
  });

  it('reconstructs a PEM whose newlines were collapsed by a single-line input field', () => {
    const pem = generateTestKeyPem();
    const collapsed = pem.replace(/\r?\n/g, '');
    const normalized = normalizePem(collapsed);
    expect(() => crypto.sign('sha256', Buffer.from('x'), {
      key: normalized, padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    })).not.toThrow();
  });

  it('strips a leading # from every line — the line-commented-.env incident', () => {
    const pem = generateTestKeyPem();
    const commented = pem.split('\n').map((line) => (line ? `#${line}` : line)).join('\n');
    const normalized = normalizePem(commented);
    expect(normalized).not.toContain('#');
    expect(() => crypto.sign('sha256', Buffer.from('x'), {
      key: normalized, padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    })).not.toThrow();
  });

  it('throws a clear error when BEGIN/END markers are entirely missing (e.g. truncated to one line)', () => {
    expect(() => normalizePem('-----BEGIN RSA PRIVATE KEY-----')).toThrow(/missing BEGIN\/END markers/);
  });

  it('accepts PKCS#8 (\'PRIVATE KEY\') as well as PKCS#1', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const normalized = normalizePem(privateKey as unknown as string);
    expect(normalized).toContain('-----BEGIN PRIVATE KEY-----');
  });
});

describe('parseKalshiSecret', () => {
  it('splits keyId:PEM on the first colon (PEM itself never contains a colon)', () => {
    const pem = generateTestKeyPem();
    const { keyId, privateKeyPem } = parseKalshiSecret(`abc-123:${pem}`);
    expect(keyId).toBe('abc-123');
    expect(privateKeyPem).toContain('-----BEGIN RSA PRIVATE KEY-----');
  });

  it('rejects a secret with no colon', () => {
    expect(() => parseKalshiSecret('not-a-valid-secret')).toThrow(/keyId:privateKeyPem/);
  });
});

describe('signKalshiRequest', () => {
  it('signs the exact ts+METHOD+path string, dropping the query string', () => {
    const pem = generateTestKeyPem();
    const sig = signKalshiRequest(pem, '1700000000000', 'GET', '/trade-api/v2/portfolio/balance?foo=bar');
    // A valid base64 signature the corresponding public key can verify against the query-stripped message.
    const pub = crypto.createPublicKey(pem);
    const verified = crypto.verify('sha256', Buffer.from('1700000000000GET/trade-api/v2/portfolio/balance', 'utf8'),
      { key: pub, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST },
      Buffer.from(sig, 'base64'));
    expect(verified).toBe(true);
  });
});
