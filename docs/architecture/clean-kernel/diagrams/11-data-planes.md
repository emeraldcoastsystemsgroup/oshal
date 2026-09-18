# 11 — Data planes: connectors, knowledge, time series

Three data rails that share one key function and one admission door. Spec:
[05 §G, §H, §I](../05-subsystem-specs.md#g-connector-framework).

```mermaid
flowchart TB
  CTX["Ctx from control::admit<br/>principal · tenant · grants"] --> KEY["scope_key(subject, tenant)"]

  subgraph conn["Connector plane — someone else's system"]
    DECL["Connector declaration<br/>auth shape · scopes · operations"]
    BROKER["Token broker<br/>holds values · issues SecretRef"]
    OP["Intent handler<br/>input schema → normalized + redacted"]
    AUD["Action audit<br/>principal · connector · operation · outcome"]
    DECL --> OP
    BROKER -. "resolve, never return" .-> OP
    OP --> AUD
  end

  subgraph know["Knowledge plane — retrieval"]
    ING["Ingestion (package-fed)"]
    CHK["Chunker"]
    EMB["Embedding trait<br/>local ONNX · hosted · in-database"]
    IDX[("Index<br/>vector + lexical")]
    RET["Hybrid retrieval + fusion"]
    ACL["Permission filter<br/>same grants as the door"]
    ING --> CHK --> EMB --> IDX
    IDX --> RET --> ACL
  end

  subgraph ts["Time-series plane — high-rate append"]
    DEC2["Series declaration<br/>keys · schema · retention · rollups"]
    ENG[("Engine trait<br/>hypertables · partitions · sqlite")]
    ROLL["Declared rollups"]
    DEC2 --> ENG --> ROLL
  end

  KEY --> OP
  KEY --> IDX
  KEY --> ENG
  OP --> MODEL["normalized result may reach reasoning"]
  ACL --> MODEL
  ROLL --> OBS["observe · surfaces"]
  BROKER -. never .-> MODEL
```

## The three invariants this picture encodes

| Invariant | Where |
|---|---|
| A credential value never reaches reasoning | the dashed "never" edge from the broker to the model |
| A retrieval returns only what the principal could read directly | the permission filter sits between the index and any consumer |
| Every plane derives its namespace from one key function | the three edges out of `scope_key` |

## Why time series is its own plane

Retention, rollups and late-point behavior are declared per series and enforced by the engine. An
append-only table without them becomes an outage on a delay, which is why an undeclared retention is a
load-time refusal (M-01).
