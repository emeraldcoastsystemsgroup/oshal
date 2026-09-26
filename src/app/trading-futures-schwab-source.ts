/**
 * Owner-private Schwab capture reader for bounded, research-only dated-contract studies.
 * The stored timestamps are real UTC. The existing optimizer consumes exchange-wall
 * stamps encoded in UTC fields, so conversion happens only after true-UTC gap checks.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Read owner-scoped captured contracts with strict session completeness, clock and timeframe gates before research.
 */
import type { Pool } from 'pg';
import { isSessionBucket } from '@/features/trading/services/futures-session-calendar';
import { resampleBars, type FuturesBar, type FuturesContract, type FuturesDataSource, type Timeframe } from '@/features/trading';
import { futuresUtcToWall, futuresWallTimeUtc } from './trading-futures-prediction-clock';
import { FuturesSourceError } from './trading-futures-source-error';

const TABLE = 'oshal_trading_futures_schwab_bars';
const BAR_MS = 30 * 60_000;
const MAX_WINDOW_MS = 125 * 86_400_000;
const ZONE = 'America/New_York';
const SUPPORTED = new Set<Timeframe>(['1Hour', '1Day']);

/** @description A captured-bar source, not a provider fetch or a trade-capable adapter. */
export class SchwabCapturedFuturesDataSource implements FuturesDataSource {
  readonly name = 'schwab-capture';

  constructor(private readonly pool: Pool, private readonly ownerSub: string,
    private readonly minVolume = 0, private readonly strict = true) {}

  configured(): boolean { return Boolean(this.pool && this.ownerSub); }

  async fetchBars(contract: FuturesContract, timeframe: Timeframe,
    window?: { start?: Date; end?: Date }): Promise<FuturesBar[]> {
    if (!this.configured()) throw new FuturesSourceError('Schwab captured source requires an owner and database',
      { code: 'unconfigured', root: contract.root });
    if (!['ES', 'CL'].includes(contract.root) || !new RegExp(`^${contract.root}[FGHJKMNQUVXZ]\\d{2}$`).test(contract.symbol)
      || !SUPPORTED.has(timeframe)) throw new RangeError('Schwab captured research supports dated ES/CL at 1Hour or 1Day');
    const fromWall = (window?.start ?? contract.activeStart).toISOString();
    const toWall = (window?.end ?? contract.activeEnd).toISOString();
    const from = futuresWallTimeUtc(fromWall, ZONE);
    const to = futuresWallTimeUtc(toWall, ZONE);
    if (to <= from) return [];
    if (to - from > MAX_WINDOW_MS) throw new RangeError('Schwab captured contract window exceeds 125 days');
    const rows = (await this.pool.query(`SELECT bar_ts,o,h,l,c,v FROM ${TABLE}
      WHERE owner_sub=$1 AND symbol=$2 AND timeframe='30Min' AND bar_ts >= $3 AND bar_ts < $4
      ORDER BY bar_ts LIMIT 10001`, [this.ownerSub, contract.symbol, new Date(from).toISOString(), new Date(to).toISOString()])).rows;
    if (rows.length > 10_000) throw new RangeError('Schwab captured contract window exceeds 10000 bars');

    const present = new Set<number>();
    const wall = new Set<number>();
    const bars: FuturesBar[] = [];
    for (const row of rows) {
      const instant = new Date(row.bar_ts).getTime();
      const stamp = futuresUtcToWall(instant, ZONE);
      const [o, h, l, c, v] = [row.o, row.h, row.l, row.c, row.v].map(Number);
      if (!Number.isFinite(instant) || instant % BAR_MS !== 0 || present.has(instant) || wall.has(stamp)
        || !isSessionBucket(stamp, BAR_MS) || ![o,h,l,c,v].every(Number.isFinite)
        || Math.min(o,h,l,c) <= 0 || v < 0 || h < Math.max(o,c) || l > Math.min(o,c)) {
        throw new FuturesSourceError(`${contract.root}: captured Schwab bars have invalid or ambiguous source evidence`,
          { code: 'incomplete', root: contract.root });
      }
      present.add(instant); wall.add(stamp);
      bars.push({ t: new Date(stamp).toISOString(), o, h, l, c, v });
    }

    if (this.strict) {
      let missing = 0;
      let firstMissing: string | null = null;
      for (let t = Math.ceil(from / BAR_MS) * BAR_MS; t < to; t += BAR_MS) {
        if (isSessionBucket(futuresUtcToWall(t, ZONE), BAR_MS) && !present.has(t)) {
          missing++;
          firstMissing ??= new Date(t).toISOString();
        }
      }
      if (missing) throw new FuturesSourceError(`${contract.root}: captured Schwab source is missing ${missing} session buckets beginning ${firstMissing}; optimizer not run`,
        { code: 'incomplete', root: contract.root });
    }
    return resampleBars(bars, timeframe).filter(bar => bar.v >= this.minVolume);
  }
}
