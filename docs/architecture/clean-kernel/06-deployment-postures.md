# Clean kernel — deployment postures and scaling axes

**Status:** DRAFT 2026-09-18, for operator review. These are the questions that do not have one answer:
single user or many, one tenant or many, Docker or Terraform, hot-load or blue-green. Spec:
[01 §4.11](./01-high-level-spec.md#411-deployment-modes-and-portability); subsystems:
[05](./05-subsystem-specs.md). Requirement family here: **V**.

---

## The governing rule

> **Posture selects an implementation behind a trait. It never adds a branch to kernel logic.**

Corollaries, and they are the whole point:

- **Single-user is multi-user with one person row.** There is no single-user code path, no "skip auth
  because it is just me", no nullable owner column. The door runs identically; the person table has one
  row and the login is local.
- **Single-tenant is multi-tenant with one tenant row.** Row-level security is on, the key function is
  the same, and the tenant id is not null. A deployment that never adds a second tenant pays a few bytes
  and keeps every isolation guard live.
- **The reason is verification.** A posture-specific code path is a path the other posture never tests.
  This project has already shipped that defect twice: a mock-only authentication suite that was green
  while every real login failed, and specs that reached the live database because the hermetic path was
  the exception rather than the default.

What a posture MAY change: which trait implementation is constructed, which entry adapters are enabled,
which stores are reachable, how the artifact is delivered and upgraded. What it MAY NOT change: the
door, the key function, grants, audit, cost accounting, or whether a rule is enforced.

---

## Axis 1 — People: single user ↔ multi user

| | single user | small team | many users |
|---|---|---|---|
| Identity | local provider, one person row | local invitations or one IdP | one or more OIDC providers, auto-provision per provider |
| Grants | that person is root and admin | explicit grants; root is one row | groups and tiers; access review |
| What changes | which identity providers are enabled | invitations, directory | provider rows, review cadence |
| What never changes | the door, grants, audit, key derivation | | |

**V-01.** The kernel MUST NOT contain a code path conditional on the number of people. A single-user
deployment MUST exercise the same admission, grant and audit code as a multi-user one.
*Acceptance:* the single-user suite and the multi-user suite run the same door tests; a grep-level and
build-level guard shows no user-count conditional.

---

## Axis 2 — Tenancy: single tenant ↔ multi tenant

| | single tenant | multi tenant (pooled) | siloed |
|---|---|---|---|
| Isolation | RLS on, one tenant id | RLS on, tenant per row, key function everywhere | one deployment per tenant |
| Cost | negligible | shared infrastructure | highest |
| When | a household, one company | a service with many customers | a contractual requirement |
| What changes | the number of tenant rows; whether a tenant admin surface is shown | | the deployment count |

- Pooled with row-level security is the default. Siloed is a premium posture and is a *deployment
  multiplier*, not a second codebase (ADR-035).
- Shared objects (a shared connector, a tenant corpus, a group) are explicit tenant-scoped records, never
  "rows with a null owner".

**V-02.** Row-level security and the key function MUST be active in every tenancy posture, including
single tenant. *Acceptance:* a cross-key read is refused in a single-tenant deployment too.

**V-03.** A siloed deployment MUST run the same artifact and the same migrations as a pooled one.
*Acceptance:* artifact hash parity between a pooled and a siloed instance.

---

## Axis 3 — Packaging and provisioning

Four shapes, in order of how much someone else has to install:

| Shape | What it is | When | Today's evidence |
|---|---|---|---|
| **Bare artifact** | one binary, embedded stores, `demo`/`home` | a laptop, a home, an evaluation, an air-gapped box | this is the D-01 target; nothing equivalent exists today |
| **Container** | the same binary in an image, external stores by configuration | a server, a NAS, a small team | today's compose stack, minus the 28-container floor |
| **Compose bundle** | container plus the stores it needs, one file | a single-host deployment that wants Postgres and Redis | today's primary path |
| **Kubernetes** | Helm chart for the workload, Terraform for the infrastructure around it | a fleet, an enterprise, multi-node | `deploy/helm/oshal` and `deploy/terraform/*.tf` exist |

**Docker or Terraform is not a choice between two things; they answer different questions.**

- **Docker/OCI** answers *how the process is packaged*. Every posture above bare artifact uses it.
- **Helm** answers *how the workload is declared* on Kubernetes.
- **Terraform** answers *how the surrounding infrastructure is provisioned*: the cluster, the managed
  database, DNS, certificates, object storage, network policy.
- The kernel MUST NOT know which one is in use. Provisioning artifacts are deployment inputs, and they
  are versioned with the kernel because a migration and an infrastructure change can be one release.

**V-04.** The same artifact MUST run in all four shapes with configuration alone.
*Acceptance:* an identical build hash runs bare, in a container and on Kubernetes in CI.

**V-05.** Infrastructure definitions (Helm values, Terraform modules) MUST be versioned with the kernel
and MUST declare the minimum kernel version they target.
*Acceptance:* a version-skew check fails a chart pointed at an incompatible kernel.

**V-06.** A codeless installation path MUST exist for each supported shape (an installer for bare and
container, a chart plus values for Kubernetes). *Acceptance:* a fresh operator completes each without
editing source (ADR-129).

---

## Axis 4 — Change delivery: hot-load, restart, blue-green, rolling

Four mechanisms with different blast radii. They are not alternatives; each covers a different kind of
change.

| Change | Mechanism | Downtime | Rollback |
|---|---|---|---|
| Package install, upgrade, deactivate, unload | **hot-load** (diagram 04) | none | reactivate the previous version |
| Setting, grant, registry, activation | **record change** | none | write the previous value |
| Kernel patch, same schema | **rolling** (multiple replicas) or **restart** (single node) | seconds on a single node | previous artifact |
| Kernel change with a schema migration | **blue-green with an expand/contract migration** | none if done correctly | green retired; contract not yet run |
| Emergency | **stop** | full | previous artifact |

### Rules

- **Package changes never require a kernel restart.** That is the P-02 requirement and the main reason
  the package boundary exists.
- **Kernel schema changes follow expand → migrate → contract.** Expand is backward compatible and ships
  first; both versions run against the expanded schema; contract ships only after the old version is
  gone. A migration that cannot be expressed this way is refused at review.
- **Blue-green is for the kernel, not for packages.** Two kernel versions run against one expanded
  database; traffic moves; the old one drains. Package state lives in the database, so packages do not
  need duplicating.
- **A single-node deployment does not do blue-green.** It restarts. The requirement there is that
  startup is order-independent and fast, and that the previous artifact is one file away.
- **Rollback is an artifact, not a procedure.** If rolling back requires running something, it will not
  be done at 3am.
- **Migrations are versioned, forward-only and recorded.** A one-way migration is a release-gate
  decision, flagged at review, not discovered at rollback time.

**V-07.** A package lifecycle transition MUST NOT require a kernel restart. *Acceptance:* P-02 test.

**V-08.** A kernel schema migration MUST be expand/contract, and both adjacent kernel versions MUST run
against the expanded schema. *Acceptance:* a two-version test runs old and new simultaneously.

**V-09.** Rollback MUST be achieved by starting the previous artifact, with no manual data step.
*Acceptance:* upgrade then roll back in CI with the workload live.

**V-10.** A one-way migration MUST be declared as such and MUST be approved explicitly.
*Acceptance:* the review gate fails an undeclared irreversible migration.

---

## Posture matrix

The named modes from ADR-137, expressed across all four axes.

| Mode | People | Tenancy | Packaging | Change delivery | Stores |
|---|---|---|---|---|---|
| `demo` | single user, local provider | single tenant | bare artifact | restart | embedded relational, in-process stream, local embeddings, local time series |
| `home` | invited users | single tenant | bare artifact or container | restart | embedded or external |
| `team` | one IdP | single or multi | container or compose | rolling | Postgres, Redis, optional vector, graph, time series |
| `enterprise` | multiple IdPs, groups, access review | multi tenant pooled, or siloed | Kubernetes with Helm and Terraform | blue-green | external everything, optional managed services |

**V-11.** A mode MUST NOT enable or disable a rule; it MAY only select implementations and adapters.
*Acceptance:* a test asserts the refusal set is identical across modes for the same inputs.

---

## What this rules out

- A "simple mode" that skips authentication, tenancy or audit.
- A single-user build with nullable owners.
- Kubernetes-only features that the container shape cannot express.
- A package that requires a kernel restart.
- A migration discovered to be irreversible after it ran.
- Infrastructure definitions that drift from the kernel version they provision.
