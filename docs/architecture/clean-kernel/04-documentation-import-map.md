# Clean kernel — documentation import map

**Status:** DRAFT 2026-09-17, first-pass classification for operator review. Every ADR and architecture
document in this repo is classed and given a target in the clean design. Titles are abbreviated;
the file name is the reference.

## Classes

| Class | Meaning | What "import" means |
|---|---|---|
| **K** kernel | the decision defines a kernel object, rule or process | restated in [01](./01-high-level-spec.md) or [02](./02-rust-object-model.md); the ADR's status line gains a pointer here |
| **P** package | the decision is a domain; the kernel provides only the rail named in the target | moves with its package; the kernel document names the rail, never the domain |
| **N** node | the decision is about a machine, device or agent joining the swarm | restated under the node model (spec §4.6, diagram 06) |
| **G** governance | a repo, process or business decision | carried as process; no code target |
| **S** superseded | replaced by a clean-design rule | recorded as history; the ADR's status line names the superseding section |

Target crates: `types` (kernel-types), `control`, `store`, `mesh`, `inference`, `intents`, `orch`
(orchestration), `packages`, `sdk`, `observe`, `api`, `node` (oshal-node), `deploy` (modes and artifact).

## ADRs

| ADR | Title (abbreviated) | Class | Target |
|---|---|---|---|
| 001 | Migration onto FSD | S | crate graph (diagram 01) replaces layer-by-lint |
| 002 | Encrypted configuration storage | K | `control`: `SecretRef` and secrets at rest |
| 003 | API-key authentication | S/K | superseded for people; service credentials become device-bound node tokens (`node`) |
| 004 | Containerization strategy | S | `deploy` modes |
| 005 | Cline CLI only call path | S | `inference` trait; harness is a node |
| 005b | Docker memory optimization | S | `deploy` |
| 006 | Multi-agent configuration | K | `types::Bot`, brain records |
| 007 | E2E auth enforcement rule | K | C-01, compile-time (diagram 10) |
| 008 | Mock OIDC development mode | K | [05 §A](./05-subsystem-specs.md#a-identity-sso-and-oidc) A6: mock is a provider row, refused outside demo |
| 009 | API tool framework | K | `sdk::Tool` |
| 010 | Layer-1 tools, database-backed switches | K | [05 §E](./05-subsystem-specs.md#e-dynamic-loading-packages-bots-tools-capabilities); switches become settings and grants ([05 §C](./05-subsystem-specs.md#c-settings-admin-user-package)) |
| 011 | Agent framework with Cline layer | S | harness is a node |
| 012 | OS-control MCP adoption (parked) | N | node-resident device capability |
| 013 | Headscale overlay network | N | [07 §S](./07-subsystem-specs-2.md#s-node-network-overlay-and-enrollment) S2, S3: a transport, never an authorization |
| 014 | any-bot k8s Headscale gateway | S | `deploy` enterprise mode |
| 015 | Swarm phase inheritance pack | K | [07 §L](./07-subsystem-specs-2.md#l-workflow-authoring-and-execution) phases as data |
| 016 | Swarm agent type and inheritance | K | `types::Posture`, bot kinds |
| 017 | Localhost / swarm inheritance | S | folded into 016 and `deploy` modes |
| 018 | Swarm processing runtime contract | K | `orch`: synchronous orchestration entry, phase lifecycle |
| 019 | Per-bot container architecture | S | posture `Node` + package hosts; one accountable process per node bot survives as a rule |
| 020 | Codex runtime provider wiring | S | `inference` provider trait |
| 021 | Per-round output tracking | K | `orch` status history and artifacts |
| 022 | No deterministic fallback | K | P9; `Refusal` |
| 023 | Dispatch circuit breaker and dedup | K | [05 §F](./05-subsystem-specs.md#f-queue-routing-and-the-mesh-process) F6, Q-05 |
| 024 | Bot container lifecycle via compose | S | package lifecycle (diagram 04) |
| 025 | Dynamic tool executor registry | K | tool registry; packages provide |
| 026 | Ticket interaction intent separation | K | `orch` ticket model |
| 027 | Cost rollup and task linking | K | `observe::Ledger` |
| 028 | Phase-8 architecture pre-round | K | [07 §L](./07-subsystem-specs-2.md#l-workflow-authoring-and-execution) L2 shape derivation |
| 029 | Windows desktop automation MCP | N | node capability |
| 030 | Home persona layer | P | assistant package on channel + bot rails |
| 031 | Phase-0 discovery and build approval gate | K | [07 §L](./07-subsystem-specs-2.md#l-workflow-authoring-and-execution) L5, F-04 |
| 032 | Process Lab trace runs | K | `observe` trace runs |
| 033 | Multi-harness execution framework | S | harness is a node (spec §4.6) |
| 033b | Swarm application manifests | K | `packages::Manifest` |
| 034 | Bidirectional config ownership sync | K | [05 §C](./05-subsystem-specs.md#c-settings-admin-user-package) settings scopes and precedence |
| 035 | Multi-tenant SaaS foundation | K | tenancy (spec §4.8); pooled vs siloed [06 §Axis 2](./06-deployment-postures.md#axis-2--tenancy-single-tenant--multi-tenant) |
| 036 | Bot owns the domain, surface is a view | K | P6; `sdk` |
| 037 | Communications swarm | P | channels rail in `api`; the bots are a package |
| 038 | Swarms bundled by type | K | `packages`: an app is a bundle |
| 039 | Bot-driven workflow authoring | K | [07 §L](./07-subsystem-specs-2.md#l-workflow-authoring-and-execution) L1, L7; producer rules [05 §K](./05-subsystem-specs.md#k-code-packing-and-the-producer-pipeline) |
| 040 | DevOps / Vault credential broker | K | `intents` privileged broker |
| 041 | Per-user storage targets | K | `ScopedFiles` |
| 042 | IoT / connector tenancy | K | [05 §G](./05-subsystem-specs.md#g-connector-framework) G7, X-06 |
| 043 | Presentation Studio | P | `ScopedStore`, artifact exchange |
| 044 | Mobile companion app | P/N | a surface and a node kind |
| 045 | Two-tier graph and connector | K | `store` optional graph trait; one key function |
| 046 | Token Chase checkpoint replay | K | [07 §M](./07-subsystem-specs-2.md#m-token-optimization-and-cost-efficiency) M1-M8 |
| 047 | Smart-home edge agent | N | `node` capability |
| 048 | Finance aggregation swarm | P | `intents` |
| 049 | oshal as an aggregation platform | G | informs G5 |
| 050 | Unified assistant route orchestrator | P | assistant package over channels, bots, brain records |
| 051 | Unreal Engine MCP worker | N | node capability |
| 052 | Stock-trading swarm | P | `intents`, `orch` |
| 053 | Trading decision workflow | P | workflow as data |
| 054 | Gravity model | P | none |
| 055 | Security Center | P | `observe` audit rail |
| 056 | Ticketed data-access broker | K | [05 §G](./05-subsystem-specs.md#g-connector-framework) G2, G3 |
| 057 | Personal data schema | K | [07 §P](./07-subsystem-specs-2.md#p-person-model-learning-and-history) P1, P8 |
| 058 | Personal-intelligence service | P | `ScopedStore`, `inference` |
| 059 | Travel concierge | P | `intents` |
| 060 | Per-user task storage isolation | K | T-01 |
| 061 | World-intelligence layer | P | shared-tenant store rail |
| 062 | Media concierge and partner-credential governance | P/K | domain is a package; credential governance is `intents` |
| 063 | AI Test Lab | K | `packages` sandbox test, verdict integrity, O-03 |
| 064 | Free-tier LLM token bank | K | `inference` policy; lever ordering [07 §M](./07-subsystem-specs-2.md#m-token-optimization-and-cost-efficiency) M7 |
| 065 | Connector runtime and declarative spec | K | [05 §G](./05-subsystem-specs.md#g-connector-framework) G1, X-01 |
| 066 | Personal knowledge graph | P | optional graph trait |
| 067 | Connector marketplace and lazy tool loading | K | [05 §E](./05-subsystem-specs.md#e-dynamic-loading-packages-bots-tools-capabilities) E3, L-04 |
| 068 | TV surfaces and device-link pairing | N/P | node pairing rail; surfaces are a package |
| 069 | Ops and SecOps connectors | P | `intents` |
| 070 | Multi-provider video generation | P | media-generation skill package |
| 071 | Character LoRA studio | P | none |
| 072 | World knowledge and alt-data signals | P | none |
| 073 | Vids operator scenario library | P | Test Lab catalog |
| 074 | Daily trade recap pipeline | P | activations |
| 075 | Little Monsters onboarding | P | none |
| 076 | Tenant-aware RLS and least-privilege role | K | T-02 |
| 077 | Self-developing platform, super-admin | K | S-03, S-04 |
| 078 | Kubernetes, Argo batch, multi-tenant proof | K | [06 §Axis 3](./06-deployment-postures.md#axis-3--packaging-and-provisioning); batch is a transport option |
| 079 | Haven user model and learning loop | K | [07 §P](./07-subsystem-specs-2.md#p-person-model-learning-and-history) P1-P8 |
| 080 | Creative Studio extend-story | P | none |
| 081 | Developer bot and idle CLI timeouts | K/S | developer bot is a producer (S-01); CLI timeouts superseded |
| 082 | Video series pipeline | P | activations, artifact exchange |
| 083 | Knowledge-owner call-out routing | K | [05 §F](./05-subsystem-specs.md#f-queue-routing-and-the-mesh-process) F2, Q-04 |
| 084 | Deterministic speaker diarization | K | [07 §O](./07-subsystem-specs-2.md#o-ambient-capture-listening-transcription-diarization) O4, E-03 |
| 085 | Every app is a hot-loadable package | K | `packages` |
| 087 | Access roles, Jarvis visibility scoping | K | grants and capability visibility |
| 089 | Skill-import adapter | K | [05 §K](./05-subsystem-specs.md#k-code-packing-and-the-producer-pipeline) K3, W-03 |
| 090 | GitHub Actions to local CI | G | kernel CI is local-first too |
| 090 | Skills as first-class packages | K | `packages` skills and the four axes |
| 091 | pgvector RAG engine | K | [05 §H](./05-subsystem-specs.md#h-knowledge-and-rag-framework) H3, H4 |
| 092 | Trading Strategy Lab | P | none |
| 093 | Packaged-app runtime placement | K | package hosts and posture |
| 094 | Kalshi prediction markets | P | `intents` |
| 095 | Strategy library | P | none |
| 096 | Shadow indicators | P | numeric kernels stay WASM |
| 097 | App suites | K | manifest field |
| 098 | Drone Ops app | P | node kinds |
| 099 | Drones are remote swarm nodes | N | `types::NodeKind` |
| 100 | Ambient person model | K | [07 §O](./07-subsystem-specs-2.md#o-ambient-capture-listening-transcription-diarization) + [§P](./07-subsystem-specs-2.md#p-person-model-learning-and-history) recall with receipts |
| 101 | Browser swarm (proposed) | N | browser worker nodes |
| 102 | Sat-Ops satellites as nodes | P/N | node kinds |
| 103 | AI Office one themed engine | P | none |
| 104 | Cost governance and kill switch | K | C-06, `observe::Ledger` |
| 105 | Connector write-actions tier | K | [05 §G](./05-subsystem-specs.md#g-connector-framework) G4, X-03 |
| 106 | Shared LLM-judge service | K | `inference` judge service |
| 107 | Run-trace read model | K | [07 §N](./07-subsystem-specs-2.md#n-tracing) N1-N7 |
| 108 | Office delivery adapters | P | artifact exchange targets |
| 109 | A2A gateway | K | [07 §R](./07-subsystem-specs-2.md#r-external-agents-and-a2a) R1-R7 |
| 110 | Jarvis media input | P/K | domain is a package; capture rules [07 §O](./07-subsystem-specs-2.md#o-ambient-capture-listening-transcription-diarization) |
| 111 | Spatial mapping | P | node capture kinds |
| 112 | Game shows as plugins | P | none |
| 113 | Switchboard and workspaces | P | surface rail |
| 114 | User-owned remote nodes | K | [07 §S](./07-subsystem-specs-2.md#s-node-network-overlay-and-enrollment) S1, S4, S8 |
| 115 | Clean trunk branch strategy | G | applies to the kernel repo (D1) |
| 116 | Futures extension layer | P | numeric kernel stays WASM |
| 117 | Local invited-user login | K | [05 §A](./05-subsystem-specs.md#a-identity-sso-and-oidc) A5; invitations [05 §B](./05-subsystem-specs.md#b-user-management) B4 |
| 118 | App access tiers | K | `types::Tier` |
| 119 | Autonomous health ticket processing | K | [05 §J](./05-subsystem-specs.md#j-monitoring-health-and-self-healing) J5, J6, H-04 |
| 120 | Joke-shorts pump | P | activations |
| 121 | Compile the numeric kernel, not the platform | K | numeric passes stay optional WASM; this series is the "new profile" its scope guard asks for |
| 122 | Model is an untrusted principal | K | P4 |
| 123 | Payroll app | P | none |
| 124 | RLS phase 2 table walling | K | T-02 |
| 125 | Operations stream pipeline | K | [05 §J](./05-subsystem-specs.md#j-monitoring-health-and-self-healing) alert to ticket path |
| 126 | Multi-provider OIDC login | K | [05 §A](./05-subsystem-specs.md#a-identity-sso-and-oidc) A3, A4 |
| 127 | Demo-mode CLI brain, per-user provider preference | S/K | CLI brain superseded; preference is a settings record ([05 §C](./05-subsystem-specs.md#c-settings-admin-user-package)) |
| 128 | Codex fleet default | K | fleet-default brain record (data) |
| 129 | Codeless Kubernetes install path | K | [06 §Axis 3](./06-deployment-postures.md#axis-3--packaging-and-provisioning) V-06 |
| 130 | codex-cli storyboard image provider | S | node-hosted capability if kept |
| 131 | Marketing engine package | P | none |
| 132 | Public-site analytics | G | out of scope |
| 133 | Outbound marketing connectors | P | `intents` |
| 134 | Multi-account trading books | P | none |
| 135 | Print-to-swarm and print-to-RAG | P/N | intake surface via a node |
| 136 | Trading surface IA and direct trades | P | none |
| 137 | Deploy modes | K | [06 posture matrix](./06-deployment-postures.md#posture-matrix) V-11 |
| 138 | Single-stock research and pinned lots | P | none |
| 139 | Artifact exchange registry | K | artifact exchange rail |
| 140 | Local device access broker | K/N | [07 §S](./07-subsystem-specs-2.md#s-node-network-overlay-and-enrollment) S6, Z-06 |
| 141 | Application groups | K | manifest kind |
| 142 | IPO event sleeve | P | none |
| 143 | Market-data stream | P/K | domain is a package; the rail is [05 §I](./05-subsystem-specs.md#i-time-series-framework) |
| 144 | Guest-seed contract | K | T-05 |
| 145 | App status contract | K | P-07 |
| 146 | Fantasy football | P | none |
| 147 | Multi-registry app loader | K | [05 §D](./05-subsystem-specs.md#d-application-management) D1, A-01 |
| 148 | Swarm root | K | C-08; roles vs tiers [05 §B](./05-subsystem-specs.md#b-user-management) B2 |
| 149 | Enterprise application authorization | K | grants |
| 150 | Scan-to-print reconstruction | P | none |
| 151 | Eyes and hands embodied swarm | P/N | peripheral node kinds |
| 152 | Embodied physics and training lab | P | none |
| 153 | Iterative CAD kernel | P | none |
| 154 | Circuit Lab | P | none |
| 155 | Drone relay chains | P/N | node transport |
| 156 | Animatronic props as a peripheral kind | P/N | node kinds |
| 157 | Scheduled services under an activated principal | K | T-04, `types::Activation` |
| 158 | Entra / local identity bridge | K | [05 §A](./05-subsystem-specs.md#a-identity-sso-and-oidc) A2, I-03 |
| 159 | Engine manages only what it can account for | P/K | trading rule; the principle reused for cost (B-12) |
| 160 | Vehicle record, medium as parameter | P | none |
| 161 | One bot invocation chokepoint | K | P1, B-01 |
| 162 | A bot's brain is layered records | K | B-02 |

Counts by class are generated from this table when it is finalized; do not type them here.

## Architecture documents

| Document | Class | Target |
|---|---|---|
| core-runtime-overview.md | K | spec §4 |
| OSHAL-agent-runtime-design-and-implementation-plan.md | K/S | superseded by this series; keep for the responsibility boundary history |
| end-to-end-runtime-architecture.md | K | diagram 05 |
| layer0-provider-framework.md | K | `inference` |
| layer1-tools-framework.md | K | tool registry, `sdk::Tool` |
| dynamic-bot-tool-runtime-plan.md | K | package lifecycle, tool loading |
| deployable-agent-contract.md | K/N | bot contract and node contract |
| kernel-vs-app-packages.md | K | P6; the one rule carries verbatim |
| connectors-and-graph-architecture.md | K | `intents`, `store` graph trait |
| connectors-tenant-isolation.md | K | connector ownership in `control` |
| data-model/ (generated) | K | `store`; schema docs stay generated |
| human-in-the-loop.md | K | `Ctx<Confirmed>`, activation |
| model-gateway.md | K | `inference` |
| edge-agent-architecture.md | K/N | [07 §S](./07-subsystem-specs-2.md#s-node-network-overlay-and-enrollment) |
| deployment-runtime-topology.md | K | diagram 08 and [06](./06-deployment-postures.md) |
| devops-cockpit-connectivity.md | K | `deploy` |
| native-compiled-kernel.md | K | numeric WASM kernels, unchanged |
| admin-console.md | K | surfaces for grants, registries, activations |
| operating-fluency-spec.md | G | operator documentation standard |
| platform-shared-services.md | K | budgets, write actions, search, judge, notifications, export, DLQ, node auth, tracing: each maps to a crate above and to a section of [05](./05-subsystem-specs.md) |
| global-search-deep-link-contract.md | K | surface contract; search is `store` + package-declared sources |
| chat-agent-profile-runtime-architecture.md | K | [07 §Q](./07-subsystem-specs-2.md#q-bot-composition-extends-family-b) prompt assembly frame |
| jarvis-architecture-and-flow.md, jarvis-native-background-wake.md | P | assistant package |
| alert-triage-and-consolidation-spec.md | K | [05 §J](./05-subsystem-specs.md#j-monitoring-health-and-self-healing) triage and deduplication |
| complex-ticket-* (three documents) | K | [07 §L](./07-subsystem-specs-2.md#l-workflow-authoring-and-execution) worked examples |
| little-monsters-on-oshal-plan.md | P | none |
| linkedin-content-swarm-workflow.md | P | none |
| drone-relay-*, embodied-*, animatronic-prop-hardware.md | P/N | node kinds |
| facebook-bot-credential-management.md | K | `intents` credential governance |
| knowledge-owner-routing-config-checklist.md | K | routing declarations |
| multi-week-build-readiness-plan.md | G | history |
| 078-argo-batch-proveout-status.md | K | `deploy` |

## How an import is performed

1. Read the source document's Decision section.
2. For class K: find the object in [02](./02-rust-object-model.md) that carries the rule. If none does,
   either the rule is missing from the spec (add it, with a requirement and a guard) or the decision is
   actually a domain (reclass to P).
3. For class P or N: confirm the kernel rail the target names exists in the spec. The domain content is
   not imported.
4. For class S: add a status line to the source ADR naming the superseding section. Do not delete it.
5. Record the import in this table's target column with the section or type name, not a paraphrase.
