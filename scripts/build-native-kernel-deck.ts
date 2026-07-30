/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — generates the native-kernel deck through the repo's own presentation-generation feature (dogfoods renderPptx rather than adding a second deck pipeline).
 *
 * Generates the "should we rewrite it in a compiled language" deck.
 *
 * WHY A GENERATOR AND NOT A CHECKED-IN DECK. The anti-drift rules in CLAUDE.md are explicit that a
 * generator is a surface: a pptx builder holding stale figures while the docs were clean is a real
 * failure this project has already had. So the numbers live HERE, once, next to a pointer at the
 * measurement that produced them — and the .pptx is a build product you re-run.
 *
 * It renders through `@/features/presentation-generation` (the AI Office feature) rather than calling
 * pptxgenjs directly, so the deck inherits the shipped themes and layout auto-selection and there is
 * only ever one deck pipeline to maintain.
 *
 * Usage:
 *   npx tsx scripts/build-native-kernel-deck.ts [--theme <id>] [--out <path>]
 *
 * @module scripts/build-native-kernel-deck
 */

import * as fs from 'fs';
import * as path from 'path';
import { renderPptx, isThemeId } from '@/features/presentation-generation';
import type { DeckThemeId, RenderableSlide } from '@/shared/types';

/**
 * SOURCE OF TRUTH FOR EVERY FIGURE IN THIS DECK.
 *
 * Regenerate with: `npx tsx native/bench/profile-ts.ts 200000` and
 * `npx tsx native/bench/compare.ts 25000 100000 400000`. If you change a number here without a
 * fresh run behind it, you have created exactly the drift this comment exists to prevent.
 *
 * Posture: measured 2026-07-29 on the operator's dev box WITH the agent stack running. The spread is
 * wide and is reported as a range on the slides, not smoothed to a midpoint.
 */
const MEASURED = {
  takenOn: '2026-07-29',
  host: 'node 24.11 · win32-x64 · dev box, swarm running',
  /** Controller latency, the argument against a platform rewrite. */
  controller: [
    ['pure-JS API route, no I/O', '4-5 ms'],
    ['API route + one Postgres round-trip', '6-35 ms'],
    ['dispatch work to a language model', '2,000-120,000 ms'],
  ] as const,
  /** Top of the indicator profile at 200k bars, ms. */
  profile: [
    ['superTrendM11', 274],
    ['dmiAdx', 180],
    ['adaptiveLaguerre', 135],
    ['dmiWave', 116],
    ['chandelierBands', 116],
    ['movingMedian', 97],
  ] as const,
  profileTotalMs: 1245,
  profileBars: 200_000,
  /** TS vs WASM, zero-copy read-out. */
  results: [
    [25_000, 90, 16, '5.6x', '3.7-7.7x'],
    [100_000, 376, 56, '6.7x', '4.9-9.1x'],
    [400_000, 1474, 250, '5.9x', '4.4-8.5x'],
  ] as const,
  seriesCount: 40,
  testsWithKernel: 88,
  testsWithoutKernel: 6,
  wasmBytes: 40_181,
  portedLines: 900,
  tsLines: '249K',
} as const;

/** `label :: value` KPI line — the label carries the number so the parser reads it as a metric. */
const kpi = (n: string, caption: string): string => `${n} :: ${caption}`;

const SLIDES: RenderableSlide[] = [
  {
    title: 'The instinct is to blame the language',
    content: '#layout: statement\nIt explains everything, and the fix is heroic.',
    notes: 'Open on the temptation, not the answer. Everyone in the room has felt this.',
  },
  {
    title: 'So we measured the control plane first',
    content: `| What | Time |\n| --- | --- |\n${
      MEASURED.controller.map(([w, t]) => `| ${w} | ${t} |`).join('\n')}`,
    notes: 'The controller routes, queues, dispatches and waits. It never calls a model itself.',
  },
  {
    title: 'A rewrite optimizes the 4 milliseconds',
    content: '#layout: statement\nThe 30-second wait stays exactly where it is.',
    notes: 'This is the whole argument. Say it once, plainly, and move on.',
  },
  {
    title: 'Two more reasons it gets worse',
    content: 'The worker CLIs we orchestrate are themselves Node programs — a compiled control '
      + 'plane still ships a JavaScript runtime to run its own workers\n'
      + 'The entire browser UI cannot be compiled, because browsers run JavaScript\n'
      + `Scope of the proposal: ~${MEASURED.tsLines} lines of TypeScript, 579 end-to-end tests, `
      + 'years of encoded decisions — to chase 4 ms',
    notes: 'Two runtimes instead of one is the detail that usually lands hardest.',
  },
  {
    title: 'But the same profile found the exception',
    content: `#layout: bar-chart\n${MEASURED.profile.map(([n, ms]) => `${n}: ${ms}`).join('\n')}`,
    notes: `One numeric layer: ${MEASURED.profileTotalMs} ms for `
      + `${MEASURED.profileBars.toLocaleString()} bars. Fifteen passes over every bar.`,
  },
  {
    title: 'What that costs in practice',
    // Pinned: these are magnitudes, not ordered steps. Auto-select reads the units ("10 s",
    // "1 hour") as non-metric labels and lands on `process`, which reads as a sequence.
    content: ['#layout: kpi-grid',
      kpi('10 s', 'one five-year 1-minute series'),
      kpi('1 hour', 'a 500-combination parameter sweep'),
      kpi(`${MEASURED.portedLines} lines`, 'of pure arithmetic, no I/O'),
    ].join('\n'),
    notes: 'Real money, and the ideal port target: small, numeric, no I/O.',
  },
  {
    title: 'Ported to Rust: the numbers',
    content: '| Bars | Before | After | Speedup | Across runs |\n| --- | --- | --- | --- | --- |\n'
      + MEASURED.results.map(([b, ts, w, s, r]) => `| ${b.toLocaleString()} | ${ts} ms | ${w} ms | ${s} | ${r} |`).join('\n'),
    notes: 'Quote the range, never the peak. One run read 11.1x; repeats put it near 5x.',
  },
  {
    title: 'Defensible summary: 5 to 7 times',
    content: `#layout: statement\nOn a ${(MEASURED.wasmBytes / 1024).toFixed(0)}KB WebAssembly module — with identical results.`,
  },
  {
    title: 'Bit-exact, not close enough',
    content: [
      kpi('0 ULP', `all ${MEASURED.seriesCount} output series identical`),
      kpi(`${MEASURED.testsWithKernel}`, 'tests with the kernel present'),
      kpi(`${MEASURED.testsWithoutKernel}`, 'fallback assertions when absent'),
    ].join('\n'),
    notes: 'Reachable only because three transcendental constants are computed JS-side and passed in.',
  },
  {
    title: 'Four decisions that made a second implementation safe',
    content: 'Cross the language boundary once per run :: never once per calculation\n'
      + 'Verify bit-exactness :: an epsilon hides real divergence\n'
      + 'Name the reference implementation :: when they disagree, the port is wrong\n'
      + 'Make it optional :: nobody else inherits the toolchain',
    notes: 'Boundary-per-bar is the mistake that usually kills this kind of project outright.',
  },
  {
    title: 'The bug the guard caught on its first run',
    content: 'The kernel relied on "unwritten output slots read zero" — true in the original, which '
      + 'allocated fresh arrays per call\nThe new loader REUSED its output buffer, for speed\n'
      + 'Correct on the first call, wrong on every call after, and no error either way\n'
      + 'Only reproducible when a smaller input follows a larger one',
    notes: 'An approximate-tolerance test passes this. That is the argument for exactness.',
  },
  {
    title: 'Compiled or just better laid out?',
    content: '## What actually won\ncolumnar arrays instead of objects\nno per-bar allocation\n'
      + 'one reused output buffer\n## Only then\nregisters, no boxing, inlining',
    notes: 'The first three are reachable in plain TypeScript. Say so out loud.',
  },
  {
    title: 'What we are not claiming',
    content: 'Measured on a busy machine — the baseline swung 2.1x between identical runs; no idle-host '
      + 'or Linux number exists yet\nOne subsystem in isolation, not an end-to-end backtest\n'
      + 'Copying results out of the module costs about half the gain\n'
      + 'Benchmark input is a seeded random walk — not a market simulation, and no strategy result',
    notes: 'Lead with limits before anyone has to ask. This slide is why the rest is credible.',
  },
  {
    title: 'The transferable lesson',
    content: '#layout: statement\nProfile first. Most systems are waiting, not computing.',
  },
  {
    title: 'Next steps',
    content: '#layout: closing\nTry columnar typed arrays in TypeScript before porting anything else\n'
      + 'Measure on an idle host, and on Linux\n'
      + 'github.com/emeraldcoastsystemsgroup/oshal',
  },
];

/** Parse `--flag value` from argv. */
function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const themeArg = flag('theme', 'blueprint');
if (!isThemeId(themeArg)) {
  console.error(`unknown theme "${themeArg}" — see src/features/presentation-generation/services/deck-themes.ts`);
  process.exit(2);
}
const theme = themeArg as DeckThemeId;
const outPath = path.resolve(flag('out', 'docs/assets/oshal/native-kernel-deck.pptx'));

/**
 * @description Render the deck and write it to disk.
 * @returns Resolves when the file is written.
 */
async function main(): Promise<void> {
  const title = 'Should we rewrite it in a compiled language?';
  const buf = await renderPptx(title, SLIDES, {
    theme,
    subtitle: `A measured answer · ${MEASURED.host} · taken ${MEASURED.takenOn}`,
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  try {
    fs.writeFileSync(outPath, buf);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EBUSY' || e.code === 'EPERM') {
      // PowerPoint holds an exclusive lock (and leaves a ~$ shadow file) while a deck is open.
      console.error(`\nCannot write ${outPath} — it looks open in PowerPoint. Close it and re-run.\n`);
      process.exit(1);
    }
    throw err;
  }

  console.log(`\n✔ ${outPath}`);
  console.log(`  ${SLIDES.length} content slides · theme "${theme}" · ${(buf.length / 1024).toFixed(0)} KB`);
  console.log('  Figures come from native/BENCHMARKS.md — re-run the benchmarks before editing them.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
