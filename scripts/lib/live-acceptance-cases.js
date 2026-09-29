/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the registry of automated live-acceptance cases, in run order. scripts/operations/live-acceptance.js selects from it by key, and the Test Lab cards (test-lab-live-acceptance-scenarios.ts) register one card per entry, so the runner and the Lab can never list different cases.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Register the trading-parity case (live-acceptance-trading-parity.js) for "Queued paper-to-live parity features": read-only, no model turn.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Register the vids-publish case (live-acceptance-vids-publish.js) for "Vids public-publish rail": writes one tagged job, export and publication and removes them, no model turn.
 */

'use strict';

/**
 * Each entry: the case module (CASE_ID, KEY, TITLE, NEEDS, run), the backlog entry it proves, and
 * whether a run spends a real model turn or writes owner data (both make the Lab card explicit-only).
 */
const CASES = Object.freeze([
  { module: require('./live-acceptance-response-renderer.js'), backlog: 'Shared response-renderer completion', spendsModel: false, writes: false },
  { module: require('./live-acceptance-congress.js'), backlog: 'Political-trades (STOCK Act) signal has never run on this box', spendsModel: false, writes: true },
  { module: require('./live-acceptance-dev-workspace.js'), backlog: 'Jarvis in dev mode should see what this workspace sees', spendsModel: true, writes: true },
  { module: require('./live-acceptance-floater.js'), backlog: 'A vehicle record, and the medium it runs in as a parameter (ADR-160)', spendsModel: false, writes: true },
  { module: require('./live-acceptance-linkedin.js'), backlog: 'LinkedIn Content Assistant queue workflow', spendsModel: true, writes: true },
  { module: require('./live-acceptance-commerce.js'), backlog: 'Consumer commerce native surfaces', spendsModel: false, writes: true },
  { module: require('./live-acceptance-lm-class-material.js'), backlog: 'ADR-139 - the little-monsters class-materials destination', spendsModel: false, writes: true },
  { module: require('./live-acceptance-jarvis-cache.js'), backlog: 'Jarvis starts cold on every conversation - prime the invariant context once', spendsModel: true, writes: true },
  { module: require('./live-acceptance-trading-parity.js'), backlog: 'Queued paper-to-live parity features', spendsModel: false, writes: false },
  { module: require('./live-acceptance-vids-publish.js'), backlog: 'Vids public-publish rail', spendsModel: false, writes: true },
]);

/**
 * @description Select cases by key, or every case for `all`.
 * @param {string} selector - A case key or `all`.
 * @returns {Array<(typeof CASES)[number]>} The selected entries (empty for an unknown key).
 */
function selectCases(selector) {
  if (selector === 'all') return [...CASES];
  return CASES.filter((entry) => entry.module.KEY === selector || entry.module.CASE_ID === selector);
}

module.exports = { CASES, selectCases };
