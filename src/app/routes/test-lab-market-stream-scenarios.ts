/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register the ADR-143 market-data stream guards with one credential-free kernel status readback. The attached suites are local protocol proof (a real local WebSocketServer, a static compose pin); the step reports whether THIS node is armed and authenticated and never claims the dated regular-hours paper-ticket observation that ADR-143 Phase 3 owes.
 */
import type { Scenario, StepResult } from './test-lab-scenarios';
import { marketStreamStatus, type MarketStreamStatus } from '@/features/trading';

const APP = 'intelligent-trades';
const LABEL = 'Kernel stream status (credential-free readback)';
const LOCAL_PROOF = 'The attached suites are local protocol proof (real local WebSocketServer, loopback SSE), not a venue or regular-hours observation.';

/**
 * @description Grade the kernel's own status snapshot. The snapshot carries no key, secret or venue
 *   URL by construction (ADR-143 D2), so it can be echoed as the step output. Unarmed is degraded,
 *   not failed: default-off is the shipped posture and arming is the operator's decision.
 * @param status - The kernel's credential-free stream status.
 * @returns A Lab step result whose detail names the next real step rather than implying one ran.
 */
export function marketStreamStatusStep(status: MarketStreamStatus): StepResult {
  const base = { app: APP, label: LABEL, output: status };
  if (!status.enabled) {
    return { ...base, state: 'degraded', detail: `TRADING_STREAM_ENABLED is not armed on this node: the kernel opens no venue socket. ${LOCAL_PROOF} Arming is an operator step (ADR-143 Phase 3).` };
  }
  if (status.state === 'entitlement_blocked') {
    return { ...base, state: 'fail', detail: `The venue refused the entitlement (${status.lastError || 'no message'}); the kernel waits out its cooldown and every surface is back on the poll. One client per key: check nothing else streams with this key.` };
  }
  if (status.state === 'authenticated' && status.lastPrintAt) {
    return { ...base, state: 'pass', detail: `Armed and authenticated on feed ${status.feed}: ${status.symbols.length} symbol(s) subscribed, last print ${status.lastPrintAt}. A print this node received; not the dated paper-ticket observation ADR-143 Phase 3 owes.` };
  }
  if (status.state === 'authenticated') {
    return { ...base, state: 'degraded', detail: `Armed and authenticated on feed ${status.feed} with no print yet (${status.symbols.length} symbol(s) subscribed). Outside regular hours the IEX feed carries nothing; the surfaces keep polling until a print arrives.` };
  }
  return { ...base, state: 'degraded', detail: `Armed but ${status.state}${status.lastError ? ` (${status.lastError})` : ''}: no venue session is authenticated right now. ${LOCAL_PROOF}` };
}

/** @description Discover the ADR-143 stream guards. @returns One local-runner scenario, not live proof. */
export const MARKET_STREAM_SCENARIOS: Scenario[] = [{
  id: 'market-data-stream', title: 'Market-data stream (ADR-143)', group: 'tool',
  description: 'Default-off Alpaca IEX websocket terminated in the kernel, refcounted subscriptions, 405/402 handling, credential-free prints and status, and the compose default-off pin. The suites are local protocol proof against a real local WebSocketServer; they do not establish a venue session, operator arming or the dated regular-hours paper-ticket print/reconnect observation.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/trading-market-data-stream.spec.ts' },
    { level: 'unit', path: 'tests/unit/compose-trading-stream-gate.spec.ts' },
    { level: 'unit', path: 'tests/unit/test-lab-market-stream-registration.spec.ts' },
  ],
  steps: [{ id: 'kernel-status', app: APP, label: LABEL, run: async () => marketStreamStatusStep(marketStreamStatus()) }],
}];
