/**
 * Trading research brain — news + fundamentals → the trading-analyst LLM → a portfolio-gated trade.
 *
 * The technical autopilot (trading-schedule-dispatch.ts) trades trends. THIS path is the analyst that
 * reads the world: on a schedule it pulls fresh market news (Alpaca news API), pairs it with the
 * company's fundamentals (SEC EDGAR), and hands both to the accountable `trading-analyst` LLM bot,
 * which reasons a justified buy/sell/hold (ADR-052 signal→decision→order provenance). The portfolio
 * money-manager then sizes the decision against the book before any paper order is placed.
 *
 * Two cadences share this code:
 *  - `trading-research:<sub>`  — every ~15 min, a wider freshness window, top few news-heavy names.
 *  - `trading-fast:<sub>`      — every ~1-2 min, only items <~3 min old, reacting quickly to breaking
 *    headlines. Honest scope: this rides the CONTINUATION of a move (tens of seconds to minutes), it
 *    does not and cannot beat HFT to the first-tick spike.
 *
 * PAPER-ONLY (refuses live), market-hours-gated, and bounded to a few LLM calls per fire to cap cost.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — fresh-news capture + EDGAR fundamentals → trading-analyst LLM decision → portfolio-sized paper order; shared research (15m) + fast (1-2m) cadences; paper-only, market-gated, LLM-call-bounded.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Protect the book: analyze HELD names with fresh news before buy-hunting so the analyst can sell them on materially negative headlines (the news-driven exit). Previously only the most news-heavy names were analyzed, always hunting buys — held positions never got a protective look.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Trading engine extraction (ADR-085 pre-carve): import repoint only — analyzeAndRecordDecision/placeDecisionOrder/ensureTradingSchema/SignalRow now come from app/trading-engine.ts instead of the carvable route surface. Zero behavior change.
 *
 * @module trading-research-dispatch
 */

import type { AppContext } from './composition-root';
import type { ScheduleRecord, ScheduleDispatchResult } from '@/features/scheduling';
import {
  getBrokerAdapter, marketDataConfigured, tradableSession, recentNews, fundamentalsSummary,
  latestPrice, riskPolicy, sizeEntry, DEFAULT_UNIVERSE,
  type Position, type BrokerAccount, type TradingMode, type NewsItem,
} from '@/features/trading';
import { analyzeAndRecordDecision, placeDecisionOrder, ensureTradingSchema, type SignalRow } from './trading-engine';
import { loadInFlight } from './trading-schedule-dispatch';
import { createWorldIntelligenceService, type WorldIntelligenceService } from '@/features/world-data';
import { readWorldSignals, worldSignalsEnabled } from './trading-world-signals';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'trading-research-dispatch' });

/** @description True for the research-brain schedules (research + fast). */
export function isResearchSchedule(taskType: string): boolean {
  return taskType.startsWith('trading-research') || taskType.startsWith('trading-fast');
}
/** @description The per-user research / fast schedule taskTypes. */
export function researchTaskType(sub: string): string { return `trading-research:${sub}`; }
export function fastTaskType(sub: string): string { return `trading-fast:${sub}`; }

/** Cap LLM analyst calls per fire (cost bound). */
const MAX_ANALYST_CALLS = { research: 4, fast: 2 } as const;

/** Insert one combined news signal + an optional fundamentals signal (+ optional world signal) for a
 *  symbol; return the rows. The world row (TRADING_WORLD_SIGNALS) hands the analyst the smart-money /
 *  sentiment basket so it reasons over insider+congress buying, sentiment momentum, short interest, etc. */
async function captureSignals(pool: AppContext['pool'], sub: string, mode: TradingMode, symbol: string, news: NewsItem[], worldSvc: WorldIntelligenceService | null = null): Promise<SignalRow[]> {
  const top = news.slice(0, 6);
  const body = top.map((n) => `• ${n.headline}${n.summary ? ` — ${n.summary.slice(0, 200)}` : ''} (${n.source})`).join('\n');
  const rows: SignalRow[] = [];
  const newsRow = (await pool.query(
    `INSERT INTO oshal_trading_signals (user_sub, mode, source, author, url, title, body, symbols, indicators, content_hash)
       VALUES ($1,$2,'news',$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (user_sub, mode, content_hash) DO UPDATE SET observed_at = oshal_trading_signals.observed_at
     RETURNING signal_id, source, author, title, body, url, symbols, indicators, observed_at`,
    [sub, mode, top[0]?.source || null, top[0]?.url || null, top[0]?.headline?.slice(0, 200) || `${symbol} news`, body, [symbol],
     JSON.stringify({ count: news.length, ids: top.map((n) => n.id) }), `news:${symbol}:${top.map((n) => n.id).join('-')}`])).rows[0];
  rows.push(newsRow as SignalRow);

  const fundamentals = await fundamentalsSummary(symbol);
  if (fundamentals) {
    const fRow = (await pool.query(
      `INSERT INTO oshal_trading_signals (user_sub, mode, source, title, body, symbols, indicators, content_hash)
         VALUES ($1,$2,'fundamentals',$3,$4,$5,$6,$7)
       ON CONFLICT (user_sub, mode, content_hash) DO UPDATE SET observed_at = oshal_trading_signals.observed_at
       RETURNING signal_id, source, author, title, body, url, symbols, indicators, observed_at`,
      [sub, mode, `${symbol} fundamentals`, fundamentals.summary, [symbol], JSON.stringify(fundamentals),
       `fund:${symbol}:${fundamentals.fiscalYear}`])).rows[0];
    rows.push(fRow as SignalRow);
  }

  // World-intelligence basket (TRADING_WORLD_SIGNALS) — smart-money + sentiment the analyst can weigh.
  // Hour-bucketed content_hash so it refreshes each fire without spamming duplicate rows.
  if (worldSvc) {
    const w = await readWorldSignals(worldSvc, symbol).catch(() => null);
    if (w && w.score != null) {
      const bucket = new Date().toISOString().slice(0, 13);
      const wRow = (await pool.query(
        `INSERT INTO oshal_trading_signals (user_sub, mode, source, title, body, symbols, indicators, content_hash)
           VALUES ($1,$2,'world',$3,$4,$5,$6,$7)
         ON CONFLICT (user_sub, mode, content_hash) DO UPDATE SET observed_at = oshal_trading_signals.observed_at
         RETURNING signal_id, source, author, title, body, url, symbols, indicators, observed_at`,
        [sub, mode, `${symbol} world signals`, w.summary, [symbol],
         JSON.stringify({ blended: w.score, ...w.metrics }), `world:${symbol}:${bucket}`])).rows[0];
      rows.push(wRow as SignalRow);
    }
  }
  return rows;
}

/** Override a decision's qty (portfolio sizing wins over the analyst's proposed size). */
async function setDecisionQty(pool: AppContext['pool'], decisionId: string, qty: number): Promise<void> {
  await pool.query('UPDATE oshal_trading_decisions SET qty=$2 WHERE decision_id=$1', [decisionId, qty]);
}

/** Reason over one symbol's news+fundamentals, size, and place a paper order. Returns a result note. */
async function analyzeSymbol(
  ctx: AppContext, sub: string, mode: TradingMode, symbol: string, news: NewsItem[],
  account: BrokerAccount, positions: Position[], inFlight: Set<string>, extHours: boolean,
  worldSvc: WorldIntelligenceService | null = null,
): Promise<{ symbol: string; action: string; placed: boolean; note: string }> {
  const signals = await captureSignals(ctx.pool, sub, mode, symbol, news, worldSvc);
  const { decisionId, decision } = await analyzeAndRecordDecision(ctx, sub, mode, signals);
  if (decision.action === 'hold' || !decision.symbol) return { symbol, action: 'hold', placed: false, note: 'analyst held' };

  const policy = riskPolicy(mode);
  const held = positions.find((p) => p.symbol.toUpperCase() === decision.symbol)?.qty || 0;
  if (decision.action === 'buy') {
    if (held > 0) return { symbol, action: 'buy', placed: false, note: 'already holding' };
    // A pending pre/post-market limit from a prior fire isn't in positions yet — skip so the fast leg
    // (every 2 min) can't pyramid the same name across fires until they all fill at the open.
    if (inFlight.has(decision.symbol.toUpperCase())) return { symbol, action: 'buy', placed: false, note: 'working order in flight' };
    const price = (await latestPrice(decision.symbol)) ?? 0;
    const sized = sizeEntry(decision.symbol, price, decision.confidence, account, positions, policy);
    // Extended-hours size-down — news trades fire in thin pre/post; halve so a gap can't outsize the book.
    const extMult = extHours ? Number(process.env.TRADING_EXT_SIZE_MULT || 0.5) : 1;
    const qty = Math.floor(sized.qty * extMult);
    if (qty <= 0) return { symbol, action: 'buy', placed: false, note: sized.blocked || (extHours ? 'ext-hours haircut → <1 share' : 'no size') };
    await setDecisionQty(ctx.pool, decisionId, qty);
  } else { // sell
    if (held <= 0) return { symbol, action: 'sell', placed: false, note: 'no position to close' };
    await setDecisionQty(ctx.pool, decisionId, held);
  }
  const requestId = `research-${new Date().toISOString().slice(0, 16)}-${decision.symbol}-${decision.action}`;
  const r = await placeDecisionOrder(ctx.pool, sub, mode, decisionId, requestId, false);
  return { symbol: decision.symbol, action: decision.action, placed: true, note: `${r.side} ${r.qty} (${r.status})` };
}

/**
 * @description Dispatch a research-brain fire (news+fundamentals → analyst → portfolio → paper).
 * @param ctx - App context (pool, ticketService).
 * @param schedule - The due schedule (taskData carries userSub, mode, universe).
 * @returns Dispatch result for scheduler accounting.
 */
export async function dispatchTradingResearch(ctx: AppContext, schedule: ScheduleRecord): Promise<ScheduleDispatchResult> {
  const td = schedule.taskData as Record<string, unknown>;
  const sub = String(td.userSub || '');
  const mode: TradingMode = String(td.mode || 'paper').toLowerCase() === 'live' ? 'live' : 'paper';
  const universe = Array.isArray(td.universe) && td.universe.length ? (td.universe as unknown[]).map((s) => String(s).toUpperCase()) : DEFAULT_UNIVERSE;
  const fast = schedule.taskType.startsWith('trading-fast');
  const sinceMinutes = fast ? 3 : 20;
  const maxCalls = fast ? MAX_ANALYST_CALLS.fast : MAX_ANALYST_CALLS.research;

  if (!sub) return { success: false, scheduleId: schedule.id, error: 'research schedule missing userSub' };
  if (mode === 'live') return { success: false, scheduleId: schedule.id, error: 'research brain is paper-only' };
  if (!marketDataConfigured() || !getBrokerAdapter('paper').configured()) {
    logger.info({ scheduleId: schedule.id }, 'research skipped — keys not configured');
    return { success: true, scheduleId: schedule.id };
  }
  // Trade in regular OR pre/post-market (news moves hardest off-hours). Closed → skip.
  const session = await tradableSession();
  if (!session) { logger.info({ scheduleId: schedule.id, fast }, 'research skipped — market closed (no tradable session)'); return { success: true, scheduleId: schedule.id }; }

  try {
    await ensureTradingSchema(ctx.pool);
    const news = await recentNews(universe, sinceMinutes, 50);
    if (!news.length) { logger.info({ scheduleId: schedule.id, fast }, 'research — no fresh news'); return { success: true, scheduleId: schedule.id }; }

    // Group fresh news by in-universe symbol, rank by volume, take the top few.
    const uni = new Set(universe);
    const bySymbol = new Map<string, NewsItem[]>();
    for (const n of news) for (const s of n.symbols.map((x) => x.toUpperCase())) {
      if (!uni.has(s)) continue;
      (bySymbol.get(s) ?? bySymbol.set(s, []).get(s)!).push(n);
    }
    const broker = getBrokerAdapter(mode, sub);
    const [positions, accountRaw] = await Promise.all([broker.getPositions().catch(() => [] as Position[]), broker.getAccount().catch(() => null)]);
    const accountSnap: BrokerAccount = accountRaw ?? { cash: 0, buyingPower: 0, equity: 0, currency: 'USD' };
    const held = new Set(positions.filter((p) => p.qty > 0).map((p) => p.symbol.toUpperCase()));
    // Working orders (pending pre/post-market limits getPositions() can't see) — exclude their symbols
    // from new buys and reserve their pending notional from cash so we don't re-deploy claimed dollars.
    const inFlight = await loadInFlight(ctx.pool, sub, mode).catch(() => ({ symbols: new Set<string>(), pendingBuyNotional: 0 }));
    const account: BrokerAccount = { ...accountSnap, cash: Math.max(0, accountSnap.cash - inFlight.pendingBuyNotional) };

    // Protect the BOOK first: a held name with fresh news is analyzed BEFORE buy-hunting, so the
    // analyst can SELL it on materially negative headlines (the "articles everywhere → get out" path)
    // — it used to only ever look at the most news-heavy names hunting buys, never the book it held.
    const ranked = [...bySymbol.entries()].sort((a, b) => b[1].length - a[1].length);
    const chosen = [...ranked.filter(([s]) => held.has(s)), ...ranked.filter(([s]) => !held.has(s))].slice(0, maxCalls);
    if (!chosen.length) { logger.info({ scheduleId: schedule.id }, 'research — no in-universe news'); return { success: true, scheduleId: schedule.id }; }

    // World basket for the analyst (TRADING_WORLD_SIGNALS) — built once per fire, only when enabled.
    const worldSvc = worldSignalsEnabled() ? createWorldIntelligenceService() : null;

    const results = [];
    for (const [symbol, items] of chosen) {
      try { results.push(await analyzeSymbol(ctx, sub, mode, symbol, items, account, positions, inFlight.symbols, session === 'pre' || session === 'post', worldSvc)); }
      catch (e) { results.push({ symbol, action: 'error', placed: false, note: (e as Error).message }); }
    }
    const placed = results.filter((r) => r.placed);
    logger.info({ scheduleId: schedule.id, fast, analyzed: results.length, placed: placed.length }, 'research run complete');
    if (placed.length) await logResearchTicket(ctx, sub, mode, fast, results).catch((e) => logger.warn({ err: e }, 'research ticket failed'));
    return { success: true, scheduleId: schedule.id, taskId: `research-${schedule.id}` };
  } catch (e) {
    logger.error({ err: e, scheduleId: schedule.id }, 'research run failed');
    return { success: false, scheduleId: schedule.id, error: (e as Error).message };
  }
}

/** Log a summary ticket when the research brain traded. */
async function logResearchTicket(ctx: AppContext, sub: string, mode: TradingMode, fast: boolean, results: Array<{ symbol: string; action: string; placed: boolean; note: string }>): Promise<void> {
  const placed = results.filter((r) => r.placed);
  await ctx.ticketService.createTicket({
    title: `📰 ${fast ? 'Fast' : 'Research'} brain: ${placed.length} trade(s) [${mode}]`,
    ticketType: 'trading-decision', ownerSub: sub, status: 'complete',
    description: `News+fundamentals analyst run — ${results.map((r) => `${r.symbol}:${r.action}${r.placed ? '✓' : `(${r.note})`}`).join(', ')}.`,
    priority: 'none', labels: [], workspaceId: null, assignedAgentId: null, parentTicketId: null,
    externalProvider: null, externalId: null, externalUrl: null,
    metadata: { source: fast ? 'trading-fast' : 'trading-research', book: mode, firedAt: new Date().toISOString(), results },
  });
}
