/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | New. onnxruntime-web's Emscripten Node shell appends two process-global rethrow listeners the moment the wasm initialises (`process.on('unhandledRejection', t => { throw t })` and `process.on('uncaughtException', t => { if (!(t instanceof ExitStatus)) throw t })`, dist/ort-web.node.js). They land BEHIND installProcessCrashGuards, so from that instant any unhandled rejection anywhere in the controller is rethrown from inside the rejection handler, becomes an uncaught exception, is rethrown again from inside the exception handler, and kills the process with exit code 7 and half a megabyte of minified bundle on stderr — before the crash guards' 250 ms log flush runs. This module snapshots the two listener lists before the runtime loads and removes exactly the rethrow-shaped listeners the runtime added, leaving every listener the process legitimately owns in place.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Warn when listeners appeared since the snapshot and none matched the rethrow shape. The strip logged only on success, so it was silent in exactly the case worth hearing about - a minifier change renaming the throw, or a new listener shape, would have degraded the fix with nothing in the log.
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'onnx-process-guards' });

/** The two process events the ONNX Emscripten shell hijacks. */
const GUARDED_EVENTS = ['unhandledRejection', 'uncaughtException'] as const;

type GuardedEvent = (typeof GUARDED_EVENTS)[number];

/** Listener lists captured before the ONNX runtime is imported. */
export type ProcessGuardSnapshot = Record<GuardedEvent, Function[]>;

/** What a strip actually removed — logged, and asserted by the regression guard. */
export interface StripResult {
  /** Listeners removed per event. */
  removed: Record<GuardedEvent, number>;
  /** Listeners added since the snapshot that were left alone (not rethrow-shaped). */
  kept: Record<GuardedEvent, number>;
}

/**
 * @description True when a listener's only effect on the value it is handed is to
 * throw it again — the Emscripten shape, in both its bare (`function(t){throw t}`)
 * and ExitStatus-filtered (`function(t){if(!(t instanceof K))throw t}`) forms, and
 * in arrow form should a future build emit one.
 *
 * Matching on the SHAPE rather than on the library that registered it is deliberate:
 * a listener that rethrows its own argument from inside an `unhandledRejection` or
 * `uncaughtException` handler is unconditionally fatal to a long-running service,
 * whichever dependency installed it. oshal's own guards log and never throw their
 * argument, so they can never match.
 *
 * @param listener - A process listener function to classify.
 * @returns True when the listener rethrows its first parameter.
 */
export function isRethrowListener(listener: Function): boolean {
  let source: string;
  try {
    source = Function.prototype.toString.call(listener);
  } catch {
    return false;
  }
  // Name of the listener's first parameter, then a `throw <that same parameter>`
  // in its body. Tying the throw back to the parameter is what keeps this from
  // matching a handler that throws something it constructed itself.
  // `paren` covers `function (t) {`, `function name(t) {` and `(t) => {` alike;
  // `bare` covers the parenthesis-free arrow `t => {`.
  const paren = /^[^(]{0,64}\(\s*([\w$]+)\s*[),]/.exec(source);
  const bare = /^(?:async\s+)?([\w$]+)\s*=>/.exec(source);
  const param = paren?.[1] ?? bare?.[1];
  if (!param) return false;
  const escaped = param.replace(/\$/g, '\\$');
  return new RegExp(String.raw`\bthrow\s+${escaped}\s*[;}\n]`).test(source);
}

/**
 * @description Captures the current `unhandledRejection` / `uncaughtException`
 * listener lists so a later strip can tell "was already here" from "the ONNX
 * runtime just added this". Call it BEFORE importing anything that pulls in the
 * runtime.
 * @returns The captured listener lists.
 */
export function snapshotProcessGuards(): ProcessGuardSnapshot {
  return {
    unhandledRejection: process.listeners('unhandledRejection').slice(),
    uncaughtException: process.listeners('uncaughtException').slice(),
  };
}

/**
 * @description Removes every rethrow-shaped listener registered since `snapshot`.
 *
 * Two conditions must both hold before a listener is removed: it is absent from the
 * snapshot, and it rethrows its own argument. The first protects handlers the api
 * legitimately installs while the 4-5 s model load is in flight; the second protects
 * oshal's own crash guards, which are in the snapshot anyway. Nothing is added — a
 * swallowing catch-all would trade a loud crash for a silent one.
 *
 * @param snapshot - The listener lists captured by snapshotProcessGuards().
 * @returns Counts of what was removed and what was left in place.
 */
export function stripRethrowGuards(snapshot: ProcessGuardSnapshot): StripResult {
  const result: StripResult = {
    removed: { unhandledRejection: 0, uncaughtException: 0 },
    kept: { unhandledRejection: 0, uncaughtException: 0 },
  };
  for (const event of GUARDED_EVENTS) {
    const known = new Set(snapshot[event]);
    // Cast to the base emitter: process's per-event overloads do not accept an
    // event name narrowed only to a union of the two literals.
    const emitter = process as NodeJS.EventEmitter;
    for (const listener of emitter.listeners(event)) {
      if (known.has(listener)) continue;
      if (!isRethrowListener(listener)) {
        result.kept[event] += 1;
        continue;
      }
      emitter.removeListener(event, listener as (...args: unknown[]) => void);
      result.removed[event] += 1;
    }
  }
  const total = result.removed.unhandledRejection + result.removed.uncaughtException;
  const survivors = result.kept.unhandledRejection + result.kept.uncaughtException;
  if (total > 0) {
    logger.warn(
      { removed: result.removed, kept: result.kept },
      'Removed process-global rethrow listeners installed by the ONNX runtime — a stray rejection is survivable again',
    );
  } else if (survivors > 0) {
    // The failure mode worth hearing about: the runtime registered listeners and the classifier
    // matched none of them — a minifier change renaming the throw, or a new listener shape. Logging
    // only on success would make exactly that case silent.
    logger.warn(
      { kept: result.kept },
      'The ONNX runtime added process listeners and none matched the rethrow shape — the strip may have stopped working; a stray rejection could be fatal again',
    );
  }
  return result;
}
