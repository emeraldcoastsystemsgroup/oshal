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

The carve is a *deployment* decision expressed as a flag, not an identity claim that outranks the
gate. A shared box leaves `DEMO_MODE` off and nothing changes. The guest demo surfaces that share
this stack are covered by the operator-identity half: a guest turn can never reach the CLI even
with the flag on.

> **Amended 2026-09-22 — the carve covers Google's two CLIs as well, and nothing else changes.**
> `gemini-cli` and `antigravity-cli` were in the `HarnessType` union and in
> `assertAuditedAutonomousHarness`'s refused set, but not in
> `assertUnattendedProviderPreflight`'s — so the check that runs *before* a task or workspace
> exists let them through, and the two Google terminal agents were guarded once where `codex-cli`
> and `claude-code` are guarded twice. They are now listed there, refused on exactly the same two
> conditions and no others: `DEMO_MODE` on **and** an exact `OSHAL_OPERATOR_SUBS` subject. A
> non-operator caller, a non-demo deployment and an identity-less request all keep the existing
> refusal, and `tests/unit/demo-cli-brain-carve.spec.ts` now runs every one of those negatives
> against both new ids.
>
> **The limit of this amendment.** It widens *which harness* the carve can select. It does not
> widen *who* the carve covers, it does not change `assertAuditedAutonomousHarness`, and it does
> not touch the any-bot spawn boundary — `assert-cli-tool-boundary.js` already listed every
> spelling of both CLIs under this same carve. Two ids that look adjacent stay deliberately
> outside the refused set: `gemini` (the Cline-backed API provider id) and `google-gemini` (the
> apiType) name an HTTP endpoint with no tool loop and no credential home, and refusing them would
> break the ordinary hosted Google lane rather than harden anything.

> **Amended 2026-09-22 (second) — what shipped, and the two things that did not.**
>
> This amendment corrects the first one above, which described a Google rail as working when the
> half that executes a turn does not exist. It is written to match
> [the backlog entry](../BACKLOG.md) exactly; where the two ever disagree, the backlog is the one
> being kept current and this is the one to fix.
>
> **Shipped and proven by guards.**
> - The carve extension described above. It is a strict tightening and nothing depends on it
>   being reverted.
> - `POST /api/gemini/auth/import` and `/signout`, mirroring the Claude Code routes: the same
>   operator-session guard, the same SEC-05 409 for every other caller and every non-demo
>   deployment, an atomic 0600 write to the mounted path, and no credential material in any
>   response body or log line (`tests/unit/gemini-demo-login-adoption.spec.ts` asserts the absence
>   explicitly rather than assuming it).
> - `cliBrainOffer`: one function answering whether a CLI brain may be offered, called by BOTH the
>   settings surface and the resolver, so an option cannot be offered that a turn would not run on.
> - An unresolvable dispatch (`AuthoritativeDispatchConfigError`) is classified retryable-to-hosted,
>   so a mis-selected CLI brain degrades instead of reaching the user as a raw provider error.
>
> **PR #787 did not ship a bot node that could execute either Google CLI.** At that boundary,
> `HARNESS_BY_ID` gave both ids `botNodeRuntime: null`, and neither was a `ProviderRegistry`
> id, so `resolveBotNodeSwitch` answers null and `reconcileDispatchProviderConfig` refuses the
> dispatch **by name**. The first version of this rail offered the Gemini brain the moment a login
> was pushed; the option was selectable, `PUT` accepted it, and every turn afterwards failed. The
> option became unavailable and `PUT` refused it, each naming the missing piece.
>
> The follow-on `antigravity-bot-runtime` branch adds that fourth runtime without changing the
> fleet's musl base. A checksum-pinned vendor binary runs through a private Debian glibc loader;
> the any-bot wrapper uses stream-json stdin and remains behind the ADR-127 boundary. Installation
> does not imply readiness: the operator's Windows Credential Manager session cannot be copied to
> Linux, and Google's account-auth path requires a persistent Linux Secret Service/D-Bus keyring
> that the image does not yet provide. The option stays closed until that service exists, a login
> is live-proved, and
> `ANTIGRAVITY_ACCOUNT_LOGIN_READY=true` records that proof.
>
> **Did NOT ship, and cannot: the Gemini CLI sign-in the push rail was built around.** On
> 2026-09-22 the operator ran `gemini` and chose *Sign in with Google*. Google answered, verbatim:
>
> > Failed to sign in. Message: This client is no longer supported for Gemini Code Assist for
> > individuals. To continue using Gemini, please migrate to the Antigravity suite of products:
> > https://antigravity.google
>
> `~/.gemini/oauth_creds.json` therefore cannot be produced by a sign-in any more, so the push rail
> has nothing to carry. The client row is marked `dormant` in `LOGIN_TARGETS` rather than deleted,
> and `isPushableLogin` reads that flag: the row, the file shape, the parse arm and the import
> route are all still correct and still guarded, and reviving them is deleting one block. The
> earlier claim that a pushed login "can only be used through the CLI harness" remains true about
> the ENDPOINT — `oauth-personal` builds against `cloudcode-pa.googleapis.com`, not
> `generativelanguage.googleapis.com` — but it is now moot, because the credential is unobtainable
> and the harness is unrunnable.
>
> **What Google points individuals at instead is Antigravity, and it works on Windows.**
> Measured on the operator's own machine: `agy` v1.2.8 at `%LOCALAPPDATA%\agy\bin\agy.exe`,
> already authenticated as him, `agy models` listing ids the shared API key cannot reach, and
> `agy --model gemini-3.8-flash-low -p "…"` answering — on the exact model that returns 503 "high
> demand" through the API key on every other transport. It is headless by design (`-p`,
> `--output-format`, `--model`, `--effort`). It originally could not run **here**: every bot node is the
> one `oshal-bot:latest` image, `Dockerfile.oshal` is `FROM node:20-alpine`, and the CLI ships no
> musl build while its glibc PIE fails to relocate under `gcompat` (measured in a throwaway
> container; `AntigravityCliHarnessAdapter` has carried the sentence since). The private-loader
> runtime closes the executable gap; node authentication and the recorded live turn remain.

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

> **Amended 2026-08-12 by [ADR-128](128-codex-fleet-default.md):** rung 2's order is now
> **`openai-codex`, then `claude-code`** (`DEMO_CLI_ORDER` in
> [user-brain-resolution.ts](../../src/app/routes/user-brain-resolution.ts)) — codex became the
> swarm's default CLI/API/LLM fleet-wide. Everything else in this ladder, and both carves'
> security conditions, are unchanged.

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
- **A CLI turn's recorded cost is a price-equivalent, not a bill.** Corrected against a live run:
  the Claude Code CLI *does* report a per-call figure ($0.079 for the first real operator turn) and
  it lands in `chat_tasks` like any other. What it is not is money that changed hands — a
  subscription already paid for that call. Any surface summing cost across providers is therefore
  adding two different units, and must say which turns were subscription-backed rather than
  presenting one total as spend.
- **Open-source deployments get the options without inheriting the risk.** Defaults ship closed:
  no `DEMO_MODE`, no key lending, no CLI. A deployment turns on exactly what its threat model
  allows.
