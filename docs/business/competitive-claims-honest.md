# Competitive claims — the honest, adversarially-verified record (2026-07-17)

This document exists so nobody — human or bot — re-argues settled ground. On 2026-07-17 we ran a
113-agent adversarial research study whose explicit job was to **refute Open Swarm's own two loudest
differentiators**, defaulting to "refuted" whenever a competitor plausibly ships the capability.
Both fell. This file records what died, what survived, what is *real in our own code* (so we don't
under-sell it either), and how to talk about it. If the public site (`site/oswarm.ai/index.html`,
`/compare`) and this file disagree, **this file wins** — fix the site.

## TL;DR

- The word **"exclusive" is retired** on two axes. The features are real; the "only we do it" framing
  was false.
- Our real, unrefuted position is a **category** claim, not a feature score: **hosted AI products
  (ChatGPT, Claude, Zapier) are harnesses that build one-offs; Open Swarm is an application backbone
  you own and extend.** A definition can't be refuted by a competitor's doc link.
- The differentiator that survives *and* is genuinely uncommon is the **self-healing red/blue loop**:
  the platform patches its own source, redeploys, tests the patch against a baseline, and auto-reverts
  a regression — on a stack the customer owns. A SaaS vendor **structurally cannot** offer this.

## What was refuted (do NOT re-claim as exclusive)

| Claim we made | Refuted by | Evidence |
|---|---|---|
| "Spawn a new tool-equipped agent at runtime, no redeploy" is exclusive | **AWS Bedrock `InvokeInlineAgent`** (GA Nov 2024) | The API has **no `agentId` parameter** — structurally cannot reference a pre-created agent; `instruction` (persona) + `foundationModel` + `actionGroups` (tools, incl. `RETURN_CONTROL` = zero deployed infra) ride in the request body. Tools can be mutated between turns of one live session. |
| "A ranked, reviewed, gated cluster of agents inside one step" is exclusive | **CrewAI, LangGraph, AG2, Bedrock** (four independent products) | CrewAI `Process.hierarchical` + Task Guardrails (blocking gate, bounded retry); `langgraph-supervisor` incl. nested supervisors; AG2 `GroupChat` (bounded `max_round`, FSM topology); Bedrock `agentCollaboration: SUPERVISOR`. Multi-round review and the quality gate are both refuted; only *self-scored ranked bidding* is unrefuted, and only on absence-of-documentation (medium confidence). **The *codepacking* axis (one-harness review→gate) was never assessed — see "What was under-sold" below.** |
| "Vendor-neutral model routing" is a differentiator | **n8n** (also LangGraph, Dify) | n8n Model Selector node "dynamically selects one of the connected language models during workflow execution," plus Enable Fallback Model across ~18 provider nodes. **This refuted the *model-routing* framing only; the higher *runtime / harness-layer* routing claim stands — see "What was under-sold" below.** |

**Coverage caveat, stated so it can't be quoted around:** the study verified only axes 13/14/15 (and
12 of 15 surviving claims concern AWS Bedrock alone). The other 11 axes — connectors, ease, NL/voice,
speed, workflow power, self-host, data ownership, safety, audit, extensibility, domain apps — produced
**zero** verified evidence in either direction. Our old 100/100 self-scores on six of those are
**untested, not vindicated.** Treat them as "not assessed," not as wins.

## What was under-sold (the honesty pass over-corrected — reinstated 2026-07-18)

The 2026-07-17 study defaulted to "refuted" and, on two rows, refuted a **weakened** version of our
own claim, then let the real one go. Reinstated here at the correct layer, with caveats so we don't
over-swing back:

| Claim | Why it stands | Honest caveat |
|---|---|---|
| **Runtime / harness-layer neutrality** (not "model routing") | The refuted row conceded *model* routing to n8n — a category error. n8n's Model Selector swaps the **model** inside its one agent runtime; Open Swarm routes across **independently-built agent runtimes** — Cline, Claude Code CLI, Codex CLI, Gemini CLI (`HarnessType` + `HARNESS_FACTORIES`, `provider-runtime.ts`), each with its own tools, auth, and loop, normalized behind one envelope and dispatched per bot/phase. No competitor productizes routing across agent runtimes. | Anyone *can* script a CLI call (n8n Execute Command, a LangGraph node). The claim is **first-class, productized** cross-runtime routing — a "how/where-it-lives" claim, **not** "impossible elsewhere." |
| **Codepacking — one-harness bounded review→gate** | The "reviewed/gated cluster" row was refuted on review+gate *capability*, but never addressed codepacking: collapsing a workflow into ONE harness one-shot — continuous context, rotated perspective, no inter-agent handoff (`codex-packer.yaml`). CrewAI/LangGraph/AG2/Bedrock all **hand off between separate-context agents**. | Single-context multi-perspective is the old Self-Refine / Reflexion pattern — not novel as a *technique*. The novelty is that it's a **harness-level packing primitive** (vendor-neutral). Call it "bounded / repeatable," never "deterministic." |

Both are **architecture / packaging** claims a competitor's doc link can't refute — the same shape as
the category claim that survived. They do **not** resurrect "exclusive"; they name a layer nobody else occupies.

## What is REAL in our own code (so we don't under-sell it either)

An earlier pass in this same session wrongly called the self-development / self-healing loop "vapor"
after a lazy `grep` for the literal string "a/b". That was wrong. Verified against the tree:

- **SelfHealable contract** — [any-bot/server/services/SelfHealTestEndpoint.js](../../any-bot/server/services/SelfHealTestEndpoint.js):
  every bot automatically exposes `POST /api/selfheal/test`, wired at
  [any-bot/server/app.js:127](../../any-bot/server/app.js). Bots register custom tests via `registerTest()`.
- **The loop** — [ai-lab/bot-personas/self-healing-bot.yaml](../../ai-lab/bot-personas/self-healing-bot.yaml):
  baseline (test *before* the fix) → `analyze-and-fix-code` (with backup) → package/build →
  `deploy-container` (redeploy + health wait) → re-test → **compare with baseline** → keep if it passes,
  else `revert-and-escalate` (max 3 attempts, then escalate to a human). Champion vs challenger, with
  automatic rollback. **This is the red/blue "A/B" the operator meant.**
- **Autonomous** — `SelfHealingScheduler` at
  [any-bot/server/app-modules/startup-swarm-runtime.js:876](../../any-bot/server/app-modules/startup-swarm-runtime.js)
  does autonomous container monitoring (env-gated); it can run with no human at the helm.
- **Governed self-EDIT loop** (ADR-077) — [src/features/dev-console/services/dev-session-engine.ts](../../src/features/dev-console/services/dev-session-engine.ts)
  + [sandboxed-agent-runner.ts](../../src/features/dev-console/services/sandboxed-agent-runner.ts):
  super-admin instructs the assistant to fix a bug; edits happen in an isolated `dev-session/*` worktree,
  typecheck-verified, committed **branch-only** (never the live tree, never `main`), inside a locked-down
  container (`--network none --read-only --cap-drop ALL`). The orchestrator calls these "two
  red-team-hardened cores." **Human-in-the-loop and branch-scoped by design.**
- **Dynamic node ability** — real: `bot-container-spawner-service.ts` (spawns real containers),
  `agent-runtime-registry-service.ts` (persistent heartbeating registry), `mesh-bid-broadcaster.ts`
  (self-scored bids — the one axis-14 sub-claim the study could not refute),
  `capability-expansion-service.ts` (an agent can request a new capability mid-flight).

**Honest scope of the self-heal loop:** it is **health / regression** testing (did the patch pass the
self-test and not break the baseline), NOT a marketing-style **traffic-split / user-metric** experiment.
Both get called "A/B"; they are different animals. Say the precise one on public surfaces.

## "Do other companies have this?" — the honest answer

The *components* are commodity; the *integrated closed loop on a stack you own* is the rare part.

- **Auto-rollback on baseline/canary regression:** yes — Argo Rollouts, Flagger, Spinnaker (progressive delivery).
- **AI that writes code fixes:** yes — Devin, GitHub Copilot Autofix/Workspace, Cursor agents, SWE-agent (and Claude Code itself).
- **Autonomous monitor → auto-remediate:** yes — AIOps (Dynatrace Davis, Datadog Watchdog, PagerDuty, Shoreline).

What is uncommon: one **self-hosted platform** that self-monitors → writes a **source-code** patch →
redeploys → **red/blue tests it against a per-bot baseline** → auto-reverts, as a shipped default, with
the customer owning the whole stack. **Do not write "nobody else does this" on any public surface** —
that is exactly the overclaim the study just punished. Write the category truth instead: a hosted
vendor *structurally cannot* let agents rewrite the product; an owned stack can. That sentence is true
and unrefuted. If we ever want to claim the integrated loop is unique, it earns the same adversarial
study first.

## How to talk about it (the pitch that survives)

1. **Category, not feature** (unrefutable): harness vs application backbone. Competitors organize
   independent threads and build one-offs; Open Swarm starts you on a running application — auth,
   per-user isolation, connector spine, ribbon, bot mesh already standing — and you extend that.
2. **Own-your-stack properties** (architectural, defensible): self-host, your data + keys, safety gates
   on by default, live-proof audit trail.
3. **The self-healing red/blue loop** (real, uncommon, honestly scoped): patches its own code, redeploys,
   tests vs baseline, auto-reverts — only possible because you own the stack.
4. **The determinism story we have NOT yet earned** (roadmap, do not claim): everyone can run agent
   clusters — the open question is the *bill* and the *reliability*. Independent reports put CrewAI
   hierarchical at +30–50% token overhead and a LangGraph supervisor loop at 47 iterations / $180 on
   one request. If we instrument a head-to-head (same task; Open Swarm vs CrewAI hierarchical vs
   LangGraph supervisor; count tokens, dollars, rounds, whether the gate held), that becomes a claim
   nobody can refute with a doc link. **Not tested yet — do not put it on the site until it is.**

## Provenance

- Study method: 6 search angles → 30 sources fetched → 141 claims → 25 adversarially verified by a
  3-vote panel instructed to refute (2 of 3 refutes kills a claim). 15 confirmed, 10 killed. 113 agents.
- Site changes that flow from this doc: `site/oswarm.ai/index.html` `/compare` — cut the two
  refuted "leads" and the *model-routing* framing, added the correction-owning block and the
  self-healing loop. **Correction (2026-07-18): the harness / runtime-layer routing claim is TRUE
  and unrefuted — the site correctly leads on it; do NOT cut it. See "What was under-sold."**
- Related: [../adr/077-self-developing-platform-and-super-admin-dev-console.md](../adr/077-self-developing-platform-and-super-admin-dev-console.md),
  [../adr/081-oshal-developer-bot-and-idle-timeouts.md](../adr/081-oshal-developer-bot-and-idle-timeouts.md),
  [./competitive-landscape.md](./competitive-landscape.md).
