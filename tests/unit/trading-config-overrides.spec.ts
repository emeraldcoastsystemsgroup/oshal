/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-095 overlay math: effectiveCorePct applyPct scaling, overlayCoreEntries exemption-hold preservation, overlayRotationKnobs rotation/ensemble ownership, riskPolicy PolicyOverride precedence (incl. explicit-null tp), and the no-override = env-identical invariants on coreConfig/rotationConfig.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  effectiveCorePct, overlayCoreEntries, overlayRotationKnobs, policyOverrideOf,
  type ConfigOverrideRow,
} from '../../src/app/trading-config-overrides';
import { coreConfig, rotationConfig } from '../../src/app/trading-schedule-dispatch';
import { riskPolicy } from '../../src/features/trading/services/portfolio';
import type { StrategyConfig } from '../../src/app/trading-strategy-lab-sim';

const cfg = (over: Partial<StrategyConfig> = {}): StrategyConfig => ({
  kind: 'rotation', posture: 'active', corePct: 60, coreSymbol: 'SPY', takeProfitPct: null,
  rank: 'gravity', cadenceDays: 1, topN: 12, weighting: 'conviction', universe: [],
  warmupDays: 80, windowDays: 780, ...over,
});
const row = (config: StrategyConfig, applyPct = 100): ConfigOverrideRow => ({
  id: 'o1', strategyId: 's1', strategyName: 'test strategy', config, applyPct,
  active: true, note: '', createdAt: '2026-07-13', deactivatedAt: null,
});

const ENV_KEYS = [
  'TRADING_CORE_SYMBOLS', 'TRADING_CORE_TARGET_PCT',
  'TRADING_SLEEVE_ROTATION', 'TRADING_ROTATION_RANK', 'TRADING_ROTATION_EVERY_DAYS',
  'TRADING_ROTATION_TOPN', 'TRADING_ROTATION_WEIGHTING', 'TRADING_ROTATION_EXT_HOURS',
  'TRADING_RISK_POSTURE', 'TRADING_RISK_POSTURE_LIVE', 'TRADING_TAKE_PROFIT_PCT',
];

beforeEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

describe('effectiveCorePct (applyPct scales the designed sleeve share)', () => {
  it('100% = the strategy exactly as designed', () => {
    expect(effectiveCorePct(cfg({ corePct: 60 }), 100)).toBe(60);
    expect(effectiveCorePct(cfg({ corePct: 0 }), 100)).toBe(0);
  });
  it('50% of a 40-point sleeve parks the other half in the core', () => {
    expect(effectiveCorePct(cfg({ corePct: 60 }), 50)).toBe(80); // sleeve 40 → 20, core 80
  });
  it('25% of a full-deploy strategy runs a 75% core', () => {
    expect(effectiveCorePct(cfg({ corePct: 0 }), 25)).toBe(75);
  });
  it('clamps junk applyPct to sane bounds', () => {
    expect(effectiveCorePct(cfg({ corePct: 60 }), 0)).toBe(60);   // 0/NaN → 100
    expect(effectiveCorePct(cfg({ corePct: 60 }), NaN)).toBe(60);
    expect(effectiveCorePct(cfg({ corePct: 60 }), 500)).toBe(60); // >100 → 100
  });
});

describe('overlayCoreEntries (operator :0 holds always survive)', () => {
  const envMap = (): Map<string, number> => new Map([['SPY', 60], ['SKHYV', 0], ['SKHY', 0]]);
  it('no override → the env map untouched (same reference)', () => {
    const m = envMap();
    expect(overlayCoreEntries(m, null)).toBe(m);
  });
  it('strategy owns the core target; exemption holds preserved', () => {
    const m = overlayCoreEntries(envMap(), row(cfg({ corePct: 60 }), 100));
    expect(m.get('SPY')).toBe(60);
    expect(m.get('SKHYV')).toBe(0);
    expect(m.get('SKHY')).toBe(0);
  });
  it('applyPct raises the effective core', () => {
    const m = overlayCoreEntries(envMap(), row(cfg({ corePct: 60 }), 50));
    expect(m.get('SPY')).toBe(80);
  });
  it('a full-deploy strategy at 100% removes the env core target but keeps the holds', () => {
    const m = overlayCoreEntries(envMap(), row(cfg({ corePct: 0 }), 100));
    expect(m.has('SPY')).toBe(false);
    expect(m.get('SKHYV')).toBe(0);
  });
  it('a non-SPY env core target is replaced by the strategy core symbol', () => {
    const m = overlayCoreEntries(new Map([['QQQ', 30]]), row(cfg({ corePct: 40, coreSymbol: 'SPY' }), 100));
    expect(m.has('QQQ')).toBe(false);
    expect(m.get('SPY')).toBe(40);
  });
});

describe('overlayRotationKnobs (kind decides who owns the sleeve)', () => {
  const base = { enabled: false, everyDays: 5, topN: 0, rank: 'blend', weighting: 'conviction', extHours: false };
  it('no override → base unchanged', () => {
    expect(overlayRotationKnobs(base, null)).toBe(base);
  });
  it('a rotation strategy enables rotation with its own knobs (extHours stays env)', () => {
    const k = overlayRotationKnobs({ ...base, extHours: true }, row(cfg({ rank: 'momentum', cadenceDays: 3, topN: 8, weighting: 'equal' })));
    expect(k).toEqual({ enabled: true, everyDays: 3, topN: 8, rank: 'momentum', weighting: 'equal', extHours: true });
  });
  it('an ensemble strategy turns rotation OFF even when env has it on', () => {
    const k = overlayRotationKnobs({ ...base, enabled: true }, row(cfg({ kind: 'ensemble' })));
    expect(k.enabled).toBe(false);
    expect(k.rank).toBe(base.rank); // rest untouched
  });
});

describe('riskPolicy PolicyOverride precedence', () => {
  it('no override → env behavior unchanged', () => {
    process.env.TRADING_RISK_POSTURE = 'active';
    process.env.TRADING_TAKE_PROFIT_PCT = '25';
    const p = riskPolicy('paper', policyOverrideOf(null));
    expect(p.posture).toBe('active');
    expect(p.takeProfitPct).toBe(25);
  });
  it('override posture beats both env postures on both books', () => {
    process.env.TRADING_RISK_POSTURE = 'active';
    process.env.TRADING_RISK_POSTURE_LIVE = 'aggressive';
    const ov = policyOverrideOf(row(cfg({ posture: 'balanced' })));
    expect(riskPolicy('paper', ov).posture).toBe('balanced');
    expect(riskPolicy('live', ov).posture).toBe('balanced');
  });
  it('override tp null = posture default, DEFEATING an env TRADING_TAKE_PROFIT_PCT', () => {
    process.env.TRADING_RISK_POSTURE = 'balanced';
    process.env.TRADING_TAKE_PROFIT_PCT = '25';
    const p = riskPolicy('paper', policyOverrideOf(row(cfg({ posture: 'balanced', takeProfitPct: null }))));
    expect(p.takeProfitPct).toBe(20); // the balanced posture's own tp, not the env 25
  });
  it('override tp number wins outright and clamps to 95', () => {
    const p = riskPolicy('paper', policyOverrideOf(row(cfg({ takeProfitPct: 33 }))));
    expect(p.takeProfitPct).toBe(33);
    expect(riskPolicy('paper', { takeProfitPct: 400 }).takeProfitPct).toBe(95);
  });
});

describe('config resolvers stay env-identical without an override', () => {
  it('coreConfig(null) === coreConfig() shape', () => {
    process.env.TRADING_CORE_SYMBOLS = 'SPY:60,SKHYV:0';
    const a = coreConfig();
    const b = coreConfig(null);
    expect(b.targetPct).toBe(a.targetPct);
    expect([...b.perSymbolPct.entries()]).toEqual([...a.perSymbolPct.entries()]);
  });
  it('coreConfig(override) merges strategy target with env holds', () => {
    process.env.TRADING_CORE_SYMBOLS = 'SPY:60,SKHYV:0,SKHY:0';
    const c = coreConfig(row(cfg({ corePct: 60 }), 50));
    expect(c.perSymbolPct.get('SPY')).toBe(80);
    expect(c.perSymbolPct.get('SKHYV')).toBe(0);
    expect(c.targetPct).toBe(80);
  });
  it('rotationConfig(override) flips rotation on with the strategy knobs', () => {
    process.env.TRADING_SLEEVE_ROTATION = 'false';
    const k = rotationConfig(row(cfg({ rank: 'gravity', cadenceDays: 1, topN: 12 })));
    expect(k.enabled).toBe(true);
    expect(k.rank).toBe('gravity');
    expect(k.everyDays).toBe(1);
    expect(k.topN).toBe(12);
  });
});
