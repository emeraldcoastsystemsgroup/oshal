/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

const STORE_KEY = '__OSHAL_UI_DEBUG__';
const MAX_ENTRIES = 400;

function getDebugStore() {
  const globalObject = typeof window !== 'undefined' ? window : globalThis;
  const existing = globalObject[STORE_KEY];
  if (existing && typeof existing.push === 'function') {
    return existing;
  }

  const store = {
    entries: [],
    push(entry) {
      this.entries.push(entry);
      if (this.entries.length > MAX_ENTRIES) {
        this.entries.splice(0, this.entries.length - MAX_ENTRIES);
      }
    },
    clear() {
      this.entries.length = 0;
    },
    getEntries() {
      return [...this.entries];
    },
  };

  globalObject[STORE_KEY] = store;
  return store;
}

/**
 * @description Normalizes an arbitrary thrown value into a plain, log-safe shape
 * so UI debug entries stay serializable and consistent regardless of whether the
 * caller threw an Error, a string, or something unexpected.
 * @param {*} error The thrown value or error to normalize for logging.
 * @returns {{name?: string, message: string, stack?: string}} A plain object capturing the error details.
 */
export function serializeUiError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: typeof error === 'string' ? error : 'Unknown UI error',
  };
}

function writeConsoleEntry(level, entry) {
  const consoleMethod = typeof console?.[level] === 'function'
    ? console[level].bind(console)
    : console.log.bind(console);
  consoleMethod(`[oshal-ui][${entry.module}] ${entry.message}`, entry);
}

/**
 * @description Builds a timestamped debug entry, retains it in the bounded
 * in-memory store, and mirrors it to the browser console so transient UI events
 * are both inspectable later and visible in real time during development.
 * @param {string} level The severity level (e.g. 'debug', 'info', 'warn', 'error').
 * @param {string} moduleName The name of the UI module emitting the log.
 * @param {string} message The human-readable log message.
 * @param {Object} [context={}] Additional structured fields to merge into the entry.
 * @returns {Object} The constructed log entry that was stored and printed.
 */
export function emitUiDebugLog(level, moduleName, message, context = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    module: moduleName,
    message,
    ...context,
  };

  getDebugStore().push(entry);
  writeConsoleEntry(level, entry);
  return entry;
}

/**
 * @description Creates a module-scoped logger so callers can emit leveled debug
 * entries without repeating the module name or shared context on every call, with
 * `child` enabling further-scoped loggers that inherit accumulated bindings.
 * @param {string} moduleName The module name stamped onto every entry from this logger.
 * @param {Object} [bindings={}] Context fields automatically merged into each log call.
 * @returns {{debug: Function, info: Function, warn: Function, error: Function, child: Function}} A logger with leveled methods and a child factory.
 */
export function createUiLogger(moduleName, bindings = {}) {
  const withBindings = (context = {}) => ({ ...bindings, ...context });

  return {
    debug(message, context = {}) {
      return emitUiDebugLog('debug', moduleName, message, withBindings(context));
    },
    info(message, context = {}) {
      return emitUiDebugLog('info', moduleName, message, withBindings(context));
    },
    warn(message, context = {}) {
      return emitUiDebugLog('warn', moduleName, message, withBindings(context));
    },
    error(message, context = {}) {
      return emitUiDebugLog('error', moduleName, message, withBindings(context));
    },
    child(context = {}) {
      return createUiLogger(moduleName, withBindings(context));
    },
  };
}

/**
 * @description Returns a defensive copy of the retained debug entries so callers
 * (e.g. a debug panel or error reporter) can read history without being able to
 * mutate the underlying store.
 * @returns {Object[]} A snapshot array of the currently stored log entries.
 */
export function getUiDebugEntries() {
  return getDebugStore().getEntries();
}
