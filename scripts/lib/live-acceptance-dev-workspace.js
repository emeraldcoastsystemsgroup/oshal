/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for "Jarvis in dev mode should see what this workspace sees" (dev-workspace-index). As the caller: read the package's gate (super-admin, dev console, package flag); turn dev mode on through the package's same-origin route and require the index built; open one tagged Jarvis conversation through the real /api/jarvis/ask asking about the ADR (package-tool proposals must name a Jarvis session the caller owns, and only the ask route creates one issuer-bound); drive the Jarvis package-tool flow (preview, execute) in that conversation naming the ADR number and require the cited doc_id of that ADR's file; turn dev mode off and require the same ask refused with no citation; then restore the caller's original dev-mode state and remove the conversation. The deployment flags need an api restart, so when a gate is closed the case reports the configuration step and writes nothing.
 */

'use strict';

const common = require('./live-acceptance-common.js');
const thread = require('./live-acceptance-jarvis-thread.js');

const CASE_ID = 'dev-workspace-index-live';
const KEY = 'dev-workspace';
const TITLE = 'Developer workspace index: cited ADR answer in dev mode, refused outside it';
const NEEDS = Object.freeze(['api', 'sql', 'workspace', 'ownerSub']);
const TOOL = 'dev_workspace_search';
const BASE = '/api/dev-workspace-index';
const TOOLS = '/api/jarvis/package-tools';
/** The ADR the ask names; its indexed path must be docs/adr/<number>-*.md. */
const DEFAULT_ADR = '077';
const DEFAULT_BUDGETS = Object.freeze({ answerBudgetMs: 300_000, settleBudgetMs: 180_000, pollMs: 3_000 });
/** What the operator must do when a deployment gate is closed (each needs an api restart). */
const CONFIG_STEP = 'Stage dev-workspace-index 0.2.0, set OSHAL_DEV_WORKSPACE_INDEX_ENABLED=true and OSHAL_DEV_CONSOLE_ENABLED=true, '
  + 'put the operator subject on OSHAL_SUPERADMIN_SUBS, restart the api, and build the index with '
  + 'node tools/workspace-index.js --root <checkout> (from the package).';

/**
 * @description Why the package gate is closed for this caller, or null when every gate is open.
 * @param {{status: number, json: object}} res - GET /api/dev-workspace-index/dev-mode.
 * @returns {string|null} The closed gate, named.
 */
function closedGate(res) {
  if (res.status === 404) return 'dev-workspace-index is not installed on this deployment';
  if (res.status !== 200) return `GET ${BASE}/dev-mode answered HTTP ${res.status}`;
  const body = res.json || {};
  if (body.packageEnabled !== true) return 'OSHAL_DEV_WORKSPACE_INDEX_ENABLED is off';
  if (body.devConsoleEnabled !== true) return 'the ADR-077 dev console (OSHAL_DEV_CONSOLE_ENABLED) is off';
  if (body.superAdmin !== true) return 'the caller is not on OSHAL_SUPERADMIN_SUBS';
  return null;
}

/**
 * @description Switch the caller's dev mode through the package's same-origin action route.
 * @param {object} io - api, origin.
 * @param {boolean} on - Target state.
 * @returns {Promise<{status: number, enabled: boolean|null}>} The route's answer.
 */
async function switchDevMode(io, on) {
  const res = await io.api(on ? 'POST' : 'DELETE', `${BASE}/dev-mode`, {}, { headers: common.sameOriginHeaders(io.origin, 'x-oshal-dev-workspace') });
  const enabled = res.json && res.json.devMode ? res.json.devMode.enabled === true : null;
  return { status: res.status, enabled };
}

/**
 * @description One Jarvis package-tool ask: preview then execute, as the Jarvis surface does.
 * @param {object} io - api, origin.
 * @param {string} sessionId - The caller's Jarvis conversation.
 * @param {string} query - The ask.
 * @returns {Promise<{preview: number, execute: number|null, results: object[], citation: string, error: string|null}>} The outcome.
 */
async function askTool(io, sessionId, query) {
  const headers = common.sameOriginHeaders(io.origin, 'x-oshal-package-tool');
  const preview = await io.api('POST', `${TOOLS}/preview`, { sessionId, toolName: TOOL, input: { query, limit: 3 } }, { headers });
  const proposalId = preview.json && preview.json.id;
  if (preview.status !== 200 || !proposalId) {
    return { preview: preview.status, execute: null, results: [], citation: '', error: String((preview.json && preview.json.error) || 'no proposal') };
  }
  const execute = await io.api('POST', `${TOOLS}/execute`, { proposalId }, { headers });
  const result = (execute.json && execute.json.result) || {};
  return { preview: preview.status, execute: execute.status, results: Array.isArray(result.results) ? result.results : [],
    citation: String(result.citation || ''), error: execute.status === 200 ? null : String((execute.json && execute.json.error) || 'refused') };
}

/**
 * @description Judge the dev-mode ask: executed, and its first result is the named ADR with a doc_id.
 * @param {Awaited<ReturnType<typeof askTool>>} ask - The ask outcome.
 * @param {string} adr - The ADR number.
 * @returns {{ok: boolean, detail: string, docId: string|null, path: string|null}} The judgement.
 */
function judgeCitedAnswer(ask, adr) {
  const top = ask.results[0] || null;
  const pathRe = new RegExp(`^docs/adr/${adr}-[\\w.-]+\\.md$`);
  if (ask.execute !== 200) return { ok: false, detail: `the dev-mode ask was refused (preview ${ask.preview}, execute ${ask.execute}: ${ask.error})`, docId: null, path: null };
  if (!top || typeof top.doc_id !== 'string' || !top.doc_id) return { ok: false, detail: 'the dev-mode ask returned no cited result', docId: null, path: null };
  if (!pathRe.test(String(top.path))) return { ok: false, detail: `the top result is ${top.path}, not ADR-${adr}`, docId: top.doc_id, path: String(top.path) };
  return { ok: true, detail: `ADR-${adr} ask returned doc_id ${top.doc_id} (${top.path})`, docId: top.doc_id, path: String(top.path) };
}

/**
 * @description Judge the ask with dev mode off: refused, and nothing cited came back.
 * @param {Awaited<ReturnType<typeof askTool>>} ask - The ask outcome.
 * @returns {{ok: boolean, detail: string}} The judgement.
 */
function judgeRefusal(ask) {
  if (ask.results.length) return { ok: false, detail: `outside dev mode the ask still returned ${ask.results.length} cited result(s)` };
  if (ask.execute === 200) return { ok: false, detail: 'outside dev mode the ask executed (HTTP 200) instead of being refused' };
  return { ok: true, detail: `outside dev mode the same ask was refused (preview ${ask.preview}${ask.execute === null ? '' : `, execute ${ask.execute}`}: ${ask.error})` };
}

/**
 * @description The package-tool half inside an open conversation: cited in dev mode, refused outside it.
 * @param {object} io - Ports.
 * @param {object} conversation - The open conversation.
 * @param {string} adr - The ADR number.
 * @returns {Promise<{state: string, detail: string, evidence: object}>} The verdict.
 */
async function toolHalf(io, conversation, adr) {
  const answered = judgeCitedAnswer(await askTool(io, conversation.sessionId, `ADR-${adr}`), adr);
  const off = await switchDevMode(io, false);
  if (off.status !== 200 || off.enabled !== false) return { state: 'fail', detail: `${answered.detail}; turning dev mode off answered HTTP ${off.status}`, evidence: {} };
  const refused = judgeRefusal(await askTool(io, conversation.sessionId, `ADR-${adr}`));
  const jarvisCited = Boolean(answered.docId && conversation.answer.includes(answered.docId));
  const evidence = { docId: answered.docId, path: answered.path, jarvisAnswerSeconds: conversation.answerSeconds, jarvisAnswerCitedDocId: jarvisCited };
  return { state: answered.ok && refused.ok ? 'pass' : 'fail', detail: `${answered.detail}; ${refused.detail}`, evidence };
}

/**
 * @description The body of the case once the gate is open: on, index, conversation, cited ask, off, refused ask.
 * @param {object} io - Ports.
 * @param {string} tag - The run's fixture tag.
 * @param {string} adr - The ADR number.
 * @param {object} budgets - Budgets.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @param {object[]} conversations - Filled with the conversation this run opens (for cleanup).
 * @returns {Promise<{state: string, detail: string, evidence: object}>} The verdict.
 */
async function exercise(io, tag, adr, budgets, ledger, conversations) {
  const on = await switchDevMode(io, true);
  if (on.status !== 200 || on.enabled !== true) return { state: 'fail', detail: `turning dev mode on answered HTTP ${on.status}`, evidence: {} };
  const status = await io.api('GET', `${BASE}/status`);
  if (status.status !== 200 || !(status.json && status.json.indexPresent)) {
    return { state: 'unavailable', detail: `the index is not built on this deployment (GET ${BASE}/status HTTP ${status.status}). ${CONFIG_STEP}`, evidence: {} };
  }
  const question = `Which document in this repository is ADR-${adr}, and what does it decide? Cite its doc_id.`;
  const conversation = await thread.openConversation(io, `${tag}-1`, question, budgets, ledger);
  conversations.push(conversation);
  if (conversation.error) return { state: 'fail', detail: `the Jarvis conversation did not open: ${conversation.error}`, evidence: {} };
  const outcome = await toolHalf(io, conversation, adr);
  return { ...outcome, evidence: { ...outcome.evidence, counts: status.json.counts || null } };
}

/**
 * @description Put the caller's dev mode back where it was and prove it.
 * @param {object} io - Ports.
 * @param {boolean} initial - The state before the run.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function restoreDevMode(io, initial, ledger) {
  await ledger.attempt('dev-mode restore', async () => {
    const now = await io.api('GET', `${BASE}/dev-mode`);
    const enabled = now.json && now.json.devMode ? now.json.devMode.enabled === true : null;
    if (enabled !== initial) await switchDevMode(io, initial);
    const after = await io.api('GET', `${BASE}/dev-mode`);
    const final = after.json && after.json.devMode ? after.json.devMode.enabled === true : null;
    if (final !== initial) return `dev mode is ${final ? 'on' : 'off'} after the run; it was ${initial ? 'on' : 'off'} before`;
    ledger.removed('dev-mode-change', initial ? 'restored-on' : 'restored-off');
    return null;
  });
}

/**
 * @description Run the case once.
 * @param {object} ports - api, origin, sql, workspace, ownerSub.
 * @param {object} [options] - `adr` (a three-digit ADR number to ask for), budget overrides, `tag` (tests only).
 * @returns {Promise<object>} The result with its cleanup receipt.
 */
async function run(ports, options = {}) {
  const missing = common.missingPorts(ports, [...NEEDS, 'origin']);
  if (missing.length) return common.unavailable(CASE_ID, `This runner has no ${missing.join('/')} port.`);
  const io = common.withClock(ports);
  const adr = /^\d{3}$/.test(String(options.adr || '')) ? String(options.adr) : DEFAULT_ADR;
  const tag = options.tag || common.mintTag(KEY);
  const gate = await io.api('GET', `${BASE}/dev-mode`);
  const closed = closedGate(gate);
  if (closed) return common.unavailable(CASE_ID, `${closed}; the case cannot open it without an api restart. ${CONFIG_STEP}`);
  const initial = gate.json.devMode && gate.json.devMode.enabled === true;
  const ledger = new common.CleanupLedger();
  ledger.created('dev-mode-change', initial ? 'restored-on' : 'restored-off', 'the run switches dev mode and must leave it as it found it');
  const conversations = [];
  let verdict;
  try {
    const outcome = await exercise(io, tag, adr, common.budgetsFrom(DEFAULT_BUDGETS, options), ledger, conversations);
    verdict = { state: outcome.state, detail: `${outcome.detail}.`, evidence: outcome.evidence };
  } catch (error) {
    verdict = { state: 'fail', detail: `The case crashed: ${common.errorText(error)}`, evidence: {} };
  }
  await restoreDevMode(io, initial, ledger);
  await thread.closeConversations(io, conversations, ledger);
  return common.finish(CASE_ID, verdict, ledger, { adr, initialDevMode: initial, ...verdict.evidence });
}

module.exports = { CASE_ID, KEY, TITLE, NEEDS, CONFIG_STEP, closedGate, judgeCitedAnswer, judgeRefusal, run };
