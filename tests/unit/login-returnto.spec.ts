/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the login returnTo chain (operator report: a /cockpit/?app=intelligent-sales desktop shortcut double-logged-in and landed on the bare cockpit — the stock /login route dropped returnTo, and the callback-retry restart never carried one). Goes red if the sanitizer ever admits an off-origin/protocol-relative/control-char target (open redirect), rejects a legitimate ?app= deep link, or if the callback-state restart path stops carrying the interrupted login's destination.
 */

import { describe, expect, it } from 'vitest';
import { sanitizeLoginReturnTo, buildOidcLoginRestartPath } from '../../src/shared/middleware/oidc';

/** Encodes an express-openid-connect-shaped state payload (base64url JSON {returnTo}). */
function encodeState(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

describe('sanitizeLoginReturnTo', () => {
  it('admits same-origin relative paths, including ?app= deep links', () => {
    expect(sanitizeLoginReturnTo('/cockpit/?app=intelligent-sales')).toBe('/cockpit/?app=intelligent-sales');
    expect(sanitizeLoginReturnTo('/welcome?app=little-monsters')).toBe('/welcome?app=little-monsters');
    expect(sanitizeLoginReturnTo('/')).toBe('/');
  });

  it('rejects non-strings and empty/whitespace values', () => {
    expect(sanitizeLoginReturnTo(undefined)).toBeUndefined();
    expect(sanitizeLoginReturnTo(42)).toBeUndefined();
    expect(sanitizeLoginReturnTo(['/cockpit/'])).toBeUndefined();
    expect(sanitizeLoginReturnTo('')).toBeUndefined();
    expect(sanitizeLoginReturnTo('   ')).toBeUndefined();
  });

  it('rejects absolute and protocol-relative URLs (open-redirect gate)', () => {
    expect(sanitizeLoginReturnTo('https://evil.example/phish')).toBeUndefined();
    expect(sanitizeLoginReturnTo('http://evil.example')).toBeUndefined();
    expect(sanitizeLoginReturnTo('//evil.example/phish')).toBeUndefined();
    expect(sanitizeLoginReturnTo('/\\evil.example')).toBeUndefined();
    expect(sanitizeLoginReturnTo('javascript:alert(1)')).toBeUndefined();
  });

  it('rejects control characters and oversized values', () => {
    const withNewline = '/cockpit/' + String.fromCharCode(10) + 'Set-Cookie: x';
    const withNull = '/cockpit/' + String.fromCharCode(0);
    expect(sanitizeLoginReturnTo(withNewline)).toBeUndefined();
    expect(sanitizeLoginReturnTo(withNull)).toBeUndefined();
    expect(sanitizeLoginReturnTo('/' + 'a'.repeat(2100))).toBeUndefined();
  });
});

describe('buildOidcLoginRestartPath', () => {
  it('carries the interrupted login destination out of the callback state', () => {
    const state = encodeState({ returnTo: '/cockpit/?app=intelligent-sales' });
    expect(buildOidcLoginRestartPath(state)).toBe(
      `/login?returnTo=${encodeURIComponent('/cockpit/?app=intelligent-sales')}`,
    );
  });

  it('sanitizes an off-origin state returnTo down to a bare /login', () => {
    expect(buildOidcLoginRestartPath(encodeState({ returnTo: 'https://evil.example/' }))).toBe('/login');
    expect(buildOidcLoginRestartPath(encodeState({ returnTo: '//evil.example/' }))).toBe('/login');
  });

  it('falls back to a bare /login on missing or undecodable state', () => {
    expect(buildOidcLoginRestartPath(undefined)).toBe('/login');
    expect(buildOidcLoginRestartPath('')).toBe('/login');
    expect(buildOidcLoginRestartPath('not-base64url-json')).toBe('/login');
    expect(buildOidcLoginRestartPath(encodeState({ nope: true }))).toBe('/login');
  });
});
