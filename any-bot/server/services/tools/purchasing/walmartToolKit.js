/**
 * Walmart tool kit — discoverable tools that SHELL the oshal-walmart CLI.
 *
 * The CLI resolves the operator's Walmart credential from the connector store
 * (broker -> DB), signs the request, and returns JSON. No keys live here and none
 * live in env/compose — exactly the connector pattern (docs/connector-backed-apps.md).
 *
 * Pattern: exports { 'tool-name': async (params) => {...} } — auto-discovered (ADR-025).
 * Tools pass params.userSub -> OSHAL_USER_SUB and params.label -> OSHAL_CONNECTION_LABEL.
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — replaces the env-reading
 *            | walmartProvider; the bot now acts through the brokered connector cred.
 * ---------------------------------------------------------------------------
 * @module walmartToolKit
 * @agent shopping-concierge
 */
const { runBrokeredCli } = require('../brokered-cli-runner');

/** Run the Walmart CLI and parse its JSON stdout. Never throws — returns {error} instead. */
function runCli(args, params = {}, context = {}) {
  return runBrokeredCli({ script: 'oshal-walmart.js', args, params, context, errorLabel: 'walmart' });
}

module.exports = {
  // Search the operator's Walmart catalog.
  'search-products': async (p = {}, c = {}) => runCli(['search', String(p.query || ''), String(p.limit || 8)], p, c),
  // Read a deal feed: rollback | clearance | bestsellers | specialbuy.
  'scan-deals': async (p = {}, c = {}) => runCli(['deals', String(p.feed || 'rollback')], p, c),
  // Build the order deep link from "ITEMID_QTY,ITEMID_QTY" — the shopper opens it,
  // signs into their own Walmart, and checks out.
  'order-deeplink': async (p = {}, c = {}) => runCli(['cart', String(p.items || '')], p, c),
  // Is a Walmart connection available to this caller?
  'walmart-accounts': async (p = {}, c = {}) => runCli(['accounts'], p, c),
};
