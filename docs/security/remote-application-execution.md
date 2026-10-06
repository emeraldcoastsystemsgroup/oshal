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

Interactive cockpit and rail chat to a protected node-bound bot (`POST /api/send-message` and
`POST /api/tasks/:taskId/messages`) builds the same shape on the controller. Every chat client posts
`agenticMode: true` or omits it, so the route ignores the client's value for a protected target and
sends `direct: true, agenticMode: false`; the brain comes from `stampRemoteBrain`. Protection is
decided with the inline branch's exact expression (the execution policy, or the controller's
protected-agent read that protected dispatch prepares from). Bare service-secret calls and
unprotected bots keep the shape they asked for.

Each protected worker run has isolated history. The runtime supplies an empty native worker-tool
set, excludes global project context and layered swarm memory, and rechecks permission immediately
before inference and before storing or returning the answer. The final prompt authority names only
the exact non-system `AUTO` tools and scopes resolved for the bot at call time. A CLI that supports
the bridge receives an invocation-only MCP configuration bound to the exact bot, owner, task and
original execution. Every bridged call must still be an enabled `AUTO` grant for that bot and
receives a fresh same-application `action` permit before the existing server-side executor runs it.
The invocation-only Antigravity settings auto-approve `mcp(oshal-tools/*)` because a headless CLI
cannot answer its default MCP confirmation; they do not approve another MCP server or any terminal
command. The temporary configuration is removed after the turn. The existing per-bot usage and
cost path is retained.

A protected turn runs tool-less on the worker's direct path, which supplies only a generic system
prompt, so the bot's persona travels from the controller. When an application activates, the
controller reads each declared bot's persona file through the owning manifest (a path outside the
package is refused) and composes the identity (name and role), the scalar `personality` entries, a
perspective, and a fixed sentence stating that the persona grants no tool, scope or credential.
The perspective is `protected_perspective` when the persona declares one; otherwise the ordinary
`perspective` is used only when it passes a screen for shell, script and credential-carrier
wording, and is left out (identity and personality still travel) when it does not. Capabilities,
tool lists, authorizations, runtime, selectors and system prompts are never read. A composed
persona that names a secret identifier, exceeds 16 KiB, is not valid UTF-8 or contains control
characters is refused for that bot and is never truncated. `BotNodeClient` adds the text registered
for the prepared binding's application and bot as `botPersona`; a caller that supplies the field
is refused with `bot_persona_carrier_reserved`. The worker accepts it only on a signed protected
direct, non-agentic body, refuses an envelope whose persona differs from the signed body, and files
it first under `TRUSTED CONFIGURATION` as `[trusted-config source="bot-persona"]`, before the
untrusted body. It changes no allowed tool or scope: the final authority rebind still decides what
the model may invoke.

The worker's open-ended agentic loop, provider intents, connector credentials, raw mesh/batch calls
and Token Chase replay remain refused for protected applications. Call-time application tools are
the bounded exception: they execute through the controller broker, not the worker's native tool
registry. A configured CLI brain remains subject to the existing
demo/operator eligibility checks and final spawn guard; this protocol does not widen who may use a
CLI. General queued agentic work does not become supported merely because a ticket has captured
user provenance.

## Concierge node for inline application bots

An installed application's bot that is registered controller-inline (its manifest names no
`container:`) runs in the controller orchestrator, and the controller never runs a CLI (SEC-05). The
deployment operator's Antigravity login therefore cannot answer for those bots inline. Their turns
can instead run on one bot node, the concierge node: compose service `concierge-bot` (profile
`concierge-node`), started with `BOT_NODE_SERVES=inline-app-bots`.

**Who routes.** `resolveBotDispatchRoute` decides each turn's transport once, for
`executeBotOrInline` and for `POST /api/send-message` (before ticket intake). A bot with its own node
keeps it. Otherwise a turn goes to the concierge node only when all of these hold: the turn is
interactive (`direct: true`) and the caller is covered by the ADR-127 carve (`DEMO_MODE` and an exact
`OSHAL_OPERATOR_SUBS` entry); the caller chose no BYO connection, provider, credentials or provider
intent; `OSHAL_CONCIERGE_NODE_URL` is set on `oshal-api` and the target is an inline application bot
(the governing registry definition is an installed package's controller-inline bot, not a static
entry, not a kernel identity and not `requiresOwnNode`); the bot's harness needs a brain; the caller's
resolved brain is `antigravity-cli`; and `GET <url>/api/health` answers 2xx within 2 seconds (the
answer is cached for 15 seconds). Every other turn keeps its existing path, and a blank URL turns the
route off. When the node is unhealthy the turn stays inline; if the hosted ladder is then empty, the
422 `NO_HOSTED_BRAIN` body carries `detail: "concierge_node_unavailable"`. A concierge turn is sent
like a dedicated-node turn: the resolved brain is stamped as the authoritative provider, a protected
bot's turn is non-agentic and carries the signed `botPersona`, and its cost task is the served bot's.

**Node identity rule.** The signed delegation names the served bot as `azp`, never the concierge. On a
node started with `BOT_NODE_SERVES=inline-app-bots`, the delegation target is the body's `agentId`
(missing: `403 target_agent_mismatch`) and the token must name it (otherwise `401`). After the
signature verifies, and before the nonce is consumed, the node must serve the target: its own agent,
or an agent that an installed application durably owns (`oshal_application_execution_claims`), never
a kernel identity or a static registry entry. A refusal is `403 target_agent_not_served` and leaves
the nonce unspent; a failed ownership read refuses with `503`. A multi-agent node without delegation
verification keys, or with any other `BOT_NODE_SERVES` value, refuses to start. The protected
boundary requires `azp` to equal the envelope target and the target to be served. Dedicated nodes are
unchanged and admit only their own agent. On the concierge a served bot's turn refuses connector
credentials and provider intents, and an unprotected turn gets an agent-scoped task, so two bots on
one workspace never share history.

**Limits.**

- An unprotected application bot gets reasoning only on the concierge node. Its interactive turn
  runs host-tools-only and the node has no package tools, so application tools are not available,
  and it carries no bot persona (the persona carrier rides only on signed protected dispatch). Under
  the enforce authorization mode every installed application's bots are protected, so this applies
  only where a bot is unprotected.
- `protected_perspective` is an author-trusted override, reviewed in the package's own PR: it skips
  the perspective screen. The secret, size, UTF-8 and control-character refusals still apply to
  the whole composed persona.
- Queued manifest-worker dispatch is not routed to the concierge node yet (phase 2). Queued work for
  an inline application bot keeps its existing path.
- Route-backed tools still answer 401 when called from the node, until they are converted to package
  tools.

## Controller and worker protocol

1. The controller refreshes the initiating account and current application rights. It captures
   installed source/catalog/generation, exact principal, tenant, bot, task, workspace, original
   directory freshness and effective grant bounds in a durable execution record.
2. It includes the opaque `applicationExecutionId` in the existing Ed25519 delegated request and,
   when the owning application registered a persona for the bot, the controller-composed
   `botPersona`, both before signing, so the body digest covers them. It durably binds the complete
   body digest and recorded delegation claims before sending. Prompts (the persona included),
   provider keys and raw delegation tokens are not persisted in the authority record.
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
result boundary. SSE checks again for each event. A node chat reply is published on the task stream only after its
protected lineage, both persisted turns and the caller's read have been re-proved; the stream route
still authorizes every subscriber for that event. Protected cached facts are withheld from
automatic derived summaries until those summary paths retain complete source lineage.

Both migrations use forced row security for controller-only authority records. Runtime bootstrap
uses the same schema as installation. Existing delegation key configuration and
`SWARM_SERVICE_SECRET` are reused. Workers use trusted process configuration
`SWARM_CONTROLLER_URL` (default `http://oshal-api:5000`) and the controller public key ring; they
never receive the controller private signing key.

## Verification and release

`npm run test:remote-authorization` is the fixed local runner registered in AI Test Lab as
`protected-remote-application-execution`. It exercises real policy, signed HTTP, worker and SQLite
boundaries, canonical result stores/SSE, disposable PostgreSQL, and the delegation replay ledger
against a disposable Redis. Local Docker is needed for the PostgreSQL and Redis cases. No production
accounts, application records or live inference are used.

The Lab registration exposes the suites and prerequisites. Its browser step reports that the local
runner is required; it does not execute arbitrary host commands or claim that registration is a
passing deployment test. See [the run record](../releases/remote-authorization-2026-09-11.md) for
the final commands, counts and publication state.
