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
 *
 * @module features/security/route-audit
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChildLogger } from '@/shared/logger';
import { resolveRouteAuthMode } from '@/shared/route-auth';
import type { RawFinding, ScannerReport } from './types';

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

/** @description One extracted `app.use('/api/…', …)` mount. */
interface ServerMount {
  mountPath: string;
  /** Full middleware argument text (everything after the path argument). */
  middlewares: string;
  line: number;
}

/**
 * @description Extract every `app.use('<path literal starting /api/>', …)` mount from server.ts
 * source, with its FULL balanced argument text. `app.get/post/…` inline handlers are out of
 * scope here (deliberately minimal, matching this scanner's historical scope); the CI-side
 * inventory spec covers all methods.
 * @param source - Raw server.ts source.
 * @returns The mount inventory.
 */
function extractServerMounts(source: string): ServerMount[] {
  const stripped = stripComments(source);
  const mounts: ServerMount[] = [];
  const starts = /\bapp\.use\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = starts.exec(stripped)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const args = balancedArgs(stripped, openIdx);
    if (args === null) continue;
    const lead = args.trimStart();
    const pathMatch = lead.match(/^(['"`])(\/api\/[^'"`]*)\1/);
    if (!pathMatch) continue;
    // Middlewares = everything after the path literal and its separating comma.
    const rest = lead.slice(pathMatch[0].length).replace(/^\s*,/, '');
    const line = stripped.slice(0, m.index).split('\n').length;
    mounts.push({ mountPath: pathMatch[2], middlewares: rest, line });
  }
  return mounts;
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

  const findings: RawFinding[] = [];
  const mounts = extractServerMounts(text);
  for (const mount of mounts) {
    if (isPublicByDesign(mount.mountPath)) continue;
    const hasAuth = /requiresAuth|requireAuth|ensureAuth|authMiddleware|requiresContext/.test(mount.middlewares);
    if (hasAuth) continue;
    // A mount whose ONLY middleware is a rate limiter registers no handlers — nothing is
    // exposed here; the real routes for the path mount separately (with their own auth).
    if (/^\s*[A-Za-z_$][\w$]*Limiter\s*$/.test(mount.middlewares)) continue;
    findings.push({
      category: 'route_auth',
      severity: 'high',
      title: `Route ${mount.mountPath} mounted without requiresAuth`,
      detail: `${mount.mountPath} is mounted in server.ts (line ${mount.line}) without the requiresAuth middleware. `
        + `Auth is opt-in per route in this codebase, so unless this endpoint is meant to be public, its data/actions are reachable unauthenticated. `
        + `Add requiresAuth to the mount, or add the path to the public-by-design allow-list if it is intentional.`,
      source: `src/app/server.ts:${mount.line}`,
      evidence: { mountPath: mount.mountPath, line: mount.line, middlewares: mount.middlewares.trim().slice(0, 200) },
      fingerprint: `route_auth:${mount.mountPath}`,
    });
  }

  // ADR-085 D2: carved apps mount their routes dynamically — server.ts never sees them. Any
  // declaration resolving to `public` mounts ANONYMOUS (empty guard chain in the mounter), so
  // it must either be public-by-design (reviewed self-guard) or it is a finding. Non-public
  // modes are guarded by the mounter itself and need no flagging here.
  const manifestCount = manifestRoutes?.length ?? 0;
  const seen = new Set<string>();
  for (const decl of manifestRoutes ?? []) {
    const mode = resolveRouteAuthMode({ auth: decl.auth, requiresAuth: decl.requiresAuth });
    if (mode !== 'public') continue;
    if (isPublicByDesign(decl.mountPath)) continue;
    const fingerprint = `route_auth:manifest:${decl.mountPath}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    findings.push({
      category: 'route_auth',
      severity: 'high',
      title: `Package route ${decl.mountPath} declared auth: public`,
      detail: `App '${decl.appName}' declares ${decl.mountPath} with auth mode 'public' in its manifest routes[], `
        + `so the framework mounts it with NO guard chain — it is anonymous-callable unless the router self-guards. `
        + `Verify the package router carries its own fail-closed guard (token/secret/HMAC) and add the path to the `
        + `public-by-design allow-list citing that guard, or change the manifest declaration to a guarded auth mode.`,
      source: `manifest:${decl.appName}`,
      evidence: { mountPath: decl.mountPath, appName: decl.appName, declaredAuth: decl.auth ?? null },
      fingerprint,
    });
  }

  return {
    kind: 'posture',
    available: true,
    findings,
    categories: ['route_auth'],
    note: `inspected ${mounts.length} /api mounts in ${path.relative(root, file).replace(/\\/g, '/')}`
      + (manifestRoutes ? ` + ${manifestCount} active manifest route declarations` : ' (no manifest route inventory supplied)'),
  };
}
