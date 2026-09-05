/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-139 Stage 1 guards over the REAL shared modules (no doubles — the registry and handle store ARE the boundary): every malformed artifacts: declaration shape is refused (a loader that stops calling the validator, or a validator that goes permissive, goes red here); MIME-glob matching including parameters and case; registry replace-by-app + retract + stable menu order; and the handle store's isolation contract — mint validates the source path fail-closed, resolve refuses foreign subs and expired refs indistinguishably (injected clock), and the per-sub cap bounds a mint loop.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Stage 2 (Amendment B): overlay is KERNEL-RESERVED — a manifest declaring it must fail the load (or any app could point the in-place overlay at an arbitrary page), while a kernel boot registration passes it through to the menu.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import {
  validateArtifactActionsDeclaration,
  isValidArtifactTypeGlob,
  matchesArtifactType,
  registerAppArtifactActions,
  unregisterAppArtifactActions,
  artifactActionsForType,
  mintArtifactHandle,
  resolveArtifactHandle,
  artifactSourcePathError,
} from '@/shared/artifact-exchange';

const GOOD = {
  accepts: [
    { id: 'restyle', label: 'Restyle in Portrait Studio', icon: '🎨', types: ['image/*'], mode: 'open' as const },
    { id: 'ingest', label: 'Ingest', types: ['application/pdf', 'text/*'], mode: 'post' as const, endpoint: '/api/rag/ingest-artifact' },
  ],
};

describe('artifacts: declaration validation (fail-closed at load)', () => {
  it('accepts a well-formed declaration, and absence', () => {
    expect(validateArtifactActionsDeclaration(GOOD)).toBeNull();
    expect(validateArtifactActionsDeclaration(undefined)).toBeNull();
    expect(validateArtifactActionsDeclaration({ provides: [{ types: ['image/png'], list: '/api/x/list' }] })).toBeNull();
  });

  it('refuses every malformed shape with a pointed message', () => {
    const bad: Array<[unknown, RegExp]> = [
      [[], /must be a map/],
      [{ nonsense: [] }, /unknown key/],
      [{ accepts: {} }, /must be a list/],
      [{ accepts: [{ id: 'Bad_ID', label: 'x', types: ['image/*'], mode: 'open' }] }, /id must be a lowercase slug/],
      [{ accepts: [{ id: 'a', label: '', types: ['image/*'], mode: 'open' }] }, /label/],
      [{ accepts: [{ id: 'a', label: 'x', types: [], mode: 'open' }] }, /non-empty list of MIME globs/],
      [{ accepts: [{ id: 'a', label: 'x', types: ['image/'], mode: 'open' }] }, /not a valid MIME glob/],
      [{ accepts: [{ id: 'a', label: 'x', types: ['*/png'], mode: 'open' }] }, /not a valid MIME glob/],
      [{ accepts: [{ id: 'a', label: 'x', types: ['image/*'], mode: 'share' }] }, /mode must be one of/],
      [{ accepts: [{ id: 'a', label: 'x', types: ['image/*'], mode: 'post' }] }, /requires a root-relative/],
      [{ accepts: [{ id: 'a', label: 'x', types: ['image/*'], mode: 'post', endpoint: 'https://evil.example/x' }] }, /requires a root-relative/],
      [{ accepts: [{ id: 'a', label: 'x', types: ['image/*'], mode: 'post', endpoint: '/notapi/x' }] }, /requires a root-relative/],
      [{ accepts: [{ id: 'a', label: 'x', types: ['image/*'], mode: 'post', endpoint: '/api/../etc' }] }, /requires a root-relative/],
      [{ accepts: [{ id: 'a', label: 'x', types: ['image/*'], mode: 'open', endpoint: '/api/x' }] }, /open mode takes no endpoint/],
      [{ accepts: [GOOD.accepts[0], { ...GOOD.accepts[0] }] }, /duplicate id/],
      [{ accepts: [{ id: 'a', label: 'x', types: ['image/*'], mode: 'open', overlay: '/api/artifacts/email-compose' }] }, /kernel-reserved/],
      [{ provides: [{ types: ['bogus'] }] }, /not a valid MIME glob/],
      [{ provides: [{ types: ['image/*'], list: 'http://x/y' }] }, /root-relative/],
    ];
    for (const [decl, re] of bad) {
      const err = validateArtifactActionsDeclaration(decl);
      expect(err, JSON.stringify(decl)).toMatch(re);
    }
  });

  it('glob + matcher agree on shapes, parameters, and case', () => {
    expect(isValidArtifactTypeGlob('*/*')).toBe(true);
    expect(isValidArtifactTypeGlob('image/*')).toBe(true);
    expect(isValidArtifactTypeGlob('application/pdf')).toBe(true);
    expect(isValidArtifactTypeGlob('image')).toBe(false);
    expect(matchesArtifactType('image/*', 'image/png')).toBe(true);
    expect(matchesArtifactType('image/*', 'IMAGE/PNG')).toBe(true);
    expect(matchesArtifactType('*/*', 'application/pdf')).toBe(true);
    expect(matchesArtifactType('application/pdf', 'application/pdf; charset=binary')).toBe(true);
    expect(matchesArtifactType('image/*', 'application/pdf')).toBe(false);
    expect(matchesArtifactType('image/png', 'not-a-mime')).toBe(false);
  });
});

describe('registry: replace-by-app, retract, stable menu', () => {
  afterEach(() => {
    unregisterAppArtifactActions('app-a');
    unregisterAppArtifactActions('app-b');
  });

  it('aggregates matching actions across apps in stable order, with endpoint only on post', () => {
    registerAppArtifactActions('app-b', { accepts: [{ id: 'b1', label: 'B one', types: ['image/*'], mode: 'open' }] });
    registerAppArtifactActions('app-a', GOOD);
    const forPng = artifactActionsForType('image/png');
    expect(forPng.map((a) => `${a.app}:${a.id}`)).toEqual(['app-a:restyle', 'app-b:b1']);
    expect(forPng[0].endpoint).toBeUndefined();
    const forPdf = artifactActionsForType('application/pdf');
    expect(forPdf).toHaveLength(1);
    expect(forPdf[0].endpoint).toBe('/api/rag/ingest-artifact');
  });

  it('kernel overlay registrations pass overlay through to the menu (manifests cannot reach here)', () => {
    registerAppArtifactActions('app-a', {
      accepts: [{ id: 'compose', label: 'Email it…', types: ['*/*'], mode: 'open', overlay: '/api/artifacts/email-compose' }],
    });
    const menu = artifactActionsForType('application/pdf');
    expect(menu).toHaveLength(1);
    expect(menu[0].overlay).toBe('/api/artifacts/email-compose');
  });

  it('re-register replaces; unregister empties the menu', () => {
    registerAppArtifactActions('app-a', GOOD);
    registerAppArtifactActions('app-a', { accepts: [{ id: 'only', label: 'Only', types: ['text/plain'], mode: 'open' }] });
    expect(artifactActionsForType('image/png')).toHaveLength(0);
    expect(artifactActionsForType('text/plain')).toHaveLength(1);
    unregisterAppArtifactActions('app-a');
    expect(artifactActionsForType('text/plain')).toHaveLength(0);
  });
});

describe('handles: the isolation boundary (owner-bound, TTL, fail-closed source)', () => {
  const SUB = 'auth0|artifact-owner';
  const OTHER = 'auth0|someone-else';

  it('mint validates the source path fail-closed', () => {
    for (const bad of ['', 'https://evil/x', '/etc/passwd', '/api/../secrets', '/api/a\\b', '/api/a b', '/api/x#frag', 'api/x']) {
      expect(artifactSourcePathError(bad), bad).not.toBeNull();
    }
    expect(artifactSourcePathError('/api/portrait-studio/portraits/abc/image?download=1')).toBeNull();
    expect(() => mintArtifactHandle({ ownerSub: SUB, sourcePath: 'https://evil/x', type: 'image/png' })).toThrow();
    expect(() => mintArtifactHandle({ ownerSub: '', sourcePath: '/api/x/y', type: 'image/png' })).toThrow(/authenticated/);
  });

  it('resolves for the minting sub only, and never after expiry — indistinguishably', () => {
    const t0 = 1_000_000;
    const rec = mintArtifactHandle({ ownerSub: SUB, sourcePath: '/api/x/y', type: 'Image/PNG; q=1', name: 'a"b\r\nc.png' }, t0);
    expect(rec.type).toBe('image/png');
    expect(rec.name).not.toMatch(/["\r\n]/);
    expect(resolveArtifactHandle(rec.ref, SUB, t0 + 1000)?.ref).toBe(rec.ref);
    expect(resolveArtifactHandle(rec.ref, OTHER, t0 + 1000)).toBeNull();
    expect(resolveArtifactHandle('art_does-not-exist', SUB, t0 + 1000)).toBeNull();
    expect(resolveArtifactHandle(rec.ref, SUB, t0 + 16 * 60 * 1000)).toBeNull();
  });

  it('bounds outstanding handles per sub', () => {
    const t0 = 2_000_000;
    const HOARDER = 'auth0|hoarder';
    for (let i = 0; i < 200; i++) {
      mintArtifactHandle({ ownerSub: HOARDER, sourcePath: `/api/x/${i}`, type: 'text/plain' }, t0);
    }
    expect(() => mintArtifactHandle({ ownerSub: HOARDER, sourcePath: '/api/x/one-more', type: 'text/plain' }, t0)).toThrow(/too many outstanding/);
    // A different sub is unaffected, and expiry frees the hoarder's budget.
    expect(() => mintArtifactHandle({ ownerSub: SUB, sourcePath: '/api/x/ok', type: 'text/plain' }, t0)).not.toThrow();
    expect(() => mintArtifactHandle({ ownerSub: HOARDER, sourcePath: '/api/x/later', type: 'text/plain' }, t0 + 16 * 60 * 1000)).not.toThrow();
  });
});
