/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for the focused-landing shell lock (ADR-164 amendment) against the installed build, as a NON-operator on a host HOST_APP_MAP focuses, READ-ONLY: case and index.html spellings of the cockpit document and the experience entry page redirect to the landing, an unknown ?name= on the profile route is refused 404 experience_unavailable with exactly the lock fields, and the profile route with no name serves the landing application. It needs the second-caller port (OSHAL_VERIFY_SECOND_PAT, a non-operator's token) and OSHAL_VERIFY_FOCUSED_HOST (a mapped host, sent as X-Forwarded-Host); without either it reports unavailable by name and sends nothing.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Require an explicitly bound focused HTTP(S) origin before any case request; send no Host or forwarded-host overrides, so native-fetch header filtering cannot manufacture mapped-host acceptance.
 */

'use strict';

const crypto = require('node:crypto');
const common = require('./live-acceptance-common.js');

const CASE_ID = 'focused-shell-lock-live';
const KEY = 'shell-lock';
const TITLE = 'Focused-landing shell lock for a non-operator: cockpit spellings redirect, an unknown profile name is refused, no name serves the landing application';
const NEEDS = Object.freeze(['second']);
/** The host the case asks as: one HOST_APP_MAP maps to an application. */
const HOST_ENV = 'OSHAL_VERIFY_FOCUSED_HOST';
const SECOND_PAT_ENV = 'OSHAL_VERIFY_SECOND_PAT';
/** Spellings of the cockpit document and an experience entry page the redirect must cover. */
const SURFACES = Object.freeze(['/cockpit/', '/Cockpit/', '/COCKPIT/index.html', '/experience/index.html']);
/** The specs that guard the seams this case crosses live. */
const REGRESSION_TESTS = Object.freeze([
  { level: 'integration', path: 'tests/unit/host-app-map-http.spec.ts' },
  { level: 'integration', path: 'tests/unit/cockpit-shell-lock-routes.spec.ts' },
  { level: 'integration', path: 'tests/unit/ui-profile-focused-refusal.spec.ts' },
  { level: 'integration', path: 'tests/unit/ui-profile-rls-hidden-experience-postgres.spec.ts' },
]);

/**
 * @description The focused host the case asks as, from the options (a spec) or the environment.
 * @param {{focusedHost?: string}} options - Case options.
 * @returns {string} The host name, or '' when none is configured.
 */
function focusedHost(options) {
  const host = String((options && options.focusedHost) || process.env[HOST_ENV] || '').trim().toLowerCase();
  return /^[a-z0-9.-]{1,253}$/.test(host) ? host : '';
}

/**
 * @description Refuse a missing, malformed or differently bound origin before any caller request.
 * @param {string} origin - The origin the caller port actually targets.
 * @param {{focusedHost?: string}} [options] - Expected mapped host, or its environment value.
 * @returns {string|null} The named prerequisite problem, or null for the actual focused origin.
 */
function originRefusal(origin, options = {}) {
  const host = focusedHost(options);
  if (!host) return `Set ${HOST_ENV} to a host that HOST_APP_MAP maps to an application.`;
  let target;
  try { target = new URL(origin); } catch { return 'Bind the second caller to an explicit HTTP(S) origin with OSHAL_VERIFY_BASE_URL.'; }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password
    || target.pathname !== '/' || target.search || target.hash) return 'OSHAL_VERIFY_BASE_URL must be an HTTP(S) origin without credentials, a path, query or fragment.';
  return target.hostname.toLowerCase() === host ? null
    : `Set OSHAL_VERIFY_BASE_URL to the actual focused origin for ${HOST_ENV} (${host}); the caller is bound to ${target.origin}.`;
}

/**
 * @description One ordinary GET as the second caller on its verified focused origin.
 * @param {object} second - The second-caller port.
 * @param {string} route - Path and query.
 * @returns {Promise<object>} The reply.
 */
function askAs(second, route) {
  return second.api('GET', route);
}

/**
 * @description Judge the profile refusal for a name nothing synthesises: 404 with exactly the lock fields.
 * @param {{status: number, json: object}} res - The reply.
 * @returns {{state: 'pass'|'fail'|'unavailable', detail: string, landingApp: string|null}} The judgement and the landing it named.
 */
function judgeRefusal(res) {
  const body = res.json || {};
  const keys = Object.keys(body).sort().join(',');
  const landingApp = typeof body.landingApp === 'string' && body.landingApp ? body.landingApp : null;
  if (res.status === 200 && body.profile) return { state: 'fail', detail: `an unknown name answered 200 with profile "${body.profile.name}" (${String(body.profile.description || '').slice(0, 80)})`, landingApp };
  if (res.status === 404 && body.error === 'experience_unavailable' && !landingApp) return { state: 'unavailable', detail: 'the profile route named no focused landing for this host (is it in HOST_APP_MAP?)', landingApp };
  if (res.status !== 404 || body.error !== 'experience_unavailable' || keys !== 'error,landingApp,operator' || body.operator !== false) {
    return { state: 'fail', detail: `an unknown name answered HTTP ${res.status} with keys [${keys}] error=${body.error} operator=${body.operator}`, landingApp };
  }
  return { state: 'pass', detail: `an unknown name is refused 404 experience_unavailable (landing ${landingApp})`, landingApp };
}

/**
 * @description Judge the surface redirects: every spelling must 302 to the landing.
 * @param {Array<{path: string, status: number, location: string|null}>} replies - One reply per surface.
 * @param {string} landing - The expected landing path.
 * @returns {{state: 'pass'|'fail', detail: string}} The judgement.
 */
function judgeRedirects(replies, landing) {
  const wrong = replies.filter((reply) => reply.status !== 302 || reply.location !== landing);
  const line = replies.map((reply) => `${reply.path} -> ${reply.status}${reply.location ? ` ${reply.location}` : ''}`).join(', ');
  return wrong.length ? { state: 'fail', detail: `not every surface redirects to ${landing}: ${line}` } : { state: 'pass', detail: `${replies.length} surface spellings redirect to ${landing}` };
}

/**
 * @description Judge the no-name profile: the landing application, synthesised.
 * @param {{status: number, json: object}} res - The reply.
 * @param {string} landingApp - The landing application.
 * @returns {{state: 'pass'|'fail', detail: string}} The judgement.
 */
function judgeLanding(res, landingApp) {
  const body = res.json || {};
  const name = body.profile && body.profile.name;
  if (res.status === 200 && body.source === 'swarm-app' && body.requested === landingApp && name === landingApp) {
    return { state: 'pass', detail: `no name serves the landing application ${landingApp}` };
  }
  return { state: 'fail', detail: `no name answered HTTP ${res.status} source=${body.source} requested=${body.requested} profile=${name} error=${body.error}` };
}

/**
 * @description Read the second caller's operator verdict; the lock holds only non-operators.
 * @param {object} second - The second-caller port.
 * @returns {Promise<{ok: boolean, detail: string}>} Whether the caller is a non-operator.
 */
async function nonOperator(second) {
  const who = await askAs(second, '/api/cli-tokens/whoami');
  if (who.status !== 200) return { ok: false, detail: `the second caller did not resolve (whoami HTTP ${who.status})` };
  if (who.json.operator !== false) return { ok: false, detail: `the second caller (${SECOND_PAT_ENV}) is an operator; the lock holds only non-operators` };
  return { ok: true, detail: '' };
}

/**
 * @description Ask the three questions in order and fold their judgements.
 * @param {object} second - The second-caller port.
 * @param {string} host - The focused host.
 * @returns {Promise<{verdict: {state: string, detail: string}, evidence: object}>} The verdict and evidence.
 */
async function probe(second, host) {
  const refusal = judgeRefusal(await askAs(second, `/api/ui/profile?name=zzz-shell-lock-${crypto.randomBytes(4).toString('hex')}`));
  if (refusal.state !== 'pass') return { verdict: { state: refusal.state, detail: `${refusal.detail}.` }, evidence: { refusal: refusal.detail } };
  const landing = `/cockpit/?app=${refusal.landingApp}`;
  const replies = [];
  for (const path of SURFACES) {
    const res = await askAs(second, path);
    replies.push({ path, status: res.status, location: res.location || null });
  }
  const redirects = judgeRedirects(replies, landing);
  const plain = judgeLanding(await askAs(second, '/api/ui/profile'), refusal.landingApp);
  const parts = [refusal, redirects, plain];
  const state = parts.every((part) => part.state === 'pass') ? 'pass' : 'fail';
  return { verdict: { state, detail: `${parts.map((part) => part.detail).join('; ')}.` },
    evidence: { host, refusal: refusal.detail, redirects: redirects.detail, landing: plain.detail } };
}

/**
 * @description Run the case once. Read-only: every request is a GET, so there is nothing to clean up.
 * @param {object} ports - second (a non-operator's api port).
 * @param {{focusedHost?: string}} [options] - Case options; the host otherwise comes from OSHAL_VERIFY_FOCUSED_HOST.
 * @returns {Promise<object>} The result with its (empty) cleanup receipt.
 */
async function run(ports, options = {}) {
  if (common.missingPorts(ports, NEEDS).length) {
    return common.unavailable(CASE_ID, `This runner binds no second caller: set ${SECOND_PAT_ENV} to the token of a NON-operator on the focused host.`);
  }
  const host = focusedHost(options);
  const targetProblem = originRefusal(ports.second.origin, options);
  if (targetProblem) return common.unavailable(CASE_ID, targetProblem);
  const ledger = new common.CleanupLedger();
  try {
    const caller = await nonOperator(ports.second);
    if (!caller.ok) return common.unavailable(CASE_ID, `${caller.detail}.`);
    const { verdict, evidence } = await probe(ports.second, host);
    return common.finish(CASE_ID, verdict, ledger, evidence);
  } catch (error) {
    return common.finish(CASE_ID, { state: 'fail', detail: `The case crashed: ${common.errorText(error)}` }, ledger);
  }
}

module.exports = { CASE_ID, KEY, TITLE, NEEDS, REGRESSION_TESTS, SURFACES, originRefusal, judgeRefusal, judgeRedirects, judgeLanding, run };
