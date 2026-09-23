/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | Add the explicit error contract for deterministic refusals so orchestration boundaries never infer terminal outcomes from arbitrary error-message text.
 */

import { remedyForRefusal } from './remedies';

/**
 * A deliberate, deterministic refusal emitted by an enforcing path.
 *
 * The stable code and human detail remain separate fields while `message` preserves the existing
 * wire/log shape. A reviewed catalog remedy is attached at construction time unless the enforcing
 * path supplies a more specific one.
 */
export class RefusalError extends Error {
  constructor(
    public readonly code: string,
    public readonly detail: string,
    public readonly remedy: string | undefined = remedyForRefusal(code),
  ) {
    super(`${code}: ${detail}`);
    this.name = 'RefusalError';
  }
}
