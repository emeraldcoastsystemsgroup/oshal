# 08 — Deployment topology by mode

One artifact, declared modes (ADR-137). Spec: [01 §4.11](../01-high-level-spec.md#411-deployment-modes-and-portability),
requirements D-01 to D-05.

```mermaid
flowchart TB
  subgraph demo["demo / home — one machine, one artifact, nothing else installed"]
    D1["oshald --mode demo|home"]
    D1 --- S1[("embedded relational")]
    D1 --- S2[("in-process stream")]
    D1 --- S3[("local embeddings")]
    D1 --- S4["cockpit shell (embedded assets)"]
    D1 --- P1["packages: in-process sandbox host + out-of-process host"]
  end
  subgraph ent["team / enterprise — same artifact, external stores"]
    E1["oshald --mode enterprise (controller)"]
    E2["oshald --role node × N"]
    E1 --- PG[("Postgres · RLS · governed role")]
    E1 --- RS[("Redis Streams")]
    E1 -. optional .- VG[("vector · graph")]
    E2 --- RS
    E2 --- PG
    ON["oshal-node on user-owned machines"] -- "device-bound token" --> E1
    EXT["external agents"] -- "A2A · default-off" --> E1
    IDP["OIDC providers · local auth"] --> E1
  end
```

## Process anatomy of `oshald`

```mermaid
flowchart LR
  subgraph bin["oshald process"]
    A["api · cli · channels"] --> C["control"]
    C --> O["orchestration"]
    O --> M["mesh"]
    O --> I["inference"]
    O --> T["intents"]
    C --> S["store"]
    P["packages (hosts)"] --> C
    OB["observe"] --- C
  end
  bin --> ST[("stores by mode")]
```

## Mode table

| Mode | Stores | Auth | Remote nodes | Packages |
|---|---|---|---|---|
| demo | embedded relational, in-process stream, local embeddings | open on loopback | refused | hot-load |
| home | embedded or external | invited users (local auth), device-bound tokens | allowed | hot-load |
| team / enterprise | Postgres + Redis; optional vector and graph | OIDC, multi-provider | allowed | hot-load, registry-gated |

## Startup and upgrade invariants

- Startup is order-independent: an unreachable store is a health state, never a crash (D-02).
- Kernel migrations are embedded and run on start; package migrations run at activation in the package
  namespace (P-04).
- Upgrade is an artifact swap; rollback is the previous artifact; a migration that cannot roll back is
  refused at review (D-03).
- Monitoring targets are inherited from package declarations, never hand-registered (D-05).
