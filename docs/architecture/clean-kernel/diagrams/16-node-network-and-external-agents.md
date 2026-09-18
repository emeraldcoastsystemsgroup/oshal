# 16 — Node network, overlay and external agents

Four ways something outside the kernel process participates, and the one rule they share. Spec:
[07 §R, §S](../07-subsystem-specs-2.md#r-external-agents-and-a2a).

```mermaid
flowchart TB
  subgraph paths["Network paths — all equivalent to admission"]
    LAN["LAN"]
    NET["Public internet + TLS"]
    OVL["Overlay (Headscale / Tailscale)"]
  end
  subgraph parties["Who is on the other end"]
    LN["Local node<br/>(same machine, still enrolled)"]
    RN["Remote node<br/>user-owned machine, harness or devices"]
    DV["Device / peripheral<br/>reached only via its owning node"]
    XA["External agent<br/>not oshal-aware"]
  end
  LN --> LAN
  RN --> LAN
  RN --> NET
  RN --> OVL
  DV --> RN
  XA --> NET
  LAN --> D["control::admit"]
  NET --> D
  OVL --> D
  D --> T{"Credential and grants"}
  T -- "device-bound leased token + owner scope" --> OK1["node work: claim envelopes, run, report"]
  T -- "per-agent credential + scopes (gateway enabled)" --> OK2["external work: read scopes and named intents"]
  T -- "overlay membership only" --> NO["Refused: reachability is not authorization"]
```

## The rule the diagram exists to state

**Being reachable is not being authorized (S3, Z-03).** An overlay is a transport convenience. A node
on the overlay with no valid lease is refused exactly like a stranger on the internet.

## Enrollment and lease

```mermaid
stateDiagram-v2
  [*] --> Claimed : person proves ownership (codeless install link)
  Claimed --> Leased : device-bound token issued, owner-scoped
  Leased --> Active : heartbeats within the lease window
  Active --> Leased : lease renewed
  Active --> Expired : heartbeats stop
  Expired --> Leased : re-enrols
  Expired --> [*] : revoked by owner or admin
  Active --> [*] : revoked (in-flight envelopes re-queued)
```

An expired lease releases in-flight envelopes for re-queue with an attempt count (S4, Z-04). A node is
disposable: it holds no authority beyond its lease and no state that cannot be re-created (S8).

## External agents sit lower

| | node | external agent |
|---|---|---|
| Identity | device-bound leased token, owner-scoped | per-agent credential with scopes |
| Default ceiling | may run bot work its owner holds | read scopes and named intents only |
| Confirmed context | possible, through the door as the bot | never by default (R4, Y-03) |
| Discovery | not discoverable | curated card, absent unless enabled (R1, R2) |
| Outbound | claims envelopes | called as a schema-bounded, budgeted, audited intent (R5) |
