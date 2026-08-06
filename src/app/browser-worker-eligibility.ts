/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Define one fail-closed browser-worker gate requiring an execution tool, the exact browser_control capability, and the separate exact browser_pilot_consent tag.
 */

/**
 * Browser-worker eligibility is an explicit advertisement, separate from ordinary remote execution.
 * A node may join the swarm and expose powerful CLI or shell tools without consenting to foreground
 * browser piloting. This pure predicate is shared by dispatch and worker visibility so neither path
 * can infer browser authorization from generic device enrollment or accidentally normalize an alias.
 *
 * @module app/browser-worker-eligibility
 */

/** Exact MCP namespace/capability that proves browser-control tooling is installed. */
export const BROWSER_CONTROL_CAPABILITY = 'browser_control';

/** Exact per-node runner decision authorizing foreground browser piloting. */
export const BROWSER_PILOT_CONSENT_TAG = 'browser_pilot_consent';

/** Non-enumerating refusal shared by browser-task callers after scoped selection returns empty. */
export const NO_AUTHORIZED_BROWSER_WORKER_ERROR = 'No authorized browser-control worker is available.';

/** Minimal advertisement fields needed to evaluate browser-worker authorization. */
export interface BrowserWorkerAdvertisement {
  capabilities?: readonly string[];
  tags?: readonly string[];
}

/**
 * @description Returns true only for an execution node with explicit browser tooling and consent.
 * Matching is deliberately exact and case-sensitive: aliases, prefixes, and pending-state tags do
 * not grant a dangerous capability. Device-owner access is a separate mandatory selector filter.
 * @param node - The remote node's server-validated capability and tag advertisement.
 * @returns Whether the node explicitly opted into browser-task eligibility.
 */
export function isAuthorizedBrowserWorker(node: BrowserWorkerAdvertisement): boolean {
  const capabilities = node.capabilities ?? [];
  const canExecute = capabilities.includes('codex.exec') || capabilities.includes('shell.exec');
  return canExecute && capabilities.includes(BROWSER_CONTROL_CAPABILITY) &&
    (node.tags ?? []).includes(BROWSER_PILOT_CONSENT_TAG);
}
