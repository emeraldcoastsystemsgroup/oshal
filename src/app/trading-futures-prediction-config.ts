/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bound opt-in, dated-contract forward research independently of historical optimization.
 */
import { parseFuturesSymbol } from '@/features/trading';

/** @description Explicit research-only forward envelope; no defaults select a contract or source clock. */
export interface FuturesPredictionConfig {
  enabled: boolean;
  contracts: Record<string, string>;
  sourceTimeZone: string;
  horizonHours: number;
  maxSourceAgeHours: number;
  gradingToleranceHours: number;
  historyBars: number;
}

const ZONES = new Set(['UTC', 'America/New_York', 'America/Chicago']);
const TIMEFRAMES = new Set(['5Min', '1Hour', '1Day']);
function bounded(raw: unknown, fallback: number, min: number, max: number): number {
  const value = raw ?? fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`Futures prediction value must be an integer from ${min} to ${max}`);
  }
  return value;
}

/** @description Keep old schedules off and require explicit archive clock and contracts when on.
 * @param raw - Console configuration. @param study - Parent study source and market envelope.
 * @returns Validated bounded settings; no default contract or timezone is inferred.
 */
export function normalizeFuturesPredictions(raw: unknown, study: { roots: string[]; source: string; timeframe: string; ltfTimeframe: string }): FuturesPredictionConfig {
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new TypeError('predictions must be an object');
  const input = (raw ?? {}) as Record<string, unknown>;
  if (Object.keys(input).some(key => !['enabled','contracts','sourceTimeZone','horizonHours','maxSourceAgeHours','gradingToleranceHours','historyBars'].includes(key))) throw new RangeError('Unknown Futures prediction setting');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new TypeError('predictions.enabled must be a boolean');
  const enabled = input.enabled === true;
  const sourceTimeZone = input.sourceTimeZone === undefined ? '' : String(input.sourceTimeZone);
  if (sourceTimeZone && !ZONES.has(sourceTimeZone)) throw new RangeError('Unsupported Futures archive time zone');
  if (input.contracts !== undefined && (!input.contracts || typeof input.contracts !== 'object' || Array.isArray(input.contracts))) throw new TypeError('predictions.contracts must map roots to dated symbols');
  const contracts: Record<string, string> = {};
  for (const [root, symbol] of Object.entries(input.contracts ?? {})) {
    const parsed = typeof symbol === 'string' ? parseFuturesSymbol(symbol) : null;
    if (!study.roots.includes(root) || !parsed || parsed.root.root !== root || !parsed.root.months.includes(parsed.monthNum)
      || !/^[A-Z0-9]+[FGHJKMNQUVXZ]\d{2}$/.test(String(symbol))) throw new RangeError(`Invalid explicit contract for ${root}`);
    contracts[root] = symbol as string;
  }
  if (enabled && (study.source !== 'kibot-file' || !TIMEFRAMES.has(study.timeframe) || !TIMEFRAMES.has(study.ltfTimeframe))) {
    throw new RangeError('Forward predictions require Kibot files and 5Min, 1Hour or 1Day bars');
  }
  if (enabled && (!sourceTimeZone || study.roots.some(root => !contracts[root]))) throw new RangeError('Forward predictions require an explicit archive time zone and dated contract for every root');
  return { enabled, contracts, sourceTimeZone,
    horizonHours: bounded(input.horizonHours, 24, 1, 168),
    maxSourceAgeHours: bounded(input.maxSourceAgeHours, 36, 1, 168),
    gradingToleranceHours: bounded(input.gradingToleranceHours, 24, 1, 168),
    historyBars: bounded(input.historyBars, 512, 64, 4096) };
}
