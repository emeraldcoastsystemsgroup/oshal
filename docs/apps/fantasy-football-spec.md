# fantasy-football — functional and technical specification

**Status:** Specification for review. **Part of P0 already ships** in sports-edge and must not be rebuilt
(§1.7); the rest is unbuilt. The decisions and their rationale are in
[ADR-146](../adr/146-fantasy-football-draft-platform.md); this document is the buildable detail.

**Scope:** a store package that manages a fantasy football team and the league around it — the value
model and roster-construction engine first, then the site with its commissioner controls, then the
draft-specific layer and a remote-node assistant for a live ESPN draft room. Queued in
[BACKLOG](../BACKLOG.md) as *"Fantasy football — the draft engine, the league site, and the live-draft
node"*.

**Managing comes before drafting, on the operator's own facts (2026-09-09).** The draft already
happened and it went badly: *"we have been positioned last … we picked up running backs first round 2
times that were specifically left over by the other team owners … because we missed the first 2 rounds
maybe first 4."* An autopicked roster of other managers' leftovers is the starting position, and the
season is at **week 1** (verified live against ESPN's public season endpoint on 2026-09-09), so every
remaining decision is still ahead. The draft engine is not deleted — it is needed next August and for
mocks — but it moves behind the engine that fixes a roster you already have.

**The one sentence that shapes everything below:** a roster decision is not "who is the better player",
it is *the change in the points your starting lineup will actually score over the rest of the season* —
and, when you are behind, *the change in your odds of making the playoffs*. Every algorithm here computes
one of those two numbers. That is what the operator meant by **build from the team out**, and it applies
to a waiver claim exactly as it applies to a pick.

---

## Part 1 — Functional specification

### 1.1 The three things a user does

| surface | who | what it does |
|---|---|---|
| **Manage** | every manager, every week | start/sit against *this week's opponent*, the waiver board with a bid, trades worth proposing, and streaming. The primary surface. |
| **League** | every member | matchups, standings, rosters, transactions — the ordinary season around it. |
| **Commissioner** | one person | league settings, member management, corrections, and an audit trail of every correction. |
| **Draft** | pre-season | a board, a queue, a recommendation with its reasoning, and a clock. Works with no external league at all (paper mode). |

### 1.2 The weekly board — the screen that matters

```
Week 3 · vs Team Roman (5th, 2-0)          projected 108.4 – 121.7      win 34%

  YOU ARE AN UNDERDOG THIS WEEK, SO THE LINEUP CHANGES SHAPE.
  Playing your safest lineup wins 31% of the time. This one wins 34% — same players,
  more variance, because you need the tail, not the average.

  START            over                      why
  RB  Tyjae Spears  → Rhamondre Stevenson    +6.1 ceiling, −1.8 mean. You need ceiling.
  WR  Xavier Legette → Khalil Shakir         CAR trails by 7 in the model → volume.

  WAIVERS  budget $74 of $100 · claims process Wed 3am
  1. Bhayshul Tuten  RB · JAX      +19.2 rest-of-season      bid $23   drop: K
     starts in 9 of your remaining 15 weeks — your RB2 is a replacement in 9 of them
  2. Jauan Jennings  WR · SF       +7.4                       bid $6    drop: WR5
  3. Chargers DST    week 3 only   +4.1 this week             bid $1    stream

  TRADE  one both sides gain from
     you give  Ladd McConkey (WR)          you get  Kenneth Walker III (RB)
     you   +11.8 rest-of-season     them  +6.3 — they start 4 WRs and roster 6; their
     RB depth never reaches their lineup. This is the surplus your draft left you short of.
```

Every number on that screen is derived, and every one is defined in Part 2. Nothing is ever submitted
automatically — a human presses the button.

### 1.3 The draft board, mid-draft

```
Round 4 · Pick 41 overall · your pick        clock 1:12      [ Draft ]  [ Queue ]

  RECOMMENDED   Chase Brown            RB · CIN · bye 10
                +18.4 pts to your season starting lineup     ← the number that decides it
                tier 4 of RB (3 left)      VOR 41.2      VONA +11.6
                why: your RB2 slot starts a replacement in 9 of 14 weeks without him;
                     tier 4 empties in an expected 6 picks and you pick again at 56.

  ALTERNATIVES  Jaxon Smith-Njigba  WR  +14.9   tier 3 of WR (5 left)   VONA +3.1
                Trey McBride        TE  +13.2   tier 2 of TE (1 left)   VONA +9.8   ← scarcity
                Bo Nix              QB  +6.1    tier 6 of QB (11 left)  VONA +0.4
```

### 1.4 League configuration

Everything that changes the math is configuration, never a constant in code:

- **Format** — snake, auction, or keeper/dynasty; team count; draft order; auction budget.
- **Roster slots** — QB/RB/WR/TE/FLEX/superflex/K/DST/bench/IR, any counts.
- **Scoring** — per-stat points (PPR, half, standard, TE premium, custom bonuses), entered as a stat→points
  map, defaulted from the connected league's own `mSettings` when there is one.
- **Season shape** — regular-season weeks, playoff weeks and bracket size, trade deadline, waiver mode
  (FAAB budget or rolling priority), lineup lock policy.

### 1.5 Commissioner controls

A separate surface, not buttons sprinkled through the app:

- edit any roster, score, or lineup; re-open a locked lineup; reverse a transaction
- set or re-draw the draft order; pause, resume, or roll back the draft
- invite and remove members; reassign a team to a different member
- force-process waivers; veto or approve a trade
- **an audit row for every one of these** — who, when, before, after — visible to the whole league

### 1.6 What arrives when

| phase | ships |
|---|---|
| **P0** | **the management engine**: projections, league scoring, availability, the weekly lineup optimizer, rest-of-season marginal value, and the four decisions built on them — start/sit, waivers with a bid, trade finding, streaming. Works on a roster typed in by hand. |
| **P1** | the league site and the commissioner surface. |
| **P2** | the draft-specific layer — tiers, VONA, the draft simulator, auction max-bid — plus the live-draft node assistant. Needed next pre-season and for mocks. |
| **P3** | automation of the weekly loop, still confirm-gated: claims queued for approval, a Monday alert when the recommendation changes. |

### 1.7 What already ships

Verified on the box 2026-09-09 (sports-edge **0.6.0, active** after store #150), so that P0 is understood
as the gap and not the whole engine:

| already built, in `sports-edge` | not built |
|---|---|
| `applyScoring` from the league's own `scoringItems` (2.2.1) | waivers with a bid (2.2.7) |
| `optimiseLineup` + `startSitCalls` (2.2.6) | rest-of-season `SV`/`MV` (2.2.4) — the optimiser still values one week at a time |
| projection distilling with a cached shared refresh | the two-sided trade finder (2.2.8) and the other teams' rosters it needs |
| league link/unlink, own-team resolution from `SWID` | streaming (2.2.9) |
| the ledger — calls registered before kickoff, then graded (2.2.11) | |
| the credential rule, implemented: resolved per request, used outbound, never logged/stored/returned | |
| **the `P(win)` objective and the matchup read (2.2.2, 2.2.5, 2.2.6) — shipped 0.6.0, 2026-09-09** | |

**Caveat:** none of the shipped half has run against a real league — there is no `espn-fantasy` row in
`oshal_connections` on this box, so those routes have only ever seen fixtures.

---

## Part 2 — Technical specification

### 2.1 Where the data comes from

| input | source | credential |
|---|---|---|
| player pool, ADP, auction values, ownership, raw projections, current week | ESPN public player + season feeds | **none** |
| **your roster, your opponents' rosters, matchups, league settings** | `espn-fantasy` connector (core #362) — `SWID` + `espn_s2` | account cookies |
| **the same, without a credential** | manual roster entry — you type or paste the 10 teams once | none |
| opponent strength, injuries weighted by production share | the `sports-edge` model inputs | none |

**The credential moved onto the critical path, and that is new.** The draft engine needed nothing —
the pool, ADP and projections are public. Managing a team needs *your* roster and *your opponents'*,
which in a private league means the two ESPN cookies. The operator has also reported the ESPN team
"having some issues", so **manual entry is a first-class input, not a fallback**: the engine must run
to completion on rosters typed into a form, and every read path must degrade to it rather than to a
blank screen.

Two properties of the ESPN feed are load-bearing and both are traps (measured 2026-09-08, recorded in
ADR-146): **`appliedTotal` is null** — projections are raw stats and points only exist against a league's
scoring rules — and **`x-fantasy-filter` is required** — without the header the feed returns exactly 50
players, which reads as missing data rather than a truncated request.

Per ADR-146 D2 the read client and the scorer are the kernel skill `fantasy-leagues`; this package declares
`uses: [fantasy-leagues]` and calls it.

### 2.2 The algorithms

Notation: player `p`, week `w`, position `pos`, league scoring map `σ`, roster `R`.

#### 2.2.1 Points, under *your* rules

```
pts(p, w) = Σ_s  projectedStats[p, w, s] × σ[s]
```

No stat dictionary is ever hardcoded (ADR-146; the failure mode is silent). `σ` comes from the connected
league's `mSettings.scoringItems`, or from the league record configured in 1.4.

Two independent projections are carried and blended at a weight the backtest sets: ESPN's per-week stat
line, and a tape-built projection using `sports-edge`'s opponent-adjusted ratings and its
production-weighted injury adjustment. One vendor's number is never the only input.

#### 2.2.2 Availability, and the distribution around a projection

Each week carries a start probability `a(p, w)` — 0 on a bye, reduced by injury status, else 1. Expected
points are `a(p,w) × pts(p,w) + (1 − a(p,w)) × replacement(pos)`.

Every player also carries a **spread** `s(p, w)`, not just a mean, because half of Part 2 depends on
variance. There is no free per-player variance feed, so `s` is estimated from the week-to-week dispersion
of players at the same position in the same projection band, measured over prior seasons — a modelled
parameter, stated as one on the surface, and calibrated in the backtest.

#### 2.2.3 Replacement level — the baseline is the league, not a rank

```
R_pos  = teams × (starters_pos + flexShare_pos)      # how many of this position actually start
B_pos  = mean season points of players ranked R_pos … R_pos+2
VOR(p) = seasonPoints(p) − B_pos
```

`flexShare_pos` is the fraction of FLEX slots historically filled by `pos` in a league of this shape.
A 12-team 2RB/3WR/1FLEX league and a 10-team 1FLEX league get different baselines, which is the point.
Recomputed weekly as the free-agent pool changes.

#### 2.2.4 Marginal lineup value — this is "build from the team out"

The single function the whole package rests on, used identically by a draft pick, a waiver claim and a
trade:

```
L(R, w)   = max over legal slot assignments of  Σ expected points        # weekly optimal lineup
SV(R, W)  = Σ_{w ∈ W}  ω_w · L(R, w)                                     # value over a set of weeks
MV(c | R) = SV(R + c, W_remaining) − SV(R, W_remaining)                  # what adding c is worth
```

`W_remaining` is the rest of the season — for a draft that is all 17 weeks, in week 3 it is 15, and that
is the *only* difference between drafting and managing. `ω_w` weights the fantasy playoff weeks above
week 3. `L` is a bipartite assignment over slots; greedy from most-restrictive slot is exact for standard
slot sets, with the Hungarian method as the fallback for exotic multi-position slots.

This one mechanism replaces a pile of hand-typed rules:

- a **third RB** is worth what it adds *in the weeks it would actually start* — usually little, sometimes a lot
- **bye collisions** price themselves: the week your only QB is out is a week `L` drops to a replacement
- **handcuffs** price themselves through correlated availability — a backup's value rises exactly as his starter's `a(p,w)` falls
- **positional scarcity** needs no rule at all: it is the shape of `B_pos`
- a **drop candidate** is just `MV(d | R − d)` — the player whose removal costs least

#### 2.2.5 The objective changes when you are behind

Maximising expected points is the right objective only for a team that is already good. For a team built
from other managers' leftovers it is actively wrong, and this is the most important idea in the document.

A week is a head-to-head against a known opponent lineup. What you want is not the highest mean, it is the
highest **probability of scoring more than they do**:

```
P(win) = Φ( (μ_you − μ_opp) / √(σ²_you + σ²_opp) )
```

Differentiate that and the consequence is immediate and unarguable:

- **when `μ_you < μ_opp` (you are the underdog), P(win) increases with `σ_you`** — start the volatile
  player, not the steady one
- **when you are favoured, P(win) increases as `σ_you` falls** — start the floor

Over the season the same logic runs one level up: simulate the remaining schedule `N` times and choose the
decision that maximises **P(making the playoffs)** rather than total points. A team on the bubble behaves
almost like the mean-maximiser; a team two games out correctly becomes a variance-seeker, because a
season's worth of safe lineups converges on a result that finishes 7th.

This is derived, not a heuristic, and it is exactly the situation the operator is in.

#### 2.2.6 Start/sit

For week `w`, enumerate legal lineups (the slot assignment is small — the top few candidates per slot
suffice), score each by `P(win)` from 2.2.5 against the opponent's own optimal lineup, and present the
best. Show the mean-maximising lineup alongside it whenever the two differ, with the difference in
`P(win)` — a recommendation that costs mean points must justify itself in win probability or it is not
made.

#### 2.2.7 Waivers and FAAB

The value of a claim is a swap, not an addition, because a full roster has no free slot:

```
Δ(c, d) = SV(R − d + c, W_remaining) − SV(R, W_remaining)
```

Rank the wire by `Δ` over the best drop `d`. Then convert `Δ` into money. With `B` FAAB dollars left and
an estimate `E` of the total `Δ` still available from the wire this season:

```
bid*(c) = B × Δ(c, d) / (Δ(c, d) + E_rest)
```

which is the budget's own marginal value — spend a fraction of what is left equal to this claim's share
of the value left. Two corrections on top: a **scarcity premium** when `c` fills a slot where your starter
is a replacement in more than a third of remaining weeks (the leftover-RB case exactly), and a **hard
cap** at the point where winning the bid leaves too little for the rest of the season.

Streaming claims (2.2.9) are priced on a one-week horizon and should never consume budget meant for a
rest-of-season add; they are ranked in a separate lane.

#### 2.2.8 Trades — and how to find one the other manager accepts

A trade is two `SV` calls per side. For each opponent roster `T`, each give-set `g ⊆ R` and get-set
`h ⊆ T`:

```
Δ_you  = SV(R − g + h, W_rem) − SV(R, W_rem)
Δ_them = SV(T − h + g, W_rem) − SV(T, W_rem)
```

**Propose only when both are positive.** Those trades exist far more often than they look like they
should, and the reason is structural: rosters have different slot pressure. A manager starting three WRs
who rosters six has a fourth-best WR whose `MV` *to them* is near zero — he never reaches their lineup —
while the same player fills a hole in yours. **Your draft's damage is someone else's surplus**, and this
search is how you find it.

Bound the search to 1-for-1 and 2-for-1 among startable players, rank by `Δ_you` subject to
`Δ_them > threshold` so the proposal is plausible, and show *their* gain in the offer — a trade the other
manager can see the logic of is the one that gets accepted.

#### 2.2.9 Streaming

Defence, kicker, and (in superflex) a second quarterback are one-week decisions: maximise `pts(p, w)` over
free agents for that week only, using `sports-edge`'s opponent-adjusted ratings for the matchup half.
Constrained by the league's add limits and the streaming budget lane from 2.2.7.

#### 2.2.10 The draft layer (P2)

The draft-specific pieces sit on top of the same `MV`:

- **Tiers** — within a position, gaps `g_i = v_i − v_{i+1}` over the top 60; a tier edge is `g_i > k·σ_g`
  (`k ≈ 1.5`, calibrated). Variable-sized tiers, because a draft is a sequence of "which cliff falls next".
- **VONA** — the cost of a pick is the best player still there at your next pick:
  `P(p survives to N') = Π_{n ∈ (N,N')} [1 − select(p,n)]` with `select` a normal kernel around ADP;
  `VONA(p) = MV(p|R) − E[max over survivors of MV(q|R)]`.
- **Draft simulation** — for the top `K` candidates by VONA, simulate `M` completions with opponents
  drawing around ADP and score each finished roster with `SV`. Budget `K = 10`, `M = 300`.
- **Auction** — with inflation `ι = money left / value left`, `maxBid(c)` is the price at which `MV` per
  dollar stops beating the best `MV`-per-dollar reachable with the remaining pool.

#### 2.2.11 The honesty gate

Two ledgers, one standard — the same one sports-edge and kalshi run under.

**Management (weekly, from P0).** Every recommendation is recorded before kickoff: the lineup advised, the
lineup actually started, the claim advised, the claim actually made. At week's end, score all of them
against real results. The season report is one honest sentence — *the engine's lineup beat the one you
started by N points across W weeks*, or it did not.

**Drafting (seasonal, from P2).** Draft a completed season using **only** pre-season data (this is why ADP
is snapshotted, not recomputed — see 2.3), opponents drafting straight off ADP with noise, varying the
draft slot; score every roster on that season's *actual* weekly optimal lineup; report mean points and win
rate against the ADP rosters across **≥100 drafts**. A loss is reported as a loss.

### 2.3 Data model

All tables `ff_` prefixed, owner-scoped, in the package's own migrations.

| table | holds | note |
|---|---|---|
| `ff_leagues` | format, team count, roster slots, scoring map, season shape, external league ref | scoring/slots as JSONB — configuration, never constants |
| `ff_teams` | team, league, draft slot, owning member | member nullable while single-operator (ADR-146 D3) |
| `ff_players` | player cache: name, position, pro team, bye week, eligible slots | refreshed daily |
| `ff_projections` | per player/week/source raw stat map **and its spread** | never points — points are computed per league |
| `ff_rosters` | **every team's roster**, not just yours | the trade finder is worthless without the other nine |
| `ff_matchups` | week, home team, away team, result | drives `P(win)` and the playoff simulation |
| `ff_lineups` | who started in a week, and who the engine said to start | the management ledger's raw material |
| `ff_recommendations` | week, kind (start/sit, claim, trade), advised, taken, outcome | 2.2.11's weekly ledger |
| `ff_transactions` | adds, drops, waivers, trades, FAAB spent | |
| `ff_adp` | ADP, auction value, ownership, **captured_at** | an immutable snapshot; a backtest is worthless with today's ADP, the same reason sports-edge 0.3.0 captures the opening line |
| `ff_drafts`, `ff_picks` | draft state, and each pick with the rationale that justified it | P2 |
| `ff_admin_audit` | commissioner action, actor, before, after | league-visible (1.5) |

### 2.4 Routes

Under the package's route root, auth-gated (routes are public by default in this codebase — CLAUDE.md):

```
POST   /leagues                     create; GET/PATCH /leagues/:id      settings
POST   /leagues/:id/import          pull rosters/matchups via the connector
POST   /leagues/:id/rosters         MANUAL entry — the credential-free path (2.1)
GET    /leagues/:id/week/:w         the weekly board: start/sit, waivers, trades, streaming
GET    /leagues/:id/week/:w/lineup  optimal lineup + the P(win) it buys vs the mean-max lineup
GET    /leagues/:id/waivers         wire ranked by Δ, each with a bid and a drop
GET    /leagues/:id/trades          two-sided proposals, both gains shown
POST   /leagues/:id/transactions    record a claim/trade a human approved
GET    /leagues/:id/report          the management ledger (2.2.11)
POST   /admin/:id/*                 commissioner actions; every one writes ff_admin_audit
POST   /drafts …                    the P2 draft surface
```

### 2.5 The live-draft node loop (P2)

Per ADR-146 D4 there is **no new core rail**. The app issues short, repeated tasks to a chosen node:

1. the app dispatches a browser task: *open the draft room, return picks after cursor `c`*
2. the node runs it against the operator's already-logged-in browser and completes it — one claimed task,
   released immediately
3. the app appends the picks, advances `c`, re-runs the recommendation, updates the surface
4. repeat until the draft ends

The ESPN cookies never leave that machine; only picks — public inside the room — come back. Nothing is
ever submitted: **no autopick path exists**, per the automation opt-in directive.

### 2.6 Guards (one per failure this spec can already name)

| guard | goes red when |
|---|---|
| two-rule scoring | the same fixture player scores identically under PPR and standard — i.e. someone hardcoded a stat table |
| filter-header | a pool read without `x-fantasy-filter` is treated as data instead of failing loudly (the silent 50-player page) |
| optimizer exactness | the slot assignment disagrees with brute force on a small roster |
| **underdog variance** | a team projected to lose a week is handed the *lower*-variance lineup — the 2.2.5 objective silently reverted to mean-maximising |
| **trade two-sidedness** | a proposal is surfaced with `Δ_them ≤ 0` |
| **manual-entry parity** | any weekly recommendation is unreachable from hand-typed rosters, i.e. the connector became mandatory |
| ADP immutability | a snapshot row is rewritten after `captured_at` |
| no-autopick / no-autoclaim | a pick, claim or trade can be recorded without a human confirm |
| ledger completeness | a week closes with recommendations that were never graded |

### 2.7 Open items

The three operator questions in ADR-146 (skill extraction now or later; single-operator or multi-member in
P1; package name, suite, and the group with sports-edge) gate P1 but not P0.

What P0 does need from the operator: **the league's scoring and roster slots, and either the ESPN
credential or one pass of manual roster entry for all teams.** The engine cannot rank a waiver claim
without knowing what a reception is worth, and cannot find a trade without the other nine rosters.
