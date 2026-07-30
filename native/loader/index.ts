/**
 * The kernel loader — instantiate the WASM module if it is present, otherwise report absence so
 * the caller uses the TypeScript reference path.
 *
 * OPTIONAL BY CONSTRUCTION. `native/dist/oshal_kernel.wasm` is a build product and is NOT tracked
 * (see native/.gitignore). A checkout without it is a SUPPORTED state, not a broken one:
 * [`loadKernel`] returns `null`, every caller falls back to the existing TS implementation, and
 * nothing in the platform changes except speed. That is the property that lets this land without
 * putting a Rust toolchain on the critical path for anyone else — no bot node, no CI job, and no
 * `oshal-up.sh` bring-up can fail because Rust is missing.
 *
 * FAIL LOUD ON DRIFT, FAIL SOFT ON ABSENCE. Absence is fine. A module whose ABI version or buffer
 * counts disagree with `series.ts` is NOT fine — that is a stale artifact next to newer JS, and
 * reading the old column layout would produce a plausible, wrong backtest. The loader refuses to
 * use such a module and says why.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — synchronous WASM instantiation, ABI cross-check, buffer reuse across calls, zero-copy series views, and the absent-artifact null path.
 *
 * @module native/loader
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ABI_VERSION, PARAM_COUNT, SERIES_COUNT, SERIES_NAMES,
  packParams, type IndicatorConfig,
} from './series';

/** A bar in the shape the trading feature already uses (`OhlcvBar`). */
export interface Bar { o: number; h: number; l: number; c: number; v: number }

/** The instantiated kernel. */
export interface Kernel {
  /**
   * Compute every indicator series for `bars`.
   *
   * The returned views are ZERO-COPY windows into WASM linear memory and are valid only until the
   * next `compute` call on this kernel. Copy anything you need to retain. This is the reason the
   * kernel is fast on large series — a 40-series × 1.7M-bar result is ~540MB that never gets
   * copied — and it is the one sharp edge of the API.
   */
  compute(bars: readonly Bar[], cfg: IndicatorConfig): Float64Array[];
  /** Bytes of WASM linear memory currently committed — for the benchmark's reporting. */
  memoryBytes(): number;
}

/** Exported shape of the compiled module. */
interface KernelExports {
  memory: WebAssembly.Memory;
  kernel_alloc(len: number): number;
  kernel_compute(bars: number, n: number, params: number, out: number): void;
  kernel_series_count(): number;
  kernel_param_count(): number;
  kernel_abi_version(): number;
}

/**
 * Default artifact location, resolved relative to THIS FILE so the caller's cwd does not matter.
 *
 * `__dirname` rather than `import.meta.url`: the package is CommonJS (`tsconfig` module `Node16`, no
 * `"type": "module"`), and the single-executable build bundles this to CJS — where `import.meta` is
 * empty and esbuild warns about it. An `import.meta` fallback here would be a dead branch that emits
 * a build warning on every packaging run.
 */
function defaultWasmPath(): string {
  return join(__dirname, '..', 'dist', 'oshal_kernel.wasm');
}

/**
 * @description Load and instantiate the native indicator kernel.
 * @param wasmPath - Override the artifact path; defaults to `native/dist/oshal_kernel.wasm`.
 * @returns A {@link Kernel}, or `null` when the artifact is absent (build it with
 *   `node native/build.js`). Throws only when a module IS present but its ABI disagrees with this
 *   loader — a stale-artifact condition that must not be silently tolerated.
 */
export function loadKernel(wasmPath = defaultWasmPath()): Kernel | null {
  if (!existsSync(wasmPath)) return null;
  return loadKernelFromBytes(readFileSync(wasmPath), wasmPath);
}

/**
 * @description Instantiate the kernel from module bytes already in memory, rather than from a path.
 *
 * This exists for the single-executable build: a packaged binary carries the `.wasm` as an embedded
 * SEA asset (`node:sea` `getAsset`), where there is no file to stat. Same ABI checks, same contract.
 * @param bytes - The compiled WebAssembly module.
 * @param origin - Label used in error messages to say where the bytes came from.
 * @returns A {@link Kernel}. Throws on an ABI mismatch, exactly as {@link loadKernel} does.
 */
export function loadKernelFromBytes(
  bytes: Uint8Array | ArrayBuffer,
  origin = '<in-memory>',
): Kernel {
  const wasmPath = origin;
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, {});
  const ex = instance.exports as unknown as KernelExports;

  const abi = ex.kernel_abi_version();
  const series = ex.kernel_series_count();
  const params = ex.kernel_param_count();
  if (abi !== ABI_VERSION || series !== SERIES_COUNT || params !== PARAM_COUNT) {
    throw new Error(
      `native kernel ABI mismatch — artifact says (abi=${abi}, series=${series}, params=${params}), `
      + `loader expects (abi=${ABI_VERSION}, series=${SERIES_COUNT}, params=${PARAM_COUNT}). `
      + `The .wasm at ${wasmPath} is stale; rebuild with \`node native/build.js\`.`,
    );
  }

  // Buffers are allocated on first use and grown by reallocation. `kernel_alloc` leaks, so we keep
  // one set per kernel and only re-allocate when a larger series arrives — a parameter sweep over
  // one bar series therefore allocates exactly once.
  let capacity = 0;
  let barsPtr = 0;
  let outPtr = 0;
  let paramsPtr = 0;

  /** (Re)allocate for `n` bars if the current buffers are too small. */
  function ensure(n: number): void {
    if (n <= capacity) return;
    barsPtr = ex.kernel_alloc(5 * n);
    outPtr = ex.kernel_alloc(SERIES_COUNT * n);
    if (paramsPtr === 0) paramsPtr = ex.kernel_alloc(PARAM_COUNT);
    capacity = n;
  }

  return {
    compute(bars: readonly Bar[], cfg: IndicatorConfig): Float64Array[] {
      const n = bars.length;
      if (n === 0) return Array.from({ length: SERIES_COUNT }, () => new Float64Array(0));
      ensure(n);

      // Write bars column-major. Views are rebuilt every call because `ensure` may have grown
      // linear memory, which detaches any previously-created view.
      const heap = new Float64Array(ex.memory.buffer, barsPtr, 5 * n);
      for (let i = 0; i < n; i++) {
        const b = bars[i];
        heap[i] = b.o;
        heap[n + i] = b.h;
        heap[2 * n + i] = b.l;
        heap[3 * n + i] = b.c;
        heap[4 * n + i] = b.v;
      }
      new Float64Array(ex.memory.buffer, paramsPtr, PARAM_COUNT).set(packParams(cfg));

      ex.kernel_compute(barsPtr, n, paramsPtr, outPtr);

      const out: Float64Array[] = new Array(SERIES_COUNT);
      for (let s = 0; s < SERIES_COUNT; s++) {
        out[s] = new Float64Array(ex.memory.buffer, outPtr + s * n * 8, n);
      }
      return out;
    },
    memoryBytes(): number {
      return ex.memory.buffer.byteLength;
    },
  };
}

/**
 * @description Describe why the kernel is unavailable, for a log line or a benchmark banner.
 * @param wasmPath - Artifact path to check; defaults to the standard location.
 * @returns A human-readable status string.
 */
export function kernelStatus(wasmPath = defaultWasmPath()): string {
  if (!existsSync(wasmPath)) {
    return `absent (${wasmPath}) — using the TypeScript reference path. Build: node native/build.js`;
  }
  return `present (${wasmPath})`;
}

export { SERIES_NAMES };
export * from './series';
