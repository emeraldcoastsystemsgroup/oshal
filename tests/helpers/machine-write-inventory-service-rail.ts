/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Entries for the files the machine-auth discovery could not see until it matched the two helpers routes really use to admit the service rail (serviceSecretOr, getTrustedServiceUserSub; docs/backlog/machine-auth-discovery-blind-spot.md). Each was read end to end. Kept beside machine-write-inventory.ts so that file stays under the repository's decomposition threshold; it spreads this list into MACHINE_WRITE_INVENTORY.
 */

import type { MachineWriteEntry } from './machine-write-inventory';

/**
 * @description Service-rail entries surfaced by the 2026-10-04 discovery widening. The
 * reasoning that matters for each: which mount admits the caller, and what identity the
 * connection carries when an owner-scoped table is touched.
 */
export const SERVICE_RAIL_INVENTORY: readonly MachineWriteEntry[] = [
  {
    id: 'files-service-user',
    entryPoint: "app.use('/api/files', serviceSecretOr(requiresAuth), createFilesRoutes(...)) — the ADR-139 handle relay's internal rail",
    file: 'src/app/routes/files-routes.ts',
    auth: 'service-secret',
    ownerScopedTables: ['oshal_connections'],
    identity: { kind: 'caller-scoped', via: 'router.use(requireTrustedServiceUserIdentity) → runWithRequestIdentity({ sub, isOperator: false })' },
    behaviorallyProven: true,
    note:
      'The mount admits the service secret, and the global middleware stamps such a request OPERATOR. The '
      + 'router now re-enters every service-secret request as the named user before any handler, so the '
      + 'connector-token path (accessibleConnections SELECT, refresh UPDATE in getValidAccessToken) runs as '
      + 'that user, exactly as their browser call does; a service call naming no user is refused 403. The '
      + 'driver observes the connection lookup under the narrowed identity.',
  },
  {
    id: 'connector-liveness-session',
    entryPoint: "GET /api/connect/liveness (app.use('/api/connect', requiresAuth, createConnectorLivenessRoutes(ctx)))",
    file: 'src/app/routes/connector-liveness.ts',
    auth: 'oidc-session',
    ownerScopedTables: ['oshal_connections'],
    identity: { kind: 'oidc-session-identity' },
    behaviorallyProven: true,
    note:
      'Matched by discovery only through callerSub\'s trusted-service FALLBACK, which is unreachable through this '
      + 'mount: production requiresAuth demands req.oidc.isAuthenticated() and the mock posture injects a session, '
      + 'and callerSub reads the session first. The forced token refresh (getValidAccessToken forceRefresh) therefore '
      + 'runs under the signed-in user\'s own identity. Removing the dead fallback belongs to theme D (one principal '
      + 'at the door), not to this inventory.',
  },
  {
    id: 'voice-prefs-session',
    entryPoint: "POST /api/voice/prefs (app.use('/api/voice', requiresAuth, createVoiceRoutes(ctx)))",
    file: 'src/app/routes/voice-routes.ts',
    auth: 'oidc-session',
    ownerScopedTables: ['voice_user_prefs'],
    identity: { kind: 'oidc-session-identity' },
    behaviorallyProven: true,
    note:
      'Same shape as connector-liveness-session: callerSub is session-first with a trusted-service fallback the '
      + 'requiresAuth-only mount never lets a session-less caller reach, so the voice_user_prefs write runs as the '
      + 'signed-in user.',
  },
  {
    id: 'jarvis-visual-response',
    entryPoint: 'GET /api/jarvis/visuals/:artifactId (sub-router of the Jarvis router)',
    file: 'src/app/routes/jarvis-visual-response.ts',
    auth: 'service-secret',
    ownerScopedTables: [],
    identity: {
      kind: 'no-owner-scoped-write',
      why:
        'GET-only. It resolves the caller (delegated sub, else the trusted service sub) to read one visual '
        + 'artifact, and is mounted inside the Jarvis router after router.use(requireTrustedServiceUserIdentity) '
        + '(jarvis-routes.ts), so a service caller is already narrowed to the named user. It writes nothing.',
    },
    behaviorallyProven: true,
    note: 'Read path only; the Jarvis router entry above owns the identity decision for its mount.',
  },
  {
    id: 'protected-result-access',
    entryPoint: 'helper used by result-reading routes to authorize a caller against a protected result',
    file: 'src/app/routes/protected-result-access.ts',
    auth: 'service-secret',
    ownerScopedTables: [],
    identity: {
      kind: 'no-owner-scoped-write',
      why:
        'An authorization helper: it reads the trusted service sub and calls canAccessResource. It holds no pool '
        + 'and issues no statement.',
    },
    behaviorallyProven: true,
    note: 'Pure decision code; the routes that call it own their own entries.',
  },
  {
    id: 'tool-control-routes',
    entryPoint: "app.use('/api/tools', serviceSecretOr(requiresAuth), createToolRoutes(...))",
    file: 'src/app/routes/tool-routes.ts',
    auth: 'service-secret',
    ownerScopedTables: [],
    identity: {
      kind: 'no-owner-scoped-write',
      why:
        'Every write route (register, runtime register/delete, dynamic delete, create/update/delete) is behind '
        + 'requiresOperator, which reads the session caller only, so a service secret alone is refused 403. The '
        + 'tables it changes (runtime_tool_executors, migration 023) carry no owner or tenant column and no policy.',
    },
    behaviorallyProven: true,
    note: 'Service callers reach the read routes only; nothing owner-scoped is written on any path.',
  },
];
