import { describe, it, expect } from 'vitest';
import { scanText, redactEgress, dlpMode } from './redactor';

const OFF = {} as unknown as NodeJS.ProcessEnv;
const MASK = { OSHAL_DLP_MODE: 'mask' } as unknown as NodeJS.ProcessEnv;
const BLOCK = { OSHAL_DLP_MODE: 'block' } as unknown as NodeJS.ProcessEnv;

describe('dlpMode — env gate', () => {
  it('defaults to off', () => expect(dlpMode(OFF)).toBe('off'));
  it('reads mask/block', () => {
    expect(dlpMode(MASK)).toBe('mask');
    expect(dlpMode(BLOCK)).toBe('block');
  });
  it('treats junk as off', () => expect(dlpMode({ OSHAL_DLP_MODE: 'yes' } as never)).toBe('off'));
});

describe('scanText — detectors', () => {
  it('finds emails', () => {
    const f = scanText('reach me at jane.doe@example.com please');
    expect(f.map((x) => x.kind)).toContain('email');
  });
  it('finds an AWS access key id', () => {
    expect(scanText('key AKIAIOSFODNN7EXAMPLE here').some((f) => f.kind === 'aws_access_key')).toBe(true);
  });
  it('finds a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(scanText('token ' + jwt).some((f) => f.kind === 'jwt')).toBe(true);
  });
  it('finds a private key block', () => {
    const pk = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----';
    expect(scanText(pk).some((f) => f.kind === 'private_key')).toBe(true);
  });
  it('finds an SSN', () => {
    expect(scanText('ssn 123-45-6789').some((f) => f.kind === 'ssn')).toBe(true);
  });
  it('Luhn-validates credit cards (accepts valid, rejects invalid)', () => {
    expect(scanText('card 4242 4242 4242 4242').some((f) => f.kind === 'credit_card')).toBe(true);
    expect(scanText('num 1234 5678 9012 3456').some((f) => f.kind === 'credit_card')).toBe(false);
  });
  it('returns [] for clean text', () => {
    expect(scanText('the quick brown fox jumps over the lazy dog')).toEqual([]);
  });
});

describe('redactEgress — mode behavior', () => {
  it('off mode passes text through unchanged', () => {
    const r = redactEgress('email me at a@b.com', OFF);
    expect(r.redacted).toBe('email me at a@b.com');
    expect(r.blocked).toBe(false);
    expect(r.findings).toEqual([]);
  });

  it('mask mode replaces sensitive spans with typed placeholders', () => {
    const r = redactEgress('contact a@b.com or AKIAIOSFODNN7EXAMPLE', MASK);
    expect(r.redacted).toContain('[REDACTED:email]');
    expect(r.redacted).toContain('[REDACTED:aws_access_key]');
    expect(r.redacted).not.toContain('a@b.com');
    expect(r.blocked).toBe(false);
  });

  it('mask mode keeps non-sensitive text intact and indices correct for multiple findings', () => {
    const r = redactEgress('x a@b.com y c@d.com z', MASK);
    expect(r.redacted).toBe('x [REDACTED:email] y [REDACTED:email] z');
    expect(r.findings).toHaveLength(2);
  });

  it('block mode flags blocked when any finding exists', () => {
    const r = redactEgress('ssn 123-45-6789', BLOCK);
    expect(r.blocked).toBe(true);
    expect(r.redacted).toContain('[REDACTED:ssn]');
  });

  it('block mode does not block clean text', () => {
    const r = redactEgress('nothing sensitive here', BLOCK);
    expect(r.blocked).toBe(false);
    expect(r.redacted).toBe('nothing sensitive here');
  });
});
