/**
 * Route auth audit (posture) — Security Center (ADR-055).
 *
 * Auth in this codebase is opt-in PER ROUTE (a mount must explicitly include the `requiresAuth`
 * middleware — see CLAUDE.md / the trading mount). That is flexible but easy to forget, and a
 * forgotten gate means an app's data is reachable unauthenticated. This scanner reads the
 * server mount table and flags any `/api/*` mount that does NOT pass `requiresAuth`, excluding
 * the handful of routes that are public by design (health, auth handshakes, webhooks).
 *
 * It also walks the ACTIVE app manifests' `routes[]` (ADR-085 D2): carved apps mount dynamically
 * via ManifestRouteMounterImpl, never through server.ts, so a server.ts-only scan decays as apps
 * carve. A manifest route resolving to `public` mounts with an EMPTY guard chain — exactly the
 * anonymous-by-omission shape this scanner exists to catch.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Allow-list the verified self-guarded mounts (world/alerts/lora/remote-clients/trading-charts — each carries its own token/secret/session guard INSIDE the router) and skip limiter-only app.use() mounts (e.g. '/api/intake' + expensiveOpLimiter registers no handlers; the real routes mount separately with requiresAuth). These six were the standing false positives in the Security Center.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 1 carve #3: dropped '/api/lora' from the allow-list — LoRA Studio carved to the store; core no longer hard-mounts the path, and the package's split mounts declare their auth modes in the manifest.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 3 carve: dropped '/api/world' from the allow-list — World Intelligence carved to the store; core no longer hard-mounts the path (lora precedent). The WORLD_INGEST_TOKEN fail-closed write guard ships unchanged in the package route.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 3 carve: dropped '/api/trading-charts' from the allow-list — the trading surface carved to the store; core no longer hard-mounts the path (lora/world precedent). The /bars callerSub 401 self-gate ships unchanged in the package route (declared auth: public in its manifest).
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Three fixes from the route-audit diagnosis: (1) PARSER — the old MOUNT_RE captured middlewares with [^)]* which stopped at the FIRST close-paren, so `app.use('/api/vision', express.json({ limit: '12mb' }), serviceSecretOr(requiresAuth), …)` truncated before requiresAuth was seen → standing false positive; replaced with the string-aware comment-strip + balanced-paren argument walk proven in tests/unit/server-route-auth-inventory.spec.ts. (2) MANIFEST WALK — auditRoutes() now accepts the active manifests' routes[] and flags any declaration resolving to `public` (via the shared resolveRouteAuthMode, fail-closed on omission) that is not public-by-design — the mounter mounts `public` with an empty guard chain, and carved apps are invisible to the server.ts scan. (3) PUBLIC_BY_DESIGN reconciled against the actual current routes: added '/api/profile-studio' (server.ts:1003, service-secret self-guarded — was the second standing false positive) and the five reviewed anonymous package mounts (world / trading-charts / lora/ingest / vids-public / hello-oshal — the complete auth:public-or-requiresAuth:false set across the live stack's ACTIVE manifests, verified against swarm_applications 2026-07-24); matching tightened from bare startsWith to exact-or-slash-boundary so '/api/apply' can never silently whitelist '/api/apply-operator'.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Allow-listed '/api/sms' — the inbound Twilio SMS webhook mounts anonymous by design (machine-to-machine) and self-guards with the X-Twilio-Signature verification (verifyTwilioSignature) against TWILIO_AUTH_TOKEN inside the router: 503 when the token is unset, 403 on a bad signature, never open by omission (mirrors the /api/alerts entry). The CI-side sibling (tests/unit/server-route-auth-inventory.spec.ts) carries the matching reviewed entry.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | CLOSED THE METHOD BLIND SPOT. This scanner matched only `app.use(` — its own docblock declared `app.get`/`app.post` "out of scope" — so four unguarded /api mounts registered as INLINE HANDLERS were structurally invisible to it, and the Security Center reported "0 route_auth findings" while unable to see a whole class of mount. Two of those four ('/api/security/csp-report' and '/api/branding') were not covered by PUBLIC_BY_DESIGN at all; the CI-side spec's UNGUARDED_ALLOWLIST was the only place they had ever been reviewed, which is exactly the divergence the two lists were supposed to prevent. extractServerMounts now walks app.use/get/post/put/patch/delete/all (the parser the CI-side sibling already used) and accepts an array-of-paths first argument, and the two inline mounts are allow-listed here citing their reviewed guards. Inventory went 81 -> 87 /api mounts. Pinned by the new programmatic sync check in tests/unit/route-audit.spec.ts, which imports BOTH lists and asserts the containment relationship so they can no longer drift silently.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Closed the remaining module/mixed/non-/api blind spot with executable route-surface contracts. Security Center now verifies the internal fail-closed guards for /api/hooks, /auth/facebook/data-deletion, /api/channels/telegram/webhook, and /node/* instead of silently omitting or over-classifying them.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Decomposed auditRoutes into focused literal-mount and manifest collectors so the expanded scanner remains below the repository's fifty-line function limit.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Exported one limiter-only classification rule for both the runtime scanner and CI inventory, eliminating manual allowlist entries that went stale/red on every new rate-limiter mount.
 *
 * @module features/security/route-audit
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChildLogger } from '@/shared/logger';
import { resolveRouteAuthMode } from '@/shared/route-auth';
import type { RawFinding, ScannerReport } from './types';
import { auditRouteSurfaceContracts, ROUTE_SURFACE_CONTRACTS } from './route-surface-contracts';

const logger = createChildLogger({ module: 'security:route-audit' });

/**
 * @description Mounts that are intentionally public — not auth gaps. Matched exact or on a
 * `/`-segment boundary (`/api/apply` covers `/api/apply/ingest`, never `/api/apply-operator`).
 * Every self-guarded entry MUST cite the internal guard it was reviewed against; re-verify the
 * guard before adding an entry. Exported so the regression spec can keep this list honest.
 */
export const PUBLIC_BY_DESIGN: readonly string[] = [
  '/api/health', '/api/healthz', '/api/ready', '/api/livez', '/api/metrics',
  '/api/auth', '/api/login', '/api/logout', '/api/callback', '/api/oidc',
  '/api/webhook', '/api/webhooks', '/api/public', '/api/connect/callback',
  // Self-guarded CORE mounts (verified 2026-07-08, re-reconciled 2026-07-24): auth lives INSIDE
  // the router, so the mount legitimately lacks requiresAuth. Re-verify the internal guard
  // before adding to this list.
  '/api/alerts',         // Alertmanager webhook — ALERT_WEBHOOK_TOKEN bearer guard, fail-closed
  '/api/sms',            // Inbound SMS webhook (Twilio) — X-Twilio-Signature verified vs TWILIO_AUTH_TOKEN
                         // inside the router (verifyTwilioSignature at sms-inbound-routes.ts); 503 when the
                         // token is unset, 403 on a bad/missing signature — never open by omission
  '/api/remote-clients', // router-level authorizeRemoteClient (OIDC session OR shared-secret header)
  '/api/apply',          // box callback ingest — every route requires the service secret (serviceSecretOk)
  '/api/profile-studio', // LinkedIn profile-plan box callback — POST /ingest 401s without the service
                         // secret (serviceSecretOk at profile-studio-ingest-routes.ts:43, fail-closed
                         // when SWARM_SERVICE_SECRET is unset; mirrors /api/apply)
  // Self-guarded PACKAGE mounts (ADR-085 D2 `auth: public` declarations, reviewed 2026-07-24):
  // the store package's router self-guards, so the anonymous mount is deliberate. Only NEW
  // public package routes should fire.
  '/api/world',          // WORLD_INGEST_TOKEN fail-closed write guard inside the package router;
                         // reads are the deliberately-open shared feed (world/oshal-app.yaml)
  '/api/trading-charts', // vendored MIT chart lib is a public JS asset; GET /bars self-gates via
                         // callerSub() → 401 (trading/oshal-app.yaml)
  '/api/lora/ingest',    // box→controller callback — router self-guards on x-service-secret
                         // (lora/oshal-app.yaml split-mount pattern; /api/lora proper stays oidc)
  '/api/vids-public',    // read-only published-renders surface — router self-guards (slug + file
                         // validation, published-dir only, no listing, fail-closed 404)
  '/api/hello-oshal',    // the sample app package (legacy requiresAuth:false ⇒ public) — /ping
                         // returns a static hello JSON only; no data, no actions, nothing to guard
  // INLINE-HANDLER mounts (app.post/app.get in server.ts, reviewed 2026-07-29). These became
  // visible only when this scanner stopped matching app.use() alone; before that they were
  // reviewed exclusively in tests/unit/server-route-auth-inventory.spec.ts's UNGUARDED_ALLOWLIST.
  // Both reasons are copied from that list so the two stay word-for-word reconcilable.
  '/api/security/csp-report', // CSP violation report collector — browsers POST reports with no
                              // session; the inline handler logs the violated directive and returns
                              // 204, parsing only the CSP report content-types. No data returned.
  '/api/branding',            // pre-login branding lookup — the inline handler returns only the
                              // SERVICE_NAME / DISPLAY_NAME / TITLE env values. No user data, and
                              // the login surfaces need it before a session exists.
];

/** @description Is this mount path covered by the public-by-design list (exact or `/`-boundary)? */
function isPublicByDesign(mountPath: string): boolean {
  return PUBLIC_BY_DESIGN.some((p) => mountPath === p || mountPath.startsWith(`${p}/`));
}

/**
 * @description One active-manifest route declaration, as the auditor needs it (ADR-085 D2).
 * Declared locally — features/security must not import features/swarm-apps (FSD same-layer rule);
 * the caller (the app layer) maps SwarmAppRouteDeclaration down to this plain shape.
 */
export interface ManifestRouteAuditEntry {
  /** Owning app (manifest `name`), for the finding's source. */
  appName: string;
  /** Where the mounter mounts it. */
  mountPath: string;
  /** Declared auth mode (`routes[].auth`); omission resolves to `oidc`, fail-closed. */
  auth?: string;
  /** @deprecated Legacy boolean (`false` ⇒ public). `auth` wins. */
  requiresAuth?: boolean;
}

/**
 * @description Replace comments with spaces (newlines preserved so indices keep their line
 * numbers) while leaving string/template literals intact — a `//` inside a URL string must not
 * eat the rest of the line, and a mount example inside a comment must not become a mount.
 * (Same idiom as tests/unit/server-route-auth-inventory.spec.ts, the CI-side sibling.)
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
 * strings, `express.json({ limit: '12mb' })`, or `serviceSecretOr(requiresAuth)` cannot
 * truncate the walk (the old `[^)]*` regex stopped at the first `)`, hiding guards declared
 * after a parenthesised middleware).
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

/** @description One extracted `app.<method>('/api/…', …)` mount. */
interface ServerMount {
  mountPath: string;
  /** The Express method the mount was registered with (`use`, `get`, `post`, …). */
  method: string;
  /** Full middleware argument text (everything after the path argument). */
  middlewares: string;
  line: number;
}

/** Express registration methods that can expose an `/api/*` path. */
const MOUNT_METHOD_RE = /\bapp\.(use|get|post|put|patch|delete|all)\s*\(/g;

/**
 * @description Parse a mount's leading path argument(s) and return both the `/api/*` literals it
 * claims and the remaining argument text. Two shapes occur in server.ts: a single string literal,
 * and an array of string literals (`app.get(['/a', '/b'], …)`). A non-literal first argument
 * (a variable, or `express.static(dir)`) yields no paths and the mount is ignored — this scanner
 * can only reason about paths it can read statically.
 * @param args - The mount's full balanced argument text.
 * @returns The `/api/*` paths claimed plus the middleware text that follows them.
 */
function splitPathsAndMiddlewares(args: string): { paths: string[]; middlewares: string } {
  const lead = args.trimStart();
  const single = lead.match(/^(['"`])(\/api\/[^'"`]*)\1/);
  if (single) {
    return { paths: [single[2]], middlewares: lead.slice(single[0].length).replace(/^\s*,/, '') };
  }
  if (lead.startsWith('[')) {
    const close = lead.indexOf(']');
    if (close === -1) return { paths: [], middlewares: '' };
    const arr = lead.slice(0, close + 1);
    const paths = [...arr.matchAll(/(['"`])([^'"`]*)\1/g)]
      .map((m) => m[2])
      .filter((p) => p.startsWith('/api/'));
    return { paths, middlewares: lead.slice(arr.length).replace(/^\s*,/, '') };
  }
  return { paths: [], middlewares: '' };
}

/**
 * @description Extract every `app.<method>('<path literal starting /api/>', …)` mount from
 * server.ts source, with its FULL balanced argument text.
 *
 * WHY all methods (changed 2026-07-29): matching `app.use(` alone made INLINE-HANDLER mounts
 * structurally invisible — `app.post('/api/security/csp-report', handler)` and
 * `app.get('/api/branding', handler)` are anonymous-callable in exactly the way this scanner
 * exists to catch, and it could not see them. A scanner that cannot see a class of mount reports
 * "clean" for the wrong reason, which is worse than reporting a finding. This is the same method
 * set the CI-side sibling (tests/unit/server-route-auth-inventory.spec.ts) has always used.
 * @param source - Raw server.ts source.
 * @returns The mount inventory (one entry per claimed `/api/*` path).
 */
function extractServerMounts(source: string): ServerMount[] {
  const stripped = stripComments(source);
  const mounts: ServerMount[] = [];
  const starts = new RegExp(MOUNT_METHOD_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = starts.exec(stripped)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const args = balancedArgs(stripped, openIdx);
    if (args === null) continue;
    const { paths, middlewares } = splitPathsAndMiddlewares(args);
    if (!paths.length) continue;
    const line = stripped.slice(0, m.index).split('\n').length;
    for (const mountPath of paths) {
      mounts.push({ mountPath, method: m[1], middlewares, line });
    }
  }
  return mounts;
}

function auditServerMounts(mounts: readonly ServerMount[]): RawFinding[] {
  return mounts
    .filter((mount) => !isReviewedOrGuardedMount(mount))
    .map(serverMountFinding);
}

function isReviewedOrGuardedMount(mount: ServerMount): boolean {
  if (isPublicByDesign(mount.mountPath)) return true;
  const hasAuth = /requiresAuth|requireAuth|ensureAuth|authMiddleware|requiresContext/.test(mount.middlewares);
  if (hasAuth) return true;
  // A mount whose ONLY middleware is a rate limiter registers no handlers. The real
  // routes for that path mount separately and carry their own authorization.
  return isLimiterOnlyMiddleware(mount.middlewares);
}

/**
 * @description True only when a mount's complete post-path argument text is one
 * limiter identifier and therefore registers no route handler. Shared with the CI
 * inventory so adding a limiter-only mount cannot require a second allowlist entry.
 * @param middlewares - Text after the Express mount's path argument.
 * @returns Whether this registration contains a limiter and no handler/router.
 */
export function isLimiterOnlyMiddleware(middlewares: string): boolean {
  return /^\s*[A-Za-z_$][\w$]*Limiter\s*$/.test(middlewares);
}

function serverMountFinding(mount: ServerMount): RawFinding {
  return {
    category: 'route_auth',
    severity: 'high',
    title: `Route ${mount.mountPath} mounted without requiresAuth`,
    detail: `${mount.mountPath} is mounted in server.ts (app.${mount.method} at line ${mount.line}) without the requiresAuth middleware. `
      + `Auth is opt-in per route in this codebase, so unless this endpoint is meant to be public, its data/actions are reachable unauthenticated. `
      + `Add requiresAuth to the mount, or add the path to the public-by-design allow-list if it is intentional.`,
    source: `src/app/server.ts:${mount.line}`,
    evidence: {
      mountPath: mount.mountPath,
      method: mount.method,
      line: mount.line,
      middlewares: mount.middlewares.trim().slice(0, 200),
    },
    fingerprint: `route_auth:${mount.mountPath}`,
  };
}

function auditManifestRoutes(entries: readonly ManifestRouteAuditEntry[]): RawFinding[] {
  const findings: RawFinding[] = [];
  const seen = new Set<string>();
  for (const declaration of entries) {
    const mode = resolveRouteAuthMode({ auth: declaration.auth, requiresAuth: declaration.requiresAuth });
    if (mode !== 'public' || isPublicByDesign(declaration.mountPath)) continue;
    const fingerprint = `route_auth:manifest:${declaration.mountPath}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    findings.push(manifestRouteFinding(declaration, fingerprint));
  }
  return findings;
}

function manifestRouteFinding(
  declaration: ManifestRouteAuditEntry,
  fingerprint: string,
): RawFinding {
  return {
    category: 'route_auth',
    severity: 'high',
    title: `Package route ${declaration.mountPath} declared auth: public`,
    detail: `App '${declaration.appName}' declares ${declaration.mountPath} with auth mode 'public' in its manifest routes[], `
      + `so the framework mounts it with NO guard chain — it is anonymous-callable unless the router self-guards. `
      + `Verify the package router carries its own fail-closed guard (token/secret/HMAC) and add the path to the `
      + `public-by-design allow-list citing that guard, or change the manifest declaration to a guarded auth mode.`,
    source: `manifest:${declaration.appName}`,
    evidence: {
      mountPath: declaration.mountPath,
      appName: declaration.appName,
      declaredAuth: declaration.auth ?? null,
    },
    fingerprint,
  };
}

/**
 * @description Audit route-auth posture: the Express mount table in server.ts (any `/api/*`
 * mount without `requiresAuth`) PLUS the active app manifests' `routes[]` (any declaration
 * resolving to `public` — the mounter mounts those with an empty guard chain).
 * @param serverFile - Path to server.ts (defaults under SECURITY_SCAN_ROOT/process.cwd()).
 * @param manifestRoutes - Active manifests' route declarations (omit ⇒ server.ts-only, the
 *   pre-2026-07-24 behavior — existing callers stay green).
 * @returns The posture report (category `route_auth`).
 */
export function auditRoutes(serverFile?: string, manifestRoutes?: ManifestRouteAuditEntry[]): ScannerReport {
  const root = process.env.SECURITY_SCAN_ROOT || process.cwd();
  const file = serverFile || path.join(root, 'src', 'app', 'server.ts');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    logger.warn({ err, file }, 'route audit: server.ts not readable');
    return { kind: 'posture', available: false, findings: [], categories: ['route_auth'], note: `server.ts not found at ${file}` };
  }

  const mounts = extractServerMounts(text);
  const manifestCount = manifestRoutes?.length ?? 0;
  const findings = [
    ...auditServerMounts(mounts),
    // These are structurally outside the literal /api classifier. Their contracts turn
    // guard drift into HIGH findings instead of accepting a vacuous "not observed" result.
    ...auditRouteSurfaceContracts(text, root),
    // ADR-085 packages mount dynamically, so server.ts never contains their route literals.
    ...auditManifestRoutes(manifestRoutes ?? []),
  ];

  return {
    kind: 'posture',
    available: true,
    findings,
    categories: ['route_auth'],
    note: `inspected ${mounts.length} /api mounts in ${path.relative(root, file).replace(/\\/g, '/')}`
      + ` + ${ROUTE_SURFACE_CONTRACTS.filter((contract) => text.includes(contract.registrationMarker)).length} active non-standard route contracts`
      + (manifestRoutes ? ` + ${manifestCount} active manifest route declarations` : ' (no manifest route inventory supplied)'),
  };
}
