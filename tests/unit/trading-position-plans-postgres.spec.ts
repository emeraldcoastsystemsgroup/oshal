/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the per-position exit-plan TABLE (ADR-052 addendum) against a real PostgreSQL this file owns: the ledger resolves only when armed (knob or mode-aware env); a stamp carries the policy's terms and supersedes the open plan atomically; the terms are IMMUTABLE at the database (the BEFORE UPDATE trigger refuses them, 23514) while status may move; the placeManaged hook stamps a placed buy, ignores a rejected or unpriced one, closes a full exit with its door and leaves a partial trim open; re-underwriting touches only names with an open plan and never a name stamped this fire; the exit split judges a planned position on its stored terms after a posture flip; amendPlans is the audited successor path; every write is scoped to (user_sub, book_id); owner RLS is enforced against a NOSUPERUSER NOBYPASSRLS role.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import crypto from 'crypto';
import { RISK_POLICIES, addSessions, etSessionDate, type Position } from '../../src/features/trading';
import { legacyBook } from '../../src/app/trading-books-store';
import {
  resolvePlanLedger, stampPlan, closeOpenPlan, recordPlanOrder, reunderwritePlans, splitExitsByPlan, amendPlans,
  listPositionPlans, loadOpenPlans, sellDoor, heldCandidates, type PlanLedger,
} from '../../src/app/trading-position-plans';
import type { ConfigOverrideRow } from '../../src/app/trading-config-overrides';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { ensureTradingSpecSchema } from '../helpers/trading-spec-schema';

const RUNTIME_ROLE = 'plans_runtime';
// A PostgreSQL this file owns — nothing to point, nothing to point at. `row_security=off` keeps the
// fixture superuser's reads across the FORCE-RLS table explicit; the RLS case uses RUNTIME_ROLE.
const database = new DisposablePostgres({
  purpose: 'trading-position-plans', database: 'trading_fixture', memory: '384m', max: 4,
  statementTimeoutMs: 60_000, options: '-c row_security=off', roles: [RUNTIME_ROLE],
});
const RUN = crypto.randomUUID().slice(0, 8);
const SUB = `spec-plans-${RUN}`;
const OTHER = `spec-plans-other-${RUN}`;
let pool: Pool;

const PAPER = () => legacyBook(SUB, 'paper');
const ledger = (policy = RISK_POLICIES.balanced, sessions = 20, today = etSessionDate()): PlanLedger =>
  ({ sub: SUB, book: PAPER(), policy, sessions, today, stampedThisFire: new Set() });
const rows = async (symbol: string, sub = SUB) => (await pool.query(
  'SELECT * FROM oshal_trading_position_plans WHERE user_sub = $1 AND symbol = $2 ORDER BY created_at, plan_id', [sub, symbol])).rows;
const pos = (symbol: string, price: number, avg = 100, qty = 10): Position =>
  ({ symbol, qty, avgEntryPrice: avg, currentPrice: price, marketValue: qty * price, unrealizedPl: qty * (price - avg) });
const override = (exitPlanSessions: number | null): ConfigOverrideRow =>
  ({ config: { exitPlanSessions } } as unknown as ConfigOverrideRow);

beforeAll(async () => {
  pool = await database.start();
  await ensureTradingSpecSchema(pool);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE ON oshal_trading_position_plans TO ${RUNTIME_ROLE}`);
}, 240_000);

afterAll(async () => { await database.stop(); }, 120_000);

beforeEach(async () => {
  delete process.env.TRADING_EXIT_PLANS; delete process.env.TRADING_EXIT_PLAN_SESSIONS;
  await pool.query('DELETE FROM oshal_trading_position_plans');
});

describe('the plan ledger resolves only when plans are armed for the book', () => {
  it('OFF by default: no ledger, so every call site is a no-op', () => {
    expect(resolvePlanLedger(SUB, PAPER(), null, RISK_POLICIES.balanced)).toBeNull();
  });
  it('the mode-aware env arms paper only; an applied knob outranks it', () => {
    process.env.TRADING_EXIT_PLANS = 'paper';
    expect(resolvePlanLedger(SUB, PAPER(), null, RISK_POLICIES.balanced)?.sessions).toBe(20);
    expect(resolvePlanLedger(SUB, legacyBook(SUB, 'live'), null, RISK_POLICIES.balanced)).toBeNull();
    expect(resolvePlanLedger(SUB, PAPER(), override(0), RISK_POLICIES.balanced)).toBeNull();
    delete process.env.TRADING_EXIT_PLANS;
    expect(resolvePlanLedger(SUB, legacyBook(SUB, 'live'), override(5), RISK_POLICIES.active)).toMatchObject({ sessions: 5, policy: RISK_POLICIES.active });
  });
});

describe('stamping', () => {
  it('stamps the policy terms at the reference price, and a later buy supersedes atomically', async () => {
    const l = ledger();
    const first = await stampPlan(pool, l, { symbol: 'hota', entryPrice: 50, source: 'scan', decisionId: null });
    const [row] = await rows('HOTA');
    expect(row).toMatchObject({
      plan_id: first, status: 'open', source: 'scan', posture: 'balanced', mode: 'paper', book_id: PAPER().bookId,
      entry_price: '50.0000', stop_price: '45.5000', take_profit_price: '60.0000', sessions: 20,
    });
    expect(row.expiry_session.toISOString().slice(0, 10)).toBe(addSessions(l.today, 20));
    expect(l.stampedThisFire.has('HOTA')).toBe(true);
    const second = await stampPlan(pool, ledger(RISK_POLICIES.active), { symbol: 'HOTA', entryPrice: 55, source: 'rotation', decisionId: null });
    const after = await rows('HOTA');
    expect(after.map((r) => [r.status, r.superseded_by])).toEqual([['superseded', second], ['open', null]]);
    expect(after[1]).toMatchObject({ entry_price: '55.0000', posture: 'active', stop_loss_pct: '5.0000' });
  });

  it('the terms are IMMUTABLE at the database; status may still move', async () => {
    const id = await stampPlan(pool, ledger(), { symbol: 'FRZ', entryPrice: 100, source: 'scan', decisionId: null });
    await expect(pool.query('UPDATE oshal_trading_position_plans SET stop_price = 1 WHERE plan_id = $1', [id]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('UPDATE oshal_trading_position_plans SET stop_loss_pct = 50, expiry_session = expiry_session + 30 WHERE plan_id = $1', [id]))
      .rejects.toMatchObject({ code: '23514' });
    await pool.query("UPDATE oshal_trading_position_plans SET status = 'closed', closed_by_door = 'manual' WHERE plan_id = $1", [id]);
    expect((await rows('FRZ'))[0]).toMatchObject({ status: 'closed', stop_price: '91.0000' });
  });
});

describe('the placeManaged hook (recordPlanOrder)', () => {
  const buy = (symbol: string, price: number | null, source = 'mtf-autopilot') => ({ symbol, side: 'buy' as const, price, source, indicators: {} });
  const sell = (symbol: string, source: string, indicators: unknown = {}) => ({ symbol, side: 'sell' as const, price: null, source, indicators });
  const DEC = () => crypto.randomUUID();

  it('a placed buy stamps under its entry leg and decision; a rejected or unpriced buy stamps nothing', async () => {
    const d1 = DEC();
    await recordPlanOrder(pool, ledger(), d1, buy('HOTA', 50), 'accepted');
    await recordPlanOrder(pool, ledger(), d1, buy('ROT', 20, 'gravity-rotation'), 'accepted');
    await recordPlanOrder(pool, ledger(), DEC(), buy('REJ', 20), 'rejected');
    await recordPlanOrder(pool, ledger(), DEC(), buy('NOPX', null), 'accepted');
    expect((await rows('HOTA'))[0]).toMatchObject({ source: 'scan', decision_id: d1, status: 'open' });
    expect((await rows('ROT'))[0]).toMatchObject({ source: 'rotation' });
    expect(await rows('REJ')).toEqual([]);
    expect(await rows('NOPX')).toEqual([]);
  });

  it('a full exit closes the plan with its door and decision; a partial trim leaves it open', async () => {
    for (const s of ['BRK', 'SIG', 'TRIM', 'CAP', 'EXP']) await stampPlan(pool, ledger(), { symbol: s, entryPrice: 100, source: 'scan', decisionId: null });
    const exitDec = DEC();
    await recordPlanOrder(pool, ledger(), exitDec, sell('BRK', 'mtf-breakdown', { reason: 'breakdown' }), 'accepted', 'breakdown');
    await recordPlanOrder(pool, ledger(), DEC(), sell('SIG', 'mtf-autopilot', { score: -0.4 }), 'accepted');
    await recordPlanOrder(pool, ledger(), DEC(), sell('TRIM', 'gravity-rotation', { reason: 'rotation-trim' }), 'accepted', 'rotation');
    await recordPlanOrder(pool, ledger(), DEC(), sell('CAP', 'risk-exit', { reason: 'cap_trim' }), 'accepted', 'cap_trim');
    await recordPlanOrder(pool, ledger(), DEC(), sell('EXP', 'position-plan', { reason: 'plan-expiry' }), 'rejected', 'plan-expiry');
    expect((await rows('BRK'))[0]).toMatchObject({ status: 'closed', closed_by_door: 'breakdown', closed_decision_id: exitDec });
    expect((await rows('SIG'))[0]).toMatchObject({ status: 'closed', closed_by_door: 'signal' });
    expect((await rows('TRIM'))[0]).toMatchObject({ status: 'open', closed_by_door: null });
    expect((await rows('CAP'))[0]).toMatchObject({ status: 'open' });
    expect((await rows('EXP'))[0]).toMatchObject({ status: 'open' }); // a rejected exit did not end the position
  });

  it('sellDoor prefers the decision\'s own reason, then the journal tag, then "signal" for a technical sell', () => {
    expect(sellDoor({ symbol: 'X', side: 'sell', price: null, source: 'gravity-rotation', indicators: { reason: 'rotation-trim' } }, 'rotation')).toBe('rotation-trim');
    expect(sellDoor({ symbol: 'X', side: 'sell', price: null, source: 'risk-exit', indicators: {} }, 'stop_loss')).toBe('stop_loss');
    expect(sellDoor({ symbol: 'X', side: 'sell', price: null, source: 'mtf-autopilot', indicators: { score: 1 } })).toBe('signal');
  });
});

describe('re-underwriting and the exit split', () => {
  it('re-underwrites only names with an open plan, never one stamped this fire', async () => {
    await stampPlan(pool, ledger(), { symbol: 'OLD', entryPrice: 90, source: 'scan', decisionId: null });
    const fire = ledger();
    await stampPlan(pool, fire, { symbol: 'NEW', entryPrice: 40, source: 'scan', decisionId: null });
    const done = await reunderwritePlans(pool, fire, [
      { symbol: 'OLD', price: 95 }, { symbol: 'NEW', price: 41 }, { symbol: 'NOPLAN', price: 10 }, { symbol: 'OLD', price: null },
    ], 'scan');
    expect(done).toEqual(['OLD']);
    const old = await rows('OLD');
    expect(old.map((r) => [r.status, r.entry_price, r.source])).toEqual([['superseded', '90.0000', 'scan'], ['open', '95.0000', 'scan-reunderwrite']]);
    expect(old[1].decision_id).toBeNull();
    expect((await rows('NEW')).map((r) => r.entry_price)).toEqual(['40.0000']);
    expect(await rows('NOPLAN')).toEqual([]);
  });

  it('heldCandidates keeps held, managed names at their mark', () => {
    const hand = { ...pos('HAND', 10), unmanaged: true };
    expect(heldCandidates([pos('a', 12), pos('b', 5), hand, { ...pos('Z', 3), qty: 0 }], ['A', 'HAND', 'Z'])).toEqual([{ symbol: 'A', price: 12 }]);
  });

  it('a posture flip cannot re-price a stored plan: the split judges the stored terms', async () => {
    await stampPlan(pool, ledger(RISK_POLICIES.balanced), { symbol: 'FLIP', entryPrice: 100, source: 'scan', decisionId: null });
    const flipped = ledger(RISK_POLICIES.active); // the book flipped to a 5% stop after the stamp
    const split = await splitExitsByPlan(pool, flipped, [pos('FLIP', 93), pos('FLOP', 93)], new Map());
    expect(split?.exits).toEqual([]);
    expect(split?.unplanned.map((p) => p.symbol)).toEqual(['FLOP']);
    const [row] = await rows('FLIP');
    expect(row).toMatchObject({ status: 'open', posture: 'balanced', stop_loss_pct: '9.0000' });
  });
});

describe('amendPlans — the ONLY way a stored plan\'s terms change', () => {
  it('retires the plan as `amended` and opens a successor from the ORIGINAL entry and stamp date, with actor and note', async () => {
    const l = ledger(RISK_POLICIES.balanced, 20, '2026-09-01');
    const a = await stampPlan(pool, l, { symbol: 'AMD', entryPrice: 100, source: 'scan', decisionId: null });
    await stampPlan(pool, l, { symbol: 'KEEP', entryPrice: 50, source: 'scan', decisionId: null });
    const out = await amendPlans(pool, SUB, PAPER(), { symbols: ['amd'], policy: RISK_POLICIES.active, sessions: 10 }, 'operator@example', 'tighten after the posture review');
    expect(out).toHaveLength(1);
    const amd = await rows('AMD');
    expect(amd.map((r) => r.status)).toEqual(['amended', 'open']);
    expect(amd[0].superseded_by).toBe(amd[1].plan_id);
    expect(amd[1]).toMatchObject({
      amended_from: a, amended_by: 'operator@example', amend_note: 'tighten after the posture review',
      entry_price: '100.0000', stop_loss_pct: '5.0000', stop_price: '95.0000', sessions: 10, posture: 'active',
    });
    expect(amd[1].stamped_session.toISOString().slice(0, 10)).toBe('2026-09-01');
    expect(amd[1].expiry_session.toISOString().slice(0, 10)).toBe(addSessions('2026-09-01', 10));
    expect((await rows('KEEP')).map((r) => r.status)).toEqual(['open']); // outside the symbol filter
  });
});

describe('scoping — every write is keyed (user_sub, book_id); owner RLS is the wall for route callers', () => {
  it('a ledger never closes, lists or re-underwrites another owner\'s or another book\'s plan', async () => {
    const theirs: PlanLedger = { ...ledger(), sub: OTHER, book: legacyBook(OTHER, 'paper') };
    const liveBook: PlanLedger = { ...ledger(), book: legacyBook(SUB, 'live') };
    await stampPlan(pool, theirs, { symbol: 'SHR', entryPrice: 10, source: 'scan', decisionId: null });
    await stampPlan(pool, liveBook, { symbol: 'SHR', entryPrice: 11, source: 'scan', decisionId: null });
    expect(await closeOpenPlan(pool, ledger(), 'SHR', 'breakdown', crypto.randomUUID())).toBeNull();
    expect(await listPositionPlans(pool, SUB, PAPER().bookId)).toEqual([]);
    expect([...(await loadOpenPlans(pool, SUB, legacyBook(SUB, 'live').bookId)).keys()]).toEqual(['SHR']);
    expect((await rows('SHR', OTHER))[0]).toMatchObject({ status: 'open' });
  });

  it('as a NOSUPERUSER NOBYPASSRLS role, an owner sees and writes only their own plans', async () => {
    await stampPlan(pool, ledger(), { symbol: 'MINE', entryPrice: 10, source: 'scan', decisionId: null });
    await stampPlan(pool, { ...ledger(), sub: OTHER, book: legacyBook(OTHER, 'paper') }, { symbol: 'THEIRS', entryPrice: 10, source: 'scan', decisionId: null });
    const client = await database.rolePool(RUNTIME_ROLE).connect();
    try {
      await client.query("SELECT set_config('oshal.current_sub', $1, false), set_config('oshal.is_operator', 'off', false)", [SUB]);
      const seen = (await client.query('SELECT symbol FROM oshal_trading_position_plans ORDER BY symbol')).rows.map((r) => r.symbol);
      expect(seen).toEqual(['MINE']);
      const updated = await client.query("UPDATE oshal_trading_position_plans SET status = 'closed' WHERE symbol = 'THEIRS'");
      expect(updated.rowCount).toBe(0);
      await expect(client.query(
        `INSERT INTO oshal_trading_position_plans (user_sub, mode, book_id, symbol, source, posture, entry_price, stop_loss_pct,
           take_profit_pct, trail_arm_pct, trail_giveback_pct, stop_price, take_profit_price, sessions, stamped_session, expiry_session)
         VALUES ($1,'paper',$2,'FORGED','scan','balanced',1,9,20,8,4,1,1,20,'2026-09-01','2026-09-29')`,
        [OTHER, legacyBook(OTHER, 'paper').bookId])).rejects.toMatchObject({ code: '42501' });
    } finally {
      client.release();
    }
    expect((await rows('THEIRS', OTHER))[0].status).toBe('open');
  });
});
