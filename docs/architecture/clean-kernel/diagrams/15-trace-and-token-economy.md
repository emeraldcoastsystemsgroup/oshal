# 15 — The trace and cost spine, and counterfactual optimization

One set of records answers three questions: what happened, what it cost, and whether it could cost
less. Spec: [07 §M, §N](../07-subsystem-specs-2.md#m-token-optimization-and-cost-efficiency).

## The spine

```mermaid
flowchart LR
  E["entry"] --> AD["admission span<br/>trace_id created"]
  AD --> PH["phase span<br/>trace_id propagated in the envelope"]
  PH --> CA["call span<br/>one per inference or intent call"]
  CA --> CE["CostEvent<br/>SAME id as the call span"]
  PH --> SH["status-history row"]
  CA --> RR["run record<br/>inputs · redacted prompt · outputs"]
  CE --> LED[("one ledger")]
  SH --> TR["Trace = assembled from these rows only"]
  RR --> TR
  LED --> TR
  LED --> BUD["budgets"]
  LED --> UI["cockpit totals"]
```

Three span kinds and nothing else: admission, phase, call (N3). A missing row is a visible gap, never
a synthesized span (N1, G-02). Call spans and cost events share an id, so totals reconcile by
construction rather than by a hand-written join (N4, G-03).

## Counterfactual optimization

```mermaid
sequenceDiagram
  autonumber
  participant R as recorded runs (checkpoints)
  participant O as optimizer
  participant J as judge (own budget)
  participant L as ledger
  participant S as settings

  O->>R: pick an incumbent run + a checkpoint
  O->>O: verify determinism by replaying the incumbent
  alt not reproducible
    O-->>O: disqualify, report non-deterministic
  else reproducible
    O->>R: replay a candidate (prompt · context · cache · model · phase)
    O->>J: score incumbent vs candidate output
    J-->>O: quality verdict (judging cost recorded)
    O->>L: savings = incumbent cost − candidate cost − judging cost
    alt clear win on cost AND non-inferior quality
      O->>S: promote as a scoped settings write (audited, reversible)
    else tie or worse
      O-->>O: keep the winner
    end
  end
```

| Rule | Requirement |
|---|---|
| Never experiment on live person work | K-01 |
| Savings net of judging cost, quality non-inferior | K-02 |
| Non-reproducible replay disqualified | K-03 |
| Promotion is an audited, reversible settings write | K-04 |
| Claimed savings reconcile against the ledger | K-05 |
| Eliding a phase needs human approval | K-06 |

The lever order by blast radius is prompt shape, context selection, cache reuse, model choice, phase
elision. The first four are reversible by a settings write; the last changes the product, which is why
it is gated.
