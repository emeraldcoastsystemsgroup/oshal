/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the per-host session-cookie domain: a configured domain must NEVER be applied to a host it does not cover (the browser rejects the cookie, the OIDC transient state cookie inherits the rejection, and every login on that host dies at /callback with "checks.state argument is missing" — live incident on dnd.oshal.ai 2026-07-31 with SESSION_COOKIE_DOMAIN=.agenticfederal.us). Also pins the comma-separated multi-domain form and the host-only fallback.
 */

import { describe, it, expect } from 'vitest';

import { resolveCookieDomainForHost } from '@/shared/middleware/oidc';

describe('resolveCookieDomainForHost', () => {
  it('returns undefined (host-only cookie) when nothing is configured', () => {
    expect(resolveCookieDomainForHost(undefined, 'https://oshal.agenticfederal.us')).toBeUndefined();
    expect(resolveCookieDomainForHost('', 'https://oshal.agenticfederal.us')).toBeUndefined();
  });

  it('applies a matching domain to a subdomain of it', () => {
    expect(resolveCookieDomainForHost('.agenticfederal.us', 'https://oshal.agenticfederal.us')).toBe('.agenticfederal.us');
    expect(resolveCookieDomainForHost('.agenticfederal.us', 'https://littlemonster.agenticfederal.us')).toBe('.agenticfederal.us');
  });

  it('NEVER applies a domain to a host outside it — the dnd.oshal.ai incident', () => {
    // With .agenticfederal.us configured, an oshal.ai host must get a host-only
    // cookie, not a Domain the browser will reject (which kills the state cookie).
    expect(resolveCookieDomainForHost('.agenticfederal.us', 'https://dnd.oshal.ai')).toBeUndefined();
  });

  it('never matches a lookalike suffix without a dot boundary', () => {
    // evil-agenticfederal.us ends with the bare string but is a DIFFERENT domain.
    expect(resolveCookieDomainForHost('.agenticfederal.us', 'https://evil-agenticfederal.us')).toBeUndefined();
  });

  it('resolves the right entry from a comma-separated list per host', () => {
    const configured = '.agenticfederal.us,.oshal.ai';
    expect(resolveCookieDomainForHost(configured, 'https://oshal.agenticfederal.us')).toBe('.agenticfederal.us');
    expect(resolveCookieDomainForHost(configured, 'https://dnd.oshal.ai')).toBe('.oshal.ai');
    expect(resolveCookieDomainForHost(configured, 'https://finance.oshal.ai')).toBe('.oshal.ai');
    expect(resolveCookieDomainForHost(configured, 'https://example.com')).toBeUndefined();
  });

  it('matches the apex itself, case-insensitively, with whitespace tolerated', () => {
    expect(resolveCookieDomainForHost(' .oshal.ai , .agenticfederal.us ', 'https://OSHAL.AI')).toBe('.oshal.ai');
    expect(resolveCookieDomainForHost('oshal.ai', 'https://dnd.oshal.ai')).toBe('oshal.ai');
  });

  it('returns undefined for an unparseable baseURL instead of throwing', () => {
    expect(resolveCookieDomainForHost('.oshal.ai', 'not a url')).toBeUndefined();
  });
});
