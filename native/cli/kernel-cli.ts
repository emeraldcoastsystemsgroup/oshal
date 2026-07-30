/**
 * `oshal-kernel` — the standalone CLI, and the proof that a real single-file executable is
 * reachable for this codebase.
 *
 * WHY THIS IS THE THING THAT GOT PACKAGED FIRST. ROADMAP item 4 is "one `oshal.exe` that boots the
 * controller with no Node installed". The controller pulls in express, pg, ioredis and a stack of
 * native bindings, so that is a real project. This CLI is the same mechanism proven end to end on a
 * target that has ZERO native dependencies: bundle → SEA blob → inject → run. If the mechanism works
 * here it works there; what remains for the controller is dependency surgery, not an unknown.
 *
 * It also happens to be genuinely useful — it runs the indicator kernel, the parity check and the
 * benchmark on a machine with no Node, no Rust and no repo checkout.
 *
 * THE WASM TRAVELS INSIDE THE BINARY. When running as a packaged executable the module is read via
 * `node:sea` `getAsset('kernel.wasm')`; when running from source it is read from `native/dist/`.
 * Both paths go through the same ABI checks. `--where` reports which one is in effect.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — bench/parity/where subcommands over the kernel, with SEA-embedded WASM and a source-tree fallback.
 *
 * @module native/cli/kernel-cli
 */

import { loadKernel, loadKernelFromBytes, kernelStatus, type Kernel } from '../loader';
import { computeReference } from '../loader/reference';
import { DEFAULT_CONFIG, SERIES_NAMES, SERIES_COUNT } from '../loader/series';
import { makeBars } from '../bench/bars';

/** Marks whether the kernel came from the embedded asset or the source tree. */
type KernelOrigin = 'embedded (SEA asset)' | 'source tree' | 'unavailable';

/**
 * @description Resolve the kernel, preferring the embedded SEA asset and falling back to the
 * on-disk artifact. Never throws for absence — an unavailable kernel is a supported state, and the
 * caller reports it rather than dying.
 * @returns The kernel (or null) plus where it came from.
 */
function resolveKernel(): { kernel: Kernel | null; origin: KernelOrigin } {
  // node:sea is only meaningful inside a packaged binary; importing it from source is harmless but
  // isSea() is false, so this whole branch is skipped in dev.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const sea = require('node:sea') as {
      isSea(): boolean; getAsset(key: string): ArrayBuffer;
    };
    if (sea.isSea()) {
      return {
        kernel: loadKernelFromBytes(sea.getAsset('kernel.wasm'), 'SEA asset kernel.wasm'),
        origin: 'embedded (SEA asset)',
      };
    }
  } catch {
    // Not a SEA build, or node:sea unavailable — fall through to the disk path.
  }
  const kernel = loadKernel();
  return { kernel, origin: kernel ? 'source tree' : 'unavailable' };
}

/** ULP distance between two doubles; 0 means bit-identical. */
function ulpDiff(a: number, b: number): number {
  if (Number.isNaN(a) && Number.isNaN(b)) return 0;
  if (a === b) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  const buf = new ArrayBuffer(8);
  const f = new Float64Array(buf);
  const i = new BigInt64Array(buf);
  f[0] = a; const ia = i[0];
  f[0] = b; const ib = i[0];
  const key = (x: bigint): bigint => (x < 0n ? -9223372036854775808n - x : x);
  const d = key(ia) - key(ib);
  return Number(d < 0n ? -d : d);
}

/** Median of a numeric sample. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const HELP = `oshal-kernel — standalone futures indicator kernel

USAGE
  oshal-kernel where                 report build info and where the kernel came from
  oshal-kernel bench [bars]          time the TypeScript path against the WASM kernel
  oshal-kernel parity [bars]         verify all ${SERIES_COUNT} series agree bit for bit
  oshal-kernel help                  this text

Bars default to 100000. Synthetic seeded input — this measures throughput and verifies
agreement; it is NOT a strategy result.
`;

/** `where` — build provenance, so a binary handed to someone can identify itself. */
function cmdWhere(): number {
  const { kernel, origin } = resolveKernel();
  console.log('\noshal-kernel');
  console.log('-'.repeat(52));
  console.log(`kernel origin  : ${origin}`);
  console.log(`node runtime   : ${process.version}`);
  console.log(`platform       : ${process.platform}-${process.arch}`);
  console.log(`packaged       : ${origin.startsWith('embedded') ? 'yes — single executable' : 'no — running from source'}`);
  console.log(`series         : ${SERIES_COUNT}`);
  if (kernel) {
    console.log(`wasm memory    : ${(kernel.memoryBytes() / 1024).toFixed(0)} KB committed`);
  } else {
    console.log(`status         : ${kernelStatus()}`);
  }
  console.log('');
  return 0;
}

/** `bench` — the headline comparison. */
function cmdBench(n: number): number {
  const { kernel, origin } = resolveKernel();
  const bars = makeBars(n);
  console.log(`\nbench — ${n.toLocaleString()} bars · kernel: ${origin}\n`);

  const runs = n <= 100_000 ? 7 : 5;
  const tsSamples: number[] = [];
  computeReference(bars, DEFAULT_CONFIG); // warm
  for (let r = 0; r < runs; r++) {
    const t0 = process.hrtime.bigint();
    computeReference(bars, DEFAULT_CONFIG);
    tsSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const tsMed = median(tsSamples);
  console.log(`  TypeScript   ${tsMed.toFixed(0).padStart(6)} ms   `
    + `(${Math.min(...tsSamples).toFixed(0)}-${Math.max(...tsSamples).toFixed(0)} ms over ${runs} runs)`);

  if (!kernel) {
    console.log('\n  WASM kernel  unavailable — TypeScript is the only path here.');
    console.log(`  ${kernelStatus()}\n`);
    return 0;
  }

  const wSamples: number[] = [];
  kernel.compute(bars, DEFAULT_CONFIG); // warm
  for (let r = 0; r < runs; r++) {
    const t0 = process.hrtime.bigint();
    kernel.compute(bars, DEFAULT_CONFIG);
    wSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const wMed = median(wSamples);
  console.log(`  WASM kernel  ${wMed.toFixed(0).padStart(6)} ms   `
    + `(${Math.min(...wSamples).toFixed(0)}-${Math.max(...wSamples).toFixed(0)} ms over ${runs} runs)`);
  console.log(`\n  speedup      ${(tsMed / wMed).toFixed(1)}x median`
    + `   (range ${(Math.min(...tsSamples) / Math.max(...wSamples)).toFixed(1)}`
    + `-${(Math.max(...tsSamples) / Math.min(...wSamples)).toFixed(1)}x)`);
  console.log(`  throughput   ${((n / wMed) / 1000).toFixed(2)} M bars/s\n`);
  return 0;
}

/** `parity` — the correctness claim, checkable by whoever holds the binary. */
function cmdParity(n: number): number {
  const { kernel, origin } = resolveKernel();
  if (!kernel) {
    console.error(`\nparity — no kernel to compare against (${kernelStatus()})\n`);
    return 1;
  }
  const bars = makeBars(n);
  console.log(`\nparity — ${n.toLocaleString()} bars · kernel: ${origin}\n`);

  const nat = kernel.compute(bars, DEFAULT_CONFIG).map((v) => Float64Array.from(v));
  const ref = computeReference(bars, DEFAULT_CONFIG);

  let exact = 0;
  const failures: string[] = [];
  for (let s = 0; s < SERIES_COUNT; s++) {
    let worst = 0;
    let worstAt = -1;
    for (let i = 0; i < n; i++) {
      const u = ulpDiff(ref[s][i], nat[s][i]);
      if (u > worst) { worst = u; worstAt = i; }
    }
    if (worst === 0) exact++;
    else failures.push(`${SERIES_NAMES[s]}: ${worst} ULP at bar ${worstAt}`);
  }

  console.log(`  bit-exact series : ${exact}/${SERIES_COUNT}`);
  if (failures.length) {
    console.log('\n  DIVERGENCES:');
    for (const f of failures) console.log(`    ${f}`);
    console.log('');
    return 1;
  }
  console.log('  all series identical to the last bit.\n');
  return 0;
}

const argv = process.argv.slice(2);
const cmd = (argv[0] || 'where').toLowerCase();
const bars = Number(argv.find((a) => /^\d+$/.test(a)) || 100_000);

let code = 0;
switch (cmd) {
  case 'where': case 'info': code = cmdWhere(); break;
  case 'bench': code = cmdBench(bars); break;
  case 'parity': code = cmdParity(bars); break;
  case 'help': case '--help': case '-h': console.log(HELP); break;
  default:
    console.error(`unknown command: ${cmd}\n`);
    console.log(HELP);
    code = 2;
}
process.exit(code);
