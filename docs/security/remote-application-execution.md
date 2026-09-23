# Protected remote application execution

Protected bot reasoning carries the initiating user's exact issuer and subject from the controller
through the worker and back to the result reader. The controller resolves the application from
installed bot ownership. A request cannot select its application authority, actor, callback URL,
or execution reference.

## Supported execution

The supported remote mode is direct configured reasoning: `direct: true`, `agenticMode: false`,
and exactly one server-resolved brain shape. A hosted selection carries `byoLlmConnection`; a CLI
selection carries the authoritative `providerId` and optional model, with
`providerConfigRequired: true`. Small scalar application facts may be obtained by the existing
authorized [specialist context reader](../apps/specialist-context.md) before signing. Application
tools declared `AUTO` for the selected bot are discovered at call time through the controller's
server-side MCP bridge; neither mechanism globally preloads tools.

Queued manifest-worker dispatch uses the same `resolveUserBrain` configuration ladder as Jarvis.
A queue has no HTTP request of its own, so it resolves from the durable ticket owner and builds the
matching direct, non-agentic body. When the owner has no usable configured brain, dispatch refuses
before anything is signed and records the missing requirement on the ticket. Connector credentials
and deterministic provider intents are refused rather than dropped. A hosted brain is authoritative
through its resolved endpoint; a CLI brain is authoritative through its signed provider/model stamp.

Each protected worker run has isolated history. The runtime supplies an empty native worker-tool
set, excludes global project context and layered swarm memory, and rechecks permission immediately
before inference and before storing or returning the answer. The final prompt authority names only
the exact non-system `AUTO` tools and scopes resolved for the bot at call time. A CLI that supports
the bridge receives an invocation-only MCP configuration bound to the exact bot, owner, task and
original execution. Every bridged call must still be an enabled `AUTO` grant for that bot and
receives a fresh same-application `action` permit before the existing server-side executor runs it.
The temporary configuration is removed after the turn. The existing per-bot usage and cost path is
retained.

The worker's open-ended agentic loop, provider intents, connector credentials, raw mesh/batch calls
and Token Chase replay remain refused for protected applications. Call-time application tools are
the bounded exception: they execute through the controller broker, not the worker's native tool
registry. A configured CLI brain remains subject to the existing
demo/operator eligibility checks and final spawn guard; this protocol does not widen who may use a
CLI. General queued agentic work does not become supported merely because a ticket has captured
user provenance.

## Controller and worker protocol

1. The controller refreshes the initiating account and current application rights. It captures
   installed source/catalog/generation, exact principal, tenant, bot, task, workspace, original
   directory freshness and effective grant bounds in a durable execution record.
2. It includes only the opaque `applicationExecutionId` in the existing Ed25519 delegated request.
   It durably binds the complete body digest and recorded delegation claims before sending.
   Prompts, provider keys and raw delegation tokens are not persisted in the authority record.
3. The worker verifies machine authentication, signature, exact request bindings and the existing
   single-use delegation nonce. Trusted async context carries this proof outside the body.
4. The worker asks the fixed controller endpoint
   `POST /api/internal/application-executions/revalidate` for `start`, subsequent `work` checks,
   `action` for each bridged tool call, and `complete`. The controller reevaluates current account/provider, ownership, installation
   generation and original grants at every phase. Start is consumed once durably; repeated
   challenges and conflicting concurrent transitions refuse.
5. Each response is independently signed for the distinct application permit audience and scope,
   bound to the worker nonce and original dispatch. Its payload expires within 15 seconds; the
   worker checks that payload expiry in addition to the existing token envelope verifier.
6. The controller releases a successful response only after completed execution and current rights
   are verified. It replaces any worker-supplied lineage with its own prepared execution ID.

`action` is a closed controller check for a same-application named bot/tool operation. It does not
install or enable a worker tool executor: the tool must independently remain an exact enabled
`AUTO` grant for that bot, and execution stays in the controller's existing audited executor.
Missing keys, unavailable controller/database, stale
directory evidence, disabled accounts, any changed original grant set (including broader grants), source replacement and reload
fail closed. Retained directory timestamps are never refreshed by repeated execution checks.

## Queue and result ownership

Migration 133 stores verified queue initiators separately from mutable tickets. Ticket creation
captures identity only when the authenticated actor and request identity match the selected owner.
Owner reassignment is refused; reserved issuer and result metadata survive ordinary ticket updates.
Protected dispatch restores the captured actor under a nonoperator database identity and still
checks current policy. Legacy tickets without this provenance refuse protected execution.

Migration 132 stores execution state and durable links to parent result tasks. Result checks cover
every execution contributing to a task, including when a concurrent metadata append was lost.
Task/message history, ticket detail/listing, Jarvis caches/shelves and SSE delivery require current
rights for the exact issuer and subject. Platform administration does not bypass this business
result boundary. SSE checks again for each event. Protected cached facts are withheld from
automatic derived summaries until those summary paths retain complete source lineage.

Both migrations use forced row security for controller-only authority records. Runtime bootstrap
uses the same schema as installation. Existing delegation key configuration and
`SWARM_SERVICE_SECRET` are reused. Workers use trusted process configuration
`SWARM_CONTROLLER_URL` (default `http://oshal-api:5000`) and the controller public key ring; they
never receive the controller private signing key.

## Verification and release

`npm run test:remote-authorization` is the fixed local runner registered in AI Test Lab as
`protected-remote-application-execution`. It exercises real policy, signed HTTP, worker and SQLite
boundaries, canonical result stores/SSE, and disposable PostgreSQL. Local Docker is needed for the
PostgreSQL cases. No production accounts, application records or live inference are used.

The Lab registration exposes the suites and prerequisites. Its browser step reports that the local
runner is required; it does not execute arbitrary host commands or claim that registration is a
passing deployment test. See [the run record](../releases/remote-authorization-2026-09-11.md) for
the final commands, counts and publication state.
