# 04 — Package lifecycle (hot-load, no kernel restart)

Every transition is a kernel action on a running kernel. Spec:
[01 §4.5](../01-high-level-spec.md#45-package-contract), requirements P-01 to P-08.

```mermaid
stateDiagram-v2
  [*] --> Installed : install from a trusted registry row (P-08)
  Installed --> Validated : manifest · SDK range · declared capabilities OK (P-01, P-03)
  Installed --> Rejected : validation failed
  Validated --> Tested : sandbox tests pass with verdict integrity (P-05)
  Validated --> Rejected : failed · zero tests · declined · truncated evidence
  Tested --> Granted : admin grants the declared capabilities
  Granted --> Loaded : host links granted capabilities only · migrations run in the package namespace (P-04)
  Granted --> Inactive : migration failed → namespace unchanged
  Loaded --> Active : a person activates · schedules bind to a principal (ADR-157)
  Active --> Draining : upgrade → new version reaches Loaded
  Draining --> Inactive : in-flight envelopes complete
  Active --> Inactive : deactivate
  Inactive --> Loaded : reactivate
  Inactive --> [*] : unload (P-02)
  Rejected --> [*]
```

## Who may cause each transition

| Transition | Actor | Recorded as |
|---|---|---|
| install | admin (registry-gated) or a self-writing producer (S-01) | AuditEvent with source registry and version |
| validate, test | kernel | test verdict with evidence hash |
| grant | admin | Grant rows per capability |
| load | kernel | linked capability set, migration ledger |
| activate | a person, or a portal admin for a system service (ADR-157) | Activation naming the principal |
| upgrade | admin | old version drains; rollback = re-activate the previous Loaded version |
| deactivate, unload | admin | AuditEvent |

## Two hosts, one contract

```mermaid
flowchart LR
  M["Manifest + SDK interface (WIT)"] --> W["In-process sandbox host<br/>(wasmtime · component model)"]
  M --> X["Out-of-process host<br/>(Node · Python engines · anything with a runtime)"]
  W --> C["Capabilities linked = granted imports"]
  X --> C
  C --> K["control::admit on every host call"]
```

A capability a package did not declare is not linked in either host, so it cannot be called. The
out-of-process host exists for today's JavaScript packages and for Python engines; it speaks the same
interface over local IPC and is admitted identically.
