# 01 — Crate dependency graph

The build-enforced layering. An arrow means "depends on". Cargo rejects a cycle, so the direction of
every edge is a property of the build, not a lint. Spec: [01 §4.4](../01-high-level-spec.md#44-dependency-structure).

```mermaid
flowchart BT
  KT["kernel-types<br/>objects only · zero I/O · zero external deps"]
  CT["control<br/>admit() · identity · tenancy · grants · budgets · audit"]
  OB["observe<br/>spans · audit sink · metrics · redaction"]
  ST["store<br/>trait Store · postgres (RLS) · sqlite (single-node)"]
  ME["mesh<br/>trait Stream · redis-streams · in-process"]
  IN["inference<br/>trait Provider · hosted · byo · local endpoint"]
  IT["intents<br/>schema-bounded ops · SecretRef resolves here only"]
  OR["orchestration<br/>tickets · envelopes · workflows · activations"]
  PK["packages<br/>manifest · loader · capability grants · hosts"]
  SDK["sdk<br/>versioned · depends on kernel-types only"]
  API["api (axum)"]
  CLI["cli"]
  CH["channels<br/>email · telegram · voice"]
  D(("oshald<br/>single binary"))
  N(("oshal-node<br/>harness adapter"))

  CT --> KT
  OB --> KT
  CT --> OB
  ST --> CT
  ME --> CT
  IN --> CT
  IT --> CT
  OR --> ST
  OR --> ME
  OR --> IN
  OR --> IT
  PK --> OR
  PK --> SDK
  SDK --> KT
  API --> PK
  CLI --> PK
  CH --> PK
  D --> API
  D --> CLI
  D --> CH
  N --> SDK

  classDef entry fill:#eef,stroke:#446;
  classDef leaf fill:#efe,stroke:#464;
  class API,CLI,CH entry;
  class KT,SDK leaf;
```

## Rules the graph encodes

| Rule | Enforced by |
|---|---|
| Edges point upward only; no cycles | Cargo workspace resolution |
| `api`, `cli`, `channels` cannot name `store`, `mesh`, `inference` or `intents` | they are not in those crates' `Cargo.toml`; a deep import does not resolve |
| Packages compile against `sdk` and nothing else | `sdk` is the only crate published for package builds; the loader refuses an SDK range the kernel does not satisfy |
| `kernel-types` never gains an I/O dependency | a workspace test asserts its dependency list is empty |
| `SecretRef` can be created in `control` and resolved only in `intents` | the resolving function is `pub(crate)`; no other crate can call it |

## Forbidden edges (examples the build rejects)

- `api → store` (a handler reaching a raw connection)
- `orchestration → api` (the runtime depending on a transport)
- `sdk → control` (a package seeing the door's internals)
- `inference → intents` (a provider touching a credential)
