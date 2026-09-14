/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted UNGUARDED_ALLOWLIST out of tests/unit/server-route-auth-inventory.spec.ts so a SECOND spec can import it. The backlog's done-when for the route-audit allowlist gap asks for a programmatic cross-check between this reviewed list and src/features/security/route-audit.ts's PUBLIC_BY_DESIGN; until now the two referenced each other only in prose comments and could diverge silently forever (they had — '/api/security/csp-report' and '/api/branding' lived here and nowhere in PUBLIC_BY_DESIGN). Importing a spec file from another spec would re-register its suites, so the shared data moves to this plain module instead. Content is unchanged from the spec's version; the reviewed reasons ARE the artifact.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added the '/api/jarvis' limiter-only entry (+ LIMITER_ONLY_PATHS). The web-hardening close-out mounted expensiveOpLimiter on /api/jarvis, which registers no handlers, but the CI-side inventory classifies limiter-only mounts by ALLOWLIST while the runtime scanner skips them BY RULE - so the gate went red on main the moment that mount landed, on a path whose every real router is guarded (serviceSecretOr(requiresAuth) + two requiresAuth mounts). Mirrors the /api/intake entry exactly. The asymmetry itself is the real defect and is named in the entry's reason: the parser should learn the scanner's Limiter rule so the next such mount does not repeat this.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Removed limiter-only mounts from the reviewed anonymous-route allowlist. The CI inventory now applies the runtime scanner's shared isLimiterOnlyMiddleware rule, so a limiter registration is derived as handler-less rather than manually waived.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Re-review Profile Studio's non-OIDC callback as short-lived, one-use, exact-dispatch capability authenticated after removal of the reusable fleet secret.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Review the three /api/authorization, /api/authorization/tenant-memberships and /api/user-directory mounts. All 14 routes beneath them ARE guarded: requiresAuth is passed into the factory (the CLAUDE.md-blessed shape) instead of wrapping the mount, and each factory applies it as its first router.use. This spec and the runtime scanner both classify posture on the literal substring requiresAuth in the mount text, so both had been standing red on a false positive. Deliberately NOT fixed by teaching the parser to follow the deps variable: the presence of requiresAuth in an object does not prove it is applied, and inferring a guard from a substring is the exact trap this repo has already paid for. A reviewed entry demands someone read the module, which is the stronger contract.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Re-review Apply ingest as a hashed one-use
 *   exact-task capability; internal queue controls retain constant-time service authentication and
 *   the former interactive secret-bearing callbacks are terminally retired.
 */

/**
 * @description One reviewed unguarded `/api` mount in `src/app/server.ts`.
 *
 * WHY a written reason is mandatory: `src/shared/middleware/oidc.ts` runs with
 * `authRequired: false`, so a mount that omits `requiresAuth` is anonymous-callable. An entry
 * here asserts that a human READ the mounted route module (or the inline handler) end-to-end and
 * confirmed either an internal fail-closed guard or deliberate public-ness. A stub reason is a
 * lie the guards below actively reject.
 */
export interface UnguardedRouteEntry {
  /** The `/api/...` mount path exactly as server.ts declares it. */
  path: string;
  /** Why it is safe unguarded — cite the internal guard's file:line, or why nothing needs guarding. */
  reason: string;
}

/**
 * @description THE ALLOWLIST. Every entry was populated by READING the mounted route module (or
 * the inline handler) and confirming either an internal guard or deliberate public-ness.
 *
 * If `tests/unit/server-route-auth-inventory.spec.ts` just failed on a mount you added: add a
 * guard to the mount, or read your route module end-to-end and add `{path, reason}` here with the
 * file:line of its internal guard. Never add an entry without that reading.
 *
 * KEEP IN SYNC with `PUBLIC_BY_DESIGN` in `src/features/security/route-audit.ts` — the runtime
 * Security Center scanner. `tests/unit/route-audit.spec.ts` imports both and fails on divergence,
 * so an entry added here without the matching scanner entry goes red in the same CI run.
 */
export const UNGUARDED_ALLOWLIST: readonly UnguardedRouteEntry[] = [
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
    path: '/api/apply',
    reason:
      'Apply machine plane — internal dispatch/enqueue/batch routes use constant-time serviceSecretOk; ' +
      'POST /ingest requires a syntactically valid x-oshal-callback-capability whose SHA-256 digest is ' +
      'atomically reserved/consumed only for its exact task, owner, ticket, posting, client, generation, ' +
      'operation, and expiry. Email/vault/shot callbacks return 410. OIDC would break the leaf daemon.',
  },
  {
    path: '/api/profile-studio',
    reason:
      'LinkedIn profile-plan desktop callback — POST /ingest 401s without a syntactically valid ' +
      'x-oshal-callback-capability, then atomically consumes its hash only when exact owner, generation, ' +
      'task, client, operation, and expiry match. Replays and stale ABA callbacks return 409.',
  },
  // ('/api/trading-charts' removed: the trading surface carved to the app store, ADR-085
  //  Wave 3 — server.ts no longer mounts the path (the stale-entry guard demands removal).
  //  The packaged route ships the same split posture: the vendored chart lib is a public MIT
  //  JS asset, GET /bars self-gates via callerSub() → 401, declared auth: public in the
  //  package manifest.)
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
  //  server.ts no longer mounts the path (the stale-entry guard demands removal). The
  //  packaged route ships the same self-guarded posture: WORLD_INGEST_TOKEN fail-closed
  //  writes, open shared-feed reads, ENABLE_WORLD_INTELLIGENCE 503 gate.)
  {
    path: '/api/authorization',
    reason:
      'Guarded, not anonymous - requiresAuth is PASSED IN rather than wrapped around the mount, which is the pattern CLAUDE.md explicitly blesses ("registerFooRoutes(app, requiresAuth, deps)"). server.ts L1139 builds ' +
      '{ requiresAuth, resolveActor, authorizationTool } from the same binding /api/providers uses (L587), and BOTH factories apply it as their FIRST router.use: authorization-routes.ts L57 (createAuthorizationRoutes) and ' +
      'L102 (createAuthorizationPageRoutes). Beneath it the actor resolver throws 401 without a verified sub/issuer and rejects the guest issuer outright, and every operation adds its own scope check (403). ' +
      'Wrapping the mount would add a second identical guard and change nothing observable. The inventory flags it only because it classifies posture on the literal substring requiresAuth in the mount TEXT, which ' +
      'this mount does not contain. NOTE: matching is exact-or-slash-boundary, so this entry also covers any FUTURE /api/authorization/* mount - a new child must be re-reviewed, never assumed.',
  },
  {
    path: '/api/authorization/tenant-memberships',
    reason:
      'Guarded, not anonymous - same passed-in requiresAuth as /api/authorization (server.ts L1139/L1141). external-tenant-membership-routes.ts L25 applies it as the first router.use, and the service re-checks ' +
      'currentAdmin (401/403) plus the .assign and .directory permissions around every apply. Listed explicitly even though the /api/authorization entry already covers it by slash-boundary, so removing the ' +
      'parent entry can never silently unreview this child.',
  },
  {
    path: '/api/user-directory',
    reason:
      'Guarded, not anonymous - same passed-in requiresAuth (server.ts L1139/L1143). user-directory-routes.ts L23 applies it as the first router.use and L26 adds a blanket requireRosterAdmin, which the roster read then ' +
      'enforces a SECOND time inside application-principal-directory.ts. This mount is the one of the three that would matter most if it were open - it returns the full user roster (sub, issuer, label falling back to ' +
      'email, status, lastSeenAt) - which is why it carries two independent admin checks rather than one.',
  },
];
