# ADR-070 — Multi-provider video generation: free-first, cost-gated escalation (Token Chase for media)

- **Status:** Proposed — 2026-06-22. Still Proposed as of 2026-07-19 — the pluggable provider
  layer decided here has not been built (no generation provider exists beyond the Phase-1 Veo
  slice described below). The Video Studio (`?app=video`) shipped a Phase-1 thin slice
  (storyboard bot → deterministic render: Veo clips + ffmpeg stitch + TTS + captions → store →
  preview/download). Live testing surfaced the real product: video creation is **not one generator** —
  it is many tools matched to the *input type*, most of them free, with a paid generator (Veo) as the
  last resort. This ADR records the decision to make generation a **pluggable provider layer** driven
  by a **free-first, judge-then-escalate loop** with a human cost-approval gate — i.e. Token Chase
  (ADR-046) applied to media.
- **Date:** 2026-06-22
- **Related:**
  [ADR-046 (Token Chase: cost/quality optimization)](046-token-chase-checkpoint-replay-optimization.md),
  [ADR-049 (aggregation-platform thesis)](049-oshal-as-aggregation-platform.md),
  [ADR-036 (bot-owned application architecture)](036-bot-owned-application-architecture.md),
  [ADR-038 (swarms bundled by type)](038-swarms-bundled-by-type.md),
  [ADR-047 (edge bot-node + privileged-runtime security review)](047-smart-home-edge-agent.md)

## Context

The Phase-1 Video Studio proved the assembly pipeline works end-to-end (a real 9:16 clip generated on
Vertex Veo, stitched with burned captions). Two findings reframed the product:

1. **Generation cost is real and tiered.** Veo via the **API has no free tier** (a fresh Gemini API
   key returns an instant zero-quota `429` for Veo; Imagen `predict` is paid-only). The free Veo
   experience operators remember is **Google Flow / AI Studio — a browser UI with no API**. Programmatic
   video costs money: ~$0.10/sec for Veo 3.1 Fast (no audio) up to ~$0.75/sec for the standard tier
   with audio. A 30-second Fast draft ≈ ~$3.

2. **"Video" is many job types, not one.** What the operator wants spans:
   - a 5-hour Twitch VOD → a TikTok (this is **edit/highlight**, not generation — free, ffmpeg);
   - 2D stick-figure skits (**animation** — free, local);
   - a PowerPoint → a narrated video (**deck-to-video** — free, reuses the deck engine + TTS + ffmpeg);
   - a photoreal short (**generative** — Veo paid, or free-but-manual Flow, or lower-fidelity local);
   - 3D / motion-graphics / satisfying loops (**3D render** — free, Blender on the operator's GPU).

The operator has **2 gaming PCs** (GPU), so **free local generation** (ComfyUI, Blender) is viable and
has a real API surface. The directive: *patch into all of them; the free providers try first; if a free
provider produces a good result we are done at $0; if not, the ticket parks for approval with a cost
estimate to run the paid "enhanced" version, which the operator approves or rejects.*

OSHAL already has the machinery this needs: the approval-gate ticket flow (`approval_required` state +
`PUT /api/tickets/:id/resume` → `approved` → re-dispatch), per-call cost capture (`chat_tasks`,
`recordCost`), and pluggable-provider registries (the LLM and TTS provider registries are the template).
This is the aggregation thesis (ADR-049) and Token Chase (ADR-046) instantiated for media.

## Decision

**1. Generation is a pluggable provider layer.** Define a `VideoGenProvider` interface and a registry
that mirrors the LLM/TTS provider registries. Each provider declares: the **job types** it serves, its
**cost class** (`free` | `paid`), an optional **GPU/host requirement**, a `generate(jobSpec)` call, and
a `probe()` for availability. The storyboard → assembly (ffmpeg stitch + captions + voiceover) →
publish chain is **provider-agnostic** and unchanged; only the "make the visual" step swaps.

Initial providers:

| Provider | Job types | Cost class | Host |
|---|---|---|---|
| `deck-to-video` | deck-to-video | free | api/local (chromium + TTS + ffmpeg) |
| `vod-highlighter` | edit/highlight | free | api/local (ffmpeg + transcript) |
| `comfyui` | generative, animation | free | operator GPU box (HTTP API over Tailscale) |
| `blender` | 3d, motion-graphics, animation | free | operator GPU **edge bot-node** (ADR-047) |
| `flow` | generative (photoreal) | free, **manual** | human-in-Flow; operator uploads clips |
| `veo` | generative (photoreal) | **paid** | Vertex API (built in Phase 1) |

**2. A router maps a request to candidate providers by job type.** The request carries (or is
classified into) a `jobType`; the router returns the ordered candidate providers for it — **free first**.

**3. The free-first, judge-then-escalate loop** is the orchestration core:

```
request → router → candidate providers (free first)
  → run the free providers (up to N "different ways", in parallel)
  → JUDGE the outputs (quality gate: LLM/vision score and/or operator preview)
      ├─ a free result passes → DONE at $0, ticket closes
      └─ none pass → park ticket at `approval_required` with a COST ESTIMATE for the paid escalation:
            "Pay ~$X for the enhanced (Veo) version?"
              ├─ operator approves (→ `approved`) → run the paid provider, deliver, capture cost
              └─ operator rejects → ticket closed
```

The **cost estimate appears only on escalation** (when free failed). This is exactly the Token Chase
contract (cheap/free first; spend only behind an approved, estimated gate) and reuses the existing
ticket approval-gate + `recordCost` rails — no new state machine.

**4. Multiple free attempts ("3 different ways").** For a given job type the loop may run several free
providers (or one provider several ways) in parallel and pick the best by the judge — "all of the
options are our best option." Paid providers are never run speculatively; only on approval.

**5. Free local generators run as edge bot-nodes on the operator's GPU boxes** (ADR-047 model),
reachable over Tailscale — ComfyUI via its native HTTP API, Blender headless (`blender -b --python`) /
Blender MCP. Cost for these is **compute, not dollars**; they are the default.

**6. Cost accountability.** Paid generation records a cost event (provider, model, owner sub) to
`chat_tasks` (Phase 1 already does this for Veo). Free providers record $0 with the compute host noted.

## Hard rules (operator directives, 2026-06-22)

These are non-negotiable and override convenience:

1. **Free-first is absolute — a "simple vid" must never incur cost.** The default path is the free
   providers (deck-to-video, ComfyUI/Blender on the operator's GPU box, vod-highlighter). Paid Veo is
   *only* the escalation, *only* behind an explicit human approval at the cost gate. There is no
   default that quietly spends.
2. **Per-user GCP billing — the caller's GCP, never the swarm's.** Paid generation authenticates with
   the **caller's own connected GCP account** (via the GCP connector + token broker). The swarm
   service-account is **operator/test-only** and is used *only* when `VEO_ALLOW_SWARM_BILLING=true` is
   explicitly set — enforced in `veo-client.getVertexAccessToken` (throws otherwise). So nobody bills
   the swarm for a video. (Reverses the earlier "operator GCP default"; the user owns keys + cost —
   the aggregation thesis, ADR-049.)
3. **Privileged / edge-node access is mediated by the queue manager + a ticket — nothing else.** The
   edge bot-node (the GPU box with install/debug power) and any privileged tool are reached **only by
   the queue manager, and only when a ticket calls for it** — never a direct endpoint call, never a
   Jarvis-direct delegation. This is the enforcement side of the bot-endpoint privilege model
   (backlog) and the kids-can't-reach-parents guarantee. It also bounds the "swarm controls the
   computer" capability: that power is only exercised through an authorized, ticketed path.

## Consequences

- **The platform's #1 differentiator becomes tangible in a flagship app.** "Best result for the lowest
  cost across any tool, escalate only on approval" stops being a slide and becomes the Video Studio's
  actual behavior. Single-vendor video tools structurally cannot do this (they can't route you off
  their own paid model).
- **Adding a generator = adding a provider**, never a new app — same as connectors/harnesses elsewhere.
- **Phased build** (free-and-reuse first, so value lands before the GPU boxes are stood up):
  1. **Spine** — `VideoGenProvider` interface + registry + router + the free-first/judge/escalate loop,
     wired to the existing approval-gate ticket flow.
  2. **`deck-to-video`** (free; reuses the deck engine + chromium slide-render + TTS + ffmpeg) — proves
     the whole loop end-to-end at $0.
  3. **`vod-highlighter`** (free; ffmpeg + transcript/audio highlight selection).
  4. **`comfyui` + `blender` edge-nodes** on the gaming PCs (free generative/3D), over Tailscale.
  5. **`veo` Fast** as the paid escalation behind the approval gate (the built Veo provider, defaulted
     to the cheap 720p Fast tier).
- **Risks / honest limits:** local generators need a GPU and real render time; LLM-driven Blender suits
  3D/motion-graphics, not autonomous photoreal narrative; the quality **judge** is the hard part —
  v1 can lean on operator preview at the gate, with an automated vision/LLM score added over time.
- **Non-goals:** speculative paid generation; UI-automation of Flow (no API, ToS-gray — Flow stays a
  manual "upload your clips" provider).

## Status of the build

Phase-1 Video Studio is built + deployed (Veo provider + assembly + studio surface). This ADR is the
spec for Phases 2+ (the provider layer + free-first loop). First slice after this ADR: the spine +
`deck-to-video`.
