# Payroll — operator guide

`?app=payroll` runs payroll for your own company: employees with W-4 profiles, pay runs with live
tax math, printable stubs, and quarterly-liability plus W-2-preview reports.

**Package:** `payroll/` in the [oshal-applications](https://github.com/emeraldcoastsystemsgroup/oshal-applications)
store repo ([ADR-085](../adr/085-remote-app-packages-and-registries.md)). **Design:** [ADR-123](../adr/123-payroll-app.md).
**Suite:** `ai-finance`. **Access:** `guestTier: blocked` — payroll data is employee PII.

> **oshal computes payroll and produces the artifacts; your bank and the tax agencies execute
> them.** It generates the NACHA ACH file, printable checks, Form 941/940 and Florida RT-6
> worksheets, issuable W-2s and the SSA EFW2 submission — and then reads your bank's returns back in
> so a failed deposit is visible. But it **transmits nothing**: no e-filing, no EFTPS deposit
> initiation, no upload happens from here. No money moves through oshal and no third-party payroll
> provider is involved, which is deliberate: an embedded provider would compute its own withholding
> and this engine would become decorative.

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

- **Florida RT-6** (quarterly reemployment tax) is the first state return, built from the same ledger
  and reconciled against the reemployment tax actually accrued. Florida's $7,000 wage base is per
  employee per calendar year, so the return carries each person's year-to-date forward — the same
  trap Form 940 has. It does not fill in the payment coupon's OCR scanline; no published document
  describes that string's structure, and a wrong one misroutes the payment.
- **Electronic W-2 (SSA EFW2)** builds the file you upload to Business Services Online. Set your BSO
  User ID and a contact e-mail in Settings first — SSA rejects a submission without them. Run it
  through **AccuWage Online** before uploading: AccuWage checks the format, not whether names and
  Social Security numbers match SSA records. **The layout is verified per tax year and an unverified
  year is refused by name rather than guessed** — tax year 2026 adds Box 12 codes TT and TP, which
  have no field in the verified 2025 layout.

## Settlement — did everyone actually get paid?

Approving a run says who *should* be paid. The **Settlement** tab answers who was.

- **Import returns.** Paste the file your bank hands back. A **return** (R01 insufficient funds, R02
  account closed, R03 no account) means the money came back and that person is unpaid; the run
  surfaces them, and the code carries its statutory consequence — R01 may be reinitiated at most
  twice, while most others require that you stop sending to that account entirely. A **notification
  of change** is the opposite: the payment succeeded, and the bank is correcting the account details
  for next time. Applying one asks you to confirm, then re-checks the ABA check digit before writing.
- **This only works if the ACH file was generated by this version.** A return identifies its entry
  only by the original trace number, so runs whose file predates v2.2 show as "no ACH trace
  recorded" and must be matched by hand.
- **Print checks.** Numbers come from a sequence that can never reissue one. **No MICR line is
  printed** — the standard governing the MICR band is not public and the available vendor
  documentation contradicts itself on field positions, so checks print onto your bank's pre-encoded
  stock rather than onto a guess.
- **Banking calendar.** Two of them, because they disagree. The Federal Reserve decides whether
  payroll funds; the IRS decides when a deposit is due. A holiday on a Saturday costs the Fed nothing
  but still moves the IRS deadline, and DC Emancipation Day moves the deadline with the banks fully
  open. The tab shows both and calls out the dates where they differ.

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

**Nothing transmits.** Every artifact is something you send: no e-filing to the IRS or SSA, and no
EFTPS deposit initiation. The EFW2 file is generated but you upload it; the 941, 940 and RT-6 are
worksheets you transcribe.

**Two things are refused rather than approximated**, and both will stay refused until the governing
document is in hand: the EFW2 layout for a tax year that has not been read (2026 among them), and
the MICR line on a check. In each case the source of truth is unobtainable or self-contradictory, and
a wrong answer would be indistinguishable from a right one to the person relying on it.

Also absent: employee self-service (one login is still the whole company), 1099 contractors, PTO and
leave accrual, workers' compensation and employer benefit contributions, the pre-2020 Form W-4
allowances path, and segregation of duties between whoever prepares a run and whoever approves it.
Overpayment repayment spanning tax years is deliberately out of scope because it carries genuinely
different tax treatment — approximating it would be worse than refusing. State returns cover Florida
only.

All of these are tracked in [BACKLOG.md](../BACKLOG.md) with done-when criteria.

## Tests

`payroll/tests/` runs dependency-free `node --test` suites against the **compiled** route modules —
the same bytes the framework mounts. They include executable proofs that the engine reproduces Pub
15-T Worksheet 1A exactly in both W-4 modes, the Missouri DOR's own worked example, wage-base and
threshold crossings, the gross↔net identity, hostile-input hardening, both confirm gates with the
database provably untouched, void-run negation, and a sweep proving no payroll query reaches the
database without a tenant predicate. Wired as the `payroll` job in the store repo's CI.
