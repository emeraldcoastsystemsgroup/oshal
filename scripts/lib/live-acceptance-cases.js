/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the registry of automated live-acceptance cases, in run order. scripts/operations/live-acceptance.js selects from it by key, and the Test Lab cards (test-lab-live-acceptance-scenarios.ts) register one card per entry, so the runner and the Lab can never list different cases.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Register the trading-parity case (live-acceptance-trading-parity.js) for "Queued paper-to-live parity features": read-only, no model turn.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Register the vids-publish case (live-acceptance-vids-publish.js) for "Vids public-publish rail": writes one tagged job, export and publication and removes them, no model turn.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Register the token-chase-replay case (live-acceptance-token-chase-replay.js) for "Workspace-bound checkpoint and tail replay": it starts one tagged file-tools turn on a bot only when no file-tools-only run is captured (a model turn) and removes it, so the card is explicit-only.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Register the create-region-edit case (live-acceptance-create-region-edit.js) for "Create visual workspace and integrated editing": one tagged Create project, one image-provider call (paid only with the host runner's --allow-paid) and one accepted revision, the project removed, so the card is explicit-only.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Register the forge-edit case (live-acceptance-forge-edit.js) for "Strategy Studio and Bot Forge conversational parity" (the Forge half): one tagged two-bot pack written, deployed, edited and deployed again through the Packs panel, then the pack, manifest, personas, app and both agents removed. No model turn; it writes, so the card is explicit-only.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | The tickets-in-tickets case: one tagged build root planned in-process, its children run one at a time over the signed hop, and the root assembled; spends model turns and writes tickets, so its Lab card is explicit-only.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Register the package-run case (live-acceptance-package-run.js) for the Test Lab run-path authority scope: the installed presentations brand-render case run through the durable run route, every run read timed against 1 s. No model turn; it writes the Lab's run-history row and starts a package sandbox, so the card is explicit-only.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Registered storyboard-agy (live-acceptance-storyboard-agy.js): one frame through the swarm-default antigravity-cli image rail via the explicit-only Lab card storyboard-swarm-default-render (ADR-130 amendment 2026-10-02). It spends one model turn and writes a tagged render workspace, which it removes.
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
  { module: require('./live-acceptance-token-chase-replay.js'), backlog: 'Workspace-bound checkpoint and tail replay', spendsModel: true, writes: true },
  { module: require('./live-acceptance-create-region-edit.js'), backlog: 'Create visual workspace and integrated editing', spendsModel: true, writes: true },
  { module: require('./live-acceptance-forge-edit.js'), backlog: 'Strategy Studio and Bot Forge conversational parity', spendsModel: false, writes: true },
  { module: require('./live-acceptance-tickets-in-tickets.js'), backlog: 'The build/swarm pipeline has no signed transport - every work unit rides the Redis mesh', spendsModel: true, writes: true },
  { module: require('./live-acceptance-package-run.js'), backlog: 'Test Lab package runs cancel themselves when an all-package authority re-check runs past 5 s (2026-10-01)', spendsModel: false, writes: true },
  { module: require('./live-acceptance-storyboard-agy.js'), backlog: 'Storyboard images follow the swarm default (antigravity) - live proof on the box', spendsModel: true, writes: true },
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
