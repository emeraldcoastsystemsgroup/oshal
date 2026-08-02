/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The machine-write identity inventory (BACKLOG "Machine-write identity: audit every un-migrated identity-less WRITE, not just reads"). Sibling of unguarded-route-allowlist.ts: that list answers "may this mount be anonymous?", this one answers the question that actually took production down twice — "when this MACHINE caller writes an owner-scoped row, whose identity is on the connection?". a2a-routes hit it in July (anonymous sub '' vs the FORCE RLS WITH CHECK on tickets) and the ADR-119 alert intake in August (PR #99, same failure, found by a container-kill drill and not by any of its 32 green unit guards). Enforced by tests/unit/machine-write-identity.spec.ts.
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
   * from the global middleware. NOT a failure today — and NOT acceptable long term, because it
   * hands a secret-holder cross-tenant reach. Permitted only for `service-secret` auth, and only
   * with a BACKLOG reference.
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
    behaviorallyProven: false,
    note:
      'The July instance of this class, and the rail every later fix copies. rpc.handle runs inside '
      + 'runWithRequestIdentity({ sub: ownerSubForA2aAgent(agent.agentId), isOperator:false }) and '
      + 'a2a-rpc-service stamps the same sub as the ticket owner. Behavioural proof deferred: driving '
      + 'the RPC needs a pool-backed credential store; its guards are tests/unit/a2a-gateway.spec.ts '
      + 'and tests/unit/a2a-cost-stamper.spec.ts.',
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
    auth: 'service-secret',
    ownerScopedTables: ['linkedin_profile_plans'],
    identity: { kind: 'caller-scoped', via: 'runWithRequestIdentity({ sub: body.userSub, isOperator:false })' },
    behaviorallyProven: true,
    note:
      'Documented itself as mirroring /api/apply/ingest and mirrored everything except the identity '
      + 're-entry, so a desktop-worker callback mutated a user-owned row from an OPERATOR connection. '
      + 'linkedin_profile_plans has no policy yet (migration 087 adds none), which is why nothing '
      + 'surfaced it — the latent shape, fixed before the policy lands rather than after.',
  },
  {
    id: 'apply-ingest',
    entryPoint: 'POST /api/apply/{ingest,dispatch,enqueue,site-cred,email-code,shot,…}',
    file: 'src/app/routes/apply-ingest-routes.ts',
    auth: 'service-secret',
    ownerScopedTables: ['ats_site_credentials', 'tickets'],
    identity: { kind: 'caller-scoped', via: 'runWithRequestIdentity({ sub: userSub, isOperator:false }) per handler' },
    behaviorallyProven: true,
    note:
      'The site-cred / email-code / enqueue handlers were already caller-scoped; POST /ingest was not, '
      + 'so a caller-supplied ticketId became an operator-privileged UPDATE with no owner check. Now '
      + 'scoped to the asserted userSub, which makes RLS itself refuse a ticket that user does not own. '
      + 'RESIDUAL: a callback that omits userSub keeps the legacy unscoped path and logs a WARN.',
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
    behaviorallyProven: false,
    note:
      'Already migrated — listed so the inventory is the complete picture rather than only the broken '
      + 'rows. Behavioural proof deferred: driving the worker plane needs the mesh + registry '
      + 'fixtures. Its own guards are tests/unit/remote-client-auth.spec.ts + '
      + 'tests/unit/remote-client-device-ownership.spec.ts.',
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
    behaviorallyProven: false,
    note:
      'Already migrated (SEQ 11). Behavioural proof deferred here because driving the bot-node '
      + 'entrypoint needs a provider runtime to boot; its own guard is '
      + 'tests/unit/bot-node-swarm-execute-auth.spec.ts.',
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
    behaviorallyProven: false,
    note:
      'Already migrated, and the precedent every other bootstrap read in this inventory cites. Guard: '
      + 'tests/unit/token-middleware-rls.spec.ts (the PAT lookup starved to zero rows under guc-strict).',
  },
  {
    id: 'jarvis-service-callers',
    entryPoint: '/api/jarvis/* reached with X-Service-Secret (serviceSecretOr mount)',
    file: 'src/app/routes/jarvis-routes.ts',
    auth: 'service-secret',
    ownerScopedTables: ['jarvis_tasks', 'tickets'],
    identity: {
      kind: 'ambient-service-secret-operator',
      backlogRef: 'docs/BACKLOG.md — Machine-write identity (residual: narrow the serviceSecretOr operator stamp)',
    },
    behaviorallyProven: false,
    note:
      'callerSub() honors X-OSHAL-User-Sub for AUTHZ but never puts it on the connection, so the write '
      + 'runs operator and the only scoping is the literal WHERE user_sub = $2. Works; too much reach. '
      + 'Not silently broken, so it is declared debt rather than a fix in this pass.',
  },
  {
    id: 'test-lab-golden',
    entryPoint: 'POST /api/test-lab/golden/run (serviceSecretOr mount)',
    file: 'src/app/routes/test-lab-golden.ts',
    auth: 'service-secret',
    ownerScopedTables: ['tickets'],
    identity: {
      kind: 'ambient-service-secret-operator',
      backlogRef: 'docs/BACKLOG.md — Machine-write identity (residual: narrow the serviceSecretOr operator stamp)',
    },
    behaviorallyProven: false,
    note:
      'Stamps ownerSub: TEST_LAB_OWNER_SUB on the row (the synthetic-sub half is already right) but '
      + 'never establishes it on the connection, so it survives only on the operator stamp. The day '
      + 'the nightly runs on anything but the service secret it becomes the alert-intake failure.',
  },
  {
    id: 'internal-tool-bridge',
    entryPoint: 'POST /api/tools/execute (serviceSecretOr mount)',
    file: 'src/app/routes/internal-tool-bridge-routes.ts',
    auth: 'service-secret',
    ownerScopedTables: ['access_audit_log'],
    identity: {
      kind: 'ambient-service-secret-operator',
      backlogRef: 'docs/BACKLOG.md — Machine-write identity (residual: narrow the serviceSecretOr operator stamp)',
    },
    behaviorallyProven: false,
    note:
      'emitToolAudit writes the append-only audit trail. The AUTOMATIC writer next door '
      + '(audit-capture-middleware) was explicitly systemized because "an actor could suppress their '
      + 'own audit trail"; this explicit call site never was.',
  },
  {
    id: 'message-routes-service-callers',
    entryPoint: '/api/{tasks,messages,…} reached with X-Service-Secret (serviceSecretOr mount)',
    file: 'src/app/routes/message-routes.ts',
    auth: 'service-secret',
    ownerScopedTables: ['chat_tasks'],
    identity: {
      kind: 'ambient-service-secret-operator',
      backlogRef: 'docs/BACKLOG.md — Machine-write identity (residual: narrow the serviceSecretOr operator stamp)',
    },
    behaviorallyProven: false,
    note:
      'Uses hasValidServiceSecret + getTrustedServiceUserSub for AUTHZ only; the resolved sub never '
      + 'reaches oshal.current_sub, so the chat_tasks write rides the operator stamp.',
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
    behaviorallyProven: false,
    note:
      'Pre-identity by construction. Guards: tests/unit/local-auth-routes.spec.ts, '
      + 'tests/unit/local-auth-session.spec.ts, tests/unit/local-auth-middleware.spec.ts.',
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
export const MAX_UNPROVEN_ENTRIES = 9;

/**
 * @description The maximum number of entries allowed to sit at
 * `identity.kind === 'ambient-service-secret-operator'`. Same ratchet. These are not broken today
 * — they ride the operator stamp `hasValidServiceSecret` earns in server.ts — but every one of
 * them is a secret-holder with cross-tenant reach, and the count must only fall.
 */
export const MAX_AMBIENT_OPERATOR_ENTRIES = 4;
