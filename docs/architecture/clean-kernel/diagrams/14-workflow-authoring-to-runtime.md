# 14 — Workflow authoring to runtime

Design time compiles into the runtime. There is no second execution engine. Spec:
[07 §L](../07-subsystem-specs-2.md#l-workflow-authoring-and-execution).

```mermaid
flowchart TB
  subgraph design["Design time"]
    C["Studio canvas"]
    NL["Natural-language draft<br/>(a producer, never an installer)"]
    M["Hand-written manifest"]
    NL --> C
  end
  C --> DEF["Workflow definition<br/>nodes · edges · bounds · gates"]
  M --> DEF
  DEF --> V{"Validation (total, before install)"}
  V -- "unresolved node · unsatisfied input · unreachable node · unbounded loop" --> REJ["Rejected with the failing node named"]
  V -- ok --> PKG["Compiled into a package<br/>(passes the normal package gate)"]
  PKG --> REG["Workflow registry"]
  REG --> SHAPE{"Shape derived from the definition"}
  SHAPE -- "one bot, one phase" --> S1["single-shot"]
  SHAPE -- "ordered phases, optional gates" --> S2["staged"]
  SHAPE -- "branching, parallel, join" --> S3["graph"]
  S1 --> ENG["One execution engine<br/>dispatcher + envelopes"]
  S2 --> ENG
  S3 --> ENG
  ENG --> GATE{"Approval gate on this phase?"}
  GATE -- yes --> AP["Named principal approves → Ctx&lt;Confirmed&gt;"]
  GATE -- no --> RUN["Phase runs"]
  AP --> RUN
  RUN --> REC["Run record<br/>definition version · inputs · per-phase outcome · cost"]
  REC --> OPT["input to token optimization (diagram 15)"]
```

## What the picture forbids

| Forbidden | Requirement |
|---|---|
| A published workflow that lives outside the package model | F-01 |
| A definition that installs without total validation | F-02 |
| A second engine per shape | F-03 |
| A gate a model can satisfy | F-04 |
| An unbounded loop or fan-out | F-06 |

## Why run records matter twice

They make a run explainable now and comparable later. Counterfactual optimization (diagram 15) replays
them; without a complete record there is nothing to replay and no baseline to beat.
