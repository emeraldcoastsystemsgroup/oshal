/**
 * Read-only Schwab Futures capability probe. A quote is not an OHLCV bar and a short
 * historical sample is not evidence of the contract depth a walk-forward study needs.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Probe dated ES/CL quotes and minute/daily candles through an existing brokered token without returning tokens or market-data payloads.
 */
import { activeContractAt, getFuturesRoot } from '@/features/trading';

type ProbeState = 'available' | 'empty' | 'invalid' | 'rejected' | 'unavailable';
export interface SchwabFuturesSample {
  state: ProbeState;
  httpStatus?: number;
  bars?: number;
  volumeBars?: number;
  first?: string;
  last?: string;
}
export interface SchwabFuturesProbeRoot {
  root: string;
  datedContract: string;
  quote: { state: ProbeState; httpStatus?: number; asOf?: string };
  minute: SchwabFuturesSample;
  daily: SchwabFuturesSample;
  forwardBarCandidate: boolean;
}
export interface SchwabFuturesProbeResult {
  source: 'schwab';
  checkedAt: string;
  readOnly: true;
  roots: SchwabFuturesProbeRoot[];
  note: string;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const BASE = 'https://api.schwabapi.com/marketdata/v1';

function iso(value: unknown): string | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 946684800000 || n > Date.now() + 86_400_000) return undefined;
  return new Date(n).toISOString();
}

async function providerRead(fetcher: Fetcher, token: string, endpoint: string): Promise<{ state: ProbeState; httpStatus?: number; json?: unknown }> {
  try {
    const response = await fetcher(`${(process.env.SCHWAB_MARKETDATA_BASE_URL || BASE).replace(/\/+$/, '')}${endpoint}`, {
      method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return { state: response.status === 401 || response.status === 403 ? 'rejected' : 'unavailable', httpStatus: response.status };
    return { state: 'available', httpStatus: response.status, json: await response.json() };
  } catch {
    return { state: 'unavailable' };
  }
}

function candleSample(raw: unknown, status: number | undefined): SchwabFuturesSample {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { candles?: unknown }).candles)) return { state: 'invalid', httpStatus: status };
  const candles = (raw as { candles: unknown[] }).candles;
  if (!candles.length) return { state: 'empty', httpStatus: status, bars: 0, volumeBars: 0 };
  let valid = 0, volumeBars = 0, first: string | undefined, last: string | undefined;
  const seen = new Set<string>();
  for (const value of candles) {
    if (!value || typeof value !== 'object') continue;
    const bar = value as Record<string, unknown>;
    const stamp = iso(bar.datetime);
    const [o, h, l, c, v] = [bar.open, bar.high, bar.low, bar.close, bar.volume].map(Number);
    if (!stamp || seen.has(stamp) || ![o, h, l, c, v].every(Number.isFinite) || o <= 0 || c <= 0 || v < 0 || h < Math.max(o, c) || l > Math.min(o, c)) continue;
    seen.add(stamp);
    valid += 1;
    if (v > 0) volumeBars += 1;
    first = first && first < stamp ? first : stamp;
    last = last && last > stamp ? last : stamp;
  }
  return { state: valid === candles.length ? 'available' : 'invalid', httpStatus: status, bars: valid, volumeBars, ...(first ? { first } : {}), ...(last ? { last } : {}) };
}

async function readCandles(fetcher: Fetcher, token: string, symbol: string, frequencyType: 'minute' | 'daily'): Promise<SchwabFuturesSample> {
  const now = Date.now();
  const qs = new URLSearchParams({ symbol, periodType: frequencyType === 'minute' ? 'day' : 'month',
    frequencyType, frequency: frequencyType === 'minute' ? '30' : '1',
    startDate: String(now - (frequencyType === 'minute' ? 5 : 30) * 86_400_000), endDate: String(now),
    needExtendedHoursData: 'true' });
  const result = await providerRead(fetcher, token, `/pricehistory?${qs}`);
  return result.state === 'available' ? candleSample(result.json, result.httpStatus) : { state: result.state, ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}) };
}

/** @description Inspect bounded dated-contract samples using an already-authorized Schwab access token. No bars or credential leave this function. */
export async function probeSchwabFuturesBars(token: string, roots: string[] = ['ES', 'CL'], fetcher: Fetcher = fetch): Promise<SchwabFuturesProbeResult> {
  if (!token) throw new TypeError('Schwab connection unavailable');
  if (!Array.isArray(roots) || roots.length < 1 || roots.length > 2 || roots.some(root => !getFuturesRoot(root))) throw new RangeError('Choose one or two supported Futures roots');
  const checkedAt = new Date().toISOString();
  const results: SchwabFuturesProbeRoot[] = [];
  for (const root of roots) {
    const contract = activeContractAt(root, new Date());
    if (!contract) throw new Error('No active dated contract');
    const symbol = `/${contract.symbol}`;
    const response = await providerRead(fetcher, token, `/quotes?symbols=${encodeURIComponent(symbol)}&fields=quote&indicative=false`);
    let quote: SchwabFuturesProbeRoot['quote'] = { state: response.state, ...(response.httpStatus ? { httpStatus: response.httpStatus } : {}) };
    if (response.state === 'available') {
      const record = response.json && typeof response.json === 'object' ? (response.json as Record<string, unknown>)[symbol] : undefined;
      const raw = record && typeof record === 'object' ? (record as { quote?: Record<string, unknown> }).quote : undefined;
      const price = Number(raw?.lastPrice);
      const asOf = iso(raw?.tradeTime ?? raw?.quoteTime);
      quote = { state: Number.isFinite(price) && price > 0 ? 'available' : 'empty', httpStatus: response.httpStatus, ...(asOf ? { asOf } : {}) };
    }
    const minute = await readCandles(fetcher, token, symbol, 'minute');
    const daily = await readCandles(fetcher, token, symbol, 'daily');
    results.push({ root, datedContract: contract.symbol, quote, minute, daily,
      forwardBarCandidate: minute.state === 'available' && (minute.bars ?? 0) > 1 && (minute.volumeBars ?? 0) > 0 });
  }
  return { source: 'schwab', checkedAt, readOnly: true, roots: results,
    note: 'A short dated-contract sample is only a capability check. Historical depth, gaps, continuous rolling, forward collection and permitted retention must be verified separately before this can drive research.' };
}
