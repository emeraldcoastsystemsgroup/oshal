# Clean kernel — subsystem specifications, part 2

**Status:** DRAFT 2026-09-18, for operator review. Second gap pass. Covers workflow authoring and
execution, token optimization, tracing, ambient capture, the person model and learning loop, bot
composition depth, external agents, and the node network. Part 1 is [05](./05-subsystem-specs.md);
deployment axes are [06](./06-deployment-postures.md).

New requirement families: **F** workflow, **K** token optimization, **G** tracing, **E** ambient
capture, **J** person model and learning, **Y** external agents, **Z** node network. Bot composition
extends family **B** from [01 §5.3](./01-high-level-spec.md#53-bots-and-swarm-b).

---

## L. Workflow authoring and execution

**What it is.** How a process gets described, validated, compiled and run. Today: a studio compiler, a
run-history store, three dispatch workers (manifest, graph, routing), a multi-app plan compiler, and
workflows registered from manifests. Publish already compiles to runtime.

### Decisions

| # | Decision | Why |
|---|---|---|
| L1 | **The runtime is the only authority. Authoring compiles into it.** The studio is a design-time surface that emits a workflow definition; it is never a second execution engine. | this is already true and is the single most load-bearing fact about the studio |
| L2 | **One definition format, three execution shapes**: single-shot (one bot, one phase), staged (ordered phases with optional approval gates), and graph (branching, parallel, join). The shape is derived from the definition, not chosen by the author. | three hand-picked engines is how the dispatcher grew conditionals |
| L3 | **A workflow is a package artifact.** Publish emits a caller-scoped manifest that installs like any other package, so authoring inherits the whole package gate. | ADR-085, ADR-039; no separate "published workflow" store |
| L4 | **Validation is total and happens before install**: every node resolves to a registered bot or tool, every edge has a satisfied input, no unreachable node, no cycle without an explicit loop bound. | a workflow that fails at phase 7 wasted six phases of spend |
| L5 | **Approval gates are principals, not prompts.** A gate names who may approve and produces a confirmed context when they do. | ADR-031; an approval a model can satisfy is not an approval (P4) |
| L6 | **Every run is recorded as a run record** with its definition version, inputs, per-phase outcomes and cost, so a run is reproducible and comparable. | the run-history store made explicit; it is also the input to token optimization (§M) |
| L7 | **Natural-language authoring drafts a definition; it never installs one.** The draft goes through L4 validation and a human review. | talk-to-build is a producer (S-01) |
| L8 | **Loops and parallelism are bounded by declaration**: max iterations, max fan-out, per-run budget. An unbounded graph is a validation failure. | a parallel fan-out with no bound is a spend incident |

### Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| F-01 | A published workflow MUST become a package and pass the package gate. | publish produces an installable package; no separate store |
| F-02 | Validation MUST reject unresolved nodes, unsatisfied inputs, unreachable nodes and unbounded loops before install. | one negative test per case |
| F-03 | The three execution shapes MUST be derived from the definition and MUST run on one engine. | the same definition file runs single-shot, staged and graph cases |
| F-04 | An approval gate MUST name an approving principal and MUST produce a confirmed context. | a bot cannot satisfy a gate; an unauthorized person is refused |
| F-05 | Every run MUST record definition version, inputs, per-phase outcome and cost. | run record is complete enough to replay |
| F-06 | Fan-out, iteration and per-run budget MUST be bounded by declaration and enforced at dispatch. | exceeding a bound refuses with a named code |

---

## M. Token optimization and cost efficiency

**What it is.** Making a run cheaper without making it worse. Today this is Token Chase: checkpoint and
replay, an assessor, a judge with its own budget, judged savings, a keep-winner rule, promotion, and a
determinism verdict. It is the platform's strongest differentiator and appeared nowhere in the spec.

### Decisions

| # | Decision | Why |
|---|---|---|
| M1 | **Optimization is counterfactual replay over recorded runs**, never live experimentation on a person's work. A candidate is replayed from a checkpoint and compared to the winner. | you cannot A/B a person's real ticket without spending their money twice |
| M2 | **A candidate must prove savings *and* non-inferior quality.** A judge scores output; the judge has its own budget; judged savings are net of judging cost. | a cheaper wrong answer is not a saving, and an unbudgeted judge can cost more than it saves |
| M3 | **Keep the winner.** A candidate replaces the incumbent only on a clear win; ties keep the incumbent. | prevents drift from noise |
| M4 | **Determinism is verified, not assumed.** A replay that cannot reproduce the incumbent's result is reported as non-deterministic and disqualified from comparison. | the determinism verdict exists because comparing two noisy runs proves nothing |
| M5 | **Promotion is a settings write at a named scope** (§C of part 1), auditable and reversible. | an optimization is a policy change, not a hidden mutation |
| M6 | **Checkpoints are content-addressed and scoped like every other store.** A checkpoint carries no credential and is subject to the same retention rules. | checkpoints contain prompts and results, which are person data |
| M7 | **Optimization levers are declared and ordered by blast radius**: prompt shape, context selection, cache reuse, model choice, phase elision. Eliding a phase requires approval. | model choice is cheap to reverse; deleting a phase changes the product |
| M8 | **Cost accounting is the same ledger.** A claimed saving must be visible as reduced metered cost, not a modeled estimate. | ADR-104, O-02; a saving nobody can see in the ledger did not happen |

### Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| K-01 | Optimization MUST run over recorded runs, never on live person work. | a live ticket is never used as a candidate arm |
| K-02 | A promotion MUST require judged savings net of judging cost and non-inferior quality. | a cheaper-but-worse candidate is rejected; judge cost is subtracted |
| K-03 | A non-reproducible replay MUST be disqualified and reported. | determinism test |
| K-04 | Promotion MUST be a scoped settings write, audited and reversible. | promote then revert |
| K-05 | Claimed savings MUST reconcile against the cost ledger. | ledger delta matches the claim within tolerance |
| K-06 | Phase elision MUST require human approval. | refusal without approval |

---

## N. Tracing

**What it is.** The causal record of one unit of work across processes, bots and nodes. Today a trace
is assembled from status history, task links and cost events, and never fabricated.

### Decisions

| # | Decision | Why |
|---|---|---|
| N1 | **A trace is assembled from records that already exist.** Spans come from real rows. A missing row means a missing span, never an invented one. | ADR-107; a fabricated span is worse than a gap because it is believed |
| N2 | **One trace id per unit of work, propagated in the envelope** across in-process, stream, remote-node and external hops. | without propagation a remote harness run is an unexplainable gap |
| N3 | **Three span kinds, no more**: admission (one per entry), phase (one per workflow phase), call (one per inference or intent call). Everything else is an attribute. | a free-form span vocabulary becomes unqueryable |
| N4 | **Cost and trace share identifiers.** A call span and its cost event carry the same id, so totals reconcile by construction rather than by a join written by hand. | O-02 |
| N5 | **Redaction happens at the sink, and trace attributes are subject to it.** A trace must never become the place a prompt or a secret leaks. | O-04 |
| N6 | **Traces are person-scoped data** with declared retention, stored on the time-series rail. | §I of part 1; unbounded trace growth is the classic outage-on-a-delay |
| N7 | **A node reports spans for work it ran**, under the bot principal, and they are marked as reported rather than measured. | the same metered/reported distinction as cost (B-12) |

### Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| G-01 | A trace id MUST propagate across all four transports and appear in every span of the unit. | end-to-end trace over a remote node has no gap |
| G-02 | Spans MUST be assembled from real records; a missing record MUST produce a visible gap, not a synthesized span. | delete a row, see a gap |
| G-03 | Call spans and cost events MUST share identifiers and reconcile. | totals equal by id join |
| G-04 | Trace attributes MUST pass the redaction test. | prompt and secret redaction on trace sinks |
| G-05 | Traces MUST declare retention. | undeclared retention refused (M-01) |

---

## O. Ambient capture: listening, transcription, diarization

**What it is.** Continuous or triggered capture of audio, screen or video, and its conversion into text
attributed to a person. Today: an ambient-listening service, deterministic speaker diarization with
voice profiles, media input treated as a transcription pre-pass.

This is the highest-consent-risk subsystem in the platform, so its rules are stricter than the rest.

### Decisions

| # | Decision | Why |
|---|---|---|
| O1 | **Capture is off by default and requires an explicit, revocable consent record naming the scope**: which device, which surface, which hours, which retention. | a listening default-on is a product nobody can defend |
| O2 | **Consent is per person captured, not only per person operating.** A capture surface must be able to state who consented; a bystander is not consent. | diarization makes it possible to know, so it becomes an obligation |
| O3 | **Capture is local-first.** Raw audio and video stay on the capturing node; the kernel receives transcripts and features, not streams, unless a person explicitly uploads. | a platform that ships raw home audio to a server is a different product |
| O4 | **Diarization is deterministic and profile-based**, and an unmatched speaker is `unknown`, never a guess. | ADR-084; attributing a sentence to the wrong person is a serious error |
| O5 | **Transcription is a provider trait** with a local implementation, so `demo` works with no network. | portability |
| O6 | **Retention is declared and short by default, with a visible indicator while capture is active** and a one-action stop. | the person must always be able to see and stop it |
| O7 | **Captured text enters the person model only through the consent gate** (§P), never directly. | one entry point for sensitive derivation |

### Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| E-01 | Capture MUST be off by default and MUST require a scoped, revocable consent record. | no consent, no capture; revoke stops it immediately |
| E-02 | Raw media MUST NOT leave the capturing node without an explicit person action. | a capture session transmits transcripts only |
| E-03 | An unmatched speaker MUST be labelled unknown. | diarization test with an unenrolled voice |
| E-04 | Capture MUST show a visible active indicator and a one-action stop. | surface test |
| E-05 | Captured content MUST have declared retention and MUST be deletable by the captured person. | retention and delete tests |
| E-06 | `demo` mode MUST transcribe with no network. | offline test |

---

## P. Person model, learning and history

**What it is.** What the platform remembers about a person and how that memory is used. Today: a person
model with a schema, a consent gate, a recall guard, a projection ledger, an enrichment service, asks
and recall queries, plus the Haven learning loop and proactivity.

### Decisions

| # | Decision | Why |
|---|---|---|
| P1 | **Three distinct stores, not one blob**: *history* (what happened, immutable, retention-bound), *profile* (durable attributes a person can read and correct), *derivations* (inferences, each with its source and confidence). | a system that cannot separate "you said" from "we inferred" cannot let a person correct it |
| P2 | **Every derivation carries provenance and is individually revocable.** Deleting a source deletes what was derived from it. | the projection ledger exists for this; it is what makes deletion honest |
| P3 | **Recall is guarded**: a bot receives only the slice the current task justifies, filtered by the same grants as the door. | ADR-100 recall with receipts; a personal assistant that dumps a whole profile into every prompt is an exfiltration channel |
| P4 | **Recall produces receipts.** A person can see what was recalled, when and for which task. | trust requires an audit the person can read, not only an operator |
| P5 | **Enrichment is consent-gated and asynchronous**, never a side effect of an unrelated request. | derivation is a decision, not a byproduct |
| P6 | **Learning changes settings and ranking, not rules.** A learned preference may pick a model, order a list or time a suggestion; it may never grant access, change a policy or bypass a gate. | P4 of the spec: the model is untrusted, and so is a learned signal |
| P7 | **Proactivity is budgeted and interruptible.** Unsolicited actions have a rate limit, a budget and an off switch. | an assistant that acts on its own without a bound is a cost and trust incident |
| P8 | **A person can read, export, correct and delete everything in all three stores.** | ADR-057, U-05 |

### Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| J-01 | History, profile and derivations MUST be separable and separately deletable. | delete a source; its derivations disappear |
| J-02 | Every derivation MUST carry source and confidence. | schema test; no orphan derivation |
| J-03 | Recall MUST be task-scoped and grant-filtered, and MUST produce a receipt. | a recall returns only justified fields; receipt recorded |
| J-04 | Enrichment MUST require consent and MUST NOT run as a side effect of an unrelated entry. | consent-off test |
| J-05 | A learned signal MUST NOT alter grants, policy or gates. | a negative test asserts learning cannot widen access |
| J-06 | Proactive actions MUST be rate-limited, budgeted and switchable off. | bound tests |
| J-07 | Export and correction MUST cover all three stores. | round-trip test |

---

## Q. Bot composition (extends family B)

**What it is.** How a bot is assembled at invocation: identity, persona, brain, tools, memory slice and
guardrails. [01 §4.6](./01-high-level-spec.md#46-bot-model-any-bot) defines the model; this is the
assembly contract.

### Decisions

| # | Decision | Why |
|---|---|---|
| Q1 | **Prompt assembly is a kernel service with a fixed order**: system contract, persona data, task envelope, recalled slice, tool schemas, inputs. A package supplies content for named slots; it never supplies the frame. | a package that can rewrite the system contract can remove its own guardrails |
| Q2 | **Persona is data and carries no authority.** Refusals, scopes and access come from grants and capabilities, never from persona text. | ADR-122 |
| Q3 | **Tool binding is per invocation**, from the intersection of the bot's declared tools and the caller's grants. | a bot does not carry a standing tool set |
| Q4 | **The recalled slice is chosen by the recall guard** (§P), not by the bot or the persona. | J-03 |
| Q5 | **Output is structured and validated against a declared schema** where the workflow expects structure; a parse failure escalates rather than falling back. | ADR-022 |
| Q6 | **The assembled prompt is recorded (redacted) with the run record** so a run is explainable and replayable. | §M needs it; §N forbids it leaking |

### Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| B-13 | Prompt assembly MUST follow the fixed frame; a package MUST NOT alter the system contract. | attempted override is dropped and recorded |
| B-14 | Tool binding MUST be the intersection of declared tools and caller grants, computed per invocation. | grant removal takes effect on the next invocation |
| B-15 | Structured output MUST be schema-validated, and a parse failure MUST escalate. | escalation test, no silent fallback |
| B-16 | The assembled prompt MUST be recorded redacted with the run record. | replay and redaction tests |

---

## R. External agents and A2A

**What it is.** Agents that are not part of this swarm joining it, and this swarm joining someone
else's. Today: an A2A route with an agent card, default-off, per-agent hashed credentials and scopes.

### Decisions

| # | Decision | Why |
|---|---|---|
| R1 | **Default off.** The gateway and the agent card do not exist until explicitly enabled. | ADR-109; there is no accidentally-live gateway |
| R2 | **The card is curated by the same visibility rules** that scope bots for a person; a stranger sees only what discovery already allows. | ADR-087 |
| R3 | **Per-agent credentials with scopes, never a shared secret.** Each external agent is a principal with grants. | a global secret is not an identity |
| R4 | **An external agent is an untrusted principal with a lower ceiling.** It may be granted read scopes and specific intents; it may never receive a confirmed context by default. | P4 applied to a party you do not control |
| R5 | **Outbound is symmetric.** When oshal calls an external agent, that call is an intent with a schema, a budget and an audit record, not a free-form HTTP call from a handler. | otherwise outbound becomes an unaudited hole |
| R6 | **Protocol is an adapter.** The kernel speaks envelopes; A2A, MCP and any future protocol are adapters at the edge. | keeps one runtime vocabulary |
| R7 | **A2A is not proven in production and must say so** until it is. | the honesty rule; today's roadmap already marks it unproven |

### Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| Y-01 | The gateway and card MUST be absent unless explicitly enabled. | disabled returns not-found, not unauthorized |
| Y-02 | Each external agent MUST have its own credential and scopes. | revoking one does not affect another |
| Y-03 | An external agent MUST NOT obtain a confirmed context without an explicit, separate grant. | write attempt refused by default |
| Y-04 | Outbound calls to external agents MUST be schema-bounded, budgeted and audited. | audit row per outbound call |
| Y-05 | Protocol adapters MUST NOT leak protocol types into kernel crates. | build guard: no adapter type in `orchestration` |

---

## S. Node network, overlay and enrollment

**What it is.** How a machine that is not the kernel's own host reaches it safely: enrollment, tokens,
leases, heartbeats, network path and device access. Today: join routes, a node installer, a node lease
script, a Headscale enrollment worker, remote-client config, and a device broker design.

### Decisions

| # | Decision | Why |
|---|---|---|
| S1 | **Enrollment proves ownership, then issues a device-bound token.** The token is scoped to one node and one owner and is renewable by lease, not permanent. | ADR-114; a long-lived shared token is the failure mode this replaces |
| S2 | **The overlay network is optional and is a transport detail.** A node may reach the kernel over a LAN, over the public internet with TLS, or over an overlay such as Headscale or Tailscale. The kernel's admission rules are identical in all three. | ADR-013 stays available without becoming a dependency |
| S3 | **Network reachability is never an authorization.** Being on the overlay grants nothing; the token and grants do. | otherwise the VPN becomes an implicit trust boundary |
| S4 | **A lease expires.** A node that stops heart-beating loses its claim on in-flight envelopes, which are re-queued with an attempt count. | Q-02; a dead node must not hold work hostage |
| S5 | **Node capabilities are declared and granted, like a package**: which harness, which devices, which surfaces. An undeclared capability is not linked. | one capability model for packages and nodes |
| S6 | **Device access is node-resident and owner-scoped.** The kernel asks a node to act on a device it owns; the kernel never holds device credentials. | ADR-140 |
| S7 | **Installation is codeless.** A person enrolls a node from a link or a short command; no source edit, no manual token file. | ADR-129 spirit applied to nodes |
| S8 | **A node is disposable.** Losing one loses no state: work re-queues and the node holds no authority beyond its lease. A node holds only a *materialization* of the task workspace; the kernel owns the workspace ([08](./08-workspace-and-assistant.md)). | prevents a node becoming a pet with data on it |

### Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| Z-01 | Enrollment MUST prove ownership and issue a device-bound, owner-scoped, leased token. | a token from one node is refused from another |
| Z-02 | Admission MUST be identical across LAN, internet and overlay paths. | the same refusal set on all three |
| Z-03 | Overlay membership MUST grant no authority by itself. | an overlay peer without a token is refused |
| Z-04 | An expired lease MUST release in-flight envelopes for re-queue. | node-death test |
| Z-05 | Node capabilities MUST be declared and granted; undeclared ones are not linked. | capability test |
| Z-06 | Device operations MUST run on the owning node with kernel-side authorization and audit. | a device call from a non-owner refuses |
| Z-07 | Enrollment MUST be completable without editing source or hand-placing a token. | fresh-node install test |

---

## Where these sit

| Subsystem | Crates | Diagram |
|---|---|---|
| Workflow authoring and execution | `orchestration`, `packages` | [14](./diagrams/14-workflow-authoring-to-runtime.md) |
| Token optimization | `orchestration`, `observe` | [15](./diagrams/15-trace-and-token-economy.md) |
| Tracing | `observe` | [15](./diagrams/15-trace-and-token-economy.md) |
| Ambient capture | `node`, `intents` | [17](./diagrams/17-person-model-and-consent.md) |
| Person model and learning | `store`, `control` | [17](./diagrams/17-person-model-and-consent.md) |
| Bot composition | `inference`, `orchestration` | [05](./diagrams/05-ticket-envelope-flow.md) |
| External agents and A2A | `api`, `mesh` | [16](./diagrams/16-node-network-and-external-agents.md) |
| Node network and enrollment | `node`, `control` | [16](./diagrams/16-node-network-and-external-agents.md) |
