/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for HOST_APP_MAP: an unset map or an unmatched hostname must fall through unchanged, a matched hostname must land on that app, matching is case-insensitive, and whitespace around entries doesn't break the split.
 */

import { describe, it, expect } from 'vitest';

import { resolveHostLandingPath } from '@/app/host-app-map';

describe('resolveHostLandingPath', () => {
  it('falls back when HOST_APP_MAP is unset', () => {
    expect(resolveHostLandingPath(undefined, 'dnd.oshal.ai', '/cockpit/')).toBe('/cockpit/');
  });

  it('falls back when the hostname has no entry in the map', () => {
    expect(resolveHostLandingPath('dnd.oshal.ai=dnd', 'oshal.ai', '/cockpit/')).toBe('/cockpit/');
  });

  it('falls back when hostname is missing', () => {
    expect(resolveHostLandingPath('dnd.oshal.ai=dnd', undefined, '/cockpit/')).toBe('/cockpit/');
  });

  it('resolves a matching host to its app landing path', () => {
    const map = 'dnd.oshal.ai=dnd,trading.oshal.ai=intelligent-trades';
    expect(resolveHostLandingPath(map, 'dnd.oshal.ai', '/cockpit/')).toBe('/cockpit/?app=dnd');
    expect(resolveHostLandingPath(map, 'trading.oshal.ai', '/cockpit/')).toBe('/cockpit/?app=intelligent-trades');
  });

  it('matches hostnames case-insensitively', () => {
    expect(resolveHostLandingPath('DND.OSHAL.AI=dnd', 'dnd.oshal.ai', '/cockpit/')).toBe('/cockpit/?app=dnd');
  });

  it('tolerates whitespace around entries and around the = separator', () => {
    const map = ' dnd.oshal.ai = dnd , trading.oshal.ai = intelligent-trades ';
    expect(resolveHostLandingPath(map, 'trading.oshal.ai', '/cockpit/')).toBe('/cockpit/?app=intelligent-trades');
  });

  it('never falls through to an unrelated app when the map is malformed', () => {
    expect(resolveHostLandingPath('dnd.oshal.ai=,=,trading.oshal.ai', 'dnd.oshal.ai', '/cockpit/')).toBe('/cockpit/');
  });
});
