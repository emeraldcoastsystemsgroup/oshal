/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Share the one readiness shape a schema bootstrap may be asked for again, so a boot-time failure is not cached for the life of the process.
 */

/** @description Hand out a readiness step a later caller can ask for again.
 * A schema bootstrap composed as a single eagerly created promise keeps its own rejection: one
 * lost pool acquire at boot makes every later operation await the same dead promise while the
 * controller still reports healthy. Memoizing the attempt and dropping the memo on failure keeps
 * concurrent callers sharing one in-flight bootstrap while the next caller after a failure starts
 * a fresh one. This is the shape `createSchemaReady`, the Entra local identity bridge and the
 * ADR-157 activation wiring each wrote by hand; it exists once here so a readiness that chains
 * onto another readiness cannot quietly reintroduce the cached rejection one level out.
 * @param attempt The bootstrap to run, at most once per successful outcome.
 * @returns A thunk sharing one in-flight attempt and forgetting a failed one.
 */
export function createRetryableReady<T>(attempt: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = attempt().catch(error => {
        pending = null;
        throw error;
      });
    }
    return pending;
  };
}
