/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bound connector consent to its initiating browser and identity across callback cookie domains.
 *
 * Ceremonies live in the controller process for at most ten minutes. A restart discards them,
 * so an interrupted consent must be started again. Multiple controllers need routing affinity
 * across all configured origins or a shared atomic ceremony store before using this flow.
 * No token is exchanged or persisted by the
 * public callback. Only authenticated completion on the original origin can redeem its code.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { ConnectorCaller } from './connector-response-helpers';
import { appUrl, signState, verifyState } from './connector-oauth-ceremony';

export const CONNECTOR_CEREMONY_TTL = 10 * 60 * 1000;

export interface ConnectorConsent {
  provider: string;
  caller: ConnectorCaller;
  origin: string;
  redirect: string;
  tenant?: string;
  label?: string;
  verifier?: string;
}

interface Ceremony extends ConnectorConsent {
  cookieName: string;
  cookieHash: Buffer;
  expiresAt: number;
  phase: 'authorize' | 'complete';
  code?: string;
  error?: string;
}

/** @description Resolve only an exact configured login origin; headers never add a trusted origin. */
export function connectorOrigin(req: Request): string | null {
  for (const value of [appUrl(), ...(process.env.OIDC_BASE_URLS || '').split(',')]) {
    try {
      const origin = new URL(value.trim());
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
      if (origin.username || origin.password || origin.search || origin.hash
          || (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:'))) continue;
      if (origin.host.toLowerCase() === (req.get('host') || '').toLowerCase()) return origin.origin;
    } catch { /* Ignore malformed deployment entries; never echo them into a redirect. */ }
  }
  return null;
}

/** @description Retrieve only a unique cookie; duplicate names are ambiguous and fail closed. */
function cookieValue(req: Request, name: string): string {
  const matches = (req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  if (matches.length !== 1) return '';
  try { return decodeURIComponent(matches[0].slice(name.length + 1)); } catch { return ''; }
}

/** @description Bounded, one-time, process-local code handoffs; no browser-supplied identity is trusted. */
export class ConnectorOAuthCeremonies {
  private readonly pending = new Map<string, Ceremony>();

  /** @description Expired entries are removed before every operation, without background timers. */
  private prune(): void {
    for (const [key, value] of this.pending) if (value.expiresAt <= Date.now()) this.pending.delete(key);
  }

  /** @description Capture the authenticated consent and issue independent state and browser secrets. */
  issue(consent: ConnectorConsent): { state: string; cookieName: string; cookieSecret: string } {
    this.prune();
    if (this.pending.size >= 1000 || [...this.pending.values()].filter(value => value.caller.sub === consent.caller.sub).length >= 8) {
      throw new Error('too many pending connector sign-ins');
    }
    const nonce = randomBytes(32).toString('base64url');
    const cookieSecret = randomBytes(32).toString('base64url');
    const cookieName = `oshalconnect_${nonce}`;
    const state = signState({ nonce });
    this.pending.set(state, {
      ...consent, caller: { ...consent.caller }, cookieName,
      cookieHash: createHash('sha256').update(cookieSecret).digest(),
      expiresAt: Date.now() + CONNECTOR_CEREMONY_TTL, phase: 'authorize',
    });
    return { state, cookieName, cookieSecret };
  }

  /** @description Consume a provider state exactly once and stage its code without external I/O. */
  relay(state: string, provider: string, callerSub: string | undefined, code: string, error: string): { location: string } | null {
    this.prune();
    if (!verifyState(state)) return null;
    const ceremony = this.pending.get(state);
    if (!ceremony || ceremony.phase !== 'authorize' || ceremony.provider !== provider
        || (callerSub !== undefined && callerSub !== ceremony.caller.sub)) return null;
    this.pending.delete(state);
    const ticket = randomBytes(32).toString('base64url');
    this.pending.set(ticket, { ...ceremony, phase: 'complete', code, error });
    return { location: `${ceremony.origin}/api/connect/${provider}/complete?ticket=${ticket}` };
  }

  /** @description Consume only after the original host, user, and browser secret all agree. */
  complete(ticket: string, provider: string, req: Request, me: ConnectorCaller): Ceremony | null {
    this.prune();
    const ceremony = this.pending.get(ticket);
    if (!ceremony || ceremony.phase !== 'complete' || ceremony.provider !== provider
        || ceremony.caller.sub !== me.sub || connectorOrigin(req) !== ceremony.origin) return null;
    const actual = createHash('sha256').update(cookieValue(req, ceremony.cookieName)).digest();
    if (!timingSafeEqual(actual, ceremony.cookieHash)) return null;
    this.pending.delete(ticket);
    return ceremony;
  }
}
