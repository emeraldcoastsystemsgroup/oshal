/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Route-auth INVENTORY guard: enumerate EVERY /api mount in server.ts and fail on any unguarded one that is not on the reviewed allowlist below. oidc.ts runs authRequired:false, so a mount without requiresAuth/serviceSecretOr/requiresOperator is anonymous-callable — and until now no test enumerated the mount table (every existing spec pins specific routes), so a new unwrapped /api mount shipped anonymous with no red. SCOPE: /api mounts registered directly via app.use/get/post/put/patch/delete/all in server.ts only. Out of scope for now (deliberately minimal): non-/api mounts (/shared, /cockpit, /welcome — static assets + HTML surfaces with their own guards) and register*(app, requiresAuth) helper modules, which carry requiresAuth by parameter and mount inside their own files. Runtime sibling: src/features/security/route-audit.ts (the Security Center scanner) — this spec is the CI-side version with a stricter parser (multi-line mounts, app.get/post as well as app.use).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Dropped the /api/world allowlist entry per the spec's own stale-entry instruction — World Intelligence carved to the app store (ADR-085 Wave 3), server.ts no longer mounts the path. The packaged route keeps the identical self-guarded posture (WORLD_INGEST_TOKEN fail-closed writes / open reads / ENABLE_WORLD_INTELLIGENCE 503).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Dropped the /api/trading-charts allowlist entry per the spec's own stale-entry instruction — the trading surface carved to the app store (ADR-085 Wave 3), server.ts no longer mounts any trading path. The packaged route keeps the identical split posture (public MIT chart lib / callerSub-gated /bars), declared auth: public in the package manifest. Anti-bitrot floors lowered with the four unmounts (90→85 inventory, 80→75 guarded — 87/78 remain; floors, not censuses).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';

// ─────────────────────────────────────────────────────────────────────────────
// THE ALLOWLIST. Every entry was populated by READING the mounted route module
// (or the inline handler) and confirming either an internal guard or deliberate
// public-ness. If this test just failed on a mount you added: add a guard to the
// mount, or read your route module end-to-end and add {path, reason} here with
// the file:line of its internal guard. Never add an entry without that reading.
// ─────────────────────────────────────────────────────────────────────────────
const UNGUARDED_ALLOWLIST: Array<{ path: string; reason: string }> = [
  {
    path: '/api/security/csp-report',
    reason:
      'CSP violation report collector — browsers POST reports without a session (inline handler in ' +
      'server.ts: logs the violated directive and returns 204; parses only the CSP report content-types).',
  },
  {
    path: '/api/branding',
    reason:
      'Public branding lookup — inline handler returns SERVICE_NAME/DISPLAY_NAME/TITLE env values only; ' +
      'no user data, needed by pre-login surfaces.',
  },
  {
    path: '/api/health',
    reason:
      'Extended health endpoint (public by design) — Docker healthcheck + monitors probe it without ' +
      'credentials; returns status/uptime/stream stats only.',
  },
  {
    path: '/api/auth/user',
    reason:
      'Auth-state probe for the cockpit profile widget — deliberately ungated so it always returns 200 ' +
      '(never a login redirect) and reports the REAL session state ({authenticated:false} when anonymous).',
  },
  {
    path: '/api/intake',
    reason:
      'Limiter-only mount — app.use(\'/api/intake\', expensiveOpLimiter) registers a rate limiter and no ' +
      'handlers; the real route POST /api/intake/fast mounts separately with requiresAuth ' +
      '(src/app/routes/fast-intake-routes.ts L36).',
  },
  {
    path: '/api/apply',
    reason:
      'Desktop-worker box callback — every route 401s without the service secret: serviceSecretOk() at ' +
      'src/app/routes/apply-ingest-routes.ts L35 (/dispatch) + L44 (/ingest); fail-closed when ' +
      'SWARM_SERVICE_SECRET is unset. Wrapping in requiresAuth would break the non-OIDC box.',
  },
  {
    path: '/api/profile-studio',
    reason:
      'LinkedIn profile-plan box callback — POST /ingest 401s without the service secret: ' +
      'serviceSecretOk() at src/app/routes/profile-studio-ingest-routes.ts L43; fail-closed when ' +
      'SWARM_SERVICE_SECRET is unset (mirrors /api/apply).',
  },
  // ('/api/trading-charts' removed: the trading surface carved to the app store, ADR-085
  //  Wave 3 — server.ts no longer mounts the path (the stale-entry guard below demands
  //  removal). The packaged route ships the same split posture: the vendored chart lib is a
  //  public MIT JS asset, GET /bars self-gates via callerSub() → 401, declared auth: public
  //  in the package manifest.)
  {
    path: '/api/remote-clients',
    reason:
      'Router-level fail-closed gate — router.use(authorizeRemoteClient) at ' +
      'src/app/routes/remote-client-routes.ts L89: OIDC session OR REMOTE_CLIENT_SHARED_SECRET bearer, ' +
      '401 otherwise; session callers are additionally device-ownership gated (requireDeviceAccess). ' +
      'Wrapping in requiresAuth would reject the bearer path remote bot-nodes use.',
  },
  {
    path: '/api/alerts',
    reason:
      'Prometheus Alertmanager webhook (machine-to-machine, no OIDC session possible) — fail-closed ' +
      'bearer guard on ALERT_WEBHOOK_TOKEN at src/app/routes/alertmanager-routes.ts L179-L193: with the ' +
      'token unset the receiver rejects EVERYTHING (401), so it is never open by omission.',
  },
  {
    path: '/api/sms',
    reason:
      'Inbound SMS webhook (Twilio, machine-to-machine, no OIDC session possible) — self-guards with the ' +
      'Twilio request signature (X-Twilio-Signature) verified against TWILIO_AUTH_TOKEN inside the router ' +
      '(verifyTwilioSignature in src/app/routes/sms-inbound-routes.ts): fail-closed 503 when the token is ' +
      'unset and 403 on a bad/missing signature, so it is never open by omission (mirrors /api/alerts).',
  },
  // ('/api/world' removed: World Intelligence carved to the app store, ADR-085 Wave 3 —
  //  server.ts no longer mounts the path (the stale-entry guard below demands removal). The
  //  packaged route ships the same self-guarded posture: WORLD_INGEST_TOKEN fail-closed
  //  writes, open shared-feed reads, ENABLE_WORLD_INTELLIGENCE 503 gate.)
];

// ─────────────────────────────────────────────────────────────────────────────
// server.ts source-scanning helpers. The existing single-line idiom
// (tests/unit/manifest-route-auth.spec.ts classifyMount) breaks on multi-line
// mounts — e.g. app.post('/api/security/csp-report', …) puts the path on its own
// line and /api/remote-clients spreads its middleware list over five. So this
// spec strips comments (string-aware) and then extracts each mount's FULL
// balanced-paren argument text before classifying it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @description Replace comments with spaces (newlines preserved so indices keep their line
 * numbers) while leaving string/template literals intact — a `//` inside a URL string must
 * not eat the rest of the line, and a mount example inside a comment must not become a mount.
 * @param src - Raw TypeScript source.
 * @returns Source of identical length/line structure with comments blanked.
 */
function stripComments(src: string): string {
  const out: string[] = [];
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let state: State = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const pair = c + (src[i + 1] ?? '');
    if (state === 'code') {
      if (pair === '//') { state = 'line'; out.push(' '); continue; }
      if (pair === '/*') { state = 'block'; out.push(' '); continue; }
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'template';
      out.push(c);
    } else if (state === 'line') {
      if (c === '\n') { state = 'code'; out.push(c); } else out.push(' ');
    } else if (state === 'block') {
      if (pair === '*/') { state = 'code'; out.push('  '); i++; } else out.push(c === '\n' ? c : ' ');
    } else {
      // Inside a string/template literal: copy verbatim, honour escapes, exit on the close quote.
      if (c === '\\') { out.push(c, src[i + 1] ?? ''); i++; continue; }
      if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'template' && c === '`')) {
        state = 'code';
      }
      out.push(c);
    }
  }
  return out.join('');
}

/**
 * @description Given comment-stripped source and the index of a mount's opening paren, return
 * the full argument text up to the MATCHING close paren — string-aware, so parens inside path
 * strings or template interpolations can not unbalance the walk.
 * @param text - Comment-stripped source.
 * @param openIdx - Index of the `(` that opens the call.
 * @returns The argument text (exclusive of the outer parens), or null when unterminated.
 */
function balancedArgs(text: string, openIdx: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  return null;
}

/**
 * @description Parse the mount's leading path argument(s): a string literal or an array of
 * string literals. Non-literal first args (e.g. the commented-out express.static mount) yield [].
 * @param args - The mount's full argument text.
 * @returns Every literal path the mount claims.
 */
function mountPaths(args: string): string[] {
  const lead = args.trimStart();
  const single = lead.match(/^(['"`])([^'"`]*)\1/);
  if (single) return [single[2]];
  if (lead.startsWith('[')) {
    const arr = lead.slice(0, lead.indexOf(']') + 1);
    return [...arr.matchAll(/(['"`])([^'"`]*)\1/g)].map((m) => m[2]);
  }
  return [];
}

/** One extracted mount from server.ts. */
interface Mount {
  method: string;
  paths: string[];
  args: string;
  line: number;
  mode: 'service-or-oidc' | 'operator' | 'oidc' | 'unguarded';
}

/**
 * @description Classify a mount's auth posture from its argument text (the manifest-route-auth
 * classifyMount idiom, widened): serviceSecretOr → service-or-oidc; requiresOperator → operator;
 * any requiresAuth (direct middleware OR passed into the route factory, which applies it
 * per-route — the /api/notify / claude-code-auth-routes pattern) → oidc; else unguarded.
 * @param args - The mount's full argument text.
 * @returns The posture.
 */
function classifyMount(args: string): Mount['mode'] {
  if (args.includes('serviceSecretOr')) return 'service-or-oidc';
  if (args.includes('requiresOperator')) return 'operator';
  if (args.includes('requiresAuth')) return 'oidc';
  return 'unguarded';
}

/**
 * @description Extract every app.<method>(…) mount whose path starts with /api/ from server.ts.
 * @param source - Raw server.ts source.
 * @returns The classified /api mount inventory.
 */
function extractApiMounts(source: string): Mount[] {
  const stripped = stripComments(source);
  const mounts: Mount[] = [];
  const starts = /\bapp\.(use|get|post|put|patch|delete|all)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = starts.exec(stripped)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const args = balancedArgs(stripped, openIdx);
    if (args === null) continue;
    const paths = mountPaths(args).filter((p) => p.startsWith('/api/'));
    if (!paths.length) continue;
    const line = stripped.slice(0, m.index).split('\n').length;
    mounts.push({ method: m[1], paths, args, line, mode: classifyMount(args) });
  }
  return mounts;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('server.ts /api route-auth inventory (the anonymous-by-omission guard)', () => {
  const source = readFileSync('src/app/server.ts', 'utf8');
  const mounts = extractApiMounts(source);
  const unguarded = mounts.filter((mt) => mt.mode === 'unguarded');

  // Vacuous-pass tripwire: if the parser bitrots (server.ts refactor, idiom change) the
  // inventory shrinks toward zero and every assertion below would pass while checking nothing.
  // (Floor 90→85 on 2026-07-20: the trading carve — the last Wave-G carve — unmounted its four
  //  surfaces (87 remain); an anti-bitrot floor, not a census, so it shrinks with the rips.)
  it('extracts the full /api mount inventory (parser is alive)', () => {
    expect(mounts.length).toBeGreaterThanOrEqual(85);
  });

  it('sees every guard posture in use (guard identifiers have not been renamed away)', () => {
    const modes = new Set(mounts.map((mt) => mt.mode));
    // If requiresAuth/serviceSecretOr/requiresOperator were renamed, mounts would drift into
    // 'unguarded' and the allowlist assertion below fails loudly — this pins the other side:
    // all three postures must remain represented so a silent mass-reclassification is impossible.
    // (Floor 80→75 on 2026-07-20: the trading carve removed three serviceSecretOr mounts —
    //  78 guarded remain; same anti-bitrot rationale as the inventory floor above.)
    expect(modes.has('oidc')).toBe(true);
    expect(modes.has('service-or-oidc')).toBe(true);
    expect(modes.has('operator')).toBe(true);
    expect(mounts.filter((mt) => mt.mode !== 'unguarded').length).toBeGreaterThanOrEqual(75);
  });

  // THE guard. authRequired:false means an unwrapped mount is anonymous-callable — every
  // unguarded /api mount must be individually reviewed and carry a written reason here.
  it('every unguarded /api mount is on the reviewed allowlist', () => {
    const allowed = new Set(UNGUARDED_ALLOWLIST.map((e) => e.path));
    const offenders = unguarded
      .flatMap((mt) => mt.paths.map((p) => ({ ...mt, path: p })))
      .filter((mt) => !allowed.has(mt.path))
      .map(
        (mt) =>
          `${mt.path} (app.${mt.method} at src/app/server.ts:${mt.line}) is mounted WITHOUT ` +
          `requiresAuth / serviceSecretOr / requiresOperator — it is anonymous-callable ` +
          `(oidc.ts runs authRequired:false). Either add a guard to the mount, or READ the ` +
          `route module end-to-end and add {path, reason} to UNGUARDED_ALLOWLIST in ` +
          `tests/unit/server-route-auth-inventory.spec.ts citing its internal guard.`,
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
          `${e.path} is allowlisted but no longer mounts unguarded in server.ts ` +
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
