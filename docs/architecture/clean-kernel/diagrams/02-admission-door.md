# 02 — The one door: admission sequence

Every entry kind goes through `control::admit()`. The handler never sees the raw entry; it receives a
`Ctx` and derives scoped handles from it. Spec: [01 §4.2](../01-high-level-spec.md#42-the-one-door),
requirements C-01 to C-08.

```mermaid
sequenceDiagram
  autonumber
  participant E as Entry adapter<br/>(http · stream · tick · package-call · cli · channel)
  participant D as control::admit
  participant I as Identity
  participant G as Grants + Budget
  participant O as observe
  participant H as Handler
  participant S as Scoped handles<br/>(store · inference · intents · files · notify)

  E->>D: Entry (raw, untrusted)
  D->>I: verify claims (subject, issuer, tenant)
  I-->>D: Principal
  D->>G: tier for (principal, package) · budget for scope
  G-->>D: Tier · Budget
  alt refused (no identity · deny tier · over budget · missing confirmation)
    D->>O: AuditEvent(refusal, reason code)
    D-->>E: Refusal(code)
  else admitted
    D->>O: open TraceSpan(principal, tenant, package)
    D-->>H: Ctx (Read | Write | Confirmed)
    H->>S: derive from Ctx
    S-->>H: rows · results (RLS-bound, cost-attributed)
    H-->>D: Response
    D->>O: close span · AuditEvent · CostEvents
    D-->>E: Response
  end
```

## What the door guarantees

| Guarantee | Mechanism |
|---|---|
| No handler runs without a `Ctx` | handler signature requires one; only `control` can construct it |
| Identity is derived once | `Principal` is built from verified claims including issuer at step 2 and never re-read |
| Write needs a grant, confirmed write needs the token | `Ctx<Write>` requires tier ≥ editor; `Ctx<Confirmed>` requires the confirmation (ADR-105) |
| One span, one audit event, cost events | emitted at steps 7 and 12 by the door, never by handlers |
| Refusals are typed and recorded | step 5 to 6; no silent fallback (P9) |

## Entry kinds and what they carry

| Entry | Identity source | Notes |
|---|---|---|
| http | OIDC session, local-auth session, node token, service token | multipart and streaming bodies carry the same identity as JSON |
| stream message | envelope's bot principal | a bot re-enters the door as itself (P4) |
| schedule tick | the activation's principal (ADR-157) | an unactivated schedule is refused at step 5 |
| package call | the calling package's granted capability set | a capability not granted is not linked, so it never reaches the door |
| cli | local operator session or root | root is a database row, not a flag |
| channel | verified channel link → principal | unlinked channel input is refused |
