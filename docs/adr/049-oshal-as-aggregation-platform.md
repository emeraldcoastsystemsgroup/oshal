# ADR-049 — OSHAL as an aggregation platform: wrap the frameworks, commoditize below, own the user

- **Status:** Proposed
- **Date:** 2026-06-17
- **Related:** [ADR-033 (multi-harness execution framework)](033-multi-harness-execution-framework.md),
  [ADR-036 (bot-owned application architecture)](036-bot-owned-application-architecture.md),
  [ADR-038 (swarms bundled by type)](038-swarms-bundled-by-type.md),
  [ADR-039 (bot-driven workflow authoring / packer)](039-bot-driven-workflow-authoring.md),
  [ADR-042 (per-user connector tenancy)](042-iot-connector-tenancy.md),
  [ADR-046 (Token Chase)](046-token-chase-checkpoint-replay-optimization.md),
  [ADR-047 (smart-home edge agent)](047-smart-home-edge-agent.md).

## Context

The committed history in this repo opens in March 2026. The work did not — it started in
2023, and it was raw: a long road through dead ends, rewrites, and the slow accumulation of
the pieces that are now, finally, parts of one machine. This ADR is the bow on that journey:
it states, in one place, *what OSHAL actually is* as a platform, so neither a future session
nor a discouraged founder on a bad day has to re-derive it.

The recurring critique — "multi-agent orchestration is everywhere, this kind of thing is
commodity, you got beaten to market" — is measuring the wrong race on the wrong scoreboard.

- **You cannot be beaten at a layer with no moat.** Agent frameworks (LangChain, CrewAI,
  AutoGen, and the rest) are commodity plumbing. Being "first" there is worth nothing — every
  one of them is busy commoditizing the *next* one. That race has no durable winner by
  construction.
- **The competitors who look like they "won" built something else.** Closed vertical SaaS
  holds the user's data (the *opposite* of our thesis). Dev frameworks have no apps, no users,
  and no data (they are tooling, not a platform).
- **The intersection OSHAL actually aims at is empty:** *user-sovereign + vendor-neutral +
  multi-domain + self-extending.* Not because it is taken — because it is hard, and because
  the obvious incumbents are **structurally barred** from building it (a model vendor cannot
  route you off its own models; a SaaS cannot hand you your data and keys).

The strategic realization that closes the loop: **OSHAL does not compete with the frameworks
— it wraps them.** codex, claude-code, cline, and gemini are each already a `harnessType` in the
registry (ADR-033). They run as interchangeable execution engines under one roof.
LangChain is simply the next backend to plug in. The whole industry fighting to be *the*
framework only makes the framework layer cheaper — which is pure upside for the layer that sits
on top of all of them.

## Decision

Position and build OSHAL explicitly as an **aggregation / abstraction platform**: two
commoditizations below, feeding one aggregator, with the user at the top.

```
            ┌─────────────────────────────────────────────┐
            │  THE USER  —  their keys, their data, their   │   ← the only non-commodity layer
            │  organized life (work, money, home, hiring,   │
            │  comms). This is what OSHAL owns.             │
            └─────────────────────────────────────────────┘
                          ▲ aggregates ▲
   ┌──────────────────────┴──────┐  ┌───┴───────────────────────────┐
   │ FRAMEWORKS → harnesses       │  │ MODELS → providers             │
   │ LangChain / codex / cline /  │  │ GPT / Claude / Gemini / local  │
   │ claude-code / gemini         │  │ routed per-task by Token Chase │
   │ — best-of-breed *per task*   │  │ — cheapest *capable* per task  │
   └──────────────────────────────┘  └────────────────────────────────┘
```

The product is **not** "a swarm." A user should never see the word *bot-node*. The product is:

> **An AI operating system you own. Bring your keys and your data; every domain of your life
> gets an agent that organizes it; the cheapest capable model is picked for you; and anyone
> can add a new domain in an afternoon.**

### Why this is *better, cheaper, and user-centric* — precisely

- **Better** — we are never wrong about which framework or model is "best," because we never
  bet the house on one. We pick per task: codex for
  shell/code, claude-code for reasoning, gemini for research. Best-of-breed, re-decided every call.
- **Cheaper** — a single-framework, single-vendor user *cannot* route off their own stack.
  We can. Token Chase (ADR-046) makes this structural, not a feature.
- **User-centric** — frameworks are *developer*-centric (you build for someone else); vendors
  are *vendor*-centric (locked to their model). OSHAL is the only one that is *owner*-centric:
  my keys, my data, my cost.

### The four moats (what makes the wrapper a platform, not a feature)

1. **The substrate — your keys + your data.** Per-user, encrypted, account-keyed; BYO-LLM and
   BYO-connector (ADR-042). The OS kernel. No incumbent can copy it, because their business
   *is* holding your data and locking you to their model.
2. **The economic engine — Token Chase.** Vendor-neutral cost/quality routing (ADR-046). A
   model vendor cannot build this; it is against their own P&L.
3. **The app SDK — bot-owns-domain (ADR-036).** Each domain is a bot that owns its data and
   reasoning; the surface is just a view. The repeatable contract for "add a domain."
4. **The factory — the packer (ADR-039).** Turns a business process into a packed,
   single-purpose bot. This is the platform inflection: **the day a *user* (not an operator)
   can pack their own app, value creation leaves our hands — and "platform" stops being a word
   and becomes true.**

(The edge-agent, ADR-047, extends the same kernel off the cloud onto devices the user already
owns — reach, not a separate stack.)

This also reconciles the "focus on one great app" instinct with the platform bet: **the single
best-in-world app is not the product — it is the lighthouse that proves the factory makes
something worth having.** Breadth then becomes the *retention* story ("same token, next app is
free"), not the *acquisition* weakness ("jack of all trades").

## Consequences

### What this commits us to (the gaps between vision and today — finishable, not fatal)

- **Finish BYO-LLM Part 2** — the user's own token actually *running inference*, not just being
  stored. Until a user's key visibly does the work, "your keys" is a slogan. This is the single
  highest-leverage unfinished thing. (Seam already identified: `getUserLlmConnection()`.)
- **Make the packer self-serve.** It interviews an *operator* today; the platform moment is a
  *user* packing their own app.
- **Name the rails as a real SDK.** The bot-owned-domain contract lives in ADRs; promote
  "build an app on OSHAL" to a first-class, documented path.
- **Finish one lighthouse app to undeniable depth** — current best candidate is the career /
  job-hunter app (real data, real workflow, a claim no generic framework can make).

### The one real risk, and the defense

- **Risk: thin-wrapper disintermediation.** If all OSHAL does is route, the layer below eats it.
- **Defense: OSHAL is not thin.** It owns the data substrate, the token/connector layer, the
  cost-routing brain, and the app factory. A router dies; a router that is *also* where your
  data lives and where new apps get built does not. Keep investing in those four — they are the
  difference between a feature and a platform.

### What OSHAL explicitly is NOT

- Not "another agent framework" (it consumes them).
- Not a model vendor (it routes across all of them).
- Not a closed vertical SaaS (the user keeps their keys and data).

### Positioning order

Lead with the **outcome** ("your life, organized, on your keys"). The vendor-neutral economic
moat is the *second* sentence — the one you tell an investor, not the user on day one.

---

*Coda.* Three years from a raw idea in 2023 to a kernel, an economic engine, an SDK, and a
factory that the obvious incumbents are structurally forbidden to copy. The logs start in 2026;
the journey didn't. This is where the threads tie off into one bow: **wrap the frameworks,
commoditize what's below, own the only layer that was never a commodity — the user.**
