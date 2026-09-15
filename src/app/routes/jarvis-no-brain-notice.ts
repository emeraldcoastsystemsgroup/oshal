/**
 * What the operator is TOLD when Jarvis has no admissible brain.
 *
 * The condition itself is settled elsewhere and is not touched here: `resolveUserBrain` returns
 * nothing, the target bot's registry harness is an unbrokered CLI, and the SEC-05 preflight refuses
 * that harness at a bot node. `stampRemoteBrain` / `resolveHostedBrainMeta` already convert that
 * into a `NO_HOSTED_BRAIN` refusal instead of the raw harness text. What was missing is the last
 * hop: the Jarvis ask route dropped that error into its generic failure slot, so the surface showed
 * whatever string arrived and the spoken line was an apology with no content ("Sorry, that didn't
 * work"). An operator whose only real problem was an unsaved endpoint had nothing to act on.
 *
 * This module is the one place that turn's user-facing copy lives. It is pure so both the route and
 * its guard read the same decision, and it names the card that actually exists on the Connections
 * tab — Bring Your Own LLM — rather than a settings heading that does not.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: JARVIS_NO_BRAIN_CODE/MESSAGE plus describeJarvisAskFailure, so an empty user-brain ladder on an unbrokered-harness turn reaches the surface as an actionable sentence with a machine code the client can speak, and every other failure keeps its own message verbatim.
 *
 * @module jarvis-no-brain-notice
 */

/**
 * Machine code carried on the `/ask` job and its result payload. Identical to the code
 * `NoHostedBrainError` already raises, because it names the same state — the surface branches on
 * it to choose a spoken line that says something.
 */
export const JARVIS_NO_BRAIN_CODE = 'NO_HOSTED_BRAIN';

/**
 * The sentence the operator reads. Written for the person who is stuck, not for the log: it says
 * what is missing and where to add it. The destination is Settings → Connections, whose
 * *Bring Your Own LLM* card takes an OpenAI-compatible endpoint, model and key.
 */
export const JARVIS_NO_BRAIN_MESSAGE =
  'Jarvis has no AI engine connected — add one under Settings → Connections → Bring Your Own LLM.';

/** What the `/ask` job records for a failed turn. */
export interface JarvisAskFailure {
  /** The text the surface renders and the shelf stores. */
  message: string;
  /** Present only for the states the surface has a specific answer for. */
  code?: string;
}

/**
 * @description Decide what a failed Jarvis turn tells the operator. A `NO_HOSTED_BRAIN` refusal —
 * the state where the caller's brain ladder resolved to nothing and the bot's harness is one the
 * controller refuses unattended — becomes the actionable Settings sentence plus its code. Every
 * other failure keeps its own message exactly as thrown: this rewrites one known state, it never
 * flattens unrelated errors into a friendlier lie.
 * @param error - The failure thrown by the turn.
 * @returns The message to record on the job, with the machine code when one applies.
 */
export function describeJarvisAskFailure(error: unknown): JarvisAskFailure {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === JARVIS_NO_BRAIN_CODE) {
    return { message: JARVIS_NO_BRAIN_MESSAGE, code: JARVIS_NO_BRAIN_CODE };
  }
  return { message: (error as Error)?.message ?? String(error) };
}
