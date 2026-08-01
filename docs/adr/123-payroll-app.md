# ADR-123: Payroll — a deterministic ADP-style payroll app; no LLM computes a dollar

**Status:** Accepted (2026-08-01) — **v1.0 shipped** (store PR #33), **v1.1 shipped** the same day
adding the correction mechanism, primary-source verification of every tax constant, and the
tax-year-2026 reporting accumulators that OBBBA made mandatory.
Shipped: the pure engine `src-routes/payroll-engine.ts` over versioned constants in
`src-routes/payroll-tax-tables.ts` and `src-routes/payroll-state-tax.ts`, persistence in
`src-routes/payroll-store.ts`, `/api/payroll` routes with confirm-gated approve and void actions,
the `?app=payroll` surface, and dependency-free `node --test` guards run as the `payroll` store-ci job.
**Package:** `payroll/` in the oshal-applications store repo ([ADR-085](085-remote-app-packages-and-registries.md)).
**Related:** [ADR-036](036-bot-owned-application-architecture.md) (why a deterministic app has no bot),
[ADR-097](097-app-suites-primary-categorization.md) (`suite: ai-finance`),
[ADR-118](118-app-access-tiers.md) (`guestTier: blocked`).

## Context

The operator asked for "the payroll system, ADP style." Payroll is the first oshal application whose
output is a **legally consequential number attached to a named person**. A wrong recommendation in a
research app costs a re-read; a wrong paycheck costs an employee real money and exposes the employer
to penalties. That difference drives every decision below.

Three constraints shaped it:

- **An LLM must never compute a paycheck.** Not "should not" — must not. Tax withholding is a
  published, fully specified arithmetic procedure (IRS Pub 15-T Worksheet 1A). A language model
  reproducing it is strictly worse than the arithmetic: non-deterministic, unauditable, and confident
  when wrong. This is the same principle as [ADR-122](122-model-is-untrusted-principal.md) approached
  from the other side — the authority lives outside the model.
- **Rule 0c: application code never mixes with swarm code.** Payroll is a store package. The only
  thing it puts in the core repo is this ADR and its docs.
- **The honest-coverage problem.** A payroll product is judged on the states, edge cases, and filings
  it handles. The tempting failure is to ship a plausible-looking table for all fifty states. A wrong
  table is worse than an absent one, because the operator cannot tell it is wrong.

Tax constants carry a second, subtler risk: a model's recollection of "the 2026 standard deduction"
is a plausible number, not a verified one, and it will look exactly as confident either way.

## Decision

1. **The tax math is arithmetic over versioned data, with the engine as a pure function.**
   `payroll-engine.ts` exports `computePaycheck` — no I/O, no clock, no framework, integer cents in
   and out. Every figure it uses lives in `payroll-tax-tables.ts` / `payroll-state-tax.ts`. Updating
   a tax year replaces data, never logic. No LLM sits anywhere in this path, and the package declares
   no bot and no `ticketType` at all.

2. **Every constant is verified against the retrieved primary document, and cites it in place.**
   Not from recall. `payroll-tax-tables.ts` carries a provenance block plus per-constant `VERIFIED:`
   comments naming Rev. Proc. 2025-32 §4.01 (the rate tables), the SSA 2026 COLA release (the
   $184,500 wage base), Pub 15-T (2026) (the method and supplemental rates), Notice 2025-67 (the
   402(g) limits), and the Florida DOR rate page. A new tax year invalidates the file, and the header
   says so.

3. **The Pub 15-T equivalence is proven in tests, not asserted in prose.** The engine subtracts the
   full standard deduction and applies the Rev. Proc. brackets; Pub 15-T instead subtracts Worksheet
   1A line 1g ($8,600 / $12,900) and carries the remainder in each schedule's 0% band. These are the
   same computation — `line 1g + the 0% band == the standard deduction` — and for a checked Step 2
   box, line 1g is zero while every threshold and the deduction are exactly halved, which is the
   engine's `scale = 0.5`. Both identities are executable assertions in
   `tests/payroll-engine.test.mjs`, with worked figures ($3,820 and $6,585 on $50,000 single).

4. **A paid run is an immutable ledger entry; corrections are contra-entries.** No route mutates a
   paid run. `POST /runs/:id/void` appends a linked run of kind `void` whose every signed column is
   the negation of the original, produced by a single `INSERT … SELECT -col` inside a transaction.
   Year-to-date sums, the quarterly liability report, and the W-2 preview all self-correct because
   they are sums over the same ledger. A unique partial index keyed on `kind = 'void'` makes
   double-voiding impossible in the database rather than merely unlikely in the handler.

5. **Coverage is declared, never implied.** `payroll-state-tax.ts` has exactly four outcomes and the
   caller can always tell which one it got: a verified `none` / `flat` / `brackets` rule, or **no
   rule** — in which case the operator's manually entered rate is used and the engine emits a warning.
   When that manual rate is also zero, the warning is louder still, because silently withholding
   nothing for a state that taxes wages is the most dangerous thing the module could do. States
   researched and deliberately not shipped (Indiana, North Carolina) sit in `KNOWN_UNSUPPORTED` with
   the reason recorded, so the decision is not silently re-litigated.

6. **The money actions are confirm-gated and attributed.** Approving a run and voiding a paid one
   both require `confirm: true` (HTTP 428 otherwise, with the database provably untouched) and both
   record the approving OIDC sub and timestamp. One sub is one company: all four tables are
   `user_sub`-scoped with tier-1 owner RLS applied at the lazy-DDL chokepoint, and a test sweeps
   every route to prove no payroll query reaches the database without a tenant predicate.

## Consequences

- Adding a tax year, a state, or a rate is a data edit with a citation — the reviewable unit is a
  number and its source, not a code path.
- The engine is trivially testable, so the guards are strong: hand-derived known values, wage-base and
  threshold crossings, the gross↔net identity, and hostile-input hardening all run against the
  compiled bytes the framework actually mounts.
- The void design keeps the register tying 1:1 to physical checks, so a pay stub stays reproducible
  from stored rows. The cost is that a correction is always two records, and an operator who wanted
  "just edit the number" has to void and reissue instead.
- **The app records payroll; it does not move money or file anything.** No ACH or direct deposit, no
  941/940 filing, no tax deposits. The W-2 output is explicitly a *preview*. Those are regulated
  activities better reached through a provider integration than reimplemented.
- **Honest coverage limits, stated rather than hidden:** four states ship with verified withholding
  tables (PA, IL, KY flat; MO progressive) plus the nine no-wage-income-tax states. Every other state
  falls back to an operator-entered rate *with a warning*. Local and city taxes (Indiana counties,
  Ohio municipalities, PA Act 32, NYC/Yonkers, Maryland county), state disability and paid-leave
  contributions (CA SDI, NY PFL, NJ TDI, WA PFML), reciprocity, and multi-state allocation are not
  modelled at all.
- **Also not modelled, and deliberately so:** the pre-2020 Form W-4 allowances path; overpayment
  repayment across tax years (which has genuinely different tax treatment and getting it backwards is
  an IRS violation); garnishment limits under the CCPA disposable-earnings caps; PTO and leave
  accrual; workers' compensation and employer benefit contributions. These are listed in the backlog
  with done-when criteria rather than approximated.
- A mid-year switch from another payroll provider is supported only through the prior-YTD fields on
  the employee, which feed the wage-base caps but are deliberately **excluded** from the W-2 preview —
  the prior provider issues its own W-2, and adding the figures would double-count.
- Because the whole surface is one company per login, there is no employee self-service: an employee
  cannot log in to fetch their own stub. That is a real product gap, not an oversight.
