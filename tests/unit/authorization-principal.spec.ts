/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard verified issuer extraction and directory evidence across identity projection.
 */
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { getAuthenticatedPrincipalIssuer } from '../../src/shared/middleware/principal-issuer';
import { getPreservedDirectoryClaims, preserveVerifiedDirectoryClaims } from '../../src/shared/middleware/verified-directory-claims';

describe('application authorization principal provenance', () => {
  it('reads the verified issuer when OIDC presentation filters protocol claims', () => {
    const req = { oidc: { isAuthenticated: () => true, user: { sub: 'person' }, idTokenClaims: { iss: 'https://issuer.example' } } } as unknown as Request;
    expect(getAuthenticatedPrincipalIssuer(req)).toBe('https://issuer.example');
  });

  it('does not repair missing verified protocol evidence from presentation or request inputs', () => {
    const req = { oidc: { isAuthenticated: () => true, user: { iss: 'https://spoof.example' }, idTokenClaims: {} }, body: { issuer: 'https://spoof.example' } } as unknown as Request;
    expect(getAuthenticatedPrincipalIssuer(req)).toBeNull();
  });

  it('retains the explicit issuer on synthetic local/PAT sessions without protocol claims', () => {
    const req = { oidc: { isAuthenticated: () => true, user: { iss: 'urn:oshal:local-auth' } } } as unknown as Request;
    expect(getAuthenticatedPrincipalIssuer(req)).toBe('urn:oshal:local-auth');
    req.oidc.isAuthenticated = () => false;
    expect(getAuthenticatedPrincipalIssuer(req)).toBeNull();
  });

  it('copies only verified directory metadata and never leaks endpoint/token values', () => {
    const req = {} as Request;
    const groups = ['group-a'];
    preserveVerifiedDirectoryClaims(req, { iss: 'https://issuer.example', groups, _claim_names: { groups: 'source' }, _claim_sources: { source: { endpoint: 'https://untrusted.example' } }, token: 'not-retained' });
    groups.push('group-b');
    expect(getPreservedDirectoryClaims(req)).toMatchObject({ groups: ['group-a'], groupOverage: true });
    expect(getPreservedDirectoryClaims(req)).not.toHaveProperty('_claim_sources');
    expect(getPreservedDirectoryClaims(req)).not.toHaveProperty('token');
    expect(getPreservedDirectoryClaims({ body: { groups } } as Request)).toBeUndefined();
  });
});
