# Delivery

How a client engagement is run: the method, and the bots that replicate it. Consulting process,
not platform architecture — for how the platform itself is built, see
[../architecture/](../architecture/).

- [ENGAGEMENT-METHOD.md](./ENGAGEMENT-METHOD.md) — the seven steps from a recorded discovery call
  to a hand-over pack (Discover · Baseline · Measure · Architect · Build · Verify · Package), the
  artifact set each step produces, which `delivery-*` bot runs it, and the six failures that
  shaped it — every one of which reported success at the time.

## The bots

Four personas encode the method so it does not have to be hand-driven. Each has its own quality
gate; all four live in [ai-lab/bot-personas/](../../ai-lab/bot-personas/).

| Persona | Runs | Produces |
|---|---|---|
| [delivery-analyst](../../ai-lab/bot-personas/delivery-analyst.yaml) | Discover, Baseline | requirements with a quote, a verified today-state and a done-when per item |
| [delivery-sizer](../../ai-lab/bot-personas/delivery-sizer.yaml) | Measure | a dataset at projected volume, timings with query plans, concurrency results, the sizing report |
| [delivery-architect](../../ai-lab/bot-personas/delivery-architect.yaml) | Architect | as-is/to-be, a reference architecture per option, cost/risk/security tables, decision trees, the deck |
| [delivery-verifier](../../ai-lab/bot-personas/delivery-verifier.yaml) | Verify, Package | deploy parity, browser proof, red-proven guards, the hand-over pack |

Build (step 5) uses the existing build swarm — there is no delivery-specific builder.
