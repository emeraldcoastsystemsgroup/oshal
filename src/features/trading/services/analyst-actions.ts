/**
 * Analyst-action headline classifier (ADR-096 / the 2026-07-12 pre-registered hypothesis) —
 * DETERMINISTIC classification of Benzinga wire headlines into analyst-action events:
 * rating changes (upgrade/downgrade), price-target moves (raise/cut), and coverage initiations.
 *
 * Pure string → class, no I/O, no LLM — the "deterministic model for the fundamental analysis"
 * the event-overlay framework requires: same headline, same class, forever. The sweep-#5 lessons
 * are encoded as EXCLUSIONS: listicles/movers/preview/recap noise never classifies, reactive
 * "What's going on with X?" stories never classify, and a bare "Reiterates" with no PT move
 * carries no new information.
 *
 * Consumed by scripts/oshal-trading-analyst-actions-study.ts (the event study) and, if the study
 * PROCEEDs, by the future live event-overlay.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — exclusion-first deterministic classifier: upgrade/downgrade > pt-raise/pt-cut > initiation (bullish/bearish rating words; neutral initiations are no-calls), broker prefix extraction.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Noise gate hoisted to @/shared/utils/headline-noise so the world-data ingest can strain its sentiment series without an FSD cross-slice import. Re-exported here — every existing trading caller is unchanged.
 *
 * @module analyst-actions
 */

import { isNoiseHeadline } from '@/shared/utils/headline-noise';

/** The event classes the study measures (direction is implied by the class). */
export type AnalystActionClass = 'upgrade' | 'downgrade' | 'pt-raise' | 'pt-cut' | 'initiation-bull' | 'initiation-bear';

/** One classified analyst action. */
export interface AnalystAction {
  cls: AnalystActionClass;
  dir: 'up' | 'down';
  /** The house issuing the note (leading words before the action verb), when extractable. */
  broker: string | null;
}

// Re-exported so existing trading callers (studies, barrel) keep importing it from here.
export { isNoiseHeadline };

/** Bullish / bearish rating vocabularies (initiations classify only on a directional rating). */
const BULL_RATING = /\b(buy|strong buy|overweight|outperform|positive|accumulate)\b/i;
const BEAR_RATING = /\b(sell|strong sell|underweight|underperform|negative|reduce)\b/i;

/** Broker prefix: the words before the first action verb ("Cantor Fitzgerald Maintains …"). */
const BROKER = /^([A-Z][\w.&' -]{1,40}?)\s+(?:Maintains|Upgrades|Downgrades|Initiates|Reinstates|Reiterates|Raises|Lowers|Cuts|Assumes|Resumes)\b/;

/**
 * @description Classifies one wire headline into an analyst-action event, or null (no call).
 * Precedence: exclusions → rating CHANGE (upgrade/downgrade) → price-target move → initiation.
 * A "Maintains X, Raises Price Target" is a pt-raise; a bare "Reiterates/Maintains" with no PT
 * move carries no new information and is a no-call.
 * @param headline - The raw wire headline.
 * @returns The classified action, or null when the headline is noise / not an analyst action.
 */
export function classifyAnalystHeadline(headline: string): AnalystAction | null {
  const h = String(headline || '').trim();
  if (isNoiseHeadline(h)) return null;

  const broker = BROKER.exec(h)?.[1]?.trim() ?? null;

  // 1) Rating CHANGES dominate — an upgrade that also raises the PT is still an upgrade.
  if (/\bupgrades?\b/i.test(h) && !/\bdowngrades?\b/i.test(h)) return { cls: 'upgrade', dir: 'up', broker };
  if (/\bdowngrades?\b/i.test(h) && !/\bupgrades?\b/i.test(h)) return { cls: 'downgrade', dir: 'down', broker };

  // 2) Price-target moves (the class the 07-12 recall test flagged as the recurring pre-move signal).
  const raises = /\b(raises|boosts|lifts|hikes)\b[^.]*\bprice target\b/i.test(h) || /\bprice target raised\b/i.test(h);
  const lowers = /\b(lowers|cuts|reduces|trims)\b[^.]*\bprice target\b/i.test(h) || /\bprice target (lowered|cut)\b/i.test(h);
  if (raises && !lowers) return { cls: 'pt-raise', dir: 'up', broker };
  if (lowers && !raises) return { cls: 'pt-cut', dir: 'down', broker };

  // 3) Coverage initiations — only when the announced rating is directional.
  if (/\b(initiates coverage|initiates|reinstates coverage|resumes coverage|assumes coverage)\b/i.test(h)) {
    if (BULL_RATING.test(h) && !BEAR_RATING.test(h)) return { cls: 'initiation-bull', dir: 'up', broker };
    if (BEAR_RATING.test(h) && !BULL_RATING.test(h)) return { cls: 'initiation-bear', dir: 'down', broker };
    return null; // neutral/hold initiations carry no direction
  }

  return null;
}

/** The class names, grouped by direction (the study's pooled cells). */
export const ANALYST_UP_CLASSES: AnalystActionClass[] = ['upgrade', 'pt-raise', 'initiation-bull'];
export const ANALYST_DOWN_CLASSES: AnalystActionClass[] = ['downgrade', 'pt-cut', 'initiation-bear'];
