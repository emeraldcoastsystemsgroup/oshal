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

### 1. `DEMO_MODE` gates a CLI unlock at bot nodes, scoped to the deployment's operator

`assertUnattendedProviderPreflight` gains one carve, and it requires **both** conditions:

- `DEMO_MODE` is on for the deployment, **and**
- the request carries an operator identity — `userSub` present and exactly matching an entry in
  `OSHAL_OPERATOR_SUBS` (the same case-sensitive, exact comparison the free-tier exemption uses).

Anything else keeps today's refusal, unchanged and fail-closed: `DEMO_MODE` off refuses, a
non-operator caller refuses, and a request with no identity at all refuses. That last clause is
deliberate — unattended work with no owner is precisely the content-driven case SEC-05 was written
for, and a demo switch must not quietly enable it.

Every unlocked execution logs an audit line naming the provider, the agent, and the operator sub.
An unlock that leaves no trace is not auditable, and this one is a posture exception.

The carve is a *deployment* decision expressed as a flag, not an identity claim that outranks the
gate. A shared box leaves `DEMO_MODE` off and nothing changes. The guest demo surfaces that share
this stack are covered by the operator-identity half: a guest turn can never reach the CLI even
with the flag on.

### 2. A per-user default provider, stored and honoured

New per-user preference (`oshal_user_llm_prefs`, keyed by `user_sub`, one row) holding the brain
that user wants their work to run on. It is a preference, not an authorization: it can only select
something the caller may already use, and an unusable preference degrades to the next rung rather
than failing the turn.

Resolution order becomes:

1. the user's saved preference, when it resolves to something usable;
2. the demo default — `claude-code`, then `codex` — when the CLI unlock applies to this caller;
3. the caller's explicit BYO hosted connection;
4. (non-operator) their own free tiers, then the platform free lane;
5. (operator, demo) the deployment's own hosted API keys — the operator-key lane;
6. nothing: the honest no-engine answer.

Claude Code is the default default when the unlock applies, per operator direction. A user who
pastes their own key and selects it in Settings overrides all of the above, which is the point:
the ladder is what happens when nobody has chosen.

### 3. Settings owns the choice

The Bot LLM access block on `/utilities` already connects Claude Code, Codex, the free tiers, and
a bring-your-own endpoint. It gains the missing control: which of them is *mine by default*. The
selector lists only what that caller can actually use and names what will run when they choose
nothing.

## Consequences

- **The injection exposure is real and now deliberately accepted for one identity on one flag.** On
  a demo box the operator's turns run a CLI harness with shell and credential-home access, and
  prompt content assembled from email, web, or ticket bodies reaches that loop. This is acceptable
  for a single-operator dev/demo install and is not acceptable as a default; hence off by default,
  operator-only, and audited. The brokered sandbox remains the real fix and stays on the roadmap —
  this ADR does not claim to have built it.
- **`DEMO_MODE` is now load-bearing for security, not just seeding.** It was previously a
  convenience flag (`shouldSeedDemoData` reads it alongside `MOCK_OIDC`). The key-lending and CLI
  paths read `DEMO_MODE` *alone* and never `MOCK_OIDC` — mock auth is a local-testing convenience
  and must never, by itself, unlock a real subscription. Any future consumer of this flag inherits
  that rule.
- **A preference makes the ladder legible.** The failure mode this replaces was silent: three
  connected providers, no way to know which would run, and no way to change it. The cost is one
  more piece of per-user state to migrate, back up, and delete on account deletion.
- **CLI turns are not cost-attributed the way hosted turns are.** A subscription CLI reports no
  per-call price, so `chat_tasks` records the call without a dollar figure. Cost dashboards must
  keep reading provider-reported usage and not infer spend from call counts.
- **Open-source deployments get the options without inheriting the risk.** Defaults ship closed:
  no `DEMO_MODE`, no key lending, no CLI. A deployment turns on exactly what its threat model
  allows.
