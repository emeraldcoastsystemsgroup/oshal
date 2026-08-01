# Research Notes

This directory holds focused OSHAL research documents that compare external protocols, runtime patterns, and candidate frameworks before they are promoted into architecture decisions or implementation plans.

## Available research

- [A2A vs Legacy Custom Mesh](./a2a-vs-legacy-custom-mesh.md)
- [OSHAL Product Architecture](./oshal-product-architecture.md)
- [Generic Node Pool / Hot Loading Architecture](./generic-node-pool-hot-loading-architecture.md)
- [CLI Agent Factory Architecture](./cli-agent-factory-architecture.md)
- [any-bot Migration Impact Assessment](./any-bot-migration-impact-assessment.md)
- [any-bot Swarm Separation Design](./any-bot-swarm-separation-design.md)
- [Redis Report](./redis-report.md)
- [Position Paper — Demote, Don't Delete](./position-paper-light-ai.md) — evidence-backed argument (~7,600 words, ~100 sources, MLA) that a general model belongs upstream authoring a deterministic predicate that occupies the default path, with the model *retained* on the residual behind a differential monitor. Survived a three-round adversarial refutation that killed its original "extract and delete" thesis, then a second independent verification pass (2026-07-31) that re-checked every load-bearing quotation and figure against primary sources; withdraws or corrects eighteen claims, prints the case against itself without rebuttal, and states its own falsification conditions
- [Field Guide — Where to Put the Model](./field-guide-where-to-put-the-model.md) — practitioner companion to the position paper. Ten-minute read for teams whose AI works in the demo and fails in production: why placement (not prompting) is usually the failure, the four-condition triage for which model calls qualify, and a two-week read-only-gate experiment to run before committing
- HANDOVER — A2A-vs-mesh research handover notes (companion to the A2A doc)

## How to use this folder

- use these documents for early technical comparison work
- convert accepted recommendations into ADRs and implementation plans
- keep legacy-system references framed as migration inputs, not target-state design
