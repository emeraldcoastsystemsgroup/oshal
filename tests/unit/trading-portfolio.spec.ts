import { describe, expect, it } from 'vitest';
import { exitsToRun, trailingExits, nextPeaks, sizeEntry, riskPolicy, RISK_POLICIES, sectorOf, rotationBenches, rebalanceTrims, drawdownHaltTriggered, dipExits } from '../../src/features/trading/services/portfolio';
import type { NameStrength } from '../../src/features/trading/services/portfolio';
import type { BrokerAccount, Position } from '../../src/features/trading/services/broker-adapter';

const acct = (over: Partial<BrokerAccount> = {}): BrokerAccount => ({ cash: 100000, buyingPower: 100000, equity: 100000, currency: 'USD', ...over });
const pos = (symbol: string, qty: number, avgEntryPrice: number, last: number): Position => ({
  symbol, qty, avgEntryPrice, currentPrice: last, marketValue: qty * last, unrealizedPl: qty * (last - avgEntryPrice),
});
const balanced = RISK_POLICIES.balanced;

describe('portfolio money-manager', () => {
  it('defaults to the balanced posture', () => {
    delete process.env.TRADING_RISK_POSTURE;
    expect(riskPolicy().posture).toBe('balanced');
  });

  it('maps the universe to sectors', () => {
    expect(sectorOf('NVDA')).toBe('tech');
    expect(sectorOf('JPM')).toBe('financials');
    expect(sectorOf('XOM')).toBe('energy');
    expect(sectorOf('LLY')).toBe('pharma');
    expect(sectorOf('ZZZZ')).toBe('other');
  });

  it('exits a loser past the stop-loss and a winner past take-profit', () => {
    const positions = [
      pos('AAPL', 10, 100, 100 * (1 - (balanced.stopLossPct + 1) / 100)), // below stop
      pos('MSFT', 10, 100, 100 * (1 + (balanced.takeProfitPct + 1) / 100)), // above target
      pos('NVDA', 10, 100, 101), // small gain, hold
    ];
    const exits = exitsToRun(positions, balanced);
    const byReason = Object.fromEntries(exits.map((e) => [e.symbol, e.reason]));
    expect(byReason.AAPL).toBe('stop_loss');
    expect(byReason.MSFT).toBe('take_profit');
    expect(byReason.NVDA).toBeUndefined();
  });

  it('sizes an entry to the per-name cap scaled by conviction', () => {
    // balanced perName cap = 5% of 100k = $5000; full conviction → ~$5000 / $100 = 50 sh.
    const r = sizeEntry('AAPL', 100, 1, acct(), [], balanced);
    expect(r.qty).toBe(50);
    // half conviction → ~half the size.
    expect(sizeEntry('AAPL', 100, 0.5, acct(), [], balanced).qty).toBe(25);
  });

  it('refuses to add a name already held', () => {
    const r = sizeEntry('AAPL', 100, 1, acct(), [pos('AAPL', 10, 90, 100)], balanced);
    expect(r.qty).toBe(0);
    expect(r.blocked).toMatch(/holding/);
  });

  it('blocks a buy that would breach the sector cap', () => {
    // Fill tech to the 22% cap with an existing $22k NVDA position; a new tech buy has no room.
    const positions = [pos('NVDA', 220, 100, 100)]; // $22,000 = 22% of 100k
    const r = sizeEntry('AAPL', 100, 1, acct({ cash: 78000 }), positions, balanced);
    expect(r.qty).toBe(0);
    expect(r.blocked).toMatch(/sector/);
  });

  it('halts new buys when the open book is down past the daily-loss limit', () => {
    // balanced dailyLossHalt = 4% → -$4001 open P&L halts buys.
    const positions = [pos('XOM', 100, 100, 100 - 41)]; // -$4100 unrealized
    const r = sizeEntry('AAPL', 100, 1, acct(), positions, balanced);
    expect(r.qty).toBe(0);
    expect(r.blocked).toMatch(/daily-loss/);
  });

  it('respects the total-deployed cap', () => {
    // Conservative deploys max 30%, sector max 12%. Spread $30k across 3 sectors (10% each, under the
    // sector cap) so the TOTAL cap is what binds a new buy in a 4th sector.
    const c = RISK_POLICIES.conservative;
    const positions = [pos('NVDA', 100, 100, 100), pos('JPM', 100, 100, 100), pos('XOM', 100, 100, 100)]; // $30k = 30%
    const r = sizeEntry('LLY', 100, 1, acct({ cash: 70000 }), positions, c);
    expect(r.qty).toBe(0);
    expect(r.blocked).toMatch(/deployed/);
  });
});

describe('active posture + trailing stop', () => {
  const active = RISK_POLICIES.active; // arm +5%, giveback 3%, stop 5%, take-profit 8%, 32 names @ 3%

  it('is high-turnover and downside-first relative to balanced', () => {
    expect(active.maxPositions).toBeGreaterThan(balanced.maxPositions);   // more names → more trades
    expect(active.maxPerNamePct).toBeLessThanOrEqual(3);                  // small bets → diversified downside
    expect(active.takeProfitPct).toBeLessThan(balanced.takeProfitPct);   // faster rotation
    expect(active.stopLossPct).toBeLessThan(balanced.stopLossPct);       // tighter than balanced
    expect(active.takeProfitPct).toBeGreaterThan(active.stopLossPct);    // positive reward:risk
    expect(active.trailGivebackPct).toBeLessThan(active.trailArmPct);    // arm before you trail
  });

  it('honors TRADING_RISK_POSTURE=active', () => {
    process.env.TRADING_RISK_POSTURE = 'active';
    expect(riskPolicy().posture).toBe('active');
    delete process.env.TRADING_RISK_POSTURE;
  });

  it('rolls the high-water-mark forward and prunes closed names', () => {
    let peaks = nextPeaks([pos('AAPL', 10, 100, 110)], new Map());
    expect(peaks.get('AAPL')).toBe(110);
    peaks = nextPeaks([pos('AAPL', 10, 100, 106)], peaks); // price fell — peak holds at 110
    expect(peaks.get('AAPL')).toBe(110);
    expect(nextPeaks([], peaks).size).toBe(0);             // no longer held → pruned
  });

  it('trails an armed winner that gives back past the threshold', () => {
    // Entry 100 → peak 110 → now 106: up 6% (armed past +5%), giveback 3.6% (> 3%) → exit.
    const peaks = nextPeaks([pos('AAPL', 10, 100, 110)], new Map());
    const exits = trailingExits([pos('AAPL', 10, 100, 106)], peaks, active);
    expect(exits).toHaveLength(1);
    expect(exits[0].reason).toBe('trailing_stop');
  });

  it('does not trail on small wiggle or before the winner arms', () => {
    const peakHi = nextPeaks([pos('AAPL', 10, 100, 110)], new Map());
    expect(trailingExits([pos('AAPL', 10, 100, 109)], peakHi, active)).toHaveLength(0); // giveback <1%
    const peakLow = nextPeaks([pos('AAPL', 10, 100, 102)], new Map());
    expect(trailingExits([pos('AAPL', 10, 100, 101)], peakLow, active)).toHaveLength(0); // only +1% → not armed
  });
});

describe('relative-strength rotation (coach the team)', () => {
  const str = (m: Record<string, NameStrength>) => new Map(Object.entries(m));

  it('benches a cold held starter when a hotter name is on the bench', () => {
    const positions = [pos('KO', 10, 100, 100)]; // held, flat
    const strength = str({
      KO: { score: 0.05, action: 'hold' },   // cold starter
      NVDA: { score: 0.7, action: 'buy' },    // hot bench candidate (not held)
    });
    const benched = rotationBenches(positions, strength, balanced);
    expect(benched.map((b) => b.symbol)).toEqual(['KO']);
    expect(benched[0].reason).toBe('rotation');
  });

  it('does NOT bench a still-hot starter even if someone is marginally hotter', () => {
    const positions = [pos('NVDA', 10, 100, 100)];
    const strength = str({ NVDA: { score: 0.6, action: 'buy' }, AMD: { score: 0.7, action: 'buy' } });
    expect(rotationBenches(positions, strength, balanced)).toHaveLength(0); // NVDA not cold
  });

  it('does NOT bench when no bench candidate is hot enough', () => {
    const positions = [pos('KO', 10, 100, 100)];
    const strength = str({ KO: { score: 0.05, action: 'hold' }, PEP: { score: 0.2, action: 'buy' } }); // PEP < ROTATION_HOT
    expect(rotationBenches(positions, strength, balanced)).toHaveLength(0);
  });

  it('caps swaps per fire and benches the coldest first', () => {
    const positions = ['KO', 'PG', 'CL', 'MMM', 'MO'].map((s) => pos(s, 10, 100, 100));
    const strength = str({
      KO: { score: 0.10, action: 'hold' }, PG: { score: -0.30, action: 'sell' }, CL: { score: 0.00, action: 'hold' },
      MMM: { score: 0.12, action: 'hold' }, MO: { score: 0.05, action: 'hold' },
      NVDA: { score: 0.9, action: 'buy' }, AMD: { score: 0.85, action: 'buy' }, AVGO: { score: 0.8, action: 'buy' },
    });
    const benched = rotationBenches(positions, strength, balanced); // balanced max 16 → cap = 4
    expect(benched.length).toBeLessThanOrEqual(4);
    expect(benched[0].symbol).toBe('PG'); // coldest (most negative) benched first
  });
});

describe('cap-breach trims (rebalance over-concentration)', () => {
  const active = RISK_POLICIES.active; // per-name cap 3% of equity

  it('trims a name grown past the per-name cap back toward the cap', () => {
    // active cap = 3% of 100k = $3000. TFC 140sh @ $40 = $5600 → excess $2600 → ~65 sh trimmed.
    const trims = rebalanceTrims([pos('TFC', 140, 40, 40)], 100000, active);
    expect(trims).toHaveLength(1);
    expect(trims[0].symbol).toBe('TFC');
    expect(trims[0].reason).toBe('cap_trim');
    expect(trims[0].qty).toBe(65); // floor((5600-3000)/40)
  });

  it('leaves a name within its cap alone', () => {
    // 70sh @ $40 = $2800 < $3000 cap → no trim.
    expect(rebalanceTrims([pos('TFC', 70, 40, 40)], 100000, active)).toHaveLength(0);
  });

  it('never flattens a position via a trim (keeps at least the capped core)', () => {
    // A 1-share position can never be trimmed below 1.
    expect(rebalanceTrims([pos('TFC', 1, 40, 40)], 100000, active)).toHaveLength(0);
  });

  it('values the breach on current price, not entry', () => {
    // Bought 100sh @ $20 ($2000, under cap), ran to $40 → now $4000 > $3000 → trims the run-up.
    const trims = rebalanceTrims([pos('TFC', 100, 20, 40)], 100000, active);
    expect(trims).toHaveLength(1);
    expect(trims[0].qty).toBe(25); // floor((4000-3000)/40)
  });
});

describe('extended-hours defensive dip exits (off-hours doctrine)', () => {
  const closes = new Map([['AMD', 552.24], ['MU', 985.78], ['JNJ', 259.28]]);

  it('sells a full position printing past the dip line off its regular close', () => {
    const positions = [
      pos('AMD', 19, 563.32, 529.89),  // -4.0% off close → sell all
      pos('JNJ', 27, 255.01, 259.00),  // -0.1% off close → hold
    ];
    const exits = dipExits(positions, closes, 0.5);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ symbol: 'AMD', qty: 19, reason: 'ext_dip' });
  });

  it('triggers exactly at the line, not above it', () => {
    const atLine = [pos('MU', 7, 996.49, 985.78 * 0.995)];
    const above = [pos('MU', 7, 996.49, 985.78 * 0.9951)];
    expect(dipExits(atLine, closes, 0.5)).toHaveLength(1);
    expect(dipExits(above, closes, 0.5)).toHaveLength(0);
  });

  it('never sells without a price or a close anchor, and ignores shorts', () => {
    const noAnchor = [pos('ZZZZ', 5, 100, 90)];               // no prior close known
    const noPrice = [{ ...pos('AMD', 19, 563.32, 500), currentPrice: undefined }];
    const short = [pos('AMD', -19, 563.32, 500)];
    expect(dipExits(noAnchor, closes, 0.5)).toHaveLength(0);
    expect(dipExits(noPrice as Position[], closes, 0.5)).toHaveLength(0);
    expect(dipExits(short, closes, 0.5)).toHaveLength(0);
  });
});

describe('account-drawdown circuit breaker', () => {
  it('halts new entries once equity falls past maxDrawdownPct below the high-water mark', () => {
    const b = RISK_POLICIES.balanced; // maxDrawdownPct 12
    expect(drawdownHaltTriggered(100000, 100000, b)).toBe(false); // at the high
    expect(drawdownHaltTriggered(90000, 100000, b)).toBe(false);  // -10% < 12% → still trading
    expect(drawdownHaltTriggered(88000, 100000, b)).toBe(true);   // -12% → halt
    expect(drawdownHaltTriggered(80000, 100000, b)).toBe(true);   // -20% → halt
    expect(drawdownHaltTriggered(100000, 0, b)).toBe(false);      // no HWM yet → never halts
  });

  it('uses the posture-specific drawdown limit', () => {
    expect(drawdownHaltTriggered(94000, 100000, RISK_POLICIES.active)).toBe(false);     // -6% < 10%
    expect(drawdownHaltTriggered(89000, 100000, RISK_POLICIES.active)).toBe(true);      // -11% > 10%
    expect(drawdownHaltTriggered(80000, 100000, RISK_POLICIES.aggressive)).toBe(false); // -20% < 25%
  });
});
