# ADR-168 — Trading sleeves: the long sleeve formalised, intraday declined, futures deferred, and a multi-market universe kept on paper until it is proven

- **Status:** Proposed. Ratifying the sleeves is the operator's decision. The only code built against this ADR is described in D3: the `MULTI_MARKET_UNIVERSE` constant, `SECTOR` coverage for its new names, and a Test Lab readback. No dispatch leg reads the constant. The ADR is accepted when the operator ratifies the sleeve set (D1) and the acceptance bar (D6) with a strategy-log row.
- **Date:** 2026-09-27
- **Depends on:**
  - [ADR-052](052-stock-trading-swarm.md): no justification, no trade; paper-only by default.
  - [ADR-054](054-gravity-model.md): the gravity rank.
  - [ADR-092](092-trading-strategy-lab.md) and [ADR-095](095-strategy-library-apply-to-profile.md): the Strategy Lab, per-book apply, and blends.
  - [ADR-116](116-futures-extension-layer.md): futures.
  - [ADR-134](134-multi-account-trading-books.md): books and guardrails.
  - [ADR-136](136-trading-surface-information-architecture-and-direct-trades.md) D10: un-pinned advisors follow `DEFAULT_UNIVERSE`.
  - [ADR-142](142-ipo-event-sleeve.md): the IPO sleeve, and the house shape for a sleeve acceptance bar.
  - [ADR-143](143-market-data-stream.md): the real-time feed decision and its purchase triggers.
  - [ADR-159](159-the-engine-manages-only-what-it-can-account-for.md): unaccounted positions.
- **Closes the design half of:** the BACKLOG entry "Trading platform surface and engine expansion" ([BACKLOG.md](../BACKLOG.md)).
  - That entry says the sleeves ADR "must be numbered 144". ADR-144 is the [guest-seed contract](144-guest-seed-contract.md), so this ADR takes 168.
  - Correcting that wording is left to whoever owns the BACKLOG.

---

## Context

### The backlog item

What remains to do: "design futures/intraday/long sleeves plus a roughly 200-symbol multi-market universe". The item is done when "every added sleeve is paper-proven behind kernel risk gates". The surface half (the allocation and exits cards, and arming no longer pinning `DEFAULT_UNIVERSE`) shipped as ADR-136 D10.

### The sleeves that exist today (verified in the source at this ADR's base)

| Sleeve | What it does | Where | State |
|---|---|---|---|
| **Beta core** | Deploys idle cash toward a target % in `TRADING_CORE_SYMBOLS`. The core is exempt from every sleeve sell. `SYM:0` marks an operator hold. | `coreConfig` `src/app/trading-dispatch-core.ts:48`; `runAutopilot` step 0 `src/app/trading-schedule-dispatch.ts:244-250` | Armed ([active-strategy.md](../apps/trading/active-strategy.md) knob table) |
| **Gravity rotation** | Runs on a daily cadence. Ranks the universe on daily closes and holds the top-N positive scores. Held names ride overnight and across days. | `src/app/trading-schedule-dispatch.ts:266-317`; `rotateSleeve` `src/app/trading-dispatch-rotation.ts:175`; `rotateBlendSleeve` `:363` | Armed: gravity, top-12, conviction, `active` posture, SPY core |
| **Scan sleeve** | Uses the 5-minute multi-timeframe ensemble for technical sells, benches and entries. | `src/app/trading-schedule-dispatch.ts:367` onward. It runs only when rotation does not own the sleeve. | Built; not the armed path |
| **Pop-catcher** | Buys a 5-minute surge. | `src/app/trading-dispatch-exits-entries.ts`, `TRADING_POP_CATCHER` (default off) | Rejected ([backtest-regression-suite.md](../apps/trading/backtest-regression-suite.md) row 4) |
| **Swing leg** | Runs a daily Donchian breakout with a channel exit on six commodity ETFs, held across days. Paper-only. | `src/app/trading-swing-dispatch.ts:8-22`; universe `:55` | Built; paper-only |
| **Blend components** | 2–6 weighted rotation components, with the remainder parked in the core. | `normalizeBlend` `src/app/trading-strategy-lab-sim.ts:191-201`; `src/app/trading-blend.ts`; `rotateBlendSleeve` | Built; inert until applied (ADR-095 round 2) |
| **Idle-cash yield** | Not built. | Owned by the BACKLOG entry "Queued paper-to-live parity features" | — |
| **Futures** | Research rail only. There is no paper book. | ADR-116; [futures-phasing.md](../apps/trading/futures-phasing.md) Phase 4 | Research only |

Pinned lots ([ADR-138](138-single-stock-research-watchlist-and-pinned-lots.md)), event plans (ADR-136 D6; the IPO sleeve is ADR-142) and earnings rules (ADR-136 D5) are event legs, not allocation sleeves. This ADR does not touch them.

### What the recorded evidence already says about the three named sleeves

- **Long (multi-day hold).**
  - [intraday.md](../apps/trading/intraday.md):149-150: "the alpha is not at the intraday horizon … keep its rotation slow (multi-day)".
  - Same file, :152-158: "The alpha is in the HOLD".
  - [strategy-log.md](../apps/trading/strategy-log.md):272-280: overnight carried +33.2 of SPY's +41.4 points over 25 months, and the flat-by-close holder compounded to −62.1 %.
  - The armed rotation's record: [active-strategy.md](../apps/trading/active-strategy.md):37-38 reports +38.6 % against SPY's +37.6 % over the 26-month walk, and +20.9 % against +10.1 % at 126 days. Suite row 3 (:62) reports Sharpe 2.36 and "rotation alpha real".
- **Intraday.**
  - intraday.md:144-150: "intraday cross-sectional momentum is a validated dead end".
  - strategy-log.md:203-214: intraday research on IEX is invalid, and anything intraday must use `feed=sip`.
  - strategy-log.md:358-386: "The event-pop family is CLOSED … Do not reopen without a genuinely new information source".
  - Suite rows 4 (REJECT), 8 (extended hours OFF) and 9 (flat-overnight KILLED).
- **Futures.**
  - The ADR-116 amendment of 2026-09-24 (:108) published the Phase 2 out-of-sample result: ES −$3,052.50 over 31 trades and CL −$2,272.26 over 74 trades.
  - futures-phasing.md:399-407: a result ≤ 0 on every market closes the live items as "do not build live" and leaves Phases 3–5 at the operator's discretion.
  - futures-phasing.md:264-273: Phase 4 (the durable paper book) requires explicit operator approval before it starts.

### The universe today, and where sectors are read

- **The universe.** `DEFAULT_UNIVERSE` has 159 US-listed names (`src/features/trading/services/multi-timeframe.ts:197`), bucketed into 10 sectors by `SECTOR` (`src/features/trading/services/portfolio.ts:166`).
- **Who follows it.** Every un-pinned advisor scans it (ADR-136 D10, line 169), and the store's `TRADING_UNIVERSE_MAX_PIN` defaults to its length. Changing it therefore changes every un-pinned book on its next fire.
- **What a Lab strategy can carry.** A Lab strategy can carry any universe whose symbols pass `/^[A-Z.]{1,6}$/` (`trading-strategy-lab-sim.ts:167-170`).
  - A strategy is applied per book: `trading-config-overrides.ts:107` allows one active override per `(user_sub, book_id)`.
  - The dispatcher resolves the universe in this order: the override's universe, then the schedule pin, then `DEFAULT_UNIVERSE` (`trading-schedule-dispatch.ts:529-537`).
- **Who reads `sectorOf`.** Three consumers:
  - `sizeEntry`'s per-sector cap (`portfolio.ts:474-475`), which the scan, pop and research entry paths and the Lab's ensemble simulation use.
  - `applySectorTilt`, which the rotation calls (`trading-dispatch-rotation.ts:203`).
  - The ADR-136 D10 Allocation card.
- **What the rotation's buy sizing ignores.** It does not read the sector cap. Each name's goal is `min(per-name cap, conviction share)` (`trading-dispatch-rotation.ts:284-290`), bounded by `maxPositions` (:322) and by settled cash re-read after the sells (:317).

---

## Decision

### D1. The sleeve set

| Sleeve | Verdict | New code |
|---|---|---|
| **Long sleeve = the gravity rotation, formalised** | **Adopted as it stands.** Its capital share is expressed per book in one of two ways. A solo apply uses ADR-095's `applyPct`: the sleeve gets `(100 − corePct) × applyPct/100`. A blend gives the sleeve its component's `weightPct`, and the remainder is the core. It is already armed on its recorded evidence (Context). Formalising it adds no order path, so it needs no new paper proof. | **None.** `rotateBlendSleeve` already executes weighted rotation components per book. The conditional "kernel long-sleeve execution" slice is not triggered. `tests/unit/trading-blend.spec.ts` now proves that a multi-market component normalizes, scans the union and pins both universes for replay. |
| **Multi-market long sleeve (MM-1)** | **Added.** This is the one sleeve this ADR adds: the incumbent rotation run over `MULTI_MARKET_UNIVERSE` (D2). It is paper-proven per D6 before any live apply. | The constant and its coverage (D3). Execution needs nothing new. |
| **Intraday** | **Declined.** The evidence is in Context. Reopening requires **all** of the triggers listed after this table. | None |
| **Futures** | **Deferred to the ADR-116 Phase 4 gate.** There is no second futures design, universe or sleeve here. If the operator approves Phase 4, the durable paper book it builds is the futures sleeve's paper proof, judged by ADR-116's own gate. Commodity exposure on the equities rail stays with the swing leg and is excluded from MM-1 (D2). | None |
| **Unchanged** | Beta core, scan sleeve, pop-catcher (closed), swing leg, blend rail, the event legs, and the idle-cash yield sleeve (owned elsewhere). | None |

The triggers that must all hold before intraday reopens:

1. A pre-registered hypothesis names a genuinely new information source (strategy-log.md:384-386).
2. Its study runs on `feed=sip` historical data (strategy-log.md:213-214; active-strategy.md standing rule 2).
3. Its acceptance is the standing new-sleeve arming bar (active-strategy.md:64-65).
4. Before any order, ADR-143 D1 purchase trigger (b), "any intraday strategy is armed for real orders", reopens the real-time feed decision.

The 5-minute breakdown exit is a protection on held names, not an intraday sleeve, and is unchanged.

So "every added sleeve" in the done-when means **MM-1**. A futures sleeve counts only if Phase 4 is approved, and then only under ADR-116's gate.

### D2. The multi-market universe

**Definition.** `DEFAULT_UNIVERSE` (159 names, unchanged) plus 41 US-listed exchange-traded instruments, 200 names in all. The 41 reach markets the default list cannot. They are reachable through the existing equities rails: the same bar feeds and the same one order path, with no new data source and no new venue.

| Bucket (new) | Names | Market |
|---|---|---|
| `intl-developed` | EFA, VGK, EWJ, EWG, EWU, EWC, EWA, EWL, EWH | Developed ex-US equity (broad, Europe, Japan, Germany, UK, Canada, Australia, Switzerland, Hong Kong) |
| `emerging` | EEM, FXI, KWEB, INDA, EWZ, EWT, EWY, EWW, EZA | Emerging-market equity (broad, China large-cap and internet, India, Brazil, Taiwan, Korea, Mexico, South Africa) |
| `fixed-income` | TLT, IEF, IEI, TIP, LQD, MUB, BNDX, EMB | US Treasury ladder (20+, 7–10, 3–7 years), TIPS, investment-grade credit, municipal, international and emerging-market sovereign bonds |
| `commodities` | CPER, DBA, PPLT | Copper, agriculture, platinum |
| `real-estate` | VNQ, VNQI, PLD, AMT, O, SPG, PSA | US and international REIT indices plus five large US REITs |
| `currency` | UUP, FXE, FXY | US dollar, euro, yen |
| `digital-assets` | IBIT, ETHA | Spot bitcoin and ether funds |

**Composition rules.** Each rule is guarded by a spec.

1. Every name is US-listed, unlevered and non-inverse. Its symbol has the shape `/^[A-Z]{1,5}$/`, which also passes the Lab's filter.
2. No name is already in `DEFAULT_UNIVERSE`, and `DEFAULT_UNIVERSE` stays the unchanged prefix of the multi-market list.
3. Every name gets a market bucket, and every bucket is one that no default-universe name uses. That is what makes D3's invariance hold by construction.
4. Some names are excluded by construction:
   - the swing leg's six ETFs (USO, BNO, UNG, GLD, SLV, DBC), so two sleeves never trade one symbol on a book (the promise `trading-swing-dispatch.ts:20-21` makes);
   - SPY: the benchmark, the Lab's default core symbol and the armed core;
   - the cash-like funds SGOV, BIL, SHV, USFR and SHY: the "shelter" candidates in `scripts/oshal-trading-knob-sweep.ts:203-211`, kept for the idle-cash yield sleeve;
   - US sector ETFs, which are slices of the default universe's own buckets.
5. Overlaps are disclosed, not hidden. Buckets follow the instrument's market, so a doubled bet stays possible, and D6's concentration readout is where it would show:
   - a diversified country index can hold a default name (TSM in EWT, SK Hynix in EWY);
   - a commodity fund's price drives default producers (CPER against FCX and SCCO);
   - the spot-crypto funds sit beside COIN and HOOD.

**History.** Rotation and the Lab drop any name with fewer than 60 daily closes (`trading-dispatch-rotation.ts:93,113`). A young listing therefore excludes itself instead of failing a run. The soak reports how many names were eligible.

**Where it lives.**

- `MULTI_MARKET_BUCKETS` (`portfolio.ts:155`) is the single source of the 41 names and their buckets.
- `MULTI_MARKET_EXTENSION` and `MULTI_MARKET_UNIVERSE` (`multi-timeframe.ts:246`, `:254`) are derived from it and frozen.
- All three are exported from `@/features/trading`. The store preset must import them rather than type a second list.

### D3. What this change does, and does not do, to a running book

Delivered with this ADR:

- **`DEFAULT_UNIVERSE`** is unchanged. The diff touches nothing above it, and `tests/unit/trading-multi-timeframe.spec.ts` asserts it is the multi-market list's prefix.
- **`SECTOR`** gains 41 keys, each of which resolves to `other` on the base commit. No existing key changes, and `RISK_POLICIES` is identical. A scratch comparison of the base and branch `portfolio.ts` over all 159 default names and all 159 existing keys found 0 changes; the result is recorded in the PR.
- **Reach.**
  - A book whose positions and universe are all pre-existing `SECTOR` names sizes, caps, tilts and displays exactly as before. `tests/unit/trading-portfolio.spec.ts` checks the sizing: holding TLT, EFA and IBIT leaves a default-universe entry sized identically. `tests/unit/trading-sector-tilt.spec.ts` checks the tilt: a lean on every new bucket leaves a default-only ranking byte-identical.
  - A book that holds or scans one of the 41 names sees that name move from the shared `other` bucket into its own market bucket. It stops consuming `other` room and gets its own cap. The portfolio spec shows IEF refused by a full fixed-income bucket, while EFA and an unbucketed name keep their room.
  - That is the only behaviour change, and it is the purpose of the coverage. On the Allocation card, such a held name moves from *unclassified* to its bucket.
- **What is still unread.** No dispatch leg, schedule, route or default reads `MULTI_MARKET_UNIVERSE`. `TRADING_UNIVERSE_MAX_PIN` still defaults to `DEFAULT_UNIVERSE.length`, so a 200-name schedule pin is still refused with a 400. The paper path is a Lab override (D7), not a pin.
- **Test Lab card `trading-sleeves-universe`.** This is a credential-free readback of the constant on the running image, for use after deploy. It fails if a rule in D2 breaks, reports degraded if one of this node's `TRADING_CORE_SYMBOLS` sits inside the universe (the rotation skips core symbols), and never claims the paper proof.

### D4. Scan cost against the vendor ceiling

- **Rotation.** Each fire makes one daily-bar call over the universe: `barsBatch(universe, '1Day', 150)` (`trading-dispatch-rotation.ts:198`). The 220-day lookback (`market-data.ts:75-77`) covers about 152 sessions, so 200 names come to about 30,400 bars, or 4 pages at `limit=10000`.
- **Scan.** Every fire also runs `multiTimeframeScan` over the book's universe (`trading-schedule-dispatch.ts:324`). That is five timeframe calls of at most 8 pages each (`market-data.ts:198-201`): at most 40 requests per fire per book. Add the rotation's pages and one paper book stays well inside Basic's 200 requests per minute (`market-data-rate-limit.ts:16`). A 429 is retried under the vendor's own contract (core `57e87692`) instead of aborting the run.
- **Short timeframes are the bound.** One call returns at most 8 × 10,000 = 80,000 bars.
  - For 5Min, the 7-day lookback is about 5 sessions. IEX prints only between 08:00 and 17:00 ET (active-strategy.md:31), which caps a name at 108 five-minute bars per session and 540 over the lookback. That is at most 108,000 bars at 200 names, and at most 85,860 at 159.
  - `isShortTermPop`'s doc (`multi-timeframe.ts:144`) already records that the 1-hour feed is truncated at scale.
  - Actual counts depend on each name's IEX print density, which the code cannot know in advance.
  - When a call truncates, the affected names lose that timeframe. `decideSymbol` renormalises over what it has and writes "[N tf w/o data]" (`multi-timeframe.ts:119`). `isShortTermBreakdown` needs both 5Min and 1Hour (`multi-timeframe.ts:135-139`), so it cannot fire for those names.
  - D6 therefore reports short-timeframe coverage of held names as a soak metric. The daily rotation itself is not affected.

### D5. Kernel risk gates each sleeve passes through

All of these exist today. MM-1 adds none and bypasses none: it executes through `rotateSleeve`/`rotateBlendSleeve` and `placeManaged` → `placeDecisionOrder`.

| Gate | Where | Binds the rotation (long sleeve, MM-1) |
|---|---|---|
| `TRADING_HALT` kill switch | `trading-schedule-dispatch.ts:559-565` | Yes: no entries and no exits while set |
| Book enabled (ADR-134) | `trading-schedule-dispatch.ts:274`; `trading-engine.ts:409-411` | Yes |
| Equity drawdown guard, fail-closed | `trading-schedule-dispatch.ts:289`; `trading-equity-guard.ts:72`; `maxDrawdownPct` | Yes |
| Posture dials | `RISK_POLICIES` `portfolio.ts:83`; `riskPolicy` `:111` (an applied posture wins, ADR-095) | Per-name goal, `maxPositions` and exits, but **not** `maxSectorPct` |
| Operator blocklist and earnings blackout | `trading-dispatch-rotation.ts:209`; `symbolBlocklist` `portfolio.ts:137` | Yes |
| Entry guards (same-fire re-entry, gap-down) | `trading-dispatch-rotation.ts:242`; `entry-guards.ts:106,130` | Yes |
| Per-name goal cap, max positions, settled-cash funding | `trading-dispatch-rotation.ts:284-290`, `:322`, `:317` | Yes |
| Unaccounted positions withheld (ADR-159) | `trading-dispatch-rotation.ts:264`; `unmanagedSymbols` `portfolio.ts:205` | Yes |
| Protective exits: stop, take-profit, trailing, cap trim, dip | `exitsToRun` `portfolio.ts:259`, `trailingExits` `:337`, `rebalanceTrims` `:371`, `dipExits` `:229` | Yes, on every fire |
| Short-timeframe breakdown exit | `trading-schedule-dispatch.ts:338`; `multi-timeframe.ts:135` | Yes, where 5Min and 1Hour bars exist (D4) |
| Per-sector cap | `sizeEntry` `portfolio.ts:474-475` | **No** for the rotation; yes for the scan, pop and research entries |
| Sector tilt | `trading-dispatch-rotation.ts:203` | Ranking only |
| Fleet guardrails (`TRADING_MAX_NOTIONAL_USD`, `TRADING_MAX_QTY`) | `trading-routes-helpers.ts:113,130`, via `placeDecisionOrder` | Yes, on every order |
| Live gate: `TRADING_LIVE_ENABLED` plus an explicit confirm | `trading-engine.ts:412-413`; `broker-provider.ts:90` | Yes. This is the wall between a paper proof and live |
| Per-book apply with confirm (ADR-095 §5) | `trading-config-overrides.ts:107` | Yes. MM-1 reaches a book only through it |

**The one gap MM-1 makes visible.** The rotation does not read `maxSectorPct`, so a single market bucket can take every top-N slot. The default universe has the same property today. This ADR does not decide whether the rotation should enforce a bucket cap. The soak measures the per-bucket share of the sleeve (D6), so the operator can decide with a number. A rotation bucket cap would be its own kernel change with its own amendment.

### D6. The paper acceptance bar and soak for MM-1

**Pre-registration comes first.** Before any backtest, a strategy-log row states the hypothesis: adding the 41 multi-market names to the incumbent rotation lowers drawdown without lowering risk-adjusted return. The row also fixes the knobs (active-strategy.md standing rules 1 and 4, lines 60 and 66).

**One variable.**

- MM-1 is the armed rotation configuration (rank gravity, top-12, conviction, cadence 1, posture `active`, the armed SPY core) with universe `MULTI_MARKET_UNIVERSE`.
- The incumbent is the same configuration on `DEFAULT_UNIVERSE`.
- No knob is tuned for MM-1. A tuned row is only an upper bound (backtest-regression-suite rules).

**Backtest bar.** Both configurations run in the Lab over the same window and feed (default `windowDays` 780, about the 26-month walk the incumbent's record uses).

- **B1:** MM-1's `maxDrawdownPct` ≤ the incumbent's.
- **B2:** MM-1's `sharpe` ≥ the incumbent's.
- **B3:** MM-1's `alphaVsSpyPct` ≥ 0.

**Soak.** The paper book runs MM-1, and both strategies keep their nightly Lab forward walks (`LAB_CRON`, `trading-lab-dispatch.ts:27`) over the same sessions.

- **Length:** at least 8 calendar weeks and at least 40 forward-walk sessions, including at least one week in which SPY closed down (the standing bar's non-bull week). If 8 weeks pass without such a week, the soak extends until one occurs.
- **S1:** MM-1's forward-walk max drawdown over the soak ≤ the incumbent's.
- **S2:** MM-1's forward-walk return over the soak ≥ the incumbent's minus 1.0 percentage point. The tolerance is set before any number exists: over 8 weeks a strict "≥" would fail a diversifier on noise.
- **S3 (the sleeve was exercised):** at least 5 distinct names from the 41 were held on the paper book during the soak, and at least one of them was held through the non-bull week. Otherwise the soak did not test the extension; it is extended, not passed.
- **S4 (readouts in the result row, no threshold):**
  - the maximum per-bucket share of the sleeve, sampled daily from `GET /api/trading/exposure` `bySector`;
  - held names without both 5Min and 1Hour bars, measured by re-running `multiTimeframeScan` over the MM-1 universe at a regular-session fire with the paper key, the same batched calls the dispatch makes;
  - the eligible-name count (at least 60 closes);
  - the trade count;
  - the paper-book return against MM-1's forward walk (the gap between simulation and paper fills).

**This bar departs from the standing new-sleeve arming bar on purpose.**

- The standing bar (active-strategy.md:64-65) requires at least 4 paper weeks including a non-bull week, at least 200 trades, at least 0.4 % gross per trade, no overnight carries, and net ≥ 0 in the flat week.
- It came from sweep #4, for an intraday sleeve. "No overnight carries" contradicts a multi-day hold, and the recorded evidence says the return is in the hold. A daily top-12 rotation's trade count is not a design parameter.
- The substitute above is an operator decision, to be ratified in the pre-registration row. Until it is ratified, the standing bar governs. MM-1 cannot pass that bar by construction, so it stays paper-only.

### D7. Paper-first rollout

1. **This change merges:** the constant, the coverage and the Test Lab card. Nothing trades differently for a default-universe book (D3).
2. **The operator ratifies or amends D1 and D6** with a strategy-log row.
3. **Store:** a Strategy Library preset that resolves to `MULTI_MARKET_UNIVERSE` through the barrel, reusing the confirm-guarded per-book apply, with package specs and `tests/test-lab.yaml` cases.
4. **Deploy core** with `bash scripts/oshal-deploy.sh`, then run the Test Lab card `trading-sleeves-universe`. A pass confirms the image carries the constant.
5. **Pre-register**, then backtest MM-1 and the incumbent in the Lab (B1–B3) and record the rows.
6. **Apply MM-1 to the paper book only** as a per-book override. The live book keeps its own override or the env defaults.
7. **Soak** per D6.
8. **Record the dated result row** in strategy-log.md against B1–B3 and S1–S4.
9. **Promotion is two separate operator decisions**, each with its own row:
   - (a) Apply MM-1 to a live book, through the same confirm-guarded apply, with `TRADING_LIVE_ENABLED` and the live gate unchanged.
   - (b) Fold the 41 names into `DEFAULT_UNIVERSE`. This is never automatic: every un-pinned advisor on every book follows that list on its next fire (ADR-136 D10), and `TRADING_UNIVERSE_MAX_PIN` follows its length.

`DEFAULT_UNIVERSE` does not change before step 8 passes.

### D8. What is not decided or built here

- No bucket cap in the rotation (the D5 gap; it is measured in the soak).
- No change to `DEFAULT_UNIVERSE`, `TRADING_UNIVERSE_MAX_PIN` or any env default.
- No store preset, no deploy, no arming. Those are steps 3, 4 and 6.
- No futures code and no intraday code.
- No idle-cash yield sleeve. Another BACKLOG entry owns it.
- No automated evaluator for the D6 bar yet. The bar is Proposed. Once it is ratified, a read-only evaluator can grade B1–B3 and S1–S3 from the persisted Lab runs through the operator automation identity.

---

## Consequences

**Gained.**

- The design half of the backlog item has a definition, and "every added sleeve" has a concrete meaning: MM-1, plus a futures sleeve only through ADR-116's own gate.
- The multi-market universe exists as a guarded, frozen constant that a Lab rotation or blend can name today with no new kernel code.
- Its sector coverage leaves every default-universe book exactly as it was.
- Intraday and futures have written re-entry conditions instead of an open question.

**Costs and risks.**

- A book that already holds one of the 41 names (a manual buy, or a pin) sees that name change bucket once this is deployed. This is D3's one reach, stated rather than hidden.
- At 200 names, short-timeframe coverage is bounded by the 80,000-bar call cap, so the breakdown exit may not cover every held name. The soak measures this; nothing here solves it.
- The rotation has no bucket cap. A risk-off tape could put the whole sleeve in one market bucket. The soak measures this.
- Some instruments overlap default names economically (EWT and TSM, EWY and SK Hynix, CPER and the copper producers, the crypto funds and COIN/HOOD). This is disclosed, not netted.
- The paper book prices on IEX while the live book is Schwab, so a paper pass is weaker evidence for a live apply than a same-feed proof would be. ADR-142 records the same caveat.
- The D6 bar is smaller than the standing bar and says so. If the operator does not ratify it, MM-1 stays paper-only indefinitely, which is the correct default.

## Status / open items

Proposed 2026-09-27. Built: D3 only. Next, in order:

1. Operator ratification.
2. Store preset.
3. Deploy, then the Test Lab card.
4. Pre-registration and the Lab backtests.
5. Paper apply.
6. Soak.
7. Result row.
8. The two promotion decisions.
