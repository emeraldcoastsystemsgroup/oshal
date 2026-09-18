# Clean kernel — high-level technical and functional specification (Phase 0)

**Status:** DRAFT for operator review, 2026-09-17. Language-neutral. Nothing here is decided until an
ADR says so.
**Companion to:** [ADR-121](../../adr/121-native-compiled-kernel.md) (compile the numeric kernel, not
the platform). This document does not reopen that decision. It answers a different question: *if oshal
were designed again from what this project has learned, what should it be?* The language question
(Rust, TypeScript, or refactor in place) is answered **after** this spec, against it, not before.
**Scope:** what the system must be and do. Not how to migrate to it, not a timeline.
**Why at all:** the problems this is meant to fix, with measured evidence and a scoreboard, are in
[10 — What we are actually improving](./10-what-we-are-improving.md). Read that first.

How to read it: §1 goals, §2 principles, §3 the keep / copy / re-architect / drop triage of today's
platform, §4 the target architecture, §5 functional requirements with acceptance criteria, §6
non-functional requirements, §7 what this leaves open, §8 next steps, §9 the measurements behind §3.

---

## 1. Goals

The operator's goal list, made testable. Every later requirement traces to one of these.

| # | Goal | Testable meaning |
|---|---|---|
| G1 | **Local-first and policed** | Runs on one machine with nothing else installed. Every action is admitted by a policy decision and recorded with who, for whom, at what cost. |
| G2 | **Plug and play** | A package, tool, bot or surface installs, activates, hot-loads, upgrades and unloads without a kernel restart or a kernel code change. |
| G3 | **Self-writing** | The platform can author, test, package and install its own extensions through the same gates a human uses. It can never go around them, and it never edits its own kernel at runtime. |
| G4 | **Multi-user, multi-tenant** | Person and tenant isolation is enforced in the data layer and in the type system. No isolation property depends on a query being written correctly. |
| G5 | **Simple, therefore flexible** | Few kernel objects, one admission path, one package contract. Flexibility comes from composing packages, not from kernel options. |
| G6 | **Any bot** | Any inference provider, any harness posture, any transport, behind one bot contract. A bot is an untrusted principal. |
| G7 | **Swarm-native** | Tickets, envelopes, accountable identities, cost and traces are kernel objects. Local, remote and external agents join through the same contract. |
| G8 | **Secure by construction** | Authentication, authorization, tenancy, write confirmation, secrets, audit and cost live in one control layer that the build makes unavoidable. |
| G9 | **Portable** | One artifact. Declared deployment modes. Embedded stores for single-node, external stores for a fleet. |
| G10 | **Honest** | Every claim the system makes about itself (status, tests, inventories, cost) is generated from state, never typed. |

---

## 2. Principles

Each principle names the ADR that already established it, where one exists. A clean design keeps the
decision and changes only how it is enforced.

| # | Principle | Today's basis |
|---|---|---|
| P1 | **One door.** Every entry (HTTP, stream message, schedule tick, package call, CLI, channel) passes through one admission function and comes out as a context or a refusal. Nothing else can construct a context. | ADR-161 generalized |
| P2 | **Deny by default, enforced by the type system.** A handler that has no context cannot reach a store, a provider, an intent or a file. Auth is not a middleware you remember. | inverts today's opt-in `requiresAuth` |
| P3 | **Identity is a value derived once at the edge.** Every scoped resource (store, inference, intents, files) is derived from that value. It is never re-read from a request or a session mid-flight. | fixes the multipart and `iss` incidents |
| P4 | **The model is an untrusted principal.** No security property depends on the model choosing correctly. Personas are data, not controls. | ADR-122 |
| P5 | **Credentials are references.** A handler, a bot and a package hold an opaque secret reference. Only the intent boundary can resolve it, and it never returns the value. | ADR-036, ADR-056, ADR-105 |
| P6 | **The kernel owns objects; packages own domains.** The kernel never learns an app's schema. An app never declares or removes a kernel component. | ADR-036, ADR-085, ADR-145, kernel-vs-app doc |
| P7 | **Dependencies are acyclic and enforced by the build.** Layering by lint or convention is not layering. | replaces FSD-by-convention |
| P8 | **Every mutation is accountable.** Principal, tenant, cost, trace span and audit event are emitted by the door, not by handlers. | ADR-027, ADR-104, ADR-107 |
| P9 | **Fail closed, refuse loudly, never fall back silently.** | ADR-022, publish gate, harness posture |
| P10 | **Nothing runs by declaration alone.** A declared schedule, bot or capability is an offer. A person activates it under a named principal. | ADR-157 |
| P11 | **Hermetic by construction.** Tests, package sandboxes and single-node mode run against ephemeral embedded stores. Reaching a live store is an explicit, named opt-in. | fixes the live-DB spec incidents |
| P12 | **Generated truth.** Schema docs, counts, status, route and auth inventories are produced from the running system or the tree, never typed into prose. | CLAUDE.md anti-drift rules |

---

## 3. Triage: keep, copy, re-architect, drop

**Keep** = the semantics are right; re-express them. **Copy** = the idea is right, the mechanism is not.
**Re-architect** = the mechanism is the source of recurring defects. **Drop** = do not carry forward.
Evidence for each verdict is in §9.

### 3.1 Keep

| Subsystem | What is kept | Governing decision |
|---|---|---|
| Ticket → envelope → accountable bot lifecycle, with per-call cost in the ledger | the whole model | ADR-018, ADR-021, ADR-027 |
| Deterministic data access separated from reasoning; schema-bounded provider intents; the broker as the only credential holder | the whole boundary | ADR-036, ADR-056, ADR-105 |
| Model as untrusted principal; one invocation chokepoint; budgets and kill switch | the whole posture | ADR-122, ADR-161, ADR-104 |
| Package model: manifest, suite, `uses:` skills, dependencies, groups, readiness and status contracts, trusted registries as rows | the contract | ADR-085, ADR-090, ADR-097, ADR-141, ADR-145, ADR-147 |
| Layered brain records; app access tiers; swarm root as a database invariant; scheduled services under an activated principal | the semantics | ADR-162, ADR-118, ADR-148, ADR-157 |
| Tenancy: keys derived only from subject and tenant; row-level security; least-privilege governed database role | the semantics | ADR-035, ADR-076, ADR-124 |
| Deploy modes as named postures; default-off external gateways; user-owned remote nodes with proven ownership | the semantics | ADR-137, ADR-109, ADR-114 |
| Test Lab as a product feature; run-trace read model assembled from real rows; fail-closed publish gate | the semantics | ADR-063, ADR-107 |
| Optional-by-construction compiled kernels for numeric passes | the mechanism | ADR-121 |

### 3.2 Copy the idea, replace the mechanism

| Today | Keep the idea | New mechanism |
|---|---|---|
| Route-auth inventory specs police which routes carry `requiresAuth` | "every route is classified" | classification is the door's type signature; the inventory is generated, not policed |
| Feature-Sliced Design layers `app → pages → features → entities → shared` by lint | layered import direction | build-enforced dependency graph (crates or separately versioned packages); a cycle does not compile |
| Workflow Studio publish compiles a canvas to a manifest the runtime loads | compile-to-runtime; the runtime stays the authority | same, with the manifest as the only compile target |
| Packer and skill-import emit persona + manifest for operator review | producers emit **packages** | all self-writing producers emit a package into a registry; none emit code into the kernel |
| The 124 kernel modules packages import today | this is the de facto SDK | each module is promoted into the versioned SDK or moved into a package; the list is the seed inventory |
| Cockpit shell contract: `?app=` is the single source of truth | the URL contract | keep the contract; the client is rebuilt against the new API |
| Compose service labels drive monitoring discovery | inherit, do not register | same idea, from the package manifest instead of container labels |
| `HarnessType` inventory (`cline`, `codex-cli`, `claude-code`, `gemini-cli`, `a2a`, `noop`) typed into the kernel with per-harness spawn adapters | a typed inventory of harness kinds | the inventory moves to the **node adapter**; the kernel knows a node's declared harness kind as data and never has a per-harness code path (§4.6) |
| Remote node rails: device-bound tokens, proven ownership, task journal, completion callback; the Codex remote-node and edge-agent scripts | a user-owned machine executes on the swarm's behalf | promoted from a side rail to **the** way a harness joins: every harness is a node |

### 3.3 Re-architect

| Today's mechanism | Recurring defect it produced | Replacement |
|---|---|---|
| Auth is opt-in per route | 88 of 257 route files reference the guard; three inventory specs exist only to catch the rest | P1 + P2: one door, deny by default |
| Row-level-security identity threaded by hand in 113 files | multipart uploads lost identity; session user lacked `iss`; the governed role re-converges every boot | P3: `ScopedStore` derived from the context; no raw connection is reachable from a handler |
| Packages compiled against the kernel's path aliases and loaded in-process | 924 package files import 124 kernel internals at roughly 1,500 sites, including route modules used as libraries | versioned SDK + sandboxed host (§4.5); capabilities are the imports granted |
| `src/app` holds domain code (123 top-level files, 44 of them trading) and 46K lines of routes | the kernel API is accidental; the app layer is the largest layer | the kernel has no domain code; every domain becomes a package (§4.3 object model is the whole kernel) |
| Two server codebases (TypeScript core + legacy JavaScript execution layer) | bridging code, duplicated provider logic, two test styles | one codebase, one runtime per process |
| Logging in 753 files, cost recording in 23, schema validation in 66, rate limiting in 3 | cross-cutting behavior depends on each author remembering | the door emits span, audit and cost; handlers declare a request schema and get a validated value |
| Four mandatory backing stores (relational, stream, vector, graph) plus a compose stack of bind mounts | not installable; boot-order faults; deploy parity drift | store traits with embedded single-node implementations; vector and graph become optional package-provided capabilities |
| Test harness where specs can reach the live database by default | synthetic `mode='live'` rows written twice in one day | P11: hermetic default; live requires a named fixture and an explicit flag |

### 3.4 Drop

- **Kernel-side harness spawning**: the api or bot-node process launching Claude Code, Codex CLI,
  Gemini CLI or Cline as a subprocess. It is already fail-closed; do not carry the code. This drops the
  *spawn path*, not bring-your-own harness, which is kept as a node posture (§4.6).
- The legacy execution layer as a separate codebase.
- `?profile=` and every retired identifier or tag name.
- Any assumption that a persona guardrail is a security control.
- Route modules as import targets for packages.

---

## 4. Target architecture

### 4.1 Five planes

| Plane | Owns | Never does |
|---|---|---|
| **Control** | the door, identity, tenancy, grants, budgets, secrets references, audit, trace | domain logic, I/O to external systems |
| **Orchestration** | tickets, queues, envelopes, workflows, schedules and activations | reasoning, credential handling |
| **Execution** | bots (inline, node, remote, external), providers, intents, tools | direct store access outside a context |
| **Data** | store traits: relational, stream, blob, and optional vector and graph | policy decisions |
| **Surface** | cockpit shell, package surfaces, API, CLI, channels | business logic; a surface is a view over a bot-owned store (ADR-036) |

### 4.2 The one door

```
admit(entry) -> Ctx | Refusal

entry kinds : http | stream-message | schedule-tick | package-call | cli | channel
Ctx carries : Principal, Tenant, Grants, Budget, TraceSpan, Mode(read | write | confirmed)
derived only from Ctx : ScopedStore, ScopedInference, ScopedIntents, ScopedFiles, ScopedNotify
```

- There is no second constructor for `Ctx` and no unscoped store, provider or intent handle anywhere
  outside the control plane.
- `Mode(write)` cannot be obtained without a grant at `editor` or above (ADR-118).
  `Mode(confirmed)` cannot be obtained without the explicit write confirmation (ADR-105).
- The door emits exactly one trace span, one audit event and, when inference or an intent runs, the
  cost events. Handlers emit nothing cross-cutting.
- A refusal is a typed value with a reason code. It is never a silent fallback (P9).

### 4.3 Kernel object model

This is the whole kernel. Anything not on this list is a package.

| Object | Owner / tenant | Constructed by | Notes |
|---|---|---|---|
| **Principal** | itself | the door | kinds: person, service, bot, root. Root is a database invariant (ADR-148). |
| **Tenant** | root or admin | control | every keyed store name derives from (subject, tenant) and nothing else |
| **Grant** | tenant admin or app admin | control | one of `deny / viewer / editor / admin` per (principal, package); explicit deny wins (ADR-118, ADR-149) |
| **Package** | registry + installer | loader | manifest, capabilities, surfaces, schedules, migrations in its own namespace |
| **Capability** | kernel | loader | a named host function a package may import; granted per package, activated per person |
| **Bot** | package or kernel | registry | identity + layered brain records + posture (`inline / node / remote / external`) + capabilities |
| **Provider** | kernel | provider registry | hosted, bring-your-own, or local endpoint; one trait |
| **Intent** | package or kernel | intent registry | a schema-bounded deterministic operation over a connector; the only place a `SecretRef` resolves |
| **Connector** | person | control | a `SecretRef` plus the intents it authorizes; the value never leaves the intent boundary |
| **Tool** | package | tool registry | a deterministic function exposed to a bot; never a credential carrier |
| **Ticket** | person or activation | orchestration | type, workflow, phases, status history, artifacts |
| **Envelope** | orchestration | dispatcher | one phase of one ticket addressed to one accountable bot over one transport |
| **Workflow** | package or studio | manifest compile | declared stages or a compiled node graph; the runtime is the authority |
| **Activation** | person | control | binds a declared schedule or service to a named principal (ADR-157) |
| **Node** | person | enrollment | local or remote (device-bound token, proven ownership, ADR-114), external (A2A, default-off, ADR-109). A bring-your-own harness is a node; its harness kind is data on the node record (§4.6) |
| **Surface** | package | loader | static assets served under the shell; a view, never an authority |
| **CostEvent / TraceSpan / AuditEvent** | the door | the door | one ledger; budgets, cockpit totals and traces read the same rows (ADR-104, ADR-107) |

### 4.4 Dependency structure

```
kernel-types      (objects only; zero I/O, zero external dependencies)
   ▲
control           (the door, policy, identity, tenancy, budgets, audit)
   ▲            ▲
store   mesh   inference   intents      (each depends on kernel-types + control only)
   ▲            ▲
orchestration     (tickets, envelopes, workflows, activations)
   ▲
packages          (manifest, loader, capability grants, hosts)
   ▲
api / cli / channels / surfaces        (entry adapters; they call admit() and nothing else directly)

sdk               (what a package compiles against; versioned; depends on kernel-types only)
```

Rules:

1. An edge points upward only. The build rejects a cycle.
2. `api` cannot import `store`. It receives a `Ctx` and asks it for a `ScopedStore`.
3. Packages see the `sdk` and nothing else. The SDK is semver-versioned and the loader refuses a
   package whose declared SDK range the kernel does not satisfy.
4. `kernel-types` never grows an I/O dependency. A pull request that adds one fails the build.

### 4.5 Package contract

The manifest stays what it is today (ADR-085 shape, suite, `uses:`, dependencies, readiness, status,
groups). The **code** contract becomes an interface definition, not a set of import paths.

| A package provides | A package receives (only if declared and granted) |
|---|---|
| routes with request schemas | `ScopedStore` in its own schema namespace |
| bots (identity, persona data, posture, default brain) | `ScopedInference` (cost-attributed to the bot) |
| tools and intents (schema-bounded) | `ScopedIntents` for connectors the person has authorized |
| schedules (offers, activated per ADR-157) | `ScopedFiles`, `ScopedNotify` |
| migrations for its own namespace | other packages' declared exports, through dependencies only |
| surfaces (static) and a status route | events from the mesh it subscribed to |

Lifecycle, with no kernel restart at any step:

```
install → validate (manifest, SDK range, capabilities) → sandbox test → grant → load → activate
        → upgrade (new version loads, old drains) → deactivate → unload
```

Hosts. The interface is language-neutral. Two hosts satisfy it: an in-process sandbox for packages
compiled to a portable component format, and an out-of-process host for runtimes that cannot be
sandboxed in-process (JavaScript, Python engines). Both speak the same interface. A capability a
package did not declare is not linked, so it cannot be called.

### 4.6 Bot model ("any bot")

- A bot is identity + brain + posture + capabilities. Posture is one of `inline` (reasons over already
  authorized data inside the api process), `node` (dedicated process, own store, long work), `remote`
  (user-owned node), `external` (A2A).
- One invocation chokepoint (ADR-161). Transport is a separate question from admission.
- Providers sit behind one trait. Hosted, bring-your-own, and local endpoints are the same to a caller.
  A caller-authorized bring-your-own connection is ephemeral and never rewrites a default (ADR-162).
- Prompt assembly is a kernel service. Personas are data. Nothing the model emits is executed without
  passing the door again as the bot's own principal (P4).
- The model never receives a credential, a raw connector payload, or a store connection. Intents return
  normalized, redacted results (ADR-036).

**Bring your own harness: a harness is a node, not a subprocess.** Three shapes, one contract:

| Shape | What the person brings | How it joins | What the kernel holds |
|---|---|---|---|
| **BYO inference** | an API key or OAuth to a hosted or local endpoint (OpenAI, Anthropic, Ollama, LM Studio, LiteLLM, ...) | the provider trait; the ephemeral `byoLlmConnection` rule (ADR-162) | a `SecretRef`; cost is **metered** by the kernel |
| **BYO harness node** | an agent runtime on a machine they own (Claude Code, Codex CLI, Gemini CLI, Cline, OpenHands, their own) | enrolls as a node with a device-bound token and proven ownership (ADR-114); binds to bot identities the owner holds; claims envelopes addressed to those bots; runs the harness locally with the person's own credentials; returns artifacts | a node record and a bot principal; **no credential, no process**; cost is **reported**, not metered |
| **BYO external agent** | an agent that is not oshal-aware | the A2A gateway, default-off, per-agent scoped credentials (ADR-109) | an agent card and scoped credential |

Properties the node shape must satisfy, which are what today's fail-closed rule was waiting for:

- **Local is not special.** A harness on the same machine as the kernel is still a node: same
  enrollment, same token, same door. There is no kernel spawn path, so there is nothing to bypass.
- **Immutable request-start generation.** The node adapter pins the harness's tool and handler
  configuration when it claims an envelope and reports that generation; a change mid-run fails the run.
- **Exact operation scopes travel in the envelope.** Connector access happens by the node asking the
  kernel for an intent result under the bot's principal; the token never leaves the intent boundary.
  An envelope carries the capabilities granted for that phase and nothing else.
- **Results are untrusted input.** Everything the harness returns passes the door as the bot's own
  principal (P4). A harness can propose a write; only a confirmed context performs it.
- **Reported cost is labelled.** Budgets enforce only what the kernel meters. A BYO harness node runs
  on the person's own spend; the adapter's token report is recorded as `reported`, never summed as
  `metered` (ADR-159 applied to money).
- **The workspace belongs to the task, not the node.** The kernel owns a versioned workspace per ticket;
  a node holds a materialized copy of the subtree it claimed and commits back under that claim, so bots
  on different harnesses collaborate on one task without ever sharing a directory or an index. Specified
  in [08 — The task workspace](./08-workspace-and-assistant.md); there is no shared mount.

### 4.7 Swarm integration

```
ticket → workflow (declared or compiled) → phase → envelope → accountable bot → artifacts + cost + trace
```

- The envelope is the unit. Local delivery is an in-process stream; node delivery is a durable stream
  with consumer groups; remote delivery rides the device-bound token; external delivery is A2A. Same
  envelope, four transports.
- Every phase transition is a status-history row; the trace is assembled from those rows, never
  fabricated (ADR-107).
- Dispatch reads the workflow from the manifest registry. A ticket type with no loaded workflow waits;
  it is never guessed (today's startup-race guard, made a rule).
- Budgets are checked before dispatch and before every interactive invocation, from the same ledger the
  cockpit displays (ADR-104).

### 4.8 Multi-user, multi-tenant

- `Principal → Tenant → Grant` is resolved at the door. Every keyed name in every store derives from
  (subject, tenant) through one function (today's graph-keys rule, applied to all stores).
- Relational isolation is row-level security under a least-privilege governed role. The role's grants
  are converged from one declared contract at boot (ADR-076, ADR-124).
- Vector, graph and blob stores derive their namespace from the same key function; a package gets its
  own namespace inside the person's or tenant's.
- Enterprise authorization (ADR-149) and app access tiers (ADR-118) are the only grant vocabulary.
  Guest access is a seeded principal with a declared capability matrix (ADR-144), not a special path.
- Scheduled and service work runs under an activated principal of one of two classes: a person, or a
  system service a portal admin activated (ADR-157).

### 4.9 Self-writing loop

- Producers (packer, skill import, studio publish, developer bot, capability loop) emit **packages**
  into a registry the admin trusts (ADR-147). They never emit code into the kernel.
- Every produced package passes the same gate as a human-authored one: validate → sandbox test →
  operator review (`inactive` until activated) → grant → activate.
- Kernel changes still land through pull request and the publish gate. The platform proposes; it does
  not merge into itself. Super-admin is a distinct, double-gated role (ADR-077).
- The test catalog a package declares is executed in the sandbox with verdict integrity: a zero-test
  run is not a pass, a declined run is not a pass, a truncated log cannot flip a verdict.

### 4.10 Observability and honesty

- One span per admitted entry, carrying principal, tenant, package, duration, outcome and cost.
- One cost ledger. Budgets, traces and cockpit totals read it. Nothing else counts money.
- Every package reports through its declared status route; the kernel renders and never learns the
  schema (ADR-145).
- Inventories are generated from the running system: routes and their admission class, packages and
  versions, bots and postures, capabilities granted, tests registered. A number typed in a document
  is a defect.

### 4.11 Deployment modes and portability

The four axes behind this table (people, tenancy, packaging, change delivery) are specified in
[06 — Deployment postures](./06-deployment-postures.md). The governing rule there: a posture selects a
trait implementation, never a branch in kernel logic, so single-user is multi-user with one row.

| Mode (ADR-137) | Stores | Auth | Packages |
|---|---|---|---|
| `demo` | embedded relational, in-process stream, local embeddings | open on loopback | hot-load |
| `home` | embedded or external | invited users, device-bound tokens | hot-load |
| `team` / `enterprise` | external relational and stream; optional vector and graph | OIDC, multi-provider (ADR-126) | hot-load, registry-gated |

- One artifact. The cockpit shell ships inside it. Migrations for the kernel ship inside it and run on
  start; package migrations run at package activation in the package's namespace.
- Startup is order-independent: a store that is not yet reachable is a health state, never a crash.
- Upgrade is an artifact swap plus embedded migrations. Rollback is the previous artifact; migrations
  that cannot roll back are refused at review time.

---

## 5. Functional requirements

`MUST` is a release gate. `SHOULD` is a design target that needs an ADR to drop. Each requirement has
an acceptance criterion a test can assert.

This section covers the kernel families C, P, B, T, S, O and D. Eleven subsystems carry their own
decisions and requirement families in [05 — Subsystem specifications](./05-subsystem-specs.md):
identity and SSO (I), user management (U), settings (N), application management (A), dynamic loading
(L), queue and mesh (Q), connectors (X), knowledge and RAG (R), time series (M), monitoring and
self-healing (H), packing and producers (W). Eight more carry theirs in [07 — Subsystem specifications, part 2](./07-subsystem-specs-2.md): workflow (F), token optimization (K), tracing (G), ambient capture (E), person model and learning (J), external agents (Y), node network (Z), and bot composition (B-13 onward). The task workspace, the any-harness collaboration contract and the assistant rails are in [08](./08-workspace-and-assistant.md), families WS, HA and AS. A systematic audit of the whole ADR corpus added 79 further requirements across these families, listed in [09 — Amendments from the ADR sweep](./09-adr-sweep-amendments.md). Deployment choices — single or multi user, single or
multi tenant, container or Kubernetes, hot-load or blue-green — are an orthogonal axis with family V
in [06 — Deployment postures](./06-deployment-postures.md).

### 5.1 Control (C)

| ID | Requirement | Acceptance |
|---|---|---|
| C-01 | Every entry kind MUST pass through `admit()`; no route, consumer, tick or host call runs without a `Ctx`. | a generated inventory shows zero entries outside the door; a negative build test proves a handler without `Ctx` does not compile or link |
| C-02 | `Ctx` MUST be the only source of scoped store, inference, intent, file and notify handles. | grep-level and build-level guard: no unscoped constructor is public outside control |
| C-03 | Write access MUST require a grant at `editor` or above; confirmed writes MUST require the explicit confirmation token. | refusal cases for viewer, missing grant, missing confirmation |
| C-04 | Identity MUST be derived once per entry from verified claims including issuer; later code MUST NOT re-derive it. | multipart, streaming and channel entries carry the same identity as JSON entries |
| C-05 | A `SecretRef` MUST NOT be serializable or loggable; only the intent boundary MAY resolve it. | a build test proves `SecretRef` has no serialize implementation; a redaction test on every log sink |
| C-06 | Budgets MUST be checked before dispatch and before every interactive invocation, from the single ledger. | over-budget refusal at both chokepoints; ledger totals equal cockpit totals |
| C-07 | Every refusal MUST carry a reason code and be recorded; no silent fallback path exists. | refusal audit rows exist for each reason code exercised in tests |
| C-08 | Root MUST be a database invariant, at most one, not owner-scoped. | a concurrent second root claim fails as a constraint violation |

### 5.2 Packages (P)

| ID | Requirement | Acceptance |
|---|---|---|
| P-01 | A package MUST declare everything it provides and every capability it needs in its manifest; an undeclared capability is not linked. | calling an undeclared capability fails at load, not at runtime |
| P-02 | Install, upgrade, deactivate and unload MUST complete without a kernel restart. | a lifecycle test on the running kernel |
| P-03 | A package MUST compile only against the versioned SDK; kernel internals are not reachable. | the package build has no path into kernel modules; SDK range mismatch is refused at load |
| P-04 | Package migrations MUST run in the package's own namespace at activation and MUST be reviewed for rollback. | activation with a failing migration leaves the package inactive and the namespace unchanged |
| P-05 | A package's sandbox tests MUST run before activation with verdict integrity (no vacuous pass). | zero tests → not a pass; declined → `pending`; truncated evidence → `pending` |
| P-06 | Groups MUST carry no code; a group with code fails the load. | ADR-141 negative test |
| P-07 | A package MUST report status through its declared route; the kernel renders without knowing the schema. | ADR-145 contract test |
| P-08 | A registry MUST be a trusted row; packages install only from trusted rows. | install from an untrusted source is refused |

### 5.3 Bots and swarm (B)

| ID | Requirement | Acceptance |
|---|---|---|
| B-01 | Every bot invocation MUST clear one admission decision regardless of transport. | the same refusal set applies over HTTP, stream, and inline paths |
| B-02 | The brain for a turn MUST resolve from layered records: user choice, then bot default, then fleet default, then registry. | precedence tests per rung; no literal in code |
| B-03 | A bot MUST NOT receive credentials, raw connector payloads or store connections. | intent results are the only connector data in a prompt; a redaction test on prompt assembly |
| B-04 | Providers MUST sit behind one trait; hosted, bring-your-own and local endpoints are interchangeable to a caller. | provider fixtures are named explicitly in tests; a `noop` provider exists for isolation |
| B-05 | The kernel MUST NOT spawn an agent harness; harness kinds are node-declared data, not kernel code paths. | a build-level guard: no process-spawn call reachable from the bot or provider crates; the harness inventory lives in the node adapter |
| B-09 | A harness MUST join only as an enrolled node with a device-bound token and proven ownership, whether remote or on the kernel's own machine. | an unenrolled local harness cannot claim an envelope; a node bound to another person's bot is refused |
| B-10 | A node MUST report an immutable configuration generation at claim time; a generation change mid-run MUST fail the run. | generation mismatch test. **This mechanism already exists today**: the execution layer snapshots capabilities before the model sees any schema and re-asserts the snapshot before the provider call and each operation, so a mid-run revocation aborts rather than races. The clean design inherits it rather than inventing it. |
| B-11 | A node MUST obtain connector data only as intent results under the bot's principal; no envelope MAY carry a credential value. | envelope schema has no secret field; intent request from a node is admitted as the bot principal |
| B-12 | Cost a node reports MUST be recorded as `reported` and never summed with `metered` cost in budgets or totals. | ledger rows carry the label; budget enforcement ignores `reported` |
| B-06 | Envelopes MUST be delivered over in-process, durable-stream, remote and external transports with identical semantics. | the same workflow completes over each transport in tests |
| B-07 | A ticket type without a loaded workflow MUST wait, never guess. | startup-race test |
| B-08 | External agents MUST join only through a default-off gateway with per-agent scoped credentials. | ADR-109 tests carried forward |

### 5.4 Tenancy and users (T)

| ID | Requirement | Acceptance |
|---|---|---|
| T-01 | Every keyed name in every store MUST derive from (subject, tenant) through one function. | key-derivation guard covers relational, vector, graph, blob |
| T-02 | Relational isolation MUST be row-level security under a governed least-privilege role converged from one contract. | a bypass attempt as the governed role returns zero rows; the role's grants match the contract after boot |
| T-03 | Grants MUST use only the tier vocabulary; explicit deny wins. | ADR-118 matrix tests |
| T-04 | Scheduled and service work MUST run under an activated principal; a declared schedule alone runs nothing. | unactivated schedule ticks are refused and recorded |
| T-05 | Guest access MUST be a seeded principal with a declared capability matrix. | ADR-144 contract test |

### 5.5 Self-writing (S)

| ID | Requirement | Acceptance |
|---|---|---|
| S-01 | Producers MUST emit packages into a registry; no producer MAY write into the kernel tree. | producer output is a package directory that passes P-01..P-05 |
| S-02 | A produced package MUST be `inactive` until a person activates it. | activation audit row names the person |
| S-03 | Super-admin MUST be a distinct, double-gated role; operator does not imply it. | ADR-077 gates carried forward |
| S-04 | Kernel changes MUST land through review and the publish gate; the platform proposes and never merges into itself. | the developer bot's output is a branch and a proposal, never a merge |

### 5.6 Observability (O)

| ID | Requirement | Acceptance |
|---|---|---|
| O-01 | The door MUST emit one span, one audit event and the cost events per admitted entry; handlers emit none. | span count equals admitted-entry count in a test run |
| O-02 | One cost ledger MUST feed budgets, traces and cockpit totals. | the three totals are equal for a fixture run |
| O-03 | Inventories (entries and admission class, packages, bots, capabilities, tests) MUST be generated, and a documentation check MUST fail on a typed count. | generator output is diffed in CI against the tree |
| O-04 | Logs MUST be structured, and every sink MUST pass the redaction test. | redaction guard carried forward |

### 5.7 Deployment (D)

| ID | Requirement | Acceptance |
|---|---|---|
| D-01 | `demo` mode MUST run from one artifact with no external service installed. | fresh machine, one file, cockpit reachable, one package installed and exercised |
| D-02 | Startup MUST be order-independent; an unreachable store is a health state. | start with stores down, then up; the kernel converges without restart |
| D-03 | Upgrade MUST be an artifact swap plus embedded migrations; rollback is the previous artifact. | upgrade and rollback test between two versions |
| D-04 | Modes MUST be declared postures; a mode name never invents behavior outside its table. | ADR-137 tests carried forward |
| D-05 | Monitoring MUST be inherited from package declarations, never registered by hand. | adding a bot adds a scrape target with no config edit |

---

## 6. Non-functional requirements

- **Footprint.** Targets are measured against today's api container and a fresh `demo` install before
  they are written down. No number here until then (P12).
- **Latency.** The control plane is I/O-bound (ADR-121 profile). The requirement is that the door adds
  no measurable overhead against today's per-route times, not that anything gets faster.
- **Hermetic tests.** The default test target is an embedded store. A live store requires a named
  fixture and an explicit flag, and the run fails loudly when the flag is set and the store is absent.
- **Limits carried forward.** File and function caps, Change Log headers, structured logging, no
  silent catches, no mock deliverables, docs as-built.
- **No secret in any artifact.** The publish gate and the redaction guard apply to the kernel artifact,
  every package and every generated document.
- **Documentation is generated where it can be.** Schema, inventories, counts, status.

---

## 7. What this specification does not decide

(Subsystem depth and deployment postures are no longer open here: they moved to
[05](./05-subsystem-specs.md) and [06](./06-deployment-postures.md).)

- **Language.** Rust, TypeScript, or refactor in place is decided against this spec in the next
  document, with the ADR-121 scope guard respected.
- **Migration strategy.** A strangler beside today's stack was recommended in the evaluation that
  preceded this document; it is not decided here.
- **Store engines.** Relational, stream, vector and graph engines are chosen per deployment mode later.
  The spec fixes the traits and the key derivation, not the vendors.
- **Timeline and sequencing.** Follows the language decision.

---

## 8. Next steps (Phase 0)

| Step | Deliverable | Done when |
|---|---|---|
| 1 | Operator review of this document | verdicts in §3 confirmed or corrected in a follow-up commit |
| 2 | SDK seed inventory | the 124 kernel modules packages import today, each marked `promote to SDK` or `move to package`, checked in as a generated table |
| 3 | Object-model review against the ADR corpus | every ADR in §2 and §3 maps to an object in §4.3 or is marked domain (package) |
| 4 | Requirement-to-test map | each `MUST` in §5 names the guard that will assert it |
| 5 | Language decision document | Rust vs TypeScript vs in-place, scored against §5 and §6, with the ADR-121 profile as an input |

---

## 9. Evidence

Measured 2026-09-17 on the working trees of `oshal` and `oshal-applications`. Counts are code lines
(blank and comment lines excluded). They are a dated snapshot, not canon; regenerate with the commands
below before quoting them anywhere else.

| Measure | Value |
|---|---|
| Core server TypeScript (`src/app` + `features` + `entities` + `shared`) | 214,408 |
| of which `src/features/swarm-orchestration` | 18,563 |
| `src/app` top-level files / trading-prefixed | 123 / 44 |
| `src/app/routes` files / lines | 257 / 46,362 |
| Legacy JavaScript execution layer (`any-bot/server`) | 41,192 |
| Cockpit browser JavaScript / HTML pages | 29,476 / 46 |
| Core tests (lines; unit specs; Playwright specs) | 179,136; 1,014; 171 |
| Express handlers | 862 |
| Route files referencing `requiresAuth` | 88 of 257 |
| Files touching row-level-security identity | 113 |
| Files creating a child logger / recording cost / using zod / rate limiting | 753 / 23 / 66 / 3 |
| Runtime dependencies / native modules | 53 / 4 (sharp, better-sqlite3, onnxruntime, msgpackr) |
| Files touching Postgres / Redis | 224 / 23 |
| SQL migrations (core) | 133 |
| ADRs | 164 |
| Store packages | 61 |
| Store route source (`src-routes`) / compiled copies (`routes`) | 154,005 / 156,527 |
| Store package tests / browser UI JavaScript | 101,926 / 24,528 |
| Distinct kernel modules imported by packages / import sites | 124 / ~1,500 |
| Top imported kernel modules | logger 348, app-context 342, database 55, agent-management 48, connectors-routes 46, inline-bot-execution 44, authz 43, trading 40 |

Regeneration (Git Bash, from each repo root):

```bash
# code lines, one tree
find <dir> -type f \( -name '*.ts' -o -name '*.js' -o -name '*.mjs' \) -not -path '*/node_modules/*' \
  -not -name '*.d.ts' -print0 | xargs -0 cat | grep -cvE '^\s*$|^\s*//|^\s*\*|^\s*/\*'

# kernel modules imported by store packages
grep -rhoE --exclude-dir=node_modules --include=*.ts --include=*.js \
  "from ['\"]@/(app|shared|features|entities)[^'\"]*" . | sort | uniq -c | sort -nr

# route files carrying the auth guard
grep -lE 'requiresAuth|requireAuth' src/app/routes/*.ts | wc -l; ls src/app/routes/*.ts | wc -l
```
