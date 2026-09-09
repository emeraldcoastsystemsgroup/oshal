# fantasy-football — functional and technical specification

**Status:** Specification for review. Nothing built. The decisions and their rationale are in
[ADR-146](../adr/146-fantasy-football-draft-platform.md); this document is the buildable detail.

**Scope:** a store package that drafts a fantasy football team and runs the league around it — the value
model and roster-construction engine first, then the site with its commissioner controls, then a
remote-node assistant for a live ESPN draft room. Queued in
[BACKLOG](../BACKLOG.md) as *"Fantasy football — the draft engine, the league site, and the live-draft
node"*.

**The one sentence that shapes everything below:** a pick is not "the best player left", it is *the change
in the points your starting lineup will actually score over the rest of the season*. Every algorithm here
exists to compute that number, which is what the operator meant by **build from the team out**.

---

## Part 1 — Functional specification

### 1.1 The three things a user does

| surface | who | what it does |
|---|---|---|
| **Draft** | anyone drafting | a board, a queue, a recommendation with its reasoning, and a clock. Works with no external league at all (paper mode). |
| **League** | every member | rosters, matchups, lineups, waivers, trades, standings — the ordinary season. |
| **Commissioner** | one person | league settings, member management, corrections, and an audit trail of every correction. |

### 1.2 The draft board, mid-draft

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

  YOUR ROSTER   RB Bijan Robinson (bye 12) · WR Nico Collins (bye 6) · WR Ladd McConkey (bye 5)
                weakest starting slot: RB2 (replacement in 9 weeks) · bye collision: none
```

Every number on that screen is derived, and every one of them is explained in Part 2. The recommendation
never picks anything — a human presses the button.

### 1.3 League configuration

Everything that changes the math is configuration, never a constant in code:

- **Format** — snake, auction, or keeper/dynasty; team count; draft order; auction budget.
- **Roster slots** — QB/RB/WR/TE/FLEX/superflex/K/DST/bench/IR, any counts.
- **Scoring** — per-stat points (PPR, half, standard, TE premium, custom bonuses), entered as a stat→points
  map, defaulted from the connected league's own `mSettings` when there is one.
- **Season shape** — regular-season weeks, playoff weeks and bracket size, trade deadline, waiver mode
  (FAAB budget or rolling priority), lineup lock policy.

### 1.4 Commissioner controls

A separate surface, not buttons sprinkled through the app:

- edit any roster, score, or lineup; re-open a locked lineup; reverse a transaction
- set or re-draw the draft order; pause, resume, or roll back the draft
- invite and remove members; reassign a team to a different member
- force-process waivers; veto or approve a trade
- **an audit row for every one of these** — who, when, before, after — visible to the whole league

### 1.5 What arrives when

| phase | ships |
|---|---|
| **P0** | the engine: projections, values, tiers, the lineup optimizer, the draft simulator, the backtest. Usable from the draft surface in paper mode. |
| **P1** | the league site and the commissioner surface. |
| **P2** | the live-draft node assistant. |
| **P3** | in-season automation — waiver recommendations, start/sit, the trade analyzer (all the same engine). |

---

## Part 2 — Technical specification

### 2.1 Where the data comes from

| input | source | credential |
|---|---|---|
| player pool, ADP, auction values, ownership, raw projections | ESPN public player feed | **none** |
| a private league's settings, rosters, matchups | `espn-fantasy` connector (core #362) — `SWID` + `espn_s2` | account cookies |
| opponent strength, injuries weighted by production share | the `sports-edge` model inputs | none |
| live draft-room picks | a remote node reading the operator's own browser session | never leaves the machine |

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
league's `mSettings.scoringItems`, or from the league record configured in 1.3.

Two independent projections are carried and blended at a weight the backtest sets: ESPN's per-week stat
line, and a tape-built projection using `sports-edge`'s opponent-adjusted ratings and its
production-weighted injury adjustment. One vendor's number is never the only input.

#### 2.2.2 Availability

Each week carries a start probability `a(p, w)` — 0 on a bye, reduced by injury status, else 1. Expected
points are `a(p,w) × pts(p,w) + (1 − a(p,w)) × replacement(pos)`, so an injured stud is worth what a real
manager gets: his replacement, in the weeks he misses.

#### 2.2.3 Replacement level — the baseline is the league, not a rank

```
R_pos  = teams × (starters_pos + flexShare_pos)      # how many of this position actually start
B_pos  = mean season points of players ranked R_pos … R_pos+2
VOR(p) = seasonPoints(p) − B_pos
```

`flexShare_pos` is the fraction of FLEX slots historically filled by `pos` in a league of this shape.
A 12-team 2RB/3WR/1FLEX league and a 10-team 1FLEX league get different baselines, which is the point.
Recomputed as the pool empties.

#### 2.2.4 Tiers — where the cliff is

Within a position, sort by VOR and take gaps `g_i = v_i − v_{i+1}` over the top 60. A tier edge is any
`g_i > k · σ_g` (start at `k = 1.5`, calibrated in the backtest). Tiers come out variable-sized, which is
correct — a draft is a sequence of "which cliff falls next" decisions, not a ranked list.

#### 2.2.5 VONA — what the pick actually costs

The cost of taking `p` now is the best player still there at your **next** pick `N'`. Model each
intervening pick as a draw from the remaining pool weighted around ADP:

```
P(p survives to N')  =  Π over picks n ∈ (N, N')  [ 1 − select(p, n) ]
select(p, n)         ∝  φ( (n − adp_p) / s_adp )        # normal kernel around ADP
VONA(p)              =  MV(p | R) − E[ max over q surviving to N' of MV(q | R) ]
```

`s_adp` is a modelled parameter, not a measured one — ESPN publishes `averageDraftPosition` but no
dispersion — so it is calibrated in the backtest and stated as an assumption on the surface.

#### 2.2.6 Marginal lineup value — this is "build from the team out"

Everything above ranks players. This ranks *your team with them in it*.

```
L(R, w)   = max over legal slot assignments of  Σ expected points        # weekly optimal lineup
SV(R)     = Σ_w  ω_w · L(R, w)                                           # season value
MV(c | R) = SV(R ∪ {c}) − SV(R)                                          # the number on the board
```

`ω_w` weights the fantasy playoff weeks (15–17) above week 3. `L` is a bipartite assignment over slots;
greedy from most-restrictive slot is exact for standard slot sets, with the Hungarian method as the
fallback when a league defines exotic multi-position slots.

This single mechanism replaces a pile of hand-typed rules, and that is why it is the centrepiece:

- a **third RB** is worth what it adds *in the weeks it would actually start* — usually little, sometimes a lot
- **bye collisions** price themselves: the week your only QB is out is a week `L` drops to a replacement
- **handcuffs** price themselves through correlated availability — a backup's value rises exactly as his starter's `a(p,w)` falls
- **positional scarcity** needs no rule at all: it is the shape of `B_pos`

#### 2.2.7 Simulating the rest of the draft

Greedy `MV` is still myopic — it does not know what the board looks like in three rounds. So for each of
the top `K` candidates by VONA:

```
for m in 1..M:
    simulate remaining picks — opponents draw around ADP, we take argmax MV thereafter
    score the completed roster with SV(R_final)
recommend argmax over a risk functional of the resulting distribution
```

Early rounds optimize the mean (upside is cheap when there is time to correct); late rounds optimize a
lower percentile (floor). Budget: `K = 10`, `M = 300`, which bounds a recommendation to a few hundred
thousand lineup evaluations — well inside a draft clock on the box, and the numbers to tune first if it is
not.

#### 2.2.8 Auction

Same engine, one extra variable. With inflation `ι = (money left in the room) / (value left on the board)`:

```
maxBid(c) = the price at which MV(c | R) per dollar stops beating the best
            MV-per-dollar reachable with the remaining pool and remaining budget
```

Solved greedily against the remaining-value knapsack, recomputed after every sale.

#### 2.2.9 The honesty gate

The engine must beat *following ADP* before anyone calls it an edge — the same standard sports-edge and
kalshi run under:

1. Take a completed season. Draft using **only** data available before it started (this is why ADP is
   snapshotted, not recomputed — see 2.3).
2. Opponents draft straight off ADP with noise. Vary the draft slot 1…N.
3. Score every resulting roster on the season's **actual** weekly optimal lineup.
4. Report mean points, win rate against the ADP rosters, and the distribution — across **≥100 drafts**.
5. A loss is reported as a loss.

Live drafts are registered before the season and graded after it, in the same table.

### 2.3 Data model

All tables `ff_` prefixed, owner-scoped, in the package's own migrations.

| table | holds | note |
|---|---|---|
| `ff_leagues` | format, team count, roster slots, scoring map, season shape, external league ref | scoring/slots as JSONB — configuration, never constants |
| `ff_teams` | team, league, draft slot, owning member | member nullable while single-operator (ADR-146 D3) |
| `ff_players` | player cache: name, position, pro team, bye week, eligible slots | refreshed daily |
| `ff_projections` | per player/week/source raw stat map | never points — points are computed per league |
| `ff_adp` | ADP, auction value, ownership, **captured_at** | an immutable snapshot; a backtest is worthless with today's ADP, the same reason sports-edge 0.3.0 captures the opening line |
| `ff_drafts` | status, mode (live/mock/paper), current pick, cursor | |
| `ff_picks` | overall, round, team, player, source (manual/node/engine), rationale | rationale stores the tier/VOR/VONA/MV that justified it |
| `ff_rosters`, `ff_lineups` | who is on a team, who starts in a week | |
| `ff_transactions` | adds, drops, waivers, trades | |
| `ff_admin_audit` | commissioner action, actor, before, after | league-visible (1.4) |
| `ff_draft_grades` | registered picks, baseline points, actual points, graded date | the honesty gate's ledger |

### 2.4 Routes

Under the package's route root, auth-gated (routes are public by default in this codebase — CLAUDE.md):

```
POST   /leagues                     create; GET/PATCH /leagues/:id      settings
POST   /leagues/:id/members         invite/assign        DELETE …/:sub  remove
POST   /drafts                      start (mode: paper | mock | live)
GET    /drafts/:id/board            board + your roster + the recommendation
POST   /drafts/:id/picks            record a pick (a human's confirm; never the engine's)
GET    /drafts/:id/recommend        candidates with tier/VOR/VONA/MV and the reasoning
POST   /drafts/:id/sync             cursor read from the node (2.5)
GET    /leagues/:id/lineups/:week   set/optimize a lineup
POST   /leagues/:id/trades          propose/evaluate — the analyzer is MV on both rosters
POST   /admin/:id/*                 commissioner actions; every one writes ff_admin_audit
GET    /backtest                    run and report the 2.2.9 protocol
```

### 2.5 The live-draft node loop

Per ADR-146 D4 there is **no new core rail**. The app issues short, repeated tasks to a chosen node:

1. the app dispatches a browser task: *open the draft room, return picks after cursor `c`*
2. the node runs it against the operator's already-logged-in browser and completes it — one claimed task,
   released immediately
3. the app appends the picks, advances `c`, re-runs 2.2.7, updates the surface
4. repeat until the draft ends

The ESPN cookies never leave that machine; only picks — public inside the room — come back. Nothing is
ever submitted: **no autopick path exists**, per the automation opt-in directive.

### 2.6 Guards (one per failure this spec can already name)

| guard | goes red when |
|---|---|
| two-rule scoring | the same fixture player scores identically under PPR and standard — i.e. someone hardcoded a stat table |
| filter-header | a pool read without `x-fantasy-filter` is treated as data instead of failing loudly (the silent 50-player page) |
| optimizer exactness | the slot assignment disagrees with brute force on a small roster |
| ADP immutability | a snapshot row is rewritten after `captured_at` |
| no-autopick | a pick can be recorded without a human confirm |
| backtest reports losses | the backtest path can return a summary that omits the ADP baseline comparison |

### 2.7 Open items

The three operator questions in ADR-146 (skill extraction now or later; single-operator or multi-member in
P1; package name, suite, and whether it groups with sports-edge) gate P1 but not P0 — the engine's inputs
are public and need no decision to start.
