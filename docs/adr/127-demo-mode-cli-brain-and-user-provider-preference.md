# ADR-127 — Demo-mode CLI brain + a per-user default provider

Status: Accepted
Date: 2026-08-09

## Context

SEC-05 made bot nodes refuse every unbrokered autonomous CLI harness
(`assertUnattendedProviderPreflight` in [bot-node-execution-handler.ts](../../src/app/bot-node-execution-handler.ts)):
`cline`, `claude-code`, `codex`, `openai-codex`. The reasoning holds and is not in dispute — a CLI
harness owns its own tool loop, can read its credential home, and cannot revalidate oshal's handler
generation or operation scopes mid-loop. A prompt-injection audit on this codebase demonstrated the
full chain (injection → shell → acting as another user) and bot nodes connect to Postgres with high
privilege. Where prompt content originates outside the caller — an email body, a fetched page, a
ticket description written by someone else — handing that loop a live subscription is exactly the
exposure SEC-05 exists to stop.

What SEC-05 did not account for is the single-operator deployment, which is the shape almost every
oshal install starts as. On such a box the operator's own CLI subscription is not an exotic
credential to be brokered away from the model — it is the brain they installed the product to use,
already sitting in `~/.claude` and `~/.codex`, mounted into the containers on purpose. With the
refusal in place and no explicit hosted connection saved, an operator turn resolved to nothing at
all: the resolver returned `undefined`, the node fell to its configured provider, the preflight
refused it, and the user got "Sorry, that didn't work" while a working `claude` binary and a fresh
credential sat one process away. ADR-064's free-tier legs did not cover it either, because the
operator is exempt from those by their own directive.

The immediate hole was closed by the DEMO-gated operator-key lane (this deployment's own hosted API
keys, resolved controller-side and passed as a normal `byoLlmConnection`). That works, and it is
the right default for a box with API keys. It is still the wrong answer for the operator who has a
Claude Code subscription and reasonably asks why their own login is the one thing they cannot use.

Two problems are therefore in scope, and they are the same problem seen from both ends:

1. There is no admissible path from a mounted CLI login to an executed turn, under any conditions.
2. There is no per-user answer to "which brain should run my work" — resolution is a fixed ladder
   (explicit BYO → free tier → platform free), with the operator-key lane bolted underneath. A user
   who has connected three things cannot say which one they want.

## Decision

### 1. `DEMO_MODE` gates a CLI unlock at bot nodes, scoped to exact deployment identities

`assertUnattendedProviderPreflight` gains one carve. It requires `DEMO_MODE` plus one of these
exact identity/provider conditions:

- the request carries an operator identity — `userSub` exactly matches `OSHAL_OPERATOR_SUBS`; or
- the request is Codex (`codex`, `codex-cli`, or `openai-codex`) and `userSub` exactly matches
  `OSHAL_DEMO_CLI_SUBS`.

`OSHAL_DEMO_CLI_SUBS` is a brain entitlement only. It is never read by RBAC, Security Center,
cross-user access, CLI-token minting, or any other operator gate. It exists for a bounded customer
demo whose pre-provisioned users must share the deployment's mounted Codex subscription without
being made platform operators. It is empty by default and wildcard values do not match.

Anything else keeps today's refusal, unchanged and fail-closed: `DEMO_MODE` off refuses, an
unlisted caller refuses, a demo user selecting a non-Codex CLI refuses, and a request with no
identity at all refuses. That last clause is deliberate — unattended work with no owner is
precisely the content-driven case SEC-05 was written for, and a demo switch must not quietly enable
it.

Every unlock is logged at both enforcement boundaries. The TypeScript preflight records the
provider and caller subject; the final JavaScript spawn boundary records the provider. Normal task
and dispatch logs carry the agent/task correlation. An unlock that leaves no trace is not
auditable, and this one is a posture exception.

**SEC-05 is two boundaries, not one, and both need the carve.** The TypeScript preflight decides
whether work is *accepted*; any-bot's `assertCliToolBoundary` decides whether a process is
*spawned*, and it refuses for a different reason — the CLI cannot enforce the server-issued tool
list. Carving only the first produced an execution that passed policy and then died at the spawn
gate (`UNENFORCEABLE_CLI_TOOL_BOUNDARY`, 65ms, empty response), which is how this second layer was
found. The spawn gate now applies the identical two conditions, with one difference that matters:
it reads the subject from the per-request spawn env the handler builds
(`extraEnv.OSHAL_USER_SUB`), never from a caller-supplied option. An earlier revision of that file
removed exactly such a bypass (a caller-asserted `brokeredSandbox` flag); re-introducing one in a
different shape would be the same defect wearing a demo hat.

The carve is a *deployment* decision expressed as a flag plus exact subject lists, not an identity
claim that outranks the gate. A shared box leaves `DEMO_MODE` off and nothing changes. A customer
demo lists only its pre-provisioned canonical subjects; every other guest remains unable to reach
the CLI even with the flag on.

### 2. A per-user default provider, stored and honoured

New per-user preference (`oshal_user_llm_prefs`, keyed by `user_sub`, one row) holding the brain
that user wants their work to run on. It is a preference, not an authorization: it can only select
something the caller may already use, and an unusable preference degrades to the next rung rather
than failing the turn.

Resolution order becomes:

1. the user's saved preference, when it resolves to something usable;
2. the demo default — Codex — when the CLI unlock applies to this caller;
3. the caller's explicit BYO hosted connection;
4. (non-operator) their own free tiers, then the platform free lane;
5. (operator, demo) the deployment's own hosted API keys — the operator-key lane;
6. nothing: the honest no-engine answer.

The original 2026-08-09 decision made Claude Code the default. [ADR-128](128-codex-fleet-default.md)
first changed rung 2 to Codex-then-Claude on 2026-08-12, then Amendment 1 removed automatic Claude
fallback on 2026-08-13. The current `DEMO_CLI_ORDER` is therefore **`['openai-codex']`**. A user who
connects their own endpoint and selects it in Settings still overrides the automatic rung; an
operator may also select Claude explicitly when that mounted login is usable.

> **Amended 2026-08-17 for bounded customer demos:** an exact `OSHAL_DEMO_CLI_SUBS` list may use
> the mounted Codex login without operator RBAC. These nonoperator subjects are Codex-only: a saved
> Claude/Cline preference cannot expand the entitlement and falls through to the Codex demo
> default. Operators retain the original provider-flexible carve. The controller resolver,
> TypeScript node preflight, and final JavaScript spawn boundary all apply the same decision.

### 3. Settings owns the choice

The Bot LLM access block on `/utilities` already connects Claude Code, Codex, the free tiers, and
a bring-your-own endpoint. It gains the missing control: which of them is *mine by default*. The
selector lists only what that caller can actually use and names what will run when they choose
nothing.

## Consequences

- **The injection exposure is real and deliberately accepted for exact identities on one flag.**
  On a demo box an operator may run the mounted CLIs, and explicitly listed customer-demo users may
  run mounted Codex. Prompt content assembled from email, web, or ticket bodies reaches that loop.
  This is not acceptable as a default; hence `DEMO_MODE` off by default, an empty demo-user list,
  Codex-only nonoperator access, exact subject matching, normal bot/app entitlements, and an audit
  line on every pass. The brokered sandbox remains the real fix and stays on the roadmap — this ADR
  does not claim to have built it.
- **`DEMO_MODE` is now load-bearing for security, not just seeding.** It was previously a
  convenience flag (`shouldSeedDemoData` reads it alongside `MOCK_OIDC`). The key-lending and CLI
  paths read `DEMO_MODE` *alone* and never `MOCK_OIDC` — mock auth is a local-testing convenience
  and must never, by itself, unlock a real subscription. Any future consumer of this flag inherits
  that rule.
- **A preference makes the ladder legible.** The failure mode this replaces was silent: three
  connected providers, no way to know which would run, and no way to change it. The cost is one
  more piece of per-user state to migrate, back up, and delete on account deletion.
- **A CLI turn's recorded cost is a price-equivalent, not a bill.** Corrected against a live run:
  the Claude Code CLI *does* report a per-call figure ($0.079 for the first real operator turn) and
  it lands in `chat_tasks` like any other. What it is not is money that changed hands — a
  subscription already paid for that call. Any surface summing cost across providers is therefore
  adding two different units, and must say which turns were subscription-backed rather than
  presenting one total as spend.
- **Open-source deployments get the options without inheriting the risk.** Defaults ship closed:
  no `DEMO_MODE`, no key lending, no CLI. A deployment turns on exactly what its threat model
  allows.
