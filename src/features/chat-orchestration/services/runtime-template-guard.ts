/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                          | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Phase 0 tool-exec hardening: validate a rendered runtime-template value before it is shell-quoted into a cli command. Complements cli-command-validator (which guards the template's static text) by guarding the substituted values.
 */

import { FatalToolError } from './fatal-tool-error';

/** Max rendered length of a single value substituted into a runtime tool template. */
export const MAX_TEMPLATE_VALUE_BYTES = 16 * 1024;

/**
 * @description Validate a single rendered template value before it is shell-quoted
 * into a command. Shell-quoting neutralizes metacharacters, but two things slip
 * past it:
 *  - a NUL byte: truncates C-string args and can desync the surrounding quote —
 *    an integrity violation, so it throws {@link FatalToolError} to halt the task
 *    rather than letting the model retry an injection-shaped input;
 *  - an unbounded value: an arg/disk bomb that can blow the exec maxBuffer — a
 *    plain Error (recoverable), so the model can resend a smaller value.
 *
 * @param rendered - the stringified value about to be substituted
 * @param token - the template token name, for error messages (e.g. `input.query`)
 * @param maxBytes - size cap; defaults to {@link MAX_TEMPLATE_VALUE_BYTES}
 */
export function guardTemplateValue(
  rendered: string,
  token: string,
  maxBytes: number = MAX_TEMPLATE_VALUE_BYTES,
): void {
  if (rendered.includes('\u0000')) {
    throw new FatalToolError(
      `Runtime tool template value for "{${token}}" contains a NUL byte.`,
      'input-integrity',
    );
  }
  if (Buffer.byteLength(rendered, 'utf8') > maxBytes) {
    throw new Error(
      `Runtime tool template value for "{${token}}" exceeds ${maxBytes} bytes.`,
    );
  }
}
