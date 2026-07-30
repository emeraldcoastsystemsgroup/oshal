# oshal Contributor License Agreement

**Version 1.0.** Applies to every contribution merged into
`emeraldcoastsystemsgroup/oshal` on or after 2026-07-30.

This is short on purpose. Read it once; you agree to it per pull request with a
single line.

## Why this exists

oshal is open core. The platform is AGPL-3.0-or-later and always will be, and a
paid commercial license is offered to anyone who cannot meet the AGPL's copyleft
terms (see [docs/legal/licensing.md](docs/legal/licensing.md)).

That second half only works if the maintainer holds the rights to license
*every* line in the tree under those commercial terms. Under a plain
inbound=outbound arrangement, a merged contribution is licensed to the project
under the AGPL and nothing more — which means it can never appear in the
commercial build, and the maintainer would have to keep a permanent list of
files that must be stripped from it. This agreement avoids that.

It does not take your copyright. You keep it. You are granting a license.

## The agreement

By submitting a Contribution, You agree to the following. "You" means the
copyright owner or the legal entity authorized by the copyright owner.
"Contribution" means any work of authorship You intentionally submit for
inclusion in this project. "Maintainer" means Emerald Coast Systems Group.

**1. Copyright license.** You grant the Maintainer and every recipient of the
project a perpetual, worldwide, non-exclusive, royalty-free, irrevocable
copyright license to reproduce, prepare derivative works of, publicly display,
publicly perform, sublicense, and distribute Your Contribution and such
derivative works.

**2. Right to relicense.** You grant the Maintainer the right to license Your
Contribution, and derivative works of it, under terms of the Maintainer's
choosing — including proprietary commercial terms — in addition to
AGPL-3.0-or-later. This is the clause that lets the commercial exception exist.
It does not permit the Maintainer to remove Your Contribution from the AGPL
release: the public project remains AGPL-3.0-or-later, and Your Contribution
remains available to everyone under that license.

**3. Patent license.** You grant the Maintainer and every recipient of the
project a perpetual, worldwide, non-exclusive, royalty-free, irrevocable patent
license to make, have made, use, offer to sell, sell, import, and otherwise
transfer Your Contribution, limited to those patent claims licensable by You
that are necessarily infringed by Your Contribution alone or by its combination
with the project. If You institute patent litigation alleging that the project
or a Contribution within it constitutes patent infringement, the patent licenses
granted to You under this agreement terminate as of the date such litigation is
filed.

**4. You have the right to grant this.** You represent that each Contribution is
Your original creation, and that You are legally entitled to grant the licenses
above. **If Your employer has rights to intellectual property You create, You
represent that You have received permission to make the Contribution on behalf
of that employer, that Your employer has waived such rights, or that Your
employer has executed a separate agreement with the Maintainer.** If you are
unsure whether your employment agreement assigns what you write on your own
time, resolve that before contributing — not after.

**5. Third-party material.** If Your Contribution includes work that is not Your
original creation, You must submit it separately and clearly identified,
complete with its license, author, and any restrictions, and it must be
compatible with AGPL-3.0-or-later. See the third-party section of
[NOTICE](NOTICE).

**6. No obligation, no warranty.** The Maintainer is under no obligation to use,
merge, or keep any Contribution. Except for the representations in sections 4
and 5, You provide Your Contribution "AS IS", without warranties or conditions
of any kind.

**7. Attribution.** You keep authorship credit. Your git authorship on the
commit is the record, and the Maintainer will not misattribute it. Note that
this repository's file headers use a single maintainer alias by convention
(see [CLAUDE.md](CLAUDE.md#file-headers-change-log)); that convention is about
change-log format, and it neither transfers nor obscures the copyright recorded
in git history.

## How to agree

Put this line in your pull request description, with your real name:

```
I have read CLA.md and I agree to it. Signed-off-by: Your Name <you@example.com>
```

Also sign your commits off — `git commit -s` appends the same trailer, which is
the [Developer Certificate of Origin 1.1](https://developercertificate.org/)
statement. Both together are what gets read at merge time.

If you are contributing on behalf of a company and need a countersigned entity
agreement instead, email **oss@oswarm.ai** before opening the PR.

## Scope

This agreement covers contributions to the oshal platform in this repository. It
does not apply to application packages published in the separate store
repository, which carry their own terms.
