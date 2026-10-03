/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1b (D4): the spend rule and its seam. The amount of one capability call is its units times the unit price on the provider's offer row — never a literal in code; with no price set, or with units that could not be measured, the call is still recorded, as a zero-amount row, and the rule returns why (the recorder's api log line names it unpriced and the reason). A free provider's call records nothing. The recorder that writes the event (chat_tasks + oshal_cost_events) is installed by the app at boot, so the voice feature records spend without importing the cost store; with nothing installed (no Postgres) nothing is recorded.
 */

/**
 * @description The capability spend rule (ADR-173 D4) and the process's installed recorder.
 * @module shared/capability-providers/capability-spend
 */

import type { CapabilitySpendEvent, CapabilitySpendRecorder } from './capability-types';

/** The amount of one call, and whether it could be priced. */
export interface CapabilitySpendAmount {
  amountUsd: number;
  /** True only when both the units and the unit price are known. */
  priced: boolean;
  /** Why the amount is zero without being free: the price or the units are unknown. */
  unpricedReason: string | null;
}

/**
 * @description The amount of one call: units times the offer row's unit price (D4).
 * @param event - The spend event.
 * @returns The amount, and why it is unpriced when it is.
 */
export function capabilitySpendAmount(event: Pick<CapabilitySpendEvent, 'units' | 'unitPriceUsd' | 'capability' | 'providerId'>): CapabilitySpendAmount {
  if (event.unitPriceUsd === null || !Number.isFinite(event.unitPriceUsd)) {
    return { amountUsd: 0, priced: false, unpricedReason: `no unit price is set for ${event.capability}/${event.providerId} on its offer row` };
  }
  if (event.units === null || !Number.isFinite(event.units)) {
    return { amountUsd: 0, priced: false, unpricedReason: `the call's units could not be measured for ${event.capability}/${event.providerId}` };
  }
  return { amountUsd: Math.max(0, event.units) * Math.max(0, event.unitPriceUsd), priced: true, unpricedReason: null };
}

let installed: CapabilitySpendRecorder | null = null;

/**
 * @description Install the process's spend recorder (the composition root does this at boot).
 * @param recorder - The recorder, or null to clear (tests).
 * @returns void
 */
export function installCapabilitySpendRecorder(recorder: CapabilitySpendRecorder | null): void {
  installed = recorder;
}

/**
 * @description The installed spend recorder, or null when none is installed (no Postgres).
 * @returns The recorder.
 */
export function installedCapabilitySpendRecorder(): CapabilitySpendRecorder | null {
  return installed;
}
