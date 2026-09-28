/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L3: the step-up proof store on a fixed clock. A challenge is usable only after a fresh authentication for the same subject AND issuer and the same method, and only for the operation and exact parameters it was opened for, once. An authentication (or the token carrying it) older than the challenge proves nothing, which is what stops an identity provider's silent session reuse or a login that happened before the page asked. Lifetimes, the per-person bound, the TOTP attempt limit, cancellation and the account-erasure hook (the registered location state eraser) are each pinned.
 */

import { describe, expect, it } from 'vitest';
import { eraseLocationData, type LocationPrincipal } from '@/features/location';
import {
  LocationStepUpStore, canonicalLocationJson, locationStepUpDigest, locationStepUpStore,
} from '@/app/location-step-up';

const ISSUER = 'https://login.oshal.example.com';
const ME: LocationPrincipal = { sub: 'person-a', principalIssuer: ISSUER };
const SAME_SUB_OTHER_ISSUER: LocationPrincipal = { sub: 'person-a', principalIssuer: 'https://other.oshal.example.com' };
const SOMEONE_ELSE: LocationPrincipal = { sub: 'person-b', principalIssuer: ISSUER };
const OPT_IN = { deviceId: null, precisionClass: 'block' };

function storeAt(start = 1_000_000) {
  const clock = { now: start };
  const store = new LocationStepUpStore({ now: () => clock.now, completeWithinMs: 60_000, useWithinMs: 30_000, skewMs: 2_000, maxOpenPerPrincipal: 3, maxTotpAttempts: 2 });
  return { clock, store };
}

describe('location step-up: proving', () => {
  it('a fresh OIDC authentication for the same account proves the challenge; the view never leaks the principal', () => {
    const { clock, store } = storeAt();
    const view = store.create(ME, 'opt-in', OPT_IN, 'oidc-max-age');
    expect(view).toEqual({ challengeId: view.challengeId, operation: 'opt-in', method: 'oidc-max-age', state: 'pending', expiresAt: expect.any(String) });
    expect(view.challengeId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    clock.now += 5_000;
    expect(store.prove(view.challengeId, { method: 'oidc-max-age', principal: ME, authTimeMs: clock.now - 1_000, issuedAtMs: clock.now })).toEqual({ ok: true });
    expect(store.view(view.challengeId, ME)?.state).toBe('proven');
  });

  it('an authentication older than the challenge (beyond the skew) proves nothing: silent session reuse', () => {
    const { clock, store } = storeAt();
    const view = store.create(ME, 'opt-in', OPT_IN, 'oidc-max-age');
    clock.now += 5_000;
    expect(store.prove(view.challengeId, { method: 'oidc-max-age', principal: ME, authTimeMs: 1_000_000 - 2_001, issuedAtMs: clock.now }))
      .toEqual({ ok: false, reason: 'stale-authentication' });
    expect(store.prove(view.challengeId, { method: 'oidc-max-age', principal: ME, authTimeMs: clock.now, issuedAtMs: 1_000_000 - 60_000 }))
      .toEqual({ ok: false, reason: 'stale-authentication' });
    expect(store.prove(view.challengeId, { method: 'oidc-max-age', principal: ME, authTimeMs: Number.NaN }))
      .toEqual({ ok: false, reason: 'stale-authentication' });
    expect(store.view(view.challengeId, ME)?.state).toBe('pending');
  });

  it('another account, the same subject under another issuer, or another method cannot prove it', () => {
    const { clock, store } = storeAt();
    const view = store.create(ME, 'opt-in', OPT_IN, 'oidc-max-age');
    for (const principal of [SOMEONE_ELSE, SAME_SUB_OTHER_ISSUER]) {
      expect(store.prove(view.challengeId, { method: 'oidc-max-age', principal, authTimeMs: clock.now })).toEqual({ ok: false, reason: 'different-account' });
    }
    expect(store.prove(view.challengeId, { method: 'mock-oidc', principal: ME, authTimeMs: clock.now })).toEqual({ ok: false, reason: 'method-mismatch' });
    expect(store.prove('no-such-challenge', { method: 'oidc-max-age', principal: ME, authTimeMs: clock.now })).toEqual({ ok: false, reason: 'unknown' });
  });

  it('a challenge not proven in time expires', () => {
    const { clock, store } = storeAt();
    const view = store.create(ME, 'opt-in', OPT_IN, 'mock-oidc');
    clock.now += 60_001;
    expect(store.view(view.challengeId, ME)?.state).toBe('expired');
    expect(store.prove(view.challengeId, { method: 'mock-oidc', principal: ME, authTimeMs: clock.now })).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('location step-up: spending', () => {
  it('is single use, for exactly the operation and parameters it was opened for', () => {
    const { clock, store } = storeAt();
    const view = store.create(ME, 'opt-in', { precisionClass: 'block', deviceId: null }, 'mock-oidc');
    expect(store.consume(view.challengeId, ME, 'opt-in', OPT_IN)).toEqual({ ok: false, reason: 'not-proven' });
    store.prove(view.challengeId, { method: 'mock-oidc', principal: ME, authTimeMs: clock.now });
    expect(store.consume(view.challengeId, ME, 'raise-precision', OPT_IN)).toEqual({ ok: false, reason: 'operation-mismatch' });
    expect(store.consume(view.challengeId, ME, 'opt-in', { deviceId: null, precisionClass: 'exact' })).toEqual({ ok: false, reason: 'params-mismatch' });
    expect(store.consume(view.challengeId, SOMEONE_ELSE, 'opt-in', OPT_IN)).toEqual({ ok: false, reason: 'unknown' });
    expect(store.consume(view.challengeId, SAME_SUB_OTHER_ISSUER, 'opt-in', OPT_IN)).toEqual({ ok: false, reason: 'unknown' });
    expect(store.consume(view.challengeId, ME, 'opt-in', OPT_IN)).toEqual({ ok: true });
    expect(store.consume(view.challengeId, ME, 'opt-in', OPT_IN)).toEqual({ ok: false, reason: 'already-used' });
  });

  it('a proven challenge left unused past its window cannot be spent', () => {
    const { clock, store } = storeAt();
    const view = store.create(ME, 'accept-share', { tenantId: 't', placeIds: ['a'] }, 'mock-oidc');
    store.prove(view.challengeId, { method: 'mock-oidc', principal: ME, authTimeMs: clock.now });
    clock.now += 30_001;
    expect(store.consume(view.challengeId, ME, 'accept-share', { tenantId: 't', placeIds: ['a'] })).toEqual({ ok: false, reason: 'expired' });
  });

  it('parameters digest canonically: key order never matters, array order does', () => {
    expect(canonicalLocationJson({ b: 1, a: { d: [2, 1], c: undefined } })).toBe('{"a":{"d":[2,1]},"b":1}');
    expect(locationStepUpDigest('opt-in', { a: 1, b: 2 })).toBe(locationStepUpDigest('opt-in', { b: 2, a: 1 }));
    expect(locationStepUpDigest('opt-in', { a: [1, 2] })).not.toBe(locationStepUpDigest('opt-in', { a: [2, 1] }));
    expect(locationStepUpDigest('opt-in', OPT_IN)).not.toBe(locationStepUpDigest('arm-rule', OPT_IN));
  });
});

describe('location step-up: bounds and erasure', () => {
  it('holds a bounded number of open challenges per person, dropping the oldest', () => {
    const { store } = storeAt();
    const first = store.create(ME, 'opt-in', OPT_IN, 'mock-oidc');
    for (let i = 0; i < 3; i += 1) store.create(ME, 'opt-in', OPT_IN, 'mock-oidc');
    store.create(SOMEONE_ELSE, 'opt-in', OPT_IN, 'mock-oidc');
    expect(store.view(first.challengeId, ME)).toBeNull();
    expect(store.size()).toBe(4);
  });

  it('a TOTP challenge dies after the allowed attempts', () => {
    const { store } = storeAt();
    const view = store.create(ME, 'opt-in', OPT_IN, 'local-totp');
    expect(store.noteAttempt(view.challengeId, ME)).toEqual({ ok: true });
    expect(store.noteAttempt(view.challengeId, ME)).toEqual({ ok: true });
    expect(store.noteAttempt(view.challengeId, ME)).toEqual({ ok: false, reason: 'too-many-attempts' });
    expect(store.view(view.challengeId, ME)).toBeNull();
  });

  it('cancel and clearPrincipal remove only the person\'s own challenges', () => {
    const { store } = storeAt();
    const mine = store.create(ME, 'opt-in', OPT_IN, 'mock-oidc');
    const theirs = store.create(SOMEONE_ELSE, 'opt-in', OPT_IN, 'mock-oidc');
    expect(store.cancel(theirs.challengeId, ME)).toBe(false);
    expect(store.clearPrincipal(SAME_SUB_OTHER_ISSUER)).toBe(0);
    expect(store.clearPrincipal(ME)).toBe(1);
    expect(store.view(mine.challengeId, ME)).toBeNull();
    expect(store.view(theirs.challengeId, SOMEONE_ELSE)).not.toBeNull();
  });

  it('the account erasure clears the process store through its registered state eraser', async () => {
    const view = locationStepUpStore.create(ME, 'opt-in', OPT_IN, 'mock-oidc');
    const client = { query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined };
    const result = await eraseLocationData({ connect: async () => client } as never, ME);
    expect(result.stateErasersFailed).toEqual([]);
    expect(result.stateErasersRun).toBeGreaterThanOrEqual(1);
    expect(locationStepUpStore.view(view.challengeId, ME)).toBeNull();
  });
});
