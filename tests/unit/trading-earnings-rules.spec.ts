/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Fix round 4 guards, both against the live Postgres: (a) a rule that has ALREADY SOLD part of a position may never be filed as `no_action` — the partial-then-stale-verdict and partial-then-reaction-rebound paths (the two terminal exits the tranche work did not cover; each used to write status='no_action' unconditionally, leaving 736 of 1000 shares exposed with no alert anywhere) now end `fired_short` with truncated/shortReason and the exposed-share sentence on the timeline; (b) the ambiguous-failure retry is settled with the venue's own order record instead of guessed — a BUY places exactly ONE order per intent no matter how many ambiguous errors it meets, an order the venue turns out to already hold is ADOPTED rather than re-placed (and never adopted twice), and the attempt bound is per RULE, proven by failing across a successful tranche, which used to reset it. Plus the once-only deferral note across an interleaved `halted` entry, and a source pin on the engine's reservation-release DELETE — the fact that makes an ambiguous retry a real second submission.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fix round 3 guards: a sell whose position exceeds what ONE guardrail-capped order may carry is sold in tranches with distinct requestIds and distinct decision rows (and, when the tranche bound is reached, ends saying how many shares remain exposed) — the previous behaviour placed 264 of 1000 shares and called itself `fired`; an UNKNOWN place failure is bounded at TRADING_EARNINGS_RULE_MAX_PLACE_ATTEMPTS and then terminal (it used to re-submit every tick to expiry, and the engine deletes its reservation each time, so on a venue with no client-order-id that is a duplicate-fill path); a 5xx that keeps deferring stands down on TRADING_EARNINGS_RULE_STALE_HOURS instead of trading a day-old verdict; and both "noted once across two ticks" assertions now RE-READ the row (they previously filtered a snapshot captured before the second tick and could not fail).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fix round 2 guards: the fired order is sized so the ENGINE's own notional check passes — the persisted decision row is fed to the REAL guardrailViolation (not restated arithmetic) and a price sweep proves it across the whole cap-bound band, which is what the previous sizing (off the last print, under a higher limit) failed at every cap-bound buy; and a transient 5xx from the order rail defers instead of disarming — the rule stays classified, retries under the SAME requestId, and reuses/reprices its ONE decision row rather than fanning the journal out. Plus: the TRADING_HALT pin asserts the absence of a READ (process.env.TRADING_HALT), not of the string, so a comment cannot turn it red.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-136 D5 earnings-reaction rules against the live oshal Postgres (real FORCE-RLS table, real partial unique index, real signals/decisions ledger rows). Drives the whole state machine with EDGAR, the document read, the analyst and the venue doubled at their seams: armed → detected → classified → fired; expiry never fires (and never polls); a miss sells with the rationale carrying the verdict, the numbers read and the filing URL; a beat buys the sized fraction; the notional ceiling is enforced BY THIS MODULE (the engine skips its notional test for a 0 refPrice, and never reads TRADING_HALT — both pinned from the engine source, which is why both guards live here and are exercised here); TRADING_HALT blocks the order; a position sold out from under a beat ends no_action, not a fresh entry; a disagreeing print waits then stands down; unclear never trades; the flag off does nothing at all. Plus the fundamentals CIK cache: a failed first fetch is NOT cached forever. Run with --no-file-parallelism (concurrent schema bootstrap races).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';
import {
  ensureEventRulesSchema, normalizeEventRule, createEventRule, listEventRules, getEventRule, cancelEventRule,
  deleteEventRule, tickEarningsRules, findNewEarningsFiling, inEarningsWindow, reactionPasses, sizeRuleOrder,
  intendedRuleQty, guardrailCappedQty, marketableLimit, parseEarningsReply, buildEarningsPrompt,
  edgarSubmissionsUrl, edgarDocumentUrl,
  mapVerdictAction, tradingAnalystAgentId, CLASSIFICATION_BASIS, EARNINGS_RULE_AGENT_ID,
  type EarningsRuleDeps, type EventRuleRow,
} from '../../src/app/trading-earnings-rules';
import { lookupCik } from '../../src/features/trading/services/fundamentals';
import { ensureBooksSchema, ensureLegacyBooks, legacyBook } from '../../src/app/trading-books-store';
import { ensureTradingSchema, TradingError, guardrails } from '../../src/app/trading-engine';
// The engine's OWN notional/qty/allowlist check, imported rather than restated: the fired order has
// to survive it, and the only honest way to prove that is to run it on the persisted decision row.
import { guardrailViolation } from '../../src/app/routes/trading-routes-helpers';
import type { AppContext } from '../../src/app/composition/app-context';
import type { OrderResult, Position } from '../../src/features/trading';

// Every case here drives a multi-tick state machine against the LIVE Postgres; the 5 s default is a
// flake, not a signal (the same tick costs milliseconds in production).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const DSN = process.env.OSHAL_TEST_DSN || `postgresql://oshal:oshal@127.0.0.1:${process.env.OSHAL_PG_PORT ?? '55433'}/oshal`;
const RUN = crypto.randomUUID().slice(0, 8);
const SUB = `spec-erule-${RUN}`;
let pool: Pool;
const ctx = () => ({ pool } as unknown as AppContext);
const book = legacyBook(SUB, 'paper');

/* The scenario is anchored on the REAL clock so the fixture never rots: the rule's created_at is now(),
 * the print is expected tomorrow, the 8-K is accepted an hour from now and the leg ticks two hours out. */
const T0 = Date.now();
const ymd = (t: number): string => new Date(t).toISOString().slice(0, 10);
const EXPECTED = ymd(T0 + 86_400_000);
const ACCEPTED = new Date(T0 + 3_600_000).toISOString();
const TICK = new Date(T0 + 2 * 3_600_000);
const EXPIRES = new Date(T0 + 30 * 86_400_000).toISOString();
const CIK = '0000789019';
const DOC_URL = `https://www.sec.gov/Archives/edgar/data/789019/000078901926000101/spec-8k.htm`;

/** EDGAR's parallel `filings.recent` arrays: one 8-K carrying item 2.02, one older 8-K that does not. */
const submissions = (acceptedAt = ACCEPTED) => ({
  cik: '789019',
  filings: {
    recent: {
      accessionNumber: ['0000789019-26-000101', '0000789019-26-000090'],
      filingDate: [ymd(Date.parse(acceptedAt)), ymd(T0 - 40 * 86_400_000)],
      acceptanceDateTime: [acceptedAt, new Date(T0 - 40 * 86_400_000).toISOString()],
      form: ['8-K', '8-K'],
      items: ['2.02,9.01', '5.02'],
      primaryDocument: ['spec-8k.htm', 'spec-old.htm'],
    },
  },
});

const REPLY = (verdict: string) => '```json\n' + JSON.stringify({
  verdict, revenue: { current: '$70.1B', priorYear: '$62.0B', pct: '+13.1%' }, eps: { current: '$3.30', priorYear: '$2.99' },
  guidance: { prior: '$68-69B', comparison: 'above the top of its own prior range' }, rationale: 'Filed numbers versus the prior-year quarter.',
}) + '\n```';

/** One row of the venue's OWN order record, as listOrders returns it. */
const venueOrder = (over: Partial<OrderResult>): OrderResult => ({
  id: 'venue-1', clientOrderId: 'cid', status: 'accepted', symbol: 'X', side: 'sell', qty: 1,
  type: 'limit', filledQty: 0, provider: 'alpaca', mode: 'paper', ...over,
} as OrderResult);

interface Harness {
  deps: (over?: Partial<EarningsRuleDeps>) => EarningsRuleDeps;
  calls: { edgar: number; doc: number; analyst: number; venue: number; place: Array<{ decisionId: string; requestId: string }>; prompts: string[] };
  positions: Position[];
  setPrint: (p: number | null) => void;
  setRefusal: (e: Error | null) => void;
  setNow: (d: Date) => void;
  /** What the venue's order record says when an ambiguous submission is settled (default: nothing landed). */
  setVenue: (orders: OrderResult[]) => void;
}

function harness(opts: { held?: number; refPrice?: number; verdict?: string; subs?: unknown } = {}): Harness {
  const calls = { edgar: 0, doc: 0, analyst: 0, venue: 0, place: [] as Array<{ decisionId: string; requestId: string }>, prompts: [] as string[] };
  const positions: Position[] = opts.held === 0 ? [] : [{
    symbol: 'PLACEHOLDER', qty: opts.held ?? 100, avgEntryPrice: 100,
    marketValue: (opts.held ?? 100) * (opts.refPrice ?? 200), unrealizedPl: 0, currentPrice: opts.refPrice ?? 200,
  }];
  let print: number | null = null;
  let refuse: Error | null = null;
  let now = TICK;
  let venue: OrderResult[] = [];
  const deps = (over: Partial<EarningsRuleDeps> = {}): EarningsRuleDeps => ({
    now: () => now,
    session: async () => 'regular',
    fetchText: async () => { calls.doc += 1; return 'Contoso reports quarterly revenue of $70.1 billion, up from $62.0 billion.'; },
    latestTrade: async () => print == null ? null : { price: print, asOf: now },
    place: (async (_p: unknown, _s: string, _b: unknown, decisionId: string, requestId: string): Promise<OrderResult> => {
      calls.place.push({ decisionId, requestId });
      if (refuse) throw refuse;
      return { id: `o-${calls.place.length}`, clientOrderId: requestId, status: 'accepted', symbol: 'X', side: 'sell', qty: 1, type: 'limit', filledQty: 0 } as unknown as OrderResult;
    }) as unknown as EarningsRuleDeps['place'],
    positions: async () => positions,
    listOrders: async () => { calls.venue += 1; return venue; },
    edgarJson: async () => { calls.edgar += 1; return opts.subs ?? submissions(); },
    calendarDaysToEarnings: async () => null,
    lookupCik: async () => CIK,
    analyst: async (_c, _s, prompt) => { calls.analyst += 1; calls.prompts.push(prompt); return REPLY(opts.verdict ?? 'miss'); },
    ...over,
  });
  return { deps, calls, positions, setPrint: (p) => { print = p; }, setRefusal: (e) => { refuse = e; }, setNow: (d) => { now = d; }, setVenue: (o) => { venue = o; } };
}

/** Arm a rule for one symbol and point the harness's fake position at it. */
async function arm(h: Harness, symbol: string, over: Record<string, unknown> = {}): Promise<EventRuleRow> {
  if (h.positions[0]) h.positions[0].symbol = symbol;
  const rule = normalizeEventRule({ symbol, expiresAt: EXPIRES, expectedAt: EXPECTED, ...over });
  return createEventRule(pool as never, SUB, { book, rule });
}

beforeAll(async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || `spec-secret-${RUN}`;
  process.env.TRADING_MAX_NOTIONAL_USD = '50000'; process.env.TRADING_MAX_QTY = '100000';
  delete process.env.TRADING_SYMBOL_ALLOWLIST; delete process.env.TRADING_HALT;
  process.env.TRADING_EARNINGS_RULES = 'true';
  delete process.env.TRADING_EARNINGS_RULE_REACTION_PCT; delete process.env.TRADING_EARNINGS_RULE_ACT_WINDOW_MIN;
  delete process.env.TRADING_EARNINGS_RULE_WINDOW_BEFORE_DAYS; delete process.env.TRADING_EARNINGS_RULE_WINDOW_AFTER_DAYS;
  delete process.env.TRADING_EARNINGS_RULE_MAX_TRANCHES; delete process.env.TRADING_EARNINGS_RULE_MAX_PLACE_ATTEMPTS;
  delete process.env.TRADING_EARNINGS_RULE_STALE_HOURS; delete process.env.TRADING_EARNINGS_RULE_MAX_DOC_ATTEMPTS;
  pool = new Pool({ connectionString: DSN, max: 4, options: '-c row_security=off' });
  try { await pool.query('SELECT 1'); } catch (error) {
    throw new Error(`trading-earnings-rules requires the live oshal Postgres at ${DSN.replace(/:[^:@/]+@/, ':***@')} — bring the stack up with \`bash scripts/oshal-up.sh\` (cause: ${(error as Error).message})`);
  }
  await ensureBooksSchema(pool as never); await ensureTradingSchema(pool as never); await ensureEventRulesSchema(pool as never);
  await pool.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_app') THEN EXECUTE 'ALTER TABLE oshal_trading_event_rules OWNER TO oshal_app'; END IF; END $$;`);
  await ensureLegacyBooks(pool as never, SUB);
}, 120_000);

afterAll(async () => {
  for (const t of ['oshal_trading_event_rules', 'oshal_trading_orders', 'oshal_trading_decisions', 'oshal_trading_signals', 'oshal_trading_books']) {
    await pool.query(`DELETE FROM ${t} WHERE user_sub = $1`, [SUB]).catch(() => {});
  }
  await pool.end();
});

describe('the CIK lookup never caches a FAILED EDGAR fetch (fundamentals.ts, the poisoned-cache bug)', () => {
  it('a first fetch that fails returns null and is not remembered; the next call succeeds and IS cached', async () => {
    const real = globalThis.fetch;
    try {
      globalThis.fetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
      expect(await lookupCik('MSFT')).toBeNull();                       // outage
      globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ '0': { cik_str: 789019, ticker: 'MSFT' } }) })) as unknown as typeof fetch;
      expect(await lookupCik('MSFT')).toBe(CIK);                        // recovered without a process restart
      expect(await lookupCik('msft')).toBe(CIK);                        // case-insensitive
      globalThis.fetch = (async () => { throw new Error('EDGAR down'); }) as unknown as typeof fetch;
      expect(await lookupCik('MSFT')).toBe(CIK);                        // the good map is still cached
      expect(await lookupCik('NOTATICKER')).toBeNull();
    } finally { globalThis.fetch = real; }
  });
});

describe('the two guards the ENGINE does not apply for this order shape (why they live in the rule)', () => {
  const engine = readFileSync(path.resolve(__dirname, '../../src/app/trading-engine.ts'), 'utf8');
  const helpers = readFileSync(path.resolve(__dirname, '../../src/app/routes/trading-routes-helpers.ts'), 'utf8');
  const rules = readFileSync(path.resolve(__dirname, '../../src/app/trading-earnings-rules.ts'), 'utf8');

  it('placeDecisionOrder never reads TRADING_HALT — so the rule must, and does', () => {
    expect(engine).not.toMatch(/process\.env\.TRADING_HALT/);   // a mention in a COMMENT must not turn this red
    expect(rules).toContain("String(process.env.TRADING_HALT ?? '').toLowerCase() === 'true'");
  });

  it('the engine skips the notional check when refPrice is 0 (a MARKET order) — so the rule sizes itself and fires a marketable LIMIT', () => {
    expect(engine).toContain('const refPrice = limitPrice ?? stopPrice ?? 0;');
    expect(helpers).toContain('if (refPrice > 0 && notional > g.maxNotionalUsd) {');
    expect(rules).toContain("order_type, limit_price, time_in_force, confidence");
  });

  it("'event-rule' is deliberately NOT operator-authored: a beat→buy on a view-only book is refused by the engine", () => {
    expect(engine).toContain("const operatorAuthored = d.agent_id === 'operator' || d.agent_id === 'pinned-lot' || d.agent_id === 'event-playbook';");
    expect(engine).not.toContain(EARNINGS_RULE_AGENT_ID);
  });

  it('the engine RELEASES its reservation when a submit throws — which is why an ambiguous retry re-submits for real, and why the rule asks the VENUE instead of guessing', () => {
    // This is the premise of the whole ambiguous-failure design. The module comment says a retry under
    // the same requestId is NOT a no-op; that claim is only worth anything if it is pinned to the code.
    expect(engine).toContain("DELETE FROM oshal_trading_orders WHERE user_sub=$1 AND book_id=$2 AND client_order_id=$3 AND status='submitting'");
    expect(rules).toContain('deps.listOrders(book, sub,');
  });

  it('the analyst identity is DERIVED from the active registry, not a third hand-typed UUID', () => {
    const id = tradingAnalystAgentId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(engine).toContain(`const TRADING_AGENT_ID = '${id}';`);
    expect(rules).not.toContain(id);
  });
});

describe('pure helpers', () => {
  it('finds only a NEW 8-K carrying item 2.02, newest first, and builds the archive URL', () => {
    const f = findNewEarningsFiling(submissions(), new Date(T0).toISOString(), CIK);
    expect(f).toMatchObject({ form: '8-K', accession: '0000789019-26-000101', items: '2.02,9.01', url: DOC_URL });
    expect(findNewEarningsFiling(submissions(), new Date(T0 + 2 * 3_600_000).toISOString(), CIK)).toBeNull();  // already seen
    expect(findNewEarningsFiling({}, new Date(0).toISOString(), CIK)).toBeNull();
    expect(edgarSubmissionsUrl(CIK)).toBe('https://data.sec.gov/submissions/CIK0000789019.json');
    expect(edgarDocumentUrl(CIK, '0000789019-26-000101', 'spec-8k.htm')).toBe(DOC_URL);
  });

  it('the window opens on the expected date ± the knobs, or on the calendar', () => {
    expect(inEarningsWindow({ expectedAt: EXPECTED }, TICK, null)).toBe(true);
    expect(inEarningsWindow({ expectedAt: ymd(T0 + 40 * 86_400_000) }, TICK, null)).toBe(false);
    expect(inEarningsWindow({ expectedAt: null }, TICK, null)).toBe(false);
    expect(inEarningsWindow({ expectedAt: null }, TICK, 1)).toBe(true);
    expect(inEarningsWindow({ expectedAt: null }, TICK, 5)).toBe(false);
  });

  it('the reaction gate wants the print to agree with the verdict; 0 disables it', () => {
    expect(reactionPasses('beat', 200, 210, 0.5)).toBe(true);
    expect(reactionPasses('beat', 200, 199, 0.5)).toBe(false);
    expect(reactionPasses('miss', 200, 190, 0.5)).toBe(true);
    expect(reactionPasses('miss', 200, 201, 0.5)).toBe(false);
    expect(reactionPasses('inline', 200, 200, 0.5)).toBe(true);
    expect(reactionPasses('beat', 200, 199, 0)).toBe(true);
  });

  it('sizes in whole shares and enforces the notional ceiling ITSELF (the engine will not for a market order)', () => {
    const g = guardrails();
    expect(g).toMatchObject({ maxNotionalUsd: 50_000, maxQty: 100_000 });
    expect(sizeRuleOrder({ mode: 'pct_of_position', value: 100 }, 100, 190, g, 100)).toBe(100);
    expect(sizeRuleOrder({ mode: 'pct_of_position', value: 25 }, 100, 210, g, null)).toBe(25);
    expect(sizeRuleOrder({ mode: 'pct_of_position', value: 100 }, 1000, 200, g, null)).toBe(250);   // $50,000 / $200
    expect(sizeRuleOrder({ mode: 'shares', value: 40 }, 10, 100, g, 10)).toBe(10);                  // a sell caps at held
    expect(sizeRuleOrder({ mode: 'notional', value: 10_000 }, 100, 200, g, null)).toBe(50);
    expect(sizeRuleOrder({ mode: 'pct_of_position', value: 100 }, 0, 200, g, 0)).toBe(0);
    expect(marketableLimit('buy', 200)).toBe(201);
    expect(marketableLimit('sell', 200)).toBe(199);
  });

  it('separates the operator INTENT from what one guardrail-capped order may carry (a truncated sell must be visible, not silent)', () => {
    const g = guardrails();
    // "Sell 100% of 1000 shares" MEANS 1000 shares. The guardrails cap ONE order at 264 of them at a
    // $189.05 limit — the difference is the exposure a silent truncation would leave behind.
    expect(intendedRuleQty({ mode: 'pct_of_position', value: 100 }, 1000, 189.05, 1000)).toBe(1000);
    expect(guardrailCappedQty(1000, 189.05, g)).toBe(264);                 // floor($50,000 / $189.05)
    expect(sizeRuleOrder({ mode: 'pct_of_position', value: 100 }, 1000, 189.05, g, 1000)).toBe(264);
    expect(guardrailViolation(g, 'MSFT', 1000, 189.05)).toMatch(/exceeds the max/);   // the engine agrees
    expect(guardrailViolation(g, 'MSFT', 264, 189.05)).toBeNull();
    // …and the fleet SHARE cap binds the same way, which is the shape the deployed defaults have.
    process.env.TRADING_MAX_QTY = '100';
    try { expect(guardrailCappedQty(1000, 189.05, guardrails())).toBe(100); }
    finally { process.env.TRADING_MAX_QTY = '100000'; }
  });

  it("the sizing the rule fires with survives the ENGINE's own notional check at every cap-bound price", () => {
    // The engine re-checks with refPrice = limit_price. Sizing off the last print (the lower number for
    // a buy) put qty x limit OVER the ceiling for most cap-bound prices — 422 guardrail_blocked, which
    // for a rule is terminal. Size at the limit and the two checks agree. Swept, not argued.
    const g = guardrails();
    const unsized: number[] = [];
    for (let price = 5; price <= 1000; price += 5) {
      for (const side of ['buy', 'sell'] as const) {
        const limit = marketableLimit(side, price);
        const qty = sizeRuleOrder({ mode: 'pct_of_position', value: 100 }, 100_000, limit, g, null);
        if (qty < 1) { unsized.push(price); continue; }
        expect(guardrailViolation(g, 'MSFT', qty, limit)).toBeNull();
      }
    }
    expect(unsized).toEqual([]);
    // And the fix is load-bearing: the OLD basis (size off the print, fire at the limit) is refused.
    const oldQty = sizeRuleOrder({ mode: 'pct_of_position', value: 100 }, 100_000, 210, g, null);
    expect(guardrailViolation(g, 'NVDA', oldQty, marketableLimit('buy', 210))).toMatch(/exceeds the max/);
  });

  it("an unreadable analyst reply is 'unclear', which maps to hold — an unread filing is never a trade", () => {
    expect(parseEarningsReply('I could not open the document.').verdict).toBe('unclear');
    expect(parseEarningsReply(REPLY('beat'))).toMatchObject({ verdict: 'beat', revenue: { current: '$70.1B', priorYear: '$62.0B' } });
    expect(mapVerdictAction({ onBeat: 'buy', onMiss: 'sell', onInline: 'hold', classification: parseEarningsReply('nonsense') })).toBe('hold');
    expect(buildEarningsPrompt('MSFT', { form: '8-K', accession: 'a', acceptedAt: ACCEPTED, filedDate: EXPECTED, items: '2.02', url: DOC_URL }, 'text'))
      .toContain(CLASSIFICATION_BASIS);
  });

  it('refuses a bad symbol, a rule that can never act, and a bad expiry; defaults the sizing', () => {
    expect(() => normalizeEventRule({ symbol: '.X', expiresAt: EXPIRES })).toThrow(/ticker symbol/);
    expect(() => normalizeEventRule({ symbol: 'MSFT', expiresAt: EXPIRES, onBeat: 'hold', onMiss: 'hold', onInline: 'hold' })).toThrow(/never do anything/);
    expect(() => normalizeEventRule({ symbol: 'MSFT', expiresAt: new Date(T0 - 1000).toISOString() })).toThrow(/expiry in the future/);
    expect(() => normalizeEventRule({ symbol: 'MSFT', expiresAt: new Date(T0 + 200 * 86_400_000).toISOString() })).toThrow(/more than 120 days/);
    expect(normalizeEventRule({ symbol: 'msft', expiresAt: EXPIRES })).toMatchObject({ symbol: 'MSFT', onBeat: 'buy', onMiss: 'sell', onInline: 'hold', sizing: { mode: 'pct_of_position', value: 25 } });
    expect(normalizeEventRule({ symbol: 'MSFT', expiresAt: EXPIRES, onBeat: 'hold' }).sizing).toEqual({ mode: 'pct_of_position', value: 100 });
  });
});

describe('the rule store — a FORCE-RLS table with one active rule per book + symbol', () => {
  it('is FORCE-RLS with an owner policy on user_sub', async () => {
    const t = (await pool.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'oshal_trading_event_rules'`)).rows[0];
    expect(t).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    expect((await pool.query(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'oshal_trading_event_rules'`)).rows[0].n).toBeGreaterThan(0);
  });

  it('refuses a second ACTIVE rule for the same book + symbol, and allows one again after a cancel', async () => {
    const h = harness();
    const first = await arm(h, 'CSCO');
    await expect(arm(h, 'CSCO')).rejects.toThrow(/already an active earnings rule/);
    await cancelEventRule(pool as never, SUB, first.ruleId);
    const again = await arm(h, 'CSCO');
    expect(again.status).toBe('armed');
    expect((await listEventRules(pool as never, SUB, { bookId: book.bookId })).filter((r) => r.symbol === 'CSCO').length).toBe(2);
    await expect(cancelEventRule(pool as never, SUB, first.ruleId)).rejects.toThrow(/already cancelled/);
    await expect(deleteEventRule(pool as never, SUB, again.ruleId)).rejects.toThrow(/cancel it first/);
    await cancelEventRule(pool as never, SUB, again.ruleId);
    expect(await deleteEventRule(pool as never, SUB, again.ruleId)).toBe(true);
  });
});

describe('the state machine — armed → detected → classified → fired, through the ONE order path', () => {
  it('a MISS sells: one place() call with one requestId, an event-rule decision, and a rationale carrying the verdict, the numbers and the filing URL', async () => {
    const h = harness({ verdict: 'miss', held: 100, refPrice: 200 });
    const rule = await arm(h, 'MSFT', { onMiss: 'sell', sizing: { mode: 'pct_of_position', value: 100 } });

    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:detected`);
    const detected = await getEventRule(pool as never, SUB, rule.ruleId);
    expect(detected).toMatchObject({ status: 'detected', cik: CIK });
    expect(detected?.filing?.url).toBe(DOC_URL);
    expect(detected?.reaction).toMatchObject({ refPrice: 200 });

    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:classified`);
    expect(h.calls.analyst).toBe(1);
    expect(h.calls.prompts[0]).toContain(CLASSIFICATION_BASIS);
    expect((await getEventRule(pool as never, SUB, rule.ruleId))?.classification).toMatchObject({ verdict: 'miss' });

    h.setPrint(190);                                                     // −5%: the market agrees with the miss
    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:fired`);
    expect(h.calls.place).toEqual([{ decisionId: expect.any(String), requestId: `erule-${rule.ruleId.slice(0, 8)}` }]);
    const fired = await getEventRule(pool as never, SUB, rule.ruleId);
    expect(fired).toMatchObject({ status: 'fired' });
    expect(fired?.order).toMatchObject({ targetQty: 100, placedQty: 100, truncated: false });
    expect(fired?.order?.tranches).toEqual([{ n: 1, id: 'o-1', status: 'accepted', qty: 100, limitPrice: 189.05, at: expect.any(String) }]);

    const d = (await pool.query('SELECT * FROM oshal_trading_decisions WHERE decision_id = $1', [fired?.decisionId])).rows[0];
    expect(d).toMatchObject({ agent_id: EARNINGS_RULE_AGENT_ID, action: 'sell', side: 'sell', symbol: 'MSFT', order_type: 'limit', book_id: book.bookId });
    expect(Number(d.qty)).toBe(100);
    expect(Number(d.limit_price)).toBe(189.05);
    expect(guardrailViolation(guardrails(), d.symbol, Number(d.qty), Number(d.limit_price))).toBeNull();
    expect(d.rationale).toContain('MISS');
    expect(d.rationale).toContain('$70.1B');
    expect(d.rationale).toContain('$62.0B');
    expect(d.rationale).toContain(DOC_URL);
    expect(d.rationale).toContain(CLASSIFICATION_BASIS);
    const s = (await pool.query('SELECT * FROM oshal_trading_signals WHERE signal_id = $1', [d.signal_ids[0]])).rows[0];
    expect(s).toMatchObject({ source: EARNINGS_RULE_AGENT_ID, url: DOC_URL, book_id: book.bookId });

    const after = await tickEarningsRules(ctx(), SUB, h.deps());          // terminal: never fires twice
    expect(after.processed).toBe(0);
    expect(h.calls.place.length).toBe(1);
  });

  it('a BEAT buys the sized fraction, capped by the $50,000 notional ceiling THIS MODULE applies', async () => {
    const h = harness({ verdict: 'beat', held: 1000, refPrice: 200 });
    const rule = await arm(h, 'NVDA', { onBeat: 'buy', sizing: { mode: 'pct_of_position', value: 100 } });
    await tickEarningsRules(ctx(), SUB, h.deps());                        // detected
    await tickEarningsRules(ctx(), SUB, h.deps());                        // classified
    h.setPrint(210);                                                      // +5%: the market agrees with the beat
    // Short of the intent, so the terminal is `fired_short`, never a bare `fired`: the status alone has
    // to tell an operator scanning a list that this rule did not do all of what it was armed to do.
    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:fired_short`);
    const fired = await getEventRule(pool as never, SUB, rule.ruleId);
    expect(fired?.status).toBe('fired_short');
    const d = (await pool.query('SELECT * FROM oshal_trading_decisions WHERE decision_id = $1', [fired?.decisionId])).rows[0];
    expect(Number(d.qty)).toBe(236);                                      // floor($50,000 / $211.05) — the LIMIT, not the $210 print, and not 1000 shares
    expect(d.side).toBe('buy');
    expect(Number(d.limit_price)).toBe(211.05);
    // The whole point of the marketable limit is that the engine re-checks the ceiling. Run ITS check
    // on the row we actually persisted: sized off the print this was 238 x 211.05 = $50,229.90 and the
    // engine refused every cap-bound beat with a terminal 422.
    expect(Number(d.qty) * Number(d.limit_price)).toBeLessThanOrEqual(guardrails().maxNotionalUsd);
    expect(guardrailViolation(guardrails(), d.symbol, Number(d.qty), Number(d.limit_price))).toBeNull();
    // A BUY does not tranche (a rule that kept buying over ticks would surprise the operator), so the
    // cap ends it — but it is RECORDED as short of the intent, in the row, the timeline and the rationale.
    expect(fired?.order).toMatchObject({ targetQty: 1000, placedQty: 236, truncated: true, shortReason: 'guardrail_cap' });
    expect(fired?.timeline.at(-1)?.detail).toContain('TRUNCATED');
    expect(fired?.timeline.at(-1)?.detail).toContain('764 shares were NOT bought');
    expect(d.rationale).toContain('GUARDRAIL-TRUNCATED');
  });

  it('TRADING_HALT stops the order the engine would have placed — the panic button is honoured here or nowhere', async () => {
    const h = harness({ verdict: 'miss', held: 100, refPrice: 200 });
    const rule = await arm(h, 'AMD', { onMiss: 'sell' });
    await tickEarningsRules(ctx(), SUB, h.deps());
    await tickEarningsRules(ctx(), SUB, h.deps());
    h.setPrint(190);
    process.env.TRADING_HALT = 'true';
    try {
      const out = await tickEarningsRules(ctx(), SUB, h.deps());
      expect(out.transitions).not.toContain(`${rule.ruleId}:fired`);
      expect(h.calls.place.length).toBe(0);
      const held = await getEventRule(pool as never, SUB, rule.ruleId);
      expect(held?.status).toBe('classified');
      expect(held?.timeline.at(-1)).toMatchObject({ event: 'halted' });
    } finally { delete process.env.TRADING_HALT; }
    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:fired`);
  });

  it('a BEAT on a name that is no longer held ends no_action — the rule never opens a fresh position', async () => {
    const h = harness({ verdict: 'beat', held: 100, refPrice: 200 });
    const rule = await arm(h, 'ORCL', { onBeat: 'buy' });
    await tickEarningsRules(ctx(), SUB, h.deps());
    await tickEarningsRules(ctx(), SUB, h.deps());
    h.setPrint(210);
    h.positions.length = 0;                                               // the autopilot / earnings blackout sold it
    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:no_action`);
    expect(h.calls.place.length).toBe(0);
    expect((await getEventRule(pool as never, SUB, rule.ruleId))?.timeline.at(-1)?.detail).toContain('no longer held');
  });

  it('a print that disagrees waits, then stands down at the act window — no order either way', async () => {
    const h = harness({ verdict: 'miss', held: 100, refPrice: 200 });
    const rule = await arm(h, 'ADBE', { onMiss: 'sell' });
    await tickEarningsRules(ctx(), SUB, h.deps());
    await tickEarningsRules(ctx(), SUB, h.deps());
    h.setPrint(201);                                                      // up, against the miss
    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toEqual([]);
    expect((await getEventRule(pool as never, SUB, rule.ruleId))?.timeline.at(-1)).toMatchObject({ event: 'reaction_disagrees' });
    h.setNow(new Date(TICK.getTime() + 91 * 60_000));                     // past TRADING_EARNINGS_RULE_ACT_WINDOW_MIN
    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:no_action`);
    expect(h.calls.place.length).toBe(0);
  });

  it("an 'unclear' read never trades", async () => {
    const h = harness({ verdict: 'garbled', held: 100, refPrice: 200 });
    const rule = await arm(h, 'INTC');
    await tickEarningsRules(ctx(), SUB, h.deps());
    await tickEarningsRules(ctx(), SUB, h.deps());
    h.setPrint(150);
    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:no_action`);
    expect(h.calls.place.length).toBe(0);
    expect((await getEventRule(pool as never, SUB, rule.ruleId))?.timeline.at(-1)?.detail).toContain('could not be read into a verdict');
  });

  it('a TRANSIENT 5xx (a broker-token blip) DEFERS — the protective sell keeps its action, retries under the same requestId, and reuses its one decision row', async () => {
    const h = harness({ verdict: 'miss', held: 100, refPrice: 200 });
    const rule = await arm(h, 'PFE', { onMiss: 'sell', sizing: { mode: 'pct_of_position', value: 100 } });
    await tickEarningsRules(ctx(), SUB, h.deps());                        // detected
    await tickEarningsRules(ctx(), SUB, h.deps());                        // classified
    h.setPrint(190);
    // Both 5xx the order path can raise (broker_not_configured, settlement_unknown) are thrown BEFORE
    // any venue submission and release the reservation — so nothing was placed and a retry is safe.
    h.setRefusal(new TradingError(503, 'broker_not_configured', 'Set the live broker keys first.'));
    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toEqual([]);
    const deferred = await getEventRule(pool as never, SUB, rule.ruleId);
    expect(deferred?.status).toBe('classified');                          // NOT 'error' — the sell is still armed
    expect(deferred?.timeline.at(-1)).toMatchObject({ event: 'place_deferred' });
    expect(deferred?.timeline.at(-1)?.detail).toContain('broker_not_configured');
    await tickEarningsRules(ctx(), SUB, h.deps());                        // still down: noted once, not per tick
    const deferredTwice = await getEventRule(pool as never, SUB, rule.ruleId);   // RE-READ: the row, not the snapshot
    expect(deferredTwice?.timeline.filter((t) => t.event === 'place_deferred').length).toBe(1);
    expect(deferredTwice?.order).toMatchObject({ deferrals: 2, placedQty: 0 });  // both attempts counted

    h.setRefusal(null);                                                   // the token refreshes
    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:fired`);
    const fired = await getEventRule(pool as never, SUB, rule.ruleId);
    expect(fired?.status).toBe('fired');
    expect(new Set(h.calls.place.map((c) => c.requestId))).toEqual(new Set([`erule-${rule.ruleId.slice(0, 8)}`]));
    expect(new Set(h.calls.place.map((c) => c.decisionId)).size).toBe(1);  // one decision, repriced — not one per tick
    const n = await pool.query(`SELECT count(*)::int AS n FROM oshal_trading_decisions WHERE user_sub = $1 AND indicators->>'ruleId' = $2`, [SUB, rule.ruleId]);
    expect(n.rows[0].n).toBe(1);
    const sig = await pool.query(`SELECT count(*)::int AS n FROM oshal_trading_signals WHERE user_sub = $1 AND indicators->>'ruleId' = $2`, [SUB, rule.ruleId]);
    expect(sig.rows[0].n).toBe(1);
  });

  it('an engine refusal (a view-only book refusing an event-rule buy) is terminal — no retry loop', async () => {
    const h = harness({ verdict: 'miss', held: 100, refPrice: 200 });
    const rule = await arm(h, 'CRM', { onMiss: 'sell' });
    await tickEarningsRules(ctx(), SUB, h.deps());
    await tickEarningsRules(ctx(), SUB, h.deps());
    h.setPrint(190);
    h.setRefusal(new TradingError(409, 'book_disabled', "Book 'live' is view-only for the autopilot"));   // 4xx: a decision about THIS order
    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:error`);
    h.setRefusal(null);
    await tickEarningsRules(ctx(), SUB, h.deps());
    expect(h.calls.place.length).toBe(1);
    expect((await getEventRule(pool as never, SUB, rule.ruleId))?.timeline.at(-1)?.detail).toContain('book_disabled');
  });
});

describe('a protective sell bigger than one guardrail-capped order (the deployed caps are $1,000 / 100 shares)', () => {
  it('sells in TRANCHES rather than placing 5 of 1000 shares and calling itself fired', async () => {
    const h = harness({ verdict: 'miss', held: 1000, refPrice: 200 });
    const rule = await arm(h, 'BAC', { onMiss: 'sell', sizing: { mode: 'pct_of_position', value: 100 } });
    await tickEarningsRules(ctx(), SUB, h.deps());                        // detected
    await tickEarningsRules(ctx(), SUB, h.deps());                        // classified
    h.setPrint(190);                                                      // limit 189.05 → 264 shares per order
    process.env.TRADING_EARNINGS_RULE_MAX_TRANCHES = '2';
    try {
      // Tranche 1: the rule stays ACTIVE and says why. Selling 264 of 1000 and going terminal would
      // leave 736 shares exposed on a miss with no kernel re-arm path — the failure this case pins.
      expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:partial`);
      const partial = await getEventRule(pool as never, SUB, rule.ruleId);
      expect(partial?.status).toBe('classified');
      expect(partial?.order).toMatchObject({ targetQty: 1000, placedQty: 264, truncated: false });
      expect(partial?.timeline.at(-1)).toMatchObject({ event: 'partial' });
      expect(partial?.timeline.at(-1)?.detail).toContain('remaining 736');

      // Tranche 2 is a DISTINCT order and needs a distinct requestId, or the engine's reservation
      // arbiter would no-op the rest of the sell.
      expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:fired_short`);
      const done = await getEventRule(pool as never, SUB, rule.ruleId);
      expect(done?.status).toBe('fired_short');
      expect(h.calls.place.map((c) => c.requestId)).toEqual([`erule-${rule.ruleId.slice(0, 8)}`, `erule-${rule.ruleId.slice(0, 8)}-2`]);
      expect(new Set(h.calls.place.map((c) => c.decisionId)).size).toBe(2);
      expect(done?.order).toMatchObject({ targetQty: 1000, placedQty: 528, truncated: true, shortReason: 'tranche_bound' });
      // The tranche bound is reached, so the rule ends SHORT — and says so in the words an operator
      // reading the timeline needs: how many shares are still exposed.
      expect(done?.timeline.at(-1)?.detail).toContain('472 shares were NOT sold and remain exposed');

      // Every order the rule actually placed survives the engine's own check, and the rationale on the
      // ledger row states the truncation (so the journal never shows a sell that looks whole).
      const rows = (await pool.query(`SELECT * FROM oshal_trading_decisions WHERE user_sub = $1 AND indicators->>'ruleId' = $2 ORDER BY created_at`, [SUB, rule.ruleId])).rows;
      expect(rows.length).toBe(2);
      for (const d of rows) {
        expect(Number(d.qty)).toBe(264);
        expect(guardrailViolation(guardrails(), d.symbol, Number(d.qty), Number(d.limit_price))).toBeNull();
        expect(d.rationale).toContain('GUARDRAIL-TRUNCATED');
      }
      expect(rows[0].rationale).toContain('the remaining 736 are placed on the following ticks');
    } finally { delete process.env.TRADING_EARNINGS_RULE_MAX_TRANCHES; }
  });
});

describe('a rule that already MOVED SHARES may never be filed as though nothing happened', () => {
  /** Tranche 1 of a 1000-share protective exit: 264 placed, the rule stays `classified`, 736 owed. */
  async function halfSold(symbol: string): Promise<{ h: Harness; rule: EventRuleRow }> {
    const h = harness({ verdict: 'miss', held: 1000, refPrice: 200 });
    const rule = await arm(h, symbol, { onMiss: 'sell', sizing: { mode: 'pct_of_position', value: 100 } });
    await tickEarningsRules(ctx(), SUB, h.deps());                        // detected
    await tickEarningsRules(ctx(), SUB, h.deps());                        // classified
    h.setPrint(190);                                                      // limit 189.05 → 264 per order
    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:partial`);
    expect((await getEventRule(pool as never, SUB, rule.ruleId))?.order).toMatchObject({ placedQty: 264, targetQty: 1000 });
    return { h, rule };
  }

  it('a STALE verdict closes a half-sold rule `fired_short`, naming the shares still exposed — not `no_action`', async () => {
    const { h, rule } = await halfSold('WFC');
    // The stand-down itself is right (a day-old read is not a reason to trade). What was wrong is that
    // it wrote status='no_action' without ever looking at order.placedQty: 264 shares had already been
    // sold, 736 were still exposed, and the row said the rule owed nothing.
    h.setNow(new Date(TICK.getTime() + 25 * 3_600_000));                  // past TRADING_EARNINGS_RULE_STALE_HOURS
    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:fired_short`);
    const done = await getEventRule(pool as never, SUB, rule.ruleId);
    expect(done?.status).toBe('fired_short');
    expect(done?.status).not.toBe('no_action');
    expect(done?.order).toMatchObject({ targetQty: 1000, placedQty: 264, truncated: true, shortReason: 'stale_verdict' });
    expect(done?.timeline.at(-1)?.detail).toContain('736 shares were NOT sold and remain exposed');
    expect(done?.timeline.at(-1)?.detail).toContain('stale verdict');
    expect(h.calls.place.length).toBe(1);                                 // it stood down; it did not sell more
  });

  it('a REBOUND past the act window closes a half-sold rule `fired_short` too — the second silent exit', async () => {
    const { h, rule } = await halfSold('GS');
    h.setPrint(202);                                                      // back above the detection ref: the miss no longer confirms
    h.setNow(new Date(TICK.getTime() + 91 * 60_000));                     // past TRADING_EARNINGS_RULE_ACT_WINDOW_MIN
    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:fired_short`);
    const done = await getEventRule(pool as never, SUB, rule.ruleId);
    expect(done?.status).toBe('fired_short');
    expect(done?.order).toMatchObject({ targetQty: 1000, placedQty: 264, truncated: true, shortReason: 'reaction_faded' });
    expect(done?.timeline.at(-1)?.detail).toContain('736 shares were NOT sold and remain exposed');
    expect(h.calls.place.length).toBe(1);
  });

  it('a rule that never placed anything still ends plainly `no_action` — the honest status is not being widened', async () => {
    const h = harness({ verdict: 'miss', held: 100, refPrice: 200 });
    const rule = await arm(h, 'UPS', { onMiss: 'sell' });
    await tickEarningsRules(ctx(), SUB, h.deps());
    await tickEarningsRules(ctx(), SUB, h.deps());
    h.setPrint(201);                                                      // never confirms
    await tickEarningsRules(ctx(), SUB, h.deps());
    h.setNow(new Date(TICK.getTime() + 91 * 60_000));
    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:no_action`);
    const done = await getEventRule(pool as never, SUB, rule.ruleId);
    expect(done?.status).toBe('no_action');
    expect(done?.order?.placedQty ?? 0).toBe(0);
    expect(h.calls.place.length).toBe(0);
  });
});

describe('a place failure the venue may have accepted is bounded, not retried forever', () => {
  it('an UNKNOWN error (a broker adapter throwing a plain Error) retries TRADING_EARNINGS_RULE_MAX_PLACE_ATTEMPTS times, then stops loudly', async () => {
    const h = harness({ verdict: 'miss', held: 100, refPrice: 200 });
    const rule = await arm(h, 'KO', { onMiss: 'sell' });
    await tickEarningsRules(ctx(), SUB, h.deps());
    await tickEarningsRules(ctx(), SUB, h.deps());
    h.setPrint(190);
    // schwab-broker-adapter throws `new Error('schwab place order 500 …')`, not a TradingError — and the
    // engine DELETES its status='submitting' reservation on the way out, so a retry re-submits. Schwab
    // has no client-order-id, so an unbounded retry loop is how one rule becomes several real fills.
    h.setRefusal(new Error('schwab place order 500 gateway timeout'));
    process.env.TRADING_EARNINGS_RULE_MAX_PLACE_ATTEMPTS = '3';
    try {
      expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toEqual([]);
      const first = await getEventRule(pool as never, SUB, rule.ruleId);
      expect(first?.status).toBe('classified');
      expect(first?.timeline.at(-1)).toMatchObject({ event: 'place_failed' });
      expect(first?.timeline.at(-1)?.detail).toContain('attempt 1 of 3');
      expect(first?.order).toMatchObject({ attempts: 1, placedQty: 0 });

      await tickEarningsRules(ctx(), SUB, h.deps());                      // attempt 2
      expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:error`);
      const stopped = await getEventRule(pool as never, SUB, rule.ruleId);
      expect(stopped?.status).toBe('error');
      expect(stopped?.order).toMatchObject({ attempts: 3 });
      expect(stopped?.timeline.at(-1)?.detail).toContain('CHECK THE ACCOUNT');
      expect(h.calls.place.length).toBe(3);

      h.setRefusal(null);
      await tickEarningsRules(ctx(), SUB, h.deps());                      // terminal: no fourth submission
      expect(h.calls.place.length).toBe(3);
    } finally { delete process.env.TRADING_EARNINGS_RULE_MAX_PLACE_ATTEMPTS; }
  });

  it('a BUY places exactly ONE order per intent no matter how many ambiguous errors it meets', async () => {
    const h = harness({ verdict: 'beat', held: 1000, refPrice: 200 });
    const rule = await arm(h, 'LLY', { onBeat: 'buy', sizing: { mode: 'pct_of_position', value: 100 } });
    await tickEarningsRules(ctx(), SUB, h.deps());
    await tickEarningsRules(ctx(), SUB, h.deps());
    h.setPrint(210);
    // The old code retried ANY non-TradingError up to the attempt bound, on either side — so this made
    // three real submissions for one intent at a venue that ignores clientOrderId. A duplicate BUY
    // costs capital nobody asked for, and this module does not repeat buys at all.
    h.setRefusal(new Error('schwab place order 500 gateway timeout'));
    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:error`);
    expect(h.calls.place.length).toBe(1);                                 // one submission, ever
    expect(h.calls.venue).toBe(1);                                        // and it asked the venue before deciding
    const stopped = await getEventRule(pool as never, SUB, rule.ruleId);
    expect(stopped?.status).toBe('error');
    expect(stopped?.order).toMatchObject({ attempts: 1, placedQty: 0 });
    expect(stopped?.timeline.at(-1)?.detail).toContain('never re-places a BUY');
    expect(stopped?.timeline.at(-1)?.detail).toContain('CHECK THE ACCOUNT');
    h.setRefusal(null);
    await tickEarningsRules(ctx(), SUB, h.deps());                        // terminal: no second submission
    expect(h.calls.place.length).toBe(1);
  });

  it("when the venue turns out to ALREADY HOLD the ambiguous order it is adopted, never placed a second time — and never adopted twice", async () => {
    const h = harness({ verdict: 'miss', held: 1000, refPrice: 200 });
    const rule = await arm(h, 'MRK', { onMiss: 'sell', sizing: { mode: 'pct_of_position', value: 100 } });
    await tickEarningsRules(ctx(), SUB, h.deps());
    await tickEarningsRules(ctx(), SUB, h.deps());
    h.setPrint(190);                                                      // limit 189.05 → 264 per order
    // The adapter throws AFTER the venue accepted (a hangup on the response). placeDecisionOrder's catch
    // then DELETES its status='submitting' reservation, so a retry would submit for REAL — and Schwab
    // ignores clientOrderId (2026-08-18). The venue's own record is the only thing that separates
    // "never landed" from "already working", so the rule reads it instead of guessing.
    h.setRefusal(new Error('socket hang up'));
    h.setVenue([venueOrder({ id: 'venue-777', symbol: 'MRK', side: 'sell', qty: 264, status: 'accepted' })]);
    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:partial`);
    expect(h.calls.place.length).toBe(1);                                 // the second order was ADOPTED, not sent
    const adopted = await getEventRule(pool as never, SUB, rule.ruleId);
    expect(adopted?.order).toMatchObject({ placedQty: 264, targetQty: 1000, attempts: 1 });
    expect(adopted?.order?.tranches).toEqual([{ n: 1, id: 'venue-777', status: 'accepted', qty: 264, limitPrice: 189.05, at: expect.any(String), adopted: true }]);
    expect(adopted?.timeline.at(-1)?.detail).toContain('ADOPTED');
    // The next tranche fails ambiguously too, and the venue still shows only the order the rule already
    // knows about: a tranched sell places identically-sized orders, so its OWN tranche must not read as
    // a mystery duplicate — it is excluded by id, the window reads empty, and nothing is double-counted.
    await tickEarningsRules(ctx(), SUB, h.deps());
    const after = await getEventRule(pool as never, SUB, rule.ruleId);
    expect(after?.order).toMatchObject({ placedQty: 264, attempts: 2 });  // NOT 528
    expect(after?.order?.tranches.length).toBe(1);
    expect(after?.status).toBe('classified');
  });

  it('the ambiguous-failure bound is per RULE — a successful tranche does not hand it a fresh set of attempts', async () => {
    const h = harness({ verdict: 'miss', held: 1000, refPrice: 200 });
    const rule = await arm(h, 'CVX', { onMiss: 'sell', sizing: { mode: 'pct_of_position', value: 100 } });
    await tickEarningsRules(ctx(), SUB, h.deps());
    await tickEarningsRules(ctx(), SUB, h.deps());
    h.setPrint(190);
    process.env.TRADING_EARNINGS_RULE_MAX_PLACE_ATTEMPTS = '2';
    try {
      h.setRefusal(new Error('schwab place order 500 gateway timeout'));  // ambiguous #1
      await tickEarningsRules(ctx(), SUB, h.deps());                      // the venue is empty → a SELL may retry
      expect((await getEventRule(pool as never, SUB, rule.ruleId))?.order).toMatchObject({ attempts: 1, placedQty: 0 });

      h.setRefusal(null);
      expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:partial`);
      // `order.attempts = 0` on a successful tranche multiplied the bound by the tranche count: five
      // tranches x three attempts = fifteen chances to double-fill under one rule.
      expect((await getEventRule(pool as never, SUB, rule.ruleId))?.order).toMatchObject({ attempts: 1, placedQty: 264 });

      h.setRefusal(new Error('schwab place order 500 gateway timeout'));  // ambiguous #2 = the bound
      expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:error`);
      const stopped = await getEventRule(pool as never, SUB, rule.ruleId);
      expect(stopped?.status).toBe('error');
      expect(stopped?.order).toMatchObject({ attempts: 2, placedQty: 264, truncated: true, shortReason: 'venue_ambiguous' });
      expect(stopped?.timeline.at(-1)?.detail).toContain('736 shares were NOT sold and remain exposed');
      expect(h.calls.place.length).toBe(3);
      h.setRefusal(null);
      await tickEarningsRules(ctx(), SUB, h.deps());                      // terminal
      expect(h.calls.place.length).toBe(3);
    } finally { delete process.env.TRADING_EARNINGS_RULE_MAX_PLACE_ATTEMPTS; }
  });

  it('the once-only deferral note survives an INTERLEAVED timeline entry (it used to compare only the last one)', async () => {
    const h = harness({ verdict: 'miss', held: 100, refPrice: 200 });
    const rule = await arm(h, 'T', { onMiss: 'sell' });
    await tickEarningsRules(ctx(), SUB, h.deps());
    await tickEarningsRules(ctx(), SUB, h.deps());
    h.setPrint(190);
    h.setRefusal(new TradingError(503, 'broker_not_configured', 'Set the live broker keys first.'));
    await tickEarningsRules(ctx(), SUB, h.deps());                        // place_deferred
    process.env.TRADING_HALT = 'true';
    try { await tickEarningsRules(ctx(), SUB, h.deps()); } finally { delete process.env.TRADING_HALT; }   // 'halted' lands in between
    await tickEarningsRules(ctx(), SUB, h.deps());                        // deferred again — must not re-note
    const r = await getEventRule(pool as never, SUB, rule.ruleId);
    expect(r?.timeline.filter((t) => t.event === 'place_deferred').length).toBe(1);
    expect(r?.timeline.filter((t) => t.event === 'halted').length).toBe(1);
    expect(r?.order).toMatchObject({ deferrals: 2, placedQty: 0 });
    expect(r?.status).toBe('classified');                                 // still armed to sell
  });

  it('a 5xx that keeps deferring does not retry to the rule expiry — a stale verdict stands down instead', async () => {
    const h = harness({ verdict: 'miss', held: 100, refPrice: 200 });
    const rule = await arm(h, 'XOM', { onMiss: 'sell' });
    await tickEarningsRules(ctx(), SUB, h.deps());
    await tickEarningsRules(ctx(), SUB, h.deps());
    h.setPrint(190);
    h.setRefusal(new TradingError(503, 'settlement_unknown', 'The account could not be read.'));
    await tickEarningsRules(ctx(), SUB, h.deps());
    expect((await getEventRule(pool as never, SUB, rule.ruleId))?.status).toBe('classified');
    h.setNow(new Date(TICK.getTime() + 25 * 3_600_000));                  // past TRADING_EARNINGS_RULE_STALE_HOURS
    h.setRefusal(null);                                                   // the rail is back — but the read is a day old
    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:no_action`);
    expect(h.calls.place.length).toBe(1);                                 // only the refused attempt
    expect((await getEventRule(pool as never, SUB, rule.ruleId))?.timeline.at(-1)?.detail).toContain('stale verdict');
  });
});

describe('the watcher never spends a read it does not owe', () => {
  it('a symbol that is not held polls nothing and stays armed', async () => {
    const h = harness({ held: 100, refPrice: 200 });
    const rule = await arm(h, 'TSLA');
    h.positions[0].symbol = 'SOMETHINGELSE';
    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toEqual([]);
    expect(h.calls.edgar).toBe(0);
    const r = await getEventRule(pool as never, SUB, rule.ruleId);
    expect(r?.status).toBe('armed');
    expect(r?.timeline.at(-1)).toMatchObject({ event: 'not_held' });
    await tickEarningsRules(ctx(), SUB, h.deps());
    const again = await getEventRule(pool as never, SUB, rule.ruleId);          // RE-READ: the row, not the snapshot
    expect(again?.timeline.filter((t) => t.event === 'not_held').length).toBe(1);   // noted once, not every tick
  });

  it('a rule outside its earnings window polls nothing', async () => {
    const h = harness({ held: 100, refPrice: 200 });
    await arm(h, 'AAPL', { expectedAt: ymd(T0 + 40 * 86_400_000) });
    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toEqual([]);
    expect(h.calls.edgar).toBe(0);
  });

  it('an EXPIRED rule expires without polling EDGAR or placing, even with a matching filing waiting', async () => {
    const h = harness({ held: 100, refPrice: 200 });
    const rule = await arm(h, 'IBM', { expiresAt: new Date(T0 + 120_000).toISOString() });
    if (h.positions[0]) h.positions[0].symbol = 'IBM';
    expect((await tickEarningsRules(ctx(), SUB, h.deps())).transitions).toContain(`${rule.ruleId}:expired`);
    expect(h.calls.edgar).toBe(0);
    expect(h.calls.place.length).toBe(0);
    expect((await getEventRule(pool as never, SUB, rule.ruleId))?.status).toBe('expired');
  });

  it('TRADING_EARNINGS_RULES=false does nothing at all — no rows read, no EDGAR, no model call', async () => {
    const h = harness({ held: 100, refPrice: 200 });
    await arm(h, 'QCOM');
    process.env.TRADING_EARNINGS_RULES = 'false';
    try {
      expect(await tickEarningsRules(ctx(), SUB, h.deps())).toEqual({ processed: 0, transitions: [] });
      expect(h.calls.edgar + h.calls.analyst + h.calls.doc + h.calls.place.length).toBe(0);
    } finally { process.env.TRADING_EARNINGS_RULES = 'true'; }
  });

  it('the analyst budget bounds a busy earnings morning to TRADING_EARNINGS_RULE_MAX_LLM_PER_TICK reads', async () => {
    const h = harness({ verdict: 'inline', held: 100, refPrice: 200 });
    const syms = ['GOOG', 'META', 'AMZN', 'NFLX'];
    const rules = [];
    for (const s of syms) rules.push(await arm(h, s));
    h.positions.length = 0;
    for (const s of syms) h.positions.push({ symbol: s, qty: 100, avgEntryPrice: 100, marketValue: 20_000, unrealizedPl: 0, currentPrice: 200 });
    process.env.TRADING_EARNINGS_RULE_MAX_LLM_PER_TICK = '2';
    try {
      await tickEarningsRules(ctx(), SUB, h.deps());                      // all four → detected
      await tickEarningsRules(ctx(), SUB, h.deps());                      // only two may read the model
      expect(h.calls.analyst).toBe(2);
    } finally { delete process.env.TRADING_EARNINGS_RULE_MAX_LLM_PER_TICK; }
  });
});
