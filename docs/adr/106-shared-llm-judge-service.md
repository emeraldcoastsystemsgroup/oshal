# ADR-106: Shared LLM-judge service + quality-judge concierge

**Status:** Accepted (2026-07-16) — BUILT + DEPLOYED in the 2026-07-15/16 gap-list build.
Feature slice `src/features/quality-judge`, route `/api/judge`, persona
`ai-lab/bot-personas/quality-judge.yaml`, registered in **both** bot registries. Consumed by
Token Chase step 4 ([ADR-046](046-token-chase-checkpoint-replay-optimization.md)), persona-evals,
and the LinkedIn assistant.

## Context

Three separate needs all wanted the same primitive — grade a piece of output against a rubric and
get a score back:

- **Token Chase step 4** — the ADR-046 quality assessor was unbuilt; grading was a lexical Jaccard
  proxy, which can't tell "cheaper *and* as good" from "cheaper *and* worse."
- **Persona regression evals** — semantic assertions need a grader.
- **Manifest `reviewerBot` gates** — the same shape.

Building three graders would triplicate the work and the cost accounting. The hard constraint:
**the swarm controller never calls an LLM** (CLAUDE.md two-runtimes rule). Grading *is* LLM work, so
it cannot live in the controller/route layer — it has to run on a bot, with the cost landing under
that bot's `agent_id`.

## Decision

1. **One shared service.** `JudgeService.grade({task, output, rubric, reference?})` returns one
   strict JSON verdict `{score 0–100, dimensions, rationale}`, consumed by all three callers through
   the barrel.
2. **Grading runs on a concierge bot.** The `quality-judge` bot is inline on `oshal-api`
   (docs/building-a-bot.md Form B, claude-code, BYOK on the swarm default login), registered in
   **both** `swarm-bot-registry.ts` and `swarm-bot-registry-local.ts`. `JudgeService` routes to it so
   the controller never calls an LLM and grading cost is attributed correctly.
3. **Deterministic lexical fallback.** Under `FORCE_LLM_PROVIDER=noop` or when the bot is
   unavailable, a lexical lane returns a verdict flagged `mode: 'lexical-fallback'` — so tests and
   free-lane runs work, and consumers can *see* it wasn't LLM-judged.

## Consequences

- Reuse: Token Chase step 4/4b, persona-evals, and the LinkedIn assistant all grade through one
  accountable path with consistent cost capture.
- **Honesty rule propagates:** consumers must never blend `llm` and `lexical-fallback` verdicts into
  one "verified" number (the Token Chase savings report enforces this).
- Grading adds an LLM call per graded item — callers that grade in bulk should batch/cap it (a
  per-run judge cost cap for Token Chase is a BACKLOG follow-up, enforced via the ADR-104
  `BudgetService`).
- The concierge is BYOK on the mounted login — no vendor key in its env, consistent with every other
  bot.
