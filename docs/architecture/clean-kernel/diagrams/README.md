# Clean kernel — diagrams

Mermaid source, rendered by GitHub and most editors. Each page carries the diagram, a legend, and the
spec section it illustrates. Update the diagram when the spec changes; the spec is the authority.

| # | Diagram | Illustrates |
|---|---|---|
| 01 | [Crate dependency graph](./01-crate-graph.md) | build-enforced layering, forbidden edges |
| 02 | [The one door](./02-admission-door.md) | `admit()` sequence, entry kinds, what the door guarantees |
| 03 | [Kernel object model](./03-object-model.md) | every kernel object, ownership, who constructs it |
| 04 | [Package lifecycle](./04-package-lifecycle.md) | hot-load state machine, two hosts one contract |
| 05 | [Ticket → envelope flow](./05-ticket-envelope-flow.md) | swarm loop, four transports, dispatch sequence |
| 06 | [Harness is a node](./06-harness-node.md) | bring-your-own harness enrollment and claim, the three BYO shapes |
| 07 | [Tenancy and scoping](./07-tenancy-scoping.md) | one key function for every store, activated principals |
| 08 | [Deployment topology](./08-deployment-topology.md) | demo/home vs team/enterprise, process anatomy |
| 09 | [Self-writing loop](./09-self-writing-loop.md) | producers emit packages, kernel changes go through review |
| 10 | [Type-level guards](./10-type-guards.md) | `Ctx<Mode>`, `SecretRef`, compile-fail proofs |
| 11 | [Data planes](./11-data-planes.md) | connector, knowledge/RAG and time-series rails over one key function |
| 12 | [Identity and settings](./12-identity-and-settings.md) | providers to one principal, person lifecycle, settings precedence |
| 13 | [Monitoring and self-healing](./13-monitoring-self-healing.md) | observability, health, bounded remediation and the forbidden set |
| 14 | [Workflow authoring to runtime](./14-workflow-authoring-to-runtime.md) | design time compiles into the one engine; validation, gates, run records |
| 15 | [Trace and token economy](./15-trace-and-token-economy.md) | the span and cost spine, and counterfactual optimization with a judge |
| 16 | [Node network and external agents](./16-node-network-and-external-agents.md) | paths, enrollment and lease, why reachability is not authorization |
| 17 | [Person model and consent](./17-person-model-and-consent.md) | capture to transcript to three stores to a guarded recall slice |
| 18 | [Task workspace collaboration](./18-task-workspace-collaboration.md) | claims, commits and two harness kinds on one workspace; what a commit must survive |
| 19 | [Assistant integration](./19-assistant-integration.md) | the three kernel rails, hand-off to surfaces, and the four rules with scars behind them |
| 20 | [One way to do things](./20-one-way-to-do-things.md) | three submission paths become one with deadline conversion; accretive prompt layering becomes a fixed frame |
