# Provider fallback chain — the review findings not yet fixed

An adversarial five-lens review of PR #645 returned **block** with 28 findings: 3 blocking,
15 should-fix, 10 nit. The review ran *after* #645 had already merged, so the three blocking
findings were fixed on `main` in the follow-up PR, together with four others that were cheap and
security-bearing. **This file is the remaining 21.**

Every finding below was verified by the reviewer by executing the code, not by reading it. Where a
claim has been re-checked since, that is noted. Nothing here is speculation, and nothing here is a
redesign of something already working.

## Already fixed, for the record

| # | what | where |
|---|---|---|
| 1 | a rung that is not a native runtime name was silently dropped at the node | `bot-node-runtime.ts` |
| 2 | `OSHAL_PROVIDER_FALLBACK_ORDER` blanked on every boot pull in the default config | `bot-node-config-bootstrap.ts`, both route sites |
| 3 | two specs left red, so `main` was red | `bot-node-config-bootstrap.spec.ts`, `bot-node-llm-provider-route.spec.ts` |
| 4 | the ADR-128 codex floor guard went red from ambient environment | `codex-default-floor.spec.ts` |
| 10 | the antigravity security fix shipped with no behavioural guard | `any-bot-cli-security-boundary.spec.ts` |
| 26 | the **JS-side** spawn boundary never learned any antigravity spelling | `assert-cli-tool-boundary.js` |

Finding 26 is worth naming plainly: `antigravity-cli` was added to the TypeScript unbrokered-denial
set and not to the JavaScript one, which is the half that gates the actual spawn. Not reachable
(the harness has no bot-node runtime), but it is the same "fixed one of two" shape twice in one
branch.

---

## Should-fix

### F5 — `OSHAL_PROVIDER_AUTO_FAILOVER` is dead in both arms, and a new line asserts otherwise — S

The resolver consults it only after the configured order has already returned, so a configured
chain cannot be switched off with it and an unconfigured node has nothing to switch off. This PR
added a `.env.example` line describing it as the kill switch.

**Done when.** Either the variable is consulted before the configured order returns, or it is
deleted from the resolver, `.env.example` and `docker-compose.oshal-local.yml` — with a case
pinning whichever was chosen. A variable that is documented and inert is worse than one that is
absent.

### F6 — the api-side `environment` rung has zero callers, so the documented ladder is three rungs — S

`resolveProviderFallbackChain` accepts `environmentOrder` and defines a `'environment'` source;
nothing in the repo, production or test, ever passes it.

**Done when.** Either `provider-switch-snapshot.ts` passes the api process's
`OSHAL_PROVIDER_FALLBACK_ORDER`, or the parameter and the `'environment'` source are deleted and
the migration 148 `COMMENT` plus the JSDoc are corrected to the ladder that actually runs. ADR-162
names five rungs; whatever is chosen, the ADR and the code must agree.

### F7 — "usable as a fallback rung" is asserted in five durable places and is false — S

Re-verified after the rung fix: `HARNESS_BY_ID` gives both `gemini-cli` and `antigravity-cli`
`botNodeRuntime: null`, so neither resolves to a runtime and neither can be a rung. A Cline-backed
**API provider** id can be; a CLI **harness** with no bot-node runtime cannot. The claim appears in
`ROADMAP.md`, `bot-provider-switch.ts` change-log 6, the adapter class JSDoc,
`provider-runtime.ts` change-log 17 and one more site.

Change-log 6 also says such an id is "refused with a reason at a node rather than silently
dropped". It is dropped, with a `logger.warn` nothing surfaces — the opposite of what it claims.

**Done when.** All five sites say "selectable" (true api-side) without "usable as a fallback rung",
change-log 6's refusal sentence is corrected, and a case asserts that a `botNodeRuntime: null` id
produces no rung. Gate on the identifier, not on the phrasing — the five sites word it differently.

### F8 — the Antigravity adapter's two advertised behaviours can never execute — S

`blockingReason()` and `ensureProviderSettings()` are unreachable, so the "measured musl cause"
the PR advertises appears on no surface an operator can see.

**Done when.** Either `blockingReason()` is surfaced where it is reachable (override
`healthCheck()`, and/or return it from the id classifier so the cockpit can render it), or
change-log 2, the ROADMAP row and the `antigravity-and-node-footprint.md` done-when criterion are
corrected to say the harness refuses with the SEC-05 text and that the musl sentence is reference
material rather than a runtime message.

### F9 — the two Antigravity guards are source-text greps the change-log prose alone satisfies — S

`antigravity-cli-harness.spec.ts` asserts the adapter file *contains* `linux_amd64_musl.json` and
`ensureProviderSettings`. Both strings appear in the change log, so the cases go green on a broken
adapter. This is the "substring guards are not guards" shape this repo has a rule about, and I
wrote it.

**Done when.** The cases call the methods: `blockingReason()` with the libc probe stubbed for musl
and for glibc, asserting the sentence vs `null`; `ensureProviderSettings()` against a temp path,
once with an existing file (bytes unchanged) and once against an unwritable directory (warns, does
not throw). The greps may stay as a companion, not as the evidence.

### F11 — the self-reference refusal compares raw spellings, so every alias evades it — S

`PUT /api/agents/provider-switch/fleet-default` refuses a chain naming its own primary by comparing
the strings as written, so `codex-cli` in a chain whose primary is `openai-codex` is accepted 200,
stored, and shown in the cockpit. The node now drops it (the rung fix dedupes on the resolved
target), so the row is merely a lie rather than a hazard — but the api should not accept it.

**Done when.** Both the self-reference refusal and the dedupe compare the classified identity
(`harnessType` plus the Cline backing id, or a canonical lowercased id), and
`provider-fallback-chain.spec.ts` gains the alias case its "however the administrator writes it"
title already promises — today it covers casing only.

### F12 — the cockpit cannot express NULL and destroys it on every save — S

The store deliberately protects an existing chain when a provider changes, and the only UI that
writes the row sends `fallbackOrder` on every save, so that protection is unreachable from the
cockpit. An administrator who edits the model and saves silently clears the chain.

**Done when.** The control tracks a dirty flag (or offers an explicit "inherit" state) and omits
`fallbackOrder` from the PUT when it was not touched; `null` and `[]` render distinguishably in the
input, as `describeChain` already does in the status line.

### F13 — the success banner promises immediacy the code does not deliver — S

"Fallback order: A → B. The next dispatch to an idle bot runs on it." The chain reaches a node on
its **boot pull**, not on the next dispatch.

**Done when.** The sentence is split — immediacy kept for the provider, and the chain stated as
applying at each bot's next start — or the chain is carried on the dispatch/config-change path so
the sentence becomes true.

### F14 — fleet-wide automatic failover was deleted with no ADR amendment — S

An operator directive recorded as Accepted (ADR-128) is reversed by removing the default ladder.
The PR body carries the upgrade note; no ADR does.

**Done when.** An ADR-128 amendment (or an ADR for migration 148) records that the default ladder
is gone in favour of an administrator-written chain, and states what must be written before deploy
to restore the previous behaviour.

### F15 — neither new spec is in the feature's test command or the Test Lab, and three refusal branches have no test — S

**Done when.** Both spec paths are appended to `test:provider-switch` in `package.json`; the three
new 400 refusal branches on `PUT /api/agents/provider-switch/fleet-default` have cases in
`provider-switch-routes.spec.ts`; both specs are registered in `test-lab-scenarios.ts` with
unit-level `regressionTests` references. A test file on disk is not Test Lab registration.

### F16 — the "no provider may be named" greps are defeated by a rename, and the rationale is backwards — S

Three source greps over one function body. Moving the code out of that body, or renaming the
function, turns them green on a violation. The change-log entry defending them argues the reverse
of what they do.

**Done when.** The greps are dropped or rewritten as behavioural checks — the unconfigured-node
case already *is* the real guard — and change-log entry 1's rationale is corrected.

### F17 — "status is authoritative" is implemented as a denylist, so an unknown status returns as the answer — S

Four names are rejected; anything else with exit 0 is handed back as the model's response. The
spec's own framing ("a zero exit with status ERROR is the shape that would otherwise be handed to a
user AS THE ANSWER") is defeated by any status name the vendor adds.

**Done when.** The check is an allowlist: succeed only on `SUCCESS` (plus, if deliberately
tolerated, a genuinely absent status), and throw carrying `parsed.error` and the raw status for
everything else. A case covers an unrecognised status name.

### F18 — the whole prompt is delivered as a single argv value — S

The failure mode this repo already fixed live for the two sibling adapters.

**Done when.** The prompt is delivered on stdin if `agy -p` reads it when the value is omitted; if
it does not, the comment says so and names what was tested, and the argv value is explicitly
bounded.

---

## Nit

| # | where | what |
|---|---|---|
| F19 | `provider-fallback-chain.spec.ts` | "the surface must name no provider" passes only because of quote style; the surface names three |
| F20 | `bot-node-runtime.ts` JSDoc | "No provider is named in this file" is literally false — the three runtime keys are named 200 lines up. Reword to: no fallback POLICY is named here |
| F21 | `cost-unit.ts` | `antigravity-cli` is absent from `PRICE_EQUIVALENT_PROVIDERS` / `PRICE_EQUIVALENT_HARNESS_TYPES` where its sibling `gemini-cli` is listed |
| F22 | antigravity adapter | the default settings path lands inside a read-only bind mount in the shipped stack, and inside the operator's real `~/.gemini` on a host run |
| F23 | `.env.example` | six new `ANTIGRAVITY_*` knobs, none documented |
| F24 | antigravity adapter | a non-numeric `ANTIGRAVITY_TIMEOUT_MS` yields `NaN`, because `??` catches only null/undefined |
| F25 | `swarm-apps/types.ts` | "selectable like any other provider" is untrue at the manifest boundary |
| F27 | `ProviderFailoverProvider.js` | with the nested chain, `providerFailover.fallback` reports the FIRST rung even when a deeper one answered |
| F28 | real-boundary audit | the `provider-switch-store-postgres` row is stale for this change |

F27 is worth pulling out of the nit bucket if anyone ever reads failover telemetry to decide which
vendor to drop: it attributes every recovery to the first rung.

## How this happened, so it is not repeated

The re-review of #645 was launched, its transcript directory disappeared during a network outage,
and its output file was empty — so it was treated as lost and a manual spot-check was substituted.
The spot-check re-verified the four defects already known from round one. It did not look for new
ones, which is the entire purpose of a re-review. The PR was merged on that basis and the review
then returned `block`.

**A review that cannot be shown to have completed has not completed.** An empty output file is not
a verdict, and a self-check by the author of the change is not a substitute for one.
