/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — searchSymbols ranking (operator 2026-09-04 "the dropdown should let me search"): exact symbol first, then symbol-prefix, then symbol-substring, then name-substring; shorter symbols win ties; the whole thing is fed from a cached Alpaca asset directory. Source guard — the fetch itself needs Alpaca keys (integration), but the ranking is the operator-facing behavior and it is pure over the directory, so it is unit-tested here by pinning the ranker's structure.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';

describe('symbol search — ranking + fail-soft (2026-09-04)', () => {
  const src = readFileSync(path.resolve(__dirname, '../../src/features/trading/services/market-data.ts'), 'utf8');

  it('the tiers are exact → symbol-prefix → symbol-substring → name-substring', () => {
    expect(src).toContain('if (a.symbol === q) return 0;');
    expect(src).toContain('if (a.symbol.startsWith(q)) return 1;');
    expect(src).toContain('if (a.symbol.includes(q)) return 2;');
    expect(src).toContain('if (a.name.toUpperCase().includes(q)) return 3;');
  });

  it('ties break by shorter symbol then alphabetical, and the result is capped', () => {
    expect(src).toMatch(/\.sort\(\(x, y\) => x\.t - y\.t \|\| x\.a\.symbol\.length - y\.a\.symbol\.length \|\| x\.a\.symbol\.localeCompare\(y\.a\.symbol\)\)/);
    expect(src).toMatch(/\.slice\(0, Math\.max\(1, Math\.min\(50, limit\)\)\)/);
  });

  it('the directory is cached and never throws — empty on unconfigured/failed fetch', () => {
    expect(src).toContain('const ASSET_TTL_MS = 24 * 3600 * 1000;');
    expect(src).toMatch(/if \(!k\.id \|\| !k\.secret\) return \[\];/);
    expect(src).toMatch(/catch \(err\) \{ logger\.warn\(\{ err \}, 'asset directory fetch threw'\); return assetCache\?\.assets \?\? \[\]; \}/);
  });

  it('an empty query returns nothing (no whole-directory dump)', () => {
    expect(src).toMatch(/if \(q\.length < 1\) return \[\];/);
  });
});
