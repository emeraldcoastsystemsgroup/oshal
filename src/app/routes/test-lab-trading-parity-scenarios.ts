/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register the ADR-052 addendum parity card: two read-only steps over the signed-in caller's own legacy paper and live books. The market-gap step reports each book's resolved bar and where it came from (applied strategy knob, mode-aware env, or off), today's SPY verdict when a book is armed, and the caller's 'market-gap' counterfactual rows; the exit-plan step reports each book's plan life and source and the paper book's open plans and closed-by-door counts. Neither step writes anything (an absent table is reported, never created), and neither claims the paper soak, which only elapsed market time on an armed paper book can produce. Paper not armed = degraded, with the exact setting that starts the soak.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | ADR-052 addendum P6: a third read-only step, yield-sleeve-readback. It reports each legacy book's resolved working float and where it came from (strategy knob, mode-aware env, or off), the fund, and the paper book's own sleeve ledger read from its decisions: funding sales, the funding sales a buy followed within two minutes (the ledger's sell-first evidence), sales no buy followed, parks, refills and the last funding day. Paper not armed = degraded with the setting that starts the soak; it never claims the soak. The two new sleeve specs join regressionTests.
 */
import type { Scenario, StepResult, ScenarioRunContext } from './test-lab-scenarios';
import { marketGapFilterPct, exitPlanSessions, yieldSleeveFloatPct, yieldSleeveSymbol, type MarketGapVerdict } from '@/features/trading';
import { legacyBookId } from '@/app/trading-books-store';
import { getActiveOverride, type ConfigOverrideRow } from '@/app/trading-config-overrides';
import { evaluateMarketGap } from '@/app/trading-dispatch-market-gate';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'test-lab-trading-parity' });
const APP = 'intelligent-trades';
const NOT_PROOF = 'A readback of this node\'s configuration and the caller\'s own ledger — not the paper soak, which only market time on an armed paper book produces.';

/** Where a book's effective setting came from. */
export type ParitySource = 'strategy' | 'env' | 'off';

/** What the readback resolved for one of the caller's legacy books. */
export interface ParityBookFacts {
  book: 'paper' | 'live';
  marketGapPct: number;
  marketGapSource: ParitySource;
  planSessions: number;
  planSource: ParitySource;
}

/** Everything both steps grade — measured once, graded purely. */
export interface ParityFacts {
  books: ParityBookFacts[];
  /** The caller's 'market-gap' counterfactual rows across its books; null when the ledger table does not exist. */
  counterfactualRows: number | null;
  /** The latest ET day a market-gap hold recorded a row; null when none. */
  lastHeldDay: string | null;
  /** The paper book's plan ledger; null when no plan has ever been stamped on this node (table absent). */
  paperPlans: { open: number; superseded: number; amended: number; closedByDoor: Record<string, number> } | null;
  /** Today's SPY verdict at the widest armed bar; null when no book is armed. */
  todayGap: MarketGapVerdict | null;
}

/**
 * @description Where a resolved value came from: a knob the applied strategy carries (0 included —
 * an explicit off), else the env when it armed the book, else off.
 * @param knob - The applied strategy's knob value.
 * @param resolved - The resolver's answer for the book.
 * @returns The source label.
 */
export function paritySource(knob: number | null | undefined, resolved: number): ParitySource {
  if (knob !== null && knob !== undefined) return 'strategy';
  return resolved > 0 ? 'env' : 'off';
}

/** One book's resolved parity settings, from the same resolvers the dispatch reads. */
function bookFacts(book: 'paper' | 'live', override: ConfigOverrideRow | null): ParityBookFacts {
  const gapKnob = override?.config.marketGapFilterPct;
  const planKnob = override?.config.exitPlanSessions;
  const marketGapPct = marketGapFilterPct(gapKnob, book);
  const planSessions = exitPlanSessions(planKnob, book);
  return { book, marketGapPct, marketGapSource: paritySource(gapKnob, marketGapPct), planSessions, planSource: paritySource(planKnob, planSessions) };
}

/** A book's posture as one clause of the step detail. */
const posture = (b: ParityBookFacts, value: number, source: ParitySource, unit: string): string =>
  `${b.book} ${value > 0 ? `armed at ${value}${unit} (${source})` : `off${source === 'strategy' ? ' (strategy knob 0)' : ''}`}`;

/**
 * @description Grade the market-wide gap-down readback. Paper armed = pass; paper not armed =
 * degraded with the setting that starts the soak. Never claims the soak.
 * @param f - The measured facts.
 * @returns The Lab step result with the facts as its output.
 */
export function marketGapStep(f: ParityFacts): StepResult {
  const label = 'Market-wide gap-down entry filter (ADR-052 addendum)';
  const paper = f.books.find((b) => b.book === 'paper');
  const books = f.books.map((b) => posture(b, b.marketGapPct, b.marketGapSource, '%')).join('; ');
  const today = f.todayGap ? ` Today SPY ${f.todayGap.gapPct == null ? 'unmeasurable (fails open)' : `${f.todayGap.gapPct.toFixed(2)}% vs its prior close — ${f.todayGap.blocked ? 'entries HOLD' : 'entries proceed'}`}.` : '';
  const rows = f.counterfactualRows == null ? ' No counterfactual ledger on this node yet.' : ` ${f.counterfactualRows} market-gap counterfactual row(s)${f.lastHeldDay ? `, last ${f.lastHeldDay}` : ''}.`;
  const output = { books: f.books.map(({ book, marketGapPct, marketGapSource }) => ({ book, marketGapPct, marketGapSource })), todayGap: f.todayGap, counterfactualRows: f.counterfactualRows, lastHeldDay: f.lastHeldDay };
  if (!paper || paper.marketGapPct <= 0) {
    return { app: APP, label, state: 'degraded', output, detail: `Not armed on the paper book, so the soak is not running: set TRADING_MARKET_GAP_FILTER=paper, or apply a strategy with marketGapFilterPct to the paper book. ${books}.${rows} ${NOT_PROOF}` };
  }
  return { app: APP, label, state: 'pass', output, detail: `${books}.${today}${rows} ${NOT_PROOF}` };
}

/**
 * @description Grade the per-position exit-plan readback. Paper armed = pass; paper not armed =
 * degraded with the setting that starts the soak. Never claims the soak.
 * @param f - The measured facts.
 * @returns The Lab step result with the facts as its output.
 */
export function exitPlanStep(f: ParityFacts): StepResult {
  const label = 'Per-position exit plans (ADR-052 addendum)';
  const paper = f.books.find((b) => b.book === 'paper');
  const books = f.books.map((b) => posture(b, b.planSessions, b.planSource, ' sessions')).join('; ');
  const doors = f.paperPlans ? Object.entries(f.paperPlans.closedByDoor).map(([door, n]) => `${door} ${n}`).join(', ') : '';
  const ledger = f.paperPlans
    ? ` Paper book: ${f.paperPlans.open} open plan(s), ${f.paperPlans.superseded} re-underwritten, ${f.paperPlans.amended} amended; closed by door: ${doors || 'none yet'}.`
    : ' No plan has been stamped on this node yet.';
  const output = { books: f.books.map(({ book, planSessions, planSource }) => ({ book, planSessions, planSource })), paperPlans: f.paperPlans };
  if (!paper || paper.planSessions <= 0) {
    return { app: APP, label, state: 'degraded', output, detail: `Not armed on the paper book, so the soak is not running: set TRADING_EXIT_PLANS=paper, or apply a strategy with exitPlanSessions to the paper book. ${books}.${ledger} ${NOT_PROOF}` };
  }
  return { app: APP, label, state: 'pass', output, detail: `${books}.${ledger} ${NOT_PROOF}` };
}

/** One book's resolved yield-sleeve float, from the dispatch's own resolver. */
export interface SleeveBookFacts { book: 'paper' | 'live'; floatPct: number; source: ParitySource }

/** What the yield-sleeve step grades — measured once, graded purely. */
export interface SleeveFacts {
  books: SleeveBookFacts[];
  /** The fund this node parks in. */
  symbol: string;
  /** The paper book's sleeve decisions; null when the decision ledger does not exist on this node. */
  paperLedger: { fundSales: number; fundedFires: number; unfollowedSales: number; parks: number; refills: number; lastFundDay: string | null } | null;
}

/**
 * @description Grade the idle-cash yield sleeve readback. Paper armed = pass, with the ledger's
 * sell-first evidence (funding sales a buy followed); paper not armed = degraded with the setting that
 * starts the soak. Never claims the soak.
 * @param f - The measured facts.
 * @returns The Lab step result with the facts as its output.
 */
export function yieldSleeveStep(f: SleeveFacts): StepResult {
  const label = 'Idle-cash yield sleeve (ADR-052 addendum P6)';
  const paper = f.books.find((b) => b.book === 'paper');
  const books = f.books.map((b) => `${b.book} ${b.floatPct > 0 ? `armed with a ${b.floatPct}% float (${b.source})` : `off${b.source === 'strategy' ? ' (strategy knob 0)' : ''}`}`).join('; ');
  const l = f.paperLedger;
  const ledger = !l ? ' No decision ledger on this node yet.'
    : ` Paper book: ${l.fundSales} funding sale(s) of ${f.symbol}, ${l.fundedFires} followed by the buys they funded, ${l.unfollowedSales} with no buy after them; ${l.parks} park(s), ${l.refills} refill(s)${l.lastFundDay ? `; last funding ${l.lastFundDay}` : ''}.`;
  const output = { books: f.books, symbol: f.symbol, paperLedger: f.paperLedger };
  if (!paper || paper.floatPct <= 0) {
    return { app: APP, label, state: 'degraded', output, detail: `Not armed on the paper book, so the soak is not running: set TRADING_YIELD_SLEEVE=paper, or apply a strategy with yieldSleeveFloatPct to the paper book. ${books}.${ledger} ${NOT_PROOF}` };
  }
  return { app: APP, label, state: 'pass', output, detail: `${books}; fund ${f.symbol}.${ledger} ${NOT_PROOF}` };
}

/** True when `table` exists — checked so a read-only step never creates one. */
async function tableExists(runtime: ScenarioRunContext, table: string): Promise<boolean> {
  const r = await runtime.ctx.pool.query('SELECT to_regclass($1) IS NOT NULL AS present', [table]);
  return Boolean(r.rows[0]?.present);
}

/** The caller's market-gap counterfactual rows across its books (null when the ledger table is absent). */
async function counterfactuals(runtime: ScenarioRunContext): Promise<{ rows: number | null; last: string | null }> {
  if (!(await tableExists(runtime, 'oshal_trading_gate_blocks'))) return { rows: null, last: null };
  const r = await runtime.ctx.pool.query(
    `SELECT count(*)::int AS n, max(et_day)::text AS last FROM oshal_trading_gate_blocks WHERE user_sub = $1 AND gate = 'market-gap'`, [runtime.ownerSub]);
  return { rows: Number(r.rows[0]?.n ?? 0), last: r.rows[0]?.last ?? null };
}

/** The caller's paper-book plan ledger, summarised (null when no plan table exists on this node). */
async function paperPlanSummary(runtime: ScenarioRunContext): Promise<ParityFacts['paperPlans']> {
  if (!(await tableExists(runtime, 'oshal_trading_position_plans'))) return null;
  const r = await runtime.ctx.pool.query(
    `SELECT status, closed_by_door, count(*)::int AS n FROM oshal_trading_position_plans
      WHERE user_sub = $1 AND book_id = $2 GROUP BY status, closed_by_door`, [runtime.ownerSub, legacyBookId(runtime.ownerSub, 'paper')]);
  const out = { open: 0, superseded: 0, amended: 0, closedByDoor: {} as Record<string, number> };
  for (const row of r.rows) {
    if (row.status === 'open') out.open += row.n;
    else if (row.status === 'superseded') out.superseded += row.n;
    else if (row.status === 'amended') out.amended += row.n;
    else if (row.status === 'closed') out.closedByDoor[String(row.closed_by_door ?? 'unknown')] = row.n;
  }
  return out;
}

/**
 * @description Measure the caller's parity facts: each legacy book's applied strategy through the
 * dispatch's own resolvers, the counterfactual and plan ledgers (read only), and today's SPY verdict
 * when any book is armed.
 * @param runtime - The server-derived run context (the signed-in caller and the app context).
 * @returns The facts both steps grade.
 */
export async function gatherParityFacts(runtime: ScenarioRunContext): Promise<ParityFacts> {
  const books: ParityBookFacts[] = [];
  for (const book of ['paper', 'live'] as const) {
    const override = await getActiveOverride(runtime.ctx.pool, runtime.ownerSub, legacyBookId(runtime.ownerSub, book));
    books.push(bookFacts(book, override));
  }
  const widest = Math.max(...books.map((b) => b.marketGapPct));
  const { rows, last } = await counterfactuals(runtime);
  return {
    books, counterfactualRows: rows, lastHeldDay: last,
    paperPlans: await paperPlanSummary(runtime),
    todayGap: widest > 0 ? await evaluateMarketGap(widest) : null,
  };
}

/** The paper book's sleeve ledger from its decisions (null when the decision table is absent). */
async function paperSleeveLedger(runtime: ScenarioRunContext): Promise<SleeveFacts['paperLedger']> {
  if (!(await tableExists(runtime, 'oshal_trading_decisions'))) return null;
  const params = [runtime.ownerSub, legacyBookId(runtime.ownerSub, 'paper')];
  const counts = (await runtime.ctx.pool.query(
    `SELECT count(*) FILTER (WHERE indicators->>'reason' = 'yield-sleeve-fund')::int AS fund,
            count(*) FILTER (WHERE indicators->>'reason' = 'yield-sleeve-park')::int AS parks,
            count(*) FILTER (WHERE indicators->>'reason' = 'yield-sleeve-refill')::int AS refills,
            (max(created_at) FILTER (WHERE indicators->>'reason' = 'yield-sleeve-fund') AT TIME ZONE 'America/New_York')::date::text AS last_fund
       FROM oshal_trading_decisions WHERE user_sub = $1 AND book_id = $2`, params)).rows[0] ?? {};
  const funded = (await runtime.ctx.pool.query(
    `SELECT count(*)::int AS n FROM oshal_trading_decisions f
      WHERE f.user_sub = $1 AND f.book_id = $2 AND f.indicators->>'reason' = 'yield-sleeve-fund'
        AND EXISTS (SELECT 1 FROM oshal_trading_decisions b WHERE b.user_sub = f.user_sub AND b.book_id = f.book_id
              AND b.side = 'buy' AND b.symbol <> f.symbol AND b.created_at > f.created_at AND b.created_at <= f.created_at + interval '2 minutes')`,
    params)).rows[0] ?? {};
  const fundSales = Number(counts.fund ?? 0);
  const fundedFires = Number(funded.n ?? 0);
  return { fundSales, fundedFires, unfollowedSales: fundSales - fundedFires, parks: Number(counts.parks ?? 0), refills: Number(counts.refills ?? 0), lastFundDay: counts.last_fund ?? null };
}

/**
 * @description Measure the caller's yield-sleeve facts: each legacy book's applied strategy through the
 * dispatch's own resolver, the fund, and the paper book's sleeve ledger (read only).
 * @param runtime - The server-derived run context (the signed-in caller and the app context).
 * @returns The facts the step grades.
 */
export async function gatherSleeveFacts(runtime: ScenarioRunContext): Promise<SleeveFacts> {
  const books: SleeveBookFacts[] = [];
  for (const book of ['paper', 'live'] as const) {
    const override = await getActiveOverride(runtime.ctx.pool, runtime.ownerSub, legacyBookId(runtime.ownerSub, book));
    const knob = override?.config.yieldSleeveFloatPct;
    const floatPct = yieldSleeveFloatPct(knob, book);
    books.push({ book, floatPct, source: paritySource(knob, floatPct) });
  }
  return { books, symbol: yieldSleeveSymbol(), paperLedger: await paperSleeveLedger(runtime) };
}

/** Run one step: gather (read only) and grade; a missing runtime or a failed read is reported, never thrown. */
async function runStep<F>(
  label: string, runtime: ScenarioRunContext | undefined, grade: (f: F) => StepResult,
  gather: (r: ScenarioRunContext) => Promise<F>,
): Promise<StepResult> {
  if (!runtime) return { app: APP, label, state: 'degraded', detail: 'No server run context (signed-in caller) reached this step; nothing was read.' };
  try {
    return grade(await gather(runtime));
  } catch (err) {
    logger.error({ err, ownerSub: runtime.ownerSub }, 'parity readback failed');
    return { app: APP, label, state: 'fail', detail: `The readback could not complete: ${(err as Error).message}. Nothing was written.` };
  }
}

/** @description The ADR-052 addendum parity card. @returns One read-only scenario with two steps. */
export const TRADING_PARITY_SCENARIOS: Scenario[] = [{
  id: 'trading-parity-features', title: 'Trading paper-to-live parity — gap filter, exit plans and yield sleeve (ADR-052)', group: 'tool',
  description: 'The market-wide gap-down entry filter, per-position exit plans and the idle-cash yield sleeve (ADR-052 addendum): one config path per feature (an applied strategy knob, else a mode-aware env default, OFF by default), read the same way by the Strategy Lab and both books. The steps read the signed-in caller\'s own books and ledgers only; they write nothing and never claim the paper soak.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/trading-entry-guards.spec.ts' },
    { level: 'unit', path: 'tests/unit/trading-position-plan.spec.ts' },
    { level: 'unit', path: 'tests/unit/trading-strategy-lab-sim.spec.ts' },
    { level: 'unit', path: 'tests/unit/trading-dispatch-decomposition.spec.ts' },
    { level: 'unit', path: 'tests/unit/test-lab-trading-parity-registration.spec.ts' },
    { level: 'integration', path: 'tests/unit/trading-position-plans-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/trading-parity-fire.spec.ts' },
    { level: 'integration', path: 'tests/unit/trading-dispatch-golden-plan.spec.ts' },
    { level: 'unit', path: 'tests/unit/trading-yield-sleeve.spec.ts' },
    { level: 'integration', path: 'tests/unit/trading-dispatch-yield-sleeve-fire.spec.ts' },
  ],
  steps: [
    { id: 'market-gap-readback', app: APP, label: 'Market-wide gap-down entry filter (ADR-052 addendum)',
      run: (_c, _p, runtime) => runStep('Market-wide gap-down entry filter (ADR-052 addendum)', runtime, marketGapStep, gatherParityFacts) },
    { id: 'exit-plan-readback', app: APP, label: 'Per-position exit plans (ADR-052 addendum)',
      run: (_c, _p, runtime) => runStep('Per-position exit plans (ADR-052 addendum)', runtime, exitPlanStep, gatherParityFacts) },
    { id: 'yield-sleeve-readback', app: APP, label: 'Idle-cash yield sleeve (ADR-052 addendum P6)',
      run: (_c, _p, runtime) => runStep('Idle-cash yield sleeve (ADR-052 addendum P6)', runtime, yieldSleeveStep, gatherSleeveFacts) },
  ],
}];
