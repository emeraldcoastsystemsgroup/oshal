/**
 * Uber Rides tool kit — discoverable tools that SHELL the oshal-uber-rides CLI.
 *
 * The CLI resolves the operator's OPTIONAL Uber Rides config from the connector store
 * (broker -> DB), estimates ride options, and returns the ride DEEP LINK. No keys live here
 * and none live in env/compose — the connector pattern (docs/connector-backed-apps.md).
 *
 * Honest reality: requesting a ride on a third party's behalf needs Uber for Business; this
 * path returns a universal m.uber.com/ul/ deep link the rider confirms + pays in their OWN
 * Uber app. Fares/ETAs are clearly-labelled estimates.
 *
 * Pattern: exports { 'tool-name': async (params) => {...} } — auto-discovered (ADR-025).
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — Uber Rides deep-link tools.
 * ---------------------------------------------------------------------------
 * @module uberRidesToolKit
 * @agent rides-concierge
 */
const { runBrokeredCli } = require('../brokered-cli-runner');

function runCli(args, params = {}, context = {}) {
  return runBrokeredCli({ script: 'oshal-uber-rides.js', args, params, context, errorLabel: 'uber-rides' });
}

module.exports = {
  // Estimate ride options (UberX/Comfort/XL/Black) for a pickup -> dropoff.
  'estimate-ride': async (p = {}, c = {}) => runCli(['estimate', String(p.pickup || 'my location'), String(p.dropoff || '')], p, c),
  // Build the ride request deep link the rider opens + confirms in their own Uber app.
  'request-ride': async (p = {}, c = {}) => runCli(['ride', String(p.pickup || 'my location'), String(p.dropoff || ''), String(p.rideType || '')], p, c),
  // Is an Uber Rides config available to this caller?
  'rides-accounts': async (p = {}, c = {}) => runCli(['accounts'], p, c),
};
