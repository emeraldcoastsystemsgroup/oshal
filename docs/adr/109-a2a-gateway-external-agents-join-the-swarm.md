# ADR-109: A2A gateway — external agents join the swarm

**Status:** Accepted (2026-07-18) — BUILT + live-proven (proof gaps below are honest, not blocking).
Feature slice `src/features/a2a-gateway`, routes `/api/a2a` (`src/app/routes/a2a-routes.ts`),
outbound harness `a2a` (`src/features/llm-provider/services/a2a-harness-adapter.ts`), migration
`089-a2a-gateway.sql`. Default-off via `A2A_GATEWAY_ENABLED`. Closes BACKLOG "Plan F — wrap up the
A2A gateway".

## Context

OSHAL already *drove* remote workers it owns — `/api/remote-clients/...`, shared-secret,
live-proven on an operator-controlled edge node (`@oshal/chat`). That is not A2A: it is one
operator's own devices joining over a private rail. Plan F named the actual gap — **a third-party
agent, implementation unknown, cannot join the swarm and the swarm cannot hand it work.** Three
things had to be true before that gap could close, and each maps onto an existing platform rail
rather than a bespoke one:

- **Discovery without a global secret.** External agents need a card to find; OSHAL bots need a
  card to be found. ADR-087 already curates which bots are visible/callable outside the swarm
  (`accessRoles`) — the A2A card had to reuse that denylist verbatim, not maintain a second list
  that could drift.
- **Inbound auth that is per-agent, not per-swarm.** The single `sharedSecret` remote-client model
  doesn't scale to "any agent on the internet" — one leaked secret would be every foreign agent's
  secret. This is the same shape as connector capability-scoping and the token broker (ADR-042):
  mint a credential, hash it at rest, scope it, revoke it independently.
- **Inbound tasks must be real tickets, not a side channel.** CLAUDE.md's two-runtimes rule is
  absolute: the controller never calls an LLM. An inbound A2A task has to become an actual ticket
  on the existing queue/dispatch rails — budgets (ADR-104), DLQ, run-trace (ADR-107) all apply for
  free, or none of them do and the gateway is an unaudited backdoor.
- **Outbound must be a harness, not a fetch call bolted onto a bot.** Under ADR-033's
  multi-harness framework, an external A2A agent as a dispatch target is a first-class harness
  (`a2a`), compile-forced through `HARNESS_FACTORIES`, not a special-cased fetch.

## Decision

1. **Default-off public agent card.** `GET /api/a2a/.well-known/agent-card.json` (and the JSON-RPC
   endpoint) are **404 unless `A2A_GATEWAY_ENABLED=true`** — there is no such thing as an
   accidentally-live gateway. The card is curated: only bots `isBotAccessibleTo(id, 'jarvis')`
   allows are listed as skills (id = a bot-name slug, never a UUID), so the same discovery gate
   ADR-087 already enforces for Jarvis governs what a stranger on the internet can even see.
2. **Per-agent hashed credentials + scopes, never a global secret.** Operator-only
   `POST /api/a2a/agents` mints a credential (`oshal_a2a_...` token, hashed at rest, scoped to
   `message:send` / `tasks:read` / `tasks:cancel`); management routes are `requiresAuth` +
   operator-gated, mirroring `budget-routes.ts`. The JSON-RPC endpoint authenticates each call by
   per-agent Bearer, not OIDC — that's the one deliberate exception to "every route is
   `requiresAuth`," because the caller is by definition not an OIDC principal.
3. **Inbound tasks are real tickets under a synthetic `a2a:<agentId>` sub.** `message/send` files
   a ticket the same way any other intake path does, owned by `a2a:<agentId>` so RLS, budgets, DLQ,
   and run-trace all apply unmodified. The route re-enters `runWithRequestIdentity` with that sub
   after Bearer auth succeeds (the same post-auth identity re-entry pattern
   `chat-channel-routes.ts` already uses) — server.ts's ambient anonymous identity must never leak
   into a ticket write. `tasks/get`/`tasks/cancel` project ticket status into the A2A `TaskState`
   enum; a ticket the caller doesn't own reads back as not-found (no existence oracle).
4. **Outbound is a first-class harness, not a special case.** `a2a` joins the `HarnessType` union
   and `HARNESS_FACTORIES` (compile-forced per ADR-033) alongside `cline`/`codex-cli`/`claude-code`/`gemini-cli`. A bot dispatched through it calls a remote agent's `message/send`, polls
   `tasks/get`, and returns the remote's artifact — the remote agent owns its own reasoning; the
   OSHAL controller still never calls an LLM.
5. **Cost is real-or-honestly-flagged, never silently free.** When the remote agent reports real
   usage/cost, it is persisted as a dollar-only supplemental `chat_tasks` stamp
   (`costSource: 'a2a-remote-reported'`) additive with the existing token-counting pipeline (no
   double-billing — the token/request counts stay zero on this stamp). When the remote reports
   nothing, the event is marked `costUnknown: 'a2a-remote'` rather than defaulting to an unflagged
   `$0`, because the generic per-provider cost resolver has no pricing table for a provider it has
   never seen.
6. **Mesh stays internal.** Nothing in this gateway touches the Redis mesh (`oshal:mesh:agent.*`).
   In-swarm bots talk to each other over the mesh; only genuinely external agents ever go through
   `/api/a2a` or the `a2a` harness. This split is structural, not a convention — the gateway code
   has no path to a mesh channel.

## Consequences

- **A foreign, non-OSHAL A2A agent can join and be joined.** Proven live end-to-end against a real
  standalone third-party-shaped agent (`tools/a2a-sample-agent/`, zero repo/npm deps): operator
  mints a credential → the agent's card is discoverable → `message/send` lands a real ticket in
  Postgres under `a2a:<agentId>` → `tasks/get` reflects real state → outbound dispatch to that same
  agent round-trips real computed work (not an echo) with real per-call cost attribution flowing
  through `recordCost` end to end.
- **Three real vulnerabilities were found and closed by adversarial review before this shipped as
  final**, not left as known gaps: (a) the RLS-identity leak where every inbound write ran under
  the ambient anonymous request identity instead of the agent's own sub, silently zeroing the
  inbound rate ceiling and hiding the agent's own tickets from it; (b) the cost stamper discarding
  a remote agent's real reported dollar figure as an unflagged `$0` because the generic pipeline
  has no `a2a` pricing entry; (c) the ADR-087 call-out role gate keying off `metadata.source ===
  'jarvis'` only, so an A2A-sourced ticket could call out to operator/swarm-scoped bots the card
  itself refuses to list. All three are fixed and regression-tested.
- **Deploy-gate work remains, tracked as BACKLOG done-when items, not overclaimed here:**
  migration `089-a2a-gateway.sql` has not been applied to the live stack and `A2A_GATEWAY_ENABLED`
  is not yet set anywhere — the surface stays structurally 404 until an operator opts in on a real
  deployment. The inbound proof filed and state-mapped a real ticket but did not execute it to
  completion (the proof's isolated DB is deliberately unreachable from the live mesh/dispatcher, by
  design, so the live paid api can never dispatch a ticket filed by a security proof). No real
  third-party vendor's A2A agent (Google/Microsoft/other A2A implementations) has been tried yet —
  only a standalone hand-built one.
- Two ways for a bot to reach the outside world now exist for genuinely different reasons: the
  `remote-client` rail (operator's own devices, shared secret, full remote-control surface) and A2A
  (any external agent, per-agent scoped credential, task-shaped only). Do not merge them — the
  trust models are not the same.
