/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard real-file clock decoding, front-month/range clamping, invalid rows and bounded import configuration without shared data writes.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { normalizeFuturesArchiveConfig } from '@/app/trading-futures-archive-config';
import { prepareFuturesArchive } from '@/app/trading-futures-archive-source';
const directory = mkdtempSync(join(tmpdir(), 'futures-import-source-'));
mkdirSync(join(directory, 'minute')); mkdirSync(join(directory, 'daily'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const config = { roots: ['ES'], timeframes: ['1Hour'], dataDir: directory, sourceTimeZone: 'UTC', start: '2025-10-01', end: '2025-10-01', minVolume: 1 };
describe('real archive import source', () => {
  it('requires explicit source settings and rejects out-of-scope or oversized requests', () => {
    expect(normalizeFuturesArchiveConfig(config)).toEqual(config);
    for (const patch of [{ sourceTimeZone: '' }, { dataDir: 'relative' }, { roots: ['STOCK'] }, { roots: ['ES', 'ES'] }, { timeframes: ['1Min'] },
      { timeframes: ['1Hour', '1Hour'] }, { start: '2025-02-30' }, { start: '2025-12-01' }, { end: '2099-01-01' },
      { start: '2000-01-01' }, { minVolume: -1 }, { minVolume: '2' }, { allowOverwrite: true }]) {
      expect(() => normalizeFuturesArchiveConfig({ ...config, ...patch })).toThrow();
    }
  });
  it('imports only completed, raw front-month/range buckets and produces stable preview citations', async () => {
    writeFileSync(join(directory, 'minute', 'ESZ25.txt'), [
      '08/01/2025,10:00,1,2,0,1,100', '08/01/2025,10:59,1,2,0,1,100',
      '10/01/2025,10:00,100,102,99,101,0', '10/01/2025,10:59,101,103,100,102,10',
      '10/01/2025,11:15,102,103,101,102,20',
    ].join('\n'));
    const preview = await prepareFuturesArchive(config), full = await prepareFuturesArchive(config, true);
    expect(preview.series).toBeUndefined(); expect(full.plan).toEqual(preview.plan);
    expect(full.series?.[0].bars).toEqual([{ t: '2025-10-01T10:00:00.000Z', o: 100, h: 103, l: 99, c: 102, v: 10 }]);
    expect(full.plan.manifest[0].received).toBe(1);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2025-10-01T10:30:00Z'));
    try { await expect(prepareFuturesArchive(config)).rejects.toThrow(/no completed/); } finally { clock.mockRestore(); }
  });
  it.each([
    ['negative volume', '10/01/2025,10:00,100,102,99,101,-1'],
    ['invalid OHLC', '10/01/2025,10:00,100,90,99,101,1'],
    ['duplicate stamp', '10/01/2025,10:00,100,102,99,101,1\n10/01/2025,10:00,100,102,99,101,1'],
    ['daily in minute folder', '10/01/2025,100,102,99,101,1'],
  ])('refuses %s rather than silently dropping data', async (_label, input) => {
    writeFileSync(join(directory, 'minute', 'ESZ25.txt'), input);
    await expect(prepareFuturesArchive(config)).rejects.toThrow();
  });
  it('refuses ambiguous archive wall time instead of guessing a DST occurrence', async () => {
    writeFileSync(join(directory, 'minute', 'ESZ25.txt'), '11/02/2025,01:00,100,102,99,101,1\n11/02/2025,01:59,100,102,99,101,1');
    await expect(prepareFuturesArchive({ ...config, start: '2025-11-02', end: '2025-11-02', sourceTimeZone: 'America/New_York' })).rejects.toThrow(/Ambiguous/);
  });
});
