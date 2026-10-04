/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The focused-landing shell lock: landing parsing, every operator surface redirected for a non-operator on a focused deployment, and the four cases that must never redirect (operator, generic landing, a named application, an asset path).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Canonical paths: case, doubled-slash, dot-segment and percent-encoded spellings of the cockpit document, /experience/*.html (index, nexus, simple) and a malformed escape under a surface root are all surfaces; assets, tool pages and APIs are not. Only the cockpit document keeps the ?app= exemption.
 */

import { describe, expect, it } from 'vitest';
import { canonicalSurfacePath, focusedLandingApp, OPERATOR_SURFACES, operatorSurfaceKind, shellRedirectFor } from '@/app/experience-shell-lock';

const LANDING = '/cockpit/?app=intelligent-sales';

describe('focusedLandingApp', () => {
  it('reads a focused application from a landing path and nothing from the generic cockpit', () => {
    expect(focusedLandingApp(LANDING)).toBe('intelligent-sales');
    expect(focusedLandingApp('/cockpit/?app=dnd&view=table')).toBe('dnd');
    expect(focusedLandingApp('/cockpit/')).toBeNull();
    expect(focusedLandingApp('/custom-home')).toBeNull();
    expect(focusedLandingApp('/cockpit/?app=')).toBeNull();
    expect(focusedLandingApp('/cockpit/?app=../users')).toBeNull();
    expect(focusedLandingApp('')).toBeNull();
  });
});

describe('shellRedirectFor', () => {
  it('sends a non-operator on a focused deployment from every operator surface to the landing', () => {
    for (const pathname of OPERATOR_SURFACES) {
      expect(shellRedirectFor({ operator: false, landingPath: LANDING, pathname }), pathname).toBe(LANDING);
    }
  });

  it('never redirects an operator', () => {
    for (const pathname of OPERATOR_SURFACES) {
      expect(shellRedirectFor({ operator: true, landingPath: LANDING, pathname })).toBeNull();
    }
  });

  it('never redirects on a deployment without a focused landing (the generic swarm product)', () => {
    for (const landingPath of ['/cockpit/', '/custom-home', '']) {
      expect(shellRedirectFor({ operator: false, landingPath, pathname: '/cockpit/' })).toBeNull();
      expect(shellRedirectFor({ operator: false, landingPath, pathname: '/portal' })).toBeNull();
    }
  });

  it('leaves a request that names an application to that application, and leaves assets alone', () => {
    expect(shellRedirectFor({ operator: false, landingPath: LANDING, pathname: '/cockpit/', requestedApp: 'dnd' })).toBeNull();
    expect(shellRedirectFor({ operator: false, landingPath: LANDING, pathname: '/cockpit/', requestedApp: 'intelligent-sales' })).toBeNull();
    // A malformed selector is not an application: the landing still applies.
    expect(shellRedirectFor({ operator: false, landingPath: LANDING, pathname: '/cockpit/', requestedApp: '../users' })).toBe(LANDING);
    expect(shellRedirectFor({ operator: false, landingPath: LANDING, pathname: '/cockpit/', requestedApp: ['a', 'b'] })).toBe(LANDING);
    for (const pathname of ['/cockpit/js/app.js', '/cockpit/css/themes/midnight.css', '/experience/live-data.js', '/api/ui/profile', '/applications/']) {
      expect(shellRedirectFor({ operator: false, landingPath: LANDING, pathname }), pathname).toBeNull();
    }
  });
});

/** Every spelling the static mounts or the case-insensitive routes would serve as a surface. */
const COCKPIT_SPELLINGS = ['/Cockpit/', '/COCKPIT/index.html', '/cockpit/js/../index.html', '/cockpit//', '/%63ockpit/',
  '/cockpit%2Findex.html', '/cockpit/%2e%2e/cockpit/', '/cockpit/%69ndex.html', '//cockpit', '/cockpit/./'];
const EXPERIENCE_SPELLINGS = ['/experience/index.html', '/experience/nexus.html', '/experience/simple.html', '/Experience/Nexus.HTML',
  '/experience//simple.html', '/Portal', '/NEXUS/', '/simple/index.html', '/experience/studio.html'];

describe('canonical surface paths', () => {
  it.each(COCKPIT_SPELLINGS)('%s is the cockpit document', (pathname) => {
    expect(canonicalSurfacePath(pathname)).toBe('/cockpit');
    expect(operatorSurfaceKind(pathname)).toBe('cockpit');
  });

  it.each(EXPERIENCE_SPELLINGS)('%s is an experience surface', (pathname) => {
    expect(operatorSurfaceKind(pathname)).toBe('experience');
  });

  it('decides a malformed escape under a surface root as a surface, and elsewhere as nothing', () => {
    expect(canonicalSurfacePath('/cockpit/%E0%A4%A')).toBeNull();
    expect(operatorSurfaceKind('/cockpit/%E0%A4%A')).toBe('experience');
    expect(operatorSurfaceKind('/Portal/%ZZ')).toBe('experience');
    expect(operatorSurfaceKind('/api/%E0%A4%A')).toBeNull();
  });

  it('leaves assets, tool pages, APIs and lookalike roots alone', () => {
    for (const pathname of ['/cockpit/js/app.js', '/cockpit/tools/platform.html', '/cockpit/css/x.css', '/experience/live-data.js',
      '/experience/shell.css', '/api/ui/profile', '/applications/', '/cockpitx/', '/cockpit-tools', '/', '']) {
      expect(operatorSurfaceKind(pathname), pathname).toBeNull();
    }
  });
});

describe('shellRedirectFor over canonical paths', () => {
  it('redirects every spelling of a surface for a non-operator on a focused deployment', () => {
    for (const pathname of [...COCKPIT_SPELLINGS, ...EXPERIENCE_SPELLINGS, '/cockpit/%E0%A4%A']) {
      expect(shellRedirectFor({ operator: false, landingPath: LANDING, pathname }), pathname).toBe(LANDING);
    }
  });

  it('keeps every spelling open to an operator and on a deployment without a focused landing', () => {
    for (const pathname of [...COCKPIT_SPELLINGS, ...EXPERIENCE_SPELLINGS]) {
      expect(shellRedirectFor({ operator: true, landingPath: LANDING, pathname }), pathname).toBeNull();
      expect(shellRedirectFor({ operator: false, landingPath: '/cockpit/', pathname }), pathname).toBeNull();
    }
  });

  it('honours ?app= on the cockpit document only, never on an experience page or a malformed path', () => {
    for (const pathname of COCKPIT_SPELLINGS) {
      expect(shellRedirectFor({ operator: false, landingPath: LANDING, pathname, requestedApp: 'dnd' }), pathname).toBeNull();
    }
    for (const pathname of [...EXPERIENCE_SPELLINGS, '/portal', '/nexus', '/simple', '/experience/', '/cockpit/%E0%A4%A']) {
      expect(shellRedirectFor({ operator: false, landingPath: LANDING, pathname, requestedApp: 'zzz' }), pathname).toBe(LANDING);
    }
  });
});
