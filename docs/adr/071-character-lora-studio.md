# ADR-071 — Character LoRA Studio: train, validate, and iteratively improve a reusable character

- **Status:** Accepted — 2026-06-24. P0–P5 built (controller app + box-side scripts), type-clean and
  unit-tested; not yet run end-to-end (needs the GPU edge box up + kohya installed — see "Status of the
  build").
- **Date:** 2026-06-24
- **Related:**
  [ADR-070 (multi-provider video generation: free-first, escalate-on-approval)](070-multi-provider-video-generation.md),
  [ADR-046 (Token Chase: cost/quality optimization)](046-token-chase-checkpoint-replay-optimization.md),
  [ADR-047 (edge bot-node + privileged-runtime security review)](047-smart-home-edge-agent.md),
  [ADR-036 (bot-owned application architecture)](036-bot-owned-application-architecture.md),
  [ADR-063 (AI Test Lab: black-box evaluation)](063-ai-test-lab.md)

## Context

The Video Studio (ADR-070) produces short-form videos, but telling a *story* needs a **character that
looks the same across many shots**. Identity-by-`img2img`-off-a-locked-hero already gives basic
consistency, but a **trained character LoRA** is cleaner, faster, and more flexible (it learns the
identity from a trigger word instead of re-deriving it from a reference each time).

An overnight run on the operator's GPU box (RTX 4060) generated a high-quality, captioned **training
dataset** for a fixed "oshbrainrot" cyclops character — 90 paired image/caption files at
`overnight/curated.zip`, trigger word `oshbrainrot`. But there was **no training step anywhere in the
repo** (the box-side pipeline stopped at the curated zip) and **no validation/curation judge** (the
existing `make-curate.py` is just even-sampling for human review).

Two reframes drove this ADR:

1. **Generating data is the easy half; validation and rejection are what make a character model good.**
   A sharper image that looks like a *different* creature is a regression. Without an objective,
   repeatable measure, "is v2 better than v1?" is a vibe.
2. **The user should own the loop, not run box scripts by hand.** Picking a character, building a
   dataset, curating, training, validating, and improving should be a first-class app — the same
   bot-owned pattern as Video Studio.

## Decision

**1. A bot-owned app (`?app=lora`), mirroring Video Studio.** A reason-only `lora-director` bot
(agent `…049`, inline on the api, claude-code harness) explains scorecards, recommends which weak cells
to target next, and — opt-in, metered — can act as a vision judge over a contact sheet. The controller
orchestrates; the bot never shells out or trains.

**2. Two box transports, split by trust (the privilege rule from ADR-070 #3).**
- **Generation + validation = ComfyUI HTTP** over Tailscale — a free *provider* call (ComfyUI's HTTP
  API is the control surface; no ticket needed).
- **kohya LoRA training = `shell.exec` on the box** — a separate process, not a ComfyUI workflow, so the
  only transport is a command on the machine. That is privileged edge control, so it goes **only through
  a queue/worker path on an authorized action**: an embedded `mcp.call-tool` → `shell.exec` task enqueued
  on the edge worker, which runs it only with `allowSystemControl` enabled. Never a direct endpoint call.

**3. "Better" is an objective number (Token Chase / AI Test Lab applied to a model).** Every version is
scored on a **fixed, held-out validation matrix** (pose × camera × expression combos the trainer never
used, with pinned seeds). Each cell gets an **identity** score (CLIP-image cosine to the locked hero) and
a **quality** score (a no-reference CLIP good-vs-bad proxy plus a single-eye guard — for a cyclops, "two
eyes" is the identity failure). Per-cell score = `0.6·identity + 0.4·quality`; version score = mean over
cells. Same matrix + seeds + hero + CLIP model ⇒ `score(vN)` is directly comparable to `score(v1)`.

**4. Three improvement mechanisms, not one ("how it gets better").**
- **Rejection (curation):** off-identity candidates (two eyes, deformed, morphed, multiple characters)
  are scored against the spec and excluded before training — garbage-in prevention.
- **Validation (measurement):** the fixed-matrix scorecard turns "better" into a comparable number.
- **Targeted regeneration (active learning):** the scorecard exposes *systematic* weak axes (e.g.
  side-profile + screaming scores low); the next training batch is generated **biased to those weak
  cells**, re-curated, and retrained → v+1, re-scored on the same matrix. Keep the best; version the
  `.safetensors`. This is the actual improvement engine — directed, not "more random data."

**5. Two run modes, human-gated by default.** Manual train/validate/improve are operator clicks (the
click is the gate). An opt-in **autonomous overnight** loop runs generate→curate→train→validate→target→
retrain until the score plateaus or a wall-clock cap, then **parks an `approval_required` morning-review
ticket** — it never silently promotes a version.

**6. State split.** The controller DB holds the authoritative metadata (characters, versions, scores,
the active "kept-best" flag); the GPU box keeps the heavy artifacts (`.safetensors`, datasets, samples).
The keep-best decision and the UI never touch the box.

## Hard rules (operator directives)

1. **Free-first is absolute.** The default scorer is local CLIP ($0). The LLM-vision judge is an opt-in,
   metered tie-breaker only — never the primary score. Local GPU training is compute, not dollars.
2. **Privileged training only via a ticket + the worker's gated `shell.exec`.** Never a direct box
   endpoint call, never Jarvis-direct. Each train/validate/improve files a `lora-train` ticket first.
3. **The box owns its artifacts; the controller owns the decision.** Models stay on the box (they feed
   ComfyUI directly); only metadata + scores cross to the controller.

## Consequences

- **Reusable characters become a first-class capability** that feeds Video Studio stories — a consistent
  cast instead of one-off generations. Single-vendor image tools can't route you off their own model;
  OSHAL trains *your* character on *your* GPU for free and escalates only behind an approved gate.
- **Adding a character = data + a training run, not a new app.** v1 is hardcoded to the cyclops; the
  generalization (P6) reads per-character config so the create-wizard works for any subject.
- **Validation is reusable infrastructure.** The fixed-matrix scorer is the AI Test Lab pattern pointed
  at a model; the same shape could score any fine-tune.
- **Honest limits:** local CLIP scoring is a heuristic (good enough for comparing versions on identical
  inputs; the LLM-vision judge is the upgrade). kohya must be installed on the box (a prerequisite). The
  autonomous loop spends GPU hours unattended and leans on the auto-curation; it still ends at a human gate.

## Status of the build (2026-06-24)

Built, type-clean (0 tsc errors), unit-tested (scorecard math), and Python-syntax-checked:

- **Controller:** `swarm-apps/lora.yaml`, `ai-lab/bot-personas/lora-director.yaml`, registry entry (…049),
  `src/app/routes/bot-lora-routes.ts` (characters / models / scorecard / keep-best / autonomous +
  ticketed `/train` `/validate` `/improve` `/improve-overnight` + public service-secret `/ingest`),
  `src/app/lora-train-dispatch.ts` (enqueues the gated box command via the exported `remoteClientRegistry`),
  `src/features/lora-studio/scorecard.ts` (objective score + weak-cell math), `src/api/lora.html`,
  migration `scripts/migrations/058-lora-studio.sql` (`oshal_lora_characters/_models/_scores`, seeded with
  the cyclops).
- **Box (`scripts/comfyui-edge/`):** `setup-kohya.ps1`, `train-lora.py` (kohya SD1.5 LoRA, 8GB params),
  `validate-lora.py` (LoraLoader + fixed matrix + CLIP scoring + gallery + ingest), `make-targeted-batch.py`
  (weak-cell biased regen), `overnight-loop.py` (autonomous improve→plateau→review).

**Not yet run end-to-end** — requires the GPU edge box reconnected (ComfyUI + the oshal-chat worker node),
`oshal-api` rebuilt to load the new routes, and `setup-kohya.ps1` run once. Phasing and the remaining work
(P6 generalize-to-any-character, gallery image hosting, automated curation judge, schedule-runtime trigger
for autonomous) are tracked in `docs/BACKLOG.md`.
