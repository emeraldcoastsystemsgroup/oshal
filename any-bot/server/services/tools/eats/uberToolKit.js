/**
 * Uber Eats tool kit — discoverable tools that SHELL the oshal-uber CLI.
 *
 * The CLI resolves the operator's OPTIONAL Uber Eats affiliate config from the connector
 * store (broker -> DB), browses a curated catalog, and returns the order DEEP LINK. No keys
 * live here and none live in env/compose — exactly the connector pattern
 * (docs/connector-backed-apps.md).
 *
 * Honest reality: Uber has no consumer API to place an Eats order on a third party's behalf,
 * so 'order-deeplink' returns a ubereats.com link the person opens + completes on their OWN
 * Uber login + payment. No shopper credentials, no payment, ever touch OSHAL.
 *
 * Pattern: exports { 'tool-name': async (params) => {...} } — auto-discovered (ADR-025).
 * Tools pass params.userSub -> OSHAL_USER_SUB and params.label -> OSHAL_CONNECTION_LABEL.
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — Uber Eats deep-link
 *            | handoff tools; the bot acts through the brokered connector cred (or none).
 * ---------------------------------------------------------------------------
 * @module uberToolKit
 * @agent eats-concierge
 */
const { runBrokeredCli } = require('../brokered-cli-runner');

/** Run the Uber CLI and parse its JSON stdout. Never throws — returns {error} instead. */
function runCli(args, params = {}, context = {}) {
  return runBrokeredCli({ script: 'oshal-uber.js', args, params, context, errorLabel: 'uber' });
}

module.exports = {
  // Search Uber Eats restaurants/dishes (curated catalog) by name, cuisine, or craving.
  'search-restaurants': async (p = {}, c = {}) => runCli(['search', String(p.query || ''), String(p.limit || 8)], p, c),
  // Browse one restaurant's menu items.
  'browse-menu': async (p = {}, c = {}) => runCli(['menu', String(p.storeId || '')], p, c),
  // Build the order deep link: pass a storeId, or "search:<terms>". The person opens it,
  // signs into their own Uber Eats, and places the order.
  'order-deeplink': async (p = {}, c = {}) => runCli(['order', String(p.storeId || p.spec || '')], p, c),
  // Is an Uber Eats config available to this caller?
  'uber-accounts': async (p = {}, c = {}) => runCli(['accounts'], p, c),
};
