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

**Deferred:** push proactivity (device/notification rails), connector-signal facts (token expiry,
new-capability matches), conversational onboarding flows (ADR-030 property 4), persona voice
wrapping of *specialist* bot replies (property 5 beyond Jarvis's own synthesis), cross-session
model summarization compaction.
