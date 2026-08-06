# ADR-046 — Token Chase: git-versioned checkpoint/replay for counterfactual workflow optimization

- **Status:** Partially implemented — capture, accountable replay, judging, savings, and reversible
  re-baselining are implemented locally (see "Implementation status" below). The complete
  commit/store checkpoint, interactive splice debugger, and learned selector remain Proposed.
- **Date:** 2026-06-17 (proposed); build status updated 2026-08-06
- **Related:** [ADR-027 (swarm cost rollup / chat_tasks linking)](027-swarm-cost-rollup-task-linking.md),
  [ADR-032 (Process Lab non-invasive trace runs)](032-process-lab-non-invasive-trace-runs.md),
  [ADR-033 (multi-harness execution framework)](033-multi-harness-execution-framework.md),
  [ADR-036 (bot-owned application architecture)](036-bot-owned-application-architecture.md),
  [ADR-039 (bot-driven workflow authoring)](039-bot-driven-workflow-authoring.md),
  [ADR-041 (per-user storage targets)](041-per-user-storage-targets.md).

## Context

A multi-agent workflow is a chain of LLM calls. Today, the only way to learn whether a cheaper
model, a tighter prompt, a different tool, or a different **harness** would have produced an
equal-or-better result for fewer tokens is to **re-run the whole workflow and eyeball the
difference.** That is expensive (you pay for every upstream call again), slow, and — because LLM
output is nondeterministic — non-comparable: run-to-run drift swamps the signal you are trying to
measure. So workflow optimization is currently done by gut.

OSHAL is unusually well-positioned to do better, because it already has the pieces a real
optimization loop needs: five concrete harnesses behind one interface (ADR-033), a canonical
per-call cost store (`chat_tasks`, ADR-027), bot-owned `user_sub`-keyed data stores (ADR-036/041),
and a git-backed shared workspace. What's missing is a way to hold everything constant except the
one decision under test, measure the difference, and **accumulate those measurements into training
data** so the orchestrator eventually stops guessing.

This ADR defines **Token Chase** — a deterministic record-and-replay layer that turns each workflow
run into (a) a scrubbable timeline an operator can rewind, (b) a source of controlled
counterfactual experiments across four decision axes, and (c) a labeled corpus that a selection
policy learns from. The name is the operator's: *chase the wasted tokens down.*

## Decision

### 1. Checkpoint the full restorable state before every LLM call

Immediately before each LLM call, the harness commits a **checkpoint**: a single immutable,
content-addressed unit that captures everything needed to re-enter that call exactly. One
checkpoint = one keyframe on the timeline; one LLM call = the segment between two keyframes.

A checkpoint is **not** "the workspace" — the thing that mutates across a workflow is the *data*
(the bot fetches via its connector token, caches into its `user_sub`-keyed store, reasons over it,
writes a derived artifact). So a checkpoint binds three things under one SHA:

```
checkpoint SHA →
    workspace tree   (git: artifacts, generated files — the durable work product)
  + data version     (the bot's user_sub-keyed store snapshot ref — cached reads + derived state)
  + call context     (serialized envelope, the assembled prompt, pinned external reads)
```

Restoring the SHA rehydrates all three, so the bot re-enters the call against **identical code,
identical data, identical context.** That is the only condition under which "play forward" is a
controlled experiment rather than a re-run that happens to start in the middle.

### 2. git is the substrate — commits, branches, worktrees, SHAs

The "save every state in a restorable fashion" requirement *is* a git commit. The whole mechanism
maps onto git primitives that already exist (the workspace is a git repo; code-server mounts it;
worktrees are available), so the durable/addressable/diffable/branchable snapshot problem is
already solved:

| Token Chase concept | git primitive |
|---|---|
| Checkpoint before call *N* | a commit |
| `checkpoint_sig` | the commit SHA (a stable content hash, for free) |
| Baseline run | a linear branch of commits, one per call |
| Rewind to call *N* | `checkout` that commit |
| Splice (edit + play forward) | `git branch` off that commit |
| The variant tree | the git DAG — the matched-pair-rooted structure the corpus wants |
| Diff baseline vs. variant tail | `git diff` of artifacts + the data-store diff + the metrics diff |
| Parallel variants without collision | **worktrees** — one checkout per variant, shared object store |

The non-filesystem half of the checkpoint (envelope, store ref, pinned reads) is committed **into
the commit** as `.tokenchase/checkpoint.json`, so one SHA restores everything and there is no second
store to keep in sync. The data version preserves the store's **encrypted** blob/ref (AES-GCM,
`user_sub`-keyed) — versioning does not widen the blast radius; never version plaintext to make
replay convenient.

### 3. Capture a baseline, then splice counterfactuals (forward-only replay)

- **Baseline (front-to-back).** Run the workflow once end to end. Each call records its checkpoint,
  the decision taken, the response, and the outcome metrics. This golden trace is the linear branch.
- **The assessor reads the chain.** A judge persona walks the trace and identifies **splice
  points** — calls where a variant can be injected and the run replayed *forward only*. A call is
  **backwards-compatible** for splicing when its modified output still satisfies the
  shape/contract its downstream consumers expect, so nothing upstream re-runs.
- **Splice and play forward.** Rewind to a checkpoint, inject the variant, replay to the end.
  Because upstream state is *restored*, you pay only for calls from the splice point forward. The
  further back you rewind, the more tail you re-run — the operator feels the cost gradient.
- **The variant doesn't overwrite baseline** — it forks a git branch off the splice commit. You
  accumulate a tree of branches all rooted at the same upstream state: matched pairs by
  construction.

### 4. The variant is a choice across four axes — each maps to an existing registry

The injected variant is not just a prompt swap. It's a decision across four independent knobs:

| Axis | The decision | Where it lives |
|---|---|---|
| **Tool** | which tool to call — or skip the call | tool-registry / framework tools |
| **API** | which connector / data source; cached read vs. live | connectors + per-user tokens (ADR-041) |
| **LLM** | which model + params | `provider-definitions.ts` |
| **Harness** | cline / claude-code / codex / gemini for this phase | `HarnessType` / `HARNESS_FACTORIES` (ADR-033) |

The **harness axis is the differentiator** — most stacks have one harness and can't optimize it.
OSHAL has five behind a common interface, so "should this phase run on codex-cli or claude-code?"
becomes a *learnable* decision with measured outcomes rather than a config-time guess.

### 5. Every run emits a labeled corpus row — context, decision, outcome

Each call writes one row, split so that counterfactual pairs are two rows sharing **context** and
differing in **decision**:

```
context{ task_class, query_type, mode, checkpoint_sig, input_size, metadata }
  + decision{ tool, api, llm, harness }
  + outcome{ chat_task_id → (tokens_in, tokens_out, cost_usd), latency_ms, quality_score,
             backwards_compatible }
```

- **Context** is what the policy learns *from*. `query_type` (reasoning vs. data-fetch vs.
  summarize vs. classify vs. tool-pick) is the single highest-value feature; `mode` reuses the
  persona's existing Mode A/B/C classification; `checkpoint_sig` (the SHA) is what lets you find
  *matched* contexts across runs. `metadata` is the held-constant ledger (params, data-source id,
  RAG collection, retry count, persona id).
- **Cost stays canonical in `chat_tasks`** (ADR-027) — the corpus row *references* the
  `chat_task_id` rather than duplicating `tokens_in`/`tokens_out`/`cost_usd`. The Token Chase store
  holds only what `chat_tasks` doesn't: the decision and its context.
- **Outcome labels** are what you optimize toward: minimize `cost_usd` (and `latency_ms`) **under**
  a `quality_score` constraint, with `backwards_compatible = false` disqualifying a row from
  "winner" no matter how cheap.

### 6. Run–learn loop → learned selection policy ("Step Grooming")

The operator-facing name for this loop is **Step Grooming** — the workflow is groomed one AI step
(one LLM call) at a time, each step refined toward its optimal `{tool, API, LLM, harness}` the way a
backlog is groomed: a continuous, per-step refinement pass rather than a one-shot rewrite. A workflow
is "groomed" when every step has been replayed against cheaper variants and either swapped (Tier 1
equivalence or Tier 2 trade-off) or confirmed already-optimal. Grooming is the workbench; the corpus
+ policy (below) is what lets later passes start from learned priors instead of from scratch.


Because forward-only replay produces **counterfactual** labels (matched pairs holding everything
constant but the decision), not merely observational ones, the corpus supports learning *causal*
preference between options. The progression:

1. Greedy, local: keep the winning splice, promote it into the workflow definition, re-baseline,
   move to the next splice point.
2. Heuristic policy: "for this `task_class`/`query_type`, the corpus says codex-cli on
   Llama-via-Ollama wins 80% of the time → try that variant first."
3. Trained policy (only once the corpus beats the heuristic): predict the cheapest decision that
   holds the quality bar *before* spending a token testing it. Token Chase stops being something you
   run and becomes something the orchestrator consults.

**Build the corpus first; let it earn the model.** Do not build the ML model before there is data
to justify it.

### 7. Playback / rewind is the operator surface over the checkpoints

The checkpoints make the workflow a scrubbable timeline: **scrub** (inspect the exact state into
any call), **rewind** (`checkout` a checkpoint), **step** (call-by-call, like a debugger), **play
forward from here**, and **branch**. Rewind *is* the splice gesture. Beyond optimization this gives:
**forensics** (rewind to the call where an answer went wrong, without re-running the whole thing),
**hand-edit-and-continue** (edit a response and play forward to isolate upstream-generation vs.
downstream-handling failures), and **explainability** (scrub front-to-back to show *how* the swarm
reached an answer).

### 8. Determinism gate — pin or flag external reads

Forward-only replay is only truthful where the checkpoint truly pins external reads. At capture
time each call is either:
- **replayable** — the connector/RAG response is **pinned into the data version** (frozen as part of
  the immutable checkpoint), so replay is exact; or
- **non-replayable** — a live side-effect; rewinding past it **warns** the operator that the tail
  won't match, and it is excluded from counterfactual labels.

The flag is a field in the committed `.tokenchase/checkpoint.json`, so the timeline marker is just
reading git. **This gate is the precondition for everything else** — if restoration doesn't
reproduce baseline, the counterfactual labels are silently corrupt and the policy learns to chase
cheap-but-broken paths with confidence.

### 9. The cost floor — local + free-tier lanes as first-class variants

The cost axis bottoms out at **$0 marginal**, and OSHAL already has both zero-cost lanes wired. The
decision axes (§4) must expose them as first-class, selectable variants so the splicer/policy tries
them automatically rather than treating "cheap" as merely "a smaller paid model":

| Lane | Cost | Mechanism | Status |
|---|---|---|---|
| **Local LLM** | $0, unlimited | Ollama / LM Studio / LiteLLM; Llama + Mistral fully local | wired as providers |
| **Free hosted tier** | $0, rate-limited | Gemini via a Google account (`gemini-cli` harness, `~/.gemini/oauth_creds.json`); other vendors' free tiers similarly | `gemini-cli` is a first-class harness |
| **Paid frontier** | $$ | hosted Claude / GPT / etc. | the baseline today |

The policy this produces is concrete, not abstract: **route `query_type` ∈ {data-fetch, classify,
summarize} to a local-LLM or free-tier lane; reserve paid frontier for `query_type=reasoning`.** For
many workflows that sends the majority of calls to $0 — the headline demo ("same output, cost → near
zero, here is the matched-pair proof"). Local LLMs supply unlimited free *compute*; free hosted tiers
supply free *quality headroom* for spikes. The two complement each other.

**Boundary — legit free tiers only.** *One* free tier per provider **plus** local hosting is a
durable, ToS-compliant floor and is what this design assumes. Farming many accounts to evade rate
limits violates provider terms, breaks without warning, and must not be a load-bearing assumption.
The lane abstraction routes among *legitimately available* lanes (the operator's own local runtime +
their own single free tiers); it does not provision or rotate accounts.

### 10. Two products on one substrate

The same capture/checkpoint layer ships as two distinct user-facing tools, which can be built and
sold independently:

- **The optimizer** (the flagship) — splice → forward-replay → diff → corpus → policy. Needs the full
  stack (assessor, corpus, policy).
- **The debugger** — scrub / rewind / step / hand-edit-and-continue over the captured timeline (§7).
  Needs **only steps 1–2** (capture + deterministic replay) — no assessor, corpus, or policy. It is
  therefore the **first shippable deliverable** and the visible proof that the substrate works.

Build the debugger first; the optimizer is the same substrate with the learning loop on top.

### 11. Two optimization tiers — equivalence-swap (zero-risk) before trade-off

Not all wins carry the same risk. Token Chase ranks them, and the safe one comes first:

- **Tier 1 — equivalence-swap (zero-risk, the default win).** Replay a call on a cheaper lane
  (local Llama, free tier); **if the output is equivalent to baseline, swap it.** Quality is
  *provably unchanged* — you only dropped cost (often to $0). There is no judgment call and nothing
  to argue with: it's the *same answer*, cheaper. This is the cleanest win in the system and the
  easiest to prove to a buyer ("identical output, here's the before/after cost"). It is also the
  most sellable claim, because *equivalence is stronger than "better"* — nobody disputes it.
- **Tier 2 — quality-equivalent trade-off.** The cheaper output *differs* but the assessor judges it
  meets the bar. A real win, but it rests on the judge's quality score, so it's a softer claim than
  Tier 1 and is applied only where Tier 1 found no equivalence.

**"Equivalent" is semantic, not byte-exact.** LLM output varies (temperature, provider drift), so the
equivalence test is a tolerance — token-count proximity **plus** a similarity/quality gate — not
string equality. Frames known to be high-variance are flagged so equivalence is judged conservatively
there. Tier 1 is "swap only when we're confident the result didn't change"; when in doubt, it is not
a Tier 1 swap.

### 12. The cost savings report — the headline output

The user-facing payoff is a **cost savings report**, not raw frames. It is what makes the value
legible and is the primary artifact to put in front of an operator or a buyer. Per run (and rolled up
per period / per workflow / per user), it states:

- **Baseline cost vs. optimized cost vs. $ saved (and %)** — the headline number.
- **Split by tier** — how much came from zero-risk equivalence-swaps (Tier 1) vs. quality-equivalent
  trade-offs (Tier 2). Tier 1 is the number to lead with; it carries no quality caveat.
- **Split by lane** — how much moved to local-LLM ($0), free tier ($0), vs. stayed on paid frontier.
- **Split by `query_type`** — which kinds of calls (data-fetch/classify/summarize vs. reasoning)
  yielded the savings, confirming the routing thesis.
- **Per-swap evidence** — each recommended swap links to its matched-pair replay (baseline frame vs.
  variant frame) so the claim is auditable, not asserted.

Served at `GET /api/token-chase/savings` (and a cockpit surface). It reads the corpus; it does not
re-run anything. The report is the deliverable the optimizer exists to produce.

### Architectural placement

Token Chase is an **orchestration-layer** concern (capture, splice, replay-forward, diff, corpus).
Per CLAUDE.md's controller/bot separation, variants **replay through the same accountable bot
nodes** — the controller never gains an LLM call. Cost capture, per-bot harness/model settings, and
`user_sub` ownership all continue to apply on replay exactly as on the baseline.

## Consequences

**Positive**

- One expensive front-to-back baseline amortizes across dozens of cheap forward-only variants.
- Comparisons are controlled experiments (matched pairs), not anecdotes — the counterfactual labels
  are good enough to learn *causal* preference.
- The harness axis becomes optimizable, which is unique to OSHAL's multi-harness design.
- Rewind delivers forensics and explainability as a free byproduct of the capture step.
- Reuses existing rails: git workspace, `chat_tasks` cost, bot-owned stores, the harness registry.

**Negative / risks**

- **Determinism is load-bearing and hard.** Any unpinned live read corrupts replay silently. The
  pin-or-flag gate must be enforced before variants are trusted (build step 2 below is the gate).
- **Label quality bounds policy quality.** A noisy `quality_score` or a loose `backwards_compatible`
  contract teaches the policy to prefer cheap-but-broken paths. The contracts at phase boundaries
  must be *checkable*, not vibes.
- **Checkpoint storage cost.** Versioning the data store per call adds git objects; needs a
  retention policy (e.g. keep baselines + winning branches, GC losing variants).
- **Encrypted-blob versioning** must keep owner-keying intact across restore — a correctness
  requirement, not an optimization.

**Build path (risk front-loaded)**

1. **Trace capture, read-only** — record the chain + `chat_task_id` linkage for an existing
   workflow. No replay. Proves the chain reconstructs end-to-end.
2. **Checkpoint + forward-only replay (the determinism gate)** — commit the three-part checkpoint;
   replay from a checkpoint with *no* edit and assert the tail reproduces baseline. If it doesn't
   reproduce, stop — variants are not yet trustworthy. **Ship the debugger view (§10) here** — scrub
   / rewind / step over the timeline is the first user-facing deliverable and needs nothing beyond
   steps 1–2.
3. **Single-variant splice + diff** — inject one adjustment (start with the LLM/model axis, lowest
   contract risk), replay forward, render the metrics diff vs. baseline. Include the **cost-floor
   lane abstraction (§9)** so {local-Llama, Gemini-free, paid-frontier} are first-class variants the
   splicer can try — this is mostly surfacing what the provider/harness registries already expose.
4. **Assessor + run–learn loop** — judge persona proposes splice points and scores quality;
   automate keep-winner → re-baseline → next point; begin accumulating the corpus.
5. **Heuristic, then trained policy** — only once the corpus is large enough to beat the heuristic.
   The first useful learned rule is the cost-floor routing of §9 (cheap `query_type`s → $0 lanes).

A concrete implementation sketch for steps 1–2 (capture + replay + debugger), grounded in the real
execution-path hooks, is in
[docs/architecture/token-chase-capture-and-debugger-spec.md](../architecture/token-chase-capture-and-debugger-spec.md).

## Implementation status (2026-08-06)

The following repository behavior is implemented and regression-tested. This status does not claim
that a provider-backed production acceptance run has occurred:

- **Step 1 — capture/read: implemented.** `TokenChaseCapture` writes redacted, owner-scoped frames
  under `<workspace>/.tokenchase/`; authenticated read routes expose runs and frame details.
- **Step 2 — replay substrate: partially implemented.** Single-call replay re-fires the captured
  prompt on an accountable bot node. A tail-replay service can hash-verify and restage recorded
  workspace-tree objects into isolation, walk frames forward, stop at first divergence, and report
  pinned/unpinned reads. Capture does not yet bind every frame to the complete workspace commit,
  encrypted owner-store version, pinned external reads, and tool schema required by this ADR.
- **Step 3 — variants and savings: implemented for per-frame model lanes.** BYO/framework
  OpenAI-compatible variants produce cost, latency, and determinism diffs; the run loop persists
  corpus observations and reports realizable `equivalent-cheaper` savings. The `free:auto`
  aggregate selector is offered only while an owner-visible free lane is outside cooldown or the
  process has a cached-live platform `:free` lane. Selection itself is authoritative at replay time:
  the existing probe/LRU resolver chooses the lane, classified provider/quota walls cool it and
  retry the same frame on another free lane, and exhaustion stops without invoking the bot's
  configured provider. Variant/corpus evidence records the server-resolved provider and model.
  `POST .../variant` returns the secret-free `selection` trace (attempts, rotations, fail-closed
  status, provider, model); `POST .../savings` returns the corresponding aggregate `laneSelection`.
- **Step 4 — judge and keep-winner: implemented.** The quality-judge lane grades observations;
  lexical fallback grades are structurally ineligible for promotion. Manual promotion is
  authenticated, owner-scoped, thresholded, transactional, and audited. Automatic promotion is
  default-off (`TOKEN_CHASE_AUTO_PROMOTE=true` is the explicit opt-in). Active winners become the
  next savings run's per-frame cost/provider/model baseline; an authenticated audited revert removes
  that active baseline so a detected regression returns subsequent runs to the captured baseline.
  Promotion and audit tables use owner-or-operator RLS in both migration 095 and the lazy bootstrap.
- **Spend controls: implemented.** `TOKEN_CHASE_BUDGET_USD` caps replay spend and
  `TOKEN_CHASE_JUDGE_BUDGET_USD` separately caps quality-judge calls. Both have finite defaults,
  check before the next paid call, and report partial completion rather than implying a full grade.

**Still Proposed or awaiting external proof:** the complete commit + encrypted-store checkpoint,
tool/read pin capture, artifact-producing downstream replay, interactive rewind/edit/forward debugger,
learned selection policy beyond the shipped health/LRU free-lane selector, and current provider-backed
acceptance evidence. Their exact
acceptance boundaries remain in the Token Chase section of [BACKLOG.md](../BACKLOG.md).
