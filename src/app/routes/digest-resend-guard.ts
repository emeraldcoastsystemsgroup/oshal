/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 3 (career-hunter carve): dueForDigest moved out of career-digest.ts to this kernel-shared module — the morning-brief cron (core) and the career digest (store package) BOTH gate on it, and a core cron may not deep-import a packaged module. Pure time guard, no app knowledge.
 */

/** "No more than once a day", tolerant of window drift. */
export const RESEND_GUARD_HOURS = 20;

/**
 * @description Resend guard shared by every daily digest/brief: true when enough time
 * has passed since the last send that a new one may go out.
 * @param lastDigestAt when the previous digest was sent (null = never)
 * @param nowMs clock override for tests
 * @returns true when a new digest may be sent
 */
export function dueForDigest(lastDigestAt: string | Date | null, nowMs: number = Date.now()): boolean {
  if (!lastDigestAt) return true;
  const t = new Date(lastDigestAt).getTime();
  if (!Number.isFinite(t)) return true;
  return nowMs - t > RESEND_GUARD_HOURS * 3_600_000;
}
