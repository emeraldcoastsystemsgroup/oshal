/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation (ADR-169 L1). The one error shape location code may log. ADR-169 D3 forbids logging an error object from the location slice or routes, because an error message can carry a URL with coordinates (a reverse-geocode or provider request) and pino redaction cannot see inside a string. The house rule still wants every catch to log the error and its stack, so this projection keeps the class name, a code-shaped code and the stack FRAMES, and drops the message, every line that is not a frame, URL queries, file fragments and every network URL (any scheme but file://). The static log guard (tests/unit/location-log-guard.spec.ts) accepts an `err` field only when its value is a call to this function imported from '@/shared/logger'.
 */

/**
 * @description What location code logs for a caught error: enough to find the failing code, and
 * nothing that can carry a coordinate, an address, a place name or a URL.
 */
export interface LocationSafeError {
  /** The error's class name (e.g. 'TypeError'); 'Error' when the name is not identifier-shaped; 'NonError' for a thrown non-error value. */
  name: string;
  /** A symbolic code such as 'ECONNREFUSED' or a SQLSTATE, only when it is plain letters, digits and underscores. */
  code?: string;
  /** Stack frames only ("at fn (file:line:col)"), with network URLs, queries and file fragments removed. */
  frames: string[];
}

const NAME_SHAPE = /^[A-Za-z_$][\w$.]{0,63}$/;
const CODE_SHAPE = /^[A-Za-z0-9_]{1,64}$/;
const FRAME_SHAPE = /^at\s.*(?::\d+:\d+\)?|\((?:native|<anonymous>)\))$/;
/** Any scheme://… except file:// (which V8 prints for ES module frames). */
const NETWORK_URL = /\b(?!file:)[a-z][a-z0-9+.-]*:\/\/[^\s)]*/gi;
const QUERY = /\?[^\s:)]*/g;
/** A fragment right after a script extension; a private member name such as `Foo.#bar` is kept. */
const FILE_FRAGMENT = /(\.[cm]?[jt]sx?)#[^\s:)]*/g;
const MAX_FRAMES = 12;

/** A value with the shape of an Error (an Error from another realm included). */
type ErrorLike = { name?: unknown; message?: unknown; stack?: unknown; code?: unknown };

/**
 * @description Keep an error name only when it is identifier-shaped.
 * @param value - The raw `name` property.
 * @returns The name, or 'Error'.
 */
function safeName(value: unknown): string {
  return typeof value === 'string' && NAME_SHAPE.test(value) ? value : 'Error';
}

/**
 * @description Keep an error code only when it is a bare symbol or an integer.
 * @param value - The raw `code` property.
 * @returns The code as a string, or undefined.
 */
function safeCode(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  return typeof value === 'string' && CODE_SHAPE.test(value) ? value : undefined;
}

/**
 * @description Reduce a stack to its frames. The header (`Name: message`) is cut when the stack
 * starts with it, and any remaining line that is not frame-shaped is dropped, so a multi-line
 * message never survives. Surviving frames lose network URLs, queries and file fragments.
 * @param error - The error-like value.
 * @returns At most MAX_FRAMES scrubbed frame lines.
 */
function stackFrames(error: ErrorLike): string[] {
  if (typeof error.stack !== 'string' || !error.stack) return [];
  const name = typeof error.name === 'string' ? error.name : 'Error';
  const message = typeof error.message === 'string' ? error.message : '';
  const header = message ? `${name}: ${message}` : name;
  const body = error.stack.startsWith(header) ? error.stack.slice(header.length) : error.stack;
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => FRAME_SHAPE.test(line))
    .map((line) => line.replace(NETWORK_URL, '<url>').replace(QUERY, '').replace(FILE_FRAGMENT, '$1'))
    .slice(0, MAX_FRAMES);
}

/**
 * @description Project a caught value into the only error shape location code may log
 * (ADR-169 D3 "No location in logs"). Use as `log.error({ err: locationSafeError(e) }, 'msg')`.
 * @param error - Whatever was caught.
 * @returns The class name, an optional code and the scrubbed stack frames; never the message.
 */
export function locationSafeError(error: unknown): LocationSafeError {
  if (error === null || typeof error !== 'object') return { name: 'NonError', frames: [] };
  const candidate = error as ErrorLike;
  const isErrorLike = error instanceof Error || typeof candidate.stack === 'string';
  const code = safeCode(candidate.code);
  const base: LocationSafeError = {
    name: isErrorLike ? safeName(candidate.name) : 'NonError',
    frames: isErrorLike ? stackFrames(candidate) : [],
  };
  return code === undefined ? base : { ...base, code };
}
