/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                          | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Phase 0 tool-exec hardening: a fatal (non-recoverable) tool error. The agentic loop re-throws these to HALT the task instead of feeding the message back to the LLM as retryable text. For policy/security/integrity failures where "let the model try again" is the wrong behavior.
 */

/**
 * @description A non-recoverable tool failure. Unlike an ordinary thrown Error
 * (which `executeAndTrack` catches and returns to the LLM as `Error: ...` so the
 * model can adapt and retry), a `FatalToolError` is re-thrown to halt the agentic
 * loop. Use it for failures where continuing would be unsafe or pointless:
 * input-integrity violations (e.g. a NUL byte in a value bound for a shell arg),
 * authorization denials that should stop the task, and sandbox/policy violations.
 */
export class FatalToolError extends Error {
  /** Short machine-readable reason, e.g. 'input-integrity', 'sandbox', 'authz'. */
  readonly reason: string;

  constructor(message: string, reason = 'fatal') {
    super(message);
    this.name = 'FatalToolError';
    this.reason = reason;
  }
}
