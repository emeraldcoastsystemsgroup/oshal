/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — congressional ("political") trade signal: STOCK Act disclosures aggregated per ticker into world_metrics. "Trade the things getting free money from the gov." Gov-contracting award data is a future sibling.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Preserve transaction dates by aggregating per ticker/day and writing dated metric points, so downstream watchlists can show the feed-backed disclosure date instead of the collector's observation time.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Key every point on the disclosure ReportDate and refuse a row without a real calendar ReportDate. Seq 2 used `TransactionDate || ReportDate`, so the day the Trading watchlist labels "disclosed" was the trade day, up to ~45 days before the trade became public. Each point now also records when the collector read the feed (observed_at), and a re-run writes only points whose value changed: the 6-hourly depth cycle re-read the whole 90-day window and appended an identical copy of every point each time.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | The default feed is no longer keyless: on 2026-09-28 GET https://api.quiverquant.com/beta/live/congresstrading answered HTTP 401 {"detail":"Authentication credentials were not provided."} to this collector's exact request, and "Invalid token." once any Bearer credential was sent. Forward WORLD_POLITICAL_TOKEN as `Authorization: Bearer <token>`, log a 401/403 at ERROR as a refusal that names the setting (and whether one was configured), never the token, and report the feed outcome (ok / refused / failed / world-disabled) in the result so the depth-cycle line says what happened instead of "collected" with zero tickers.
 */

/**
 * Political (congressional) trade signal.
 *
 * STOCK Act disclosures: members of Congress must report their stock trades. It's an "informed money"
 * signal — distinctive, free, and (per the operator) a tell for names benefiting from government money.
 * Caveat: ~45-day disclosure lag, so it's a slow POSITIONING signal, not a fast catalyst. That lag is why
 * every point is keyed on the disclosure (report) day: that is the first day the information existed
 * publicly, so a series keyed on the trade day would claim knowledge weeks before anyone had it.
 *
 * Source: Quiver Quantitative's live congress-trading endpoint. It needs an API token
 * (WORLD_POLITICAL_TOKEN, sent as a Bearer credential): without one it answers HTTP 401, which is logged
 * as a refusal naming that setting. We aggregate recent disclosures per ticker and report day into
 * world_metrics (the miner auto-discovers them):
 *   congress_buys / congress_sells (counts), congress_net (buys−sells),
 *   congress_sentiment ((buys−sells)/total, [-1,1]), congress_notional (summed lower-bound $).
 * This collector is the only writer of that namespace: world contributions refuse `congress_*` facts and
 * the `quiver-congress` source (world-types.ts).
 *
 * Future sibling (operator): wire gov-contracting award data (USAspending/SAM.gov) for "who's getting
 * federal contracts" — the same idea from the spending side.
 */

import { createWorldIntelligenceService, type WorldIntelligenceService } from './world-intelligence-service';
import { CONGRESS_FEED_SOURCE } from './world-types';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'political-trades' });

const DEFAULT_CONGRESS_URL = 'https://api.quiverquant.com/beta/live/congresstrading';
/** The setting that carries the feed credential; named in every refusal log. */
const TOKEN_SETTING = 'WORLD_POLITICAL_TOKEN';
/** Quiver serves this to a browser UA. Override via WORLD_POLITICAL_UA. */
const DEFAULT_POLITICAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
/** Lookback window (days) over the disclosure ReportDate (default 90 — covers the ~45d lag + a tail). */
const POLITICAL_DAYS = Math.max(7, Number(process.env.WORLD_POLITICAL_DAYS) || 90);
const FETCH_TIMEOUT_MS = 15_000;
const DAY_MS = 86_400_000;
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})/;

export interface CongressTrade { Ticker?: string; Transaction?: string; ReportDate?: string; TransactionDate?: string; Amount?: string | number; }

export interface PoliticalTradeObservation {
  ticker: string;
  /** UTC midnight of the feed's ReportDate — the day the trade became public. */
  disclosureDate: string;
  buys: number;
  sells: number;
  notional: number;
}

/**
 * How the run's feed read ended: `ok` (a list was read), `refused` (401/403 — the credential in
 * WORLD_POLITICAL_TOKEN is missing or rejected), `failed` (any other error, status or non-list body),
 * `world-disabled` (no world service, so the feed was not read).
 */
export type PoliticalFeedOutcome = 'ok' | 'refused' | 'failed' | 'world-disabled';

export interface PoliticalTradesResult {
  feed: PoliticalFeedOutcome;
  tickers: number;
  trades: number;
  /** Points appended this run (new, or a changed value for an existing disclosure day). */
  written: number;
  /** Points skipped because the newest stored value for that disclosure day already matched. */
  unchanged: number;
}

/** A run that wrote nothing, with the reason. */
const emptyResult = (feed: PoliticalFeedOutcome): PoliticalTradesResult => ({ feed, tickers: 0, trades: 0, written: 0, unchanged: 0 });

/**
 * @description Read the feed's ReportDate as a real calendar day. Only the literal leading
 * `YYYY-MM-DD` is used, so a timestamp's timezone cannot move a disclosure onto a neighbouring day,
 * and a day that does not exist (2026-02-30) is refused instead of rolling over into March.
 * @param raw - The untrusted ReportDate value.
 * @returns The ISO calendar day and its UTC-midnight epoch, or null when it is not a real day.
 */
export function disclosureDay(raw: unknown): { day: string; epoch: number } | null {
  const match = typeof raw === 'string' ? CALENDAR_DAY.exec(raw.trim()) : null;
  if (!match) return null;
  const epoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  return new Date(epoch).toISOString().slice(0, 10) === day ? { day, epoch } : null;
}

/** Purchase / sale classification; anything else (exchange, dividend, blank) is not a directional trade. */
function tradeDirection(transaction: unknown): 'buy' | 'sell' | null {
  const tx = String(transaction || '').toLowerCase();
  if (tx.includes('purchase')) return 'buy';
  if (tx.includes('sale') || tx.includes('sold')) return 'sell';
  return null;
}

/**
 * @description Normalize the feed into per-ticker, per-disclosure-day aggregates before any
 * persistence. A row is refused when its ticker is malformed, its ReportDate is missing or not a real
 * day, the disclosure falls outside the lookback or after today, or it is not a purchase or sale.
 * TransactionDate is deliberately ignored: nothing here may be dated before it was disclosed.
 * @param raw - Untrusted feed rows.
 * @param now - Clock used for deterministic lookback/future filtering.
 * @param lookbackDays - Inclusive lookback window in days.
 * @returns Sorted per-ticker/per-day aggregates and the number of accepted trades.
 */
export function aggregatePoliticalTrades(
  raw: CongressTrade[], now = new Date(), lookbackDays = POLITICAL_DAYS,
): { observations: PoliticalTradeObservation[]; trades: number } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutoff = today - Math.max(1, lookbackDays) * DAY_MS;
  const agg = new Map<string, PoliticalTradeObservation>();
  let trades = 0;
  for (const t of raw) {
    const sym = String(t?.Ticker || '').toUpperCase().trim();
    if (!sym || !/^[A-Z][A-Z.]{0,5}$/.test(sym)) continue;
    const disclosed = disclosureDay(t?.ReportDate);
    if (!disclosed || disclosed.epoch < cutoff || disclosed.epoch > today) continue;
    const direction = tradeDirection(t?.Transaction);
    if (!direction) continue;
    const disclosureDate = `${disclosed.day}T00:00:00.000Z`;
    const key = `${sym}\0${disclosureDate}`;
    const e = agg.get(key) || { ticker: sym, disclosureDate, buys: 0, sells: 0, notional: 0 };
    if (direction === 'buy') e.buys += 1; else e.sells += 1;
    e.notional += Number(String(t?.Amount ?? '').replace(/[,$]/g, '')) || 0;
    agg.set(key, e);
    trades += 1;
  }
  const observations = [...agg.values()]
    .sort((a, b) => a.ticker.localeCompare(b.ticker) || a.disclosureDate.localeCompare(b.disclosureDate));
  return { observations, trades };
}

/** One feed read: the rows, or why there are none. */
type FeedRead = { outcome: 'ok'; rows: CongressTrade[] } | { outcome: 'refused' | 'failed' };

/**
 * @description The request headers: the browser UA the feed expects, plus the Bearer credential when
 * one is configured.
 * @param token - The trimmed WORLD_POLITICAL_TOKEN value ('' when unset).
 * @returns The header map for the feed request.
 */
function feedHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': process.env.WORLD_POLITICAL_UA || DEFAULT_POLITICAL_UA,
    Accept: 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * @description Fetch the live disclosure feed. The URL, UA and credential are read at call time so an
 * operator override (WORLD_POLITICAL_URL / WORLD_POLITICAL_UA / WORLD_POLITICAL_TOKEN) applies to the
 * next run. A 401/403 means the credential is missing or rejected: it is logged at ERROR naming the
 * setting and whether one was configured, never the token itself.
 * @returns The rows (`ok`), or `refused` / `failed` with nothing to write.
 */
async function fetchCongressTrades(): Promise<FeedRead> {
  const url = process.env.WORLD_POLITICAL_URL || DEFAULT_CONGRESS_URL;
  const token = (process.env[TOKEN_SETTING] || '').trim();
  try {
    const res = await fetch(url, { headers: feedHeaders(token), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 401 || res.status === 403) {
      logger.error({ status: res.status, setting: TOKEN_SETTING, tokenConfigured: Boolean(token), feedHost: new URL(url).host },
        'congress trades feed refused — WORLD_POLITICAL_TOKEN missing or rejected');
      return { outcome: 'refused' };
    }
    if (!res.ok) { logger.warn({ status: res.status }, 'congress trades fetch failed'); return { outcome: 'failed' }; }
    const body = await res.json() as unknown;
    if (!Array.isArray(body)) { logger.warn({ bodyType: typeof body }, 'congress trades feed answered a non-list body'); return { outcome: 'failed' }; }
    return { outcome: 'ok', rows: body as CongressTrade[] };
  } catch (err) {
    logger.error({ err }, 'congress trades fetch error');
    return { outcome: 'failed' };
  }
}

/** The metric points one observation carries (sentiment only when there was a directional trade). */
function observationPoints(e: PoliticalTradeObservation): Array<[string, number]> {
  const total = e.buys + e.sells;
  const points: Array<[string, number]> = [
    ['congress_buys', e.buys], ['congress_sells', e.sells], ['congress_net', e.buys - e.sells],
  ];
  if (total) points.push(['congress_sentiment', Number(((e.buys - e.sells) / total).toFixed(3))]);
  points.push(['congress_notional', e.notional]);
  return points;
}

/**
 * @description Persist the observations, skipping every point whose newest stored value for the
 * same ticker/metric/disclosure day already matches. One ticker's write failure is logged and does
 * not stop the others.
 * @param svc - The world service (the only path into world_metrics).
 * @param observations - Aggregated disclosures.
 * @param observedAt - When this run read the feed.
 * @returns How many points were appended and how many were already current.
 */
async function writeObservations(
  svc: WorldIntelligenceService, observations: PoliticalTradeObservation[], observedAt: string,
): Promise<{ written: number; unchanged: number }> {
  let written = 0;
  let unchanged = 0;
  for (const e of observations) {
    const entity = `world:ticker:${e.ticker.toLowerCase()}`;
    try {
      for (const [metric, value] of observationPoints(e)) {
        const inserted = await svc.writeMetricIfChanged(entity, metric, value, CONGRESS_FEED_SOURCE, e.disclosureDate, observedAt);
        if (inserted) written += 1; else unchanged += 1;
      }
    } catch (err) {
      logger.error({ err, sym: e.ticker, disclosureDate: e.disclosureDate }, 'congress metric write failed');
    }
  }
  return { written, unchanged };
}

/**
 * @description Fetch + aggregate recent congressional disclosures per ticker into world_metrics.
 * A refused or failed feed read returns zeros with its outcome, so a feed outage never breaks the
 * refresh and never reads as a successful empty run. Runs on the 6h depth cycle; a re-run over the
 * same feed appends nothing.
 * @param svcInput - Existing world service, or omitted to build one (skips quietly when world is disabled).
 * @returns The feed outcome, ticker/trade counts, and how many points were written and already current.
 */
export async function collectPoliticalTrades(svcInput?: WorldIntelligenceService | null): Promise<PoliticalTradesResult> {
  const svc = svcInput ?? createWorldIntelligenceService();
  if (!svc) return emptyResult('world-disabled');
  const now = new Date();
  const read = await fetchCongressTrades();
  if (read.outcome !== 'ok') return emptyResult(read.outcome);

  const { observations, trades } = aggregatePoliticalTrades(read.rows, now);
  const { written, unchanged } = await writeObservations(svc, observations, now.toISOString());
  const tickers = new Set(observations.map((e) => e.ticker)).size;
  logger.info({ feed: 'ok', tickers, trades, observations: observations.length, written, unchanged }, 'political trades collected');
  return { feed: 'ok', tickers, trades, written, unchanged };
}
