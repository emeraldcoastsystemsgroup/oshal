# Licensing

The canonical answer to "what am I allowed to do with oshal?" This document
describes the license as it actually operates, including the restrictions people
commonly assume are there and are not.

**Not legal advice.** It is an accurate description of the maintainer's licensing
posture. If you need certainty for a specific commercial situation, have counsel
read [LICENSE](../../LICENSE) and email **oss@oswarm.ai**.

## The short version

oshal is licensed **AGPL-3.0-or-later**. It is free and open source software.
Run it, read it, change it, self-host it, build on it, use it at work, use it to
make money. If you distribute it or offer it to others over a network, you pass
the same freedoms along and you publish your source. If you cannot do that, a
paid commercial license is available.

## What the AGPL grants you

| You may | Notes |
|---|---|
| Run it, for any purpose, including commercially | No field-of-use restriction. No seat count. No license key. |
| Run it inside a company, in production | Explicitly permitted — see the misreadings below. |
| Read, study, and learn from the whole codebase | That is the point of publishing it. |
| Modify it, privately or publicly | Private modifications you never distribute carry no obligation. |
| Redistribute it, modified or not | Under the same license, with notices intact. |
| Offer it as a service | Provided you honor section 13 (below). |
| Fork it permanently | Rename the fork — the name is not licensed. See [NOTICE](../../NOTICE). |

**Your license rights are separate from participation in this repository.**
Issues, comments, and pull requests here are limited to collaborators, and
contribution is by invitation (see
[CONTRIBUTING.md](../../CONTRIBUTING.md#who-can-do-what)). That restriction is
about the maintainer's inbox, not about your license: every right in the table
above — including cloning, modifying, redistributing, and publishing your own
fork wherever you like — is fully intact and is not conditioned on being allowed
to post here. The AGPL does not require a licensor to accept contributions, and
declining them takes nothing away from you.

## What the AGPL requires of you

These obligations attach when you **convey** the software or **offer it over a
network** — not when you merely use it.

1. **Same license.** Your modified version goes out under AGPL-3.0-or-later
   (section 5(c)).
2. **Keep the notices.** [NOTICE](../../NOTICE), the copyright lines, the
   per-file change-log headers, and [LICENSE](../../LICENSE) stay intact.
3. **Say what you changed**, with dates (section 5(a)).
4. **The network clause (section 13).** This is the AGPL's distinguishing
   feature. If users interact with your modified version remotely over a
   network, you must offer *those users* the Corresponding Source of your
   version, at no charge, through the network. Hosting a modified oshal as a
   SaaS product without publishing your modifications is the specific thing the
   AGPL forbids.
5. **Corresponding Source means complete.** Build scripts, configuration, and
   whatever else is required to build and run your version — not a source
   tarball with the interesting parts removed.

## Misreadings worth correcting

These are the four things people assume an AGPL project restricts. It does not.

- **"Corporations can't use it in production."** They can. The AGPL is copyleft,
  not non-commercial. A company may deploy oshal in production, modify it for
  internal use, and never owe anyone anything, as long as it does not convey the
  software or offer it to outside users over a network. There is no
  non-commercial clause here and there is not going to be one.
- **"You can't use it to make money."** You can. Consultancies, hosting, and
  products built on oshal are all fine, subject to the obligations above.
- **"The functionality is protected."** Copyright covers the code as written —
  the expression. It does not cover ideas, methods, or functionality
  (17 U.S.C. section 102(b)). Somebody who reads the published architecture and
  writes their own implementation from scratch has not infringed. That is lawful
  and it is a consequence of publishing, accepted deliberately.
- **"A license clause can forbid reimplementation."** Not against someone who
  never accepted the license. A public clone requires no agreement, so terms
  that purport to bind non-licensees do not reach them. What the license governs
  is *copying* — and copying is squarely covered.

Copyright is strongest exactly where the risk feels worst: lifting the actual
code and passing it off as original work is infringement, plus a separate
notice-stripping claim in the US. See [NOTICE](../../NOTICE).

## The commercial license

The AGPL's copyleft is a real constraint for some businesses. If you want to
embed oshal in a closed-source product, or offer a hosted service built on a
modified oshal without publishing your modifications, buy a commercial license
instead of violating this one.

**Contact oss@oswarm.ai.** Nothing about the open release changes: the AGPL
version stays free and complete, and the commercial license is an alternative
set of terms for people who need it, not a paywalled feature tier.

## Where the protectable work lives

This is the open-core boundary, stated once so it is not rediscovered by
accident:

- **This repository is the platform, and it is a genuine giveaway.** Everything
  in it is published under the AGPL. Nothing here is secret, and nothing here
  can be a trade secret — publication ends secrecy.
- **Application packages ship separately.** Public packages live in the
  [oshal-apps](https://github.com/emeraldcoastsystemsgroup/oshal-apps) store
  repository under their own terms; commercial packages are not published at
  all.
- Consequence: anything whose value depends on *not* being public belongs in a
  private package, never in this tree. See
  [CLAUDE.md](../../CLAUDE.md#rule-0c--application-code-never-mixes-with-swarm-code).

## Contributions

Inbound contributions are governed by [CLA.md](../../CLA.md). You keep your
copyright; you grant a license broad enough that the commercial exception can
include your work. This is required — without it, contributed code could never
appear in the commercial build. The CLA also asks you to confirm that your
employer does not own what you wrote, which protects both of us.

## Trademark

The code is licensed; the name is not. "oshal" and "open swarm oshal" are the
maintainer's project names. Fork freely, and rename your fork. Details in
[NOTICE](../../NOTICE).

## Third-party material

oshal is original work; runtime dependencies are fetched at install time rather
than redistributed here, and the agent harnesses are invoked as external
subprocesses rather than vendored. The full statement, and the rule for vendoring
anything new, is in [NOTICE](../../NOTICE).

## Enforcement posture

The maintainer keeps the authorship record — git history, release tags, and these
notices — and treats notice-stripping and unattributed redistribution as worth
acting on. Compliance is cheap: keep the notices, state your changes, publish
your source if you host it. Reports of suspected misuse go to **oss@oswarm.ai**.

## Related

- [LICENSE](../../LICENSE) — the AGPL-3.0 text itself.
- [NOTICE](../../NOTICE) — attribution, trademark, third-party material.
- [CLA.md](../../CLA.md) — inbound contribution terms.
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — how to actually land a change.
- [SECURITY.md](../../SECURITY.md) — vulnerability reporting.
