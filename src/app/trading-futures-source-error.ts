/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Carry classified source refusals across the study worker without parsing error strings.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Distinguish incomplete captured sessions from empty or unconfigured sources.
 */
import type { FuturesSourceFreshness } from './trading-futures-research-quality';

/** @description Source-only evidence safe to show in owner notifications; never contains archive paths or credentials. */
export type FuturesSourceIssue = { root: string } & (
  { code: 'stale'; chartDate: string; ltfDate: string; freshness: FuturesSourceFreshness }
  | { code: 'empty' | 'unconfigured' | 'incomplete' }
);

/** @description A classified source refusal, distinct from optimizer, worker or provider failures. */
export class FuturesSourceError extends Error {
  constructor(message: string, public readonly issue: FuturesSourceIssue) {
    super(message);
    this.name = 'FuturesSourceError';
  }
}
