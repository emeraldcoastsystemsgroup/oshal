# Intraday day-trade research engine (`scripts/oshal-intraday.js`)

> Living doc — this is the bench we tinker on. Update the **Findings** and **Knobs** sections as we
> learn. The daily/EOD sibling is [scripts/oshal-backtest.js](../../../scripts/oshal-backtest.js); the live
> paper bot is [docs/apps/trading/advisor.md](advisor.md). ADRs: [052](../../adr/052-stock-trading-swarm.md),
> [053](../../adr/053-trading-decision-workflow.md), [054](../../adr/054-gravity-model.md).

## What it is
A research harness for **day trading** — trades intraday **minute** bars and is **flat by close**.
Two questions it answers:

1. **Single-instrument** (`compare`/`report`): does a given intraday strategy (ORB, VWAP-reversion,
   Donchian, EMA cross) beat its costs on ES or CL?
2. **Rotation** (`rotate`): the high-upside idea — **concentrate capital into whatever's running
   hardest right now**, pull it from names doing merely OK, rebalance through the day, flat by close.
   Relative strength, intraday. This is the day-trade twin of the live bot's `rotationBenches`.

Because every trade opens and closes inside one session, **no back-adjustment is needed** — a position
never spans a contract roll. So we just stitch the **front (highest-volume) contract per day** into a
continuous minute series. (The daily engine, which holds across rolls, must back-adjust; this one must not.)

## Data
Kibot per-contract minute files, unzipped to `data/_extracted/<SYM>-MINUTE/` (`data/` is gitignored):

| Sym | Source zip | Files | Format |
|---|---|---|---|
| ES (S&P 500 e-mini, $50/pt) | `ESMinute.zip` | 62 | `MM/DD/YYYY,HH:MM,O,H,L,C,V` (comma) |
| CL (WTI crude, $1000/pt) | `CL-MINUTE.zip` | 242 | `YYYYMMDD HHMMSS;O;H;L;C;V` (semicolon) |

`build` parses either format and writes a cached continuous series to
`data/_extracted/<sym>-minute-cont.csv` (`day,hm,o,h,l,c,v`; `hm` = minutes-of-day on the exchange/ET
clock). ES ≈ 5.5M bars / 5,127 days (2009→2025); CL ≈ 5.8M bars / 5,719 days (2007→2025).

**Adding equities** (the real rotation test — see Findings): pull a basket with
[scripts/oshal-equity-bars.js](../../../scripts/oshal-equity-bars.js), which writes each ticker's
`<sym>-minute-cont.csv` straight from the Alpaca IEX feed (UTC→ET DST-correct via Intl):
```bash
node scripts/oshal-equity-bars.js NVDA,AMD,TSLA,AVGO,SMCI,PLTR,COIN,MARA,MU,META,AMZN,NFLX,CRM,SHOP,UBER 2
```
Unknown tickers default to point-value 1 + equity RTH (09:30–16:00 ET) in the engine — no map edits
needed. Rotation is **return-based**, so it mixes futures and equities freely. Alpaca free IEX gives
**full multi-year** 1-min history (~390 RTH bars/day back to 2021+); for SIP-quality fills or pre/post
bars use a paid feed.

## Architecture (why it scales)
- **Memory-light build** — two passes: (1) pick the winning contract per day by volume; (2) stream each
  winner's bars out in contract-chronological order. Never holds the multi-million-bar array in RAM.
- **Day-streaming backtest** — buffers **one session at a time**; each strategy resets per day and is
  forced flat at the session close. So memory is O(one day), not O(history).
- **k-way day-merge** (`DayReader`) for rotation — advances each symbol's CSV in lockstep to the common
  (intersection) trading days, session-filtered, so symbols are aligned before ranking.
- **Two accounting models:**
  - single-instrument = **contracts** (points × point-value − slippage − commission), like the daily engine.
  - rotation = **capital fractions / returns** on a $100k notional, so it rotates coherently across any
    mix of instruments and generalizes straight to a stock basket.

## Run it
```bash
node scripts/oshal-intraday.js build   <ES|CL>                       # build/cache the continuous series
node scripts/oshal-intraday.js compare <ES|CL> [years]              # single-instrument strategies, console + HTML
node scripts/oshal-intraday.js report  <ES|CL> [years]              # HTML only
node scripts/oshal-intraday.js rotate  <SYM1,SYM2,...> [years] [lookbackMin] [rebalMin] [switchMargin]
```
Reports land in `data/_extracted/`: `<sym>-intraday-report.html`, `rotate-<syms>-report.html`
(self-contained, Chart.js: summary table, equity curves, underwater drawdown, monthly P&L).

## Knobs (the tinkering surface)
| Knob | Where | Default | Effect |
|---|---|---|---|
| `SESSION[sym]` | top of file | ES 09:30–16:00, CL 09:00–14:30 | the tradable window (minutes-of-day) |
| `SLIPPAGE_PTS`/`COMMISSION_RT` | top of file | ES 0.25 / CL 0.02 pt; $4 RT | per-fill cost realism |
| strategy params | `STRATS` / `RUNS` | ORB 15/30, VWAP k=2σ, Donchian 30, EMA 9/30 | each strategy's shape |
| `lookbackMin` | `rotate` arg | 30 | momentum measurement window |
| `rebalMin` | `rotate` arg | 5 | how often to re-rank/rotate (mirrors live autopilot cadence) |
| `topK` | rotate variants | 1 / 2 / all | concentration: K=1 = all-in the single strongest = max upside |
| `switchMargin` | `rotate` arg | 0.0015 | **anti-whipsaw**: momentum edge a challenger needs to steal a slot |
| `costBps` | rotate | 1.0 | per-turn switch cost in bps |

## Findings (update as we learn)
**2026-06-24 — baseline, honest:**
- **Single-instrument vanilla strategies all LOSE after costs** on both ES (~13.5y) and CL (~19y).
  buy-hold-intraday ≈ −1 round-turn/day (validates the cost model). EMA-cross overtrades (56–60k trades)
  → catastrophic. VWAP-reversion has a 63% win rate but **negative skew** (small wins, fat-tail losses)
  → still loses. Markets are intraday-efficient; raw signals don't clear costs.
- **Rotation on ES+CL whipsaws and loses.** 5-min / 30-min momentum rotation flipped ~every rebalance
  (60k–86k switches) and bled to costs; **equal-weight (hold both, no rotation) ≈ breakeven was best.**
  Hysteresis (`switchMargin`) cut churn and loss (concentrate-K1: 60k→45k switches, −$648k→−$479k) but
  **can't create an edge that isn't there**: two macro-divergent futures have no exploitable
  cross-sectional momentum. **Rotation earns from DISPERSION across a basket** — it needs many names
  (equities), not two futures. This is the engine validating; the next test needs equity minute data.

**2026-06-24 — equity basket rotation: the thesis holds, but only SLOW.** 15 high-momentum names
(NVDA/AMD/TSLA/AVGO/SMCI/PLTR/COIN/MARA/MU/META/AMZN/NFLX/CRM/SHOP/UBER), 500 sessions (2024-06→2026-06).
- **Fast chasing loses** (L=30m, rebal=5m): concentrate −$307k, whipsaw (24k switches) — buying the
  5-min pop mean-reverts. equal-weight ≈ breakeven still beats it.
- **Slow concentration WINS** (first thing to clear costs in the whole study):
  - L=120m, rebal=30m → **concentrate-K1 +$11.5k, PF 1.07, Sharpe 0.15** (vs equal-weight ≈ $0)
  - L=240m, rebal=60m → **rotate-top2 +$7.2k, PF 1.09, Sharpe 0.20, maxDD −$17.6k** (best risk-adj;
    equal-weight LOSES −$13.6k here)
- **Read:** the operator's "send money to the hot name" works, with a qualifier — hold the leader an hour-plus,
  don't chase minute pops (the real effect is morning-leaders-persist, not fast reversal). Modest Sharpe.
- **Honest caveats:** 2 years / one bull-ish regime; 15 hand-picked trenders (SELECTION BIAS — inflates
  it); params from a small manual sweep (overfit risk). Next: walk-forward + a neutral/larger universe +
  regime filter before trusting the number.

**2026-06-24 — walk-forward + neutral universe: the edge does NOT survive (negative result).**
Added `wf` mode (grid of L×rebal×K×margin chosen on the expanding past by in-sample Sharpe, scored on the
held-out next slice) + an OOS equal-weight benchmark per fold.
- **Momentum basket (15 cherry-picked), 5 folds:** OOS total **+$13.0k vs EW −$6.4k**; selector picked the
  SAME config (L120/R30/K2) every fold → looked robust.
- **Neutral universe (40 large-caps across sectors, no momentum screen), 5 folds:** OOS total
  **−$53.0k vs EW −$7.8k** — rotation is FAR WORSE than just diversifying, and **in-sample Sharpe was
  negative in every fold** (no positive config even existed to pick).
- **Verdict:** the momentum-basket win was **selection bias**. On a fair universe, naive cross-sectional
  intraday momentum rotation has **no edge** and underperforms equal-weight after costs. Chasing recent
  intraday winners on unscreened names loses. **Do not deploy naive intraday rotation.** The WF+neutral
  test is now the gate every future rotation idea must pass.
- **Where to look next (not naive cross-sectional momentum):** (a) a two-stage design — screen a daily
  momentum/strength universe first, THEN rotate intraday only within it (and WF-test that, screen included,
  to avoid re-importing bias); (b) regime-gated entries (only concentrate when breadth/trend supports it);
  (c) event/gravity-driven moves (ADR-054), not price-only ranking. The live autopilot's DAILY/multi-day
  rotation is a different (slower) effect and is not refuted by this intraday result.

**2026-06-24 — two-stage (daily-screen → intraday-rotate) ALSO fails the neutral WF test.**
Added `wf2`: each day rank the universe by a causal trailing-N-day daily return, keep the top-M, rotate
intraday only within them. The screen is INSIDE the walk-forward grid (screenL × topM × intraday params),
so OOS includes it — no bias smuggled in.
- **Neutral 40-name universe, 5 folds:** OOS total **−$64.3k vs equal-weight −$5.7k**, in-sample Sharpe
  mostly negative, and the picked config jumped around every fold (S5/M5 → S5/M8 → S3/M12 → S10/M5 → …)
  = no stable optimum = no signal. The daily pre-screen does NOT rescue intraday rotation.

**2026-06-24 — trend-aligned dip-buy (`trend` mode): better-behaved, still not profitable; reveals WHY.**
The sound iteration: only long on a daily-uptrend day (causal SMA gate), buy a real pullback (dipMult·ATR
off the session high), exit at targetMult·ATR or a stop, flat by close, few trades, costs on; walk-forward
over MA × dip × target, vs a "long all day on the same up days" benchmark.
- **ES:** OOS −$38k vs bench −$25k — dip-timing is *worse* than naive; in-sample Sharpe ≈ 0. No signal.
- **CL:** OOS **−$4.6k (≈ breakeven)** vs bench **−$93k** — the dip-timing AVOIDED ~$88k of loss and the
  config was stable (MA20/dip1.5/tgt1 most folds) = faint real structure. But still not net-positive after costs.
- **The unifying insight:** on crude, being long all day even on up-trend days LOSES −$93k, yet the daily
  engine's CL Donchian made **+$212k holding overnight/multi-day**. **Crude's trend alpha lives in the
  overnight / multi-day hold — and day-trading (flat by close) discards exactly that.** Intraday fights with
  one hand tied. This is why every intraday variant fails while the daily/hold approach wins.

## Conclusion (2026-06-24): intraday cross-sectional momentum is a validated dead end
Across every form tested — single-name vanilla, naive rotation, hysteresis, slow (L120–240/rebal30–60),
and daily-screened two-stage — **intraday cross-sectional momentum rotation has no out-of-sample edge on a
neutral universe and loses far more than just holding a diversified basket.** The only positive number
(+$13k) came from a cherry-picked basket and evaporated under an unbiased test. Even equal-weight
intraday is slightly negative (≈ the cost of flattening daily) — i.e. **the alpha is not at the intraday
horizon.** Do not deploy intraday concentration in the live bot; keep its rotation slow (multi-day).

**Where edge HAS shown up (pursue these, not intraday rotation):**
- **Daily trend/breakout on commodities, HELD overnight/multi-day** — the daily engine's CL Donchian was
  strongly positive OOS (+$212k across 5 WF folds). The trend-dip test proved the corollary: forcing
  flat-by-close throws this edge away (CL long-up-days intraday = −$93k). The alpha is in the HOLD — do
  not force intraday exits on a trend strategy.
- **The Gravity model** (ADR-054) and **event/news-driven** moves — signal, not price-only ranking.
- The live autopilot's existing **multi-day** relative-strength rotation (slower; not refuted here).

## Roadmap / tinkering backlog
- [ ] **Regime-aligned intraday** — only take intraday breakouts in the direction of the higher-timeframe
      (daily) trend; port the live bot's multi-timeframe gate down to minute bars. Most likely first edge.
- [ ] **Equity basket rotation** — the real test of "send money to the hot stock": pull a basket of
      liquid names' minute bars, run `rotate` across 20–100 symbols where dispersion is real. Needs an
      equity minute feed (Alpaca IEX = short window; SIP/Kibot = multi-year).
- [ ] **Time-of-day filters** — trade only the open/close where intraday moves are real; skip lunch chop.
- [ ] **Volatility targeting** — size each name by inverse vol so one wild name doesn't dominate the book.
- [ ] **Gravity/event entries** — feed news/event masses (ADR-054) as an intraday continuation signal.
- [ ] **Walk-forward** — choose params on the expanding past, score the held-out next slice (anti-overfit),
      like the daily engine's `wf` mode.
- [ ] **Wire the validated rotation knobs into the live autopilot** — `lookback`/`rebal`/`topK`/`margin`
      tuned here feed `rotationBenches` / a new concentrate-into-momentum posture in
      [trading-schedule-dispatch.ts](../../../src/app/trading-schedule-dispatch.ts).
