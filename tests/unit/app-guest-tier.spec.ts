/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D4: a manifest's guestTier is a REQUEST, not a grant (operator decision 2026-07-13). Guests are UNAUTHENTICATED, so if a package could set its own tier, installing one would silently widen what an anonymous visitor can reach — `full` includes WRITES. These tests pin the asymmetry: a request grants nothing, only an operator approval does, core's own lists always win, and a toggled-off app stops granting.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readManifest } from '../../src/features/swarm-apps';
import {
  GUEST_TIERS,
  approvedAppGuestTiers,
  guestCapabilities,
  guestDecision,
  isGuestTier,
  registerAppGuestTier,
  unregisterAppGuestTier,
} from '../../src/shared/middleware/guest-capability-matrix';

/**
 * @description Write a manifest and read it through the real readManifest.
 * @param body - YAML appended to the required name/displayName.
 * @returns The parsed manifest.
 */
function read(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-guest-'));
  const file = join(dir, 'oshal-app.yaml');
  writeFileSync(file, `name: t\ndisplayName: T\n${body}`, 'utf8');
  try {
    return readManifest(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SEG = 'demo-app';

afterEach(() => unregisterAppGuestTier(SEG));

describe('guest tier model (ADR-085 D4)', () => {
  it('narrows only real tiers', () => {
    expect([...GUEST_TIERS]).toEqual(['full', 'readonly', 'blocked']);
    expect(isGuestTier('full')).toBe(true);
    expect(isGuestTier('admin')).toBe(false);
  });

  it('readManifest accepts a declared tier and REJECTS an unknown one', () => {
    expect(read('guestTier: full\n').guestTier).toBe('full');
    expect(() => read('guestTier: superuser\n')).toThrow(/not a known tier/);
  });
});

describe('an UNAPPROVED request grants nothing (the whole point)', () => {
  // A manifest asking for `full` must NOT be able to open itself to anonymous writes. Nothing in
  // the load path registers a tier — only an operator approval does.
  it('a segment with no approval is Tier-B: guests read, mutations blocked', () => {
    expect(guestDecision(`/api/${SEG}/items`, 'GET')).toBe('allow');
    expect(guestDecision(`/api/${SEG}/items`, 'POST')).toBe('guest_readonly');
    expect(guestDecision(`/api/${SEG}/items`, 'DELETE')).toBe('guest_readonly');
  });

  it('declaring guestTier: full in a manifest does not register anything', () => {
    const m = read('guestTier: full\n');
    expect(m.guestTier).toBe('full'); // the REQUEST is parsed…
    expect(approvedAppGuestTiers().has('t')).toBe(false); // …and grants nothing
    expect(guestDecision('/api/t/items', 'POST')).toBe('guest_readonly');
  });
});

describe('an OPERATOR-APPROVED tier takes effect', () => {
  it('approved `full` lets guests write', () => {
    registerAppGuestTier(SEG, 'full');
    expect(guestDecision(`/api/${SEG}/items`, 'POST')).toBe('allow');
    expect(guestDecision(`/api/${SEG}/items`, 'GET')).toBe('allow');
  });

  it('approved `blocked` 403s guests even on GET', () => {
    registerAppGuestTier(SEG, 'blocked');
    expect(guestDecision(`/api/${SEG}/items`, 'GET')).toBe('guest_blocked');
    expect(guestDecision(`/api/${SEG}/items`, 'POST')).toBe('guest_blocked');
  });

  it('approved `readonly` is the same as the default', () => {
    registerAppGuestTier(SEG, 'readonly');
    expect(guestDecision(`/api/${SEG}/x`, 'GET')).toBe('allow');
    expect(guestDecision(`/api/${SEG}/x`, 'POST')).toBe('guest_readonly');
  });

  // Revocation (and deactivate/uninstall) must drop the app straight back to read-only.
  it('revoking the approval drops back to the read-only default', () => {
    registerAppGuestTier(SEG, 'full');
    expect(guestDecision(`/api/${SEG}/x`, 'POST')).toBe('allow');
    unregisterAppGuestTier(SEG);
    expect(guestDecision(`/api/${SEG}/x`, 'POST')).toBe('guest_readonly');
  });
});

describe('core always wins — a package cannot override a core segment', () => {
  // `workflow-studio` is core Tier-C (blocked) AND kernel-resident (never carves — the D5
  // permanent-fixture rule; this test was pinned to `payments` until its ADR-085 carve).
  // A package must not be able to approve itself into `full` on a core-locked segment.
  it('a package cannot unlock a core Tier-C segment', () => {
    registerAppGuestTier('workflow-studio', 'full');
    try {
      expect(guestDecision('/api/workflow-studio/publish', 'POST')).toBe('guest_blocked');
      expect(guestDecision('/api/workflow-studio/list', 'GET')).toBe('guest_blocked');
    } finally {
      unregisterAppGuestTier('workflow-studio');
    }
  });

  it('a package cannot lock down a core Tier-A segment', () => {
    registerAppGuestTier('jarvis', 'blocked');
    try {
      expect(guestDecision('/api/jarvis/ask', 'POST')).toBe('allow');
    } finally {
      unregisterAppGuestTier('jarvis');
    }
  });
});

describe('the capability snapshot matches the guard (no UI drift)', () => {
  it('keeps Pumpkin server writes blocked while describing its browser-local demo', () => {
    const caps = guestCapabilities();
    expect(guestDecision('/api/pumpkin/rooms/register', 'POST')).toBe('guest_readonly');
    expect(guestDecision('/api/pumpkin/chat', 'POST')).toBe('guest_readonly');
    expect(caps.tierA).not.toContain('pumpkin');
    expect(caps.notations.pumpkin).toMatch(/browser demo/i);
  });

  it('folds approved packaged tiers into tierA / tierC', () => {
    registerAppGuestTier(SEG, 'full');
    registerAppGuestTier('locked-app', 'blocked');
    try {
      const caps = guestCapabilities();
      expect(caps.tierA).toContain(SEG);
      expect(caps.tierC).toContain('locked-app');
      expect(caps.blockedApps).toContain('locked-app');
      // Core's own entries survive.
      expect(caps.tierA).toContain('jarvis');
      expect(caps.tierC).toContain('workflow-studio');
    } finally {
      unregisterAppGuestTier('locked-app');
    }
  });
});
