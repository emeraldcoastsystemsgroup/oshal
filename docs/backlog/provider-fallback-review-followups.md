# Provider fallback chain — the adversarial review of PR #645, and what it cost

**Status: closed 2026-09-18.** All 28 findings are fixed. This file stays as the record, because
the way the review was nearly lost matters more than any single finding in it.

An adversarial five-lens review of PR #645 returned **block** with 28 findings: 3 blocking,
15 should-fix, 10 nit. Every one was verified by the reviewer *executing* the code, not reading it.

## How this nearly went unfixed

The review was launched, its transcript directory disappeared during a network outage, and its
output file was empty. I treated it as lost and substituted a manual spot-check. That spot-check
re-verified the four defects already known from round one — and, being my own check of my own
change, looked for nothing new. I merged #645 on that basis. The review then completed and returned
`block`, and `main`'s unit suite had been red for about an hour.

**A review that cannot be shown to have completed has not completed.** An empty output file is not
a verdict, and the author's own check is not a substitute for one.

## The three blocking findings

| # | what | shipped in |
|---|---|---|
| 1 | a rung that is not a native runtime name was **silently dropped** at the node — the chain `.env.example` and the cockpit both advertise realized as ONE rung | #648 |
| 2 | `OSHAL_PROVIDER_FALLBACK_ORDER` was blanked on every boot pull **in the default configuration**, the inverse of what the docs state | #648 |
| 3 | two existing specs left red, so `main` was red; the build could not see it (`tsconfig.json` excludes specs, vitest does not typecheck) | #648 |

Finding 1 is the one that mattered: the feature the operator asked for did not work. The API
accepted the id, the row stored it, the cockpit rendered it, the boot pull carried it — and the
node then indexed a three-key runtime map, missed, and logged one warning nothing surfaces.

## The rest

**Claims that were simply false** — the largest category, and all mine.

- **F7** "usable as a fallback rung" for `gemini-cli`/`antigravity-cli`, asserted in **seven**
  durable places. Both carry `botNodeRuntime: null`; neither spelling is a `ProviderRegistry` id
  (the registry has `gemini`, not `gemini-cli`). One of those entries also claimed such an id is
  "refused with a reason at a node rather than silently dropped" — the opposite of the truth.
- **F20** "No provider is named in this file, and none may be" — literally false about its own
  module, which names the three runtime keys 200 lines above.
- **F13** the cockpit banner promised the chain applies to "the next dispatch"; it applies at each
  bot's next start.
- **F5** `OSHAL_PROVIDER_AUTO_FAILOVER` was read *after* the configured order returned, so it was
  inert in both arms while `.env.example` called it the kill switch.
- **F6** the api-side `environment` rung had zero callers, so ADR-162's four-rung ladder was three.

**Guards that were not guards.**

- **F9** the two Antigravity cases grepped the adapter file for strings that appear in its own
  **change log**, so they passed on an adapter whose methods had been deleted.
- **F16** three source greps scoped to function bodies located by `indexOf` — a rename defeats them.
- **F19** "the surface must name no provider" matched only *single-quoted* ids; the placeholder
  names three, unquoted.
- **F10** the antigravity security fix shipped with no behavioural guard at all.
- **F15** neither new spec was in the feature's test command or the Test Lab, and three route
  refusal branches had no test anywhere.

**Real defects beyond the blocking three.**

- **F26** the **JS-side** spawn boundary never learned any antigravity spelling. The harness was
  added to the TypeScript unbrokered-denial set and not the JavaScript one — the half that gates
  the actual child process. Not reachable, but it is the second "fixed one of two" on this branch.
- **F11** the self-reference refusal compared spellings, so a chain naming its own primary through
  an alias was accepted 200 and stored.
- **F12** the cockpit could not express NULL and destroyed it on every save, making the store's
  own "a provider change must not wipe the chain" protection unreachable from the only UI that
  writes the row.
- **F17** "status is authoritative" was a four-name denylist, so any status the vendor adds,
  renames or misspells arrived with exit 0 and was returned **as the model's answer**.
- **F27** with a nested chain, every recovery was attributed to the **first** rung — the number a
  reader uses to decide which vendor to drop.
- **F8** the measured musl cause reached no surface: `blockingReason()` is consumed in `run()`, and
  `run()` is unreachable because the audited-harness guard throws first.
- **F22** the adapter created a config tree inside the operator's **real** `~/.gemini` on a host
  run, and inside a read-only bind mount in the shipped stack.
- **F24** a non-numeric `ANTIGRAVITY_TIMEOUT_MS` became `NaN`, reaching the CLI as `--print-timeout NaNm`.
- **F21** `antigravity-cli` was metered in a different cost unit from its sibling on the identical
  Google credential.
- **F18** the whole prompt as a single argv value — the `spawn E2BIG` shape that killed every
  Dungeon Master turn once, already fixed for both sibling adapters.
- **F14** fleet-wide automatic failover was removed with no ADR amendment, reversing an operator
  directive recorded as Accepted. Now [ADR-128 Amendment 2](../adr/128-codex-fleet-default.md).
- **F23/F25/F28** six undocumented env knobs; an unqualified "selectable like any other provider"
  that is untrue at the manifest boundary; a stale real-boundary audit row.

## What is deliberately still true

`antigravity-cli` remains **excluded** from `SWARM_APP_BOT_HARNESS_TYPES`. It is a registered,
selectable harness that no bot node can execute, so a packaged bot declaring it would load and then
fail at dispatch. The exclusion is now commented in place so it is not "fixed" by the next reader.
It stays until a node can run the binary — see
[antigravity-and-node-footprint.md](antigravity-and-node-footprint.md).

## The pattern worth keeping

Three separate times on this branch a fix reached one of two places that needed it: the TS denial
set but not the JS one; one of three readers sharing a mapper; the primary's translator but not the
rungs'. Each was found by someone re-deriving the claim rather than reading the diff.
