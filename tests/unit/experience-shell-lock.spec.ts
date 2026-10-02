/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The focused-landing shell lock: landing parsing, every operator surface redirected for a non-operator on a focused deployment, and the four cases that must never redirect (operator, generic landing, a named application, an asset path).
 */

import { describe, expect, it } from 'vitest';
import { focusedLandingApp, OPERATOR_SURFACES, shellRedirectFor } from '@/app/experience-shell-lock';

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
