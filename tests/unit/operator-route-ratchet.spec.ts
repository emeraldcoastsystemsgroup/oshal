/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Signed-in route RATCHET (core convergence, step 1). The anonymous-route inventory (server-route-auth-inventory.spec.ts) stops a mount that anyone on the internet can call; nothing stopped a NEW mount that every signed-in user can call when only the portal admin should, which is the class of leak the 2026-10-04 cockpit route audit found 22 times. This guard reads the same controller mount table and fails when a mount reachable by any signed-in user (requiresAuth or delegated-user auth, no requiresOperator) is not in tests/helpers/signed-in-route-baseline.ts. Pre-existing mounts are recorded as LEGACY under a ceiling that only goes down, so they are reviewed module by module instead of all at once; a new mount needs either requiresOperator or a written reason.
 */

import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { discoverControllerRegistrars } from '@/features/security';
import { extractApiMounts, type Mount } from '../helpers/controller-api-mounts';
import { LEGACY, LEGACY_CEILING, SIGNED_IN_ROUTES } from '../helpers/signed-in-route-baseline';

const ROOT = path.resolve(__dirname, '..', '..');
const SIGNED_IN_MODES: ReadonlySet<Mount['mode']> = new Set(['oidc', 'delegated-or-oidc']);

const mounts = discoverControllerRegistrars(ROOT).flatMap(extractApiMounts);
const signedIn = mounts
  .filter((mount) => SIGNED_IN_MODES.has(mount.mode))
  .flatMap((mount) => mount.paths.map((p) => ({ ...mount, path: p })));

describe('signed-in route ratchet: parser liveness', () => {
  // Vacuous-pass tripwire: 107 signed-in-only mount paths on 2026-10-05. If discovery or the
  // classifier bitrots, the list shrinks toward zero and every assertion below passes while
  // checking nothing. A floor, not a census: converting mounts to requiresOperator lowers the
  // count, so lower this floor with LEGACY_CEILING when a review moves many at once.
  it('still sees the signed-in mount table', () => {
    expect(signedIn.length).toBeGreaterThanOrEqual(80);
  });
});

describe('signed-in route ratchet', () => {
  it('every mount any signed-in user can reach is recorded on purpose', () => {
    const recorded = new Set(SIGNED_IN_ROUTES.map((entry) => entry.path));
    const offenders = signedIn
      .filter((mount) => !recorded.has(mount.path))
      .map(
        (mount) =>
          `${mount.path} (app.${mount.method} at ${mount.file}:${mount.line}) is reachable by EVERY ` +
          `signed-in user: it has requiresAuth but no requiresOperator. If it changes swarm-wide ` +
          `state (defaults, providers, other users' data), add requiresOperator at the mount: only ` +
          `the portal admin may do that. Otherwise read the module and add {path, reason} to ` +
          `tests/helpers/signed-in-route-baseline.ts saying why every user may reach it.`,
      );
    expect(offenders).toEqual([]);
  });

  it('the baseline carries no stale entries (gated, carved or unmounted since)', () => {
    const live = new Set(signedIn.map((mount) => mount.path));
    const stale = SIGNED_IN_ROUTES
      .filter((entry) => !live.has(entry.path))
      .map((entry) => `${entry.path} is no longer a signed-in-only mount: delete its baseline entry` +
        `${entry.reason === LEGACY ? ' and lower LEGACY_CEILING by one' : ''}.`);
    expect(stale).toEqual([]);
  });

  it('LEGACY entries only go down: new mounts are never LEGACY', () => {
    const legacy = SIGNED_IN_ROUTES.filter((entry) => entry.reason === LEGACY).length;
    expect(legacy, `LEGACY entries (${legacy}) exceed LEGACY_CEILING (${LEGACY_CEILING}): a new mount ` +
      `was recorded as LEGACY. Give it requiresOperator or a real reason instead.`).toBeLessThanOrEqual(LEGACY_CEILING);
    expect(LEGACY_CEILING - legacy, `LEGACY_CEILING (${LEGACY_CEILING}) is above the ${legacy} LEGACY entries: ` +
      `lower it so the reviewed progress cannot be undone.`).toBe(0);
  });

  it('every reviewed entry carries a substantive reason and appears once', () => {
    const seen = new Set<string>();
    for (const entry of SIGNED_IN_ROUTES) {
      expect(entry.path.startsWith('/api/'), `${entry.path} must be an /api path`).toBe(true);
      expect(seen.has(entry.path), `${entry.path} is listed twice`).toBe(false);
      seen.add(entry.path);
      if (entry.reason === LEGACY) continue;
      expect(entry.reason.startsWith('legacy'), `${entry.path}: write a real reason, not a legacy marker`).toBe(false);
      expect(entry.reason.length, `${entry.path} needs a real reviewed reason, not a stub`).toBeGreaterThan(40);
    }
  });
});
