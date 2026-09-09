# Fantasy football — connecting ESPN and reading the weekly board

The Fantasy tab of Sports Edge (`/cockpit/?app=sports-edge`, then **Fantasy**) reads your ESPN
league, scores ESPN's raw projections with **your league's own rules**, and recommends the lineup
with the best chance of beating the team you actually play that week. It advises; it never touches
your ESPN lineup. Design lives in [ADR-146](../adr/146-fantasy-football-draft-platform.md) and
[the spec](../apps/fantasy-football-spec.md).

Two rules underlie everything below:

- **Points only exist relative to a league.** ESPN publishes projections as *raw stats*, never as
  points — a total is meaningless until multiplied by a scoring rule. Every number you see was
  computed with the `scoringItems` your league actually uses. No stat table is hardcoded anywhere.
- **Nothing is ever submitted for you.** There is no route in this app that changes a lineup, makes
  a claim, or accepts a trade on ESPN. You read the advice and you press the buttons on ESPN.

## Connecting your league

ESPN publishes **no OAuth and no API key** for fantasy. The only credential that exists is a pair of
cookies from a signed-in `espn.com` session — `SWID` and `espn_s2`. Treat them as what they are:
**whole-account session cookies**, not a scoped key. They cannot be revoked for this app alone, and
signing out of ESPN everywhere is the only way to kill them.

You do not need them at all for the public half — the player pool, ADP, auction values and ESPN's
own weekly projections are all credential-free. They are needed only to read a **private** league:
your roster, your opponents' rosters, the schedule and your league's scoring rules.

**Path A — paste them yourself** (works today):

1. Sign in at `fantasy.espn.com` in Chrome or Edge.
2. `F12` → **Application** → Storage → **Cookies** → `https://fantasy.espn.com`.
3. Copy **`SWID`** — including the braces, `{1A2B3C4D-…}` — and **`espn_s2`** (long, URL-encoded).
4. Open the connectors page inside the app (`/cockpit/?app=sports-edge` → **Connections**), find
   **ESPN Fantasy**, and paste: the **SWID** in the account field, **espn_s2** as the token.
5. Back on the **Fantasy** tab, enter your league id (the `leagueId=` in your ESPN league URL) and
   press **Link**. Your own team is found automatically by matching your SWID against the league's
   owners — you never look up a team id.

**Path B — let the desktop node capture them** (Config → Accounts → ESPN Fantasy → *Log in + push*).
The node opens a real ESPN sign-in window and pushes the pair for you. This path is built but is not
yet running on any machine here — see the BACKLOG entry *"The ESPN 'Log in + push' button has not
reached a running node"* for exactly what is missing.

**Where the cookies go.** They are stored by the connector broker, resolved per request, used on the
one outbound ESPN call that needs them, and discarded. They are never logged, never returned in a
response, never written into a table by this app, and never placed where a model can read them. The
`SWID` (which identifies the account and is not a secret) is shown back to you; `espn_s2` never is.

## Reading the weekly board

### The matchup card

```
Week 3 vs Team Roman

  You project   108.4      They project   121.7
  Win chance      34%      Safest lineup wins   31%

  You are the UNDERDOG this week, so the lineup changes shape — you need the tail,
  not the average.
```

This is the part that makes the app disagree with every "optimal lineup" tool you have used, so it
is worth understanding. A fantasy week is not a scoring contest against the field; it is
head-to-head against one known opponent. So what the app maximises is not your projected total, it
is the chance you outscore them:

```
P(win) = Φ( (your projection − their projection) / √(your swing² + their swing²) )
```

Work through what that implies and it is arithmetic, not opinion:

- **When you are behind on projection, your win chance goes UP with your own volatility.** Starting
  the boom/bust player is correct. You do not need the average, you need the tail.
- **When you are ahead, your win chance goes UP as volatility falls.** Start the steady one and
  refuse the coin flip.

A team that plays its safest lineup every single week while projecting behind is choosing, week
after week, the option that most reliably loses to better teams.

**The two percentages are always shown together.** *Win chance* is what the recommendation buys;
*safest lineup wins* is what the plain highest-projected lineup would have won. When they are equal,
the two objectives agree and nothing was given up. When they differ, the swap table says exactly
what it cost:

| column | means |
|---|---|
| **Start / Over** | who moves in, who moves out, each with their projection and their **swing** |
| **Points given up** | projected points the swap costs (a `+` means the swap gains points too) |
| **Win % gained** | what it bought — a swap is never taken unless this is positive |

**"Swing" is modelled, not measured, and the app says so on the screen.** ESPN publishes a
projection with no dispersion — there is no per-player variance feed anywhere in its API. So a
player's swing starts from a **positional prior** (receivers and defences are streakier than
quarterbacks) and moves toward that player's own weekly scores as the season produces them. Only the
*ordering* of those priors is load-bearing; the magnitudes are placeholders that the graded ledger
will replace. Treat swing as a shape, not a measurement.

### Start / sit

The changes worth making against the lineup you have actually set, biggest gain first, each with the
reason in words. **An empty list is the normal and correct answer** — a tool that always finds
something to change is fidgeting, not advising.

A player ESPN has ruled **OUT** is never recommended as a starter however good his projection looks,
and when he is the one being benched he is priced at **zero**, not at his projection. That matters:
pricing a ruled-out star at his stale projection makes the gain from benching him look negative,
which silences the tool on precisely the swap that costs the most.

### Projected starters, and the record

The lineup itself, then the bench. The footer names when the shared projection feed was last
refreshed and how many players it covered — if that date is old, the numbers are old, and the page
tells you rather than pretending.

Every recommendation is **registered before kickoff** and graded afterwards against what the benched
player actually scored. The **Record** section is that ledger. A call nobody records is a call that
never has to be right.

## When it cannot reach ESPN

The app degrades rather than lying, but the messages are worth knowing:

| what you see | what it means |
|---|---|
| *"Connect ESPN Fantasy to read a private league."* | You have no ESPN connection stored — **or** ESPN could not be reached at all. Those two are not yet told apart; if you know you are connected, suspect the network before re-pasting cookies. |
| *"ESPN would not return that league right now."* | You are connected, and ESPN refused or did not answer. Usually transient; the league id being wrong looks the same. |
| *"No opponent could be read for this week"* | Either a genuine bye, or the schedule read failed. The lineup shown is then simply the highest-projected one — safe, just not opponent-aware. |
| Projection date in the footer is old | ESPN's ~39 MB player feed could not be refreshed, so a cached one is being used. A stale cache beats a blank screen, and the date is there so you can judge. |

**Before blaming ESPN, check your own DNS.** On 2026-09-09 every ESPN endpoint on this box returned
a connection failure and looked exactly like an outage — but `github.com` and `google.com` failed
identically, the local resolver (`192.168.1.1`) was timing out, and resolving through `8.8.8.8`
reached ESPN's fantasy API with a **200**. ESPN was fine; the router's DNS was not. One command
separates the two:

```bash
# if this answers, ESPN is up and your resolver is the problem
nslookup lm-api-reads.fantasy.espn.com 8.8.8.8
```

## What this app will not do

- **It will not change anything on ESPN.** No lineup submission, no waiver claim, no trade
  acceptance, no autopick. Outward-acting automation is opt-in and off by default across this
  platform, and none is built here.
- **It will not bet.** Sports Edge's odds-making half carries no order path at all until its
  scorecard says it beats the market, and the fantasy half has nothing to stake.
- **It will not pretend to a precision it does not have.** Swings are priors, the independence
  assumption between two lineups is stated in the code, and every claim it makes about its own
  performance comes from the graded ledger rather than from a projection.

## Not yet built

Waivers with a bid, the two-sided trade finder, streaming, and rest-of-season value (today's
optimiser prices one week at a time). The queue and its done-when criteria are in
[BACKLOG](../BACKLOG.md) under *"Fantasy football — the draft engine, the league site, and the
live-draft node"*.
