# Payroll — operator guide

`?app=payroll` runs payroll for your own company: employees with W-4 profiles, pay runs with live
tax math, printable stubs, and quarterly-liability plus W-2-preview reports.

**Package:** `payroll/` in the [oshal-applications](https://github.com/emeraldcoastsystemsgroup/oshal-applications)
store repo ([ADR-085](../adr/085-remote-app-packages-and-registries.md)). **Design:** [ADR-123](../adr/123-payroll-app.md).
**Suite:** `ai-finance`. **Access:** `guestTier: blocked` — payroll data is employee PII.

> **oshal computes payroll and produces the artifacts; your bank and EFTPS execute them.** It
> generates the NACHA ACH file your own bank uploads, Form 941/940 worksheets with real line values,
> and issuable W-2s — but it **transmits nothing**. No e-filing to the IRS or SSA, no EFTPS deposit
> initiation, no check printing. No money moves through oshal and no third-party payroll provider is
> involved, which is deliberate: an embedded provider would compute its own withholding and this
> engine would become decorative.

## The daily loop

1. **Settings** — company name, pay frequency (weekly / biweekly / semimonthly / monthly), state,
   SUTA rate and wage base, and any FUTA credit reduction. Leave "shift a weekend pay date" on
   unless you deliberately pay on weekends.
2. **Employees** — add each person: salary or hourly, their 2020+ W-4 (filing status, Step 2
   checkbox, Step 3 credits, 4a/4b/4c), pre-tax elections (401(k) %, Section-125 health premium),
   post-tax (Roth %, other), work state, and birth date if they qualify for a 401(k) catch-up.
3. **Run payroll → New pay run** — drafts the next period from your frequency with a line for every
   employee actually employed during it. Edit hours, overtime, bonus, tips and reimbursements; every
   edit recomputes server-side with year-to-date awareness.
4. **Read the warnings.** Anything the engine is unsure about — a capped 401(k) deferral, an
   unsupported state, a negative net — appears in a red panel above the register. It is there to be
   read before you approve, not after.
5. **Approve & record.** This is the money action: it requires an explicit confirmation, stamps who
   approved it and when, and makes the run immutable.
6. **Pay stubs** — printable per employee per run, showing the period components and year-to-date.

## Paying people and filing

**Pay & file** is where a computed run becomes money and paperwork.

- **Direct deposit.** Pick a paid run and download the `.ach` file, then upload it to your bank's ACH
  portal. Set your bank's routing number, your bank's name and your ACH company identifier (usually
  `1` + your EIN) in Settings first — your bank assigns that identifier and it must match what they
  have on file. Send a **prenote** first if they want accounts validated: it is the same file with
  zero-dollar entries. Employees paid by check need no file.
- **Form 941** (quarterly) and **Form 940** (annual FUTA) produce the numbered lines you transcribe
  onto the return. Both carry a reconciliation: if the form's own arithmetic disagrees with the tax
  actually withheld, it says so and by how much, because that gap means a wage base or threshold was
  applied inconsistently somewhere.
- **W-2.** Once the SSN, EIN and both addresses are on file, the W-2 is a real document rather than a
  preview. Producing one is confirm-gated and recorded on the audit trail, because it decrypts the
  SSN and the EIN. If identity is incomplete you get `issuable: false` and the exact list of what is
  missing.

The generated ACH file is deliberately strict — 94-character records, blocked to a multiple of ten,
with an entry hash and control totals that must reconcile. Banks reject the whole file on any one of
those, so it is checked before you ever see it; if something is wrong you get the specific problems
rather than a file that fails at the bank.

## Correcting a mistake

A paid run is never edited. Instead, **Void this run** appends a linked reversal — a run whose every
amount is the exact negation of the original. Year-to-date totals, the quarterly liability report and
the W-2 preview are all sums over the same ledger, so they self-correct; the original stays as
history and the register still ties one-to-one to physical checks. Void, then create a fresh run with
the right numbers.

A void cannot itself be voided, and a run can only be voided once (enforced by a unique index, not
just by the handler). A *draft* is not voided — discard it.

## Mid-year switch from another payroll provider

Open the employee and fill in **Prior year-to-date**. Those figures feed the Social Security wage
base, the FUTA/SUTA bases and the 401(k) annual limit so the rest of the year is computed correctly.
They are deliberately **excluded from the W-2 preview** — your previous provider issues its own W-2
for the wages it paid, and adding them here would double-count.

## What the tax math actually does

Federal withholding follows the IRS Pub 15-T percentage method for automated payroll systems
(Worksheet 1A). FICA applies Social Security at 6.2% up to the annual wage base and Medicare at
1.45% with no cap, plus the additional 0.9% above $200,000 of wages from this employer (no employer
match on that part). Section-125 health premiums reduce both FIT and FICA wages; 401(k) deferrals
reduce FIT only — the two pre-tax classes are handled distinctly because the law treats them
differently. Employer accruals cover the FICA match, FUTA and SUTA against their own wage bases.

Every constant is verified against the retrieved primary document and cites it inline in
`payroll-tax-tables.ts`. Bonuses can be withheld either aggregated with regular wages (the default)
or at the 22% supplemental flat rate, with the mandatory 37% applied above $1,000,000 for the year.

**A new tax year invalidates the tables.** They are data with citations, not logic — re-verify them
against that year's publications before running a live payroll.

## State coverage — read this before trusting a number

State withholding has exactly four outcomes, and the app always tells you which one you got:

| Outcome | States | What happens |
|---|---|---|
| No wage income tax | AK, FL, NH, NV, SD, TN, TX, WA, WY | Withholds a **known** zero. |
| Verified flat rate | PA (3.07%), IL (4.95% less $2,925/allowance), KY (3.5% after a $3,360 deduction) | Computed from the verified table. |
| Verified progressive | MO (eight brackets, whole-dollar rounding) | Computed from the verified schedule. |
| **No verified table** | everything else | Falls back to the flat rate you entered **and warns you**. If you left that rate at zero, the warning is louder — a silent zero for a state that taxes wages is the worst thing this could do. |

Indiana and North Carolina are deliberately absent with reasons recorded in the code: Indiana's
mandatory county tax means a state-only rate would under-withhold everyone, and North Carolina sets
its withholding rate above its tax rate in a way that could not be confirmed from the primary source.

**Not modelled at all:** local and city taxes (Indiana counties, Ohio municipalities, PA Act 32
EIT/LST, NYC and Yonkers, Maryland county piggyback, Michigan cities), state disability and
paid-leave contributions (CA SDI, NY DBL/PFL, NJ TDI/FLI, WA PFML and Cares, MA/CT/OR/CO PFML),
reciprocity agreements, and multi-state allocation.

## Tax year 2026 reporting (OBBBA)

The OBBBA deductions for tips and overtime are claimed by the **employee** on their return — they are
not employer withholding exclusions, so tips and overtime stay fully taxable here. What changed for
payroll is *reporting*, and 2026 is the first mandatory year:

- **Box 12 code TT** — qualified overtime, which is only the FLSA half-time **premium** (the "half"
  of time-and-a-half), never the whole payment. Mark a line's overtime as non-FLSA when it comes from
  a union contract, employer policy, or a state-only daily-overtime rule; it is still paid and taxed,
  just not reportable as qualified.
- **Box 12 code TP** — cash tips, with the Treasury tipped-occupation code in box 14b from the
  employee's profile.

## Other known gaps

**Nothing transmits.** No e-filing to the IRS or SSA (the SSA's EFW2 electronic W-2 format is not
generated), no EFTPS deposit initiation, no check printing, and no handling of ACH returns or
notifications of change when your bank bounces an entry back.

Also absent: employee self-service (one login is still the whole company), 1099 contractors, PTO and
leave accrual, workers' compensation and employer benefit contributions, the pre-2020 Form W-4
allowances path, and segregation of duties between whoever prepares a run and whoever approves it.
Overpayment repayment spanning tax years is deliberately out of scope because it carries genuinely
different tax treatment — approximating it would be worse than refusing. Pay dates shift off
weekends but not off bank holidays.

All of these are tracked in [BACKLOG.md](../BACKLOG.md) with done-when criteria.

## Tests

`payroll/tests/` runs dependency-free `node --test` suites against the **compiled** route modules —
the same bytes the framework mounts. They include executable proofs that the engine reproduces Pub
15-T Worksheet 1A exactly in both W-4 modes, the Missouri DOR's own worked example, wage-base and
threshold crossings, the gross↔net identity, hostile-input hardening, both confirm gates with the
database provably untouched, void-run negation, and a sweep proving no payroll query reaches the
database without a tenant predicate. Wired as the `payroll` job in the store repo's CI.
