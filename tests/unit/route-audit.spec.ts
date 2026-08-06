/**
 * Regression guard for the Security Center route auditor (features/security/route-audit).
 *
 * Pins the three defects fixed 2026-07-24:
 *  1. PACKAGE-BLINDNESS — carved apps mount routes dynamically (ADR-085), so a server.ts-only
 *     scan never sees a manifest route declared `auth: public`. The auditor must flag any
 *     manifest route resolving to `public` that is not public-by-design. (THE required guard:
 *     a manifest route with no reviewed public-by-design entry must show up in the audit.)
 *  2. STALE PUBLIC_BY_DESIGN — the list drifted from the real mount table (missing
 *     /api/profile-studio), producing a standing false-positive HIGH finding. The real
 *     server.ts must audit CLEAN: every genuinely-unguarded mount is individually reviewed in
 *     tests/unit/server-route-auth-inventory.spec.ts, so any scanner finding here is either a
 *     false positive or a brand-new unguarded mount that spec catches in the same CI run.
 *  3. PARSER TRUNCATION — the old regex captured middlewares with [^)]* and stopped at the
 *     FIRST close paren, so a parenthesised middleware before the guard (express.json({...}))
 *     hid requiresAuth → false positive on /api/vision.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — manifest-walk guard (public fires / oidc-by-omission does not / reviewed public stays quiet), real-server.ts clean-audit sync check, balanced-paren parser guard, and the exact-or-slash-boundary allowlist matcher guard.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added the PROGRAMMATIC two-list sync check the backlog's done-when asks for, plus the method-coverage guard behind it. The scanner used to match only `app.use(` (its own docblock called app.get/app.post "out of scope"), so four unguarded inline-handler mounts were invisible to it and the Security Center reported "0 route_auth findings" while structurally blind — and two of the four ('/api/security/csp-report', '/api/branding') existed ONLY in the CI spec's UNGUARDED_ALLOWLIST, never in PUBLIC_BY_DESIGN. The lists referenced each other in prose comments alone, so nothing could catch that. Now: the scanner walks every Express method, and this spec imports BOTH lists and asserts the containment relationship in both directions.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Removed the manual limiter-only exception from list reconciliation; both scanners now derive that handler-less shape through one shared classifier.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Split list synchronization from parser-method coverage so governance-counted describe callbacks remain below fifty physical lines.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Pin the SEC-01 delegated-user middleware as an explicit route-auditor guard.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { auditRoutes, PUBLIC_BY_DESIGN } from '@/features/security';
import { UNGUARDED_ALLOWLIST } from '../helpers/unguarded-route-allowlist';

const REAL_SERVER_TS = path.resolve(__dirname, '..', '..', 'src', 'app', 'server.ts');

/** Write a synthetic server file into a temp dir and return its path. */
let tmpDir: string;
function syntheticServer(source: string): string {
  const file = path.join(tmpDir, `server-${Math.random().toString(36).slice(2)}.ts`);
  fs.writeFileSync(file, source, 'utf8');
  return file;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-spec-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('route auditor — manifest route walk (the package-blindness guard)', () => {
  it('flags a manifest route declared auth: public that is not public-by-design', () => {
    const report = auditRoutes(REAL_SERVER_TS, [
      { appName: 'x', mountPath: '/api/notreal-public', auth: 'public' },
    ]);
    const hit = report.findings.find((f) => f.fingerprint === 'route_auth:manifest:/api/notreal-public');
    expect(hit, 'a public manifest route MUST surface in the audit — the auditor has gone package-blind again').toBeTruthy();
    expect(hit!.category).toBe('route_auth');
    expect(hit!.severity).toBe('high');
    expect(hit!.source).toBe('manifest:x');
  });

  it('flags the legacy requiresAuth:false declaration (resolves to public)', () => {
    const report = auditRoutes(REAL_SERVER_TS, [
      { appName: 'legacy', mountPath: '/api/notreal-legacy', requiresAuth: false },
    ]);
    expect(report.findings.some((f) => f.fingerprint === 'route_auth:manifest:/api/notreal-legacy')).toBe(true);
  });

  it('does NOT flag a manifest route with auth omitted — omission resolves to oidc, fail-closed', () => {
    const report = auditRoutes(REAL_SERVER_TS, [
      { appName: 'x', mountPath: '/api/notreal-oidc' },
    ]);
    expect(report.findings.some((f) => f.fingerprint.startsWith('route_auth:manifest:'))).toBe(false);
  });

  it('does NOT flag guarded manifest modes (the mounter applies their guard chains)', () => {
    const report = auditRoutes(REAL_SERVER_TS, [
      { appName: 'a', mountPath: '/api/notreal-svc', auth: 'service-or-oidc' },
      { appName: 'b', mountPath: '/api/notreal-op', auth: 'operator' },
      { appName: 'c', mountPath: '/api/notreal-service', auth: 'service' },
    ]);
    expect(report.findings.some((f) => f.fingerprint.startsWith('route_auth:manifest:'))).toBe(false);
  });

  it('stays quiet on the reviewed self-guarded/anonymous public package mounts', () => {
    // The complete anonymous set across the live stack's ACTIVE manifests (verified against
    // swarm_applications 2026-07-24). If a package's public route leaves this reviewed set,
    // remove its PUBLIC_BY_DESIGN entry in the same change.
    const report = auditRoutes(REAL_SERVER_TS, [
      { appName: 'world', mountPath: '/api/world', auth: 'public' },
      { appName: 'intelligent-trades', mountPath: '/api/trading-charts', auth: 'public' },
      { appName: 'lora', mountPath: '/api/lora/ingest', auth: 'public' },
      { appName: 'vids', mountPath: '/api/vids-public', auth: 'public' },
      { appName: 'hello-oshal', mountPath: '/api/hello-oshal', requiresAuth: false },
    ]);
    expect(report.findings.filter((f) => f.fingerprint.startsWith('route_auth:manifest:'))).toEqual([]);
    expect(report.note).toContain('5 active manifest route declarations');
  });
});

describe('route auditor — PUBLIC_BY_DESIGN stays reconciled with the real mount table', () => {
  // The sync check the BACKLOG asks for: every genuinely-unguarded /api mount in server.ts is
  // individually reviewed in server-route-auth-inventory.spec.ts (same CI run), so ANY finding
  // the scanner produces against the real tree is a stale-allowlist false positive (the
  // /api/profile-studio + /api/vision bugs) or a brand-new unguarded mount that the inventory
  // spec fails on too. Red here means: reconcile PUBLIC_BY_DESIGN, in the same change.
  it('the real server.ts audits clean (no standing false positives)', () => {
    const report = auditRoutes(REAL_SERVER_TS);
    expect(report.available).toBe(true);
    expect(
      report.findings.map((f) => `${f.fingerprint} (${f.source})`),
      'the Security Center would show these as standing HIGH findings — reconcile PUBLIC_BY_DESIGN or guard the mount',
    ).toEqual([]);
  });

  // Vacuous-pass tripwire: if the parser bitrots the clean-audit test above passes while
  // checking nothing. server.ts carried 60+ app.use('/api/…') mounts at time of writing
  // (a floor, not a census — it shrinks with ADR-085 carves).
  it('the parser still extracts a substantial mount inventory', () => {
    const report = auditRoutes(REAL_SERVER_TS);
    const inspected = Number((report.note || '').match(/inspected (\d+) \/api mounts/)?.[1] ?? 0);
    expect(inspected).toBeGreaterThanOrEqual(60);
  });

  it('every allowlist entry is an /api path (no accidental global prefixes)', () => {
    for (const p of PUBLIC_BY_DESIGN) {
      expect(p.startsWith('/api/'), `${p} must be an /api path`).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE TWO-LIST SYNC CHECK (the backlog done-when).
//
// There are two allowlists for the same fact — "this /api mount is unguarded ON PURPOSE":
//   • src/features/security/route-audit.ts   PUBLIC_BY_DESIGN     — the RUNTIME scanner's list
//                                                                   (drives the Security Center)
//   • tests/helpers/unguarded-route-allowlist.ts UNGUARDED_ALLOWLIST — the CI review record
//                                                                   (drives the inventory spec)
// Before this check they cited each other only in prose comments, and they HAD diverged:
// '/api/security/csp-report' and '/api/branding' were reviewed in the CI list and completely
// absent from PUBLIC_BY_DESIGN. Nothing went red, because the scanner's app.use-only parser
// could not see those two inline-handler mounts in the first place — the divergence and the
// blindness hid each other. Both are fixed; these assertions are what keeps them fixed.
// ─────────────────────────────────────────────────────────────────────────────
/** Mirror of the scanner's own matcher: exact, or on a `/`-segment boundary. */
const coveredByScanner = (p: string): boolean =>
  PUBLIC_BY_DESIGN.some((entry) => p === entry || p.startsWith(`${entry}/`));

describe('route auditor — PUBLIC_BY_DESIGN and the CI UNGUARDED_ALLOWLIST stay in sync', () => {
  it('every CI-reviewed unguarded mount is also public-by-design to the scanner', () => {
    // Direction 1 — the Security Center must not report a standing HIGH finding for a mount a
    // human already reviewed in CI. Limiter-only registrations are derived by the shared
    // classifier and therefore never enter this anonymous-handler allowlist.
    const missing = UNGUARDED_ALLOWLIST
      .filter((e) => !coveredByScanner(e.path))
      .map(
        (e) =>
          `${e.path} is reviewed-unguarded in tests/helpers/unguarded-route-allowlist.ts but is NOT ` +
          `covered by PUBLIC_BY_DESIGN in src/features/security/route-audit.ts — the Security Center ` +
          `will show it as a standing HIGH route_auth finding. Add it there with the same reviewed ` +
          `reason (or remove it here if the mount got guarded).`,
      );
    expect(missing).toEqual([]);
  });

  it('every CORE mount the scanner declares public-by-design is reviewed in the CI list', () => {
    // Direction 2 — the scanner must not silently whitelist a core mount nobody reviewed. Only
    // CORE (server.ts) mounts are in scope: PUBLIC_BY_DESIGN additionally covers generic prefixes
    // that server.ts may not mount at all (/api/webhook, /api/oidc, …) and ADR-085 PACKAGE mounts
    // that server.ts never sees, and the CI inventory spec only scans server.ts.
    const reviewed = new Set(UNGUARDED_ALLOWLIST.map((e) => e.path));
    const serverSource = fs.readFileSync(REAL_SERVER_TS, 'utf8');
    const unreviewed = PUBLIC_BY_DESIGN
      // Is this entry a literal path server.ts actually mounts? If not, it is a generic prefix or
      // a package path and the CI inventory spec has nothing to say about it.
      .filter((entry) => new RegExp(`app\\.(use|get|post|put|patch|delete|all)\\s*\\(\\s*['"\`]${entry.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&')}['"\`]`).test(serverSource))
      .filter((entry) => !reviewed.has(entry))
      .map(
        (entry) =>
          `${entry} is allow-listed in PUBLIC_BY_DESIGN and IS mounted in server.ts, but has no ` +
          `reviewed entry in tests/helpers/unguarded-route-allowlist.ts. The scanner is staying ` +
          `quiet about a core mount no CI review covers — add the {path, reason} entry after ` +
          `reading the route module, or drop the scanner entry.`,
      );
    expect(unreviewed).toEqual([]);
  });
});

describe('route auditor — inline and array method coverage', () => {
  it('the scanner is not blind to inline-handler mounts (app.get/app.post)', () => {
    // THE blindness pin. auditRoutes() matched only `app.use(` until 2026-07-29, so an
    // anonymous `app.post('/api/x', handler)` produced NO finding — a clean report for the wrong
    // reason. If the parser regresses to app.use-only, this synthetic mount stops firing.
    const file = syntheticServer(
      `app.post('/api/synthetic-inline-post', (req, res) => res.json({ ok: true }));\n` +
      `app.get('/api/synthetic-inline-get', (req, res) => res.json({ ok: true }));\n`,
    );
    const report = auditRoutes(file);
    expect(report.findings.map((f) => f.fingerprint).sort()).toEqual([
      'route_auth:/api/synthetic-inline-get',
      'route_auth:/api/synthetic-inline-post',
    ]);
  });

  it('an inline-handler mount WITH requiresAuth stays quiet, and array paths are read', () => {
    const file = syntheticServer(
      `app.get('/api/synthetic-inline-guarded', requiresAuth, (req, res) => res.json({}));\n` +
      `app.get(['/api/synthetic-arr-a', '/api/synthetic-arr-b'], (req, res) => res.json({}));\n`,
    );
    const report = auditRoutes(file);
    // The guarded inline mount produces nothing; BOTH array paths are reported individually
    // (an array-of-paths first argument used to yield no paths at all, i.e. a silent skip).
    expect(report.findings.map((f) => f.fingerprint).sort()).toEqual([
      'route_auth:/api/synthetic-arr-a',
      'route_auth:/api/synthetic-arr-b',
    ]);
  });
});

describe('route auditor — parser (the truncating-regex guard)', () => {
  it('sees a guard declared AFTER a parenthesised middleware (the /api/vision shape)', () => {
    const file = syntheticServer(
      `app.use('/api/synthetic-vision', express.json({ limit: '12mb' }), serviceSecretOr(requiresAuth), createVisionRoutes(ctx));\n`,
    );
    const report = auditRoutes(file);
    expect(
      report.findings,
      'a guard after express.json({...}) was invisible to the old first-close-paren regex',
    ).toEqual([]);
  });

  it('still fires on a genuinely unguarded mount (the scanner is alive)', () => {
    const file = syntheticServer(
      `app.use('/api/synthetic-open', express.json({ limit: '12mb' }), createOpenRoutes(ctx));\n`,
    );
    const report = auditRoutes(file);
    expect(report.findings.map((f) => f.fingerprint)).toEqual(['route_auth:/api/synthetic-open']);
  });

  it('handles multi-line mounts and skips limiter-only mounts', () => {
    const file = syntheticServer(
      `app.use(\n  '/api/synthetic-multiline',\n  requiresAuth,\n  createRoutes({ pool: ctx.pool }),\n);\n` +
      `app.use('/api/synthetic-limited', expensiveOpLimiter);\n`,
    );
    const report = auditRoutes(file);
    expect(report.findings).toEqual([]);
  });

  it('allowlist matching is slash-boundary, not bare prefix', () => {
    // '/api/apply' is public-by-design; '/api/apply-evil' must NOT ride along on startsWith.
    const file = syntheticServer(
      `app.use('/api/apply/sub', createIngest(ctx));\napp.use('/api/apply-evil', createEvil(ctx));\n`,
    );
    const report = auditRoutes(file);
    expect(report.findings.map((f) => f.fingerprint)).toEqual(['route_auth:/api/apply-evil']);
  });

  it('ignores mounts that only exist inside comments', () => {
    const file = syntheticServer(
      `// app.use('/api/synthetic-commented', createRoutes(ctx));\n/* app.use('/api/synthetic-block', createRoutes(ctx)); */\n`,
    );
    const report = auditRoutes(file);
    expect(report.findings).toEqual([]);
    expect(report.note).toContain('inspected 0 /api mounts');
  });
});

describe('route auditor - delegated-user guard', () => {
  it('does not report a route wrapped by SEC-01 delegation or ordinary user auth', () => {
    const file = syntheticServer(
      `app.use('/api/synthetic-delegated', delegatedUserRouteAuth, createRoutes(ctx));\n`,
    );
    expect(auditRoutes(file).findings).toEqual([]);
  });
});
