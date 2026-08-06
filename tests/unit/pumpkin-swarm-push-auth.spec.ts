/**
 * THE KERNEL TRUST SEAM THE PUMPKIN'S SWARM DOOR RESTS ON.
 *
 * `POST /api/pumpkin/speak` delivers to a physical screen and speaker in someone's yard WITHOUT the
 * room pairing token, because the token is minted inside register() and only ever handed back to the
 * registering browser — no bot can hold one. The only thing standing between an arbitrary caller and
 * that device is `hasValidServiceSecret()`. The pumpkin package lives in the store repo and cannot
 * import this TypeScript, so its own suite mirrors these semantics; this spec is what stops the real
 * seam drifting away from that mirror while both stay green.
 *
 * Every case sets and restores SWARM_SERVICE_SECRET itself. Nothing here is allowed to skip when an
 * env var is absent — a guard that skips is not a guard, and "unset" is one of the cases that matters
 * most (the bypass must not exist at all when the secret is not configured).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the service-secret seam and canonical encoded owner binding used by trusted swarm calls.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';

import {
  getTrustedServiceUserSub,
  hasValidServiceSecret,
  serviceSecretHeaders,
  trustedServiceUserHeaders,
} from '@/shared/middleware/authz';

const SECRET = 'pumpkin-guard-secret-abcdefghijklmnop';
const OWNER = 'google-oauth2|1234567890';

const req = (headers: Record<string, string>): Request => ({ headers } as unknown as Request);

describe('pumpkin swarm door: the service-secret seam', () => {
  let original: string | undefined;

  beforeEach(() => { original = process.env.SWARM_SERVICE_SECRET; process.env.SWARM_SERVICE_SECRET = SECRET; });
  afterEach(() => {
    if (original === undefined) delete process.env.SWARM_SERVICE_SECRET;
    else process.env.SWARM_SERVICE_SECRET = original;
  });

  it('accepts the matching secret and resolves the owner it is acting for', () => {
    const r = req({ 'x-service-secret': SECRET, 'x-oshal-user-sub': OWNER });
    expect(hasValidServiceSecret(r)).toBe(true);
    expect(getTrustedServiceUserSub(r)).toBe(OWNER);
  });

  it('refuses a wrong secret of the SAME length (the timing-safe compare must actually compare)', () => {
    const r = req({ 'x-service-secret': 'x'.repeat(SECRET.length), 'x-oshal-user-sub': OWNER });
    expect(hasValidServiceSecret(r)).toBe(false);
    expect(getTrustedServiceUserSub(r)).toBeNull();
  });

  it('refuses a length mismatch without throwing (timingSafeEqual throws on unequal buffers)', () => {
    for (const provided of ['', 'x', `${SECRET}x`, SECRET.slice(0, -1)]) {
      const r = req({ 'x-service-secret': provided, 'x-oshal-user-sub': OWNER });
      expect(() => hasValidServiceSecret(r)).not.toThrow();
      expect(hasValidServiceSecret(r)).toBe(false);
      expect(getTrustedServiceUserSub(r)).toBeNull();
    }
  });

  it('a bare X-OSHAL-User-Sub claims nothing without the secret', () => {
    // Otherwise any caller could name any owner and drive that person's projector.
    const r = req({ 'x-oshal-user-sub': OWNER });
    expect(hasValidServiceSecret(r)).toBe(false);
    expect(getTrustedServiceUserSub(r)).toBeNull();
  });

  it('a valid secret with no owner header resolves to null, never to a default', () => {
    expect(getTrustedServiceUserSub(req({ 'x-service-secret': SECRET }))).toBeNull();
    expect(getTrustedServiceUserSub(req({ 'x-service-secret': SECRET, 'x-oshal-user-sub': '   ' }))).toBeNull();
  });

  it('with SWARM_SERVICE_SECRET unset or blank the bypass does not exist at all', () => {
    for (const configured of [undefined, '', '   ']) {
      if (configured === undefined) delete process.env.SWARM_SERVICE_SECRET;
      else process.env.SWARM_SERVICE_SECRET = configured;

      // A perfectly well-formed pair — and it must still be refused. Fail-closed, never fail-open:
      // an empty configured secret matching an empty provided header would be a total bypass.
      const r = req({ 'x-service-secret': String(configured ?? ''), 'x-oshal-user-sub': OWNER });
      expect(hasValidServiceSecret(r)).toBe(false);
      expect(getTrustedServiceUserSub(r)).toBeNull();
      expect(serviceSecretHeaders()).toEqual({});
    }
  });

  it('an empty header set — an ordinary browser request — is never trusted', () => {
    expect(hasValidServiceSecret(req({}))).toBe(false);
    expect(getTrustedServiceUserSub(req({}))).toBeNull();
  });

  it('the outbound encoded headers the tool executor stamps are exactly what the door verifies', () => {
    // This is the round trip the pumpkin-speak tool actually performs: ToolExecutorService stamps
    // trustedServiceUserHeaders() and the pumpkin route verifies it. If these two ever disagree the tool
    // silently 403s and the operator is told the prop is broken.
    const stamped = trustedServiceUserHeaders(OWNER);
    expect(stamped['X-Service-Secret']).toBe(SECRET);
    const forwarded = Object.fromEntries(Object.entries(stamped).map(([k, v]) => [k.toLowerCase(), v]));
    expect(hasValidServiceSecret(req(forwarded))).toBe(true);
    expect(getTrustedServiceUserSub(req(forwarded))).toBe(OWNER);
  });
});
