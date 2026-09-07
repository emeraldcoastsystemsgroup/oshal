/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Round-2 review fixes, each with the boundary that proves it: real child processes drive Invoke-WdExec (empty output, non-zero exit, a DEADLINE that kills a hung child, a refused argument) instead of a stubbed PowerShell function no timeout could kill; the threshold-precedence lines are executed under real powershell against a real .env so the ORDER is pinned (AlertPct before LiveAlertPct - the other way round left the Schwab books on the param default); the core-hold section is executed with a failing exec to prove $coreKnown withholds every core-exempting check; the ps1's docker invocations are enumerated from the real PowerShell AST rather than a regex a `try { $x = docker exec ... }` site could slip past; the container-side fetcher's per-read deadline is proven against a REAL hanging http server (one wedged book errors, the others are still audited); plus the hysteresis band measured from the last alert and the materiality of the position-count floor.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Round-3 review fixes, each proven where it broke. The fetcher case that mattered is reproduced at the SHIPPED per-read cap: three wedged books plus a healthy one against the real hanging server must finish inside the audit budget and the healthy book must still be audited (the round-2 case only passed because it shrank the per-read cap to 1s, hiding that 3 books x 20s x 2 attempts overruns the 60s host deadline); a mutation removes the per-book clamp and asserts the same run overruns. Get-WdAuditBudgetSec is executed under real powershell to pin budget < deadline. docker cp is driven as a REAL child process for its three outcomes (clean exit, non-zero exit, a killed hang) and for the caller-owned alert key, and the AST walk now requires ZERO raw docker cp sites. The block-G withholding is EXECUTED over the marker-wrapped gate for all four (checksReady, coreKnown) combinations plus the failed-roster fallback, instead of being pinned by exact source text. Plus: a Windows path survives ConvertTo-WdArgLine while a trailing backslash is still refused, an unreadable suppression-state file surfaces as a warning, the two account findings re-page when they double, and dust no longer produces warnings.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the guard for the watchdog's DECIDABLE checks (scripts/lib/trading-watchdog-checks.js) and the PowerShell plumbing that carries them. Every check is MUTATION-PROVED: the shipped module's bytes are read, one condition is inverted or removed, the mutant is loaded from a temp file, and the case asserts the mutant no longer reports the finding (so a guard that could not fail is impossible) - the repo file is never written and its sha256 is compared before and after. Plus the real boundaries: a REAL http server standing in for the api proves the container-side fetcher's fail-closed reads, the ?book= query-first param and the trusted-service headers; REAL powershell.exe executes the ps1's own settings/exec/symbol-state sections against a real .env and a real state file (empty exec -> check-infra, .env precedence, corrupt state file); and the whole ps1 is parsed by the real PowerShell parser. Threshold floors are re-derived from src/features/trading/services/portfolio.ts so a posture change cannot silently start paging.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const modulePath = join(root, 'scripts', 'lib', 'trading-watchdog-checks.js');
const watchdogPath = join(root, 'scripts', 'trading-watchdog.ps1');
const moduleSource = readFileSync(modulePath, 'utf8');
const watchdogSource = readFileSync(watchdogPath, 'utf8');
const moduleHashBefore = createHash('sha256').update(readFileSync(modulePath)).digest('hex');
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const scratch = mkdtempSync(join(tmpdir(), 'oshal-wd-checks-'));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const C = require(modulePath);

const NOW = Date.parse('2026-09-04T15:00:00.000Z');
const minutesAgo = (n: number): string => new Date(NOW - n * 60_000).toISOString();

/**
 * Loads a MUTANT copy of the shipped module: one exact substring replaced. The repo file is never
 * touched (its hash is asserted unchanged at the end of the run) - the mutant lives in the scratch
 * dir. A mutation whose `from` text is absent throws, so a refactor that renames the guarded line
 * fails loudly instead of quietly proving nothing.
 */
const mutant = (from: string, to: string): any => {
  expect(moduleSource.split(from).length - 1, `mutation anchor is not unique: ${from}`).toBe(1);
  const file = join(scratch, `mutant-${createHash('sha1').update(from + to).digest('hex').slice(0, 10)}.js`);
  writeFileSync(file, moduleSource.replace(from, to));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(file);
};

const position = (symbol: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ symbol, qty: 100, avgEntryPrice: 100, marketValue: 10_000, unrealizedPl: 0, ...over });
const order = (symbol: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ symbol, side: 'sell', status: 'accepted', qty: '10.000000', limit_price: null, created_at: minutesAgo(5), ...over });

const settings = (over: Record<string, unknown> = {}): any => Object.assign(
  C.defaultSettings({}), { core: new Set<string>(), rth: true, nowMs: NOW }, over);
const BOOK = { ref: 'b-spec', enabled: true };
const kindsOf = (r: { findings: Array<{ kind: string }> }): string[] => r.findings.map((f) => f.kind).sort();

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  expect(createHash('sha256').update(readFileSync(modulePath)).digest('hex'),
    'the mutation cases must never write to the shipped module').toBe(moduleHashBefore);
});

describe('watchdog checks: broker numbers never read as healthy', () => {
  it('parses real broker shapes and REFUSES everything else', () => {
    expect(C.toNumber(12.5, 'x')).toBe(12.5);
    expect(C.toNumber('73.000000', 'x')).toBe(73); // the ledger's numeric-as-string shape
    expect(C.toNumber('-1.5e2', 'x')).toBe(-150);
    for (const bad of [NaN, Infinity, null, undefined, '', ' ', 'N/A', '1,234', '12abc', {}, []]) {
      expect(() => C.toNumber(bad as never, 'AAPL.qty'), `${JSON.stringify(bad)} must not parse`).toThrow(/unparseable AAPL\.qty/);
    }
  });

  it('a NaN in ANY position number fails the whole book closed instead of reporting no findings', () => {
    const data = { account: { cash: 1, buyingPower: 1, equity: 100_000 }, positions: [position('AAPL', { unrealizedPl: 'N/A' })], orders: [] };
    expect(() => C.evaluateBook(BOOK, data, settings())).toThrow(C.WatchdogDataError);
  });

  it('an error payload (a 503 body) is NOT an empty healthy book', () => {
    expect(() => C.workingSellSymbols({ error: 'broker_not_configured' } as never)).toThrow(/missing orders/);
    expect(() => C.normalizePositions(undefined as never)).toThrow(/missing positions/);
    expect(() => C.assessAccount(null, [], { maxPositions: 40, concentrationPct: 25, core: new Set() })).toThrow(/missing account/);
  });

  it('MUTATION: dropping the strict numeric test makes the NaN book read clean', () => {
    const M = mutant([
      "  if (typeof value === 'string' && NUMERIC.test(value.trim())) {",
      "    const n = Number(value.trim());",
      "    if (!Number.isFinite(n)) throw new WatchdogDataError('unparseable ' + field + ': ' + value);",
      '    return n;',
      '  }',
    ].join('\n'), "  if (typeof value === 'string') { return Number(value.trim()) || 0; }");
    const data = { account: { cash: 1, buyingPower: 1, equity: 100_000 }, positions: [position('AAPL', { unrealizedPl: 'N/A' })], orders: [] };
    expect(M.evaluateBook(BOOK, data, settings()).findings).toEqual([]);
  });
});

describe('watchdog checks: one shared working-order-status list', () => {
  it('a sell is protective only while it is WORKING', () => {
    expect(C.isWorkingSell(order('AAPL', { status: 'accepted' }))).toBe(true);
    expect(C.isWorkingSell(order('AAPL', { status: 'PARTIALLY_FILLED' }))).toBe(true);
    for (const status of ['filled', 'rejected', 'canceled', '', undefined]) {
      expect(C.isWorkingSell(order('AAPL', { status })), `${status} must not count as protection`).toBe(false);
    }
    expect(C.isWorkingSell(order('AAPL', { side: 'buy' }))).toBe(false);
  });

  it('does not drift from the kernel status lists it mirrors', () => {
    // The kernel keeps its own copies (trading-dispatch-rail IN_FLIGHT_STATUSES, trading-reconcile
    // OPEN_STATUSES). This is the WATCHDOG's single copy, not a platform-wide source of truth -
    // the guard exists so a kernel change is caught here instead of silently disagreeing.
    const kernel: string[][] = [];
    for (const file of ['trading-dispatch-rail.ts', 'trading-reconcile.ts']) {
      const text = readFileSync(join(root, 'src', 'app', file), 'utf8');
      for (const m of text.matchAll(/(?:IN_FLIGHT_STATUSES|OPEN_STATUSES)\s*=\s*\[([^\]]+)\]/g)) {
        kernel.push(m[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
      }
    }
    expect(kernel.length, 'neither kernel status list was found - the watchdog copy is unpinned').toBeGreaterThanOrEqual(2);
    for (const list of kernel) expect(list).toEqual(C.WORKING_ORDER_STATUSES);
  });
});

describe('watchdog checks: what a silently-wrong book looks like', () => {
  const healthy = {
    account: { cash: 5_000, buyingPower: 10_000, equity: 100_000 },
    positions: [position('AAPL', { unrealizedPl: -100 }), position('MSFT', { unrealizedPl: 500 })],
    orders: [order('MSFT', { status: 'filled' })],
  };

  it('a healthy book yields NO findings at all', () => {
    const r = C.evaluateBook(BOOK, healthy, settings());
    expect(r.findings).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.positionCount).toBe(2);
  });

  it('unprotected bleeder: down past the threshold with no working sell', () => {
    const data = { ...healthy, positions: [position('AAPL', { unrealizedPl: -900 })] };
    const r = C.evaluateBook(BOOK, data, settings());
    expect(kindsOf(r)).toEqual(['bleed']);
    expect(r.findings[0].key).toBe('bleed-b-spec-AAPL');
    expect(r.findings[0].message).toContain('b-spec');
    // A working sell for the same name means it is covered; a FILLED one does not.
    const covered = C.evaluateBook(BOOK, { ...data, orders: [order('AAPL')] }, settings());
    expect(covered.findings).toEqual([]);
  });

  it('MUTATION: removing the working-sell exclusion makes the covered position alert', () => {
    const M = mutant('.filter((p) => p.plPct !== null && p.plPct <= -alertPct && !sells.has(p.symbol) && !core.has(p.symbol))',
      '.filter((p) => p.plPct !== null && p.plPct <= -alertPct && !core.has(p.symbol))');
    const data = { ...healthy, positions: [position('AAPL', { unrealizedPl: -900 })], orders: [order('AAPL')] };
    expect(kindsOf(M.evaluateBook(BOOK, data, settings()))).toEqual(['bleed']);
  });

  it('held past the stop: deeper than every shipped posture, reported even WITH a resting sell', () => {
    const data = { ...healthy, positions: [position('AAPL', { unrealizedPl: -2_500 })], orders: [order('AAPL')] };
    const r = C.evaluateBook(BOOK, data, settings());
    expect(kindsOf(r)).toEqual(['deep-loss']);
    expect(r.findings[0].message).toContain('HOLDING PAST ITS STOP');
  });

  it('MUTATION: inverting the deep-loss comparison stops reporting the held position', () => {
    const M = mutant('.filter((p) => p.plPct !== null && p.plPct <= -deepLossPct && !core.has(p.symbol))',
      '.filter((p) => p.plPct !== null && p.plPct >= -deepLossPct && !core.has(p.symbol))');
    const data = { ...healthy, positions: [position('AAPL', { unrealizedPl: -2_500 })], orders: [order('AAPL')] };
    expect(kindsOf(M.evaluateBook(BOOK, data, settings())).includes('deep-loss')).toBe(false);
  });

  it('worthless and core holdings never page (real box shapes: a $0.04 delisted lot, a :0 operator hold)', () => {
    const dust = position('HMNY', { qty: 42_689, avgEntryPrice: 0.093863, marketValue: 0.04, unrealizedPl: -4_006.87 });
    const core = position('SKHY', { unrealizedPl: -2_500 });
    const r = C.evaluateBook(BOOK, { ...healthy, positions: [dust, core] }, settings({ core: C.coreSymbolSet('SKHY:0,SPY:60') }));
    expect(r.findings).toEqual([]);
  });

  it('MUTATION: removing the materiality floor pages on the $0.04 delisted lot', () => {
    const M = mutant('return positions.filter((p) => Math.abs(p.marketValue) >= minValueUsd);', 'return positions;');
    const dust = position('HMNY', { qty: 42_689, avgEntryPrice: 0.093863, marketValue: 0.04, unrealizedPl: -4_006.87 });
    expect(kindsOf(M.evaluateBook(BOOK, { ...healthy, positions: [dust] }, settings()))).toEqual(['bleed', 'deep-loss']);
  });

  it('stranded sell: a working sell older than the age floor, at any hour', () => {
    const data = { ...healthy, orders: [order('AAPL', { created_at: minutesAgo(45) }), order('MSFT', { created_at: minutesAgo(5) })] };
    const r = C.evaluateBook(BOOK, data, settings({ rth: false }));
    expect(kindsOf(r)).toEqual(['stranded-sell']);
    expect(r.findings[0].key).toBe('stranded-sell-b-spec-AAPL');
    expect(() => C.findStrandedSells([order('AAPL', { created_at: 'never' })], NOW, 30)).toThrow(/unparseable created_at/);
  });

  it('MUTATION: dropping the age comparison strands nothing', () => {
    const M = mutant('if (ageMin > maxAgeMin) {', 'if (false) {');
    const data = { ...healthy, orders: [order('AAPL', { created_at: minutesAgo(45) })] };
    expect(M.evaluateBook(BOOK, data, settings()).findings).toEqual([]);
  });

  it('negative buying power / negative cash', () => {
    const r = C.evaluateBook(BOOK, { ...healthy, account: { cash: 10, buyingPower: -250, equity: 100_000 } }, settings());
    expect(kindsOf(r)).toEqual(['acct-negative-funds']);
    expect(r.findings[0].key).toBe('acct-negative-funds-b-spec');
    const cashOnly = C.evaluateBook(BOOK, { ...healthy, account: { cash: -5, buyingPower: 10, equity: 100_000 } }, settings());
    expect(kindsOf(cashOnly)).toEqual(['acct-negative-funds']);
  });

  it('the two ACCOUNT findings carry a worsening band, so a deepening hole re-pages', () => {
    // Round-3 review: with band null a book could go from -$100 to -$100,000 of buying power, or
    // from 41 to 400 open positions, and stay silent for the rest of the 60-minute window.
    const scope = { refs: ['b-spec'], kinds: C.evaluatedKinds(true) };
    const funds = (bp: number): any => C.evaluateBook(BOOK, { ...healthy, account: { cash: 10, buyingPower: bp, equity: 100_000 } }, settings()).findings;
    expect(funds(-100)[0].band).toBe(50);
    const first = C.decideAlerts({}, funds(-100), { nowMs: NOW, windowMin: 60, scope });
    expect(first.alerts.map((a: { key: string }) => a.key)).toEqual(['acct-negative-funds-b-spec']);
    // Slightly worse inside the window is still one page; a hole that DOUBLED pages again.
    expect(C.decideAlerts(first.state, funds(-150), { nowMs: NOW + 600_000, windowMin: 60, scope }).alerts).toEqual([]);
    expect(C.decideAlerts(first.state, funds(-100_000), { nowMs: NOW + 600_000, windowMin: 60, scope })
      .alerts.map((a: { key: string }) => a.key)).toEqual(['acct-negative-funds-b-spec']);
    const many = (n: number): any => C.evaluateBook(BOOK, { ...healthy, positions: Array.from({ length: n }, (_, i) => position(`S${i}`, { marketValue: 1_000 })) }, settings()).findings;
    expect(many(41)[0].band).toBe(10);
    const counted = C.decideAlerts({}, many(41), { nowMs: NOW, windowMin: 60, scope });
    expect(C.decideAlerts(counted.state, many(45), { nowMs: NOW + 600_000, windowMin: 60, scope }).alerts).toEqual([]);
    expect(C.decideAlerts(counted.state, many(60), { nowMs: NOW + 600_000, windowMin: 60, scope })
      .alerts.map((a: { key: string }) => a.key)).toEqual(['acct-position-count-b-spec']);
  });

  it('MUTATION: dropping the negative-funds band re-suppresses a hole that grew 1000x', () => {
    const M = mutant(`out.push(finding('acct-negative-funds', ref, null, hole, hole / 2,`, `out.push(finding('acct-negative-funds', ref, null, hole, null,`);
    const scope = { refs: ['b-spec'], kinds: C.evaluatedKinds(true) };
    const funds = (bp: number): any => M.evaluateBook(BOOK, { ...healthy, account: { cash: 10, buyingPower: bp, equity: 100_000 } }, settings()).findings;
    const first = M.decideAlerts({}, funds(-100), { nowMs: NOW, windowMin: 60, scope });
    expect(M.decideAlerts(first.state, funds(-100_000), { nowMs: NOW + 600_000, windowMin: 60, scope }).alerts).toEqual([]);
  });

  it('MUTATION: flipping the negative-funds test hides a negative account', () => {
    const M = mutant('negativeBuyingPower: buyingPower < 0, negativeCash: cash < 0,', 'negativeBuyingPower: false, negativeCash: false,');
    expect(M.evaluateBook(BOOK, { ...healthy, account: { cash: 10, buyingPower: -250, equity: 100_000 } }, settings()).findings).toEqual([]);
  });

  it('position count over the anomaly floor', () => {
    const many = Array.from({ length: 41 }, (_, i) => position(`S${i}`, { marketValue: 1_000 }));
    const r = C.evaluateBook(BOOK, { ...healthy, positions: many }, settings());
    expect(kindsOf(r)).toEqual(['acct-position-count']);
    // 31 open names is the real paper book today and must stay quiet.
    expect(C.evaluateBook(BOOK, { ...healthy, positions: many.slice(0, 31) }, settings()).findings).toEqual([]);
  });

  it('the position-count floor counts MATERIAL positions only', () => {
    // 41 worthless dust lots are not a runaway entry loop; the materiality floor that keeps them out
    // of the loss checks keeps them out of the anomaly floor too.
    const dust = Array.from({ length: 41 }, (_, i) => position(`D${i}`, { marketValue: 0.04, qty: 1 }));
    expect(C.evaluateBook(BOOK, { ...healthy, positions: dust }, settings()).findings).toEqual([]);
  });

  it('MUTATION: relaxing the count comparison hides a runaway entry loop', () => {
    const M = mutant('positionCount: held.length, positionCountOver: held.length > limits.maxPositions,',
      'positionCount: held.length, positionCountOver: false,');
    const many = Array.from({ length: 41 }, (_, i) => position(`S${i}`, { marketValue: 1_000 }));
    expect(M.evaluateBook(BOOK, { ...healthy, positions: many }, settings()).findings).toEqual([]);
  });

  it('single-name concentration, with core holds exempt', () => {
    const heavy = position('NVDA', { marketValue: 40_000 });
    const r = C.evaluateBook(BOOK, { ...healthy, positions: [heavy] }, settings());
    expect(kindsOf(r)).toEqual(['acct-concentration']);
    expect(r.findings[0].key).toBe('acct-concentration-b-spec-NVDA');
    expect(C.evaluateBook(BOOK, { ...healthy, positions: [heavy] }, settings({ core: C.coreSymbolSet('NVDA:0') })).findings).toEqual([]);
  });

  it('MUTATION: dropping the weight comparison hides a 40 percent single name', () => {
    const M = mutant('.filter((p) => !limits.core.has(p.symbol) && (Math.abs(p.marketValue) / equity) * 100 > limits.concentrationPct)',
      '.filter((p) => !limits.core.has(p.symbol) && false)');
    expect(M.evaluateBook(BOOK, { ...healthy, positions: [position('NVDA', { marketValue: 40_000 })] }, settings()).findings).toEqual([]);
  });

  it('outside regular hours only the always-true checks run', () => {
    const data = { ...healthy, positions: [position('AAPL', { unrealizedPl: -2_500 })], orders: [order('AAPL', { created_at: minutesAgo(45) })] };
    expect(kindsOf(C.evaluateBook(BOOK, data, settings({ rth: false })))).toEqual(['stranded-sell']);
    expect(kindsOf(C.evaluateBook(BOOK, data, settings({ rth: true })))).toEqual(['deep-loss', 'stranded-sell']);
    expect(C.evaluatedKinds(false)).not.toContain('deep-loss');
    expect(C.evaluatedKinds(true)).toEqual(expect.arrayContaining(['bleed', 'deep-loss']));
  });

  it('a DISABLED book is still audited, and its message says so', () => {
    const data = { ...healthy, account: { cash: -1, buyingPower: -1, equity: 100_000 } };
    const r = C.evaluateBook({ ref: 'b-off', enabled: false }, data, settings());
    expect(r.findings[0].message).toContain('this book is DISABLED');
    expect(r.findings[0].message).toContain('protective exits still run');
  });

  it('a position with no cost basis is a WARNING, never a silent pass', () => {
    const r = C.evaluateBook(BOOK, { ...healthy, positions: [position('AAPL', { avgEntryPrice: 0, unrealizedPl: -5_000 })] }, settings());
    expect(r.warnings.join(' ')).toContain('no cost basis');
  });

  it('dust does not even produce a WARNING (the materiality floor covers both)', () => {
    // A book of delisted zero-basis lots used to emit one 'audit warning:' line per lot, which is
    // how a log stops being read. A MATERIAL position with no cost basis still warns.
    const dust = Array.from({ length: 40 }, (_, i) => position(`D${i}`, { avgEntryPrice: 0, marketValue: 0.04, qty: 1 }));
    expect(C.evaluateBook(BOOK, { ...healthy, positions: dust }, settings()).warnings).toEqual([]);
    const real = C.evaluateBook(BOOK, { ...healthy, positions: [position('AAPL', { avgEntryPrice: 0, marketValue: 5_000 })] }, settings());
    expect(real.warnings.join(' ')).toContain('no cost basis');
  });

  it('every finding kind the evaluator can emit is inside the reconciliation scope', () => {
    const data = {
      account: { cash: -1, buyingPower: -1, equity: 10_000 },
      positions: [position('AAPL', { unrealizedPl: -2_500 }), position('NVDA', { marketValue: 9_000, unrealizedPl: -800 })],
      orders: [order('TSLA', { created_at: minutesAgo(90) })],
    };
    const kinds = new Set(C.evaluateBook(BOOK, data, settings()).findings.map((f: { kind: string }) => f.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(4);
    for (const k of kinds) expect(C.evaluatedKinds(true)).toContain(k);
  });
});

describe('watchdog checks: the floors sit above every shipped risk posture', () => {
  it('re-derives the caps from portfolio.ts rather than trusting a typed number', () => {
    const text = readFileSync(join(root, 'src', 'features', 'trading', 'services', 'portfolio.ts'), 'utf8');
    const grab = (field: string): number[] => [...text.matchAll(new RegExp(`${field}:\\s*([0-9.]+)`, 'g'))].map((m) => Number(m[1]));
    const stops = grab('stopLossPct'); const counts = grab('maxPositions'); const names = grab('maxPerNamePct');
    expect(stops.length * counts.length * names.length, 'portfolio.ts postures could not be read').toBeGreaterThan(0);
    const d = C.defaultSettings({});
    expect(d.deepLossPct).toBeGreaterThan(Math.max(...stops));
    expect(d.maxPositions).toBeGreaterThan(Math.max(...counts));
    expect(d.concentrationPct).toBeGreaterThan(Math.max(...names));
  });

  it('settings are configuration: a supplied value wins, a junk value falls back to the default', () => {
    expect(C.defaultSettings({ deepLossPct: '12.5' }).deepLossPct).toBe(12.5);
    expect(C.defaultSettings({ deepLossPct: 'abc' }).deepLossPct).toBe(C.defaultSettings({}).deepLossPct);
    expect(C.defaultSettings({ deepLossPct: null }).deepLossPct).toBe(C.defaultSettings({}).deepLossPct);
  });

  it('a junk setting is REPORTED, not silently defaulted', () => {
    const seen: Array<[string, unknown]> = [];
    const d = C.defaultSettings({ deepLossPct: 'abc', maxPositions: 12 }, (k: string, v: unknown) => seen.push([k, v]));
    expect(seen).toEqual([['deepLossPct', 'abc']]);
    expect(d.deepLossPct).toBe(C.defaultSettings({}).deepLossPct);
    expect(d.maxPositions).toBe(12);
  });
});

describe('watchdog checks: per-symbol suppression with hysteresis', () => {
  const scope = { refs: ['b-spec'], kinds: C.evaluatedKinds(true) };
  const f = (severity: number, symbol = 'AAPL'): any => C.finding('bleed', 'b-spec', symbol, severity, 3, 'msg ' + severity);

  it('raises once, then suppresses inside the window', () => {
    const first = C.decideAlerts({}, [f(6)], { nowMs: NOW, windowMin: 60, scope });
    expect(first.alerts.map((a: { key: string }) => a.key)).toEqual(['bleed-b-spec-AAPL']);
    const second = C.decideAlerts(first.state, [f(6.5)], { nowMs: NOW + 10 * 60_000, windowMin: 60, scope });
    expect(second.alerts).toEqual([]);
    expect(second.suppressed).toEqual(['bleed-b-spec-AAPL']);
  });

  it('re-alerts inside the window when the condition WORSENS past the band', () => {
    const first = C.decideAlerts({}, [f(6)], { nowMs: NOW, windowMin: 60, scope });
    const worse = C.decideAlerts(first.state, [f(22)], { nowMs: NOW + 10 * 60_000, windowMin: 60, scope });
    expect(worse.alerts.map((a: { key: string }) => a.key)).toEqual(['bleed-b-spec-AAPL']);
  });

  it('re-alerts on a GRADUAL slide, because the band measures from the last ALERT', () => {
    // -6 -> -8 -> -10 in 10-minute steps, band 3. Ratcheting the stored severity on each SUPPRESSED
    // reading (the first cut) made the band measure only the last step, so a name that had nearly
    // doubled stayed silent for the whole window.
    const first = C.decideAlerts({}, [f(6)], { nowMs: NOW, windowMin: 60, scope });
    expect(first.alerts.length).toBe(1);
    const drift = C.decideAlerts(first.state, [f(8)], { nowMs: NOW + 10 * 60_000, windowMin: 60, scope });
    expect(drift.alerts).toEqual([]);
    const past = C.decideAlerts(drift.state, [f(10)], { nowMs: NOW + 20 * 60_000, windowMin: 60, scope });
    expect(past.alerts.map((a: { key: string }) => a.key)).toEqual(['bleed-b-spec-AAPL']);
    // ...and the new baseline is the severity it just alerted at, not the old one.
    expect(C.decideAlerts(past.state, [f(12)], { nowMs: NOW + 30 * 60_000, windowMin: 60, scope }).alerts).toEqual([]);
  });

  it('re-alerts after the window even when nothing changed', () => {
    const first = C.decideAlerts({}, [f(6)], { nowMs: NOW, windowMin: 60, scope });
    const later = C.decideAlerts(first.state, [f(6)], { nowMs: NOW + 61 * 60_000, windowMin: 60, scope });
    expect(later.alerts.length).toBe(1);
  });

  it('recovers exactly once, clears the key, and alerts again on re-entry', () => {
    const first = C.decideAlerts({}, [f(6)], { nowMs: NOW, windowMin: 60, scope });
    const clear = C.decideAlerts(first.state, [], { nowMs: NOW + 10 * 60_000, windowMin: 60, scope });
    expect(clear.recovered).toEqual(['bleed-b-spec-AAPL']);
    expect(Object.keys(clear.state)).toEqual([]);
    const again = C.decideAlerts(clear.state, [], { nowMs: NOW + 20 * 60_000, windowMin: 60, scope });
    expect(again.recovered).toEqual([]);
    const reentry = C.decideAlerts(clear.state, [f(6)], { nowMs: NOW + 30 * 60_000, windowMin: 60, scope });
    expect(reentry.alerts.length).toBe(1);
  });

  it('never "recovers" a book or a kind the run did not evaluate', () => {
    const first = C.decideAlerts({}, [f(6)], { nowMs: NOW, windowMin: 60, scope });
    const unread = C.decideAlerts(first.state, [], { nowMs: NOW + 10 * 60_000, windowMin: 60, scope: { refs: [], kinds: C.evaluatedKinds(true) } });
    expect(unread.recovered).toEqual([]);
    expect(Object.keys(unread.state)).toEqual(['bleed-b-spec-AAPL']);
    const offHours = C.decideAlerts(first.state, [], { nowMs: NOW + 10 * 60_000, windowMin: 60, scope: { refs: ['b-spec'], kinds: C.evaluatedKinds(false) } });
    expect(offHours.recovered).toEqual([]);
  });

  it('keys are per book AND per symbol - never a symbol SET whose churn defeats suppression', () => {
    const first = C.decideAlerts({}, [f(6, 'AAPL')], { nowMs: NOW, windowMin: 60, scope });
    const both = C.decideAlerts(first.state, [f(6, 'AAPL'), f(7, 'MSFT')], { nowMs: NOW + 5 * 60_000, windowMin: 60, scope });
    expect(both.alerts.map((a: { key: string }) => a.key)).toEqual(['bleed-b-spec-MSFT']);
  });

  it('prunes entries older than a day and survives a garbage state file', () => {
    const stale = { 'bleed-b-spec-OLD': { at: new Date(NOW - 30 * 3600_000).toISOString(), severity: 9, kind: 'bleed', ref: 'b-spec' } };
    expect(Object.keys(C.decideAlerts(stale, [], { nowMs: NOW, windowMin: 60, scope }).state)).toEqual([]);
    expect(C.decideAlerts('nonsense' as never, [f(6)], { nowMs: NOW, windowMin: 60, scope }).alerts.length).toBe(1);
    expect(C.decideAlerts({ k: null }, [], { nowMs: NOW, windowMin: 60, scope }).alerts).toEqual([]);
  });

  it('MUTATION: dropping the worsening band suppresses a position that fell from -6 to -22 percent', () => {
    const M = mutant('const worsened = !!e && f.band !== null && Number.isFinite(Number(e.severity)) && f.severity - Number(e.severity) > f.band;',
      'const worsened = false;');
    const first = M.decideAlerts({}, [f(6)], { nowMs: NOW, windowMin: 60, scope });
    expect(M.decideAlerts(first.state, [f(22)], { nowMs: NOW + 10 * 60_000, windowMin: 60, scope }).alerts).toEqual([]);
  });

  it('MUTATION: dropping the scope check "recovers" a book that could not be read', () => {
    const M = mutant("if (opts.scope.kinds.indexOf(String(e.kind)) < 0 || opts.scope.refs.indexOf(String(e.ref)) < 0) continue;", '');
    const first = M.decideAlerts({}, [f(6)], { nowMs: NOW, windowMin: 60, scope });
    expect(M.decideAlerts(first.state, [], { nowMs: NOW + 60_000, windowMin: 60, scope: { refs: [], kinds: [] } }).recovered).toEqual(['bleed-b-spec-AAPL']);
  });
});

describe('watchdog checks: the pre-market gap needs a real print', () => {
  const today = '2026-09-04';
  const base = { priorClose: 500, todayIso: today, nowMs: Date.parse(`${today}T12:00:00.000Z`), minSize: 100, maxAgeMin: 15, gapPct: 1 };
  const trade = (over: Record<string, unknown> = {}): any => ({ t: `${today}T11:58:00.000Z`, p: 490, s: 500, ...over });
  const quote = (over: Record<string, unknown> = {}): any => ({ bp: 489.9, ap: 490.1, ...over });

  it('alerts when the print AND the quote mid both cross', () => {
    const r = C.assessGapPrint({ ...base, trade: trade(), quote: quote() });
    expect(r.alert).toBe(true);
    expect(Math.round(r.gap * 10) / 10).toBe(-2);
  });

  it('refuses a thin print, a stale print, yesterday\'s print, and a one-sided quote', () => {
    expect(C.assessGapPrint({ ...base, trade: trade({ s: 1 }), quote: quote() }).skip).toMatch(/thin print/);
    expect(C.assessGapPrint({ ...base, trade: trade({ t: `${today}T11:00:00.000Z` }), quote: quote() }).skip).toMatch(/stale print/);
    expect(C.assessGapPrint({ ...base, trade: trade({ t: '2026-09-03T11:58:00.000Z' }), quote: quote() }).skip).toMatch(/no pre-market print yet/);
    expect(C.assessGapPrint({ ...base, trade: trade(), quote: quote({ bp: 0 }) }).skip).toMatch(/two-sided quote/);
    expect(C.assessGapPrint({ ...base, trade: null, quote: quote() }).skip).toMatch(/no prior close or no trade/);
  });

  it('does not alert when only the trade crosses but the quote mid does not', () => {
    const r = C.assessGapPrint({ ...base, trade: trade(), quote: quote({ bp: 498, ap: 499 }) });
    expect(r.alert).toBe(false);
  });

  it('MUTATION: dropping the size floor pages on a 1-share odd lot', () => {
    const M = mutant("if (size < input.minSize) return { skip: 'thin print (size=' + size + ' < ' + input.minSize + ')' };", '');
    expect(M.assessGapPrint({ ...base, trade: trade({ s: 1 }), quote: quote() }).alert).toBe(true);
  });

  it('MUTATION: dropping the quote corroboration pages on a print the book does not support', () => {
    const M = mutant('return { alert: gap <= -input.gapPct && midGap <= -input.gapPct,', 'return { alert: gap <= -input.gapPct,');
    expect(M.assessGapPrint({ ...base, trade: trade(), quote: quote({ bp: 498, ap: 499 }) }).alert).toBe(true);
  });
});

describe('watchdog fetcher: the REAL http boundary the container-side audit crosses', () => {
  let server: Server;
  let port = 0;
  const seen: Array<{ url: string; headers: Record<string, unknown> }> = [];
  let mode: 'ok' | 'error503' | 'garbage' | 'hang' = 'ok';
  const wedged: Array<{ destroy: () => void }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', headers: req.headers as Record<string, unknown> });
      res.setHeader('content-type', 'application/json');
      // A book that answers nothing at all - the wedge the per-read deadline exists for.
      if (mode === 'hang' && (req.url ?? '').includes('book=wedged')) { wedged.push(res); return; }
      if (mode === 'error503') { res.statusCode = 503; res.end(JSON.stringify({ error: 'broker_not_configured' })); return; }
      // A 200 whose account reads fine but whose positions field is NOT an array - the shape a
      // half-broken read has, and the one the fail-closed array assert exists for.
      if (mode === 'garbage' && !(req.url ?? '').startsWith('/api/trading/account')) { res.end(JSON.stringify({ book: 'x', positions: { error: 'nope' } })); return; }
      if ((req.url ?? '').startsWith('/api/trading/account')) { res.end(JSON.stringify({ book: 'live', account: { cash: 1_000, buyingPower: 2_000, equity: 100_000 } })); return; }
      if ((req.url ?? '').startsWith('/api/trading/positions')) { res.end(JSON.stringify({ book: 'live', positions: [{ symbol: 'AAPL', qty: 10, avgEntryPrice: 100, marketValue: 700, unrealizedPl: -300 }] })); return; }
      res.end(JSON.stringify({ book: 'live', orders: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => { for (const r of wedged) { try { r.destroy(); } catch { /* already gone */ } } server.close(); });

  /**
   * Runs the ps1's own $auditJs fetcher (sliced from the script) under real node against the server.
   * ASYNC on purpose: spawnSync would block this process's event loop, and the http server the
   * fetcher talks to lives in it.
   */
  let fetchSettings: Record<string, unknown> = {};
  let fetchBudgetSec: number | undefined;
  const runFetcher = async (books: Array<{ ref: string; enabled: boolean }>, rth: boolean, prior: object, mutate?: [string, string]): Promise<any> => {
    const start = watchdogSource.indexOf('$auditJs = @\'') + '$auditJs = @\'\n'.length;
    const end = watchdogSource.indexOf('\'@', start);
    let js = watchdogSource.slice(start, end)
      .replace('require("/tmp/oshal-wd-checks.js")', JSON.stringify(modulePath).replace(/^/, 'require(') + ')')
      .replace('"/tmp/wd-audit-request.json"', JSON.stringify(join(scratch, 'req.json')))
      .replace('"/tmp/wd-audit-state.json"', JSON.stringify(join(scratch, 'state.json')))
      .replace('"http://127.0.0.1:5000/api/trading"', JSON.stringify(`http://127.0.0.1:${port}/api/trading`));
    // A mutation applies to the SHIPPED fetcher text, and the anchor is asserted first so a
    // reworded fetcher can never turn a mutation case into a vacuous pass.
    if (mutate) {
      expect(js, `the fetcher no longer contains ${mutate[0]} - the mutation would prove nothing`).toContain(mutate[0]);
      js = js.replace(mutate[0], mutate[1]);
    }
    const file = join(scratch, `fetcher-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(file, js);
    writeFileSync(join(scratch, 'req.json'), JSON.stringify({ sub: 'spec-sub', rth, coreHolds: '', books, settings: fetchSettings, auditBudgetSec: fetchBudgetSec }));
    writeFileSync(join(scratch, 'state.json'), JSON.stringify(prior));
    const r = await new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [file], { env: { ...process.env, SWARM_SERVICE_SECRET: 'spec-secret' } });
      let out = ''; let err = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('fetcher timed out')); }, 60_000);
      child.stdout.on('data', (d) => { out += String(d); });
      child.stderr.on('data', (d) => { err += String(d); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    });
    expect(r.code, `fetcher failed: ${r.err}`).toBe(0);
    return JSON.parse(r.out.trim().split('\n').filter(Boolean).at(-1) as string);
  };

  it('reads each book QUERY-FIRST (?book=<ref>) with the trusted-service headers, and finds the bleeder', async () => {
    mode = 'ok'; seen.length = 0;
    const out = await runFetcher([{ ref: 'live', enabled: true }], true, {});
    expect(out.errors).toEqual([]);
    expect(out.books).toEqual(['live']);
    expect(out.alerts.map((a: { key: string }) => a.key).sort()).toEqual(['bleed-live-AAPL', 'deep-loss-live-AAPL']);
    expect(seen.map((s) => s.url)).toEqual([
      '/api/trading/account?book=live', '/api/trading/positions?book=live', '/api/trading/orders?book=live',
    ]);
    expect(seen[0].headers['x-service-secret']).toBe('spec-secret');
    expect(seen[0].headers['x-oshal-user-sub-b64']).toBe(Buffer.from('spec-sub', 'utf8').toString('base64url'));
    // The state it hands back is what the ps1 persists, and it suppresses the next run.
    const again = await runFetcher([{ ref: 'live', enabled: true }], true, out.state);
    expect(again.alerts).toEqual([]);
    expect(again.suppressed.sort()).toEqual(['bleed-live-AAPL', 'deep-loss-live-AAPL']);
  });

  it('a 503 book is an ERROR, never an empty healthy book (and it retries before giving up)', async () => {
    mode = 'error503'; seen.length = 0;
    const out = await runFetcher([{ ref: 'live', enabled: true }], true, {});
    expect(out.alerts).toEqual([]);
    expect(out.books).toEqual([]);
    expect(out.errors[0].error).toMatch(/HTTP 503 broker_not_configured/);
    expect(seen.length, 'the fetcher must retry once before alerting').toBeGreaterThan(1);
  });

  it('a book that WEDGES hits the per-read deadline and does not cost the other books', async () => {
    // Without a deadline on the read, one wedged book parks the whole audit on undici's 300s
    // per-request default - and the host-side exec deadline then kills the run, losing the healthy
    // books' findings as well. The deadline is a setting (TRADING_WD_HTTP_TIMEOUT_SEC).
    mode = 'hang'; seen.length = 0; fetchSettings = { httpTimeoutSec: 1 };
    const started = Date.now();
    const out = await runFetcher([{ ref: 'wedged', enabled: true }, { ref: 'live', enabled: true }], true, {});
    expect(Date.now() - started, 'the read must be abandoned, not waited out').toBeLessThan(30_000);
    expect(out.errors.map((e: { ref: string }) => e.ref)).toEqual(['wedged']);
    expect(out.errors[0].error).toMatch(/timeout|abort/i);
    expect(out.books, 'the healthy book is still audited').toEqual(['live']);
    expect(out.alerts.map((a: { key: string }) => a.key).sort()).toEqual(['bleed-live-AAPL', 'deep-loss-live-AAPL']);
    fetchSettings = {};
  });

  it('THREE wedged books at the SHIPPED per-read cap still finish inside the audit budget', async () => {
    // The round-3 blocker, reproduced: the per-read cap alone does NOT keep one wedged book from
    // costing the others. At the shipped 20s cap, three wedged books spent 126s - past the 60s host
    // exec deadline - so the child was killed and EVERY book's result was thrown away, the healthy
    // ones included. The fix is a per-book SHARE of a budget derived from that same deadline, which
    // is why this case leaves httpTimeoutSec at its shipped default and only shrinks the budget.
    mode = 'hang'; seen.length = 0; fetchSettings = {}; fetchBudgetSec = 6;
    const started = Date.now();
    const out = await runFetcher([
      { ref: 'wedged', enabled: true }, { ref: 'wedged2', enabled: true }, { ref: 'wedged3', enabled: true },
      { ref: 'live', enabled: true },
    ], true, {});
    const elapsed = Date.now() - started;
    expect(elapsed, 'the audit must print inside its budget, not be killed by the host deadline').toBeLessThan(14_000);
    expect(out.errors.map((e: { ref: string }) => e.ref).sort()).toEqual(['wedged', 'wedged2', 'wedged3']);
    // The book AFTER three wedges is still audited - that is the whole promise.
    expect(out.books).toEqual(['live']);
    expect(out.alerts.map((a: { key: string }) => a.key).sort()).toEqual(['bleed-live-AAPL', 'deep-loss-live-AAPL']);
    fetchBudgetSec = undefined; fetchSettings = {};
  }, 40_000);

  it('MUTATION: without the per-book share, the same run overruns the budget it was given', async () => {
    // The shipped fetcher minus the clamp - which is exactly what the round-2 file did: each read
    // waits the whole per-read cap, so the run blows past the host deadline instead of reporting.
    mode = 'hang'; seen.length = 0; fetchSettings = { httpTimeoutSec: 4 }; fetchBudgetSec = 2;
    const started = Date.now();
    const out = await runFetcher([{ ref: 'wedged', enabled: true }, { ref: 'wedged2', enabled: true }], true, {},
      ['Math.max(250, Math.min(httpMs, left))', 'httpMs']);
    const elapsed = Date.now() - started;
    expect(out.errors.length).toBe(2);
    expect(elapsed, 'the mutant must overrun - otherwise the clamp is not what bounds the run').toBeGreaterThan(6_000);
    fetchBudgetSec = undefined; fetchSettings = {};
  }, 40_000);

  it('an unreadable suppression state file is a WARNING, never a silent duplicate-page', async () => {
    mode = 'ok'; fetchSettings = {};
    const out = await runFetcher([{ ref: 'live', enabled: true }], true, {},
      [JSON.stringify(join(scratch, 'state.json')), JSON.stringify(join(scratch, 'state-missing.json'))]);
    expect(out.warnings.join(' ')).toContain('prior suppression state unreadable');
    expect(out.alerts.length, 'it still raises - the safe direction, just not a silent one').toBeGreaterThan(0);
  });

  it('a setting the fetcher cannot parse becomes a WARNING, not a silent default', async () => {
    mode = 'ok'; fetchSettings = { deepLossPct: 'oops' };
    const out = await runFetcher([{ ref: 'live', enabled: true }], true, {});
    expect(out.warnings.join(' ')).toContain('deepLossPct');
    fetchSettings = {};
  });

  it('a 200 whose payload is not an array is an ERROR too (the fail-closed shape assert)', async () => {
    mode = 'garbage';
    const out = await runFetcher([{ ref: 'live', enabled: true }], true, {});
    expect(out.books).toEqual([]);
    expect(out.errors[0].error).toMatch(/no usable positions/);
  });
});

describe('watchdog PowerShell plumbing (real powershell.exe, real files)', () => {
  const section = (start: string, end: string): string => {
    const a = watchdogSource.indexOf(start); const b = watchdogSource.indexOf(end, a);
    if (a < 0 || b < 0) throw new Error(`watchdog source markers missing: ${start} -> ${end}`);
    return watchdogSource.slice(a, b);
  };

  const probe = (body: string[], extra: string[] = []): { status: number | null; out: string; err: string } => {
    const file = join(scratch, `probe-${Math.random().toString(36).slice(2)}.ps1`);
    writeFileSync(file, [
      '$ErrorActionPreference = "Continue"',
      '$script:raised = New-Object System.Collections.ArrayList',
      'function Log($m) { Write-Host ("LOG " + $m) }',
      'function Raise($cond, $msg) { [void]$script:raised.Add($cond); Write-Host ("RAISE " + $cond) }',
      section('# ---- wd: settings + exec ----', '# ---- wd: end settings + exec ----'),
      section('# ---- wd: symbol state ----', '# ---- wd: end symbol state ----'),
      ...extra,
      ...body,
    ].join('\n'));
    const r = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 90_000 });
    if (r.error) throw new Error(`PowerShell (${powershell}) is required for this guard and did not run: ${r.error.message}`);
    return { status: r.status, out: (r.stdout ?? '').trim(), err: r.stderr ?? '' };
  };

  // Invoke-WdExec drives a REAL child process (that is what makes the deadline able to kill it), so
  // these cases point $script:WdDockerExe at powershell itself and let it be the "docker": a real
  // exit code, real empty output, a real hang. A stubbed `function docker` - which the first cut
  // used - could never have proven the timeout, because no timeout can kill a function call.
  const asDocker = [
    `$script:WdDockerExe = ${JSON.stringify(powershell)}`,
    '$script:WdDockerArgPrefix = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command")',
  ];

  it('an EMPTY exec raises check-infra instead of reading as all-clear', () => {
    const r = probe([...asDocker,
      '$out = Invoke-WdExec "book-audit" @("exit 0")',
      'Write-Host ("NULL=" + ($null -eq $out))',
    ]);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain('RAISE check-infra-book-audit');
    expect(r.out).toContain('NULL=True');
  });

  it('a non-zero exec raises too, and real output passes through', () => {
    const bad = probe([...asDocker,
      '$out = Invoke-WdExec "paper-positions" @("Write-Output boom; exit 125")',
      'Write-Host ("NULL=" + ($null -eq $out))']);
    expect(bad.out, bad.err).toContain('RAISE check-infra-paper-positions');
    expect(bad.out).toContain('NULL=True');
    const ok = probe([...asDocker,
      '$out = Invoke-WdExec "paper-positions" @("Write-Output ok-payload")',
      'Write-Host ("OUT=" + $out)']);
    expect(ok.out, ok.err).toContain('OUT=ok-payload');
    expect(ok.out).not.toContain('RAISE');
  });

  it('an exec that HANGS is killed at its deadline and reported as a failed check', () => {
    // The failure this exists for: the api answers /api/health while /api/trading is wedged, so
    // block G's 3 reads x N books park on undici's 300s-per-request default, the run never reaches
    // the delivery step, and every alert it had already raised (api-down, engine-blind) is lost.
    const started = Date.now();
    const r = probe([...asDocker,
      '$out = Invoke-WdExec "book-audit" @("Start-Sleep -Seconds 45") 2',
      'Write-Host ("NULL=" + ($null -eq $out))']);
    const elapsed = Date.now() - started;
    expect(r.out, r.err).toContain('RAISE check-infra-book-audit');
    expect(r.out).toContain('NULL=True');
    expect(elapsed, 'the deadline must actually kill the child, not wait it out').toBeLessThan(40_000);
  });

  it('the deadline comes from TRADING_WD_EXEC_TIMEOUT_SEC, not a literal', () => {
    const r = probe([...asDocker,
      '$script:WdExecTimeoutSec = 2',
      '$out = Invoke-WdExec "book-audit" @("Start-Sleep -Seconds 45")',
      'Write-Host ("NULL=" + ($null -eq $out))']);
    expect(r.out, r.err).toContain('RAISE check-infra-book-audit');
    expect(r.out).toContain('NULL=True');
    expect(watchdogSource).toContain("Get-WdSetting 'EXEC_TIMEOUT_SEC' 60");
  });

  it('an argument this file cannot quote is REFUSED, never mis-quoted into a different command', () => {
    const r = probe([...asDocker, '$out = Invoke-WdExec "book-audit" @(\'a"b\')',
      'Write-Host ("NULL=" + ($null -eq $out))']);
    expect(r.out, r.err).toContain('RAISE check-infra-book-audit');
    expect(r.out).toContain('NULL=True');
    // But a WINDOWS PATH must go through: `docker cp` is handed one on every run, and refusing
    // every backslash (the round-2 rule) would have made the bounded copy impossible.
    const winPath = 'C:\\Users\\a b\\wd-audit.js';
    const ok = probe([...asDocker, `$line = ConvertTo-WdArgLine @('cp', '${winPath}', 'oshal-local-api:/tmp/x')`,
      'Write-Host ("LINE=" + $line)']);
    expect(ok.out, ok.err).toContain(`LINE=cp "${winPath}" oshal-local-api:/tmp/x`);
    // A trailing backslash inside a quoted argument would escape the closing quote - still refused.
    const trailing = probe([...asDocker, "$line = ConvertTo-WdArgLine @('cp', 'C:\\a b\\')",
      'Write-Host ("NULL=" + ($null -eq $line))']);
    expect(trailing.out, trailing.err).toContain('NULL=True');
  }, 30_000);

  it('docker cp is fail-closed AND deadline-bound, with the caller owning the alert key', () => {
    // A cp that silently fails leaves the PREVIOUS run's file in /tmp and the check then prints a
    // well-formed WRONG result; a cp against a wedged docker daemon parks the run before the alerts
    // already raised are delivered. Both are proven here against a REAL child process.
    const local = join(scratch, 'cp-payload.json');
    writeFileSync(local, '{}');
    const asCp = (command: string): string[] => [
      `$script:WdDockerExe = ${JSON.stringify(powershell)}`,
      `$script:WdDockerArgPrefix = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ${JSON.stringify(command)})`,
      '$ApiContainer = "oshal-local-api"',
    ];
    const call = `$ok = Copy-WdIntoApi "book-audit" ${JSON.stringify(local)} "/tmp/wd-audit-request.json"`;
    const good = probe([...asCp('exit 0;'), call, 'Write-Host ("OK=" + $ok)']);
    expect(good.out, good.err).toContain('OK=True');
    expect(good.out).not.toContain('RAISE');
    const failed = probe([...asCp('exit 7;'), call, 'Write-Host ("OK=" + $ok)']);
    expect(failed.out, failed.err).toContain('RAISE check-infra-book-audit');
    expect(failed.out).toContain('OK=False');
    const started = Date.now();
    const hung = probe([...asCp('Start-Sleep -Seconds 45;'), '$script:WdExecTimeoutSec = 2', call, 'Write-Host ("OK=" + $ok)']);
    expect(hung.out, hung.err).toContain('RAISE check-infra-book-audit');
    expect(hung.out).toContain('OK=False');
    expect(Date.now() - started, 'a wedged docker cp must be killed, not waited out').toBeLessThan(40_000);
    // The checks-module copy is the same helper with its own key, because "the module is missing"
    // is a different consequence from "this check's input is stale".
    const keyed = probe([...asCp('exit 7;'),
      `$ok = Copy-WdIntoApi "checks-module" ${JSON.stringify(local)} "/tmp/oshal-wd-checks.js" "wd-checks-unavailable"`,
      'Write-Host ("OK=" + $ok)']);
    expect(keyed.out, keyed.err).toContain('RAISE wd-checks-unavailable');
  }, 90_000);

  it('the audit budget is DERIVED from the exec deadline, so the fetcher always prints first', () => {
    // The round-3 blocker in one assertion: the container-side budget can never be >= the deadline
    // that kills the container-side process.
    const r = probe([
      'Write-Host ("DEFAULT=" + (Get-WdAuditBudgetSec))',
      '$script:WdExecTimeoutSec = 25; Write-Host ("TIGHT=" + (Get-WdAuditBudgetSec))',
      '$script:WdExecTimeoutSec = 6; Write-Host ("FLOOR=" + (Get-WdAuditBudgetSec))',
    ]);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain('DEFAULT=50');
    expect(r.out).toContain('TIGHT=15');
    // Never below the floor, and never above the deadline it is derived from.
    expect(r.out).toContain('FLOOR=5');
    expect(watchdogSource).toContain('auditBudgetSec = (Get-WdAuditBudgetSec)');
  }, 30_000);

  it('threshold precedence: AlertPct resolves BEFORE LiveAlertPct, so the .env reaches the LIVE books', () => {
    // The round-1 defect, executed rather than asserted: with the two lines the other way round an
    // operator who tightened TRADING_WD_ALERT_PCT to 3 got 3 on the paper book and kept the param
    // default of 5 on the Schwab books - looser on the only checks watching real money.
    const dir = mkdtempSync(join(tmpdir(), 'oshal-wd-env-'));
    const run = (env: string[], bound: string): { out: string; err: string } => {
      writeFileSync(join(dir, '.env'), env.join('\n') + '\n');
      return probe([
        'Write-Host ("ALERT=" + $AlertPct); Write-Host ("LIVE=" + $LiveAlertPct)',
        'Write-Host ("GAP=" + $GapAlertPct); Write-Host ("TIMEOUT=" + $script:WdExecTimeoutSec)',
      ], [
        '$AlertPct = 5.0; $LiveAlertPct = 0; $GapAlertPct = 1.0',
        `$PSBoundParameters = ${bound}`,
        `$Repo = ${JSON.stringify(dir)}`,
        section('# ---- wd: threshold precedence ----', '# ---- wd: end threshold precedence ----'),
      ]);
    };
    const inherited = run(['TRADING_WD_ALERT_PCT=3'], '@{}');
    expect(inherited.out, inherited.err).toContain('ALERT=3');
    expect(inherited.out, 'the live books must inherit the operator .env threshold, not the param default').toContain('LIVE=3');
    expect(inherited.out).toContain('TIMEOUT=60');
    const explicit = run(['TRADING_WD_ALERT_PCT=3', 'TRADING_WD_LIVE_ALERT_PCT=8.5', 'TRADING_WD_EXEC_TIMEOUT_SEC=25'], '@{}');
    expect(explicit.out).toContain('ALERT=3');
    expect(explicit.out).toContain('LIVE=8.5');
    expect(explicit.out).toContain('TIMEOUT=25');
    const bound = run(['TRADING_WD_ALERT_PCT=3'], '@{ AlertPct = 7.0 }');
    expect(bound.out, 'an explicitly passed -AlertPct outranks the .env, and is still the live fallback').toContain('ALERT=5');
    expect(bound.out).toContain('LIVE=5');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a core-hold read that FAILS withholds every core-exempting check instead of exempting nothing', () => {
    // TRADING_CORE_SYMBOLS is the exemption list for every loss conclusion. Read through an empty
    // catch (the first cut), a failed exec handed the checks an EMPTY set - and the new deep-loss
    // check would then have paged "HOLDING PAST ITS STOP" about a deliberate :0 operator hold, once
    // per window per book. The 2026-07-13 SKHY false positive, louder.
    const coreSection = section('# ---- wd: core holds ----', '# ---- wd: end core holds ----');
    const failed = probe(['Write-Host ("KNOWN=" + $coreKnown); Write-Host ("HOLDS=[" + $coreHolds + "]")'],
      ['$ApiContainer = "oshal-local-api"', 'function Invoke-WdExec($name, $a, $t) { Write-Host ("EXEC " + $name); return $null }', coreSection]);
    expect(failed.out, failed.err).toContain('KNOWN=False');
    expect(failed.out).toContain('HOLDS=[]');
    expect(failed.out).toContain('LOG core-hold list UNREADABLE');
    const ok = probe(['Write-Host ("KNOWN=" + $coreKnown); Write-Host ("HOLDS=[" + $coreHolds + "]")'],
      ['$ApiContainer = "oshal-local-api"', 'function Invoke-WdExec($name, $a, $t) { return "wd:SPY:60,SKHY:0" }', coreSection]);
    expect(ok.out, ok.err).toContain('KNOWN=True');
    expect(ok.out).toContain('HOLDS=[SPY:60,SKHY:0]');
    // An empty variable in the container is a SUCCESSFUL read (the sentinel is why), not a failure.
    const empty = probe(['Write-Host ("KNOWN=" + $coreKnown); Write-Host ("HOLDS=[" + $coreHolds + "]")'],
      ['$ApiContainer = "oshal-local-api"', 'function Invoke-WdExec($name, $a, $t) { return "wd:" }', coreSection]);
    expect(empty.out, empty.err).toContain('KNOWN=True');
    expect(empty.out).toContain('HOLDS=[]');
  });

  it('the withholding is EXECUTED: block G does not run without a core-hold read or the module', () => {
    // Round-3 review: proving $coreKnown goes false was not enough - that it actually reaches the
    // audit was pinned by exact source text, which a reformat breaks and a later reassignment
    // slips past. This RUNS the shipped gate section with the two inputs varied.
    const gate = section('# ---- wd: audit gate ----', '# ---- wd: end audit gate ----');
    const run = (checksReady: boolean, coreKnown: boolean, books: string): { out: string; err: string } => probe(
      [gate, 'Write-Host "DONE"'],
      [
        '$DbContainer = "oshal-local-db"; $rth = $true; $coreHolds = ""',
        `$symStateFile = ${JSON.stringify(join(scratch, 'gate-state.json'))}`,
        'function Invoke-WdBookAudit($b, $r, $c, $s) { $refs = @($b) | ForEach-Object { [string]$_.Ref }; Write-Host ("AUDITED " + ($refs -join ",")); return @{} }',
        'function Send-WdAuditAlerts($r, $p) { Write-Host "DELIVERED" }',
        `$checksReady = $${checksReady}; $coreKnown = $${coreKnown}; $liveBooks = ${books}`,
      ]);
    const roster = '@(@{ Ref = "b-77146871"; Enabled = $false }, @{ Ref = "live"; Enabled = $true })';
    const blind = run(true, false, roster);
    expect(blind.out, blind.err).toContain('DONE');
    expect(blind.out, 'no exemption list means no loss conclusions for this run').not.toContain('AUDITED');
    const noModule = run(false, true, roster);
    expect(noModule.out, noModule.err).not.toContain('AUDITED');
    const ok = run(true, true, roster);
    expect(ok.out, ok.err).toContain('AUDITED b-77146871,live');
    expect(ok.out).toContain('DELIVERED');
    // A failed roster read still audits the legacy book AND says the others are unwatched, under
    // its own key so the beat check's 'books-unreadable' cannot swallow it.
    const fallback = run(true, true, '$null');
    expect(fallback.out, fallback.err).toContain('AUDITED live');
    expect(fallback.out).toContain('RAISE books-unreadable-audit');
  }, 60_000);

  it('settings come from the .env TRADING_WD_* block, and junk falls back to the default', () => {
    const envFile = join(scratch, 'dotenv-sample.env');
    writeFileSync(envFile, ['# comment', 'OSHAL_OPERATOR_SUBS=someone', 'TRADING_WD_LIVE_ALERT_PCT=8.5', 'TRADING_WD_MAX_POSITIONS=oops', ''].join('\n'));
    const r = probe([
      `$script:WdEnv = Read-WdEnvSettings ${JSON.stringify(envFile)}`,
      'Write-Host ("LIVE=" + (Get-WdSetting "LIVE_ALERT_PCT" 5))',
      'Write-Host ("MAXPOS=" + (Get-WdSetting "MAX_POSITIONS" 40))',
      'Write-Host ("ABSENT=" + (Get-WdSetting "NOT_SET_ANYWHERE" 12))',
      '$script:WdEnv = Read-WdEnvSettings "C:\\\\nope\\\\missing.env"',
      'Write-Host ("NOFILE=" + (Get-WdSetting "LIVE_ALERT_PCT" 5))',
    ]);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain('LIVE=8.5');
    expect(r.out).toContain('MAXPOS=40');
    expect(r.out).toContain('ABSENT=12');
    expect(r.out).toContain('NOFILE=5');
  });

  it('the symbol-state file round-trips, and a corrupt one starts empty rather than throwing', () => {
    const good = join(scratch, 'sym-good.json');
    const bad = join(scratch, 'sym-bad.json');
    writeFileSync(bad, '{not json');
    const r = probe([
      `Write-WdSymbolState ${JSON.stringify(good)} '{"bleed-live-AAPL":{"at":"2026-09-04T15:00:00Z","severity":6,"kind":"bleed","ref":"live"}}'`,
      `Write-Host ("ROUNDTRIP=" + (Read-WdSymbolState ${JSON.stringify(good)}))`,
      `Write-Host ("CORRUPT=" + (Read-WdSymbolState ${JSON.stringify(bad)}))`,
      `Write-Host ("MISSING=" + (Read-WdSymbolState ${JSON.stringify(join(scratch, 'sym-none.json'))}))`,
    ]);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain('ROUNDTRIP={"bleed-live-AAPL"');
    expect(r.out).toContain('CORRUPT={}');
    expect(r.out).toContain('MISSING={}');
  });

  it('the whole watchdog still parses under the real PowerShell parser', () => {
    const file = join(scratch, 'parse.ps1');
    writeFileSync(file, [
      '$e = $null; $t = $null',
      `[System.Management.Automation.Language.Parser]::ParseFile(${JSON.stringify(watchdogPath)}, [ref]$t, [ref]$e) | Out-Null`,
      'if ($e -and $e.Count -gt 0) { $e | ForEach-Object { "ERR " + $_.Message } } else { "PARSE OK" }',
    ].join('\n'));
    const r = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 90_000 });
    if (r.error) throw new Error(`PowerShell (${powershell}) is required for this guard and did not run: ${r.error.message}`);
    expect((r.stdout ?? '').trim()).toBe('PARSE OK');
  });
});

describe('watchdog wiring: the ps1 uses what this module decides', () => {
  it('every docker exec is wrapped or checks its own exit code - enumerated from the real AST', () => {
    // A REGEX made this claim vacuous in round 1: `try { $coreHolds = docker exec ... } catch {}`
    // never matched `^\s*\$x = docker exec `, so the two printenv sites passed the guard while
    // swallowing their failures. The real PowerShell parser cannot be written around: it lists
    // every command invocation named `docker`, wherever and however it is written.
    const listFile = join(scratch, 'ast-docker.ps1');
    writeFileSync(listFile, [
      '$t = $null; $e = $null',
      `$ast = [System.Management.Automation.Language.Parser]::ParseFile(${JSON.stringify(watchdogPath)}, [ref]$t, [ref]$e)`,
      '$cmds = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)',
      'foreach ($c in $cmds) { if ($c.GetCommandName() -eq "docker") {',
      '  $second = ($c.CommandElements | Select-Object -Skip 1 -First 1).Extent.Text',
      '  Write-Output ("DOCKER|" + $c.Extent.StartLineNumber + "|" + $second) } }',
    ].join('\n'));
    const r = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', listFile], { encoding: 'utf8', timeout: 90_000 });
    if (r.error) throw new Error(`PowerShell (${powershell}) is required for this guard and did not run: ${r.error.message}`);
    const sites = (r.stdout ?? '').split('\n').filter((l) => l.startsWith('DOCKER|'))
      .map((l) => l.trim().split('|')).map(([, line, verb]) => ({ line: Number(line), verb }));
    expect(sites.length, 'the AST walk found no docker invocations at all - the guard would be vacuous').toBeGreaterThan(3);
    const lines = watchdogSource.split('\n');
    const bodyStart = watchdogSource.slice(0, watchdogSource.indexOf('# A) api health')).split('\n').length;
    for (const site of sites.filter((x) => x.verb === 'exec')) {
      const text = lines[site.line - 1];
      // Alert DELIVERY (oshal-send-alert.js) is not a check: its output is logged, never parsed
      // into a conclusion, and it runs only when an alert already exists.
      if (text.includes('oshal-send-alert.js')) continue;
      expect(site.line, `raw docker exec inside the CHECK body at line ${site.line}: ${text.trim()}`).toBeLessThan(bodyStart);
      // The pre-body reads (psql roster, redis-cli legs) predate this module and fail closed by
      // hand; they must at least still check their exit code.
      expect(lines.slice(site.line - 1, site.line + 3).join('\n'),
        `the raw exec at line ${site.line} does not check its exit code`).toContain('$LASTEXITCODE');
    }
    // EVERY copy into the container goes through Copy-WdIntoApi, which is both fail-closed (a
    // silently failed cp leaves the PREVIOUS run's file there and prints a well-formed wrong
    // result) and deadline-bound (a wedged daemon must not park the run before delivery). A raw
    // `docker cp` is neither, so there must be none left - the AST is what makes that checkable.
    expect(sites.filter((x) => x.verb === 'cp').map((x) => x.line),
      'a raw docker cp is unbounded - route it through Copy-WdIntoApi').toEqual([]);
    const copyBody = watchdogSource.slice(watchdogSource.indexOf('function Copy-WdIntoApi'));
    expect(copyBody.slice(0, copyBody.indexOf('# ---- wd: audit budget ----')),
      'Copy-WdIntoApi must run docker as a bounded child process, not as a bare command')
      .toContain('Invoke-WdProcess $script:WdDockerExe $line $limit');
  });

  it('the container-side reads and the core-hold read are the ones that changed', () => {
    expect(watchdogSource).toMatch(/Invoke-WdExec 'core-holds'/);
    expect(watchdogSource).toMatch(/Invoke-WdExec 'multi-account-flag'/);
    expect(watchdogSource).toContain('$coreKnown = ($null -ne $coreRaw)');
    // Both loss-check families gate on a real core-hold read.
    expect(watchdogSource).toContain('if ($coreKnown -and (Copy-WdIntoApi');
    expect(watchdogSource).toContain('if ($checksReady -and $coreKnown) {');
    // Block G's fallback alert no longer shares the beat check's suppression key.
    expect(watchdogSource).toContain("Raise 'books-unreadable-audit'");
  });

  it('block G audits EVERY live book from the roster, enabled or not, and fails closed without it', () => {
    expect(watchdogSource).toMatch(/\$auditBooks = if \(\$null -ne \$liveBooks\) \{ @\(\$liveBooks\) \}/);
    expect(watchdogSource).toContain("Raise 'books-unreadable'");
    expect(watchdogSource).toMatch(/Invoke-WdBookAudit \$auditBooks \$rth \$coreHolds/);
    // The retired single-book read must be gone: ?mode=live audited the legacy book only.
    expect(watchdogSource).not.toContain('/positions?mode=live');
    expect(watchdogSource).not.toContain('/orders?mode=live');
  });

  it('an explicit -param outranks the .env, detected by BoundParameters rather than by value', () => {
    // A defaulted [double] param is indistinguishable from an operator passing the same number, so
    // reading the .env only when the key is unbound is the only precedence that actually works.
    for (const name of ['LiveAlertPct', 'AlertPct', 'GapAlertPct']) {
      expect(watchdogSource).toContain(`$PSBoundParameters.ContainsKey('${name}')`);
    }
  });

  it('the module the container runs is the file this spec mutation-proves', () => {
    expect(watchdogSource).toContain("Join-Path $PSScriptRoot 'lib/trading-watchdog-checks.js'");
    expect(watchdogSource).toContain("Copy-WdIntoApi 'checks-module' $path '/tmp/oshal-wd-checks.js' 'wd-checks-unavailable'");
    expect(watchdogSource).toContain('require("/tmp/oshal-wd-checks.js")');
    expect(watchdogSource).toContain("Raise 'wd-checks-unavailable'");
  });

  it('stays pure ASCII (PowerShell 5.1 mojibakes anything else)', () => {
    expect(/^[\x00-\x7f]*$/.test(watchdogSource)).toBe(true);
    expect(/^[\x00-\x7f]*$/.test(moduleSource)).toBe(true);
  });
});
