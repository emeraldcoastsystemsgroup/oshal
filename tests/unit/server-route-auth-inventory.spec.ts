/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Route-auth INVENTORY guard: enumerate EVERY /api mount in server.ts and fail on any unguarded one that is not on the reviewed allowlist below. oidc.ts runs authRequired:false, so a mount without requiresAuth/serviceSecretOr/requiresOperator is anonymous-callable — and until now no test enumerated the mount table (every existing spec pins specific routes), so a new unwrapped /api mount shipped anonymous with no red. SCOPE: /api mounts registered directly via app.use/get/post/put/patch/delete/all in server.ts only. Out of scope for now (deliberately minimal): non-/api mounts (/shared, /cockpit, /welcome — static assets + HTML surfaces with their own guards) and register*(app, requiresAuth) helper modules, which carry requiresAuth by parameter and mount inside their own files. Runtime sibling: src/features/security/route-audit.ts (the Security Center scanner) — this spec is the CI-side version with a stricter parser (multi-line mounts, app.get/post as well as app.use).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Dropped the /api/world allowlist entry per the spec's own stale-entry instruction — World Intelligence carved to the app store (ADR-085 Wave 3), server.ts no longer mounts the path. The packaged route keeps the identical self-guarded posture (WORLD_INGEST_TOKEN fail-closed writes / open reads / ENABLE_WORLD_INTELLIGENCE 503).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Dropped the /api/trading-charts allowlist entry per the spec's own stale-entry instruction — the trading surface carved to the app store (ADR-085 Wave 3), server.ts no longer mounts any trading path. The packaged route keeps the identical split posture (public MIT chart lib / callerSub-gated /bars), declared auth: public in the package manifest. Anti-bitrot floors lowered with the four unmounts (90→85 inventory, 80→75 guarded — 87/78 remain; floors, not censuses).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Moved UNGUARDED_ALLOWLIST (content unchanged, reasons verbatim) to tests/helpers/unguarded-route-allowlist.ts so tests/unit/route-audit.spec.ts can import it and cross-check it against the runtime scanner's PUBLIC_BY_DESIGN. The two lists previously referenced each other only in prose and HAD diverged: '/api/security/csp-report' and '/api/branding' were reviewed here and absent from the scanner's list entirely, which the scanner's app.use-only parser hid. Importing a spec from a spec would re-register its suites, hence a plain helper module. Every assertion in this file is unchanged.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Classify handler-less limiter mounts with the runtime scanner's shared rule instead of the anonymous-route allowlist; synthetic limiter/open mounts pin both sides of the distinction.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Split parser-liveness assertions from allowlist integrity so governance-counted describe callbacks remain below fifty physical lines.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Recognize the SEC-01 delegated-user route middleware as an authenticated mount posture so Graph and Jarvis cannot be misclassified as anonymous.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | SCOPE RESTORED TO THE WHOLE CONTROLLER. This guard parsed server.ts alone, and the 2026-09-24 server decomposition (708768f5) moved most /api mounts into server-auxiliary-routes.ts and registrar modules, so the inventory fell below its floors and the allowlist went stale — red for ten days with nothing blocking. It now scans every controller registrar discovered from server.ts's src/app import graph (discoverControllerRegistrars, shared with the Security Center), reports offenders as file:line, and pins that the discovery itself stays alive (entry and auxiliary registrar present, registrar count floor) so the next split cannot blind it the same way. The classifier and the allowlist semantics are unchanged.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | The mount extraction and classifier moved verbatim to tests/helpers/controller-api-mounts.ts, shared with the signed-in route ratchet (tests/unit/operator-route-ratchet.spec.ts). Every assertion here is unchanged.
 */

import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { UNGUARDED_ALLOWLIST } from '../helpers/unguarded-route-allowlist';
import { discoverControllerRegistrars } from '@/features/security';
import { classifyMount, extractApiMounts } from '../helpers/controller-api-mounts';

// ─────────────────────────────────────────────────────────────────────────────
// Controller source-scanning helpers. The existing single-line idiom
// (tests/unit/manifest-route-auth.spec.ts classifyMount) breaks on multi-line
// mounts — e.g. app.post('/api/security/csp-report', …) puts the path on its own
// line and /api/remote-clients spreads its middleware list over five. So this
// spec strips comments (string-aware) and then extracts each mount's FULL
// balanced-paren argument text before classifying it. The comment stripper and
// paren walk are shared with the runtime scanner; the CLASSIFIER below is this
// spec's own, so the two remain independent checks of the same mounts.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..', '..');

// ─────────────────────────────────────────────────────────────────────────────

describe('server route classifier shared limiter rule', () => {
  it('derives a handler-less limiter without an allowlist entry', () => {
    expect(classifyMount("'/api/new-limit', brandNewLimiter")).toBe('limiter-only');
  });

  it('still classifies a genuinely open router as unguarded', () => {
    expect(classifyMount("'/api/new-open', createOpenRoutes()")).toBe('unguarded');
  });
});

const registrars = discoverControllerRegistrars(ROOT);
const mounts = registrars.flatMap(extractApiMounts);
const unguarded = mounts.filter((mount) => mount.mode === 'unguarded');

describe('controller registrar discovery stays alive', () => {
  // The 2026-09-24 decomposition blinded a server.ts-only scan for ten days. These pins make the
  // DISCOVERY itself fail loudly: the entry and the auxiliary cluster must be found, and the
  // registrar count may not collapse toward the entry alone.
  it('finds the controller entry and the auxiliary route cluster', () => {
    const files = registrars.map((registrar) => registrar.file);
    expect(files[0]).toBe('src/app/server.ts');
    expect(files).toContain('src/app/server-auxiliary-routes.ts');
  });

  it('finds the registrar modules that receive app (not just the two composition files)', () => {
    // 16 registrars at the time of writing (2026-10-04); a floor, not a census.
    expect(registrars.length).toBeGreaterThanOrEqual(12);
  });
});

describe('controller /api route-auth parser liveness', () => {
  // Vacuous-pass tripwire: if the parser or the discovery bitrots, the inventory shrinks toward
  // zero and every assertion below would pass while checking nothing. server.ts ALONE carries
  // about 56 /api mounts, so a floor well above that proves the registrar walk is contributing.
  // (Floor 85→140 on 2026-10-04 when the scope widened from server.ts to every registrar: 152
  //  mounts across 16 files at the time; an anti-bitrot floor, not a census.)
  it('extracts the full /api mount inventory (parser is alive)', () => {
    expect(mounts.length).toBeGreaterThanOrEqual(140);
  });

  it('sees every guard posture in use (guard identifiers have not been renamed away)', () => {
    const modes = new Set(mounts.map((mt) => mt.mode));
    // If requiresAuth/serviceSecretOr/requiresOperator were renamed, mounts would drift into
    // 'unguarded' and the allowlist assertion below fails loudly — this pins the other side:
    // all postures must remain represented so a silent mass-reclassification is impossible.
    // (Floor 75→120 on 2026-10-04 with the registrar-wide scope; same anti-bitrot rationale.)
    expect(modes.has('oidc')).toBe(true);
    expect(modes.has('delegated-or-oidc')).toBe(true);
    expect(modes.has('service-or-oidc')).toBe(true);
    expect(modes.has('operator')).toBe(true);
    expect(mounts.filter((mt) => mt.mode !== 'unguarded').length).toBeGreaterThanOrEqual(120);
  });
});

describe('controller /api anonymous-by-omission guard', () => {
  // THE guard. authRequired:false means an unwrapped mount is anonymous-callable — every
  // unguarded /api mount must be individually reviewed and carry a written reason here.
  it('every unguarded /api mount is on the reviewed allowlist', () => {
    const allowed = new Set(UNGUARDED_ALLOWLIST.map((e) => e.path));
    const offenders = unguarded
      .flatMap((mt) => mt.paths.map((p) => ({ ...mt, path: p })))
      .filter((mt) => !allowed.has(mt.path))
      .map(
        (mt) =>
          `${mt.path} (app.${mt.method} at ${mt.file}:${mt.line}) is mounted WITHOUT ` +
          `requiresAuth / serviceSecretOr / requiresOperator — it is anonymous-callable ` +
          `(oidc.ts runs authRequired:false). Either add a guard to the mount, or READ the ` +
          `route module end-to-end and add {path, reason} to UNGUARDED_ALLOWLIST in ` +
          `tests/helpers/unguarded-route-allowlist.ts citing its internal guard.`,
      );
    expect(offenders).toEqual([]);
  });

  // Freshness: an allowlist entry whose mount got guarded (or unmounted/carved) is stale —
  // remove it so the list stays a truthful inventory of what is really unguarded today.
  it('the allowlist carries no stale entries', () => {
    const unguardedPaths = new Set(unguarded.flatMap((mt) => mt.paths));
    const stale = UNGUARDED_ALLOWLIST
      .filter((e) => !unguardedPaths.has(e.path))
      .map(
        (e) =>
          `${e.path} is allowlisted but no longer mounts unguarded in any controller registrar ` +
          `(guarded since, or unmounted/carved) — delete its UNGUARDED_ALLOWLIST entry.`,
      );
    expect(stale).toEqual([]);
  });

  it('every allowlist entry carries a substantive reviewed reason', () => {
    for (const e of UNGUARDED_ALLOWLIST) {
      expect(e.path.startsWith('/api/'), `${e.path} must be an /api path`).toBe(true);
      expect(e.reason.length, `${e.path} needs a real reviewed reason, not a stub`).toBeGreaterThan(40);
    }
  });
});
