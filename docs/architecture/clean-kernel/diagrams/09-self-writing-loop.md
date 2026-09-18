# 09 — The self-writing loop

The platform authors packages through the same gate a human uses, and proposes kernel changes it
cannot merge itself. Spec: [01 §4.9](../01-high-level-spec.md#49-self-writing-loop), requirements S-01 to S-04.

```mermaid
flowchart TB
  subgraph producers["Producers (all emit packages, never kernel code)"]
    PK["packer (interview → persona + manifest)"]
    SI["skill import (SKILL.md → package, scripts quarantined)"]
    ST["studio publish (canvas → workflow manifest)"]
    DB["developer bot"]
    CL["capability loop"]
  end
  PK --> PKG["package directory<br/>manifest · routes · bots · tools · tests"]
  SI --> PKG
  ST --> PKG
  DB --> PKG
  CL --> PKG
  PKG --> REG["trusted registry row (ADR-147)"]
  REG --> GATE["the same gate as a human package<br/>validate → sandbox test → grant"]
  GATE --> INACT["Inactive until a person activates (S-02)"]
  INACT --> ACT["Active"]

  DB -. "kernel change needed" .-> PR["branch + pull request + publish gate"]
  PR --> HUMAN["human review and merge (S-04)"]
  HUMAN -. never .-> SELF["platform merging into itself"]
  SA["super-admin role<br/>distinct · double-gated (ADR-077)"] --- DB
```

## Trust ladder for the developer bot (ADR-077 carried forward)

| Level | May do | Gate |
|---|---|---|
| L0 | read the tree, propose a plan | super-admin enabled |
| L1 | author a package into a registry | S-01, S-02 |
| L2 | open a kernel pull request | S-04; publish gate |
| L3 | none: the platform never merges into itself | by construction |

## Verdict integrity in the sandbox (P-05)

- zero tests executed → not a pass
- a declined or skipped run → `pending`, never green
- truncated or lost evidence → `pending`
- the verdict names the evidence hash it was computed from
