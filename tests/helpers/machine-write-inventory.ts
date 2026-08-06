/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The machine-write identity inventory (BACKLOG "Machine-write identity: audit every un-migrated identity-less WRITE, not just reads"). Sibling of unguarded-route-allowlist.ts: that list answers "may this mount be anonymous?", this one answers the question that actually took production down twice — "when this MACHINE caller writes an owner-scoped row, whose identity is on the connection?". a2a-routes hit it in July (anonymous sub '' vs the FORCE RLS WITH CHECK on tickets) and the ADR-119 alert intake in August (PR #99, same failure, found by a container-kill drill and not by any of its 32 green unit guards). Enforced by tests/unit/machine-write-identity.spec.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Closed all four ambient service-secret operator residuals with trusted caller-scoped identities and behavioral drivers; added the strictly machine-authenticated, node-local-only node-pool control surface to discovery coverage and lowered both debt ratchets.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added the final five real HTTP/auth-boundary identity drivers and reduced the unproven-entry ratchet to zero; every owner-scoped machine surface in this inventory is now behaviorally observed at its database/cost write seam.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Reclassify Profile Studio result ingest as one-use capability authentication bound to exact callback context instead of a reusable fleet service secret.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Reclassify Apply result ingest as a one-use
 *   exact-task capability and remove the residual body-asserted/unscoped ticket path.
 */

/**
 * @description How a caller proves itself to a machine-reachable entry point. This is the axis
 * that decides the AMBIENT database identity, because `src/app/server.ts` stamps
 * `{ sub: getCaller(req).sub, isOperator: isOperator(req) || hasValidServiceSecret(req) }`:
 *
 *  - `service-secret` → `{ sub: null, isOperator: TRUE }`. The write succeeds, RLS-bypassed.
 *    Too much reach, but never the hard failure.
 *  - everything else  → `{ sub: null, isOperator: false }`. `oshal.current_sub` is `''`, and an
 *    owner-RLS `WITH CHECK` refuses the INSERT outright (a2a July, alerts August) or the row
 *    lands owner-less on a table whose policy has not shipped yet (the quiet variant).
 */
export type MachineAuthMechanism =
  /** `X-Service-Secret` constant-time vs `SWARM_SERVICE_SECRET` (self-guard or `serviceSecretOr`). */
  | 'service-secret'
  /** A single deployment-wide bearer/env token compared inside the router. */
  | 'shared-bearer'
  /** A per-credential token the swarm minted and can revoke (A2A agent token, `oshal_pat_…`). */
  | 'per-credential-bearer'
  /** A short-lived single-operation token whose digest is atomically consumed with its bound row. */
  | 'one-use-capability'
  /** The provider signs the delivery: HMAC, Twilio signature, Facebook signed_request, secret-token header. */
  | 'provider-signature'
  /** A real OIDC/local session — a human, not a machine. Present so mixed routers can be described. */
  | 'oidc-session'
  /** No authentication at all. */
  | 'none';

/** @description What the entry point establishes on the DB connection before its first write. */
export type IdentityPosture =
  /**
   * The established rail: a namespaced synthetic sub (`alert:prometheus`, `a2a:<id>`,
   * `webhook:<provider>`) stamped via `runWithRequestIdentity({ isOperator: false })` AND stamped
   * again as the row's owner column, so both halves of the RLS predicate agree.
   */
  | { kind: 'synthetic-machine-sub'; sub: string }
  /** `runWithRequestIdentity({ sub: <the row's real owner>, isOperator: false })`. */
  | { kind: 'caller-scoped'; via: string }
  /**
   * `runWithSystemIdentity` — `isOperator: true`. Legitimate ONLY for genuinely cross-owner work
   * or a bootstrap read that must precede knowing the owner (the cli-token hash lookup is the
   * precedent). Requires a written `why`.
   */
  | { kind: 'trusted-system'; why: string }
  /**
   * Nothing established: the entry point inherits the operator stamp a valid service secret gets
   * from the global middleware and hands a secret-holder cross-tenant reach. This posture is
   * retained only as an explicit regression marker: `MAX_AMBIENT_OPERATOR_ENTRIES` is zero, so any
   * entry selecting it fails the class gate immediately and must migrate to caller-scoped or
   * deliberately documented trusted-system identity.
   */
  | { kind: 'ambient-service-secret-operator'; backlogRef: string }
  /** The caller is a real signed-in human; their session already is the identity. */
  | { kind: 'oidc-session-identity' }
  /** Nothing owner-scoped is written, so there is nothing to establish. */
  | { kind: 'no-owner-scoped-write'; why: string };

/** @description One machine-reachable entry point and its reviewed identity posture. */
export interface MachineWriteEntry {
  /** Stable id; the behavioural-proof driver map in the spec is keyed on it. */
  id: string;
  /** The HTTP surface (or process entry) exactly as it is reachable. */
  entryPoint: string;
  /** Repo-relative file that OWNS the auth check. Must exist. */
  file: string;
  /** How the caller authenticates. */
  auth: MachineAuthMechanism;
  /**
   * Owner- or tenant-scoped tables this entry point writes, directly or through a collaborator.
   * Empty means it writes none — a claim the gate re-derives from the source, so it cannot be
   * used to duck the identity requirement.
   */
  ownerScopedTables: readonly string[];
  /** The reviewed posture. */
  identity: IdentityPosture;
  /**
   * `false` only for an entry whose behavioural proof is not written yet. The gate ratchets the
   * count down, so debt is visible and cannot grow.
   */
  behaviorallyProven: boolean;
  /** Why this posture is right — cite the code, not the intent. */
  note: string;
}

/**
 * @description THE INVENTORY. Every entry was populated by READING the route/service end to end:
 * which secret it checks, which tables it reaches, and what (if anything) it puts on the
 * connection first.
 *
 * If `tests/unit/machine-write-identity.spec.ts` just failed on a file you added: your file
 * authenticates a machine caller. Add an entry here with the tables it writes and the identity it
 * establishes — and if it writes an owner-scoped table under anything other than
 * `service-secret`, it MUST establish one, because the ambient context is anonymous non-operator
 * and Postgres will refuse the row.
 */
export const MACHINE_WRITE_INVENTORY: readonly MachineWriteEntry[] = [
  {
    id: 'alertmanager-intake',
    entryPoint: 'POST /api/alerts/alertmanager',
    file: 'src/app/routes/alertmanager-routes.ts',
    auth: 'shared-bearer',
    ownerScopedTables: ['tickets'],
    identity: { kind: 'synthetic-machine-sub', sub: 'alert:prometheus' },
    behaviorallyProven: true,
    note:
      'ADR-119 intake. Fail-closed ALERT_WEBHOOK_TOKEN bearer + optional HMAC, then asMachineIdentity '
      + 'stamps ALERT_INTAKE_OWNER_SUB with isOperator:false and alert-consolidation stamps the same '
      + 'value as owner_sub. This is the reference remediation (PR #99); the live proof is '
      + 'tests/alert-intake-rls-live.spec.ts.',
  },
  {
    id: 'a2a-rpc',
    entryPoint: 'POST /api/a2a (JSON-RPC message/send, tasks/get, tasks/cancel)',
    file: 'src/app/routes/a2a-routes.ts',
    auth: 'per-credential-bearer',
    ownerScopedTables: ['tickets'],
    identity: { kind: 'synthetic-machine-sub', sub: 'a2a:<agentId>' },
    behaviorallyProven: true,
    note:
      'The July instance of this class, and the rail every later fix copies. rpc.handle runs inside '
      + 'runWithRequestIdentity({ sub: ownerSubForA2aAgent(agent.agentId), isOperator:false }) and '
      + 'a2a-rpc-service stamps the same sub as the ticket owner. The class driver now authenticates '
      + 'a real Bearer JSON-RPC message/send request and observes both values at createTicket.',
  },
  {
    id: 'connector-webhook-ingress',
    entryPoint: 'POST /api/hooks/:provider/:event',
    file: 'src/app/routes/connector-webhook-routes.ts',
    auth: 'provider-signature',
    ownerScopedTables: ['tickets'],
    identity: { kind: 'synthetic-machine-sub', sub: 'webhook:<provider>' },
    behaviorallyProven: true,
    note:
      'The third instance, found by this audit and fixed with it. It failed the QUIET way: dispatch '
      + 'ran under runWithSystemIdentity (operator), so nothing was refused — every webhook-born '
      + 'ticket simply landed with owner_sub NULL, and one connector secret bought read access to '
      + 'every tenant ticket. Now webhookOwnerSub(provider) on the connection AND on the row, '
      + 'established only after verifySignature. Live proof: tests/connector-webhook-rls-live.spec.ts.',
  },
  {
    id: 'webhook-ingress-core',
    entryPoint: 'the shared verify/dedup core behind /api/hooks',
    file: 'src/app/connectors/webhooks/webhook-ingress.ts',
    auth: 'provider-signature',
    ownerScopedTables: [],
    identity: {
      kind: 'no-owner-scoped-write',
      why:
        'Verification + dedup only. Its one write is oshal_webhook_deliveries (delivery_id PK, no '
        + 'owner column, no policy), and the ticket write happens in the injected onEvent — which '
        + 'is the connector-webhook-ingress entry above.',
    },
    behaviorallyProven: true,
    note:
      'Pure framework: verifySignature + dispatchWebhook + SeenStore. Deliberately owns no ticket '
      + 'write, which is why the identity belongs to its caller and not to it.',
  },
  {
    id: 'telegram-channel-webhook',
    entryPoint: 'POST /api/channels/telegram/webhook',
    file: 'src/app/routes/chat-channel-routes.ts',
    auth: 'provider-signature',
    ownerScopedTables: ['channel_links', 'channel_link_codes'],
    identity: { kind: 'caller-scoped', via: 'ChannelLinkService.redeemLinkCode → runWithRequestIdentity(userSub)' },
    behaviorallyProven: true,
    note:
      'The route already wrapped the SWARM DISPATCH in the linked user identity and left the LINKING '
      + 'write — the row that decides whose swarm an inbound message reaches — on the ambient '
      + 'anonymous context. Fixed in channel-link-service.ts: the code claim and the owner lookup run '
      + 'trusted-system (they are what TELL us the owner), the channel_links upsert runs as that user. '
      + 'These two tables carry no policy yet; the service SEQ-1 note already promises one, and this '
      + 'is the write that would break the day it lands.',
  },
  {
    id: 'facebook-data-deletion',
    entryPoint: 'POST /auth/facebook/data-deletion',
    file: 'src/app/routes/connectors-routes.ts',
    auth: 'provider-signature',
    ownerScopedTables: ['oshal_connections'],
    identity: {
      kind: 'trusted-system',
      why:
        'Genuinely cross-owner: Meta sends a signed_request carrying only ITS user id, so the row '
        + 'belongs to an OSHAL user whose sub we do not know and no synthetic sub can express the '
        + 'statement. Bounded like the cli-token pre-identity lookup — one DELETE, no scan, keyed on '
        + 'the HMAC-verified account_id, returning only a confirmation code.',
    },
    behaviorallyProven: true,
    note:
      'Was the sharpest live defect this audit found: oshal_connections is FORCE-RLS (migration 060 '
      + 'Tier-2) and the DELETE ran anonymous non-operator, so it matched ZERO rows on every call '
      + 'while still answering Meta with a confirmation code — this class AND a false deletion '
      + 'attestation. rowCount is now logged so a silent zero cannot recur.',
  },
  {
    id: 'profile-studio-ingest',
    entryPoint: 'POST /api/profile-studio/ingest',
    file: 'src/app/routes/profile-studio-ingest-routes.ts',
    auth: 'one-use-capability',
    ownerScopedTables: ['linkedin_profile_plans'],
    identity: { kind: 'caller-scoped', via: 'runWithRequestIdentity({ sub: callback.context.userSub, isOperator:false })' },
    behaviorallyProven: true,
    note:
      'The trusted desktop runtime presents a short-lived random capability whose hash is bound to '
      + 'the exact owner, generation, task, client, and resolve operation. The route re-enters that '
      + 'exact opaque owner with isOperator:false, and the same UPDATE atomically consumes the token.',
  },
  {
    id: 'apply-ingest',
    entryPoint: 'POST /api/apply/ingest',
    file: 'src/app/routes/apply-ingest-routes.ts',
    auth: 'one-use-capability',
    ownerScopedTables: ['tickets'],
    identity: { kind: 'caller-scoped', via: 'runWithRequestIdentity({ sub: claim.userSub, isOperator:false }) after durable capability lookup' },
    behaviorallyProven: true,
    note:
      'The remote daemon presents a short-lived random capability carried outside model arguments. '
      + 'Its PostgreSQL digest supplies the exact owner, ticket, posting, task, client, generation, and '
      + 'expiry; the body cannot select identity. Queue recording must acknowledge those exact facts '
      + 'before the route enters the opaque owner identity and settles the ticket. No unscoped fallback.',
  },
  {
    id: 'remote-client-plane',
    entryPoint: 'POST /api/remote-clients/:clientId/* (worker plane)',
    file: 'src/app/routes/remote-client-routes.ts',
    auth: 'shared-bearer',
    ownerScopedTables: ['chat_tasks', 'oshal_cost_events'],
    identity: {
      kind: 'trusted-system',
      why:
        'Cost metering for a leaf task whose owner travels on the task, not on the connection, and '
        + 'which must be recorded for many owners from one shared-secret worker plane (SEQ 8). The '
        + 'chat turn itself does re-enter the node owner sub (SEQ 5), so only the metering is system.',
    },
    behaviorallyProven: true,
    note:
      'The real shared-secret HTTP plane registers an owner-bound client, durably enqueues/claims/settles '
      + 'a metered leaf task, and drives the production settlement publisher. The injected atomic cost '
      + 'sink observes the SYSTEM sentinel and the task owner at the write boundary.',
  },
  {
    id: 'sms-inbound',
    entryPoint: 'POST /api/sms/inbound',
    file: 'src/app/routes/sms-inbound-routes.ts',
    auth: 'provider-signature',
    ownerScopedTables: [],
    identity: {
      kind: 'no-owner-scoped-write',
      why:
        'The shipped onInboundSms sink is a structured log; server.ts mounts createSmsInboundRoutes() '
        + 'with no deps, so nothing touches Postgres.',
    },
    behaviorallyProven: true,
    note:
      'Clean today ONLY because the sink is a logger. The seam is documented as the place a real '
      + 'consumer gets wired, and whoever wires it inherits {sub:null,isOperator:false} — this entry '
      + 'is where they will be told so.',
  },
  {
    id: 'bot-node-swarm-execute',
    entryPoint: 'POST /api/swarm-execute (bot-node process)',
    file: 'src/app/bot-node-server.ts',
    auth: 'service-secret',
    ownerScopedTables: ['chat_tasks'],
    identity: {
      kind: 'trusted-system',
      why:
        'A separate process with no request-identity middleware at all, executing work on behalf of '
        + 'many owners; recordCost writes FORCE-RLS chat_tasks and there is no single owner to scope '
        + 'the process to. Documented at SEQ 11.',
    },
    behaviorallyProven: true,
    note:
      'The import-safe production execution seam is wired directly into bot-node-server.ts. A real '
      + 'HTTP driver passes the actual shared-secret middleware, crosses an async boundary through '
      + 'that seam, and observes the SYSTEM sentinel at the simulated cost write.',
  },
  {
    id: 'node-pool-control',
    entryPoint: 'GET/POST /node/* (node-pool process control surface)',
    file: 'src/app/routes/node-pool-routes.ts',
    auth: 'service-secret',
    ownerScopedTables: [],
    identity: {
      kind: 'no-owner-scoped-write',
      why:
        'The strict machine-only router writes only bounded node-local persona and Cline credential '
        + 'configuration files; it never reads from or writes to Postgres.',
    },
    behaviorallyProven: true,
    note:
      'requireServiceSecret fails closed when the deployment secret is absent or mismatched, persona '
      + 'paths are confined to approved roots, credential values never enter logs, and the complete '
      + 'behavioral guard is tests/unit/node-pool-routes-security.spec.ts.',
  },
  {
    id: 'cli-token-auth',
    entryPoint: 'Bearer oshal_pat_… (global middleware) + /api/cli-tokens',
    file: 'src/app/routes/cli-token-routes.ts',
    auth: 'per-credential-bearer',
    ownerScopedTables: ['oshal_cli_tokens'],
    identity: {
      kind: 'trusted-system',
      why:
        'It IS the identity stamper — the token lookup must run before any identity exists, which no '
        + 'caller-scoped or synthetic sub can express. Proof-of-possession on a 48-hex hash returning '
        + 'exactly that one row (SEQ 3).',
    },
    behaviorallyProven: true,
    note:
      'A real Bearer PAT request now drives createCliTokenAuthMiddleware over HTTP and observes both '
      + 'the proof-of-possession lookup and best-effort last-used write under the SYSTEM sentinel before '
      + 'the token owner is stamped onto req.oidc.',
  },
  {
    id: 'jarvis-service-callers',
    entryPoint: '/api/jarvis/* reached with X-Service-Secret (serviceSecretOr mount)',
    file: 'src/app/routes/jarvis-routes.ts',
    auth: 'service-secret',
    ownerScopedTables: ['jarvis_tasks', 'tickets'],
    identity: {
      kind: 'caller-scoped',
      via: 'requireTrustedServiceUserIdentity(getTrustedServiceUserSub(req)) before the Jarvis router',
    },
    behaviorallyProven: true,
    note:
      'The router now rejects a valid secret without X-OSHAL-User-Sub and re-enters every Jarvis '
      + 'sub-router/detached turn as that owner with isOperator:false. The driver executes the real '
      + 'mark-delivered UPDATE and observes both the connection sub and matching user_sub parameter.',
  },
  {
    id: 'test-lab-golden',
    entryPoint: 'POST /api/test-lab/golden/run (serviceSecretOr mount)',
    file: 'src/app/routes/test-lab-golden.ts',
    auth: 'service-secret',
    ownerScopedTables: ['tickets'],
    identity: {
      kind: 'caller-scoped',
      via: 'trusted TEST_LAB_OWNER_SUB header through requireTrustedServiceUserIdentity',
    },
    behaviorallyProven: true,
    note:
      'The host runner now requires TEST_LAB_OWNER_SUB and sends it as X-OSHAL-User-Sub beside the '
      + 'validated secret. The router stamps that same sub on the connection and ticket row, scopes '
      + 'batch polling to it, and its real detached-ticket driver observes both halves.',
  },
  {
    id: 'internal-tool-bridge',
    entryPoint: 'POST /api/tools/execute (serviceSecretOr mount)',
    file: 'src/app/routes/internal-tool-bridge-routes.ts',
    auth: 'service-secret',
    ownerScopedTables: ['access_audit_log'],
    identity: {
      kind: 'caller-scoped',
      via: 'requireTrustedServiceUserIdentity before tool grant lookup, execution, and explicit audit',
    },
    behaviorallyProven: true,
    note:
      'The explicit audit represents one user-bound tool action, unlike the cross-owner automatic '
      + 'audit writer, so it runs under that actor with isOperator:false. The real HTTP driver denies '
      + 'a missing binding and observes the trusted actor at the access_audit_log INSERT.',
  },
  {
    id: 'message-routes-service-callers',
    entryPoint: '/api/{tasks,messages,…} reached with X-Service-Secret (serviceSecretOr mount)',
    file: 'src/app/routes/message-routes.ts',
    auth: 'service-secret',
    ownerScopedTables: ['chat_tasks'],
    identity: {
      kind: 'caller-scoped',
      via: 'requireTrustedServiceUserIdentity plus trusted owner propagation into PM ticket/task rows',
    },
    behaviorallyProven: true,
    note:
      'The router rejects a service secret without X-OSHAL-User-Sub, removes body.userSub as an '
      + 'identity source, re-enters as the trusted owner, and propagates that owner onto both PM '
      + 'ticket and chat-task rows. The real route driver observes the task write under that sub.',
  },
  {
    id: 'graph-routes',
    entryPoint: '/api/graph (serviceSecretOr mount)',
    file: 'src/app/routes/graph-routes.ts',
    auth: 'service-secret',
    ownerScopedTables: [],
    identity: {
      kind: 'no-owner-scoped-write',
      why:
        'Writes ArangoDB through the caller-scoped GraphHandle (graph-keys.ts derives the database '
        + 'name from the sub). No Postgres row, so no owner-RLS predicate to satisfy.',
    },
    behaviorallyProven: true,
    note:
      'In the inventory because the mount is machine-reachable; out of THIS class because its store is '
      + 'ArangoDB, whose isolation boundary is the per-sub database name, not a Postgres row policy. A '
      + 'Postgres write added here would have to establish an identity like everything else.',
  },
  {
    id: 'vision-routes',
    entryPoint: '/api/vision (serviceSecretOr mount)',
    file: 'src/app/routes/vision-routes.ts',
    auth: 'service-secret',
    ownerScopedTables: [],
    identity: { kind: 'no-owner-scoped-write', why: 'VisionDescribeService performs no INSERT/UPDATE/DELETE — it describes an image and returns.' },
    behaviorallyProven: true,
    note:
      'Read/describe only — nothing is persisted, so a service-secret caller reaching it has no '
      + 'owner-scoped row to mis-own. Listed anyway because the mount IS machine-reachable and the '
      + 'next feature added here would inherit the operator stamp.',
  },
  {
    id: 'trading-service-headers',
    entryPoint: 'X-Service-Secret + X-OSHAL-User-Sub resolution helper for /api/trading',
    file: 'src/app/routes/trading-routes-helpers.ts',
    auth: 'service-secret',
    ownerScopedTables: [],
    identity: { kind: 'no-owner-scoped-write', why: 'A caller-sub resolution helper; it owns no query of its own.' },
    behaviorallyProven: true,
    note:
      'Listed so the discovery scan has a declared home for the trusted-service header pattern it '
      + 'matches here. The routes that consume the helper are ordinary OIDC surfaces.',
  },
  {
    id: 'llm-governance-check',
    entryPoint: 'POST /api/llm-governance/check',
    file: 'src/app/routes/llm-governance-routes.ts',
    auth: 'shared-bearer',
    ownerScopedTables: [],
    identity: { kind: 'no-owner-scoped-write', why: 'recordGateUsage is in-process (features/llm-governance gate.ts); the spend lookup is a SELECT.' },
    behaviorallyProven: true,
    note:
      'No write, so out of this class — but note for whoever adds one: internalCallerAllowed() FAILS '
      + 'OPEN when neither OSHAL_INTERNAL_TOKEN nor SESSION_SECRET is set, unlike every other guard '
      + 'here. Filed in the BACKLOG machine-write-identity residuals.',
  },
  {
    id: 'join-enroll',
    entryPoint: 'POST /api/join/enroll, GET /api/join/code',
    file: 'src/app/routes/join-routes.ts',
    auth: 'oidc-session',
    ownerScopedTables: ['oshal_cli_tokens'],
    identity: { kind: 'oidc-session-identity' },
    behaviorallyProven: true,
    note:
      'Matches the discovery scan only because it EMBEDS REMOTE_CLIENT_SHARED_SECRET in a join code. '
      + 'The route itself 401s without a real caller sub (getCaller), so the session is the identity '
      + 'and the ambient stamp is already correct — a human, not a machine.',
  },
  {
    id: 'local-auth',
    entryPoint: 'POST /api/local-auth/{bootstrap,login,accept,forgot}',
    file: 'src/app/routes/local-auth-routes.ts',
    auth: 'none',
    ownerScopedTables: ['local_users'],
    identity: {
      kind: 'trusted-system',
      why:
        'The pre-identity credential flow (ADR-117): it is what MINTS the sub, so it cannot already be '
        + 'running as it — the same chicken-and-egg as the cli-token hash lookup. Its table carries its '
        + 'own owner policy built by buildOwnerRlsPolicyStatements.',
    },
    behaviorallyProven: true,
    note:
      'Pre-identity by construction. The real public bootstrap endpoint now creates its first admin '
      + 'over HTTP against an identity-capturing pool and proves the local_users INSERT runs under '
      + 'the SYSTEM sentinel while carrying the deterministic local user_sub.',
  },
];

/**
 * @description Files the discovery scan will match but that are NOT entry points — the
 * composition root mounts the routers listed above and owns no auth mechanism of its own.
 * Kept tiny and justified on purpose: every name here is a hole in the scan.
 */
export const DISCOVERY_EXEMPT_FILES: readonly { file: string; why: string }[] = [
  {
    file: 'src/app/server.ts',
    why:
      'Composition root. It MENTIONS every secret name because it mounts the routers and reads their '
      + 'env gates; the auth checks themselves live in the routers, each of which has its own entry '
      + 'above. It is also where the ambient identity middleware lives, which the gate asserts '
      + 'separately.',
  },
];

/**
 * @description The maximum number of entries allowed to sit at `behaviorallyProven: false`.
 * A RATCHET, not a budget: it is the count at the commit that introduced this file, and the gate
 * fails if the inventory ever exceeds it. Lower it when you add a proof; never raise it.
 */
export const MAX_UNPROVEN_ENTRIES = 0;

/**
 * @description The maximum number of entries allowed to sit at
 * `identity.kind === 'ambient-service-secret-operator'`. The ratchet is now zero: every reviewed
 * service-secret write surface must replace the server's compatibility operator stamp with an
 * explicitly bound, non-operator caller before touching owner-scoped state. Keep the retired
 * identity kind in the union so a regression is reported as debt instead of disappearing from
 * the inventory model.
 */
export const MAX_AMBIENT_OPERATOR_ENTRIES = 0;
