/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added structured browser-side error reporting helper for chat debug tooling
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | FSD lint burn-down: annotated the deliberate browser console.error (no Node logger in the DOM) with a file-scoped no-console disable
 */

/* eslint-disable no-console -- client-side: browser debug-log helper shipped to the DOM (consumed by React hooks useDebugStream / useSwarmDebugPanel; no Node/Pino logger available) */

interface ClientDebugLogContext {
  [key: string]: unknown;
}

/**
 * @description Emits a structured browser error log for chat debug tooling without swallowing context.
 * @param moduleName - UI module reporting the error
 * @param action - Logical action that failed
 * @param error - Unknown thrown value
 * @param context - Optional non-sensitive context fields
 * @returns Nothing
 */
export function reportClientDebugError(
  moduleName: string,
  action: string,
  error: unknown,
  context: ClientDebugLogContext = {},
): void {
  const payload = {
    level: 'error',
    module: moduleName,
    action,
    timestamp: new Date().toISOString(),
    ...context,
    error: serializeClientError(error),
  };

  console.error(JSON.stringify(payload));
}

function serializeClientError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: typeof error === 'string' ? error : 'Unknown browser debug error',
  };
}
