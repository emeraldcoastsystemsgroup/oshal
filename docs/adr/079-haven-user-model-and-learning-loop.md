# ADR-079: Haven — The Per-User Model And Learning Loop Behind Jarvis

**Status:** Accepted (slices 1–4 as-built 2026-07-06)
**Date:** 2026-07-06
**Deciders:** oshal maintainers
**Amends:** ADR-030 (Home Persona Layer), ADR-050 (Unified Assistant Route Orchestrator)

## Context

ADR-030 proposed "Haven" — a persistent front-of-house persona with memory, proactivity, and one
voice. ADR-050 later shipped the Jarvis app, which delivered the *one voice / hidden routing* half:
classify → delegate to the accountable specialist bot → synthesize a single answer, with fast
(direct bot) and ticket (orchestrated) modes. What remained unbuilt was the half that makes it a
relationship instead of a toolbox: **a durable model of the user** that every turn reads and every
exchange teaches.

Existing memory infrastructure (`MemoryLayerService`) is agent/task-scoped — checkpoints, per-agent
conversation summaries, knowledge docs. Nothing was user-scoped. The permission-aware RAG work
(source-ACL mapper + owner-scoped retrieval filter, 2026-07-05) supplied the missing safety rail
for per-user long-term memory.

## Decision

**Haven is not a separate app or surface. Haven = Jarvis + a per-user model + a learning loop.**
One feature slice, `src/features/user-model/`, four slices as-built:

1. **The store (hot core).** `user_model_facts` — per-`user_sub` durable facts in six facets
   (identity, rule, preference, goal, entity, signal) with confidence / source / evidence /
   times-seen / recency. Owner-scoped RLS applied at the lazy-DDL chokepoint (A1.2 pattern).
   `renderHotCore` produces a compact block (≤12 facts / ≤900 chars) injected ahead of the user's
   message on **every Jarvis turn — both modes** (`withHavenContext` in jarvis-routes). An empty
   model injects nothing: a new user costs zero prompt overhead.

2. **The learning loop.** After each exchange, a **fire-and-forget, per-user-throttled** extraction
   (`learnFromExchange`) runs on the *same accountable inline Jarvis brain* (cost lands in
   `chat_tasks` — ADR-036/050). Strict-JSON output is parsed defensively; candidates are
   fail-closed filtered (`isStorableFact`: no credential shapes, bounded, known facets) and merged:
   same value reinforces (times-seen + confidence bump), contradiction supersedes (new value wins,
   confidence tempered). Explicit teaching (`POST /api/user-model/teach`, "always …") floors at
   0.95 confidence. Kill-switch: `OSHAL_USER_MODEL_LEARN=false`.

3. **The long tail.** Fact evidence overflows into a per-user **`user-model` RAG collection**,
   every chunk stamped `owner_sub` — retrieval runs through the permission filter with
   `allowPublic=false`, so only the owner's memories can ever surface (the 2026-07-05 cross-user
   denial proof covers exactly this path). `buildHavenPreamble` appends up to 3 relevant memories
   per turn.

4. **Proactivity — pull-based.** A lazy per-user sweep (throttled hourly, runs when the user
   arrives) decays idle facts (~3%/idle-day past 30 days; deactivate under 0.25) and computes
   suggestions (v1: stale goals >7 days, one-time teach nudge) into `user_model_suggestions`.
   The Jarvis page surfaces them as a dismissible "Haven noticed" strip
   (`GET /api/user-model/suggestions`). **Nothing is ever pushed outward** — proactivity greets
   you when you open the door; it does not send unapproved messages.

**User control is a first-class surface:** `GET /api/user-model` (see everything it believes about
you, with confidence + source), `POST /teach`, `DELETE /facts/:id` (forget). It is *their* model.

## Consequences

**Positive:** every specialist answer arrives already personalized; explicit rules apply
everywhere; the model self-corrects (supersede) and self-prunes (decay); per-user memory rides the
proven RLS + RAG-ACL isolation rails; a real user model is a structural differentiator no
stateless chat wrapper gets for free.

**Negative / accepted:** prompt overhead per turn (bounded ≤900 chars); one extra throttled LLM
call per learning exchange (accountable, kill-switchable); extraction quality depends on the
inline brain — the fail-closed filter means it errs toward learning less, not leaking; pull-based
proactivity means no true push notifications yet (deliberate — outward sends stay approval-gated).

**Deferred:** conversational onboarding flows (ADR-030 property 4) and persona voice wrapping of
*specialist* bot replies (property 5 beyond Jarvis's own synthesis). Both carry done-when criteria in
[Haven deferred properties](../backlog/haven-deferred-properties.md).

## Update — 2026-08-02: push proactivity, connector-signal facts, and compaction are built

Three of the five deferrals above are closed. Slice 4's "nothing is ever pushed outward" is now
"nothing is pushed outward *unless the user asked for it*" — the pull strip is unchanged and remains
the default experience.

- **Push proactivity (opt-in, default OFF).** `haven-proactivity.ts` owns the gate and the policy;
  `haven-proactivity-cron.ts` delivers through the EXISTING per-user `NotificationRouter` (email /
  SMS / voice / Telegram senders, their availability checks, and the user's quiet hours) — there is
  no second notifier. Two gates: `HAVEN_PUSH_CRON=1` enables the capability for a deployment, and
  each user switches themselves on at `GET/POST /api/user-model/proactivity`, which also reports an
  honest reason when it is off.

  The gate reads the `haven-proactive` preference row **directly, with no fallback**, and that is the
  load-bearing detail: `NotificationRouter.resolveRouting` falls back to the `default` topic row and
  then to *email-if-Gmail-else-none*, so routing the decision through it would have made unsolicited
  assistant messages the default for every Gmail-connected user and let the welcome wizard's generic
  "text me" answer stand in for consent to something else entirely. Bounded further by a per-user
  daily cap, a once-ever-per-suggestion ledger (`haven_push_deliveries`), and a rule that a
  `teach-nudge` is never pushed — a UI tip is not worth a phone buzz.

- **Connector-signal facts.** `connector-signal-facts.ts` derives one `signal`-facet fact per
  connected provider from the caller's OWN `oshal_connections` rows (health, capability labels,
  expiry countdown), refreshed in the throttled sweep and retired when a provider is disconnected.
  Never a token, never a raw scope string, never an account identifier: scopes are mapped to a fixed
  label table so provider-controlled text cannot reach a prompt, and the read is a parameterized
  `WHERE user_sub = $1` with no unscoped variant. An expiring or broken connection also raises a
  `connector-attention` suggestion — which is what gives push something real to say.

- **Cross-session compaction.** `model-compaction.ts` bounds the ACTIVE model (decay bounded a fact's
  confidence, not the model's size, so a heavy user's hot core filled with stale entities). It is
  deterministic and LLM-free, it **deactivates rather than deletes** — compacted facts still appear
  in `GET /api/user-model` and their evidence still lives in the owner-ACL'd long-tail collection —
  and it never touches an explicit teach or an identity fact.

Guards: `tests/unit/haven-push-proactivity.spec.ts`,
`tests/unit/haven-connector-signal-facts.spec.ts`, `tests/unit/haven-model-compaction.spec.ts`.
