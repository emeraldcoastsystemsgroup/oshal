# ADR-162: A bot's brain is a layered choice of records, and the registry is only the last of them

## Status

Accepted — 2026-09-17, operator decision. The user half already exists (ADR-127); the admin half is
being built against this ADR and the BACKLOG entry "A bot's LLM provider is a row in a table, not a
literal in the registry". Nothing here is a claim that the admin half works today.

## Context

The harness inventory has been multi-harness since [ADR-033](033-multi-harness-execution-framework.md):
`cline`, `codex-cli`, `claude-code`, `gemini-cli`, `a2a`, `noop`. Every one of the CLIs is installed in
the bot image, and on 2026-09-17 three of them answered from inside a running bot (`codex`, `claude`,
and `cline` once its loader was present). The operator's model has always been that any bot can be
pointed at any of them.

What was never written down is **who may point it, and in what order the answers win.** That
question was found on 2026-08-01 (PR #97): the cockpit's per-bot provider select did nothing for any
bot whose registry entry declared a `harnessType`, because `resolveHarnessForAgent()` reads that
literal before any record. The note left behind said the choice was ADR-level — make the registry
overridable, or declare it source-only — and asked that no further picker be built until it was
made. It was not made. Instead:

- 2026-08-06 (#142) made the select honest — disabled, with the reason returned as HTTP 409
  `provider_pinned` — rather than powerful.
- 2026-08-12 ([ADR-128](128-codex-fleet-default.md), PR #195) gave every LLM bot a declared
  `harnessType: 'codex-cli'` in both registries. ADR-128 itself records that the picker "was already
  inert against registry pins" and that the pin was now uniform. Per-service literals
  `FORCE_LLM_PROVIDER: openai-codex` / `FORCE_LLM_MODEL: gpt-5.5` sit in the tracked compose file on
  most bot services, overriding the `.env` interpolation in the shared block.
- 2026-09-16 (#604) extended [ADR-034](034-bidirectional-config-ownership-sync.md) so that a bot with
  no `agent_config` row is still dispatched with an authoritative record — filled from the registry
  literal.

On 2026-09-17 the fleet's Codex login hit its usage limit ("try again at Sep 20th"). Every ticket,
schedule and agentic run stopped. Every lever an operator could reach was tried, each with proof:
`.env`, the compose literals, `agents.api_provider_id`, the `agent_config` record, the persisted Cline
config. The registry literal won every time. When the JS failover did reach Cline backed by Gemini
and completed an eight-iteration task, the ADR-034 post-execution check discarded the result because
the dispatch record — the registry literal — still said Codex. Chat survived only through ADR-127's
hosted retry; nothing else did.

The operator's words: *"so this is flexible configuration right ... im not going to switch it to codex
tomorrow and we have to hard code a bunch of shit"*, and then: *"there are layers... there is the portal
admin who can set a default for the swarm as a fallback, there is the user who can set their own
credentials and defaults generally and or on a bot by bot level."*

## Decision

1. **Two owners, nested.** A *user* chooses the brain for their own turns. A *portal admin* chooses what
   the swarm runs when no user has chosen — per bot, or for the whole fleet. The registry is a default
   and nothing more.

2. **Precedence, most specific first, every rung a record and none a literal:**

   | rung | record | governs |
   |---|---|---|
   | user per-bot preference | *(follow-up — does not exist yet)* | that user's turns on that bot |
   | user general preference | `oshal_user_llm_prefs` (ADR-127) | that user's turns |
   | admin per-bot row | an operator-written row of `oshal_bot_provider_switch` (scope = the agent id; `updated_by` records who) | everything else on that bot |
   | admin fleet-default row | one reserved id in the same store | every bot without its own row |
   | registry entry | `swarm-bot-registry*.ts` (ADR-034 tier 3) | nothing, unless no row exists |

   A user's choice governs only that user's turns and only selects something the user may already use
   (ADR-127's rule: a preference is not an authorization). Swarm-owned work — tickets, schedules,
   agentic runs, anything that is nobody's turn — resolves from the admin rows.

   The `agent_config` record (ADR-034 tier 2) is not a rung of this table. It is the dispatch record
   machinery writes — manifest seeding, the bot's own broadcast-up, a config push — and the
   fleet-default row outranks it. Amended 2026-09-17, the same day: the first build of the admin half
   read every `agent_config` record as the admin per-bot row; measured on the operator box, all 70
   such records were machinery-written and would have held on the first fleet write, failing §7 for
   the whole fleet. Nothing is seeded into the switch table from `agent_config`; a per-bot row exists
   only when an operator writes one.

3. **The authoritative dispatch record carries the winning rung.** ADR-034's post-execution check
   ("what ran is what was authorized") stays. Its authority becomes the resolved row, so a switch is one
   write and the next dispatch to an idle bot runs on it: the node already reconciles an idle bot to the
   carried record and refuses only a concurrent mismatch. The check is exact: a Cline-backed id
   authorizes `cline-cli` fronting that id and nothing else. A failover chain is NOT part of the
   record — no switch row or migration-147 column carries one — and work the JS failover's fallback
   completes is still refused by the check, because the result reports the fallback's name
   (`any-bot/server/services/llm/ProviderFailoverProvider.js:97`) and `dispatchProviderMatches`
   compares it to the row. Making a configured failover part of what the record authorizes is a
   BACKLOG entry ("A failover the record configured must not have its completed work discarded"),
   not this ADR.

4. **No rows = today, byte for byte.** A deployment that has written nothing behaves exactly as before
   this ADR. The change is additive.

5. **Credentials stay with their owner.** A record names a provider and a model, never a secret. A
   user's BYO key is never the fleet's; the fleet's container key is never a user's.

6. **Unknown fails closed.** A provider id no rung can supply is refused with its reason. A bot never
   silently falls to the registry because a row was malformed.

7. **The acceptance test is the operator's sentence.** The day after this lands and deploys, moving the
   whole fleet to another provider is one write of the fleet-default row from the cockpit — no pull
   request, no image deploy, no container restart. A change that leaves a per-service compose literal
   or a registry edit on that path has not met this ADR.

## Consequences

- [ADR-128](128-codex-fleet-default.md) is **superseded on its "one default brain" decision.** Codex
  remains a valid choice; it is no longer the choice the registry makes for the fleet. Its harness
  and adapter work is untouched.
- [ADR-034](034-bidirectional-config-ownership-sync.md) is **amended**: the switch rows — the bot's
  own operator-written row, else the fleet-default row — are tier 1 of the carried record, above the
  `agent_config` record (tier 2, machinery-written) and the registry (tier 3), which fill a record
  only when no switch row governs the bot; and the post-execution check holds "what ran == what
  was authorized" against the row exactly — a failover chain is not part of the record, and a
  fallback's completed work is still refused (§3; BACKLOG "A failover the record configured must
  not have its completed work discarded").
- [ADR-033](033-multi-harness-execution-framework.md) and [ADR-127](127-demo-mode-cli-brain-and-user-provider-preference.md)
  stand. ADR-127's ladder is the user half of §2.
- HTTP 409 `provider_pinned` and the read-only cockpit select (#97, #142) go away for any bot a row
  governs. `/api/agents` reports the resolved provider **with its rung** (`user` | `bot-row` |
  `fleet-default` | `registry`) so a human can see where a value came from.
- Three follow-ups are named, not folded in: the admin fallback for *user* turns is env-only
  (`OSHAL_OPERATOR_LLM_PROVIDER/MODEL/LANES`) and gated on `DEMO_MODE`, and should be a cockpit control
  with the same record semantics; users have no per-bot preference; the user preference vocabulary is
  closed (`LLM_PREFERENCE_IDS`) and cannot name Gemini or Cline as a CLI brain.
- The compose literals become interpolation with defaults, and a guard fails if a bot service
  reintroduces a `FORCE_LLM_*` literal. "Nothing hardcoded" was already the rule; this is where it
  bit.
