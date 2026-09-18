# 12 — Identity, user lifecycle and settings precedence

Spec: [05 §A, §B, §C](../05-subsystem-specs.md#a-identity-sso-and-oidc).

## Identity: many providers, one canonical person

```mermaid
flowchart LR
  G["Google OIDC"] --> L
  M["Microsoft / Entra"] --> L
  O["Any OIDC provider row"] --> L
  LA["Local invited user + TOTP"] --> L
  MK["Mock (demo mode only)"] --> L
  L["Identity link records<br/>(issuer, subject) → PrincipalId"] --> P["Principal<br/>id · kind · subject · issuer · tenant"]
  NT["Node device-bound token"] --> PN["Principal kind = Bot or Service<br/>owner-scoped"]
  P --> D["control::admit"]
  PN --> D
```

- A provider is a row: issuer, client, discovery URL, enabled, auto-provision (A3, A4).
- `(issuer, subject)` is the key; subject alone is never a key (A1, I-01).
- Linking is explicit and audited; an unlinked identity inherits nothing (A2, I-03).

## Person lifecycle

```mermaid
stateDiagram-v2
  [*] --> Invited : admin invites (scoped to a tenant)
  Invited --> Active : accepts, links an identity
  Invited --> Expired : invitation lapses (single-use, expiring)
  Active --> Suspended : admin suspends
  Suspended --> Active : reinstated
  Active --> Deactivated : leaves
  Suspended --> Deactivated : leaves
  Deactivated --> Deleted : export or delete, person-scoped sweep
  Deleted --> [*]
  Expired --> [*]
```

Deactivation revokes sessions, node tokens and activations in one action (B5, U-02). State is evaluated
at the door on every entry kind (U-01).

## Settings precedence

```mermaid
flowchart TB
  Q["resolve(setting, principal)"] --> U{"user scope set?"}
  U -- yes --> UL{"locked above?"}
  UL -- no --> UV["value from user scope"]
  UL -- yes --> IV["inert: the locking scope wins, and the surface says so"]
  U -- no --> I{"package-install scope?"}
  I -- yes --> IV2["value from install scope"]
  I -- no --> T{"tenant scope?"}
  T -- yes --> TV["value from tenant scope"]
  T -- no --> DP{"deployment scope?"}
  DP -- yes --> DV["value from deployment scope"]
  DP -- no --> KD["kernel default (a record, not a literal)"]
  UV --> R["(value, winning_scope)"]
  IV --> R
  IV2 --> R
  TV --> R
  DV --> R
  KD --> R
```

| Rule | Requirement |
|---|---|
| One resolver, returning the value and which scope won | N-01 |
| Write permission is declared per scope | N-02 |
| A locked scope makes lower scopes inert and visible | N-03 |
| Unknown or ill-typed keys refused at write | N-04 |
| No literal where a setting exists | N-05 |

A bot's brain (ADR-162) is one instance of this resolver, not a separate mechanism.
