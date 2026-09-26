/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard quote-versus-OHLCV classification and redacted, bounded Schwab Futures capability checks.
 */
import { describe, expect, it } from 'vitest';
import { probeSchwabFuturesBars } from '@/app/trading-futures-schwab-probe';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const candle = () => ({ datetime: Date.now() - 3_600_000, open: 5000, high: 5002, low: 4999, close: 5001, volume: 25 });

describe('Schwab Futures source capability', () => {
  it('recognizes actual dated-contract bars without returning token or bar payloads', async () => {
    const paths: string[] = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      paths.push(url);
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer private-token' });
      if (url.includes('/quotes?')) {
        const symbol = new URL(url).searchParams.get('symbols')!;
        return json({ [symbol]: { quote: { lastPrice: 5001, tradeTime: Date.now() } } });
      }
      return json({ candles: [candle(), { ...candle(), datetime: Date.now() - 1_800_000 }] });
    };
    const result = await probeSchwabFuturesBars('private-token', ['ES'], fetcher);
    expect(paths).toHaveLength(3);
    expect(paths.every(path => new URL(path).searchParams.get('symbol')?.startsWith('/ES') || path.includes('/quotes?'))).toBe(true);
    expect(result.roots[0].quote.state).toBe('available');
    expect(result.roots[0].minute).toMatchObject({ state: 'available', bars: 2, volumeBars: 2 });
    expect(result.roots[0].forwardBarCandidate).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-token');
    expect(JSON.stringify(result)).not.toContain('5001');
  });

  it('does not promote quotes when futures history is empty, invalid or rejected', async () => {
    for (const history of [json({ candles: [] }), json({ candles: [{ ...candle(), volume: -1 }] }), json({ error: 'not entitled' }, 403)]) {
      const fetcher = async (url: string) => url.includes('/quotes?') ? json({}) : history.clone();
      const result = await probeSchwabFuturesBars('private-token', ['CL'], fetcher);
      expect(result.roots[0].forwardBarCandidate).toBe(false);
      expect(result.roots[0].minute.state).not.toBe('available');
      expect(JSON.stringify(result)).not.toContain('not entitled');
    }
  });

  it('rejects unchecked roots and missing broker authorization before networking', async () => {
    const unused = async () => { throw new Error('should not call'); };
    await expect(probeSchwabFuturesBars('', ['ES'], unused)).rejects.toThrow();
    await expect(probeSchwabFuturesBars('token', ['INVALID'], unused)).rejects.toThrow();
  });
});
