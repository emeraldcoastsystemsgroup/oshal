/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Global classify-call budget — the guard the 2026-06-29 Codex burn proved missing: ingestFeeds→analyzeBatch had per-chunk sizing and per-source circuit breakers but NO ceiling on total LLM calls, so a catch-up storm (everything "fresh" after downtime) spawned the classify CLI 27×/min for 9 hours. This pure token bucket caps calls per fixed hour and per fixed day; exhausted → callers fall back to the free lexicon for the remainder of the window. Pure + clock-injectable so the spec can walk windows deterministically.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | A per-pulse slice (perPulse, beginPulse): the hour's calls spread across the fires instead of landing in the first one. On the bot rail a classify call takes ~10 s, and on 2026-10-02 the first ticker pulse of the hour spent all 40 hourly calls (412 s of model time) and overran the scheduler's 240 s dispatch budget three times; an abandoned pulse keeps running, so the next fire stacks on it. The dispatcher calls beginPulse at each fire; an omitted perPulse leaves the budget exactly as before.
 */

/** Point-in-time view of the budget — what the pulse log records and the first-denial warn carries. */
export interface ClassifyBudgetSnapshot {
  /** LLM calls granted in the current hour window. */
  hourUsed: number;
  /** Max calls per hour window. */
  hourCap: number;
  /** LLM calls granted in the current day window. */
  dayUsed: number;
  /** Max calls per day window. */
  dayCap: number;
  /** Requests denied in the current hour window (0 = budget never bit this hour). */
  denied: number;
  /** LLM calls granted since the current pulse began. */
  pulseUsed: number;
  /** Max calls per pulse, or null when no per-pulse ceiling is configured. */
  pulseCap: number | null;
}

/** The budget contract analyzeBatch consumes: one tryTake per LLM call, fail-closed. */
export interface ClassifyBudget {
  /**
   * @description Consume one LLM call if the hour, day AND pulse windows all have room.
   * Synchronous (the JS event loop makes it atomic across concurrent chunk workers).
   * @returns true when the call may spend; false when the caller must fall back to lexicon.
   */
  tryTake(): boolean;
  /** @description Current counters (rolls windows first, so a stale snapshot is impossible). */
  snapshot(): ClassifyBudgetSnapshot;
  /** @description Start a new pulse: the per-pulse counter returns to zero; hour and day keep counting. */
  beginPulse(): void;
}

/** A cap: non-finite or negative input fails CLOSED to zero (no LLM), never open. */
const cap = (n: number): number => (Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);

/**
 * @description Create a classify budget with fixed (wall-clock aligned) hour + day windows and an
 * optional per-pulse slice. Fixed windows over sliding ones on purpose: counters reset at the top of
 * the hour/UTC day, which makes the behavior predictable ("60 per clock hour") and the arithmetic
 * trivially testable. The pulse slice resets only when the caller says a pulse begins. Process-lifetime
 * state only — a restart forfeits nothing but the current counts, and the per-hour cap re-bounds any
 * restart storm within one window.
 * @param opts - perHour / perDay caps and the optional perPulse cap (values < 0 or non-numeric clamp
 *               to 0 = no LLM; perPulse omitted = no per-pulse ceiling), and an injectable `now`
 *               (ms epoch) for tests.
 * @returns The budget instance.
 */
export function createClassifyBudget(opts: { perHour: number; perDay: number; perPulse?: number; now?: () => number }): ClassifyBudget {
  const perHour = cap(opts.perHour);
  const perDay = cap(opts.perDay);
  const perPulse = opts.perPulse === undefined ? null : cap(opts.perPulse);
  const now = opts.now ?? Date.now;

  let hourWindow = -1;
  let dayWindow = -1;
  let hourUsed = 0;
  let dayUsed = 0;
  let denied = 0;
  let pulseUsed = 0;

  /** Roll counters when the wall-clock window has moved on. */
  const roll = (): void => {
    const t = now();
    const h = Math.floor(t / 3_600_000);
    const d = Math.floor(t / 86_400_000);
    if (h !== hourWindow) { hourWindow = h; hourUsed = 0; denied = 0; }
    if (d !== dayWindow) { dayWindow = d; dayUsed = 0; }
  };

  return {
    tryTake(): boolean {
      roll();
      if (hourUsed >= perHour || dayUsed >= perDay || (perPulse !== null && pulseUsed >= perPulse)) { denied += 1; return false; }
      hourUsed += 1;
      dayUsed += 1;
      pulseUsed += 1;
      return true;
    },
    snapshot(): ClassifyBudgetSnapshot {
      roll();
      return { hourUsed, hourCap: perHour, dayUsed, dayCap: perDay, denied, pulseUsed, pulseCap: perPulse };
    },
    beginPulse(): void {
      pulseUsed = 0;
    },
  };
}
