# Clean kernel — subsystem specifications

**Status:** DRAFT 2026-09-18, for operator review. Added after a review pass found these subsystems
named only in passing in [01](./01-high-level-spec.md). Each section states what the subsystem is, the
decisions that define it, and requirements with acceptance criteria. Deployment choices (single vs
multi user, single vs multi tenant, Docker vs Terraform, hot-load vs blue-green) are a separate axis
and live in [06](./06-deployment-postures.md).

Requirement families here: **I** identity, **U** user management, **N** settings, **A** application
management, **L** dynamic loading, **Q** queue and mesh, **X** connectors, **R** knowledge/RAG,
**M** time series, **H** monitoring and self-healing, **W** packing and producers. They extend the
families in [01 §5](./01-high-level-spec.md#5-functional-requirements) (C, P, B, T, S, O, D).

---

## A. Identity, SSO and OIDC

**What it is.** How a person or service proves who they are, and how one human maps to one canonical
subject across several identity providers.

Today: `express-openid-connect` with two providers wired (Google, Microsoft), a local invited-user
path, mock OIDC for development, an Entra/local bridge, and a session user that does not carry the
issuer. That last fact broke every real login in one release while mock-OIDC suites stayed green.

### Decisions

| # | Decision | Why |
|---|---|---|
| A1 | **A principal is (issuer, subject), never subject alone.** The pair is resolved at the door and both halves travel in `Principal`. | two providers can mint the same subject string; a subject-only key is a cross-account collision waiting to happen |
| A2 | **One canonical local subject; external identities are linked records.** A person may link Google, Microsoft, Entra, a local password and a device; all resolve to one `PrincipalId`. | ADR-158; a person who signs in a different way is the same person, with the same data |
| A3 | **Providers are rows, not build flags.** Each row carries issuer, client, discovery URL, enabled flag, and whether it may auto-provision a new person. | ADR-126 generalized; adding an enterprise IdP is configuration, not a release |
| A4 | **Auto-provisioning is per provider and off by default.** An unknown subject from a provider without auto-provision is a refusal, not a new account. | prevents an open IdP from silently creating tenants |
| A5 | **Local auth is a provider, not a bypass.** Invited users, one-time invitations, TOTP; it produces the same `Principal` shape with issuer `local`. | ADR-117; one door for identity means no second session model |
| A6 | **Development identity is a provider too.** Mock identity is a provider row that is refused outside `demo` mode. | ADR-008 without the "tests pass, production fails" failure mode |
| A7 | **Service and node identity are separate kinds.** A node token is device-bound and owner-scoped; a service principal is a row with grants. Neither is a person. | ADR-114; a shared secret is never an identity |

### Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| I-01 | `Principal` MUST carry issuer and subject; no code path MAY key on subject alone. | a test with two providers minting the same subject keeps the data separate |
| I-02 | Identity MUST be derived from verified claims once per entry, including through multipart, streaming and channel entries. | the multipart regression case passes: upload carries the same principal as JSON |
| I-03 | Linking MUST be explicit and auditable; an unlinked external identity MUST NOT inherit another's data. | link, unlink and attempted-hijack tests |
| I-04 | A provider row with auto-provision off MUST refuse an unknown subject. | refusal code `IssuerNotTrusted` or `NoIdentity` recorded |
| I-05 | Mock identity MUST be refused outside `demo` mode. | starting `enterprise` mode with mock enabled fails to start, loudly |
| I-06 | Every authentication path MUST be exercised against a real issuer in tests, not only a mock. | a local OIDC issuer fixture runs in the suite; a mock-only suite is not evidence |

---

## B. User management

**What it is.** Invitation, directory, roles, deactivation, data export and deletion.

Today: swarm roles (root/admin/user) with root as a database invariant, a user directory, access
review routes, application authorization policy. There is no single user-lifecycle model.

### Decisions

| # | Decision | Why |
|---|---|---|
| B1 | **A person is a row with a lifecycle**: invited → active → suspended → deactivated → deleted. Every state is a refusal input at the door. | a suspended person must stop working immediately, everywhere, not per surface |
| B2 | **Roles are swarm-scope; tiers are app-scope.** `root | admin | user` governs the platform; `deny | viewer | editor | admin` governs one package. They never merge. | ADR-148 + ADR-118; merging them is how "operator" quietly becomes "can touch everything" |
| B3 | **Root is exactly one, by database invariant.** Admin is a grant. | ADR-148 |
| B4 | **Invitation is a capability of admin, scoped to a tenant**, with an expiring one-time credential. | ADR-117 |
| B5 | **Deactivation revokes sessions, node tokens and activations in one action.** A deactivated person's scheduled services stop; they do not silently keep running under a ghost principal. | ADR-157; an activation outliving its principal is an unowned process |
| B6 | **Export and delete are person-scoped operations over the same key function** every store uses. | one key derivation means one deletion sweep |

### Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| U-01 | Person state MUST be evaluated at the door; suspended or deactivated yields a refusal on every entry kind. | suspend mid-session: the next request refuses |
| U-02 | Deactivation MUST revoke sessions, node tokens and activations atomically. | after deactivation, a node claim and a schedule tick both refuse |
| U-03 | Swarm roles and app tiers MUST remain separate vocabularies. | a test proves platform admin does not imply `editor` on a package |
| U-04 | Invitations MUST expire and be single-use. | replay refused |
| U-05 | Export and delete MUST cover every store the key function names. | a seeded person's rows are absent from relational, vector, graph and blob after delete |

---

## C. Settings: admin, user, package

**What it is.** Who may set what, and which value wins. This is the axis that produced hardcoded
defaults, a bot brain chosen in four different places, and a cockpit layout cached where it should not
have been.

### Decisions

| # | Decision | Why |
|---|---|---|
| C1 | **Every setting is a record at a named scope. No literal in code is a setting.** Scopes, most specific first: **user → package-install → tenant → deployment → kernel default**. | ADR-162 generalized from brains to all settings; "nothing hardcoded" becomes structural |
| C2 | **A setting declares who may write each scope.** A person may write the user scope of their own settings; a tenant admin the tenant scope; nobody writes the kernel default at runtime. | separates "my preference" from "policy" so widening one cannot widen the other |
| C3 | **An admin scope may be marked *locked*, which removes the scopes below it.** A tenant that locks a model choice makes the user scope inert, visibly. | enterprise policy without a second mechanism |
| C4 | **Resolution is a pure function with a trace.** `resolve(setting, principal) -> (value, winning_scope)`; the surface shows which scope won. | the user can see why they got a value; support stops guessing |
| C5 | **Settings are typed and validated against a declared schema**, shipped by the kernel or a package. | an unknown key fails at write, not at read |
| C6 | **No client-side cache of an authority value.** A surface reads the resolved value; the URL contract stays authoritative for view state. | the cockpit profile-caching defect |

### Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| N-01 | Every setting MUST resolve through one function that returns the value and the winning scope. | precedence tests across all five scopes |
| N-02 | A write MUST be refused when the principal may not write that scope. | user attempting a tenant write refuses |
| N-03 | A locked scope MUST make lower scopes inert and the surface MUST show it. | locked-model test |
| N-04 | An unknown or ill-typed setting key MUST be refused at write. | schema validation test |
| N-05 | No kernel code path MAY read a literal where a setting exists. | a generated inventory lists settings and their declaring schema; review gate on new literals |

---

## D. Application management

**What it is.** The admin surface and rules over the package lifecycle in
[diagram 04](./diagrams/04-package-lifecycle.md): what is installed, from where, at what version, who
may use it, what it costs, and whether it is healthy.

### Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Install is admin-only and registry-scoped.** Registries are rows an admin trusted. | ADR-147 |
| D2 | **Grant is separate from install.** Installing does not give anyone access; access is a tier grant per person or group. | ADR-118, ADR-149; install and entitle are different decisions |
| D3 | **Dependencies resolve before activation, and a group activates only when its members are active.** | ADR-141 |
| D4 | **Every app reports its own status and readiness through declared routes; the kernel renders.** | ADR-145 |
| D5 | **Version and provenance are recorded per install**: registry row, ref, commit, artifact hash, who installed it, when. | supply chain answerability; a stale image must be detectable from the record |
| D6 | **Uninstall asks what happens to the data**: keep the namespace, export it, or delete it. Default is keep. | an uninstall that silently deletes a person's records is unrecoverable |

### Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| A-01 | Install MUST record provenance and MUST be refused from an untrusted registry. | provenance row present; untrusted source refused |
| A-02 | Activation MUST fail when a dependency or group member is not active. | dependency test |
| A-03 | Granting MUST be a distinct action from installing. | an installed, ungranted package is invisible to a non-admin |
| A-04 | Uninstall MUST NOT delete package data unless explicitly chosen. | default-keep test; explicit-delete test |
| A-05 | The application inventory MUST be generated (name, version, provenance, state, grants, health). | inventory matches the loader's state, not a written list |

---

## E. Dynamic loading: packages, bots, tools, capabilities

**What it is.** Everything that can appear or disappear while the kernel runs.

### Decisions

| # | Decision | Why |
|---|---|---|
| E1 | **One loader, four registries.** Packages load; bots, tools, workflows and surfaces are *registered by* a loaded package. There is no separate bot-install or tool-install path. | today's drift is four half-mechanisms; one lifecycle is auditable |
| E2 | **Registration is declarative and idempotent.** A package's manifest is the source; re-loading converges the registry rather than appending. | restart-safe; no duplicate bot ids |
| E3 | **Tools load lazily and scoped.** A bot sees only the tools its package declares and its grants allow; the catalog is not a global namespace. | ADR-067, ADR-087 |
| E4 | **A bot id is stable and owned by exactly one package.** Sharing an id across packages is a load-time refusal. | the ambiguous-ownership incident that took an assistant down |
| E5 | **Unload drains.** In-flight envelopes complete or are re-queued; a bot that disappears mid-phase fails the phase with a named reason, never silently. | ADR-022 posture |
| E6 | **A capability not declared is not linked**, so the failure is at load, not a runtime surprise. | diagram 04 |

### Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| L-01 | Bots, tools, workflows and surfaces MUST only enter a registry through a loaded package. | a direct registry write outside the loader does not compile |
| L-02 | Re-loading a package MUST converge, not duplicate. | load twice, one registration |
| L-03 | A duplicate bot id across packages MUST be refused at load. | duplicate-id test |
| L-04 | A tool MUST be invisible to a bot whose package did not declare it. | scoping test |
| L-05 | Unload MUST drain in-flight work and fail open phases with a named reason. | drain test with an in-flight envelope |

---

## F. Queue, routing and the mesh process

**What it is.** How work moves: the stream, consumer groups, routing rules, retries, dead letters and
back-pressure. Today this is Redis Streams with consumer groups, a dispatcher that chooses a path per
ticket type, a circuit breaker and work-item dedup.

### Decisions

| # | Decision | Why |
|---|---|---|
| F1 | **One envelope type, four transports** (in-process, durable stream, remote node, external). Routing chooses a bot; transport follows from that bot's posture. | ADR-161: admission and transport are separate questions |
| F2 | **Routing is data.** Ticket type → workflow → phase → bot comes from the manifest registry and routing declarations, never from a conditional in the dispatcher. | ADR-083 killed regex routing; the same rule applies to dispatch paths |
| F3 | **Exactly-once effect, at-least-once delivery.** Every envelope carries an idempotency key; a handler that runs twice produces one effect. | streams redeliver; pretending otherwise produces the duplicate-order class of bug |
| F4 | **Claim, acknowledge, and a visible pending set.** Unacknowledged envelopes past a deadline are re-queued with an attempt count. | consumer-group semantics made explicit |
| F5 | **A dead-letter queue is a first-class surface, not a log line.** An envelope that exhausts attempts lands in the DLQ with its refusal or error, and can be replayed by an admin after the cause is fixed. | a silently dropped ticket is indistinguishable from success |
| F6 | **Circuit breaking is per bot and per package**, and it opens on error rate, not on a single failure. | ADR-023 |
| F7 | **Back-pressure is explicit.** When a queue exceeds its bound, new tickets are refused with a named code rather than accepted and starved. | P9 |
| F8 | **The stream engine is a trait.** In-process for single-node; Redis Streams for a fleet. No kernel logic depends on Redis features beyond the trait. | portability (spec §4.11) |

### Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| Q-01 | Every envelope MUST carry an idempotency key and a redelivery MUST NOT duplicate its effect. | redeliver the same envelope; one effect |
| Q-02 | Unacknowledged envelopes MUST be re-queued with an attempt count and a visible pending set. | timeout test |
| Q-03 | Exhausted envelopes MUST land in a DLQ with cause and MUST be replayable by an admin. | DLQ round-trip test |
| Q-04 | Routing MUST come from registry data; a new ticket type MUST need no dispatcher code change. | add a ticket type by manifest only |
| Q-05 | A circuit MUST open per bot and per package on an error-rate threshold and MUST recover on probe success. | breaker test |
| Q-06 | Over-bound queues MUST refuse with a named code. | back-pressure test |
| Q-07 | The same workflow MUST complete over the in-process and durable-stream transports. | parity test |

---

## G. Connector framework

**What it is.** How the platform talks to someone else's system with someone's credential: the
declaration, the OAuth ceremony, the token store, liveness, the operation schema and the audit.

Today: 25 connector modules, a marketplace, an OAuth ceremony, liveness caching, action audit, a
token broker and a write-actions tier.

### Decisions

| # | Decision | Why |
|---|---|---|
| G1 | **A connector is a declaration, not code.** Identity of the provider, auth shape (OAuth client, personal token, API key), scopes, and the operations it authorizes. | ADR-065; artisanal integrations do not scale to a catalog |
| G2 | **An operation is a schema-bounded server handler**, not a tool the model can shape. Input schema, output normalization, redaction rules. | ADR-036, ADR-056 |
| G3 | **Credentials live in the broker; handlers receive a `SecretRef`.** Only the intent boundary resolves it, and it never returns the value. | spec C-05 |
| G4 | **Write actions are a separate tier requiring a confirmed context.** Read and write are not the same grant. | ADR-105 |
| G5 | **Every action is audited with principal, connector, operation, outcome** — including refusals. | ADR-105 audit trail |
| G6 | **Liveness and expiry are explicit states**, surfaced to the owner: connected, expiring, expired, revoked. A stale token is a visible state, not a 500. | connection-expiry semantics |
| G7 | **Ownership is per person by default; shared connectors are an explicit tenant object** with their own grants. | ADR-042 |
| G8 | **Partner registration is business-owned and documented once per shape.** A connector whose token drives no usable API is not wired. | the "no connectors to nowhere" rule |

### Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| X-01 | A connector MUST be declarable without kernel code changes for the supported auth shapes. | add one by declaration in a test |
| X-02 | A credential value MUST NOT appear outside the intent boundary, including in logs, envelopes, traces and prompts. | redaction and envelope-schema tests |
| X-03 | A write action MUST require `Ctx<Confirmed>`. | refusal without confirmation |
| X-04 | Every action and refusal MUST be audited with principal, connector and operation. | audit rows per case |
| X-05 | Expiry and revocation MUST surface as owner-visible states and MUST refuse cleanly. | expired-token path returns a named refusal, not an exception |
| X-06 | A shared connector MUST carry its own grants, distinct from personal ones. | shared-vs-personal isolation test |

---

## H. Knowledge and RAG framework

**What it is.** Corpus ingestion, chunking, embedding, retrieval, permission filtering and citation.

Today: a pgvector engine alongside the vector store, a chunker, hybrid lexical/vector fusion, a local
ONNX embedding service, a permission filter, a source ACL mapper and reserved collections. This is a
real framework and the spec mentioned it only as "vector store, optional".

### Decisions

| # | Decision | Why |
|---|---|---|
| H1 | **Retrieval is permission-filtered at query time, by the same grants the door uses.** A person never retrieves a chunk they could not read directly. | RAG is an exfiltration path if it is not; the ACL mapper exists for this reason |
| H2 | **A collection is scoped like every other store: (subject, tenant) plus package namespace.** Shared corpora are explicit tenant objects. | T-01 |
| H3 | **Hybrid retrieval is the default**: lexical and vector, fused, with a lexical-only fallback when no embedding function is available. | the fallback already exists and is the difference between degraded and broken |
| H4 | **Embeddings are a pluggable trait**: local ONNX model, a hosted embedding provider, or the database's own function. Single-node uses local. | portability; no network dependency in `demo` |
| H5 | **Citations carry provenance.** Every retrieved chunk has a document id and a source class; web-fetched content is marked as such. | the existing citation rule, made a kernel property |
| H6 | **Ingestion is a package concern; the index is a kernel rail.** A package declares a corpus and feeds it; the kernel owns chunking, embedding, scoping and retrieval. | P6 |
| H7 | **Reserved collection names exist and are refused to packages.** | prevents a package from shadowing a kernel corpus |

### Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| R-01 | A retrieval MUST return only chunks the principal may read. | a seeded cross-person corpus returns nothing to the other person |
| R-02 | Collections MUST be scoped by the single key function plus package namespace. | scoping test across two tenants |
| R-03 | Hybrid retrieval MUST degrade to lexical when embeddings are unavailable, and MUST say so. | embedding-absent test returns results with a degraded flag |
| R-04 | Every result MUST carry a document id and source class. | citation test |
| R-05 | A package MUST NOT create or read a reserved collection. | refusal test |
| R-06 | `demo` mode MUST retrieve with no network dependency. | offline test |

---

## I. Time-series framework

**What it is.** High-rate append-only data: market data, telemetry, metrics, sensor and node readings.

Today: TimescaleDB is in the compose stack and used by the world-data pre-aggregation path, the
satellite node and the data-model catalog. It has never been specified as a kernel rail, so each user
of it reinvents retention and rollups.

### Decisions

| # | Decision | Why |
|---|---|---|
| I1 | **A time series is a declared object**: name, key columns, value schema, retention, and rollup intervals. Packages declare; the kernel creates. | prevents per-package ad-hoc tables with no retention |
| I2 | **Scoped like everything else** by (subject, tenant) plus package namespace. | T-01 |
| I3 | **Retention and downsampling are declared, enforced by the engine, and visible.** An unbounded series is a load-time refusal. | an append-only table with no retention is an outage with a delay |
| I4 | **The engine is a trait**: Timescale hypertables where present; plain partitioned tables or SQLite for single-node. Queries use the trait vocabulary (range, bucket, aggregate), not engine SQL. | portability |
| I5 | **Metrics are a time series, not a separate system.** The monitoring rail writes through the same trait so single-node needs no Prometheus. | §J; one artifact in `demo` |
| I6 | **Late and out-of-order points are defined behavior**, declared per series: accept, reject, or reconcile. | market and telemetry data arrive late; silence here produces wrong charts |

### Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| M-01 | A series MUST declare retention; an undeclared or unbounded retention MUST be refused at load. | refusal test |
| M-02 | Queries MUST use the trait vocabulary and MUST run on both engines. | parity test on Timescale and single-node |
| M-03 | Rollups MUST be declared and produced by the engine, not by per-package jobs. | rollup test |
| M-04 | Late-point behavior MUST be declared and honored. | late-point test per mode |
| M-05 | Series MUST be scoped by the single key function. | cross-tenant read returns nothing |

---

## J. Monitoring, health and self-healing

**What it is.** What the system knows about itself, what it does about it, and where a human stays in
the loop.

Today: Prometheus and Alertmanager over label-discovered containers, an alert pipeline, alert triage,
operational intelligence, a bot-node self-heal route, and autonomous health ticket processing.

### Decisions

| # | Decision | Why |
|---|---|---|
| J1 | **Three layers, distinct**: *observability* (spans, ledger, inventories), *health* (liveness and readiness per component), *remediation* (an action taken in response). Do not blur them. | today's shallow HTTP health check reported "healthy" while the api had no database |
| J2 | **Health is deep by default.** A readiness answer names its dependencies and their states; "the process is up" is not readiness. | the api-up-without-a-database incident |
| J3 | **Metrics are scraped where a scraper exists and self-hosted where one does not.** Single-node writes metrics to the time-series rail and renders them; `enterprise` exposes the same series for scraping. | D-01 portability; the monitoring overlay must not be the only way to see anything |
| J4 | **Monitoring targets are inherited from declarations.** Adding a bot or package adds its targets with no configuration edit. | already the rule for container labels; generalized to manifests |
| J5 | **An alert becomes a ticket through the normal door**, is triaged and deduplicated, and dispatches like any other work. There is no second execution path for operations. | ADR-119, ADR-125 |
| J6 | **Self-healing is a bounded, declared action with a blast radius and a budget.** Allowed: restart a component, re-queue an envelope, re-open a circuit, re-run a migration check, rotate a stuck consumer. Forbidden without a human: deleting data, changing grants, editing settings above user scope, installing or upgrading a package, force-pushing anything. | the operator rule that evidence must support the specific action, made a type |
| J7 | **Every remediation is rate-limited and auditable, and repeated failure escalates to a human** instead of looping. | a self-healer that retries forever is an outage amplifier |
| J8 | **A remediation runs under an activated system-service principal**, never anonymously. | ADR-157 |

### Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| H-01 | Readiness MUST enumerate dependencies and their states; a component with a failed dependency MUST NOT report ready. | database-down test reports not-ready |
| H-02 | Metrics MUST be available in `demo` mode with no external scraper. | single-artifact metrics render |
| H-03 | Monitoring targets MUST be inherited from declarations. | adding a bot adds a target with no config edit |
| H-04 | An alert MUST become a ticket through the normal door, deduplicated. | duplicate alerts produce one ticket |
| H-05 | A remediation MUST be one of the declared allowed actions, rate-limited, audited, and run under an activated principal. | a forbidden action refuses; the audit names the principal |
| H-06 | Repeated remediation failure MUST escalate to a human and stop. | escalation test; no infinite loop |

---

## K. Code packing and the producer pipeline

**What it is.** Turning a conversation, an external skill, a canvas or a bot's own work into an
installable package. The self-writing loop in [diagram 09](./diagrams/09-self-writing-loop.md) is the
governance; this is the mechanism.

### Decisions

| # | Decision | Why |
|---|---|---|
| K1 | **One output shape: a package.** Interview-driven packing, skill import, studio publish and the developer bot all emit the same directory with a manifest. | ADR-089, ADR-039; four producers, one artifact, one gate |
| K2 | **Packing is deterministic and reproducible**: the same inputs produce the same package, and the package records the producer, inputs hash and kernel SDK range. | a generated artifact nobody can regenerate is not maintainable |
| K3 | **Imported scripts are quarantined; imported tools are translated and minimized** to declared capabilities. | ADR-089; an external skill is untrusted input |
| K4 | **A produced package is emitted `inactive` and carries its own test catalog.** No producer may activate its own output. | S-02 |
| K5 | **A producer never writes into the kernel tree.** A kernel change is a branch and a pull request. | S-01, S-04 |
| K6 | **The interview is a package too.** The packer bot ships as a package, so improving it is an install, not a release. | keeps the kernel small (G5) |

### Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| W-01 | Every producer MUST emit the same package shape and pass the same gate. | one fixture validates output from each producer |
| W-02 | Packing MUST be reproducible and MUST record producer, input hash and SDK range. | same inputs, byte-identical manifest |
| W-03 | Imported scripts MUST be quarantined and tools minimized to declared capabilities. | an imported skill requesting an undeclared capability fails at load |
| W-04 | A producer MUST NOT activate its output or write into the kernel tree. | negative tests for both |
| W-05 | A produced package MUST carry a runnable test catalog registered with the Test Lab. | a package with no tests cannot reach `Tested` |

---

## Where these sit in the architecture

| Subsystem | Crates | Diagram |
|---|---|---|
| Identity, SSO | `control` | [02](./diagrams/02-admission-door.md), [12](./diagrams/12-identity-and-settings.md) |
| User management | `control`, `api` | [12](./diagrams/12-identity-and-settings.md) |
| Settings | `control`, `sdk` | [12](./diagrams/12-identity-and-settings.md) |
| Application management | `packages`, `api` | [04](./diagrams/04-package-lifecycle.md) |
| Dynamic loading | `packages` | [04](./diagrams/04-package-lifecycle.md) |
| Queue and mesh | `mesh`, `orchestration` | [05](./diagrams/05-ticket-envelope-flow.md) |
| Connector framework | `intents`, `control` | [11](./diagrams/11-data-planes.md) |
| Knowledge / RAG | `store`, `inference` | [11](./diagrams/11-data-planes.md) |
| Time series | `store` | [11](./diagrams/11-data-planes.md) |
| Monitoring and self-healing | `observe`, `orchestration` | [13](./diagrams/13-monitoring-self-healing.md) |
| Packing and producers | `packages` | [09](./diagrams/09-self-writing-loop.md) |
