# OSHAL Docs

The front door for `docs/`. The layout rule is simple:

- **Top level** holds only the canonical guides and identity docs — the files everything else
  links to.
- **Every other document lives in a topic folder**, and every topic folder has a `README.md`
  index. If you don't know where something is, start with the directory map below.

## Start here

New to OSHAL, or building on it:

1. [WHY_OSHAL.md](./WHY_OSHAL.md) — the case for OSHAL, with measured cost data.
2. [the-stem-cell-model.md](./the-stem-cell-model.md) — what OSHAL actually is, conceptually.
3. [framework-developer-guide.md](./framework-developer-guide.md) — canonical builder guide:
   apps, tools, agents, workflows, UI, OIDC, clusters, AnyBot, remote client, and limitations.
4. [build-your-own-swarm-app.md](./build-your-own-swarm-app.md) — 10-minute tutorial: the
   smallest one-bot manifest app, plus the "compiles-but-fails" checklist for data apps.
5. [../ROADMAP.md](../ROADMAP.md) — what ships today vs where OSHAL is going.

Deeper identity material: [OSHAL-WHITEPAPER.md](./OSHAL-WHITEPAPER.md)
and [reference.md](./reference.md) (the OSHAL reference).

**Something broken or missing?** Use [Requests and defects](./operations/requests-and-defects.md)
for the GitHub-backed application/core queues and lifecycle policy. [runbooks/](./runbooks/README.md)
has the operator recovery procedures. The two
highest-frequency fixes: stack half-up after a Docker engine restart → `bash scripts/oshal-up.sh`;
`localhost` URLs hang while `127.0.0.1` works → the `wslrelay` wedge, diagnosed in
[runbooks/localhost-wedge-wslrelay.md](./runbooks/localhost-wedge-wslrelay.md).

## Building on OSHAL — the guides

| Guide | Use it when |
| --- | --- |
| [framework-developer-guide.md](./framework-developer-guide.md) | Any framework-level work — the canonical guide. |
| [build-your-own-swarm-app.md](./build-your-own-swarm-app.md) | First app; smallest end-to-end manifest. |
| [addon-developer-guide.md](./addon-developer-guide.md) | Building an app from addons (tool, bot, workflow, surface, connector); what's hot YAML vs code+rebuild. |
| [swarm-apps-framework.md](./swarm-apps-framework.md) | The manifest contract for shipping a complete app from YAML. |
| [building-a-bot.md](./building-a-bot.md) | Adding a bot the right way (dedicated node vs concierge; both registries; BYOK). |
| [workflow-studio.md](./workflow-studio.md) | Talk-to-build workflow authoring. |
| [connector-spec.md](./connector-spec.md) | Declaring a connector instead of hand-writing one. |
| [connector-backed-apps.md](./connector-backed-apps.md) | The recipe for connector-backed apps. |
| [partner-app-registration.md](./partner-app-registration.md) | Registering OAuth/partner apps (Google, Meta, …) — one repeatable pattern. |
| [test-lab.md](./test-lab.md) | The AI Test Lab (ADR-063). |
| [deployment-models.md](./deployment-models.md) | How OSHAL deploys (local, hosted, hybrid). |

## Directory map

| Folder | What's in it |
| --- | --- |
| [adr/](./adr/README.md) | Architecture Decision Records — the canonical decision log. |
| [architecture/](./architecture/README.md) | Control plane, runtime, tools, swarm design, delivery/agent contracts, model gateway, connector + graph architecture. |
| [apps/](./apps/README.md) | Per-app docs: [trading](./apps/trading/README.md), [kalshi](./apps/kalshi/README.md), LinkedIn assistant, Unreal MCP worker, Spaces (?app=spaces, ADR-111 — video→3D reconstruction), native-migration plans. |
| [assets/](./assets/README.md) | Packaging and collateral assets, including the OSHAL one-pager, benchmark brief, demo script, sales deck, and messaging kit. |
| [backlog/](./backlog/README.md) | Per-area open-work backlogs. The cross-cutting backlog is [BACKLOG.md](./BACKLOG.md). |
| [business/](./business/README.md) | GTM, competitive landscape, capabilities brief, pitch packs. |
| [channels/](./channels/README.md) | Chat-channel surfaces such as Telegram and Twilio, mounted as views over accountable bots. |
| [connectors/](./connectors/README.md) | Per-connector notes + connector runbook. |
| [creative-studio/](./creative-studio/README.md) | Google Vids remote-node pipeline notes for episode writing, rendering, validation, and delivery. |
| [delivery/](./delivery/README.md) | How a client engagement is run — the seven-step method, its artifact set, and the four `delivery-*` bots that replicate it. |
| [enterprise/](./enterprise/README.md) | Permission-aware RAG, procurement security packet, SCIM bridge. |
| evidence/ | Generated competitive-scoreboard evidence (nightly refresh — don't hand-edit generated reports). |
| [governance/](./governance/README.md) | RLS/RBAC policies, provisioning SQL, RLS runbook. |
| intelligent-career-automation/ | Apply-agent specs and application-form playbook. |
| [k8/](./k8/README.md) | Kubernetes setup docs and handover (the manifests themselves live in `ops/any-bot-k8s/`). |
| [legal/](./legal/README.md) | Licensing, attribution, trademark, and inbound contribution terms — what AGPL-3.0 actually grants and requires, and the commercial exception. |
| [little-monsters](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/little-monsters) | Little Monsters K-12 study app — carved out to the oshal-applications store (ADR-085): install, user guide, runbook, support, school deployment live in the package. |
| [operations/](./operations/README.md) | Support / SLA / incident posture. |
| release/ | Go-public: publish SOP, credential rotation, history scrub, prune list. |
| [research/](./research/README.md) | Research notes (A2A vs mesh, node pools, product architecture). |
| [runbooks/](./runbooks/README.md) | Operator runbooks — recovery procedures and feature bring-up. |
| [saas/](./saas/README.md) | Public self-serve foundation. |
| [security/](./security/README.md) | Security posture, hardening guide, control evidence. |
| [setup/](./setup/README.md) | Local setup and operator guides for specific bots and runtime surfaces. |
| [test-lab-reports/](./test-lab-reports/README.md) | Canonical Test Lab outputs (`latest.md` + `baseline.json`). |
| [tv-surfaces/](./tv-surfaces/README.md) | Roku / Samsung TV app registration. |
| [workflows/](./workflows/README.md) | Tool approval / management / verification workflows. |
| archive/ | The graveyard: superseded handovers, closed-phase plans, historical snapshots. Kept on purpose; dropped from the public snapshot. |

**Outside `docs/` but documented on its own:** [`native/`](../native/README.md) — the compiled-kernel
track (Rust → WASM port of the ADR-116 indicator layer), with its own README / ARCHITECTURE /
BENCHMARKS / ROADMAP. Kept beside its code rather than here because the docs and the crate change
together. ⚠ Not to be confused with the `*-native-migration-plan.md` files in [apps/](./apps/README.md):
"native" there means *a native OSHAL surface* (folding a standalone app into the platform), which is
unrelated to native compiled code.

## Planning & status

- [BACKLOG.md](./BACKLOG.md) — deferred engineering work; every entry has done-when criteria.
- [../ROADMAP.md](../ROADMAP.md) — today vs target, per capability.
- [adr/README.md](./adr/README.md) — decisions and their status.

## The docs standard

- Docs describe what works **today**. Vision goes to [../ROADMAP.md](../ROADMAP.md); deferred
  work goes to [BACKLOG.md](./BACKLOG.md) with done-when criteria — not into feature docs
  written as if shipped.
- Every important runtime surface gets a docs entry point; every tool-backed agent gets a setup
  guide under [setup/](./setup/README.md), attachable to the agent via `configGuide` /
  `config_guide`. Operators should never need old chat history to configure a bot.
- New documents go **into a topic folder**, not the docs/ top level. Add them to that folder's
  `README.md`. The top level is reserved for the canonical guides above.
- Point-in-time snapshots (dated scorecards, closed-phase plans, superseded handovers) move to
  archive/ — see the
  prune list for the review process.
