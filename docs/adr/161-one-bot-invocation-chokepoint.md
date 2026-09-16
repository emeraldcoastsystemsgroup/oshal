# ADR-161: Bot invocation is one chokepoint, and every caller clears the same admission decision

## Status

Accepted — 2026-09-16. The kernel half is built (this change); the Tier-C migration below is tracked
debt, not a claim about today.

## Context

Running a bot costs money, can reach a connector credential, and is the moment a caller's
entitlement to that bot actually matters. Those three controls only work if they sit somewhere every
invocation passes through.

`executeBotOrInline` ([src/app/routes/inline-bot-execution.ts](../../src/app/routes/inline-bot-execution.ts))
was built to be that place. It resolves the transport itself — a bot the registry binds to its own
container goes over HTTP to that node, a controller-inline concierge runs through the in-process
orchestrator — and both branches clear the same gates first: execute-time entitlement, the
specialist-context refusal, the two credential-carrier refusals (connector credentials require a
validated deterministic provider intent, and such an intent requires a dedicated audited bot node),
and the cost-governance verdict from `BudgetService`.

It was never the only door.

`POST /api/send-message` (and its alias `POST /api/tasks/:taskId/messages`) is the cockpit chat
panel's transport — the highest-volume interactive bot invocation in the product — and it grew its
own dispatch. PR #186 fixed half of that: when the resolved agent has a dedicated node endpoint the
route hands the turn to `executeBotOrInline` and the gates apply. A bot with **no** node endpoint
took the other branch and called `ctx.orchestrator.processMessage` directly. That branch cleared the
entitlement gate (added separately, guarded by
[tests/unit/send-message-entitlement.spec.ts](../../tests/unit/send-message-entitlement.spec.ts))
and nothing else.

The consequence was concrete, not theoretical: a user sitting on a definitively exceeded HARD daily
cap could keep spending indefinitely through the chat panel for as long as the bot they were talking
to was controller-inline. Every controller-inline bot in the registry is in that set, which is most
of the concierge fleet. The cap was a cap on node bots only, and nothing said so.

The route cannot simply call `executeBotOrInline`. Its turn carries a `ticketContext` (the
project-manager chat path opens real tickets from it) and an `interactionMode` that `BotNodeRequest`
has no field for; routing through the bot-node request shape would drop both. "Make every caller use
the one function" is the wrong instruction when the one function's parameter shape cannot express
what the caller is doing.

## Decision

**A bot invocation clears one admission decision, defined once. Transport is a separate question.**

`assertBotInvocationAdmissible(ctx, agentId, facts, hasDedicatedEndpoint)` is extracted from
`executeBotOrInline` and exported from the same module. It holds the specialist-context refusal, the
two credential-carrier refusals, and the cost-governance verdict, and it reads its inputs from a
structural `BotInvocationFacts` (owner sub, credential carriers) rather than a `BotNodeRequest`, so a
caller that cannot build a bot-node request can still be admitted by exactly this decision. The
budget refusal is now a typed `BudgetBlockedError` (`code: 'budget_cap_exceeded'`,
`statusCode: 402`) carrying the verdict — same message text as the untyped throw it replaces.

Callers are then one of three tiers.

**Tier A — the chokepoint.** `executeBotOrInline` is the default and remains so. It admits, resolves
the transport, carries the ADR-090 skill profile and the ADR-127 brain, and executes. Anything that
can call it, calls it. This is not changed by this ADR.

**Tier B — a caller that cannot take the bot-node request shape.** It calls
`assertBotInvocationAdmissible` itself, before any model work, any ladder walk and any ticket
creation, and then runs its own dispatch. There is exactly one such caller today: the inline branch
of `handleSendMessage` in
[src/app/routes/message-routes.ts](../../src/app/routes/message-routes.ts). A new Tier-B caller is a
reviewable decision, not a convenience — the justification has to be a shape the request type cannot
carry, as `ticketContext` is.

Execute-time entitlement is deliberately **not** inside the shared function. Both tiers already
assert it against the same pure `decideExecuteEntitlement`
([src/app/bot-node-execute-entitlement.ts](../../src/app/bot-node-execute-entitlement.ts)); asserting
it twice on one turn would double the audit line without adding a control.

**Tier C — invocations that reach a model without passing either.** These exist, they are named
below, and they are migration debt. A Tier-C call site is not sanctioned by being listed: listing it
is what stops it being invisible.

### The Tier-C register

| Call site | Shape | Owner | What is bypassed |
|---|---|---|---|
| `aero-lab/routes/aero-lab-routes.js` | `orchestrator.processMessage` direct | store package `aero-lab` | budget gate, credential refusals, entitlement |
| `bake-off/routes/bake-off-engine.js` | `orchestrator.processMessage` direct | store package `bake-off` | as above |
| `camera/routes/camera-routes.js` | `orchestrator.processMessage` direct | store package `camera` | as above |
| `dnd/lib/dnd-dm-service.js` | `orchestrator.processMessage` direct | store package `dnd` | as above |
| `drone/routes/drone-routes.js` | `orchestrator.processMessage` direct | store package `drone` | as above |
| `game-show/lib/host-service.js` | `orchestrator.processMessage` direct | store package `game-show` | as above |
| `movies/routes/movies-routes.js` | `orchestrator.processMessage` direct | store package `movies` | as above |
| `purchasing/routes/purchasing-routes.js` | `orchestrator.processMessage` direct | store package `purchasing` | as above |
| `sat-ops/routes/sat-routes.js` | `orchestrator.processMessage` direct | store package `sat-ops` | as above |
| `spotify/routes/spotify-routes.js` | `orchestrator.processMessage` direct | store package `spotify` | as above |
| `travel/routes/travel-routes.js` | `orchestrator.processMessage` direct | store package `travel` | as above |
| `src/pages/swarm-control/swarm-control.js:218` | browser `fetch` straight to `http://localhost:<botPort>/api/send-message` | core, swarm-control surface | every controller-side control: the request never reaches the controller at all |

Eleven store packages, enumerated by grepping `orchestrator.processMessage` across
`emeraldcoastsystemsgroup/oshal-applications` on 2026-09-16 (the `src-routes/*.ts` sources compile to
the `routes/*.js` shipped above; `output/` build residue and package tests are excluded). The count
is a measurement, not a recollection — re-measure rather than trusting this row.

The core call site is different in kind and worth stating plainly: `swarm-control.js` posts from the
**browser** to a bot node's own port. No controller gate can apply to it because the controller is
not in the path. Its migration is to route through the controller, not to add a check where there is
nothing to check.

Kernel call sites on Tier A, for contrast — they reach a model through `executeBotOrInline`, which
is where the admission gate lives: `ambient-enrichment-runtime.ts`, `home-schedule-dispatch.ts`,
`chat-channel-routes.ts`, `content-routes.ts`, `rca-routes.ts`, `security-routes.ts`,
`workflow-studio-assist-routes.ts`, `series-pipeline.ts`, `trading-earnings-rules.ts`,
`trading-engine.ts`, and `composition-root.ts`'s `executeBot` binding — which is how an installed app
package reaches a kernel bot the sanctioned way.

**Kernel call sites that are NOT admitted, measured rather than recalled.** These reach
`orchestrator.processMessage` directly, and nothing on the path calls the governance check:

| call site | what it serves |
|---|---|
| `ticket-routes.ts` `POST /api/tickets/:ticketId/chat` | a cockpit surface — the browser calls it |
| `schedule-runtime.ts` scheduled prompt dispatch | every scheduled model turn |
| `judge-routes.ts`, `persona-eval-routes.ts`, `test-lab-golden.ts` (two) | judge and evaluation lanes |
| `remote-client-chat-bridge.ts` | the remote-client bridge |
| `jarvis-orchestrator.ts` (one call) | a sub-step of a turn already admitted upstream |
| `linkedin-assistant-routes.ts` (one call) | one path beside its three admitted ones |

`jarvis-orchestrator.ts` and `linkedin-assistant-routes.ts` appear in BOTH lists on purpose: their
main paths go through the gate and each retains exactly one direct call. An earlier draft of this
ADR listed them as wholly Tier A, which read as "nothing to do here" and was wrong.
`token-chase-routes.ts` is excluded: it carries its own `TokenChaseBudgetGate`.

Re-derive the register rather than trusting this table — it is true on the day it was written:

```bash
grep -rn "orchestrator\.processMessage" src --include=*.ts | grep -v "\.spec\."   # every direct call
grep -rln "assertBotInvocationAdmissible\|checkBudget" src --include=*.ts            # everything that admits
```

## Consequences

**What this buys.** A HARD daily cap is now a cap on interactive chat, not a cap on node-backed
chat. The specialist-context and credential-carrier refusals apply to an inline chat turn for the
first time. A refused turn answers `402 budget_cap_exceeded` with the reason, instead of an anonymous
`500` the cockpit cannot distinguish from a crash. The admission decision has one definition, so the
two tiers cannot drift the way "copy the checks into the new caller" always eventually does.

**What it does not buy.** Three honest limits:

- The registers are lists, not fixes. Store packages on Tier C, and the kernel call sites tabled
  above, still reach a model without clearing anything — and this ADR does not change one of them.
  The count is deliberately not written here: it was hand-typed as "twelve" in an earlier draft and
  was wrong, in the half of the deliverable the done-when asks for. Run the two commands above.
- The budget gate reads `oshal_cost_events`, and **no inline chat path writes that ledger** — inline
  turns land usage in `chat_tasks` only. So the cap an inline turn now honours is fed by node,
  A2A, Argo and vision spend. That gap has its own BACKLOG entry ("Inline chat spend is invisible to
  windowed budget enforcement") and is not closed here; until it is, an inline-only user's own spend
  does not move their own window.
- The ADR-090 skill-profile carrier still lives in `executeBotOrInline` and does not run on the
  Tier-B path. That is a no-op today rather than a gap: `send-message` carries no `app`/`capability`
  on its request, so the profile would resolve to the empty string. Adding a body-supplied app id to
  that route would be a new caller-controlled surface and is deliberately not done.

**Cost.** One extra `BudgetService.checkBudget` on each inline chat turn — two indexed SELECTs, both
fail-open. A Tier-B caller is a maintenance obligation: a gate added to the shared function reaches
it automatically, but a gate added to `executeBotOrInline`'s body does not. New gates belong in the
shared function.

**Guard.**
[tests/unit/send-message-budget-gate.spec.ts](../../tests/unit/send-message-budget-gate.spec.ts)
drives the real `createMessageRoutes` router over real HTTP, picks the inline agent out of the real
swarm registry, and runs the real `BudgetService`; a tripped HARD cap must block the turn with a 402
before the orchestrator is called and before the brain ladder is walked, an under-cap turn must
proceed, and an unreadable budgets table must fail open. Only the pg driver is doubled — a fake pool
answering the service's own statements — and that scoped double is recorded in
[the real-boundary audit](../governance/real-boundary-regression-audit.md).

## References

- [ADR-036](036-bot-owned-application-architecture.md) — the bot owns the domain; the direct sync
  call is `BotNodeClient.execute` / `executeBotOrInline`, and cost is attributed to the bot.
- [ADR-087](087-access-roles-jarvis-visibility-scoping.md) — what entitlement is scoping.
- [ADR-090](090-skills-as-first-class-packages.md) — the skill-profile carrier the chokepoint resolves.
- [ADR-127](127-demo-mode-cli-brain-and-user-provider-preference.md) — the brain the chokepoint
  stamps on a dispatch.
