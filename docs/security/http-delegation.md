# Controller-to-bot HTTP delegation

OSHAL can require every `POST /api/swarm-execute` call to carry a short-lived,
single-use Ed25519 delegation token. The controller alone owns the private signing
key. Bot nodes receive a rotation ring containing public keys only, verify the full
dispatch binding, and atomically consume the signed nonce in shared Redis before any
entitlement check or LLM execution.

This control is independent of `X-Service-Secret`. The bot evaluates the service
secret first, signed delegation second, and execute-time entitlement third. Production
deployments should configure both controls; one does not replace the other.

This document covers controller-to-bot execution only. For a bot or automation workload calling
owner-scoped Graph/Jarvis routes on the controller API, see
[workload-to-API user delegation](./workload-delegation.md); that token has a different audience,
durable PostgreSQL authority, route/body scopes, and rollout mode.

## Wire contract

The compact token travels in `X-OSHAL-Delegation-Token`. Its protected header is fixed
to `alg=EdDSA`, `typ=OSHAL-DLG`, version `2`, and a bounded `kid`. The bot verifies every
signed claim against local policy or the JSON request body:

| Claim | Required binding |
| --- | --- |
| `iss` | `OSHAL_DELEGATION_ISSUER`, default `urn:oshal:controller` |
| `aud` | `OSHAL_DELEGATION_AUDIENCE`, default `urn:oshal:bot-node` |
| `sub` | Exact trusted `body.userSub` |
| `principal_iss` | Exact verified `body.principalIssuer` namespace |
| `azp` | Local `AGENT_ID`, not a caller-selected target |
| `task_id` | Exact `body.taskId` |
| `method`, `path` | Exact `POST /api/swarm-execute`; the token cannot move to another endpoint |
| `body_sha256` | SHA-256 of the complete canonical JSON request body |
| `scope` | Exactly `swarm:execute`; extra or missing scopes fail |
| `iat`, `nbf`, `exp` | Bounded validity window and configured clock skew |
| `jti` | Per-issue nonce consumed once in Redis |

The controller rejects a method argument/body `agentId` mismatch before network I/O.
The body digest covers every execution input, including prompt text, `direct`, brokered
credentials, BYO/provider intent, model/config carriers, and identity fields. A captured
valid token therefore cannot be raced once with a different prompt or a downgraded
entitlement mode. Recursive object-key sorting makes the digest independent of insertion
order while array order and every JSON value remain authoritative.

For user work, it signs only an identity whose subject and issuer match the trusted
request context or the issuer provenance persisted with the ticket. Ownerless trusted
system work is made explicit as `system:oshal-controller` in the
`urn:oshal:system` namespace; a missing identity never silently becomes system work.

Redis stores only `SHA-256(iss + NUL + jti)`, never a token, subject, issuer, or raw
nonce. Consumption uses one `SET ... EX ... NX` operation. A replay returns HTTP 409;
Redis unavailability returns HTTP 503 and execution does not begin. Retention extends
through token expiry plus the maximum verifier skew, bounded to 5,700 seconds.

## Enforcement and failure behavior

Enforcement is activated by key material, not by a second feature flag:

- On the controller, either `OSHAL_DELEGATION_SIGNING_KID` or
  `OSHAL_DELEGATION_SIGNING_PRIVATE_KEY` counts as configured. A missing pair, invalid
  JSON/PEM, non-Ed25519 key, or unsafe TTL fails construction/startup.
- On a bot, `OSHAL_DELEGATION_PUBLIC_KEYS` activates verification. Malformed rings fail
  startup. A private key found in a bot environment is treated as a security error and
  also fails startup.
- A bot with delegation enabled also requires a non-blank `SWARM_SERVICE_SECRET` at
  startup. This keeps `/api/llm-provider` and `/api/token-chase/replay-call` behind their
  independent machine credential even though their scope is not part of this token version.
- With no bot public ring, an absent token preserves rollout compatibility, but any
  presented token is rejected. Tokens never degrade to an unsigned request.
- With a public ring, a missing/malformed/expired/wrongly bound token is rejected before
  entitlement or execution. An `agentId` that differs from local `AGENT_ID` is rejected.
- While enabled, Redis mesh execution, the one-shot batch runtime, the legacy any-bot
  runtime, and controller localhost execution fallbacks are prohibited. Bid traffic is
  still allowed because it does not execute an LLM task.

Authorization responses are deliberately non-secret: `delegation_required` (401),
`invalid_delegation` (401), `target_agent_mismatch` (403), `delegation_replayed` (409),
and replay/verification infrastructure failures (503). Logs include bounded task or
agent context but never token, private-key, raw nonce, or replay-key material.

## Worker routing for core ticket types

Enforcement above says a controller localhost execution fallback is prohibited while signing is
active. That sentence decides which queued work can run, so the consequence is written out here
rather than left to be discovered a ticket at a time.

**The rule: a queued ticket type must name a worker that owns a dedicated bot node.** A bot
registered with `container: oshal-api` / `oshal-local-api` resolves to no endpoint
(`createRegistryEndpointResolver`, `resolve-bot-node-endpoint.ts`), so with signing configured
`dispatchManifestWorkerTicket` refuses it with

```
Signed HTTP delegation requires a dedicated bot-node endpoint
```

and the incident pipeline re-throws the underlying
`No endpoint found for agent <id> - bot node may not be registered` for the same cause. A
controller-inline concierge stays inline for its **interactive** surface, where the turn runs
in-process through `executeBotOrInline` and never crosses a network hop; it is simply not eligible
to own a **queued** ticket type.

The core ticket types are the built-ins in `WORKFLOW_PIPELINES`
(`src/features/swarm-orchestration/services/dispatch-routing.ts`) plus every `ticketType:` declared
by a kernel-resident manifest in `swarm-apps/`:

| Ticket type | Declared in | Pipeline | Worker (reviewer) | Routing under signing |
| --- | --- | --- | --- | --- |
| `build` | `WORKFLOW_PIPELINES`, `swarm-apps/oshal-engineering.yaml` | `swarm` | system-architect | Dedicated node `oshal-local-system-architect`. See the mesh note below - the HTTP decision is fixed, the swarm pipeline's own transport is not. |
| `incident` | `WORKFLOW_PIPELINES`, `swarm-apps/intelligent-operations.yaml` | `incident-rca` | rca-specialist (queue-bot) | Dedicated nodes `oshal-local-rca-specialist` / `oshal-local-queue-bot`. |
| `intelligent-processing` | `swarm-apps/intelligent-processing.yaml` | `incident-rca` | rca-specialist (queue-bot) | Same two nodes. |
| `oshal-dev` | `swarm-apps/oshal-dev.yaml` | manifest-worker | oshal-developer | Dedicated node `oshal-developer` (already `requiresOwnNode`). |
| `security-finding` | `swarm-apps/security.yaml` | `security` (manifest-worker) | security-analyst | Dedicated node `security-analyst`. |
| `task` | `WORKFLOW_PIPELINES` | manifest-worker | general-bot | Dedicated node `general-bot` (already `requiresOwnNode`). The call-out may override the worker - see below. |
| `workflow-build` | `swarm-apps/workflow-studio.yaml` | manifest-worker | workflow-assistant | Dedicated node `workflow-assistant`. |

**A profile-gated worker makes its ticket type profile-gated too.** `rca-specialist` sits behind the
compose profile `incident` and `system-architect` behind `build`, so neither is part of a default
`docker compose up` and neither can join the chart's kernel fleet (the fleet generator refuses,
deliberately). Before signing they were forced inline by the codex rule, which meant a deployment
without those profiles still served `incident`, `intelligent-processing` and `build` from the api
container. It no longer can: with signing configured those types need their profile enabled, or they
are refused. That is a deployment requirement, not a defect - but it has to be stated, because
nothing else says it.

Three of those workers - rca-specialist, system-architect and queue-bot - already named a running
compose node and were sent inline only by the legacy codex rule in `resolve-bot-node-endpoint.ts`,
which that function already logs as a declaration bug
(`Bot declares a dedicated node but is being forced inline by the codex rule`). They now carry
`requiresOwnNode: true`. security-analyst and workflow-assistant were controller-inline and now have
their own bot-node services in `docker-compose.oshal-local.yml`; for security-analyst that also
takes untrusted scanner text out of the control-plane container, which is the blast radius
`src/features/llm-provider/services/controller-inline-scope.ts` describes.

`tests/unit/signed-delegation-core-ticket-types.spec.ts` enumerates these types from the tree on
every run and dispatches one ticket per manifest-worker type through the real dispatcher, the real
registry, the real endpoint resolver and a real signing key, so a new manifest that points a ticket
type at a controller-inline bot fails without anyone editing that spec.

### Why there is no signed inline path

A signed inline path was considered and not built. The token authenticates a network hop, and an
inline worker has none - so a correct inline path would not be a token at all; it would be the
in-process `executeBotOrInline` call the interactive surfaces already use, carrying the ticket's
owner and verified principal issuer and refusing without one. The reason it was not built is that
the equivalent result is available as configuration: every core queued ticket type can name a
worker that owns a node, and moving a queued worker onto a node also **shrinks** its blast radius,
where a new in-process authorization path would add one. If a future queued ticket type genuinely
cannot own a node, that design has to be specified here first - it must demand the same subject and
verified-issuer binding the signed path demands, keep the `isApplicationExecutionProtected` refusal
and the deterministic-provider-intent refusal, and it must not reintroduce the localhost
`/api/send-message` leg, which asserts an arbitrary user subject with a machine credential and no
issuer.

### What is still refused, and why it is not this rule

Two refusals survive this routing decision. Neither is fixed by naming a different worker.

- **The `task` lane's call-out can still select a controller-inline bot.** ADR-083 lets an online
  knowledge owner claim a `task` ticket, overriding the workflow default, and a bidder that resolves
  to no endpoint is refused with the message above. The workflow default (general-bot) and the
  manifest-declared workers are covered by the rule; a call-out winner is not. Three of the five
  refusals in the local box's api log in the 24 h to 2026-09-16 are this shape - `routedBy: "bid"` on
  self-healing-bot, which has no registry entry at all - on the `task` tickets
  `scripts/lib/deploy-verify.sh` files. The backlog entry carries the measured size of the
  endpoint-less set; do not copy a count into this page, it drifts.
- **The `build` pipeline does not use this hop at all.** The swarm pipeline sends work units over
  the Redis mesh (`buildExecutionEnvelope` -> `MESH_CHANNELS.agentDirect`), and every bot node wraps
  its mesh handler in `prohibitUnsignedMeshExecution`, so with a public ring configured it answers
  `Unsigned Redis mesh execution is prohibited while delegation enforcement is active`. Giving
  system-architect a node fixes the controller's routing decision; it does not give the swarm
  pipeline a signed transport.

Both are tracked in [the backlog](../BACKLOG.md).

## Generate a key pair

Generate keys on a trusted operator machine. This Node command emits one-line JWK values
suitable for `.env`; redirect the output to a protected file or secret manager rather
than terminal history in a shared environment:

```powershell
@'
const { generateKeyPairSync } = require('node:crypto');
const kid = `delegation-${new Date().toISOString().slice(0, 10)}`;
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privateJwk = privateKey.export({ format: 'jwk' });
const publicJwk = publicKey.export({ format: 'jwk' });
console.log(`OSHAL_DELEGATION_SIGNING_KID=${kid}`);
console.log(`OSHAL_DELEGATION_SIGNING_PRIVATE_KEY=${JSON.stringify(privateJwk)}`);
console.log(`OSHAL_DELEGATION_PUBLIC_KEYS=${JSON.stringify({ [kid]: publicJwk })}`);
'@ | node -
```

Store the private JWK and active `kid` only in the controller secret scope. Store the
public-ring JSON only in bot-node scope. Public and private JWKs share `kty=OKP`,
`crv=Ed25519`, and `x`; only the controller value contains `d`.

## Configuration

| Variable | Process | Default / constraint |
| --- | --- | --- |
| `OSHAL_DELEGATION_SIGNING_KID` | Controller only | Required with private key; 1–64 safe identifier characters |
| `OSHAL_DELEGATION_SIGNING_PRIVATE_KEY` | Controller only | Ed25519 private PEM or one-line private JWK |
| `OSHAL_DELEGATION_PUBLIC_KEYS` | Bot only | JSON object of at most 16 `kid` to public PEM/JWK entries |
| `OSHAL_DELEGATION_ISSUER` | Both | `urn:oshal:controller`; must match exactly |
| `OSHAL_DELEGATION_AUDIENCE` | Both | `urn:oshal:bot-node`; must match exactly |
| `OSHAL_DELEGATION_TTL_SECONDS` | Controller only | 4,200 seconds; allowed 300–5,400 |
| `OSHAL_DELEGATION_CLOCK_SKEW_SECONDS` | Bot only | 30 seconds; allowed 0–300 |
| `REDIS_URL` | Bot only | Shared replay ledger; every replica must use the same Redis authority |
| `SWARM_SERVICE_SECRET` | Controller and bots | Required when bot delegation is enabled; must match exactly |

The local compose file enforces role separation: its bot environment anchor receives
the public ring, while `oshal-api` clears that inherited value and receives the private
key and active `kid`. Do not inject a shared catch-all secret bundle into both roles.

## Initial rollout

1. Generate and escrow the private key; record the `kid` and public JWK. Configure the
   same strong `SWARM_SERVICE_SECRET` on the controller and every bot first.
2. Configure the controller private key and all bot public rings in the same maintenance
   window. A staggered state intentionally stops work: controller-only signing is
   rejected by unenforced bots because a token is present; bot-only verification rejects
   unsigned controller requests.
3. Restart the controller and every bot. Confirm controller startup has no signing
   configuration error and each bot logs that HTTP delegation is fail-closed.
   Version 2 makes method/path mandatory, so coordinate controller and bot restarts; a mixed
   version intentionally rejects tokens instead of accepting the older, less-bound wire shape.
4. Submit one owned task. Confirm service-secret authentication, delegation authorization,
   entitlement, and execution occur in that order.
5. Confirm a retry creates a new token. Re-sending the same captured request must return
   409, and stopping Redis must make a valid new request return 503 without LLM execution.
6. Confirm unsigned HTTP, Redis mesh execution, legacy runtime, and batch execution fail.

### Background user work during rollout

User-owned background work must carry the principal issuer that was verified when the
ticket was created. TicketService stores this in reserved metadata and the manifest,
incident, and authored-workflow dispatchers propagate it. Legacy tickets without that
provenance deliberately fail closed once controller signing is enabled; a subject string
alone is not enough because two identity providers can issue the same `sub`.

Audit other schedulers before enabling keys. Current direct background examples such as
home schedules, ambient enrichment, and content pre-warm paths may reconstruct only an
owner subject and therefore stop at delegation issuance until they persist and restore
the verified issuer (or are explicitly redesigned as platform-system work). Do not fill
the missing issuer from an untrusted job payload or a deployment-wide default.

## Rotation

Rotation is overlap-first so in-flight tokens remain verifiable:

1. Generate a new key and unique `kid`.
2. Add the new public JWK to every bot ring while retaining the old public JWK; restart
   bots and verify both kids load.
3. Change the controller private key and active `kid` to the new pair; restart it and
   verify new dispatches use the new `kid`.
4. Wait at least the maximum configured token TTL plus maximum clock skew (up to 5,700
   seconds), then remove the old public JWK from all bot rings and restart bots.
5. Destroy the retired private key according to the deployment's key-retention policy.

If the active private key is suspected compromised, skip overlap for issuance: replace
the controller key immediately, remove the compromised public key from bots, and accept
that in-flight work signed by the old key will fail closed. Never disable enforcement as
a rotation shortcut.

## Rollback and recovery

A normal rollback removes both controller signing variables and every bot public ring,
then restarts all roles. This restores the explicitly logged compatibility posture; it is
a security downgrade and should be time-boxed. Removing only one side causes a deliberate
fail-closed outage. Redis recovery does not require deleting replay keys; their bounded TTL
expires them safely. Do not flush shared Redis to recover one dispatch.

When diagnosing failures, compare configured `kid`, issuer, audience, local `AGENT_ID`,
task id, owner subject, persisted principal issuer, clock, and Redis reachability. Do not
log or paste the compact token or private JWK into tickets or chat.
