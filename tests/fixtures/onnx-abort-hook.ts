/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | New. Raises the REAL Emscripten abort from inside a REAL wasm frame mid-inference, for the embedding-abort containment guard. It wraps WebAssembly.instantiate before the ONNX runtime initialises, keeps the runtime's own `_abort` import (the one a C `abort()` reaches: prints `Aborted(` to stderr, sets ABORT, throws a WebAssembly.RuntimeError) and wraps every OTHER import so that, once armed, the next import the wasm calls during a run invokes that real abort. Nothing on the boundary is doubled: the runtime, its abort, the wasm frames the error unwinds through, and the process listeners are all the shipped ones.
 */

/** What the hook exposes to a probe. */
export interface AbortHook {
  /** The import-table key of the runtime's own `_abort` (minified name, reported for the record). */
  abortKey: string | null;
  /** Arm the next wasm-to-JS import call to raise the real abort. */
  arm(): void;
  /** How many real aborts the hook has raised. */
  abortsRaised(): number;
  /** Wasm-to-JS import calls seen since the last resetImportCalls(). */
  importCalls(): number;
  /** Zero the import-call counter, so "did the runtime run at all?" can be asked per call. */
  resetImportCalls(): void;
}

/**
 * Emscripten's `_abort` import as the ORT 1.14 single-thread shell minifies it:
 * `function(){q("")}` — a zero-argument import that hands an empty string to the
 * abort helper. No other import in the table has that shape (measured: 90 imports,
 * exactly one match), and the probe fails loudly rather than guessing if the count
 * is ever not one.
 */
const ABORT_IMPORT_SHAPE = /^function\s*\(\)\s*\{\s*[\w$]+\(""\)\s*\}$/;

/**
 * @description Installs the instantiate wrapper. Must run BEFORE anything imports
 * the ONNX runtime — the wrapper only sees the imports of instantiations that
 * happen after it.
 * @returns The hook's controls.
 */
export function installAbortHook(): AbortHook {
  let armed = false;
  let raised = 0;
  let calls = 0;
  let abortKey: string | null = null;
  let realAbort: ((...args: unknown[]) => unknown) | null = null;
  const realInstantiate = WebAssembly.instantiate;

  const isAbortImport = (fn: unknown): boolean =>
    typeof fn === 'function' && ABORT_IMPORT_SHAPE.test(Function.prototype.toString.call(fn).replace(/\s+/g, ''));

  /** Wraps every function import across all import tables; exactly one must be the runtime's abort. */
  const wrapImports = (imports: WebAssembly.Imports): void => {
    const tables = Object.values(imports).filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === 'object');
    const found = tables.flatMap((table) => Object.keys(table).filter((k) => isAbortImport(table[k])));
    if (found.length !== 1) {
      throw new Error(`onnx-abort-hook: expected exactly one _abort import, found ${found.length} (${found.join(',')})`);
    }
    abortKey = found[0];
    for (const table of tables) {
      for (const [name, fn] of Object.entries(table)) {
        if (typeof fn !== 'function') continue;
        if (name === abortKey) { realAbort = fn as (...args: unknown[]) => unknown; continue; }
        const original = fn as (...args: unknown[]) => unknown;
        table[name] = function wrappedImport(this: unknown, ...args: unknown[]) {
          calls += 1;
          if (armed) {
            armed = false;
            raised += 1;
            // The runtime's own abort, raised from inside the wasm frame that called this import.
            realAbort!();
          }
          return original.apply(this, args);
        };
      }
    }
  };

  (WebAssembly as { instantiate: typeof WebAssembly.instantiate }).instantiate = function hookedInstantiate(
    this: unknown,
    source: any,
    imports?: WebAssembly.Imports,
  ): any {
    if (imports) wrapImports(imports);
    return (realInstantiate as any).call(WebAssembly, source, imports);
  } as typeof WebAssembly.instantiate;

  return {
    get abortKey() { return abortKey; },
    arm: () => { armed = true; },
    abortsRaised: () => raised,
    importCalls: () => calls,
    resetImportCalls: () => { calls = 0; },
  };
}
