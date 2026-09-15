/**
 * What the operator is TOLD when Jarvis has no admissible brain.
 *
 * The condition is settled elsewhere and is not touched here: the caller's user-brain ladder
 * resolves to nothing, the Jarvis bot's registry harness is an unbrokered CLI, and the SEC-05
 * preflight refuses that harness unattended. `stampRemoteBrain` (dedicated node) and
 * `resolveHostedBrainMeta` (inline) already turn that state into a `NO_HOSTED_BRAIN` refusal instead
 * of the raw harness text. What was missing is the last hop: the Jarvis ask route dropped that
 * refusal into its generic failure slot with no code, so the surface could only print whichever
 * string arrived — a pointer to a "Settings → AI Providers" heading that does not exist — and speak
 * "Sorry, that didn't work".
 *
 * This module is the one place that turn's user-facing copy lives, so the route and its guards read
 * the same decision. It names the card that actually exists: Settings → Connections carries the
 * *Bring Your Own LLM* card (an OpenAI-compatible base URL, model and key).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: JARVIS_NO_BRAIN_CODE / JARVIS_NO_BRAIN_MESSAGE and describeJarvisAskFailure, so an empty user-brain ladder on an unbrokered-harness Jarvis turn reaches the surface as an actionable sentence plus a machine code the page can speak, while every other failure keeps its own message verbatim.
 *
 * @module jarvis-no-brain-notice
 */

/**
 * @description Machine code carried on the `/ask` job and its result payload. It is the code
 * `NoHostedBrainError` already raises, because it names the same state; the surface branches on it
 * to speak the sentence instead of a contentless apology.
 */
export const JARVIS_NO_BRAIN_CODE = 'NO_HOSTED_BRAIN';

/**
 * @description The sentence the operator reads (and, arrows spoken as pauses, hears). Written for
 * the person who is stuck: what is missing, and the exact place to add it.
 */
export const JARVIS_NO_BRAIN_MESSAGE =
  'Jarvis has no AI engine connected — add one under Settings → Connections → Bring Your Own LLM.';

/** What the `/ask` job records for a failed turn. */
export interface JarvisAskFailure {
  /** The text the surface renders. */
  message: string;
  /** Present only for a state the surface has a specific answer for. */
  code?: string;
}

/**
 * @description Decide what a failed Jarvis turn tells the operator. A refusal carrying code
 * `NO_HOSTED_BRAIN` becomes the actionable Settings sentence plus that code. Every other failure
 * keeps its own message exactly as thrown: this rewrites one known state, keyed on the machine code
 * the refusal carries, never on message wording a model or provider could also produce.
 * @param error - The failure the turn threw.
 * @returns The message to record on the job, with the machine code when one applies.
 */
export function describeJarvisAskFailure(error: unknown): JarvisAskFailure {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === JARVIS_NO_BRAIN_CODE) {
    return { message: JARVIS_NO_BRAIN_MESSAGE, code: JARVIS_NO_BRAIN_CODE };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}
