# Active strategy — as built (2026-07-12)

The production trading configuration as it runs **today**, with the evidence behind every knob.
History and per-change receipts live in [strategy-log.md](./strategy-log.md); how to re-run the
evidence lives in [backtest-regression-suite.md](./backtest-regression-suite.md). If this page and
the running containers ever disagree, the containers win and this page is the bug.

## The strategy in one paragraph

**Core–satellite, regular-hours only.** ~60% of each book is a held **SPY beta core** (captures the
market return the sleeve structurally can't, including the overnight drift that carries ~5/6 of
market return). The satellite is the **gravity rotation sleeve**: every trading day it ranks the
140-name universe by the gravity model's displacement pull and holds the top-12 positive-score
names, conviction-weighted, capped at 3% of equity per name (`active` posture ⇒ the sleeve tops out
near ~36% deployed — the SPY core owns the cash it never touches). Protective exits (5% hard stop,
8% take-profit, 5/3 trailing, short-timeframe breakdown) run every 5 minutes, 9:30–16:00 ET.
Operator holds ride as `:0` core entries (never bought, never sold by the engine); operator
exclusions sit on a blocklist the engine cannot override.

## Every knob, with its evidence

| Env (live + paper, identical) | Value | Why (evidence) |
|---|---|---|
| `TRADING_SLEEVE_ROTATION` | `true` | Sweep #3: rotation alpha is real — gravity/momentum/blend independently +8–10 pts over SPY @126d |
| `TRADING_ROTATION_RANK` | `gravity` | Best row on the 18-config board: beats SPY full-window, Sharpe 2.36 (2.09 on the 140-name universe), maxDD 6.8–10.2% |
| `TRADING_ROTATION_EVERY_DAYS` / `TOPN` / `WEIGHTING` | `1` / `12` / `conviction` | The tested shape; cadence-5 kills the alpha (all of it lives in daily rebalance). At `active`'s 3% cap, conviction≈equal (cap binds) |
| `TRADING_RISK_POSTURE` (`_LIVE` blank) | `active` | Operator downside mandate; live ≡ paper (2026-07-08 rule). Full-deploy `aggressive` rotation was rejected: +70–118% but 20–27% drawdowns |
| `TRADING_CORE_SYMBOLS` | `SPY:60,SKHYV:0,SKHY:0` | Sleeve idles ~64% cash; the core converts it to market beta. `:0` = operator-hold exemption (SK Hynix; drop `SKHYV:0` after the 07-13 ticker conversion) |
| `TRADING_TAKE_PROFIT_PCT` | unset | Rotation was tested on posture defaults; the tp-25 evidence belongs to the scan sleeve only (sweep #1) |
| `TRADING_SYMBOL_BLOCKLIST` | `MRNA` | Operator standing exclusion, enforced at all three autonomous entry paths (scan / rotation targets / pop); exits unaffected |
| `TRADING_EXTENDED_HOURS` | `false` | 2026-07-12 ledger measurement: ext-hours orders filled 10.8% (0% after 17:00) — IEX has zero prints outside 08:00–17:00 ET. Re-enable only with real-time SIP (~$99/mo) |
| `TRADING_POP_CATCHER` | `false` | Sweep #4 REJECT: the entry signal has no discrimination (~40 names/step qualify) |
| Universe | 140 names | 106 + 34 up-and-comers (2026-07-10), with sector caps (`industrial`, `ai-power` buckets) and world-pulse press names |

## Expected shape and risk envelope (single-regime caveat applies)

- Gravity sleeve on the 140-name universe (26-month walk): **+38.6% full-window vs SPY +37.6%,
  +20.9% vs +10.1% at 126 days**, Sharpe 2.09, maxDD 10.2%.
- Combined with the 60% core: roughly **SPY + the sleeve's medium-horizon alpha**, blended maxDD
  estimated 9–13% (assume up to ~15% out-of-sample).
- All evidence is one AI-led bull regime, and the alpha lives in daily rebalancing — slippage-
  sensitive. The daily 5PM recap scores it against SPY every session.
- Overnight gaps are **ridden by design**: overnight carries ~5/6 of market return (+33.2 of SPY's
  +41.4 pts over 25 months); the defenses are the 3%-per-name cap (a −30% gap in one name ≈ −1%
  book) and the 9:30-on protective exits. Venue stops and flat-overnight were both tested and killed.

## A trading day

1. **9:30–9:35** — first fire: SPY core tops up toward target from cash (never sells the sleeve);
   the daily gravity rotation rebalances the sleeve to the current top-12 (sells drop-outs, trims
   over-goal names first, funds buys from settled cash only).
2. **Every 5 minutes until 16:00** — protective exits (stop / take-profit / trailing / breakdown)
   on every sleeve name; blocklist names can never re-enter; core + `:0` holds are never touched.
3. **Off-hours** — the engine places nothing (nothing can be priced on IEX off-hours). The host
   watchdog (10-min cadence, 8:00–20:00 ET) emails on unprotected bleeders, stranded sells, a
   silent autopilot, or a pre-market SPY gap.

## Standing rules

1. **No config change without a [strategy-log](./strategy-log.md) row, and no row without
   fixed-harness numbers** (operator rule, 2026-07-10).
2. **Data feeds:** daily-timeframe work may use IEX (≤0.16% divergence); anything intraday MUST
   use SIP historical (`feed=sip`); live pricing stays IEX until a real-time SIP plan exists.
3. **Arming bar for any new sleeve** (from sweep #4): ≥4 paper weeks including a non-bull week,
   ≥200 trades, ≥0.4%/trade gross, no overnight carries, and net ≥ 0 in the flat week.
4. **Pre-register hypotheses** before testing; hold out a clean period the design never saw;
   the tuned window is always an upper bound.
