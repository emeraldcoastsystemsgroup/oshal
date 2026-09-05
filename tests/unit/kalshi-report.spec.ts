/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Kalshi report CLI (operator, 2026-09-05: "how can I monitor Kalshi wins and reports and run cross reference"). Pins the pure cuts every cross-tab depends on — the five price bands, the confidence deciles, breakeven = price + 7%·P·(1−P) — the flag parsing (a bad spread falls back, never to zero), and that the report is READ-ONLY: a report that could write the ledger would be a way to manufacture a record.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  breakevenPct, fmtMoney, parseArgs, priceBand, probBucket, quadraticFee, renderTable,
} from '../../scripts/oshal-kalshi-report';

const source = readFileSync(resolve(process.cwd(), 'scripts/oshal-kalshi-report.ts'), 'utf8');

describe('kalshi report: the cuts', () => {
  it('breakeven is the price plus the quadratic fee — 51.75% at even money, 91.6% at 90c', () => {
    expect(quadraticFee(0.5)).toBeCloseTo(0.0175, 10);
    expect(breakevenPct(0.5)).toBeCloseTo(51.75, 10);
    expect(breakevenPct(0.9)).toBeCloseTo(90.63, 2);
    expect(breakevenPct(0.05)).toBeCloseTo(5.3325, 4);
  });

  it('price bands split the board at 20/40/60/80 cents with the lower edge inclusive', () => {
    expect(priceBand(0.05)).toBe('1 longshot <20c');
    expect(priceBand(0.199)).toBe('1 longshot <20c');
    expect(priceBand(0.2)).toBe('2 20-40c');
    expect(priceBand(0.4)).toBe('3 even 40-60c');
    expect(priceBand(0.599)).toBe('3 even 40-60c');
    expect(priceBand(0.6)).toBe('4 60-80c');
    expect(priceBand(0.8)).toBe('5 favorite 80c+');
    expect(priceBand(0.98)).toBe('5 favorite 80c+');
  });

  it('confidence deciles label our own probability, top decile inclusive of 1.0', () => {
    expect(probBucket(0.95)).toBe('0.9-1.0');
    expect(probBucket(0.9)).toBe('0.9-1.0');
    expect(probBucket(1.0)).toBe('0.9-1.0');
    expect(probBucket(0.62)).toBe('0.6-0.7');
    expect(probBucket(0.1)).toBe('0.1-0.2');
    expect(probBucket(0.05)).toBe('0.0-0.1');
  });

  it('money always carries its sign and dashes when there is nothing to show', () => {
    expect(fmtMoney(-18.244)).toBe('-$18.24');
    expect(fmtMoney(5.13)).toBe('+$5.13');
    expect(fmtMoney(0)).toBe('+$0.00');
    expect(fmtMoney(null)).toBe('—');
    expect(fmtMoney(Number.NaN)).toBe('—');
  });

  it('tables right-align numeric columns and left-align text', () => {
    const t = renderTable(['strategy', 'n', 'after fee'], [['calibration', '828', '-$40.61'], ['weather-enso', '1619', '-$88.10']]);
    const lines = t.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[2]).toMatch(/^calibration\s+828\s+-\$40\.61$/);
    expect(lines[3]).toMatch(/^weather-enso\s+1619\s+-\$88\.10$/);
  });

  it('flags: strategy filter, spread in cents with a 3c fallback (never zero by accident), json', () => {
    expect(parseArgs([])).toEqual({ strategy: null, flipSpread: 3, json: false });
    expect(parseArgs(['--strategy', 'weather-enso', '--flip-spread', '6', '--json']))
      .toEqual({ strategy: 'weather-enso', flipSpread: 6, json: true });
    expect(parseArgs(['--flip-spread', 'lots']).flipSpread).toBe(3);
    expect(parseArgs(['--flip-spread', '-2']).flipSpread).toBe(3);
    expect(parseArgs(['--flip-spread', '0']).flipSpread).toBe(0);
  });
});

describe('kalshi report: read-only by construction', () => {
  it('contains no statement that could write the ledger', () => {
    expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/);
    expect(source).toMatch(/kalshi_predictions/);
    expect(source).toMatch(/kalshi_scan_alerts/);
    expect(source).toMatch(/kalshi_orders/);
  });

  it('excludes the contrarian forward tests from the as-bet cross-tabs and the flip what-if', () => {
    // Those rows are already "the other side"; folding them in would flip them back.
    const guards = source.match(/NOT strategy LIKE 'contrarian%'/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
  });

  it('only runs main when executed directly, so the spec can import the helpers', () => {
    expect(source).toContain('if (require.main === module)');
  });
});
