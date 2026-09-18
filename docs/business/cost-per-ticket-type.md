# What a ticket actually costs, by ticket type

The headline economics claim on every oshal surface — one persona-gated bot lands an incident RCA
for **$1.30 (n=1)** where a two-bot worker→reviewer pipeline cost **$4.05 (n=7 historical incident
tickets)** — is a *persona-iteration* measurement: one workload, one corpus, one model. It is real,
it is read from `chat_tasks.total_cost`, and it is **not a benchmark**. This page is the wider
picture that keeps it honest: every ticket type the operator's cluster has actually billed, with
the n behind each number.

**Generated, never hand-typed.** The table below is rendered from
[`cost-per-ticket-type.json`](cost-per-ticket-type.json) by
[`scripts/evidence/cost-per-ticket-type.ts`](../../scripts/evidence/cost-per-ticket-type.ts),
which reads `chat_tasks` joined to `tickets` through the product's own `ticket_task_links` inside a
`READ ONLY` transaction. Re-run it to refresh:

```bash
npx tsx scripts/evidence/cost-per-ticket-type.ts
```

`tests/unit/cost-claim-carries-its-n.spec.ts` fails if the published table stops matching the
artifact, and fails if any surface anywhere in the tree states either headline figure without the n
behind it and the limits around it.

## The census

<!-- CENSUS:START -->

| ticket type | tickets with cost | median $/ticket | range | LLM calls | window |
|---|--:|--:|---|--:|---|
| `build` | n=60 | $0.6434 | $0.0820 – $2.2386 | 162 | 2026-06-21 → 2026-07-20 |
| `intelligent-processing` | n=28 | $1.1376 | $0.4566 – $2.2697 | 54 | 2026-08-01 → 2026-08-02 |
| `task` | n=17 | $0.0489 | $0.0069 – $0.5787 | 15 | 2026-06-26 → 2026-08-04 |
| `daily-trade-recap` | n=8 | $0.0347 | $0.0107 – $0.2143 | 21 | 2026-06-26 → 2026-06-30 |
| `chat` | n=6 | $0.0101 | $0.0002 – $0.0214 | 4 | 2026-06-28 → 2026-08-13 |
| `federal-capture` | n=3 | $0.1440 | $0.0148 – $0.5540 | 3 | 2026-06-01 → 2026-06-29 |
| `incident` | n=2 | $1.8076 | $0.8622 – $2.7530 | 4 | 2026-04-26 → 2026-07-08 |
| `durable-probe` | n=2 | $0.4439 | $0.3828 – $0.5050 | 5 | 2026-07-05 → 2026-07-05 |
| `test-gate-flow` | n=2 | $0.2591 | $0.2483 – $0.2698 | 2 | 2026-06-22 → 2026-06-23 |
| `smoke-published-flow` | n=2 | $0.0347 | $0.0265 – $0.0430 | 2 | 2026-06-23 → 2026-06-23 |
| `capability-ideation` | n=2 | $0.0134 | $0.0084 – $0.0185 | 2 | 2026-08-01 → 2026-08-01 |
| `oshal-dev` | n=1 | $4.1254 | $4.1254 – $4.1254 | 1 | 2026-08-06 → 2026-08-06 |
| `sap-incident` | n=1 | $1.6072 | $1.6072 – $1.6072 | 1 | 2026-04-25 → 2026-06-23 |
| `cluster-probe` | n=1 | $0.5898 | $0.5898 – $0.5898 | 3 | 2026-07-05 → 2026-07-05 |
| `smoke-parallel-2` | n=1 | $0.5708 | $0.5708 – $0.5708 | 2 | 2026-06-24 → 2026-06-24 |
| `smoke-parallel-flow` | n=1 | $0.4536 | $0.4536 – $0.4536 | 2 | 2026-06-24 → 2026-06-24 |
| `workflow-build` | n=1 | $0.0501 | $0.0501 – $0.0501 | 1 | 2026-06-22 → 2026-06-23 |

<!-- CENSUS:END -->

## How to read it

- **The median is the number to quote, with its n and its range.** `build` and
  `intelligent-processing` are the only two types with a double-digit n; everything below them is a
  handful of tickets and moves a lot if one run goes long.
- **`incident` is the type the headline claim is about**, and its n here is small — which is
  precisely why the headline stays labelled as one workload rather than being promoted to a rate.
- **Harness fixtures are left in.** `smoke-*`, `*-probe` and `test-*` types are the platform testing
  itself; they are cheap and they are kept in the table so nobody can widen or narrow the n by
  choosing which rows to show.
- **Costs are LLM spend only** — what the provider billed for the calls linked to the ticket.
  Compute, storage and human time are not in it.
- **Each chat task is counted once.** A bot-node task is keyed by the workspace it runs in, so
  sibling subtasks dispatched into one workspace accumulate into one task row that is linked to
  each of them. That row is split evenly across its tickets — the ledger does not record which
  ticket drove which call — and the artifact's `totals` tie to its `ledger` block, which is the
  same rows read once. A census whose total exceeds its ledger fails the guard.

## What this still does not prove

This is a census of one operator's cluster, not a controlled comparison. It says what oshal charged
to do the work it was actually asked to do. It does **not** say what another framework would have
charged for the same tickets — that is the cross-framework benchmark in
[`bench/`](../../bench/README.md), whose oshal leg still reports `not-run`.
