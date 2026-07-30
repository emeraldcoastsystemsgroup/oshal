# OSHAL Assets

These assets turn the validated platform work into material that can be used for demos, benchmark reviews, investor/customer conversations, and internal alignment.

Use this folder when someone asks "what is OSHAL?", "what did we prove?", or "how do we demo it without hand-waving?"

## Asset Map

- [one-pager.md](./one-pager.md)
  - concise product explanation, buyer value, proof points, and current limits
- [benchmark-brief-dynamic-insertion.md](./benchmark-brief-dynamic-insertion.md)
  - validated dynamic tool and dynamic bot insertion benchmark brief
- [demo-script.md](./demo-script.md)
  - live demo talk track with commands, expected outcomes, and recovery notes
- [sales-deck-outline.md](./sales-deck-outline.md)
  - slide-by-slide narrative for a short OSHAL pitch deck
- [native-kernel-deck.pptx](./native-kernel-deck.pptx)
  - "Should we rewrite it in a compiled language?" — 16 slides on the profile-first method, the 5-7x
    bit-exact result, and the limits. **GENERATED, do not hand-edit:**
    `npx tsx scripts/build-native-kernel-deck.ts [--theme <id>]`. Every figure lives in that script's
    `MEASURED` block with a pointer at the benchmark that produced it — editing the deck directly is
    how a generator drifts from the docs it is supposed to mirror.
- [messaging-kit.md](./messaging-kit.md)
  - positioning, taglines, objection handling, and proof language
- [operator-benchmark-runbook.md](./operator-benchmark-runbook.md)
  - exact operator steps for rerunning the benchmark
- [implementation-fulfillment-ledger.md](./implementation-fulfillment-ledger.md)
  - item-by-item implementation status, execution path, proof, and boundaries
- [visual-identity.md](./visual-identity.md)
  - SVG mark, wordmark, color tokens, and visual usage notes
- [oshal-mark.svg](./oshal-mark.svg)
  - square visual mark
- [oshal-wordmark.svg](./oshal-wordmark.svg)
  - horizontal wordmark

## Current Proof Level

Validated on 2026-05-09 to 2026-05-10 against the local Docker swarm:

- One repeatable live dynamic-agent E2E test passed.
- One bounded aggressive pass created and launched 18 dynamic tools plus 18 dynamic bot containers.
- The aggressive pass is now runnable with `npm run benchmark:dynamic-insertion`.
- The framework contract suite is runnable with `npm run test:framework-contracts` and currently reports 10 passing tests.
- All dynamic bots were healthy, heartbeating with profile-backed routing metadata, visible in the bot registry, and subscribed to Redis mesh channels.
- Cleanup left zero dynamic test agents, tools, runtime executor rows, compose overlays, persona files, mesh keys, or containers.

## Honest Boundary

These assets sell the platform insertion and framework story. They do not claim that full LLM work-item execution quality has been benchmarked yet. That benchmark requires valid model credentials and a task-completion workload.
