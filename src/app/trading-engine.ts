/**
 * Trading ENGINE (ADR-052) — the non-route business core the routes AND the background loops
 * share: the trading-analyst reasoning path (prompt → bot → parsed decision → persisted decision
 * tree), the guarded order executor (placeDecisionOrder — env-level live gate lives HERE,
 * source-guarded by tests/unit/risky-write-guards.spec.ts), the order-row upsert (recordOrder),
 * venue rebind recovery (rebindOrder), and the matured-prediction resolver
 * (resolveMaturedPredictions). Also the engine barrel: re-exports ensureTradingSchema
 * (./trading-schema) and the guardrails/TradingError/SignalRow helpers so the dispatch/reconcile
 * loops import ONE engine module and never the route surface (which carves per ADR-085).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from trading-routes.ts (1000-line cap decomposition): the analyst pipeline (buildDecisionPrompt/parseDecision/runAnalyst/analyzeAndRecordDecision), recordOrder, and rebindOrder (+RebindResult). Code moved verbatim — zero behavior change.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | recordOrder takes an optional createdAt (ISO) written ATOMICALLY in the INSERT (created_at = COALESCE($24::timestamptz, now())). For a historical ledger reconcile of a close that already happened, the row lands with its real trade date in one statement — never a now() value that would pollute the /realized "today" window, and no droppable follow-up UPDATE (an adversarial review flagged the two-step back-date as non-atomic + non-self-healing). ON CONFLICT keeps the back-dated created_at stable on re-run. Live path (no arg) is unchanged.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Moved routes/trading-routes-core.ts → app/trading-engine.ts and made it THE engine module (trading engine extraction, ADR-085 pre-carve): placeDecisionOrder (verbatim from trading-routes.ts, live_blocked gate intact) and resolveMaturedPredictions (verbatim from trading-routes-algo-builders.ts) moved in; ensureTradingSchema + the shared helpers re-exported so the 8 dispatch/reconcile loops depend only on engine modules, never the carvable route surface. Pure code motion — zero behavior change, no order-path/gate/env semantics touched.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Submission reservation: placeDecisionOrder claims the clientOrderId in the ledger (INSERT ... ON CONFLICT DO NOTHING) BEFORE the venue call, refusing the loser of a race with 409 duplicate_submission; any throw before recordOrder releases the still-'submitting' claim. Fixes the 2026-08-18 live twin orders (two same-fire paths shared a minute-bucketed clientOrderId; Alpaca rejects a reused client-order-id server-side but Schwab HAS no client-order-id, so the duplicate placed for real and the recordOrder upsert overwrote the filled row with the rejected twin — three fills vanished from the ledger). recordOrder's conflict branch now also completes qty/order_type/prices/tif/submitted_at, since with a reservation row it is the branch every normal fill takes.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-134 book re-key (PR1): placeDecisionOrder/recordOrder/analyzeAndRecordDecision accept a TradingBook or the legacy mode (normalizing to the legacy book — byte-identical under the flag-off bijection, keeping deployed store twins working). The decision lookup, feed-loop dedup, reservation arbiter, release DELETE, and order upsert all key (user_sub, book_id); mode is still written on every row; the live_blocked gate condition and string are byte-unchanged. rebindOrder preserves a row's own book identity through re-record. bindingOf threads a bound account to the factory, which ignores it while the flag is off.
 *
 * @module trading-engine
 */

import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import {
  getBrokerAdapter, getBrokerReader, liveTradingEnabled, getMarketData, latestPrice,
  tradingSession, isTickStale, maxTickAgeSec,
  type TradingMode, type TradingBook, type OrderResult,
} from '@/features/trading';
import { legacyBook, legacyBookId } from './trading-books-store';
import { resolveUserLlmConnection } from './routes/free-tier-rotation';
import { executeBotOrInline } from './routes/inline-bot-execution';
import { guardrails, guardrailViolation, TradingError, type SignalRow } from './routes/trading-routes-helpers';

/* ── the engine barrel: everything a background loop needs, importable WITHOUT touching the
 * route surface (trading-routes.ts and its builders carve to the app store per ADR-085). */
export { ensureTradingSchema } from './trading-schema';
export { guardrails, TradingError } from './routes/trading-routes-helpers';
export type { Guardrails, SignalRow } from './routes/trading-routes-helpers';

// Same module tag as the route entry file so structured log output is unchanged by the split.
const logger = createChildLogger({ module: 'trading-routes' });

/** The trading-analyst bot — reason-only, runs inline on the api container (claude-code). */
const TRADING_AGENT_ID = 'a0000000-0000-0000-0000-000000000046';
const botClient = new BotNodeClient(createRegistryEndpointResolver());

/* ─── the trading-analyst decision (reasoning on the accountable bot) ──────────── */

/** The structured decision the bot must return. */
interface AnalystDecision {
  action: 'buy' | 'sell' | 'hold';
  symbol: string | null;
  side: 'buy' | 'sell' | null;
  qty: number | null;
  orderType: 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing_stop' | null;
  limitPrice: number | null;
  stopPrice: number | null;
  trailPrice: number | null;
  trailPercent: number | null;
  confidence: number;
  rationale: string;
  indicators: Record<string, unknown>;
}

/**
 * @description Builds the self-contained trading-analyst prompt (the full output contract
 * lives here, not in a loaded persona, so behavior is deterministic — the kid-lens pattern).
 * The signals + account context are embedded. The bot must answer with ONE fenced ```json block.
 * @param signals - The captured signal snapshots to reason over.
 * @param context - Account + guardrail context so the bot proposes a sized, in-bounds trade.
 * @returns The prompt string handed to the trading-analyst bot.
 */
function buildDecisionPrompt(signals: SignalRow[], context: { cash: number; maxQty: number; maxNotionalUsd: number; allowList: string[]; mode: TradingMode }): string {
  return [
    'You are a disciplined equities trading analyst. You are handed one or more market SIGNALS',
    '(a tweet, a news headline, etc.) captured from a live data stream, plus the current account',
    'context. Decide whether the signal warrants a trade, and if so, exactly what trade.',
    '',
    'You produce a DECISION TREE: state the hypothesis (how this specific signal could move a',
    'specific ticker), the indicators you weighed, and your confidence. It is completely fine —',
    'often correct — to decide NOT to trade (action "hold"); a justified non-action is valuable.',
    'Never invent facts not present in the signals.',
    '',
    'You may open LONG or SHORT: "buy" opens/extends a long (or covers a short); "sell" opens/',
    'extends a short (or closes a long). Choose the order TYPE that fits your thesis:',
    '  market         — take liquidity now (omit prices)',
    '  limit          — limitPrice (only fill at your price or better)',
    '  stop           — stopPrice (trigger a market order when price crosses)',
    '  stop_limit     — stopPrice + limitPrice (trigger a limit order)',
    '  trailing_stop  — trailPercent (e.g. 5) OR trailPrice in dollars (a stop that trails price)',
    '',
    `This is the ${context.mode.toUpperCase()} book. Guardrails you MUST respect: max ${context.maxQty} shares,`,
    `max ~$${context.maxNotionalUsd} notional, available cash $${context.cash.toFixed(2)}` +
      (context.allowList.length ? `, allowed symbols: ${context.allowList.join(', ')}` : ', any liquid US equity') + '.',
    '',
    'Answer with EXACTLY ONE fenced json block, nothing else, in this shape (null out price',
    'fields the chosen orderType does not use):',
    '```json',
    '{',
    '  "action": "buy" | "sell" | "hold",',
    '  "symbol": "AAPL" | null,',
    '  "side": "buy" | "sell" | null,',
    '  "qty": number | null,',
    '  "orderType": "market" | "limit" | "stop" | "stop_limit" | "trailing_stop" | null,',
    '  "limitPrice": number | null,',
    '  "stopPrice": number | null,',
    '  "trailPrice": number | null,',
    '  "trailPercent": number | null,',
    '  "confidence": number,            // 0..1',
    '  "rationale": "the decision tree: signal -> hypothesis -> indicators -> conclusion",',
    '  "indicators": { "any": "structured factors you weighed" }',
    '}',
    '```',
    '',
    'SIGNALS (JSON):',
    JSON.stringify(signals.map((s) => ({
      signal_id: s.signal_id, source: s.source, author: s.author, title: s.title,
      body: s.body, url: s.url, symbols: s.symbols, indicators: s.indicators, observed_at: s.observed_at,
    }))),
  ].join('\n');
}

/** Extract the first JSON object from a bot response (fenced or bare). Throws if none parses. */
function parseDecision(text: string): AnalystDecision {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : (text.match(/\{[\s\S]*\}/)?.[0] ?? '');
  const obj = JSON.parse(candidate.trim()) as Partial<AnalystDecision>;
  const action = (obj.action === 'buy' || obj.action === 'sell') ? obj.action : 'hold';
  const TYPES = ['market', 'limit', 'stop', 'stop_limit', 'trailing_stop'] as const;
  const orderType = action === 'hold' ? null
    : (TYPES as readonly string[]).includes(String(obj.orderType)) ? (obj.orderType as AnalystDecision['orderType']) : 'market';
  const num = (v: unknown): number | null => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    action,
    symbol: obj.symbol ? String(obj.symbol).toUpperCase() : null,
    side: action === 'hold' ? null : (obj.side === 'sell' ? 'sell' : 'buy'),
    qty: num(obj.qty),
    orderType,
    limitPrice: num(obj.limitPrice),
    stopPrice: num(obj.stopPrice),
    trailPrice: num(obj.trailPrice),
    trailPercent: num(obj.trailPercent),
    confidence: Number.isFinite(Number(obj.confidence)) ? Math.max(0, Math.min(1, Number(obj.confidence))) : 0,
    rationale: String(obj.rationale || 'No rationale returned.'),
    indicators: (obj.indicators && typeof obj.indicators === 'object') ? obj.indicators as Record<string, unknown> : {},
  };
}

/** Run the trading-analyst bot over the signals. direct+agenticMode → cost auto-recorded. */
async function runAnalyst(ctx: AppContext, sub: string, signals: SignalRow[], context: Parameters<typeof buildDecisionPrompt>[1]): Promise<AnalystDecision> {
  const byoLlmConnection = await resolveUserLlmConnection(ctx.pool, sub);
  const result = await executeBotOrInline(ctx, botClient, TRADING_AGENT_ID, {
    text: buildDecisionPrompt(signals, context), taskId: `trading-${sub}`, workspaceFolderId: `trading-${sub}`,
    agentId: TRADING_AGENT_ID, agenticMode: true, direct: true, userSub: sub, byoLlmConnection,
  });
  return parseDecision(String(result.response || '').trim());
}

/**
 * @description Persist an order row (insert or status update) and return the stored shape.
 * Exported so the reconciliation loop (trading-reconcile.ts) reuses the SAME upsert.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param mode - The book ('paper' | 'live') — the upsert is book-scoped.
 * @param decisionId - The justifying decision (FK — every order is justified).
 * @param clientOrderId - Idempotency key, unique per (user, book).
 * @param r - The broker's order state to persist.
 * @param costBasis - Optional avg entry captured at SELL submit, for realized P&L on fill.
 * @param createdAt - Optional ISO fill datetime for a HISTORICAL row (a ledger reconcile of a close
 *   that already happened). Written atomically in the INSERT so the row never carries a now() value
 *   that would pollute the "today" realized window; null/omitted → now() (the normal live path).
 * @returns Resolves once the row is upserted.
 */
export async function recordOrder(
  pool: AppContext['pool'], sub: string, bookOrMode: TradingBook | TradingMode, decisionId: string, clientOrderId: string, r: OrderResult,
  costBasis?: number, createdAt?: string,
): Promise<void> {
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  const mode = book.kind;
  const cb = costBasis != null && costBasis > 0 ? costBasis : null;
  // Realized P&L per SALE: (fill − cost basis) × filled shares. Computed here when the fill lands with
  // a known cost basis (captured at submit). On reconcile the param is absent, so SQL falls back to the
  // cost_basis already persisted on the row — so a pending→filled sell still gets its realized P&L.
  // SANITY GUARD: ignore a cost basis wildly off the fill (>5× or <0.2×) — that's glitched broker
  // position data (e.g. a bad avg_entry_price), and recording it would inject a bogus huge win/loss.
  const fa = r.filledAvgPrice;
  const saneCb = cb != null && fa != null && fa > 0 && cb >= fa * 0.2 && cb <= fa * 5;
  const realizedInsert = (r.side === 'sell' && saneCb && r.filledQty > 0) ? (fa as number - (cb as number)) * r.filledQty : null;
  await pool.query(
    `INSERT INTO oshal_trading_orders
       (user_sub, mode, book_id, decision_id, broker, broker_order_id, client_order_id, symbol, side, qty,
        order_type, limit_price, stop_price, trail_price, trail_percent, time_in_force,
        status, raw_status, filled_qty, filled_avg_price, reject_reason, submitted_at, cost_basis, realized_pnl,
        created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
             COALESCE($25::timestamptz, now()))
     ON CONFLICT (user_sub, book_id, client_order_id) DO UPDATE SET
       broker_order_id = EXCLUDED.broker_order_id, status = EXCLUDED.status, raw_status = EXCLUDED.raw_status,
       filled_qty = EXCLUDED.filled_qty, filled_avg_price = EXCLUDED.filled_avg_price,
       reject_reason = EXCLUDED.reject_reason,
       -- With the submission reservation, a normal fill's recordOrder always lands on its own
       -- 'submitting' row via this branch — complete the fields the reservation couldn't know yet.
       qty = EXCLUDED.qty, order_type = EXCLUDED.order_type,
       limit_price = EXCLUDED.limit_price, stop_price = EXCLUDED.stop_price,
       trail_price = EXCLUDED.trail_price, trail_percent = EXCLUDED.trail_percent,
       time_in_force = EXCLUDED.time_in_force,
       submitted_at = COALESCE(oshal_trading_orders.submitted_at, EXCLUDED.submitted_at),
       cost_basis = COALESCE(oshal_trading_orders.cost_basis, EXCLUDED.cost_basis),
       -- Keep a historical reconcile row's back-dated created_at stable on re-run (never bump to now()).
       created_at = COALESCE(oshal_trading_orders.created_at, EXCLUDED.created_at),
       realized_pnl = CASE
         WHEN EXCLUDED.side = 'sell' AND EXCLUDED.filled_qty > 0 AND EXCLUDED.filled_avg_price IS NOT NULL
              AND COALESCE(oshal_trading_orders.cost_basis, EXCLUDED.cost_basis)
                  BETWEEN EXCLUDED.filled_avg_price * 0.2 AND EXCLUDED.filled_avg_price * 5
         THEN (EXCLUDED.filled_avg_price - COALESCE(oshal_trading_orders.cost_basis, EXCLUDED.cost_basis)) * EXCLUDED.filled_qty
         ELSE COALESCE(oshal_trading_orders.realized_pnl, EXCLUDED.realized_pnl) END,
       updated_at = now()`,
    [sub, mode, book.bookId, decisionId, r.provider, r.id || null, clientOrderId, r.symbol, r.side, r.qty,
     r.type, r.limitPrice ?? null, r.stopPrice ?? null, r.trailPrice ?? null, r.trailPercent ?? null, r.timeInForce ?? null,
     r.status, r.rawStatus ?? null, r.filledQty, r.filledAvgPrice ?? null,
     r.rejectReason ?? null, r.submittedAt ?? null, cb, realizedInsert, createdAt ?? null]);
}

/** Minutes either side of a row's created_at to search the venue when re-finding its true order. */
const REBIND_WINDOW_MIN = 15;

/** Outcome of a rebind: whether the row's broker id had to be recovered, and the venue's truth. */
export interface RebindResult {
  /** True when the stored broker id was wrong/absent and we bound the row to the real one. */
  rebound: boolean;
  /** The broker id the row carried before (null when it had none). */
  was: string | null;
  /** The broker id the row carries now. */
  brokerOrderId: string;
  /** The venue's current state for that order, as persisted. */
  order: OrderResult;
}

/**
 * @description Re-find an order at its venue and bind the row to the broker id the venue actually
 * used, then persist the venue's state over the row. Recovery for two real failure modes: Schwab
 * returns a new order's id only in a `Location` header (a dropped header leaves the row with no id),
 * and the pre-2026-07-08 cross-book upsert could stamp the OTHER book's id onto a row. Both leave a
 * row that `getOrder` can never resolve, so it strands non-terminal forever and blocks that symbol's
 * future exits. Every field written here comes from the broker — nothing is inferred. If the window
 * does not contain exactly one matching order we refuse rather than bind the wrong trade.
 * @param pool - Postgres pool.
 * @param sub - Owner sub (rows are owner-scoped).
 * @param orderId - Our `oshal_trading_orders.order_id`.
 * @returns What changed, plus the venue's persisted state.
 */
export async function rebindOrder(pool: AppContext['pool'], sub: string, orderId: string): Promise<RebindResult> {
  const row = (await pool.query(
    `SELECT mode, book_id, decision_id, client_order_id, broker_order_id, symbol, side, qty, created_at
       FROM oshal_trading_orders WHERE order_id=$1 AND user_sub=$2`, [orderId, sub])).rows[0];
  if (!row) throw new TradingError(404, 'not_found', 'No such order for this user.');
  const mode = row.mode as TradingMode;
  // ADR-134: preserve the row's OWN book identity through the re-record — a rebind on a non-legacy
  // book must never re-home the row onto the legacy book of its mode — and the reader must bind to
  // that book's ACCOUNT (an unbound reader would search the legacy account's venue history for a
  // non-legacy book's order and either find nothing or bind the wrong trade).
  const rowBook: TradingBook = { ...legacyBook(sub, mode), bookId: row.book_id ? String(row.book_id) : legacyBookId(sub, mode) };
  const loaded = row.book_id ? await import('./trading-books-store.js').then((m) => m.loadBook(pool, sub, String(row.book_id))).catch(() => null) : null;
  const broker = getBrokerReader(mode, sub,
    loaded?.accountNumber ? { accountNumber: loaded.accountNumber, connectionKey: loaded.connectionKey } : undefined); // read-only: rebinding never places or cancels anything
  const was: string | null = row.broker_order_id ? String(row.broker_order_id) : null;

  // Already bound to an id this venue recognizes? Then there is nothing to recover — just resync.
  if (was) {
    try {
      const cur = await broker.getOrder(was);
      await recordOrder(pool, sub, rowBook, String(row.decision_id), String(row.client_order_id), cur);
      return { rebound: false, was, brokerOrderId: was, order: cur };
    } catch { /* id absent, or belongs to the other book — fall through and re-find it */ }
  }

  const t = new Date(row.created_at).getTime();
  const from = new Date(t - REBIND_WINDOW_MIN * 60_000).toISOString();
  const to = new Date(t + REBIND_WINDOW_MIN * 60_000).toISOString();
  const qty = Number(row.qty);
  const symbol = String(row.symbol).toUpperCase();
  const found = (await broker.listOrders(from, to)).filter((o) =>
    o.id && o.symbol.toUpperCase() === symbol && o.side === row.side && Math.abs(o.qty - qty) < 1e-6);
  if (found.length !== 1) {
    throw new TradingError(409, 'rebind_ambiguous',
      `Expected exactly one ${symbol} ${row.side} x${qty} at ${broker.provider} between ${from} and ${to}, found ${found.length}. Refusing to guess which trade this row is.`);
  }
  const truth = found[0];
  // recordOrder's upsert rewrites broker_order_id + the whole fill state from the venue's record.
  await recordOrder(pool, sub, rowBook, String(row.decision_id), String(row.client_order_id), truth);
  logger.warn({ sub, mode, orderId, symbol, was, now: truth.id, status: truth.status, filledQty: truth.filledQty },
    'order rebound to the broker id the venue actually used');
  return { rebound: true, was, brokerOrderId: truth.id, order: truth };
}

/**
 * @description Run the analyst over signals + persist the decision (the /decide core, reused by
 * /trigger + research brain). Carries the 20-minute feed-loop dedup guard.
 * @param ctx - App context.
 * @param sub - Acting user's sub.
 * @param mode - The book ('paper' | 'live').
 * @param signals - The captured signals to reason over.
 * @returns The persisted decision id + creation time + the parsed decision.
 */
export async function analyzeAndRecordDecision(
  ctx: AppContext, sub: string, bookOrMode: TradingBook | TradingMode, signals: SignalRow[],
): Promise<{ decisionId: string; createdAt: string; decision: AnalystDecision }> {
  // ADR-134: a legacy mode normalizes to its legacy book — byte-identical rows under the bijection.
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  const mode = book.kind;
  // Feed-loop guard. The news legs re-grab `recentNews` over a 3-20 min window but fire more often
  // than that window, so consecutive fires hand this function the SAME signal batch. content_hash
  // dedupes the signal ROW, but without this we'd still re-run the LLM analyst on identical content
  // and log a duplicate `hold` every fire (~7 wasted evals per real one). If this exact batch was
  // already decided in the last 20 min, return that decision as a no-op HOLD: no analyst call, no
  // new row, and — because it's a hold — no caller re-places the prior buy/sell. Shared by all three
  // callers (research/fast legs, the /decide endpoint, the autopilot), so the guard can't be bypassed.
  const sigIds = signals.map((s) => s.signal_id).filter(Boolean);
  if (sigIds.length) {
    const prior = (await ctx.pool.query(
      `SELECT decision_id, created_at FROM oshal_trading_decisions
        WHERE user_sub=$1 AND book_id=$2 AND signal_ids = $3::uuid[]
          AND created_at > now() - interval '20 minutes'
        ORDER BY created_at DESC LIMIT 1`,
      [sub, book.bookId, sigIds])).rows[0];
    if (prior) {
      return {
        decisionId: prior.decision_id, createdAt: prior.created_at,
        decision: {
          action: 'hold', symbol: null, side: null, qty: null, orderType: null, limitPrice: null,
          stopPrice: null, trailPrice: null, trailPercent: null, confidence: 0,
          rationale: 'Deduplicated — identical signal batch already decided within 20m (feed-loop guard).',
          indicators: {},
        },
      };
    }
  }
  const g = guardrails();
  // Bind the cash-context reader to the book's account (surface-audit finding 2026-09-03): an
  // unbound reader here sized the analyst's decision against the LEGACY account's cash on a bound
  // book — the third instance of the unbound-reader class after /ledger and /summary.
  const broker = getBrokerReader(mode, sub, bindingOf(book)); // read-only (cash context) — not gated behind live-enable
  let cash = 0;
  try { cash = broker.configured() ? (await broker.getAccount()).cash : 0; } catch { /* account read optional for reasoning */ }
  const decision = await runAnalyst(ctx, sub, signals, { cash, maxQty: g.maxQty, maxNotionalUsd: g.maxNotionalUsd, allowList: g.allowList, mode });
  const row = (await ctx.pool.query(
    `INSERT INTO oshal_trading_decisions
       (user_sub, mode, book_id, signal_ids, agent_id, action, symbol, side, qty, order_type, limit_price,
        stop_price, trail_price, trail_percent, confidence, rationale, indicators, guardrails)
     VALUES ($1,$2,$3,$4::uuid[],$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING decision_id, created_at`,
    [sub, mode, book.bookId, signals.map((s) => s.signal_id), TRADING_AGENT_ID, decision.action, decision.symbol, decision.side,
     decision.qty, decision.orderType, decision.limitPrice, decision.stopPrice, decision.trailPrice, decision.trailPercent,
     decision.confidence, decision.rationale, JSON.stringify(decision.indicators), JSON.stringify(g)])).rows[0];
  return { decisionId: row.decision_id, createdAt: row.created_at, decision };
}

/**
 * @description Place the order a decision proposes (the /orders core, reused by /trigger + the
 * autopilot). Throws TradingError on any refusal (missing decision, hold, live gate, guardrails,
 * unconfigured broker, stale extended-hours quote).
 * @param pool - Postgres pool.
 * @param sub - Acting user's sub.
 * @param bookOrMode - The book (ADR-134), or the legacy mode which normalizes to its legacy book
 *   (store-twin back-compat; byte-identical behavior under the flag-off bijection).
 * @param decisionId - The justifying decision (every order chains back to one).
 * @param requestId - Client idempotency key (becomes part of client_order_id).
 * @param confirm - Explicit live confirm flag — live orders refuse without it.
 * @returns The broker's order state as placed.
 */
/**
 * @description Adapter binding for a book — undefined for legacy/unbound books (env resolution).
 * The FACTORY decides whether to honor it: while TRADING_MULTI_ACCOUNT is off, bindings are
 * ignored entirely (the ADR-134 flag-off byte-parity rule), so passing it unconditionally is safe.
 * @param book - The trading book.
 * @returns The account binding, or undefined for legacy resolution.
 */
function bindingOf(book: TradingBook): { accountNumber: string; connectionKey: string | null } | undefined {
  return book.accountNumber ? { accountNumber: book.accountNumber, connectionKey: book.connectionKey } : undefined;
}

export async function placeDecisionOrder(
  pool: AppContext['pool'], sub: string, bookOrMode: TradingBook | TradingMode, decisionId: string, requestId: string, confirm: boolean,
): Promise<OrderResult> {
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  const mode = book.kind;
  // Book-scoped decision lookup (ADR-134): with two live books an unscoped WHERE would resolve a
  // decision minted for book A while executing on book B — an order justified by the WRONG book's
  // decision, silently breaking the ADR-052 justification chain. Book B executing book A's id → 404.
  const d = (await pool.query(
    `SELECT action, symbol, side, qty, order_type, limit_price, stop_price, trail_price, trail_percent, time_in_force
       FROM oshal_trading_decisions WHERE decision_id=$1 AND user_sub=$2 AND book_id=$3`, [decisionId, sub, book.bookId])).rows[0];
  if (!d) throw new TradingError(404, 'decision_not_found', 'No such decision for this book.');
  if (d.action === 'hold' || !d.symbol || !d.side || !(Number(d.qty) > 0)) {
    throw new TradingError(409, 'not_actionable', 'This decision recommends no trade (hold) or has no sized order.');
  }
  // ADR-134 view-only rule: a DISABLED book exists so its balances/positions are visible — it may
  // reduce risk (sells / protective exits) but must never ADD it. The refusal sits in the engine,
  // not the surface, so no route or schedule path can buy on a book the operator hasn't armed.
  if (!book.enabled && d.side === 'buy') {
    throw new TradingError(409, 'book_disabled', `Book '${book.ref}' is view-only (disabled) — enable it in Accounts & books before buying.`);
  }
  if (mode === 'live' && (!liveTradingEnabled() || confirm !== true)) {
    throw new TradingError(403, 'live_blocked', 'Live orders require TRADING_LIVE_ENABLED=true and an explicit confirm.');
  }
  const TYPES = ['market', 'limit', 'stop', 'stop_limit', 'trailing_stop'] as const;
  const symbol = String(d.symbol).toUpperCase();
  const qty = Number(d.qty);
  const orderType = (TYPES as readonly string[]).includes(String(d.order_type)) ? (d.order_type as typeof TYPES[number]) : 'market';
  const limitPrice = d.limit_price != null ? Number(d.limit_price) : undefined;
  const stopPrice = d.stop_price != null ? Number(d.stop_price) : undefined;
  const trailPrice = d.trail_price != null ? Number(d.trail_price) : undefined;
  const trailPercent = d.trail_percent != null ? Number(d.trail_percent) : undefined;
  const refPrice = limitPrice ?? stopPrice ?? 0;
  const g = guardrails();
  const violation = guardrailViolation(g, symbol, qty, refPrice);
  if (violation) throw new TradingError(422, 'guardrail_blocked', violation);
  const broker = getBrokerAdapter(mode, sub, bindingOf(book));
  if (!broker.configured()) throw new TradingError(503, 'broker_not_configured', `Set the ${mode} broker keys first.`);
  const clientOrderId = `${sub}:${requestId}`.slice(0, 128);

  // SUBMISSION RESERVATION — claim the clientOrderId in the ledger BEFORE any venue work. Two paths
  // in one fire can propose the same (symbol, side) inside the same minute bucket and therefore share
  // a clientOrderId, and the venues split on what that means: Alpaca rejects a reused client-order-id
  // server-side, but Schwab has no client-order-id at all, so a second submit places a REAL duplicate
  // order — and recordOrder's upsert then let the duplicate's result overwrite the first attempt's row
  // (2026-08-18 live: ARKG/ANET/CRWD each filled at Schwab, then the twin's oversold rejection erased
  // the fill from the ledger). The unique index (user_sub, book_id, client_order_id) makes this insert
  // the race arbiter (ADR-134 re-key — the legacy mode index coexists until PR4 and, under the
  // bijection, always agrees): the loser sees zero rows back and refuses before reaching the venue.
  const reserved = await pool.query(
    `INSERT INTO oshal_trading_orders
       (user_sub, mode, book_id, decision_id, broker, client_order_id, symbol, side, qty, order_type,
        status, raw_status, filled_qty, submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'submitting','SUBMITTING',0,now())
     ON CONFLICT (user_sub, book_id, client_order_id) DO NOTHING
     RETURNING order_id`,
    [sub, mode, book.bookId, decisionId, broker.provider, clientOrderId, symbol, d.side, qty, orderType]);
  if (reserved.rows.length === 0) {
    throw new TradingError(409, 'duplicate_submission',
      `An order with idempotency key ${clientOrderId} is already in this book's ledger — refusing a second venue submission.`);
  }

  let result: OrderResult;
  let costBasis: number | undefined;
  try {
    // For a SELL, snapshot the position's avg entry NOW (before it fills/closes) so realized P&L per
    // sale can be computed when the fill lands — the position is gone afterward, so this is the only chance.
    if (d.side === 'sell') {
      try { const pos = (await broker.getPositions()).find((p) => p.symbol.toUpperCase() === symbol && p.qty > 0); if (pos) costBasis = pos.avgEntryPrice; } catch { /* best-effort */ }
    }

    // Pre/post-market routing: Alpaca rejects market orders outside RTH, so when we're in an
    // extended session convert to a MARKETABLE LIMIT (day) with extended_hours. The slippage buffer
    // (TRADING_EXT_LIMIT_SLIPPAGE_PCT, default 0.3%) crosses the wider ext-hours spread to fill.
    //
    // The limit MUST come from a fresh trade. IEX (and Schwab's lastPrice) keep serving the last print
    // long after it happened, so off-hours `latestPrice` can be hours stale with no way to tell. Pricing
    // a "protective" sell off that print puts it wherever the stock USED to be: on 2026-07-07/08 MRNA's
    // exit re-placed 97 times at a frozen 79.54 while the stock walked down to 74.61 — never marketable,
    // never filled, cancel/re-placed every 5-min fire. A tick we cannot date is a tick we cannot price
    // against, so we decline the order rather than place one that only looks like protection. The
    // position then exits on the regular-session market order, which is what actually filled at the open.
    let effType = orderType;
    let effLimit = limitPrice;
    let effTif = d.time_in_force || undefined;
    let extendedHours = false;
    // SCOPE (surface-audit 2026-09-03): this conversion exists because venues reject MARKET orders
    // outside regular hours. It must apply to market orders ONLY — an operator's explicit price point
    // (a GTC limit at $500, a stop, a trailing stop) is already a resting order the venue accepts, and
    // rewriting it into a marketable day limit at last±0.3% would silently turn "only if it drops to
    // $500" into "buy at the open at market". Non-market types pass through exactly as decided.
    if (orderType === 'market' && String(process.env.TRADING_EXTENDED_HOURS ?? 'true').toLowerCase() !== 'false') {
      const session = await tradingSession();
      if (session === 'pre' || session === 'post') {
        // Price off the SAME book's data source (Schwab for live, Alpaca for paper) so the crossing
        // price matches the venue where the order will actually execute.
        const tick = await getMarketData(mode, sub).latestTrade(symbol).catch(() => null);
        if (!tick || isTickStale(tick)) {
          const ageSec = tick ? Math.round((Date.now() - tick.asOf.getTime()) / 1000) : null;
          logger.warn({ sub, mode, symbol, side: d.side, session, tickAgeSec: ageSec, maxTickAgeSec: maxTickAgeSec() },
            'extended-hours order declined — no fresh trade to price the limit against');
          throw new TradingError(409, 'stale_quote',
            `No ${symbol} trade within ${maxTickAgeSec()}s (last: ${ageSec ?? 'none'}s ago) — refusing to price an extended-hours ${d.side} off a stale print.`);
        }
        const slip = Number(process.env.TRADING_EXT_LIMIT_SLIPPAGE_PCT || 0.3) / 100;
        const px = tick.price;
        effType = 'limit';
        effLimit = Math.round((d.side === 'buy' ? px * (1 + slip) : px * (1 - slip)) * 100) / 100;
        effTif = 'day';
        extendedHours = true;
      }
    }
    result = await broker.placeOrder({
      userSub: sub, symbol, side: d.side, qty, type: effType,
      limitPrice: effLimit, stopPrice, trailPrice, trailPercent, timeInForce: effTif, extendedHours, clientOrderId,
    });
  } catch (e) {
    // Nothing was confirmed at the venue — release the claim so a later legitimate retry isn't
    // locked out, keeping the pre-reservation observable behavior (a failed submit records nothing).
    // Scoped to status='submitting' so a row another path already progressed is never destroyed.
    try {
      await pool.query(
        `DELETE FROM oshal_trading_orders WHERE user_sub=$1 AND book_id=$2 AND client_order_id=$3 AND status='submitting'`,
        [sub, book.bookId, clientOrderId]);
    } catch (relErr) {
      logger.error({ err: relErr, sub, mode, bookRef: book.ref, clientOrderId }, 'failed to release order submission reservation');
    }
    throw e;
  }
  await recordOrder(pool, sub, book, decisionId, clientOrderId, result, costBasis);
  return result;
}

/**
 * @description Resolve matured predictions for a book against the live price (updates per-algo hit).
 * @param pool - Postgres pool.
 * @param mode - The book ('paper' | 'live') whose open predictions to resolve.
 * @returns The number of predictions resolved in this sweep.
 */
export async function resolveMaturedPredictions(pool: AppContext['pool'], mode: TradingMode): Promise<number> {
  const open = (await pool.query(
    `SELECT prediction_id, symbol, price, pred_dir FROM oshal_trading_predictions
       WHERE mode=$1 AND resolved=false AND created_at <= now() - ((horizon_hrs || ' hours')::interval) LIMIT 200`, [mode])).rows;
  let n = 0;
  for (const p of open) {
    try {
      const now = await latestPrice(p.symbol); if (now == null) continue;
      const actualDir = now > Number(p.price) ? 'up' : 'down';
      await pool.query(`UPDATE oshal_trading_predictions SET resolved=true, actual_dir=$2, actual_price=$3, hit=$4, resolved_at=now() WHERE prediction_id=$1`,
        [p.prediction_id, actualDir, now, actualDir === p.pred_dir]); n++;
    } catch { /* retry next scan */ }
  }
  return n;
}
