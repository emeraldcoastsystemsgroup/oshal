/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for "Jarvis in dev mode should see what this workspace sees" (dev-workspace-index). As the caller: read the package's gate (super-admin, dev console, package flag); turn dev mode on through the package's same-origin route and require the index built; open one tagged Jarvis conversation through the real /api/jarvis/ask asking about the ADR (package-tool proposals must name a Jarvis session the caller owns, and only the ask route creates one issuer-bound); drive the Jarvis package-tool flow (preview, execute) in that conversation naming the ADR number and require the cited doc_id of that ADR's file; turn dev mode off and require the same ask refused with no citation; then restore the caller's original dev-mode state and remove the conversation. The deployment flags need an api restart, so when a gate is closed the case reports the configuration step and writes nothing.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Cover the rest of the entry's Done-when in the same tagged conversation. Four dev-mode asks - the ADR number, a docs/BACKLOG.md entry title, a docs/runbooks/*.md runbook (the runbooks index README is not a runbook) and a local-notes/ handover document from the index's --notes-dir set - are each judged by path family: the first returned result of the family must carry a doc_id (an uncited reply is a fail), and its rank is reported because the package's search is lexical. With dev mode off all four asks must be refused with no citation, and an unauthenticated GET of the query route (a new `anonymous` port with no credential) must answer 401 or 403. The backlog and runbook asks have tracked defaults; the handover ask has none and arrives by name (option `notesProbe` or OSHAL_VERIFY_DEV_NOTES_PROBE), so no untracked file name is written here. An index that holds no local-notes documents (read from /status `sources`) is UNAVAILABLE naming the --notes-dir build step, and a missing handover probe is UNAVAILABLE naming its variable; neither is ever a pass.
 */

'use strict';

const common = require('./live-acceptance-common.js');
const thread = require('./live-acceptance-jarvis-thread.js');

const CASE_ID = 'dev-workspace-index-live';
const KEY = 'dev-workspace';
const TITLE = 'Developer workspace index: cited ADR, backlog, runbook and handover answers in dev mode, refused outside it';
const NEEDS = Object.freeze(['api', 'anonymous', 'sql', 'workspace', 'ownerSub']);
const TOOL = 'dev_workspace_search';
const BASE = '/api/dev-workspace-index';
const TOOLS = '/api/jarvis/package-tools';
/** The ADR the ask names; its indexed path must be docs/adr/<number>-*.md. */
const DEFAULT_ADR = '077';
/** How many results each ask requests; the package's search is lexical, so a family hit may not rank first. */
const ASK_LIMIT = 5;
/** The package tool refuses a query longer than this (its inputSchema maxLength). */
const MAX_PROBE_LENGTH = 200;
/** Where the probe texts come from when the caller passes no option. */
const PROBE_ENV = Object.freeze({ backlog: 'OSHAL_VERIFY_DEV_BACKLOG_PROBE', runbook: 'OSHAL_VERIFY_DEV_RUNBOOK_PROBE', notes: 'OSHAL_VERIFY_DEV_NOTES_PROBE' });
/**
 * Tracked defaults: an open docs/BACKLOG.md entry title and the words of a runbook's title. There is
 * no default for the handover: it is an untracked local note, so its words are supplied by name.
 */
const DEFAULT_PROBES = Object.freeze({
  backlog: 'Six host scheduled tasks predate the platform scheduler and should move into it',
  runbook: 'localhost wedge stale wslrelay squatting',
});
/** The path family each ask must return; the local-notes prefix is the package manifest's localNotesPrefix. */
const FAMILIES = Object.freeze({
  backlog: { label: 'BACKLOG entry title', family: 'docs/BACKLOG.md', re: /^docs\/BACKLOG\.md$/ },
  runbook: { label: 'runbook', family: 'docs/runbooks/*.md', re: /^docs\/runbooks\/(?!README\.md$)[^/]+\.md$/ },
  notes: { label: 'handover', family: 'local-notes/*', re: /^local-notes\/.+/ },
});
const DEFAULT_BUDGETS = Object.freeze({ answerBudgetMs: 300_000, settleBudgetMs: 180_000, pollMs: 3_000 });
/** What the operator must do when a deployment gate is closed (each needs an api restart). */
const CONFIG_STEP = 'Stage dev-workspace-index 0.2.1, set OSHAL_DEV_WORKSPACE_INDEX_ENABLED=true and OSHAL_DEV_CONSOLE_ENABLED=true, '
  + 'put the operator subject on OSHAL_SUPERADMIN_SUBS, restart the api, and build the index with '
  + 'node tools/workspace-index.js --root <checkout> --notes-dir <local notes directory> (from the package).';
/** The build step the handover ask needs when the index holds no local notes. */
const NOTES_BUILD_STEP = 'rebuild it with the local notes directory named: node tools/workspace-index.js --root <checkout> '
  + '--notes-dir <local notes directory> (from the package)';

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
 * @description The four asks of one run, in the order they are asked, and the named gap when the
 * handover ask has no text. Options win over the environment; the environment over the defaults.
 * @param {string} adr - The ADR number.
 * @param {object} options - Caller options (`backlogProbe`, `runbookProbe`, `notesProbe`, `env`).
 * @returns {{probes: Array<{key: string, label: string, family: string, re: RegExp, query: string}>, gap: string|null}} The asks.
 */
function probesFor(adr, options = {}) {
  const env = options.env || process.env;
  const text = (key) => String(options[`${key}Probe`] ?? env[PROBE_ENV[key]] ?? DEFAULT_PROBES[key] ?? '').trim();
  const probes = [{ key: 'adr', label: `ADR-${adr}`, family: `docs/adr/${adr}-*.md`, re: new RegExp(`^docs/adr/${adr}-[\\w.-]+\\.md$`), query: `ADR-${adr}` }];
  const gaps = [];
  for (const key of ['backlog', 'runbook', 'notes']) {
    const query = text(key);
    if (!query || query.length > MAX_PROBE_LENGTH) gaps.push(`the ${FAMILIES[key].label} ask needs ${PROBE_ENV[key]} (or the ${key}Probe option) set to 1-${MAX_PROBE_LENGTH} characters of its words`);
    probes.push({ key, ...FAMILIES[key], query });
  }
  return { probes, gap: gaps.length ? gaps.join('; ') : null };
}

/**
 * @description Why the built index cannot answer every ask, or null when it can.
 * @param {{status: number, json: object}} status - GET /api/dev-workspace-index/status with dev mode on.
 * @returns {string|null} The missing build step, named.
 */
function indexGap(status) {
  if (status.status !== 200 || !(status.json && status.json.indexPresent)) {
    return `the index is not built on this deployment (GET ${BASE}/status HTTP ${status.status}). ${CONFIG_STEP}`;
  }
  const sources = status.json.sources;
  if (!sources || typeof sources !== 'object') return `the installed dev-workspace-index does not report its index sources (GET ${BASE}/status has no sources); stage 0.2.1 or later`;
  if (!(Number(sources['local-notes']) > 0)) return `the index holds no local-notes documents, so tonight's handover cannot be asked for; ${NOTES_BUILD_STEP}`;
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
  const preview = await io.api('POST', `${TOOLS}/preview`, { sessionId, toolName: TOOL, input: { query, limit: ASK_LIMIT } }, { headers });
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
 * @description Judge one dev-mode ask: executed, a result of the expected path family came back, and
 * that result carries a doc_id. A family hit without a doc_id is an uncited reply and fails.
 * @param {Awaited<ReturnType<typeof askTool>>} ask - The ask outcome.
 * @param {{key: string, label: string, family: string, re: RegExp}} probe - What was asked and the family it must return.
 * @returns {{key: string, ok: boolean, detail: string, docId: string|null, path: string|null, rank: number|null}} The judgement.
 */
function judgeCitedAnswer(ask, probe) {
  const none = { key: probe.key, ok: false, docId: null, path: null, rank: null };
  if (ask.execute !== 200) return { ...none, detail: `the dev-mode ${probe.label} ask was refused (preview ${ask.preview}, execute ${ask.execute}: ${ask.error})` };
  const rank = ask.results.findIndex((r) => r && probe.re.test(String(r.path)));
  if (rank < 0) {
    const got = ask.results.map((r) => String(r && r.path)).join(', ') || 'nothing';
    return { ...none, detail: `the dev-mode ${probe.label} ask returned no ${probe.family} result (got ${got})` };
  }
  const hit = ask.results[rank];
  const path = String(hit.path);
  if (typeof hit.doc_id !== 'string' || !hit.doc_id.trim()) return { ...none, path, rank: rank + 1, detail: `the dev-mode ${probe.label} ask returned ${path} with no doc_id (an uncited reply)` };
  return { key: probe.key, ok: true, detail: `${probe.label} ask returned doc_id ${hit.doc_id} (${path}, rank ${rank + 1})`, docId: hit.doc_id, path, rank: rank + 1 };
}

/**
 * @description Judge one ask with dev mode off: refused, and nothing cited came back.
 * @param {Awaited<ReturnType<typeof askTool>>} ask - The ask outcome.
 * @param {{label: string}} probe - What was asked.
 * @returns {{ok: boolean, detail: string}} The judgement.
 */
function judgeRefusal(ask, probe) {
  if (ask.results.length) return { ok: false, detail: `outside dev mode the ${probe.label} ask still returned ${ask.results.length} cited result(s)` };
  if (ask.execute === 200) return { ok: false, detail: `outside dev mode the ${probe.label} ask executed (HTTP 200) instead of being refused` };
  return { ok: true, detail: `outside dev mode the ${probe.label} ask was refused (preview ${ask.preview}${ask.execute === null ? '' : `, execute ${ask.execute}`}: ${ask.error})` };
}

/**
 * @description An unauthenticated GET of the package's query route, sent with no credential at all.
 * @param {object} io - anonymous.
 * @param {string} adr - The ADR number the query names.
 * @returns {Promise<{ok: boolean, detail: string, status: number}>} The judgement: only 401 or 403 with no results passes.
 */
async function anonymousProbe(io, adr) {
  const route = `${BASE}/query?q=${encodeURIComponent(`ADR-${adr}`)}`;
  const res = await io.anonymous('GET', route);
  const results = Array.isArray(res.json && res.json.results) ? res.json.results.length : 0;
  if ((res.status === 401 || res.status === 403) && !results) return { ok: true, detail: `an unauthenticated GET ${route} answered ${res.status}`, status: res.status };
  return { ok: false, detail: `an unauthenticated GET ${route} answered HTTP ${res.status}${results ? ` with ${results} result(s)` : ''} instead of 401 or 403`, status: res.status };
}

/**
 * @description The package-tool half inside an open conversation: every ask cited in dev mode, every ask refused outside it.
 * @param {object} io - Ports.
 * @param {object} conversation - The open conversation.
 * @param {Array<object>} probes - The four asks.
 * @returns {Promise<{ok: boolean, detail: string, evidence: object}>} The verdict of this half.
 */
async function toolHalf(io, conversation, probes) {
  const answered = [];
  for (const probe of probes) answered.push(judgeCitedAnswer(await askTool(io, conversation.sessionId, probe.query), probe));
  const off = await switchDevMode(io, false);
  if (off.status !== 200 || off.enabled !== false) return { ok: false, detail: `${answered.map((a) => a.detail).join('; ')}; turning dev mode off answered HTTP ${off.status}`, evidence: {} };
  const refused = [];
  for (const probe of probes) refused.push(judgeRefusal(await askTool(io, conversation.sessionId, probe.query), probe));
  const citations = Object.fromEntries(answered.map((a) => [a.key, { docId: a.docId, path: a.path, rank: a.rank }]));
  const jarvisAnswerCitedDocIds = answered.filter((a) => a.docId && conversation.answer.includes(a.docId)).map((a) => a.key);
  return { ok: [...answered, ...refused].every((j) => j.ok), detail: [...answered, ...refused].map((j) => j.detail).join('; '),
    evidence: { citations, jarvisAnswerSeconds: conversation.answerSeconds, jarvisAnswerCitedDocIds } };
}

/**
 * @description The question the tagged Jarvis conversation opens with: all four asks, by their words.
 * @param {Array<{key: string, query: string}>} probes - The asks.
 * @returns {string} One turn.
 */
function openingQuestion(probes) {
  const q = Object.fromEntries(probes.map((p) => [p.key, p.query]));
  return `Using the developer workspace index, which documents are ${q.adr}, the backlog entry "${q.backlog}", the runbook about "${q.runbook}" `
    + `and tonight's handover ("${q.notes}")? Cite each doc_id.`;
}

/**
 * @description The body of the case once the gate is open: on, index, anonymous refusal, conversation, cited asks, off, refused asks.
 * @param {object} io - Ports.
 * @param {{tag: string, adr: string, probes: object[], probeGap: string|null, budgets: object}} plan - The run's plan.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @param {object[]} conversations - Filled with the conversation this run opens (for cleanup).
 * @returns {Promise<{state: string, detail: string, evidence: object}>} The verdict.
 */
async function exercise(io, plan, ledger, conversations) {
  const on = await switchDevMode(io, true);
  if (on.status !== 200 || on.enabled !== true) return { state: 'fail', detail: `turning dev mode on answered HTTP ${on.status}`, evidence: {} };
  const status = await io.api('GET', `${BASE}/status`);
  const gaps = [indexGap(status), plan.probeGap].filter(Boolean);
  if (gaps.length) return { state: 'unavailable', detail: gaps.join('; '), evidence: { sources: (status.json && status.json.sources) || null } };
  const anonymous = await anonymousProbe(io, plan.adr);
  const conversation = await thread.openConversation(io, `${plan.tag}-1`, openingQuestion(plan.probes), plan.budgets, ledger);
  conversations.push(conversation);
  if (conversation.error) return { state: 'fail', detail: `the Jarvis conversation did not open: ${conversation.error}`, evidence: {} };
  const half = await toolHalf(io, conversation, plan.probes);
  const evidence = { ...half.evidence, anonymousStatus: anonymous.status, counts: status.json.counts || null, sources: status.json.sources };
  return { state: half.ok && anonymous.ok ? 'pass' : 'fail', detail: `${anonymous.detail}; ${half.detail}`, evidence };
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
 * @param {object} ports - api, anonymous, origin, sql, workspace, ownerSub.
 * @param {object} [options] - `adr` (a three-digit ADR number), `backlogProbe` / `runbookProbe` / `notesProbe` (the words
 *   each ask sends; otherwise OSHAL_VERIFY_DEV_*_PROBE from `env`, default process.env), budget overrides, `tag` (tests only).
 * @returns {Promise<object>} The result with its cleanup receipt.
 */
async function run(ports, options = {}) {
  const missing = common.missingPorts(ports, [...NEEDS, 'origin']);
  if (missing.length) return common.unavailable(CASE_ID, `This runner has no ${missing.join('/')} port.`);
  const io = common.withClock(ports);
  const adr = /^\d{3}$/.test(String(options.adr || '')) ? String(options.adr) : DEFAULT_ADR;
  const { probes, gap } = probesFor(adr, options);
  const plan = { tag: options.tag || common.mintTag(KEY), adr, probes, probeGap: gap, budgets: common.budgetsFrom(DEFAULT_BUDGETS, options) };
  const gate = await io.api('GET', `${BASE}/dev-mode`);
  const closed = closedGate(gate);
  if (closed) return common.unavailable(CASE_ID, `${closed}; the case cannot open it without an api restart. ${CONFIG_STEP}`);
  const initial = gate.json.devMode && gate.json.devMode.enabled === true;
  const ledger = new common.CleanupLedger();
  ledger.created('dev-mode-change', initial ? 'restored-on' : 'restored-off', 'the run switches dev mode and must leave it as it found it');
  const conversations = [];
  let verdict;
  try {
    const outcome = await exercise(io, plan, ledger, conversations);
    verdict = { state: outcome.state, detail: `${outcome.detail}.`, evidence: outcome.evidence };
  } catch (error) {
    verdict = { state: 'fail', detail: `The case crashed: ${common.errorText(error)}`, evidence: {} };
  }
  await restoreDevMode(io, initial, ledger);
  await thread.closeConversations(io, conversations, ledger);
  return common.finish(CASE_ID, verdict, ledger, { adr, initialDevMode: initial, ...verdict.evidence });
}

module.exports = { CASE_ID, KEY, TITLE, NEEDS, CONFIG_STEP, PROBE_ENV, DEFAULT_PROBES, closedGate, probesFor, indexGap, judgeCitedAnswer, judgeRefusal, run };
