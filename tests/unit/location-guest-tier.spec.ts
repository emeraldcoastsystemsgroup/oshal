/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 D3/L2: /api/location is guest Tier C. A guest gets guest_blocked on every location route and every method, GET included, because each one is a person's position, places or consent; the neighbouring Tier-B default (GET allowed) is unchanged for other segments.
 */

import { describe, expect, it } from 'vitest';
import { GUEST_TIER_C_APPS, guestDecision } from '@/shared/middleware/guest-capability-matrix';

describe('ADR-169: location is guest Tier C', () => {
  it('lists location among the Tier C segments', () => {
    expect(GUEST_TIER_C_APPS).toContain('location');
  });

  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])('blocks a guest %s on every location route', (method) => {
    for (const route of ['/api/location', '/api/location/presence', '/api/location/devices/abc/presence', '/api/location/places']) {
      expect(guestDecision(route, method), `${method} ${route}`).toBe('guest_blocked');
    }
  });

  it('leaves an unlisted segment at the Tier-B default', () => {
    expect(guestDecision('/api/locations-elsewhere', 'GET')).toBe('allow');
  });
});
