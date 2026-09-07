/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — structural guards for the trading-schedule-dispatch decomposition (no DB): (a) the entry module's runtime export surface equals the pre-split 13-name list and the three pre-split types are still re-exported; (b) every module stays under its code-line ceiling, counted by ESLint's own max-lines rule (skipComments + skipBlankLines — the same semantics eslint.config.mjs gates on, never a hand-rolled stripper); (c) the six dispatch files form a DAG (edges matched in both the './trading-…' and '@/app/trading-…' forms) with no leg importing the entry, and the two out-edges into the strategy cluster (rotation/core → trading-config-overrides/trading-blend → trading-strategy-lab-sim) stay `import type` so the real runtime edge lab-sim → entry (rankUniverse) cannot close a cycle; (d) every module logs as 'trading-schedule-dispatch' (the watchdog/operator log contract); (e) the watchdog's grep strings stay in the ENTRY file; (f) every in-repo importer of '@/app/trading-schedule-dispatch' (src/app, scripts, tests/unit) names only symbols the barrel still exports. Scope is the six dispatch files and their importers only — no constraint is placed on modules outside the decomposition.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Flake fix: the one test that dynamically imports the entry module loads the whole trading feature graph, and a COLD transform of it runs past vitest's 5s default on a busy box (green when a sibling spec had already warmed the graph, red when run alone) — it now carries its own 60s budget. Source-pin tests are untouched: they read files, not the module graph.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import * as path from 'path';
import { Linter } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';

const ROOT = path.resolve(__dirname, '../..');
const APP = path.join(ROOT, 'src/app');
const ENTRY = 'trading-schedule-dispatch';
const LEGS = ['trading-dispatch-world-gate', 'trading-dispatch-rail', 'trading-dispatch-core', 'trading-dispatch-rotation', 'trading-dispatch-exits-entries'];
const SIX = [ENTRY, ...LEGS];
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');
const appSrc = (name: string): string => read(`src/app/${name}.ts`);

/** The runtime export surface of '@/app/trading-schedule-dispatch' BEFORE the split (Object.keys of the namespace). */
const PRE_SPLIT_EXPORTS = [
  'AUTOPILOT_CRON_DEFAULT', 'autopilotTaskType', 'coreConfig', 'coreTradePlan', 'dispatchTradingSchedule', 'ensureCore',
  'getTradingScheduleService', 'isTradingSchedule', 'loadInFlight', 'rankUniverse', 'rotationConfig', 'setTradingScheduleService', 'sizingPrice',
];
/** The type-only exports importers name (`import { type X }`); erased at runtime, pinned by source text. */
const PRE_SPLIT_TYPES = ['InFlight', 'CoreConfig', 'CoreTrade'];

/** Code lines exactly as ESLint's max-lines counts them (skipComments + skipBlankLines): lint with max 0 and read the count back. */
function eslintCodeLines(rel: string): number {
  const linter = new Linter({ configType: 'flat' });
  const messages = linter.verify(read(rel), [{
    files: ['**/*.ts'],
    languageOptions: { parser: tsParser as never, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
    rules: { 'max-lines': ['error', { max: 0, skipComments: true, skipBlankLines: true }] },
  }], { filename: path.join(ROOT, rel) });
  const fatal = messages.find((m) => m.fatal);
  if (fatal) throw new Error(`${rel}: ${fatal.message}`);
  const hit = messages.find((m) => m.ruleId === 'max-lines');
  const n = hit ? Number((/\((\d+)\)/.exec(hit.message) ?? [])[1]) : 0;
  if (!Number.isFinite(n)) throw new Error(`${rel}: could not read the max-lines count from "${hit?.message}"`);
  return n;
}

/** Import edges of one src/app module to a trading sibling — the relative './trading-…' form AND the
 *  '@/app/trading-…' alias form (either resolves to the same file; an alias import must not slip past the DAG). */
function localEdges(src: string): string[] {
  return [...src.matchAll(/from '(?:\.|@\/app)\/(trading-[a-z-]+)'/g)].map((m) => m[1]);
}

describe('(a) the public import surface of @/app/trading-schedule-dispatch is byte-for-byte the pre-split one', () => {
  // The only test here that LOADS the module graph (the entry pulls in the whole trading feature):
  // a cold transform of that graph runs past vitest's 5s default on a busy box, so it gets its own budget.
  it('runtime exports equal the pinned 13-name list — nothing added, nothing lost', async () => {
    const mod = await import('../../src/app/trading-schedule-dispatch');
    expect(Object.keys(mod).sort()).toEqual([...PRE_SPLIT_EXPORTS].sort());
  }, 60_000);
  it('the three pre-split types are still re-exported from the entry', () => {
    const src = appSrc(ENTRY);
    for (const t of PRE_SPLIT_TYPES) expect(src, `type ${t} must be re-exported`).toMatch(new RegExp(`export \\{[^}]*\\btype ${t}\\b[^}]*\\} from './trading-dispatch-`));
  });
});

describe('(b) file size — counted by ESLint max-lines (skipComments + skipBlankLines), never a hand-rolled counter', () => {
  it.each(LEGS)('%s stays under 500 code lines', (leg) => {
    expect(eslintCodeLines(`src/app/${leg}.ts`)).toBeLessThan(500);
  });
  it('the entry file stays under the 800-line decomposition threshold', () => {
    expect(eslintCodeLines(`src/app/${ENTRY}.ts`)).toBeLessThan(800);
  });
});

describe('(c) the dispatch import graph is a DAG (scope: the six dispatch files + the strategy-cluster type edges)', () => {
  const graph = new Map(SIX.map((f) => [f, localEdges(appSrc(f)).filter((e) => SIX.includes(e))]));

  it('no leg imports the entry module', () => {
    for (const leg of LEGS) expect(graph.get(leg), `${leg} must not import ${ENTRY}`).not.toContain(ENTRY);
  });
  it('a topological order exists over the six files', () => {
    const indeg = new Map(SIX.map((f) => [f, 0]));
    for (const edges of graph.values()) for (const e of edges) indeg.set(e, (indeg.get(e) ?? 0) + 1);
    const ready = SIX.filter((f) => indeg.get(f) === 0);
    const order: string[] = [];
    while (ready.length) {
      const f = ready.shift() as string; order.push(f);
      for (const e of graph.get(f) ?? []) { indeg.set(e, (indeg.get(e) ?? 0) - 1); if (indeg.get(e) === 0) ready.push(e); }
    }
    expect(order, `cycle among ${SIX.filter((f) => !order.includes(f)).join(', ')}`).toHaveLength(SIX.length);
  });
  it('the only runtime edge back toward the entry (trading-strategy-lab-sim → rankUniverse) stays open: the cluster imports lab-sim as `import type` only', () => {
    // rotation → trading-blend and core/rotation → trading-config-overrides are runtime edges; both of
    // those modules reach trading-strategy-lab-sim, which imports rankUniverse from the ENTRY at runtime.
    // A runtime import of lab-sim from either would close entry → leg → cluster → lab-sim → entry.
    for (const f of ['trading-blend', 'trading-config-overrides']) {
      const src = appSrc(f);
      const runtime = [...src.matchAll(/^import (?!type\b)[^;]*from '\.\/trading-strategy-lab-sim'/gm)];
      expect(runtime, `${f} must import trading-strategy-lab-sim as type-only`).toHaveLength(0);
      expect(src).toMatch(/^import type \{[^}]*\} from '\.\/trading-strategy-lab-sim'/m);
    }
    expect(appSrc('trading-strategy-lab-sim')).toMatch(/import \{ rankUniverse \} from '\.\/trading-schedule-dispatch'/);
  });
});

describe('(d) every dispatch module logs as module trading-schedule-dispatch (the watchdog/operator contract)', () => {
  // A leg whose moved functions never logged in the monolith (the rail) creates NO logger — a dead
  // logger would be a new symbol in a zero-behavior-change split. What is pinned: any logger a
  // dispatch module creates carries the shared name, at most one per file, and a file that emits
  // `logger.` lines has created its own (never borrowed another module's name).
  it.each(SIX)('%s', (f) => {
    const src = appSrc(f);
    const modules = [...src.matchAll(/createChildLogger\(\{ module: '([^']+)' \}\)/g)].map((m) => m[1]);
    expect(modules.length, `${f} must create at most one logger`).toBeLessThanOrEqual(1);
    for (const m of modules) expect(m, `${f} logger module`).toBe('trading-schedule-dispatch');
    if (/\blogger\./.test(src)) expect(modules, `${f} logs but created no logger`).toHaveLength(1);
  });
  it('the entry file creates exactly one logger under the shared name', () => {
    expect([...appSrc(ENTRY).matchAll(/createChildLogger\(\{ module: '([^']+)' \}\)/g)].map((m) => m[1])).toEqual(['trading-schedule-dispatch']);
  });
});

describe('(e) the watchdog grep strings stay in the ENTRY file (scripts/trading-watchdog.ps1 reads them from the log)', () => {
  const src = appSrc(ENTRY);
  it.each(['autopilot run complete', 'venue clock unreachable', 'TRADING_HALT kill switch engaged', 'autopilot skipped - '])('%s', (s) => {
    expect(src).toContain(s);
  });
  it('no leg module emits those lines (a later carve must not move them silently)', () => {
    for (const leg of LEGS) {
      const s = appSrc(leg);
      for (const needle of ['autopilot run complete', 'venue clock unreachable', 'TRADING_HALT kill switch engaged']) expect(s, leg).not.toContain(needle);
    }
  });
});

describe('(f) every in-repo importer of the entry names only symbols the barrel still exports', () => {
  const importers: Array<{ file: string; names: string[]; types: string[] }> = [];
  for (const dir of ['src/app', 'scripts', 'tests/unit']) {
    for (const f of readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith('.ts'))) {
      const rel = `${dir}/${f}`;
      if (rel === `src/app/${ENTRY}.ts`) continue;
      const src = read(rel);
      for (const m of src.matchAll(/import \{([^}]+)\} from '(?:@\/app|\.\.\/src\/app|\.\.\/\.\.\/src\/app|\.)\/trading-schedule-dispatch'/g)) {
        const specs = m[1].split(',').map((s) => s.trim()).filter(Boolean);
        importers.push({
          file: rel,
          names: specs.filter((s) => !s.startsWith('type ')).map((s) => s.split(/\s+as\s+/)[0]),
          types: specs.filter((s) => s.startsWith('type ')).map((s) => s.replace(/^type\s+/, '').split(/\s+as\s+/)[0]),
        });
      }
    }
  }
  it('finds the known importers (schedule-runtime, research-dispatch, strategy-lab-sim, the rotation backtest, the specs)', () => {
    const files = importers.map((i) => i.file);
    for (const f of ['src/app/schedule-runtime.ts', 'src/app/trading-research-dispatch.ts', 'src/app/trading-strategy-lab-sim.ts', 'scripts/oshal-trading-rotation-backtest.ts', 'tests/unit/trading-sizing-venue.spec.ts']) {
      expect(files, `expected ${f} to import the entry`).toContain(f);
    }
  });
  it('each importer resolves every name it imports', () => {
    for (const i of importers) {
      for (const n of i.names) expect(PRE_SPLIT_EXPORTS, `${i.file} imports ${n}`).toContain(n);
      for (const t of i.types) expect(PRE_SPLIT_TYPES, `${i.file} imports type ${t}`).toContain(t);
    }
  });
});
