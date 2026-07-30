# Copyright registration

How to register oshal with the US Copyright Office, why it is worth doing, and
the three facts only the copyright owner can supply.

**Not legal advice.** The Copyright Office's own
[Circular 61, *Copyright Registration of Computer Programs*](https://www.copyright.gov/circs/circ61.pdf)
is the authority, and fees and forms change. This document exists so the filing
takes twenty minutes instead of an afternoon.

## Why register a project you gave away for free

The license already handles the case where someone lifts the code and calls it
theirs — that is infringement, and stripping the notices is separately actionable
(see [NOTICE](../../NOTICE)). Registration is about whether you can *do* anything
about it:

- **It is a precondition to suing at all.** For a US work, an infringement action
  cannot be filed until registration has been made (17 U.S.C. §411(a)).
- **It is what makes suing economically rational.** Timely registration entitles
  you to elect **statutory damages and attorney's fees** instead of proving
  actual monetary loss (§412). For software given away for free, actual loss is
  close to unprovable — which means that without registration, a case you would
  clearly win is still not worth filing. This is the single highest-leverage
  thing on this page.
- **It creates a dated government record of authorship.** That matters here more
  than for most projects: this repository's history was reset twice and its root
  commits are date-pinned, so the public git timeline asserts very little about
  when the work was written.

**Timing, which is the part people get wrong.** "Timely" means registered either
(a) within three months of first publication, or (b) before the infringement
began. Option (b) is the one that stays available: **registering now covers every
infringement that starts after the registration date.** Waiting until you
discover a theft is what forfeits statutory damages, permanently, for that theft.

## Generate the deposit

The Office wants the first 25 and last 25 pages of source code for a program
longer than 50 pages. Generate it from a specific commit:

```bash
node scripts/copyright-deposit.js ~/oshal-deposit.txt
```

It writes the deposit plus a `.manifest.txt` recording the commit, the file list,
and the page arithmetic — keep the manifest, because a later registration of a
newer version needs to show what the earlier one covered.

Two notes:

- The script deposits from **`HEAD`**. Check out the commit you intend to
  register first; do not register a version you cannot reproduce.
- The scope is `src/` and `any-bot/server/` — the platform itself. Docs, tests,
  generated output, and application packages are excluded on purpose. That
  boundary is the registrant's to define, but be consistent across versions.

Print or convert to PDF and upload it as the deposit copy. Because this work is
published open source, **no redaction is needed** — the trade-secret deposit
options in Circular 61 exist for closed-source registrants and do not apply.

## Field sheet

File the **Standard Application** through the electronic system (eCO) at
copyright.gov. Fees change; check the current schedule. The Single Application's
lower fee is only available for one author, one work, not made for hire, and no
co-authors — see the decisions below before assuming it applies.

| Field | Value |
|---|---|
| Type of work | Computer program |
| Title of work | oshal |
| Alternative title | open swarm oshal |
| Year of completion | The year the version you are registering was finished |
| Published? | Yes |
| Date of first publication | **See decision 3** |
| Nation of first publication | United States |
| Author's contribution | Computer program |
| Author created | "Computer program" — do not claim text, artwork, or photographs unless you are also depositing them |
| Work made for hire? | **See decision 1** |
| Author / claimant | **See decision 1** |
| Rights and permissions | oss@oswarm.ai |
| Limitation of claim | Exclude any third-party material. This tree vendors none — see the third-party section of [NOTICE](../../NOTICE) — so ordinarily nothing to exclude. |
| Previous registration | "No" for the first filing; for later versions, "Yes" and cite the earlier registration number, claiming only the new material |

## The three decisions only the owner can make

**1. Who is the author and claimant — you, or Emerald Coast Systems Group?**
The repository is marked `Copyright (c) 2026 Emerald Coast Systems Group`. For
that to be the registered claimant, the entity must actually exist and actually
own the copyright, which happens one of two ways: the code was created as a work
made for hire by the entity, or you signed a written assignment transferring it.
If the entity is not formed, or there is no assignment, then **you personally own
the copyright** and registering the entity as author would be inaccurate. Sort
the ownership out before filing, not after — and if you do form the entity later,
a written assignment plus a recordation is the clean path.

**2. Registration is a public record under a real legal name.** The registry is
searchable, and it will carry the author/claimant name, not the
`oshal maintainers` alias this repository uses. That is unavoidable: an
anonymous or pseudonymous registration is possible but it complicates enforcement
and the term calculation, and it sits oddly against a repository that already
publishes a business identity. If keeping a personal name out of public records
matters, registering in the name of a properly formed entity is the way to get
both — which is another reason decision 1 comes first.

**3. What is the date of first publication?** Not the creation date of the
current repository. The work was published when it first became publicly
available, which predates the two history resets. Get this right: it drives the
three-month window in §412, and a materially wrong date on the application is a
defect in the registration.

## Registering later versions

A registration covers the version deposited. Software keeps changing, so the
practical pattern is to register meaningful releases rather than every commit,
and for each one to claim only the new material and cite the prior registration.
Keep every generated `.manifest.txt` — together they are the record of which
version each registration covers.

## Related

- [licensing.md](licensing.md) — what the license grants and requires.
- [../../NOTICE](../../NOTICE) — the attribution record, and the notice-stripping point.
- [scripts/copyright-deposit.js](../../scripts/copyright-deposit.js) — the deposit generator.
