/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pins the OAuth return-path guard added when the free lanes became first-class cards on /utilities: the ?return= value feeds res.redirect, so it must be an ALLOWLIST (unknown/absolute/protocol-relative/query-bearing values collapse to the default) and never an open redirect.
 */

import { describe, expect, it } from 'vitest';
import { safeReturnPath } from '../../src/app/routes/free-tier-routes';

describe('free-tier OAuth return path (open-redirect guard)', () => {
  it('allows the two surfaces that render the free-lane cards', () => {
    expect(safeReturnPath('/utilities')).toBe('/utilities');
    expect(safeReturnPath('/free-models')).toBe('/free-models');
  });

  it('defaults to /free-models when absent or empty', () => {
    expect(safeReturnPath(undefined)).toBe('/free-models');
    expect(safeReturnPath('')).toBe('/free-models');
    expect(safeReturnPath('   ')).toBe('/free-models');
  });

  it('refuses off-site redirects', () => {
    for (const evil of [
      'https://evil.com',
      'http://evil.com/utilities',
      '//evil.com',
      '//evil.com/utilities',
      'javascript:alert(1)',
      '/\\evil.com',
    ]) {
      expect(safeReturnPath(evil)).toBe('/free-models');
    }
  });

  it('refuses lookalikes and decorated variants of an allowed path', () => {
    for (const sneaky of [
      '/utilities.evil.com',
      '/utilities/../admin',
      '/utilities?x=1',
      '/utilities#frag',
      '/Utilities',
      '/utilities/',
      'utilities',
    ]) {
      expect(safeReturnPath(sneaky)).toBe('/free-models');
    }
  });

  it('refuses non-string input', () => {
    expect(safeReturnPath(null)).toBe('/free-models');
    expect(safeReturnPath(42)).toBe('/free-models');
    expect(safeReturnPath(['/utilities'])).toBe('/free-models');
    expect(safeReturnPath({ toString: () => '/utilities' })).toBe('/free-models');
  });
});
