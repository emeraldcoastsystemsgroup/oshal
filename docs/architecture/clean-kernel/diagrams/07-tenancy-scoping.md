# 07 — Tenancy and scoping

How one identity value scopes every store. Spec: [01 §4.8](../01-high-level-spec.md#48-multi-user-multi-tenant),
requirements T-01 to T-05.

```mermaid
flowchart TB
  E["verified claims<br/>subject · issuer · tenant"] --> P["Principal"]
  P --> T["Tenant"]
  P --> G{"Grant (principal, package)<br/>deny · viewer · editor · admin<br/>explicit deny wins"}
  G -- deny --> R["Refusal"]
  G -- viewer --> CR["Ctx&lt;Read&gt;"]
  G -- editor / admin --> CW["Ctx&lt;Write&gt;"]
  CW -- confirmation token --> CC["Ctx&lt;Confirmed&gt;"]
  CR --> K["key = derive(subject, tenant)<br/>one function for every store"]
  CW --> K
  CC --> K
  K --> REL["relational<br/>governed role · RLS owner_or_operator<br/>package schema namespace"]
  K --> VEC["vector (optional)<br/>collection = key / package"]
  K --> GR["graph (optional)<br/>database = key"]
  K --> BL["blob<br/>prefix = key / package"]
```

## Principal classes for non-interactive work (ADR-157)

```mermaid
flowchart LR
  S["declared schedule in a manifest"] --> A{"activated?"}
  A -- no --> X["tick refused and recorded (T-04)"]
  A -- "by a person" --> U["runs as that person's Principal"]
  A -- "by a portal admin as a system service" --> Y["runs as a system-service Principal<br/>with its own grants"]
  U --> D["control::admit"]
  Y --> D
```

## Invariants

- Nothing derives a key from anything but (subject, tenant). The derivation function is the isolation
  boundary and is guarded like the token broker (T-01).
- The governed database role's grants are converged from one declared contract at boot; a migration
  cannot widen them (T-02).
- Guest access is a seeded principal with a declared capability matrix, admitted like any other (T-05).
- Enterprise authorization (ADR-149) and app access tiers (ADR-118) are the only grant vocabulary.
