# ADR-146: Fantasy football — its own package, one kernel skill, and a draft assistant that needs no new rail

- Status: Proposed — designed, nothing built
- Date: 2026-09-09
- Related: [ADR-085](085-remote-app-packages-and-registries.md) (one app, one package),
  [ADR-090](090-skills-as-first-class-packages.md) + [kernel skills](../apps/kernel-skills.md) (the package-facing API and
  the test for what earns core), [ADR-141](141-application-groups.md) (application groups — how two apps
  are bundled without importing each other), [ADR-036](036-bot-owned-application-architecture.md) (the bot
  owns the domain, the surface is a view), [ADR-117](117-local-auth-invited-users.md) (invited users — the
  only way a second human has an identity on this swarm), [ADR-140](140-local-device-access.md) (the node
  is the swarm's hands, and it is outbound)
- Buildable detail: [docs/apps/fantasy-football-spec.md](../apps/fantasy-football-spec.md)

## Context

Operator ask, 2026-09-06: a fantasy football product — *"the methods and algorithms to pick a team and
build from the team out"*, a site that "does all the stuff any other fantasy football thing does … has
configuration and administrative controls", and a remote-node add-on that assists a **live** draft in the
operator's ESPN draft room. Queued as the BACKLOG entry *"Fantasy football — the draft engine, the league
site, and the live-draft node"* (core #350).

Two things landed in the two days after that entry, and they change what still has to be decided:

| landed | what it is |
|---|---|
| core #362, merged 2026-09-08 | the **`espn-fantasy` connector** — `SWID` + `espn_s2`, with a card that says out loud it is not an API key |
| store #140, merged 2026-09-08 | **sports-edge 0.2.0's Fantasy tab** — `sports-fantasy-espn.ts`, `sports-fantasy-scoring.ts`, `sports-fantasy-store.ts`, `sports-fantasy-routes.ts` |

So "read my ESPN league and score it under my league's rules" already exists — inside an odds-making
package. The draft engine, the league site, the commissioner controls and the live-draft assistant do not.

### What ESPN actually gives you

Measured live on 2026-09-08 (recorded here so nobody re-derives it, and because two of the three facts are
traps):

- **Projections are raw stats, not points.** `appliedTotal` is null across 29,281 weekly rows. A fantasy
  point total does not exist without a league's scoring rules, so points are
  `Σ projectedStats[statId] × leagueScoring[statId]` with `scoringItems` read from the league's
  `mSettings`. **A hardcoded stat dictionary silently mis-scores every player in a non-standard league and
  looks completely normal doing it.**
- **`x-fantasy-filter` is required and its `limit` is ignored.** No header returns 50 players — ESPN's
  alphabetically-early default page, which reads as missing data rather than a truncated request. With the
  header: 11,617 players, ~39 MB, of which ~1,617 carry weekly projections.
- **Auth is two browser cookies (`SWID` + `espn_s2`) and there is no OAuth.** They authenticate the whole
  ESPN *account*: not scoped to fantasy, no per-app revocation, no expiry the user controls. The public
  player feed and a public league need no credential at all.

That last fact is why the live-draft half is a **node** question and not a connector question: a draft room
is a logged-in browser session, and the cheapest correct answer is to never move the credential.

### The three questions, and how many of them touch core

| question | answer | touches core? |
|---|---|---|
| does this go in sports-edge or its own package? | its own package, grouped (D1) | no |
| two packages now need the same ESPN league client and league-rule scorer — how do they share it? | kernel skill (D2) | **yes — the one core change** |
| a league has many members and one commissioner; where does that model live? | in the package (D3) | no |
| can a node watch a live draft room for two hours? | yes, on the existing rail (D4) | no |

## Decision

### D1 — Fantasy football is its own store package, bundled with sports-edge by a group

Not more sports-edge tabs. ADR-085 is one app, one package, and these are two jobs: sports-edge is *"an odds
maker you point at one team"* whose Phase 1 deliberately carries **no order path** until its scorecard says
proven; fantasy football is league management, a draft, and a season. Different user, different surface,
different release cadence, and sports-edge's staking posture does not apply to a draft pick.

They are bundled with an **ADR-141 application group** (`kind: group`, no code), which is the platform's
built answer for "these apps belong together" — the group borrows member surfaces without either package
importing the other.

### D2 — The ESPN league client and the league-rule scorer become the kernel skill `fantasy-leagues`

This is the only core change the product needs, and it is taken because the platform's own written test
says so ([kernel-skills.md](../apps/kernel-skills.md)):

> If ≥2 apps would need it, or it wraps swappable vendors → **kernel skill**. Apps declare `uses:` and
> *call* it. They never bundle it.

Both halves apply. Two packages need it (sports-edge has it today, fantasy-football needs the same reads),
and the store has **no package-to-package rail** — the alternatives are copying the client (drift, in a
module whose host moved from `fantasy.espn.com` to `lm-api-reads` inside one season) or one package calling
another's HTTP routes (a coupling nothing in the platform sanctions). ESPN is the first provider; Yahoo and
Sleeper are the same shape behind the same interface, which is the vendor-swappability CLAUDE.md requires.

What moves up: the **read client** and the **scoring engine** (`sports-fantasy-espn.ts`,
`sports-fantasy-scoring.ts`). What stays in sports-edge: its own tables and routes
(`sports-fantasy-store.ts`, `sports-fantasy-routes.ts`) — those are app domain, not shared capability.
sports-edge then declares `uses: [fantasy-leagues]` and imports rather than bundles.

The scorer is the part that most needs a single home: it is the module where a hardcoded stat table would
be invisible, and one guarded implementation is cheaper to keep honest than two.

### D3 — A league is a shared multi-member object, and core grows no rail for it

A fantasy league is one object with 8–14 members, one commissioner, rows every member reads and only some
may write. ADR-036 keys package state by `user_sub`, so nothing in that pattern expresses it.

Core still does not grow a "shared group object" rail, because one has been hand-built before and the cost
is visible: **little-monsters** models exactly this shape (`lm_classes` with a teacher, `lm_students`,
`lm_enrollments`) and spent **nineteen migrations** on it — `026-education-identity`,
`029-material-sharing`, `030-multi-tenant`, `032-oidc-principal-binding`,
`035-enrollment-tenant-invariant`, `036-authoritative-progress`, `037-authorization-audit`. A commissioner
is a teacher and a league is a class.

So: built in the package, and **single-commissioner first** — the operator manages the league and every
team in it, which is the whole of the near-term ask and needs no second identity. Multi-member arrives only
when real people hold ADR-117 invited logins on this swarm, and it copies little-monsters' model rather than
re-deriving it.

This ADR records the occurrence. **Extraction trigger:** if a third package needs a member-list-with-one-
authority object, the rail is extracted then — not now, on one instance.

### D4 — The live-draft assistant rides the existing remote-client rail with short cursor reads

The temptation is a new core task kind that streams a draft room for two hours. The measured rail says
don't:

- a node executes **one claimed task at a time** (`remote-client-service.ts` refuses to claim while
  `currentTaskId` is set — SEQ 3, added to stop duplicate execution),
- it polls for work every **2,500 ms** by default (`pollIntervalMs`),
- results come back through a **one-use** completion callback bound to the claimed task.

A two-hour task would hold the node's only slot for the whole draft and starve everything else on that
machine. Instead the app issues **short, repeated, cursor-based reads**: each task opens the draft room in
the operator's already-logged-in browser, returns the picks after a cursor, and completes. The surface
re-runs the recommendation on each batch. Pick latency is bounded by the poll interval plus the read — a
few seconds against a 60–90 second draft clock, which is inside the budget by an order of magnitude.

No new core task kind, no new transport, no credential movement: the cookies stay in the browser on the
node's machine, and only picks — public information inside the room — come back.

### D5 — Nothing is auto-picked, and every draft is graded

The node never submits a pick without a per-action confirm, per the operator's automation directive
(outward-acting is opt-in, default off). And the engine carries the honesty gate the sports packages
already run under: a draft's picks are registered before the season and graded after it, measured against
the naive baseline (following ADP), with a loss reported as a loss. sports-edge exists in its current
no-order-path shape *because* the kalshi ledger showed 2,507 settled predictions beating the market on 30%
of them; a draft engine gets the same standard of proof before anyone calls it an edge.

## Consequences

- **One core change ships before the app can be two packages:** the `fantasy-leagues` skill (registry
  entry, `KernelSkillId` union, the moved modules, and sports-edge's `uses:` declaration). Everything else
  — the draft engine, the league site, the commissioner controls, the node loop — is store-repo work under
  Rule 0c.
- **sports-edge changes underneath a shipped, deployed package.** Its Fantasy tab is live on the box, so
  the extraction is a same-change migration: skill lands, sports-edge bumps and re-deploys, and the tab is
  re-verified against a real league before the old modules are deleted.
- **A hardcoded stat table becomes a single-file risk instead of a per-package one** — and gets a named
  guard: a spec that scores a fixture player under two different league rule sets and fails if the totals
  match.
- **The draft assistant is useless until node enrolment is fixed.** It is blocked by the existing BACKLOG
  entry (`REMOTE_CLIENT_REQUIRE_NODE_TOKEN=true` refuses a freshly installed node), and acceptance runs in
  a mock draft, never the operator's real league.
- **The algorithms do not wait on any of this.** The draft engine's inputs — the player pool, ADP, auction
  values, raw projections — are public and need no credential, so P0 is buildable and backtestable today.
- **What this forbids:** copying the ESPN client into a second package; a package importing another
  package; core learning what a fantasy league is; an autopick path; and a claim of edge that has not
  beaten straight-ADP drafting on completed seasons.

## Open questions for the operator

1. **Is the skill extraction taken now, or does fantasy-football start by duplicating the client and
   converge later?** Taking it now is the smaller total change; deferring it means the second copy exists
   for a while and D2 is a promise rather than a fact.
2. **Does P1 ship single-operator (you are the commissioner and every team's manager) or multi-member from
   the start?** Single-operator is the whole near-term ask and avoids nineteen migrations' worth of
   identity work; multi-member is a different schema from day one.
3. **Package name and suite** — `fantasy-football` under `ai-productivity`, or something else, and whether
   the group with sports-edge is `intelligent-sports` or the two ship ungrouped for now.
