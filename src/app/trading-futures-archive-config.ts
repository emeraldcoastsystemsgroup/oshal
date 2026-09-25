/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bound console-owned real-archive imports independently of strategy, provider and order settings.
 */
import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { getFuturesRoot } from '@/features/trading';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const time = Date.parse(value); return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}, 'Use a real calendar date');
const schema = z.object({
  roots: z.array(z.string().regex(/^[A-Z0-9]{1,3}$/).refine(value => !!getFuturesRoot(value), 'Unknown Futures root')).min(1).max(8),
  timeframes: z.array(z.enum(['1Hour', '1Day'])).min(1).max(2),
  dataDir: z.string().trim().min(1).max(1024).refine(value => isAbsolute(value) && !value.includes('\0'), 'Use an absolute server archive directory'),
  sourceTimeZone: z.enum(['UTC', 'America/New_York', 'America/Chicago']),
  start: day, end: day,
  minVolume: z.number().int().min(0).max(1_000_000_000).default(1),
}).strict();
/** @description Operator-confirmed source settings; dates bound true UTC bar opens, end day inclusive. */
export type FuturesArchiveConfig = z.infer<typeof schema>;
/** @description Explicit confirmation of new shared reference rows, never replacement or orders. */
export const FUTURES_ARCHIVE_CONFIRM = 'IMPORT SHARED FUTURES BARS';

/** @description Reject unknown controls, invalid dates and unbounded imports before file or database work.
 * @param raw - Console or CLI settings. @returns Normalized source envelope, with no inferred clock or directory.
 */
export function normalizeFuturesArchiveConfig(raw: unknown): FuturesArchiveConfig {
  const config = schema.parse(raw);
  if (config.start > config.end || Date.parse(config.end) - Date.parse(config.start) > 3660 * 86_400_000) throw new RangeError('Archive range must be ordered and no longer than ten years');
  if (config.end > new Date().toISOString().slice(0, 10)) throw new RangeError('Archive end cannot be a future UTC date');
  if (new Set(config.roots).size !== config.roots.length || new Set(config.timeframes).size !== config.timeframes.length) throw new RangeError('Duplicate roots or timeframes');
  return { ...config, roots: [...config.roots].sort(), timeframes: [...config.timeframes].sort() };
}
