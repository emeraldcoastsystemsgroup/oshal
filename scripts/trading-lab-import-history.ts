/**
 * Strategy Library history import (ADR-095) — seeds the lab catalog with every strategy /
 * configuration the operator has tested, curated from docs/apps/trading/strategy-log.md, each
 * carrying its verdict as dated notes + lessons learned. The strategy-log stays the narrative
 * record; this makes the SAME history browsable, chartable and annotatable on ?app=trading →
 * Strategy Lab ("we tested ~30 strategies and configurations but nowhere do I see them").
 *
 * Idempotent: an entry whose name already exists is skipped whole (no duplicate notes). The
 * armed production strategy (seeded by the ADR-092 live proof) is NOT duplicated — its history
 * notes attach to the existing armed rotation-gravity row when one is found.
 *
 * Record-only entries (intraday / execution-layer experiments the daily-bar lab can't walk) are
 * imported for their notes with a clearly-marked baseline config; they are excluded from
 * `--backtest`.
 *
 * Auth: a swarm-cli PAT via OSHAL_CLI_TOKEN (Bearer — the human lane), falling back to
 * OSHAL_SERVICE_SECRET/SWARM_SERVICE_SECRET + OSHAL_USER_SUB/OSHAL_OPERATOR_SUBS (service lane) —
 * the same precedence as scripts/trading-regression-suite.ts.
 *
 * Usage: npx ts-node --transpile-only scripts/trading-lab-import-history.ts
 *          [--base http://localhost:35457] [--backtest]
 *   --backtest   also run a persisted lab backtest for each imported WALKABLE entry (10–30 s each)
 *
 * Prints one machine-readable `RESULT {json}` final line (the harness convention).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — curated catalog (sweeps #1–#5 + deploys + killed builds + open hypotheses) imported via /api/trading/lab with notes/lessons/decisions per entry; armed-strategy note-attach; optional --backtest.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Preserve an explicit acting OIDC subject exactly while validating the trimmed operator-list fallback.
 */
import 'dotenv/config';
import { requireExactUserSubject } from '../src/shared/security/exact-user-subject';

const BASE = argValue('--base') || process.env.OSHAL_BASE_URL || 'http://localhost:35457';
const RUN_BACKTESTS = process.argv.includes('--backtest');

function argValue(flag: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
}

function authHeaders(): Record<string, string> {
  const pat = (process.env.OSHAL_CLI_TOKEN || '').trim();
  if (pat) return { Authorization: `Bearer ${pat}` };
  const secret = (process.env.OSHAL_SERVICE_SECRET || process.env.SWARM_SERVICE_SECRET || '').trim();
  const fallbackSub = (process.env.OSHAL_OPERATOR_SUBS || '').split(',')[0].trim();
  const candidateSub = process.env.OSHAL_USER_SUB || fallbackSub;
  const sub = candidateSub ? requireExactUserSubject(candidateSub) : '';
  if (secret && sub) return { 'X-Service-Secret': secret, 'X-OSHAL-User-Sub': sub };
  throw new Error('no auth: set OSHAL_CLI_TOKEN (swarm-cli login) or SWARM_SERVICE_SECRET + OSHAL_USER_SUB/OSHAL_OPERATOR_SUBS');
}

async function call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(`${method} ${path} HTTP ${r.status}: ${JSON.stringify(j).slice(0, 220)}`);
  return j;
}

/** A note attached at import time. */
interface SeedNote { kind: 'note' | 'lesson' | 'decision'; body: string }

/** One curated catalog entry (config knobs match the lab's normalizeConfig shape). */
interface SeedEntry {
  name: string;
  description: string;
  status: 'candidate' | 'armed' | 'retired';
  /** false = record-only (intraday / execution-layer) — imported for its notes, excluded from --backtest. */
  walkable: boolean;
  config: Record<string, unknown>;
  notes: SeedNote[];
}

const rotation = (rank: string, posture: string, corePct: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'rotation', rank, posture, corePct, coreSymbol: 'SPY', takeProfitPct: null,
  cadenceDays: 1, topN: 12, weighting: 'conviction', universe: [], warmupDays: 80, windowDays: 780, ...extra,
});
const scan = (posture: string, corePct: number, takeProfitPct: number | null): Record<string, unknown> => ({
  kind: 'ensemble', rank: 'gravity', posture, corePct, coreSymbol: 'SPY', takeProfitPct,
  cadenceDays: 1, topN: 12, weighting: 'conviction', universe: [], warmupDays: 80, windowDays: 780,
});

/** The armed production shape — used to find the ADR-092-seeded row so its history attaches there. */
const ARMED_NOTES: SeedNote[] = [
  { kind: 'note', body: 'Sweep #3 (2026-07-10, 18 configs × 5 horizons — the first-ever rotation backtest): judged best row on the board — +38.1% full-window vs SPY +37.6%, maxDD 6.8%, Sharpe 2.36, beats SPY at 21/63/126d. Revalidated on the expanded 140-name universe: +38.6% full-window, +20.9% vs SPY +10.1% at 126d, maxDD 10.2% (the newcomers are more volatile), Sharpe 2.09.' },
  { kind: 'lesson', body: 'Rotation alpha is real and rank-robust: gravity, momentum and blend independently cluster at +8–10 pts over SPY at 126d, and deployment scales it linearly. Ensemble-ranking DILUTES it. The alpha lives in DAILY rebalancing — slippage-sensitive, single-regime caveat (one AI-led bull tape).' },
  { kind: 'lesson', body: 'The July live bleed was REGIME, not a broken strategy — the same config loses the last-5d window in sim too (−1.5% vs SPY +1.35%). Turning rotation off in sweep #1\'s aftermath was premature; sweep #3 reversed it.' },
  { kind: 'decision', body: 'ARMED 2026-07-10 ~18:10 CT as "gravity + core": rotation gravity/1d/top12/active + TRADING_CORE_SYMBOLS=SPY:60,SKHYV:0,SKHY:0 (the :0 names are exemption-only operator holds), take-profit UNSET (the tp25 evidence belongs to the scan sleeve only). Expected combined shape: sleeve alpha on ~36% + SPY beta on 60% ≈ SPY +8–10 pts/126d at blended DD est. 9–13%.' },
  { kind: 'decision', body: '2026-07-12: TRADING_EXTENDED_HOURS=false. IEX is a VENUE operating 08:00–17:00 ET — extended-hours orders filled 10.8% (529 dead paper orders; 0% after 17:00 ET) because there is structurally nothing to price them against. Re-enable only with real-time SIP (Alpaca Algo Trader Plus ~$99/mo). Blast radius on live: none (all 66 live orders were regular-session).' },
  { kind: 'decision', body: '2026-07-13: advisor universe brought current 101 → 140 (operator-approved) and the schedule universe PINS were removed — every leg now tracks DEFAULT_UNIVERSE (a POST /api/trading/autopilot re-arm would re-pin statically; prefer editing DEFAULT_UNIVERSE). Regression-locked in the lab: 452 sessions, +36.41% vs SPY +35.36%, Sharpe 1.47, maxDD 13.9%, feed=sip.' },
];

const CATALOG: SeedEntry[] = [
  {
    name: 'Scan balanced (initial deploy 06-22)',
    description: 'The launch config: multi-timeframe scan sleeve (decideSymbol + money manager) on the balanced posture. Historical record.',
    status: 'retired', walkable: true, config: scan('balanced', 0, null),
    notes: [
      { kind: 'lesson', body: 'All backtest evidence from this era is VOID — the walk-forward harness fed the engine time-reversed weekly/quarterly views (resample() bug, fixed in cad41dc5 on 2026-07-09). Judge every config only on post-fix numbers.' },
    ],
  },
  {
    name: 'Scan active, no core, tp8 (June incumbent)',
    description: 'The operator downside-first mandate config (adopted 06-23): active posture, no SPY core, posture-default 8% take-profit. Ran the book into July.',
    status: 'retired', walkable: true, config: scan('active', 0, 8),
    notes: [
      { kind: 'lesson', body: 'Sweep #1 (2026-07-10, 27 runs, 150d windows): +4.9% vs SPY +9.7%. The 8% take-profit CLIPPED winners in a trending tape — a 577-trade / 37%-win churn profile. Take-profit width was the dominant dial.' },
    ],
  },
  {
    name: 'Scan active, core 35, tp25 (sweep #1 winner)',
    description: 'Sweep #1 winner: active posture + 35% SPY core + take-profit widened to 25%. Armed 07-10 ~16:20 CT; superseded the same evening by the rotation combo.',
    status: 'retired', walkable: true, config: scan('active', 35, 25),
    notes: [
      { kind: 'note', body: 'Sweep #1 evidence: +8.1/8.0/12.3% across three window starts, DD ~4.5%, Sharpe 1.9–4.6. Levers shipped with it: per-symbol core targets (TRADING_CORE_SYMBOLS=SPY:35) and TRADING_TAKE_PROFIT_PCT.' },
      { kind: 'lesson', body: 'tp 8→25 was the only sleeve-level change whose edge persisted across EVERY backtest window (+2.5 pts return at zero drawdown cost, ~120 fewer trades). The tp25 evidence belongs to the SCAN sleeve — the rotation was armed with posture-default exits.' },
    ],
  },
  {
    name: 'Rotation blend 1d top12 (June-30 deploy)',
    description: 'The first rotation deploy: blend rank, daily cadence, top-12, active posture, no core. Enabled 06-30 without a backtest; disabled in sweep #1\'s aftermath.',
    status: 'retired', walkable: true, config: rotation('blend', 'active', 0),
    notes: [
      { kind: 'lesson', body: 'Deployed with NO backtest (the rotation path was not testable until 07-10). Paper equity peaked the exact day it was enabled; July bled while SPY rallied.' },
      { kind: 'lesson', body: 'Root causes found 07-10: (a) the active posture\'s 3% per-name cap × top-12 bounds the rotation book to ~36% deployed — structural cash drag in a rally; (b) July was a genuinely bad regime for fast rotation (the same config loses the last-5d window in sim). Both causes had to be separated before judging the strategy.' },
    ],
  },
  {
    name: 'Rotation blend full-deploy (aggressive)',
    description: 'Sweep #3 grid row: blend rank at the aggressive posture (10% per-name, ~95% deployable), no core — the biggest raw return on the board.',
    status: 'retired', walkable: true, config: rotation('blend', 'aggressive', 0),
    notes: [
      { kind: 'note', body: 'Sweep #3: +117.9% full-window (548d) — the top absolute number of all 18 configs.' },
      { kind: 'lesson', body: 'REJECTED for drawdown discipline: 19.9–27.2% maxDD with −4%+ weeks. The "beat SPY by 30–40%" memory traces to the void July-4 numbers — only these full-deploy aggressive rotations actually deliver that margin on the fixed harness, at 2–3× the drawdown.' },
    ],
  },
  {
    name: 'Rotation momentum full-deploy (aggressive)',
    description: 'Sweep #3 grid row: plain 20-day momentum rank at the aggressive posture, no core.',
    status: 'retired', walkable: true, config: rotation('momentum', 'aggressive', 0),
    notes: [
      { kind: 'lesson', body: 'Sweep #3: +70.0% full-window — same drawdown family as blend full-deploy, rejected on the same DD-discipline grounds. Confirms the alpha is not rank-specific.' },
    ],
  },
  {
    name: 'Rotation ensemble-ranked (sweep #3)',
    description: 'Sweep #3 grid row: rank the universe by the multi-algo ensemble vote score instead of a single signal.',
    status: 'retired', walkable: true, config: rotation('ensemble', 'active', 0),
    notes: [
      { kind: 'lesson', body: 'Ensemble-ranking DILUTES the rotation alpha that single-signal ranks (gravity/momentum) capture — the weighted vote averages the edge away. Use the ensemble for scan decisions, not cross-sectional ranking.' },
    ],
  },
  {
    name: 'Venue-resident stops (execution variant)',
    description: 'RECORD-ONLY (execution-layer experiment — the daily-bar lab cannot express exit venues). Sweep #2: park stop orders at the venue vs the engine\'s close-based exits, on the armed rotation shape.',
    status: 'retired', walkable: false, config: rotation('gravity', 'active', 60),
    notes: [
      { kind: 'lesson', body: 'Sweep #2 (548d OHLC harness, close vs venue execution, 4 configs × 4 window starts): 7-pair average −1.0pp return / −0.02 Sharpe / +0.8pp DD. Venue-resident wins do not survive a realistic gap-fill haircut — first-print exits lock in whipsaw about as often as they save bleed. Verdict WEAK; do NOT rebuild on performance grounds (BACKLOG keeps a tail-insurance-only residual case).' },
    ],
  },
  {
    name: 'Pop-catcher (5-min intraday pull-ins)',
    description: 'RECORD-ONLY (intraday — not walkable on daily bars). The "grab it when it actually pops" layer: pull an unfunded name in from cash when it surges on the 5-minute bar. TRADING_POP_CATCHER remains false.',
    status: 'retired', walkable: false, config: scan('active', 0, null),
    notes: [
      { kind: 'lesson', body: 'Sweep #4 (first intraday test, 7 sessions of 5-min tape, production rule + threshold/exit sweeps): the entry signal has NO discrimination — ~40 names qualify per 5-min step (21.9K signals/week, ~99.9% skipped because the 5 slots are permanently full); thresholds 0.34 and 0.6 produce byte-identical trades. It samples market noise, not surges.' },
      { kind: 'lesson', body: 'Production dials made +$53.64/week on a $100K book with a 2.2-DAY average hold (not fast). The best variant (+$224/wk, ~0.25%/trade) cleared the cost bar on exactly one bullish week — statistically indistinguishable from long-beta noise, plausibly negative in a flat week. The fix is signal REWORK, not dial tuning.' },
      { kind: 'decision', body: 'Arming bar if ever revisited: ≥4 paper weeks including a non-bull week, ≥200 trades, ≥0.4%/trade gross, no overnight carries, skippedFull <20%, net ≥0 in the flat week.' },
      { kind: 'lesson', body: '07-12 postscript: the pop-era SURGE research (miss audit, "19/25 surges had no warning") was measuring OVERNIGHT GAPS on the ~2%-volume IEX tape — an RTH array-index bug + the wrong feed. Those audit conclusions are VOID; the sweep-#4 reject stands on its own evidence. Rule since: daily-timeframe work may stay on IEX; anything intraday MUST use feed=sip.' },
    ],
  },
  {
    name: 'News-materiality keyword scorer (event-pop tier 3)',
    description: 'RECORD-ONLY (intraday news-driven entries — not walkable on daily bars). Deterministic keyword-regex headline materiality scoring feeding 5-min entries. KILLED by pre-registered condition; nothing news-driven trades.',
    status: 'retired', walkable: false, config: scan('active', 0, null),
    notes: [
      { kind: 'lesson', body: 'Sweep #5 (18 trading days blind-forward, 388K real world_items headlines, pub_date-ordered, next-bar entries × real 5-min tape): v1 scorer −$1,481 (4 defects: listicle false-M&A, seeks≠approval, acquirer-side buys, overnight-gap cohort). v2 genuinely improved classification (like-for-like loss halved, WR 32→39%) but the best config made +$96 on 89 trades ($1.08/trade — under the 0.2% slippage bar). CLEAN period (keywords untouched by the tuning stretch): −$228 on 49 trades — the full-window profit was entirely the tuned week. Keyword-regex materiality is DEAD.' },
      { kind: 'lesson', body: 'Durable findings that survived the kill: (1) NEVER hold news trades overnight — RTH-only was better in every one of 7 runs; (2) "big dollar figure in the headline" is a NOISE class — 55% of volume, negative in all 7 runs; (3) aggregator pub_dates structurally lag the original wire — world_items median detection lag is 5.3 HOURS and no reader, however good, can trade a 5-hour-old feed.' },
    ],
  },
  {
    name: 'Flat-overnight (sell close, re-enter open)',
    description: 'RECORD-ONLY (market-structure decomposition, no walkable config). Operator proposal after the ext-hours shutdown: dodge overnight gap risk by going flat at every close.',
    status: 'retired', walkable: false, config: scan('active', 0, null),
    notes: [
      { kind: 'lesson', body: 'KILLED at the market-structure level (~25-month daily-OHLC decomposition): SPY total +41.4% = overnight +33.2% + intraday +6.1% — five-sixths of the market\'s entire return accrues close→open. After the ~0.2%/day round-trip cost of exiting every close, the intraday-only holder compounds to −62.1%. Combined with sweep #2 (dodging gaps costs ≈ what it saves), the overnight-avoidance family is CLOSED: ride the overnight, protect from 9:30, size so a gap can\'t kill the book.' },
    ],
  },
  {
    name: 'Analyst-actions event overlay (hypothesis)',
    description: 'OPEN HYPOTHESIS (record-only until built): analyst upgrades / price-target raises as the recurring pre-move headline class, traded RTH-only off the Benzinga wire\'s real publisher timestamps. Baseline config = the armed shape it would overlay.',
    status: 'candidate', walkable: false, config: rotation('gravity', 'active', 60),
    notes: [
      { kind: 'note', body: 'News-wire RECALL test on the corrected SIP tape (07-12): 7/25 real surges (28%) had an actionable ≤60-min prior headline — MARGINAL vs the pre-registered ≥30% PROCEED bar. But the leading headlines cluster in ONE narrow machine-readable class: analyst actions (RKLB "B of A raises PT" 60 min ahead; KLAC "Cantor raises PT" 5 min ahead). Noise (listicles, reactive "What\'s going on with X?" stories) is clearly separable.' },
      { kind: 'note', body: 'Pre-registered next test: ANALYST ACTIONS as the pre-move class (not M&A/approval — that downgraded to tiny-n hypothesis in sweep #5\'s clean period), Benzinga/Alpaca wire timestamps, RTH-only, judged against the sweep-#4 arming bar. Structurally-material feeds (SEC 8-K stream, DoD daily contracts) + an LLM reader instead of regexes are the surviving path. BACKLOG holds the build spec.' },
    ],
  },
  {
    name: 'Fundamental event overlay + wider indicator base (design)',
    description: 'DESIGN NOTE (2026-07-13, operator + friend discussion — not yet implemented; config mirrors the armed baseline it would overlay). Deterministic fundamental-event scoring → conditional 25-bar edge measurement → bet-size modulation on top of the technical base.',
    status: 'candidate', walkable: false, config: rotation('gravity', 'active', 60),
    notes: [
      { kind: 'note', body: 'The concept: (1) score scheduled fundamental releases (earnings/CPI/FOMC; later USDA crop reports) bullish/bearish vs CONSENSUS with deterministic rules — no LLM judgment; (2) event-study the next 25 bars conditional on the class, permutation-tested against shuffled event dates; (3) if (and only if) the edge survives, emit a sizing overlay — increase exposure in that market during the proven post-event window. The technical strategy keeps making entries; fundamentals modulate SIZE. Same overlay architecture as the gate-overlay and news-materiality harnesses.' },
      { kind: 'note', body: 'Prerequisite: widen the standard-indicator base (MACD, Bollinger, ATR-channel, ADX gate, stochastic, volume z-score — the algo context needs OHLCV, closes-only today) in SHADOW mode, scored nightly by the existing per-algo accuracy loop (trading-assess → overnight review → signal-weight masses) so each new signal EARNS its weight before touching live votes.' },
      { kind: 'lesson', body: 'Instrument honesty: the motivating example is ag futures (USDA WASDE → corn), which the equity rail can only proxy (CORN/WEAT/SOYB ETFs) and where consensus-vs-actual is the scarce input (actual-vs-prior bakes in lookahead). Prove the machinery on a dense event stream in the current universe first (~120 WASDE events/decade is too thin to validate a framework).' },
    ],
  },
];

interface StrategyListRow { id: string; name: string; status: string; config: { kind?: string; rank?: string }; latestBacktest?: unknown }

async function main(): Promise<void> {
  const list = (await call('GET', '/api/trading/lab/strategies')).strategies as StrategyListRow[];
  const byName = new Map(list.map((s) => [s.name, s]));
  let created = 0, skipped = 0, notesAdded = 0, backtests = 0;
  const walkableIds: string[] = [];

  // 1) Attach the armed-production history to the ADR-092-seeded armed rotation-gravity row (no duplicate).
  const armed = list.find((s) => s.status === 'armed' && s.config?.kind === 'rotation' && s.config?.rank === 'gravity');
  if (armed) {
    const existing = (await call('GET', `/api/trading/lab/strategies/${armed.id}/notes`)).notes as Array<{ kind: string }>;
    if (existing.some((n) => n.kind === 'decision')) {
      console.log(`= armed "${armed.name}" already carries decision notes — leaving as-is`);
    } else {
      for (const n of ARMED_NOTES) { await call('POST', `/api/trading/lab/strategies/${armed.id}/notes`, n); notesAdded++; }
      console.log(`+ attached ${ARMED_NOTES.length} history notes to armed "${armed.name}"`);
    }
  } else {
    console.log('! no armed rotation-gravity strategy found — creating the armed-shape row from the log');
    CATALOG.push({
      name: 'Rotation gravity 1d top12 + SPY:60 core (armed 07-10)',
      description: 'The armed production combo of record: gravity rotation daily/top-12/conviction on the active posture with a 60% SPY core, take-profit unset, default universe.',
      status: 'armed', walkable: true, config: rotation('gravity', 'active', 60), notes: ARMED_NOTES,
    });
  }

  // 2) Import the catalog (skip whole entries whose name already exists — idempotent re-runs).
  //    A skipped WALKABLE entry that still has no backtest is queued for --backtest anyway, so a
  //    two-pass "import fast, then --backtest" flow completes instead of no-opping.
  for (const entry of CATALOG) {
    const existing = byName.get(entry.name);
    if (existing) {
      skipped++;
      if (entry.walkable && !existing.latestBacktest) walkableIds.push(existing.id);
      console.log(`= exists, skipped: ${entry.name}`);
      continue;
    }
    const created0 = await call('POST', '/api/trading/lab/strategies', {
      name: entry.name, description: entry.description, config: entry.config,
    });
    const id = String((created0.strategy as { id: string }).id);
    if (entry.status !== 'candidate') await call('PATCH', `/api/trading/lab/strategies/${id}`, { status: entry.status });
    for (const n of entry.notes) { await call('POST', `/api/trading/lab/strategies/${id}/notes`, n); notesAdded++; }
    if (entry.walkable) walkableIds.push(id);
    created++;
    console.log(`+ imported: ${entry.name} [${entry.status}] (${entry.notes.length} notes)`);
  }

  // 3) Optional: give each walkable import a persisted backtest so the catalog charts immediately.
  if (RUN_BACKTESTS) {
    for (const id of walkableIds) {
      try {
        const run = (await call('POST', `/api/trading/lab/strategies/${id}/backtest`, {})).run as { status: string; metrics?: { totalReturnPct?: number } };
        backtests++;
        console.log(`  ▸ backtest ${id}: ${run.status}${run.metrics?.totalReturnPct != null ? ` ${run.metrics.totalReturnPct}%` : ''}`);
      } catch (e) {
        console.log(`  ! backtest ${id} failed: ${(e as Error).message}`);
      }
    }
  } else if (walkableIds.length) {
    console.log(`\n${walkableIds.length} walkable import(s) have no runs yet — re-run with --backtest, or use the Backtest button per row in the lab.`);
  }

  console.log(`RESULT ${JSON.stringify({ created, skipped, notesAdded, backtests })}`);
}

main().catch((e) => {
  console.error((e as Error).message);
  console.log(`RESULT ${JSON.stringify({ error: (e as Error).message })}`);
  process.exitCode = 2;
});
