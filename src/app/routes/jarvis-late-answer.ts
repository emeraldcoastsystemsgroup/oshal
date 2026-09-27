/**
 * Jarvis late answers — what an ask job says while a conversational turn outlives the /ask route's
 * decision window, and how long a surface should keep following it.
 *
 * The route used to answer a conversational turn that ran past the window with "my model provider did
 * not respond in time", while the bot was still working; the answer it then produced reached nobody.
 * The job now stays pending with this note, and the turn's own answer is written into the same thread
 * when it lands (jarvis-routes.ts), so these fields are the only thing a polling surface needs.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Initial - the still-working note and the pending-poll fields (note + remaining job retention) for a Jarvis turn that outlives the decision window, plus the ask-job retention the router's GC and these fields share.
 */

/** @description The progress note an ask job carries once its turn has outlived the decision window. */
export const JARVIS_STILL_WORKING_NOTE = 'Still working on it — the answer will appear here when it is ready.';

/** @description How long an ask job is kept, and so can still be polled, after it was created. */
export const ASK_JOB_TTL_MS = 60 * 60 * 1000;

/**
 * @description The pending-poll fields for a job whose turn is still running past the window: the note,
 * and how much longer the job is kept, so a surface follows it exactly as long as it can be answered.
 * @param job - The pending job's progress note (absent until the window passed) and creation time.
 * @param now - Current epoch ms; injectable for tests.
 * @returns `{ progress, expiresInMs }`, or an empty object while the turn is inside the window.
 */
export function stillWorkingFields(job: { progress?: string; createdAt: number }, now = Date.now()): { progress?: string; expiresInMs?: number } {
  if (!job.progress) return {};
  return { progress: job.progress, expiresInMs: Math.max(0, job.createdAt + ASK_JOB_TTL_MS - now) };
}
