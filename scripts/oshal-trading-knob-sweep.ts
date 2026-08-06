/**
 * Strategy Lab knob sweep (ADR-092/095) — generates the "what if we nudged one dial" grid as real
 * library strategies, seeds each with a baselined backtest, and prints a leaderboard.
 *
 * WHY THIS SHAPE: the library only had hand-authored strategies, so a shelved config went dark the
 * moment it was retired and dial interactions (does topN=16 only help at corePct=0?) were never
 * measured. Everything the grid needs already exists — the sim walks any config for ~2s of SIP bars
 * and ZERO token spend, and `runForwardAll` walks every NON-retired strategy nightly. So a swept row
 * saved as `candidate` is automatically forward-walked + regression-checked from the next 21:45 UTC
 * leg onward, with no new schema, no new scheduler leg, and no new UI.
 *
 * THE GRID (36 = rank 4 x topN 3 x corePct 3): every other dial is PINNED to the armed production
 * config, so each row differs from `Armed production (gravity rotation + SPY:60)` in at most three
 * knobs, and `sweep4/gravity-t12-c60` carries a config IDENTICAL to armed (verified 2026-07-17) —
 * that row is the CONTROL for the grid's plumbing: if its config ever stops matching armed's, the
 * sweep built the wrong thing. NOTE its headline metrics do NOT equal armed's baseline numbers,
 * because armed's baseline pins its own window (2024-09-19..2026-07-10) while a sweep row walks
 * windowDays back from today — same config, different window, legitimately different totals. Only a
 * same-window rerun compares directly; that is what the nightly regression half already does.
 *
 * Auth mirrors trading-regression-suite.ts: a swarm-cli PAT via OSHAL_CLI_TOKEN (the human lane),
 * falling back to SWARM_SERVICE_SECRET + OSHAL_USER_SUB/OSHAL_OPERATOR_SUBS (the internal lane).
 *
 * Usage: npx ts-node --transpile-only scripts/oshal-trading-knob-sweep.ts [flags]
 *   --grid <name>   which grid: sweep4 (default) | ira — see the grid builders for what each varies
 *   --dry-run       print the grid and exit; create nothing
 *   --leaderboard   skip generation; just print the board for existing rows of the chosen grid
 *   --rebacktest    re-run the backtest on rows that ALREADY exist, refreshing their metrics
 *   --all           leaderboard covers EVERY strategy, not only the chosen grid's rows
 *   --sort <key>    total | avgDaily | bestDay | sharpe | alpha   (default: total)
 *   --base <url>    api base (default http://localhost:35457)
 *
 * THE IRA GRID (12 = posture 2 x cadenceDays 2 x corePct 3, rank/topN pinned to gravity/12):
 * a MEASUREMENT sleeve for slow-cadence retirement-account management (operator context
 * 2026-07-17: a ~500K 401k -> rollover-IRA move; IRA cash accounts settle T+1 with no margin, so
 * high-churn daily rotation invites good-faith violations — a 5-10 session cadence sidesteps
 * settlement entirely and is the posture retirement money wants anyway). These rows measure what
 * slow cadence + conservative caps + heavy core ballast cost/earn vs the daily grid. They are
 * candidates for OBSERVATION — nothing here arms a strategy or touches a real account.
 *
 * METRICS FRESHNESS: the backtest runs INSIDE the api container, so a row's metrics only carry the
 * fields the DEPLOYED build computes. Rows seeded before the avgDailyPct/bestDayPct build show 0.00
 * in those columns; re-run with --rebacktest after the next deploy to refresh them (the board reads
 * each strategy's LATEST backtest, so a refresh is all it takes — no re-baselining, and the drift
 * check only compares totalReturnPct/maxDrawdownPct/trades so this can't false-drift).
 *
 * Runs SEQUENTIALLY on purpose: 36 backtests x ~5 paged bar requests is ~180 Alpaca calls, and the
 * free data tier allows 200/min — parallelising would trip the limiter for ~90s of saved wall time.
 * Idempotent: a name that already exists is skipped (409), so re-running only fills gaps.
 *
 * Prints one machine-readable `RESULT {json}` final line. Exit codes: 0 = ok · 1 = some rows
 * failed · 2 = could not run.
 *
 * UNDO (the whole sweep, one statement):
 *   UPDATE trading_strategies SET status='retired' WHERE user_sub=$1 AND name LIKE 'sweep4/%';
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — 36-row rank/topN/corePct grid over the armed base, idempotent create + baselined backtest seed, leaderboard on the new avgDaily/bestDay metrics.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | --grid flag + the 12-row IRA measurement grid (posture x cadenceDays 5/10 x corePct 40/60/80, gravity/12 pinned) for the 401k->rollover-IRA slow-cadence question; --rebacktest for refreshing metrics after a deploy; leaderboard follows the chosen grid's prefix.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | --grid egate (8 rows): earnings-gate A/B twins — existing bases duplicated with ONLY earningsGateDays set (dial sweep 1/3/5 on the armed control; g3 twins on the leaders + slow-cadence IRA shapes). Guarded by assertApiKnowsEarningsGate: seeding against a pre-knob api would create gate-off duplicates masquerading as twins.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Preserve an explicit acting OIDC subject exactly while validating the trimmed operator-list fallback.
 */
import 'dotenv/config';
import { requireExactUserSubject } from '../src/shared/security/exact-user-subject';

/** The dial values the grid walks. Every other knob is pinned to ARMED_BASE below. */
const RANKS = ['gravity', 'momentum', 'ensemble', 'blend'] as const;
const TOP_NS = [8, 12, 16] as const;
const CORE_PCTS = [0, 30, 60] as const;

/**
 * The armed production config, verbatim, as the pinned base (read from the library 2026-07-17:
 * "Armed production (gravity rotation + SPY:60)"). rank/topN/corePct are overwritten per grid row.
 */
const ARMED_BASE = {
  kind: 'rotation',
  posture: 'active',
  weighting: 'conviction',
  coreSymbol: 'SPY',
  universe: [] as string[],
  warmupDays: 80,
  windowDays: 780,
  cadenceDays: 1,
  takeProfitPct: null as number | null,
};

const BASE = argValue('--base') || process.env.OSHAL_BASE_URL || 'http://localhost:35457';
const GRID_NAME = (argValue('--grid') || 'sweep4').toLowerCase();
const DRY_RUN = process.argv.includes('--dry-run');
const BOARD_ONLY = process.argv.includes('--leaderboard');
const REBACKTEST = process.argv.includes('--rebacktest');
const BOARD_ALL = process.argv.includes('--all');
const SORT_KEY = (argValue('--sort') || 'total').toLowerCase();

function argValue(flag: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
}

/** @description Auth headers — PAT first (human lane), service secret + sub second (bot lane).
 *  @returns Headers for the lab API.
 *  @throws When neither lane is configured. */
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

/** @description One API call returning parsed JSON plus the status (409 is expected, not fatal).
 *  @param method - HTTP verb.
 *  @param path - API path under the base.
 *  @param body - Optional JSON body.
 *  @returns Status + parsed payload. */
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, json };
}

/** A single grid row: its deterministic name and the config it stands for. */
interface GridRow { name: string; description: string; config: Record<string, unknown> }

/** @description Expands the rank x topN x corePct grid over the pinned armed base.
 *  @returns 36 deterministic, idempotently-named rows. */
function buildSweep4Grid(): GridRow[] {
  const rows: GridRow[] = [];
  for (const rank of RANKS) {
    for (const topN of TOP_NS) {
      for (const corePct of CORE_PCTS) {
        const isControl = rank === 'gravity' && topN === 12 && corePct === 60;
        rows.push({
          name: `sweep4/${rank}-t${topN}-c${corePct}`,
          description: [
            `Sweep #4 grid row (auto-generated ${new Date().toISOString().slice(0, 10)}): rank=${rank}, topN=${topN}, corePct=${corePct}.`,
            'Every other dial is pinned to the armed production config (rotation / active / conviction / SPY core / cadence 1 / tp UNSET).',
            isControl ? 'CONTROL ROW — config identical to "Armed production (gravity rotation + SPY:60)"; it validates the grid plumbing. Its totals differ from armed\'s baseline only because that baseline pins a different window.' : '',
            'Retire the whole sweep with: UPDATE trading_strategies SET status=\'retired\' WHERE name LIKE \'sweep4/%\';',
          ].filter(Boolean).join(' '),
          config: { ...ARMED_BASE, rank, topN, corePct },
        });
      }
    }
  }
  return rows;
}

/** The IRA grid's dials — everything else pinned to the armed base with rank=gravity, topN=12. */
const IRA_POSTURES = ['conservative', 'balanced'] as const;
const IRA_CADENCES = [5, 10] as const;
const IRA_CORE_PCTS = [40, 60, 80] as const;

/** @description Expands the slow-cadence retirement measurement grid (see header).
 *  @returns 12 deterministic, idempotently-named rows. */
function buildIraGrid(): GridRow[] {
  const rows: GridRow[] = [];
  for (const posture of IRA_POSTURES) {
    for (const cadenceDays of IRA_CADENCES) {
      for (const corePct of IRA_CORE_PCTS) {
        rows.push({
          name: `ira/${posture}-cad${cadenceDays}-c${corePct}`,
          description: [
            `IRA measurement row (auto-generated ${new Date().toISOString().slice(0, 10)}): posture=${posture}, cadenceDays=${cadenceDays}, corePct=${corePct}; rank/topN pinned to gravity/12.`,
            'Slow-cadence retirement-sleeve candidate: an IRA cash account settles T+1 with no margin, so a 5-10 session cadence sidesteps good-faith-violation mechanics that daily rotation would hit.',
            'OBSERVATION ONLY — measures what slow cadence + conservative caps + heavy ballast cost/earn vs the daily grid; arming anything for a real retirement account is an operator decision.',
            'Retire the whole grid with: UPDATE trading_strategies SET status=\'retired\' WHERE name LIKE \'ira/%\';',
          ].join(' '),
          config: { ...ARMED_BASE, rank: 'gravity', topN: 12, posture, cadenceDays, corePct },
        });
      }
    }
  }
  return rows;
}

/**
 * The thesis grid's universes (operator hypothesis 2026-07-17, asked as "do we have a strategy to
 * win in a down market... small/mid-cap medical and AI products that are selling, not the LLM
 * companies; chips maybe, storage definitely, medical innovation"). The DEFAULT_UNIVERSE is 140
 * liquid LARGE-caps — its only medical exposure is mega-cap pharma + sector ETFs and its only
 * storage name is MU — so the hypothesis was previously UNMEASURABLE. Each list holds only names
 * listed 2+ years (the sim needs deep daily history; recent IPOs like ALAB/SNDK excluded for now).
 */
const THESIS_UNIVERSES: Record<string, { tickers: string[]; what: string; topN?: number }> = {
  defensive: {
    // The "win in a down market" candidate: rotation holds top-N POSITIVE scores, so given
    // gold/bonds/staples/utilities to rank it can rotate INTO shelter while equities fall —
    // the only long-only shape that can be net-up in a drawdown (shorting measured dead, ADR-088).
    tickers: ['GLD', 'GDX', 'TLT', 'IEF', 'SHY', 'BND', 'XLU', 'XLP', 'XLV', 'USMV', 'SPLV', 'VYM'],
    what: 'defensive rotation: gold/bonds/staples/utilities/min-vol — shelter the rotation can hold when equities have no positive scores',
  },
  shelter: {
    // The "hide and get PAID" row (operator 2026-07-17: downturn read, "maybe we drop it in a
    // high-yield note"). Cash-like T-bill ETFs (SGOV/BIL/SHV/USFR ≈ the bill yield, near-zero
    // equity beta) as the floor the rotation defaults into, plus gold and duration as the two
    // assets that historically RISE in risk-off. Deliberately NO junk credit (HYG/JNK) — "high
    // yield" bonds fall WITH equities in a drawdown; that is a correlation trap, not a hedge.
    tickers: ['SGOV', 'BIL', 'SHV', 'USFR', 'SHY', 'IEF', 'TLT', 'GLD'],
    what: 'shelter: T-bill floor (paid to wait) + gold + Treasury duration — the hide-out that still yields; junk credit excluded on purpose',
    topN: 4,
  },
  medtech: {
    tickers: ['TMDX', 'IRTC', 'PODD', 'DXCM', 'TNDM', 'INSP', 'PEN', 'GKOS', 'NVCR', 'EXAS', 'NTRA', 'GH', 'CRSP', 'NTLA', 'BEAM', 'MASI'],
    what: 'small/mid-cap medical innovation: devices, diagnostics, gene editing - products that SELL, not pharma mega-caps',
  },
  aiinfra: {
    tickers: ['STX', 'WDC', 'NTAP', 'PSTG', 'MU', 'MRVL', 'CIEN', 'COHR', 'LITE', 'VRT', 'MOD', 'FN', 'SMCI', 'ANET'],
    what: 'AI infrastructure picks-and-shovels: storage (STX/WDC/NTAP/PSTG), memory, optics, power/cooling - NOT the LLM companies',
  },
};

/** @description Expands the operator-thesis universes x cadence {1,10}. corePct 0 on purpose: the
 *  row measures the THESIS, undiluted by SPY ballast. topN 8 because the universes are 12-16 names.
 *  @returns 6 deterministic, idempotently-named rows. */
function buildThesisGrid(): GridRow[] {
  const rows: GridRow[] = [];
  for (const [key, u] of Object.entries(THESIS_UNIVERSES)) {
    for (const cadenceDays of [1, 10]) {
      const topN = u.topN ?? 8;
      rows.push({
        name: `thesis/${key}-cad${cadenceDays}`,
        description: [
          `Thesis row (auto-generated ${new Date().toISOString().slice(0, 10)}): ${u.what}.`,
          `Universe [${u.tickers.join(',')}], cadence ${cadenceDays}d, gravity/top${topN}/balanced/corePct 0 (undiluted read).`,
          'OBSERVATION ONLY - measures the operator hypothesis vs the large-cap default; nothing armed.',
          'Retire the whole grid with: UPDATE trading_strategies SET status=\'retired\' WHERE name LIKE \'thesis/%\';',
        ].join(' '),
        config: { ...ARMED_BASE, rank: 'gravity', topN, posture: 'balanced', cadenceDays, corePct: 0, universe: u.tickers },
      });
    }
  }
  return rows;
}

/**
 * The earnings-gate A/B grid: TWIN rows of existing bases differing ONLY in earningsGateDays, plus
 * a dial sweep (1/3/5 sessions) on the armed-shape control. Twin-vs-base forward divergence IS the
 * gate's measured value; the dial rows tune the width. Backtest halves are near-identical to their
 * bases by construction (calendar exists only from 2026-06-25) — the forward walk is the real A/B.
 */
const EGATE_BASES: Array<{ key: string; config: Record<string, unknown>; days: number[] }> = [
  // Armed-shape control: sweep the dial.
  { key: 'gravity-t12-c60', config: { ...ARMED_BASE, rank: 'gravity', topN: 12, corePct: 60 }, days: [1, 3, 5] },
  // Long-run leaders + one laggard family representative: gate on/off twins at the study's width.
  { key: 'gravity-t16-c0', config: { ...ARMED_BASE, rank: 'gravity', topN: 16, corePct: 0 }, days: [3] },
  { key: 'momentum-t16-c0', config: { ...ARMED_BASE, rank: 'momentum', topN: 16, corePct: 0 }, days: [3] },
  { key: 'ensemble-t12-c60', config: { ...ARMED_BASE, rank: 'ensemble', topN: 12, corePct: 60 }, days: [3] },
  // Retirement-cadence twins (the gate matters MOST at slow cadence: a 10-session hold spans prints).
  { key: 'ira-balanced-cad10-c60', config: { ...ARMED_BASE, rank: 'gravity', topN: 12, posture: 'balanced', cadenceDays: 10, corePct: 60 }, days: [3] },
  { key: 'ira-conservative-cad10-c40', config: { ...ARMED_BASE, rank: 'gravity', topN: 12, posture: 'conservative', cadenceDays: 10, corePct: 40 }, days: [3] },
];

/** @description Expands the earnings-gate twin grid (see EGATE_BASES).
 *  @returns 8 deterministic, idempotently-named rows. */
function buildEgateGrid(): GridRow[] {
  const rows: GridRow[] = [];
  for (const b of EGATE_BASES) {
    for (const days of b.days) {
      rows.push({
        name: `egate/${b.key}-g${days}`,
        description: [
          `Earnings-gate A/B row (auto-generated ${new Date().toISOString().slice(0, 10)}): earningsGateDays=${days} over the ${b.key} base — differs from its gate-off twin ONLY in the gate.`,
          'The twin-vs-base forward divergence IS the gate\'s measured value (backtests before 2026-06-25 are ungated by construction — the calendar did not exist).',
          'In rotation the gate excludes printing names from the leaderboard: never bought, and a held printing name drops off and is SOLD.',
          'Retire the whole grid with: UPDATE trading_strategies SET status=\'retired\' WHERE name LIKE \'egate/%\';',
        ].join(' '),
        config: { ...b.config, earningsGateDays: days },
      });
    }
  }
  return rows;
}

/** @description Selects the grid for --grid.
 *  @returns The chosen grid's rows. */
function buildGrid(): GridRow[] {
  if (GRID_NAME === 'ira') return buildIraGrid();
  if (GRID_NAME === 'thesis') return buildThesisGrid();
  if (GRID_NAME === 'egate') return buildEgateGrid();
  if (GRID_NAME !== 'sweep4') throw new Error(`unknown --grid '${GRID_NAME}' (know: sweep4, ira, thesis, egate)`);
  return buildSweep4Grid();
}

/** @description Guard for grids that need a knob the DEPLOYED api may not know yet: an api whose
 *  normalizeConfig silently drops earningsGateDays would seed gate-off DUPLICATES that masquerade
 *  as twins forever. Verifies the running api documents the knob before seeding.
 *  @throws When the deployed api predates the knob. */
async function assertApiKnowsEarningsGate(): Promise<void> {
  const { status, json } = await call('GET', '/api/trading/lab/knobs');
  if (status !== 200) throw new Error(`knobs read HTTP ${status}`);
  const knobs = (json.knobs ?? []) as Array<{ key: string }>;
  if (!knobs.some((k) => k.key === 'earningsGateDays')) {
    throw new Error('the RUNNING api does not know earningsGateDays (pre-gate build) — seeding now would create gate-off duplicates masquerading as twins. Deploy the new build first (the 15:05 CT one-shot does this), then re-run --grid egate.');
  }
}

/** Per-row outcome of the generation pass. */
interface SeedResult { name: string; created: boolean; skipped: boolean; error?: string; totalReturnPct?: number }

/** @description Runs a backtest for one strategy id and projects the outcome.
 *  @param name - Strategy name (for the result row).
 *  @param id - Strategy id.
 *  @param created - Whether this call also created the row.
 *  @returns What happened, for the RESULT line. */
async function backtest(name: string, id: string, created: boolean): Promise<SeedResult> {
  const bt = await call('POST', `/api/trading/lab/strategies/${id}/backtest`, {});
  if (bt.status !== 200 && bt.status !== 201) {
    return { name, created, skipped: false, error: `backtest HTTP ${bt.status}: ${JSON.stringify(bt.json).slice(0, 160)}` };
  }
  const run = (bt.json.run ?? bt.json) as { status?: string; error?: string; metrics?: { totalReturnPct?: number } };
  if (run.status === 'failed') return { name, created, skipped: false, error: `backtest failed: ${run.error || 'unknown'}` };
  return { name, created, skipped: false, totalReturnPct: run.metrics?.totalReturnPct };
}

/** @description Creates a grid row if absent and seeds a baselined backtest; an existing row is
 *  skipped unless --rebacktest, which refreshes its metrics against the deployed build.
 *  @param row - The grid row.
 *  @param existing - name -> id map of strategies already in the library.
 *  @returns What happened, for the RESULT line. */
async function seedRow(row: GridRow, existing: Map<string, string>): Promise<SeedResult> {
  const known = existing.get(row.name);
  if (known) {
    if (!REBACKTEST) return { name: row.name, created: false, skipped: true };
    return backtest(row.name, known, false);
  }
  const created = await call('POST', '/api/trading/lab/strategies', { name: row.name, description: row.description, config: row.config });
  // Racing another seeder (or a stale map) surfaces as 409 — treat it exactly like "already there".
  if (created.status === 409) return { name: row.name, created: false, skipped: true };
  if (created.status !== 201) {
    return { name: row.name, created: false, skipped: false, error: `create HTTP ${created.status}: ${JSON.stringify(created.json).slice(0, 160)}` };
  }
  const id = String((created.json.strategy as { id?: string } | undefined)?.id || '');
  if (!id) return { name: row.name, created: true, skipped: false, error: 'create returned no id' };
  // backtestStrategy() sets baseline_run_id on the first run, which is what makes this row
  // eligible for the nightly regression half as well as the forward walk.
  return backtest(row.name, id, true);
}

/** @description Reads the library once so seeding knows what already exists (and its id).
 *  @returns name -> strategy id. */
async function existingByName(): Promise<Map<string, string>> {
  const { status, json } = await call('GET', '/api/trading/lab/strategies');
  if (status !== 200) throw new Error(`list HTTP ${status}`);
  const rows = (json.strategies ?? []) as Array<{ id: string; name: string }>;
  return new Map(rows.map((r) => [r.name, r.id]));
}

/** The leaderboard shape pulled from GET /strategies. */
interface BoardRow {
  name: string; status: string;
  total: number; avgDaily: number; bestDay: number; worstDay: number;
  sharpe: number; maxDD: number; alpha: number; trades: number; bars: number; fwd: number;
}

/** @description Reads every strategy and projects the metric columns for the board.
 *  @returns Board rows (sweep-only unless --all). */
async function readBoard(): Promise<BoardRow[]> {
  const { status, json } = await call('GET', '/api/trading/lab/strategies');
  if (status !== 200) throw new Error(`list HTTP ${status}`);
  const strategies = (json.strategies ?? []) as Array<{
    name: string; status: string; forwardPoints?: number;
    latestBacktest?: { metrics?: Record<string, number> } | null;
  }>;
  return strategies
    .filter((s) => BOARD_ALL || s.name.startsWith(`${GRID_NAME}/`))
    .map((s) => {
      const m = s.latestBacktest?.metrics ?? {};
      return {
        name: s.name, status: s.status,
        total: Number(m.totalReturnPct ?? 0), avgDaily: Number(m.avgDailyPct ?? 0),
        bestDay: Number(m.bestDayPct ?? 0), worstDay: Number(m.worstDayPct ?? 0),
        sharpe: Number(m.sharpe ?? 0), maxDD: Number(m.maxDrawdownPct ?? 0),
        alpha: Number(m.alphaVsSpyPct ?? 0), trades: Number(m.trades ?? 0),
        bars: Number(m.bars ?? 0), fwd: Number(s.forwardPoints ?? 0),
      };
    });
}

const SORTS: Record<string, (a: BoardRow, b: BoardRow) => number> = {
  total: (a, b) => b.total - a.total,
  avgdaily: (a, b) => b.avgDaily - a.avgDaily,
  bestday: (a, b) => b.bestDay - a.bestDay,
  sharpe: (a, b) => b.sharpe - a.sharpe,
  alpha: (a, b) => b.alpha - a.alpha,
};

/** @description Prints the leaderboard table.
 *  @param rows - Board rows.
 *  @returns Nothing; writes to stdout. */
function printBoard(rows: BoardRow[]): void {
  const sorted = [...rows].sort(SORTS[SORT_KEY] ?? SORTS.total);
  const pad = (s: string | number, n: number, left = false): string => {
    const v = String(s);
    return left ? v.padEnd(n) : v.padStart(n);
  };
  console.log('');
  console.log(`Strategy Lab leaderboard — ${sorted.length} row(s), sorted by ${SORT_KEY} (backtest metrics; fwd = forward sessions walked)`);
  console.log(`${pad('strategy', 30, true)} ${pad('total%', 8)} ${pad('avgDay%', 8)} ${pad('bestDay%', 9)} ${pad('worstDay%', 10)} ${pad('sharpe', 7)} ${pad('maxDD%', 7)} ${pad('alpha%', 8)} ${pad('trades', 7)} ${pad('fwd', 4)}`);
  console.log('-'.repeat(115));
  for (const r of sorted) {
    console.log(`${pad(r.name.slice(0, 30), 30, true)} ${pad(r.total.toFixed(2), 8)} ${pad(r.avgDaily.toFixed(3), 8)} ${pad(r.bestDay.toFixed(2), 9)} ${pad(r.worstDay.toFixed(2), 10)} ${pad(r.sharpe.toFixed(2), 7)} ${pad(r.maxDD.toFixed(2), 7)} ${pad(r.alpha.toFixed(2), 8)} ${pad(r.trades, 7)} ${pad(r.fwd, 4)}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const grid = buildGrid();

  if (DRY_RUN) {
    console.log(`Grid '${GRID_NAME}': ${grid.length} rows, all unlisted dials pinned to the armed base.`);
    for (const g of grid) console.log(`  ${g.name}`);
    console.log(`RESULT ${JSON.stringify({ ok: true, dryRun: true, rows: grid.length })}`);
    return;
  }

  if (!BOARD_ONLY) {
    if (GRID_NAME === 'egate') await assertApiKnowsEarningsGate();
    const existing = await existingByName();
    console.log(`Seeding ${grid.length} sweep rows sequentially (Alpaca rate limits) — expect ~2-3 min${REBACKTEST ? '; --rebacktest: existing rows get fresh metrics' : ''}...`);
    const results: SeedResult[] = [];
    for (let i = 0; i < grid.length; i++) {
      const r = await seedRow(grid[i], existing);
      results.push(r);
      const tag = r.skipped ? 'exists (skipped)' : r.error ? `ERROR ${r.error}` : `ok total=${r.totalReturnPct}%`;
      console.log(`  [${String(i + 1).padStart(2)}/${grid.length}] ${grid[i].name.padEnd(30)} ${tag}`);
    }
    const createdCount = results.filter((r) => r.created && !r.error).length;
    const skipped = results.filter((r) => r.skipped).length;
    const failed = results.filter((r) => r.error);
    const board = await readBoard();
    printBoard(board);
    console.log(`RESULT ${JSON.stringify({ ok: failed.length === 0, created: createdCount, skipped, failed: failed.map((f) => ({ name: f.name, error: f.error })) })}`);
    if (failed.length) process.exitCode = 1;
    return;
  }

  const board = await readBoard();
  printBoard(board);
  console.log(`RESULT ${JSON.stringify({ ok: true, rows: board.length })}`);
}

main().catch((err) => {
  console.error(`sweep failed: ${(err as Error).message}`);
  console.log(`RESULT ${JSON.stringify({ ok: false, error: (err as Error).message })}`);
  process.exitCode = 2;
});
