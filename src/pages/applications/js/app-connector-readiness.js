/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The applications page listed bundles as a flat tile list: installed vs available vs source-unavailable, and nothing about what a bundle plugs into. It could not tell a CONNECTED bundle from one waiting on a credential, because it never read the connector broker at all. This module turns the two token-free feeds - the bundle's declared provider ids (manifest dependency tiers, projected into the listing summary and the store catalog) and the broker's own per-provider state (GET /api/connect/list) - into one verdict per bundle and one state per provider. It lives beside app-catalog-openability.js rather than inline in the page for the same reason that one does: the guard has to drive the REAL rendering decision, and a decision typed into the HTML cannot be driven by anything. The honesty rule is in indexProviders: when the broker cannot be read the verdict is `unknown`, never `credential-needed` and never `connected` - a page that guesses at connection state is worse than one that admits it does not know.
 */

/**
 * One provider's state for this caller, as the broker reports it.
 *
 * - `connected` — at least one live (non-expired) connection.
 * - `platform` — no personal connection, but a shared platform key makes one unnecessary.
 * - `expired` — connections exist and every one needs re-consent.
 * - `needs-credential` — this deployment can offer the provider; nobody has connected it.
 * - `unavailable` — this deployment cannot offer it (no OAuth client configured, or the broker
 *   has no such provider at all), so no amount of clicking here will connect it.
 * - `unknown` — the broker could not be read. Never inferred from silence.
 */
export const PROVIDER_STATE_LABELS = {
  connected: 'connected',
  platform: 'platform key',
  expired: 'reconnect',
  'needs-credential': 'not connected',
  unavailable: 'unavailable',
  unknown: 'unknown',
};

/** The bundle-level verdicts, in the order they win when a bundle's providers disagree. */
const BUNDLE_PRECEDENCE = ['unknown', 'unavailable', 'credential-needed', 'connected', 'none'];

/**
 * @description Index a GET /api/connect/list payload by provider id. Returns null — NOT an empty
 * index — when the payload is missing or malformed, which is what a 401/500/offline broker looks
 * like from the page. The distinction is the whole point: an empty index would make every declared
 * provider read as "not connected", so a broker outage would silently accuse the operator of never
 * having connected anything.
 * @param {{providers?: Array<Record<string, unknown>>}|null|undefined} payload - The parsed response body.
 * @returns {Map<string, Record<string, unknown>>|null} The index, or null when the broker is unreadable.
 */
export function indexProviders(payload) {
  const providers = payload && Array.isArray(payload.providers) ? payload.providers : null;
  if (!providers) return null;
  const index = new Map();
  for (const provider of providers) {
    if (provider && typeof provider.id === 'string') index.set(provider.id, provider);
  }
  return index;
}

/**
 * @description One provider's state for this caller. Reads only the token-free keys the broker
 * already publishes — `connections[].expired`, `platformDefault`, `configured` — and never a token
 * or an expiry value.
 * @param {string} id - Provider id as the manifest declares it.
 * @param {Map<string, Record<string, unknown>>|null} index - From {@link indexProviders}.
 * @returns {string} One of the PROVIDER_STATE_LABELS keys.
 */
export function connectorState(id, index) {
  if (!index) return 'unknown';
  const provider = index.get(id);
  // A provider the broker does not publish cannot be connected from this deployment, whatever the
  // manifest calls it — a package-local id, or a connector this build does not carry.
  if (!provider) return 'unavailable';
  const connections = Array.isArray(provider.connections) ? provider.connections : [];
  if (connections.some((connection) => connection && connection.expired !== true)) return 'connected';
  if (connections.length) return 'expired';
  if (provider.platformDefault === true) return 'platform';
  return provider.configured === true ? 'needs-credential' : 'unavailable';
}

/**
 * @description The human label for a provider, from the broker's own catalog, falling back to the
 * declared id so an unknown provider still renders as something an operator can search for.
 * @param {string} id - Provider id.
 * @param {Map<string, Record<string, unknown>>|null} index - From {@link indexProviders}.
 * @returns {string} The provider's display label.
 */
export function connectorLabel(id, index) {
  const provider = index ? index.get(id) : undefined;
  return provider && typeof provider.label === 'string' && provider.label ? provider.label : id;
}

/**
 * @description The providers one bundle includes, in tier order, from either feed: an installed
 * app's listing summary or a store catalog entry. Both carry the same `connectors` shape because
 * both are projected from the same shared dependency-tier contract.
 * @param {{connectors?: {required?: string[], optional?: string[]}}} bundle - A listing or catalog entry.
 * @returns {Array<{id: string, tier: string}>} Declared providers, required first, de-duplicated.
 */
export function bundleConnectors(bundle) {
  const declared = bundle && bundle.connectors ? bundle.connectors : {};
  const required = Array.isArray(declared.required) ? declared.required : [];
  const optional = Array.isArray(declared.optional) ? declared.optional : [];
  const seen = new Set();
  const out = [];
  for (const [ids, tier] of [[required, 'required'], [optional, 'optional']]) {
    for (const id of ids) {
      if (typeof id !== 'string' || !id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, tier });
    }
  }
  return out;
}

/**
 * @description The bundle-level verdict from its providers' states.
 *
 * `unavailable` needs a REQUIRED provider this deployment cannot offer — an optional one it cannot
 * offer is a feature the bundle does without, not a broken bundle. `credential-needed` covers both
 * "never connected" and "every connection expired", because both are answered by the same act.
 * @param {Array<{tier: string, state: string}>} providers - Per-provider states, with tiers.
 * @returns {string} 'none' | 'unknown' | 'unavailable' | 'credential-needed' | 'connected'.
 */
function verdictFor(providers) {
  if (!providers.length) return 'none';
  if (providers.some((p) => p.state === 'unknown')) return 'unknown';
  if (providers.some((p) => p.tier === 'required' && p.state === 'unavailable')) return 'unavailable';
  if (providers.some((p) => p.state === 'expired' || p.state === 'needs-credential')) return 'credential-needed';
  if (providers.some((p) => p.state === 'connected' || p.state === 'platform')) return 'connected';
  // Every declared provider is optional AND unavailable here: there is nothing to connect, so the
  // bundle is neither waiting on anyone nor connected to anything.
  return 'none';
}

/** The badge one verdict renders as. `none` renders nothing — silence is the honest empty state. */
const BUNDLE_BADGES = {
  connected: { label: 'connected', tone: 'ok' },
  'credential-needed': { label: 'credential needed', tone: 'warn' },
  unavailable: { label: 'unavailable here', tone: 'off' },
  unknown: { label: 'connections unknown', tone: 'off' },
};

/**
 * @description Describe one bundle's providers and its single readiness verdict, for a row in the
 * applications catalog. Pure: the same bundle and the same broker index always give the same
 * answer, which is what lets the guard drive the real rendering decision.
 * @param {{connectors?: {required?: string[], optional?: string[]}}} bundle - A listing or catalog entry.
 * @param {Map<string, Record<string, unknown>>|null} index - From {@link indexProviders}.
 * @returns {{state: string, badge: {label: string, tone: string}|null, title: string,
 *   providers: Array<{id: string, tier: string, state: string, label: string}>}} What the row renders.
 */
export function bundleReadiness(bundle, index) {
  const providers = bundleConnectors(bundle).map((declared) => ({
    ...declared,
    state: connectorState(declared.id, index),
    label: connectorLabel(declared.id, index),
  }));
  const state = verdictFor(providers);
  return { state, badge: BUNDLE_BADGES[state] || null, title: readinessTitle(state, providers), providers };
}

/**
 * @description The tooltip for a readiness badge: it names the providers that produced the
 * verdict, so a row never asserts a state without saying which provider it is about.
 * @param {string} state - The verdict from {@link bundleReadiness}.
 * @param {Array<{id: string, tier: string, state: string, label: string}>} providers - Its providers.
 * @returns {string} The tooltip text; empty when the bundle declares no providers.
 */
export function readinessTitle(state, providers) {
  const names = (...states) => providers.filter((p) => states.includes(p.state)).map((p) => p.label).join(', ');
  if (state === 'none') return '';
  if (state === 'unknown') return 'Your connections could not be read, so this bundle’s providers are not reported here.';
  if (state === 'unavailable') {
    return `This deployment does not offer ${names('unavailable')}, which this bundle requires.`;
  }
  if (state === 'credential-needed') {
    const waiting = names('needs-credential', 'expired');
    return `Waiting on ${waiting} — connect on the cockpit’s Connectors screen.`;
  }
  return `Connected: ${names('connected', 'platform')}.`;
}

/**
 * @description Sort key for the bundle verdicts, so a caller can order or group rows by readiness
 * without repeating the precedence. Lower sorts first.
 * @param {string} state - A verdict from {@link bundleReadiness}.
 * @returns {number} Its rank in the precedence order.
 */
export function readinessRank(state) {
  const rank = BUNDLE_PRECEDENCE.indexOf(state);
  return rank === -1 ? BUNDLE_PRECEDENCE.length : rank;
}
