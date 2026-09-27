/**
 * Per-position exit plans (ADR-052 addendum) — the TABLE and the per-fire ledger the dispatch uses.
 *
 * Every autonomous BUY the engine places while plans are armed for the book stamps a plan row:
 * the entry reference price, the stop / take-profit / trailing dials in force at that moment and an
 * expiry N NYSE sessions out (the math is src/features/trading/services/position-plan.ts). The
 * terms of a stored plan are IMMUTABLE — a database trigger refuses any UPDATE that touches them —
 * so a later posture or policy change cannot re-price a position already in flight. Re-pricing is
 * the explicit, audited amendPlans() action: the old row becomes `amended` and a new row carries
 * the new terms, the actor and the note. A later buy of the same name, or a fresh buy signal on a
 * held name, supersedes the open plan with a fresh one (the position is re-earned, never
 * grandfathered). A full exit closes the plan and records the DOOR that fired — the plan's own
 * (plan-stop / plan-tp / plan-trail / plan-expiry) or an event door (breakdown, signal, rotation,
 * ext_dip, and the global stop_loss / take_profit / trailing_stop for a position that had none).
 *
 * Nothing here runs unless plans are armed for the book (exitPlanSessions > 0): the dispatch gets a
 * null ledger and every call site is a no-op, so an unarmed fire is byte-identical to before.
 * Dispatch writes run under system identity, so every statement is scoped by (user_sub, book_id)
 * explicitly; owner RLS is the wall for route callers.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — oshal_trading_position_plans (owner RLS, one OPEN plan per (user_sub, book_id, symbol), a BEFORE UPDATE trigger freezing the terms, bootstrapped under the trading advisory lock), the per-fire PlanLedger (resolvePlanLedger: null unless the applied knob or the mode-aware env arms the book), the placeManaged hook (recordPlanOrder: a buy stamps and supersedes, a full exit closes with its door, a partial trim leaves the plan open), re-underwriting on a fresh buy signal, the exit leg's plan split (splitExitsByPlan — a read failure falls back to the global rules), amendPlans and listPositionPlans.
 *
 * @module trading-position-plans
 */

import type { PoolClient } from 'pg';
import type { AppContext } from './composition-root';
import {
  planTermsFor, planExits, exitPlanSessions, etSessionDate,
  type TradingBook, type RiskPolicy, type Position, type PositionPlan, type PlanDials, type ExitOrder,
} from '@/features/trading';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap, SCHEMA_LOCK_KEYS } from '@/shared/services/database';
import type { ConfigOverrideRow } from './trading-config-overrides';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'trading-position-plans' });

type Pool = AppContext['pool'];

/** Sell doors that trim part of a position: the plan stays open, the position is still held. */
const PARTIAL_DOORS = new Set(['cap_trim', 'rotation-trim', 'core-trim']);
/** Venue outcomes that mean no order is working, so no plan may be stamped or closed on them. */
const NOT_PLACED = new Set(['rejected', 'canceled', 'cancelled', 'expired']);
/** Pools this process has already bootstrapped: the DDL (a trigger re-create included) runs once per
 *  pool, not on every stamp. The advisory lock, not this memo, is what serialises processes. */
const bootstrapped = new WeakSet<Pool>();
/** The entry leg a buy decision's `source` names, as the plan records it. */
const LEG_OF: Record<string, string> = { 'mtf-autopilot': 'scan', 'gravity-rotation': 'rotation', 'pop-catcher': 'pop' };

/**
 * @description Create the plans table, its immutability trigger and owner RLS if absent. Serialised
 * on the trading family's advisory lock like every sibling store.
 * @param pool - Postgres pool.
 * @returns Resolves once the schema is in place (or its requirements are asserted).
 */
export async function ensurePositionPlansTable(pool: Pool): Promise<void> {
  if (bootstrapped.has(pool)) return;
  await runRuntimeSchemaBootstrap({
    pool, moduleName: 'trading position plans', lockKey: SCHEMA_LOCK_KEYS.trading,
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_trading_position_plans (
        plan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL, mode TEXT NOT NULL, book_id UUID NOT NULL, symbol TEXT NOT NULL,
        decision_id UUID, source TEXT NOT NULL, posture TEXT NOT NULL,
        entry_price NUMERIC(18,4) NOT NULL, stop_loss_pct NUMERIC(8,4) NOT NULL, take_profit_pct NUMERIC(8,4) NOT NULL,
        trail_arm_pct NUMERIC(8,4) NOT NULL, trail_giveback_pct NUMERIC(8,4) NOT NULL,
        stop_price NUMERIC(18,4) NOT NULL, take_profit_price NUMERIC(18,4) NOT NULL,
        sessions INTEGER NOT NULL, stamped_session DATE NOT NULL, expiry_session DATE NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','superseded','amended')),
        superseded_by UUID, amended_from UUID, amended_by TEXT, amend_note TEXT,
        closed_by_door TEXT, closed_decision_id UUID, closed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_position_plans_open
         ON oshal_trading_position_plans (user_sub, book_id, symbol) WHERE status = 'open'`,
      'CREATE INDEX IF NOT EXISTS idx_trd_position_plans_book ON oshal_trading_position_plans (user_sub, book_id, created_at DESC)',
      `CREATE OR REPLACE FUNCTION oshal_trading_position_plan_terms_frozen() RETURNS trigger AS $fn$
       BEGIN
         IF (NEW.user_sub, NEW.mode, NEW.book_id, NEW.symbol, NEW.decision_id, NEW.source, NEW.posture, NEW.entry_price,
             NEW.stop_loss_pct, NEW.take_profit_pct, NEW.trail_arm_pct, NEW.trail_giveback_pct, NEW.stop_price,
             NEW.take_profit_price, NEW.sessions, NEW.stamped_session, NEW.expiry_session, NEW.created_at)
            IS DISTINCT FROM
            (OLD.user_sub, OLD.mode, OLD.book_id, OLD.symbol, OLD.decision_id, OLD.source, OLD.posture, OLD.entry_price,
             OLD.stop_loss_pct, OLD.take_profit_pct, OLD.trail_arm_pct, OLD.trail_giveback_pct, OLD.stop_price,
             OLD.take_profit_price, OLD.sessions, OLD.stamped_session, OLD.expiry_session, OLD.created_at) THEN
           RAISE EXCEPTION 'position plan terms are immutable; amend them with amendPlans()' USING ERRCODE = 'check_violation';
         END IF;
         RETURN NEW;
       END $fn$ LANGUAGE plpgsql`,
      'DROP TRIGGER IF EXISTS trg_trd_position_plans_frozen ON oshal_trading_position_plans',
      `CREATE TRIGGER trg_trd_position_plans_frozen BEFORE UPDATE ON oshal_trading_position_plans
         FOR EACH ROW EXECUTE FUNCTION oshal_trading_position_plan_terms_frozen()`,
      ...buildOwnerRlsPolicyStatements('oshal_trading_position_plans', 'user_sub'),
    ],
    requirements: [{
      table: 'oshal_trading_position_plans',
      columns: ['plan_id', 'user_sub', 'book_id', 'symbol', 'entry_price', 'stop_price', 'expiry_session', 'status', 'closed_by_door'],
    }],
  });
  bootstrapped.add(pool);
}

/** The per-fire plan context. Null (never constructed) while plans are off for the book. */
export interface PlanLedger {
  sub: string;
  book: TradingBook;
  /** The policy in force for this fire — the dials a plan stamped now carries. */
  policy: RiskPolicy;
  /** The plan life in NYSE sessions (> 0). */
  sessions: number;
  /** Today's ET session date — the stamp date and the expiry comparison. */
  today: string;
  /** Symbols stamped in THIS fire, so a re-underwrite never re-stamps a plan the same fire made. */
  stampedThisFire: Set<string>;
}

/**
 * @description The plan ledger for one fire, or null when plans are off for this book. Resolution
 * is exitPlanSessions over the applied strategy's knob, then the mode-aware env default.
 * @param sub - Owner sub.
 * @param book - The book firing.
 * @param override - The applied Strategy Library override, when one is active.
 * @param policy - The risk policy in force for the fire.
 * @param now - Clock for the session date (injectable for tests).
 * @returns The ledger, or null (the unarmed, byte-identical path).
 */
export function resolvePlanLedger(sub: string, book: TradingBook, override: ConfigOverrideRow | null, policy: RiskPolicy, now: number = Date.now()): PlanLedger | null {
  const sessions = exitPlanSessions(override?.config.exitPlanSessions, book.kind);
  if (sessions <= 0) return null;
  return { sub, book, policy, sessions, today: etSessionDate(now), stampedThisFire: new Set() };
}

/** Map one stored row to the plan the exit leg judges. */
function rowToPlan(r: Record<string, unknown>): PositionPlan & { status: string; source: string; decisionId: string | null; closedByDoor: string | null } {
  const day = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  return {
    planId: String(r.plan_id), symbol: String(r.symbol), posture: String(r.posture), source: String(r.source),
    decisionId: r.decision_id ? String(r.decision_id) : null, status: String(r.status),
    entryPrice: Number(r.entry_price), stopLossPct: Number(r.stop_loss_pct), takeProfitPct: Number(r.take_profit_pct),
    trailArmPct: Number(r.trail_arm_pct), trailGivebackPct: Number(r.trail_giveback_pct),
    stopPrice: Number(r.stop_price), takeProfitPrice: Number(r.take_profit_price), sessions: Number(r.sessions),
    stampedSession: day(r.stamped_session), expirySession: day(r.expiry_session),
    closedByDoor: r.closed_by_door ? String(r.closed_by_door) : null,
  };
}

/**
 * @description Stamp a fresh open plan for `symbol`, superseding any open one — atomically, so the
 * one-open-plan index can never see two. Terms come from the ledger's policy and clock.
 * @param pool - Postgres pool.
 * @param ledger - The fire's plan ledger.
 * @param stamp - Symbol, entry reference price, entry leg and (for a buy) the decision it stamps.
 * @returns The new plan id.
 */
export async function stampPlan(pool: Pool, ledger: PlanLedger, stamp: { symbol: string; entryPrice: number; source: string; decisionId: string | null }): Promise<string> {
  await ensurePositionPlansTable(pool);
  const sym = stamp.symbol.toUpperCase();
  const t = planTermsFor(ledger.policy, stamp.entryPrice, ledger.sessions, ledger.today);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const old = (await client.query(
      `UPDATE oshal_trading_position_plans SET status = 'superseded', closed_at = now()
        WHERE user_sub = $1 AND book_id = $2 AND symbol = $3 AND status = 'open' RETURNING plan_id`,
      [ledger.sub, ledger.book.bookId, sym])).rows;
    const planId = String((await client.query(
      `INSERT INTO oshal_trading_position_plans (user_sub, mode, book_id, symbol, decision_id, source, posture, entry_price,
         stop_loss_pct, take_profit_pct, trail_arm_pct, trail_giveback_pct, stop_price, take_profit_price, sessions,
         stamped_session, expiry_session)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::date,$17::date) RETURNING plan_id`,
      [ledger.sub, ledger.book.kind, ledger.book.bookId, sym, stamp.decisionId, stamp.source, t.posture, t.entryPrice,
        t.stopLossPct, t.takeProfitPct, t.trailArmPct, t.trailGivebackPct, t.stopPrice, t.takeProfitPrice, t.sessions,
        t.stampedSession, t.expirySession])).rows[0].plan_id);
    if (old.length) await client.query('UPDATE oshal_trading_position_plans SET superseded_by = $1 WHERE plan_id = ANY($2::uuid[])', [planId, old.map((o) => o.plan_id)]);
    await client.query('COMMIT');
    ledger.stampedThisFire.add(sym);
    return planId;
  } catch (err) {
    await client.query('ROLLBACK').catch((rbErr) => logger.error({ err: rbErr }, 'position plan stamp rollback failed'));
    throw err;
  } finally {
    client.release();
  }
}

/**
 * @description Close the open plan for `symbol` and record the door that ended it plus the exit
 * decision that took it. A symbol with no open plan is a no-op (a position that predates arming).
 * @param pool - Postgres pool.
 * @param ledger - The fire's plan ledger.
 * @param symbol - The symbol exiting.
 * @param door - The door that fired (a plan door or an event door).
 * @param decisionId - The exit decision.
 * @returns The closed plan id, or null when there was no open plan.
 */
export async function closeOpenPlan(pool: Pool, ledger: PlanLedger, symbol: string, door: string, decisionId: string): Promise<string | null> {
  await ensurePositionPlansTable(pool);
  const rows = (await pool.query(
    `UPDATE oshal_trading_position_plans SET status = 'closed', closed_by_door = $4, closed_decision_id = $5, closed_at = now()
      WHERE user_sub = $1 AND book_id = $2 AND symbol = $3 AND status = 'open' RETURNING plan_id`,
    [ledger.sub, ledger.book.bookId, symbol.toUpperCase(), door, decisionId])).rows;
  return rows.length ? String(rows[0].plan_id) : null;
}

/** The part of a placed decision the plan hook reads (structurally the rail's DecisionInput). */
export interface PlannedDecision { symbol: string; side: 'buy' | 'sell'; price: number | null; source: string; indicators: unknown }

/**
 * @description The door a sell decision records: its own indicator reason first (a rotation trim
 * says 'rotation-trim' while its journal tag says 'rotation'), then the journal tag, then the
 * weighted scan's technical sell as 'signal'.
 * @param d - The sell decision.
 * @param reason - The run-order journal tag placeManaged was given.
 * @returns The door name.
 */
export function sellDoor(d: PlannedDecision, reason?: string): string {
  const own = (d.indicators && typeof d.indicators === 'object') ? (d.indicators as { reason?: unknown }).reason : undefined;
  if (typeof own === 'string' && own) return own;
  if (reason) return reason;
  return d.source === 'mtf-autopilot' ? 'signal' : d.source;
}

/**
 * @description The placeManaged hook: after an order is placed, a BUY stamps (and supersedes) the
 * name's plan at the decision's reference price; a full-exit SELL closes the open plan with its door;
 * a partial trim leaves the plan open. Never throws — the order it follows WAS placed, so a plan
 * write failure is logged at ERROR and the position simply falls back to the global rules.
 * @param pool - Postgres pool.
 * @param ledger - The fire's plan ledger.
 * @param decisionId - The decision placeManaged just executed.
 * @param d - That decision.
 * @param status - The venue status placeDecisionOrder returned.
 * @param reason - The run-order journal tag.
 * @returns Resolves when the plan row is written (or the failure logged).
 */
export async function recordPlanOrder(pool: Pool, ledger: PlanLedger, decisionId: string, d: PlannedDecision, status: string, reason?: string): Promise<void> {
  if (NOT_PLACED.has(String(status).toLowerCase())) return;
  try {
    if (d.side === 'buy') {
      if (!(Number(d.price) > 0)) {
        logger.warn({ sub: ledger.sub, bookRef: ledger.book.ref, symbol: d.symbol }, 'buy carried no reference price — no plan stamped; the position runs on the global rules');
        return;
      }
      await stampPlan(pool, ledger, { symbol: d.symbol, entryPrice: Number(d.price), source: LEG_OF[d.source] ?? d.source, decisionId });
      return;
    }
    const door = sellDoor(d, reason);
    if (!PARTIAL_DOORS.has(door)) await closeOpenPlan(pool, ledger, d.symbol, door, decisionId);
  } catch (err) {
    logger.error({ err, sub: ledger.sub, bookRef: ledger.book.ref, symbol: d.symbol, side: d.side }, 'position plan write failed — the order stands; this position falls back to the global rules');
  }
}

/**
 * @description Re-underwrite held names that drew a FRESH buy signal this fire without being bought
 * (a scan 'buy' on a held name; a rotation leader held at its goal): the open plan is superseded by
 * a new one at the current price with a new clock. Only names that already carry an open plan are
 * touched — a position with no plan stays on the global rules — and a name stamped earlier in this
 * same fire is skipped. Never throws.
 * @param pool - Postgres pool.
 * @param ledger - The fire's plan ledger.
 * @param candidates - Held names with a buy signal and the price that signal was judged at.
 * @param source - The leg re-earning them ('scan' | 'rotation').
 * @returns The symbols re-underwritten.
 */
export async function reunderwritePlans(pool: Pool, ledger: PlanLedger, candidates: Array<{ symbol: string; price: number | null }>, source: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const open = await loadOpenPlans(pool, ledger.sub, ledger.book.bookId);
    for (const c of candidates) {
      const sym = c.symbol.toUpperCase();
      if (!open.has(sym) || ledger.stampedThisFire.has(sym) || !(Number(c.price) > 0)) continue;
      await stampPlan(pool, ledger, { symbol: sym, entryPrice: Number(c.price), source: `${source}-reunderwrite`, decisionId: null });
      out.push(sym);
    }
  } catch (err) {
    logger.error({ err, sub: ledger.sub, bookRef: ledger.book.ref, source }, 'plan re-underwrite failed — existing plans stand unchanged');
  }
  return out;
}

/**
 * @description Held, engine-managed names among `symbols`, priced at the book's own mark — the
 * re-underwrite candidates of a leg that re-selected them. A name the engine cannot account for
 * (ADR-159 `unmanaged`) is never a candidate: no engine decision touches it, a plan clock included.
 * @param positions - The marked positions of the fire.
 * @param symbols - The names the leg re-selected.
 * @returns One candidate per held, managed name, at its current price.
 */
export function heldCandidates(positions: Position[], symbols: Iterable<string>): Array<{ symbol: string; price: number | null }> {
  const want = new Set([...symbols].map((s) => s.toUpperCase()));
  return positions
    .filter((p) => p.qty > 0 && !p.unmanaged && want.has(p.symbol.toUpperCase()))
    .map((p) => ({ symbol: p.symbol.toUpperCase(), price: p.currentPrice ?? null }));
}

/**
 * @description Every OPEN plan of one book, keyed by UPPERCASE symbol.
 * @param pool - Postgres pool.
 * @param sub - Owner sub (the WHERE is the wall under system identity).
 * @param bookId - The book.
 * @returns Open plans by symbol.
 */
export async function loadOpenPlans(pool: Pool, sub: string, bookId: string): Promise<Map<string, PositionPlan>> {
  await ensurePositionPlansTable(pool);
  const rows = (await pool.query(
    `SELECT * FROM oshal_trading_position_plans WHERE user_sub = $1 AND book_id = $2 AND status = 'open'`, [sub, bookId])).rows;
  return new Map(rows.map((r) => { const p = rowToPlan(r); return [p.symbol.toUpperCase(), p] as const; }));
}

/**
 * @description The exit leg's split: positions with an open plan are judged by planExits on their
 * OWN terms; the rest are returned for the global rules. A read failure returns null and logs at
 * ERROR, and the caller then runs the global rules over the whole book — exactly today's behaviour,
 * never a fire with no exits at all.
 * @param pool - Postgres pool.
 * @param ledger - The fire's plan ledger.
 * @param positions - The marked, overlaid positions.
 * @param peaks - The rolled-forward peak per symbol.
 * @returns The plan exits and the unplanned positions, or null on a read failure.
 */
export async function splitExitsByPlan(pool: Pool, ledger: PlanLedger, positions: Position[], peaks: Map<string, number>): Promise<{ exits: ExitOrder[]; unplanned: Position[] } | null> {
  try {
    return planExits(positions, await loadOpenPlans(pool, ledger.sub, ledger.book.bookId), peaks, ledger.today);
  } catch (err) {
    logger.error({ err, sub: ledger.sub, bookRef: ledger.book.ref }, 'open-plan read FAILED — every position runs on the global exit rules this fire');
    return null;
  }
}

/** What an amendment changes; anything omitted keeps the plan's current value. */
export interface PlanAmendment {
  /** Limit the amendment to these symbols; omitted = every open plan of the book. */
  symbols?: string[];
  /** New stop / take-profit / trailing dials (a posture's policy); omitted = keep the current dials. */
  policy?: PlanDials;
  /** New life in sessions, counted from the ORIGINAL stamp date; omitted = keep the current clock. */
  sessions?: number;
}

/**
 * @description The deliberate "amend plans" action — the ONLY way a stored plan's terms change. Each
 * matching open plan becomes `amended` and a new open row carries the amended terms, priced from the
 * ORIGINAL entry and stamp date, plus the actor and the note. Atomic across the whole batch.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param book - The book whose plans are amended.
 * @param change - What to change.
 * @param actor - Who amended (recorded on every new row).
 * @param note - Why (recorded on every new row).
 * @returns The new open plans.
 */
export async function amendPlans(pool: Pool, sub: string, book: TradingBook, change: PlanAmendment, actor: string, note: string): Promise<PositionPlan[]> {
  await ensurePositionPlansTable(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const symbols = change.symbols?.map((s) => s.toUpperCase()) ?? null;
    const current = (await client.query(
      `SELECT * FROM oshal_trading_position_plans WHERE user_sub = $1 AND book_id = $2 AND status = 'open'
          AND ($3::text[] IS NULL OR symbol = ANY($3::text[])) FOR UPDATE`, [sub, book.bookId, symbols])).rows.map(rowToPlan);
    const amended: PositionPlan[] = [];
    for (const p of current) amended.push(await amendOne(client, sub, book, p, change, actor, note));
    await client.query('COMMIT');
    logger.info({ sub, bookRef: book.ref, actor, count: amended.length }, 'position plans AMENDED (deliberate action)');
    return amended;
  } catch (err) {
    await client.query('ROLLBACK').catch((rbErr) => logger.error({ err: rbErr }, 'position plan amend rollback failed'));
    logger.error({ err, sub, bookRef: book.ref }, 'position plan amend failed — no plan changed');
    throw err;
  } finally {
    client.release();
  }
}

/** Amend one plan inside the caller's transaction: retire the row, insert the amended successor. */
async function amendOne(
  client: PoolClient, sub: string, book: TradingBook, p: PositionPlanRow,
  change: PlanAmendment, actor: string, note: string,
): Promise<PositionPlan> {
  const policy: PlanDials = change.policy ?? {
    posture: p.posture as PlanDials['posture'], stopLossPct: p.stopLossPct, takeProfitPct: p.takeProfitPct,
    trailArmPct: p.trailArmPct, trailGivebackPct: p.trailGivebackPct,
  };
  const t = planTermsFor(policy, p.entryPrice, change.sessions ?? p.sessions, p.stampedSession);
  await client.query(`UPDATE oshal_trading_position_plans SET status = 'amended', closed_at = now() WHERE plan_id = $1 AND user_sub = $2`, [p.planId, sub]);
  const row = (await client.query(
    `INSERT INTO oshal_trading_position_plans (user_sub, mode, book_id, symbol, decision_id, source, posture, entry_price,
       stop_loss_pct, take_profit_pct, trail_arm_pct, trail_giveback_pct, stop_price, take_profit_price, sessions,
       stamped_session, expiry_session, amended_from, amended_by, amend_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::date,$17::date,$18,$19,$20) RETURNING *`,
    [sub, book.kind, book.bookId, p.symbol, p.decisionId, p.source, t.posture, t.entryPrice, t.stopLossPct, t.takeProfitPct,
      t.trailArmPct, t.trailGivebackPct, t.stopPrice, t.takeProfitPrice, t.sessions, t.stampedSession, t.expirySession,
      p.planId, actor.slice(0, 200), note.slice(0, 500)])).rows[0];
  await client.query('UPDATE oshal_trading_position_plans SET superseded_by = $1 WHERE plan_id = $2 AND user_sub = $3', [row.plan_id, p.planId, sub]);
  return rowToPlan(row);
}

/** One plan as an API or the Test Lab reads it. */
export type PositionPlanRow = ReturnType<typeof rowToPlan>;

/**
 * @description A book's plans, newest first — the read an API view or the Test Lab card renders.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param bookId - The book.
 * @param opts - Optional status filter and row limit (default 200, max 1000).
 * @returns The plans.
 */
export async function listPositionPlans(pool: Pool, sub: string, bookId: string, opts: { status?: string; limit?: number } = {}): Promise<PositionPlanRow[]> {
  await ensurePositionPlansTable(pool);
  const limit = Math.max(1, Math.min(1000, Math.round(opts.limit ?? 200)));
  const rows = (await pool.query(
    `SELECT * FROM oshal_trading_position_plans WHERE user_sub = $1 AND book_id = $2 AND ($3::text IS NULL OR status = $3)
      ORDER BY created_at DESC, plan_id LIMIT $4`, [sub, bookId, opts.status ?? null, limit])).rows;
  return rows.map(rowToPlan);
}
