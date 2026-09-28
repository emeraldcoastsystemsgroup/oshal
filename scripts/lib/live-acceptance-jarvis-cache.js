/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live measurement for "Jarvis starts cold on every conversation - prime the invariant context once". Opens N (default 3) fresh, uniquely tagged Jarvis conversations in sequence through the real POST /api/jarvis/ask, each asking one short tool-free question, and for each reads the Jarvis bot's own call log ("OpenAI-compatible call ... (input I, output O, cached C), invariant cache STATE") inside that conversation's window, plus the owner's cost-ledger rows and chat_tasks rollups. Passes when the first conversation's call created (or hit) the cache and every later fresh conversation HIT it with cached tokens > 0. When no OpenAI-compatible call was logged, Jarvis answered on another brain and the case says so, naming the provider from the ledger. It renders the measurement as a Markdown block for docs/architecture/jarvis-own-task-recall.md. Every conversation, its messages, chat ticket, ask job and ask workspace are deleted and a residue read must come back empty; the cost ledger and usage rollups record real spend and are kept.
 */

'use strict';

const common = require('./live-acceptance-common.js');
const thread = require('./live-acceptance-jarvis-thread.js');

const CASE_ID = 'jarvis-prompt-cache-live';
const KEY = 'jarvis-cache';
const TITLE = 'Jarvis invariant-preamble cache across fresh conversations (created, then hit)';
const NEEDS = Object.freeze(['api', 'sql', 'logs', 'workspace', 'ownerSub']);
/** Tool-free and conversational (a wh-question, no work verb), so Jarvis answers it rather than filing work. */
const QUESTION = 'What is 2 plus 3? Reply with just the number.';
const DEFAULT_CONTAINER = 'oshal-local-jarvis-bot';
const JARVIS_AGENT_NAME = 'oshal-assistant';
const DEFAULTS = Object.freeze({ conversations: 3, answerBudgetMs: 300_000, settleBudgetMs: 180_000, pollMs: 3_000, logSlackMs: 5_000 });
/** The call-log line OpenAIProvider.js prints after every call. */
const CALL_RE = /OpenAI-compatible call \((.+?) @ (.+?)\): (\d+)ms, (\d+) tokens \(input (\d+), output (\d+), cached (\d+)\), invariant cache ([\w-]+)/;
const DOC_START = '<!-- live-acceptance:jarvis-prompt-cache:start -->';
const DOC_END = '<!-- live-acceptance:jarvis-prompt-cache:end -->';

/**
 * @description Parse `docker logs --timestamps` lines into call records inside a time window.
 * @param {string[]} lines - Raw log lines (timestamp prefix, then pino JSON or text).
 * @param {number} fromMs - Window start (epoch ms).
 * @param {number} toMs - Window end (epoch ms).
 * @returns {Array<{at: number, model: string, endpoint: string, latencyMs: number, total: number, input: number, output: number, cached: number, state: string}>} Calls.
 */
function parseCallLines(lines, fromMs, toMs) {
  const calls = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = String(raw);
    const stamp = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(.*)$/);
    let at = stamp ? Date.parse(stamp[1]) : NaN;
    let text = stamp ? stamp[2] : line;
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj.msg === 'string') text = obj.msg;
      if (obj && Number.isFinite(Number(obj.time))) at = Number(obj.time);
    } catch { /* a plain-text line */ }
    const m = text.match(CALL_RE);
    if (!m || !Number.isFinite(at) || at < fromMs || at > toMs) continue;
    calls.push({ at, model: m[1], endpoint: m[2], latencyMs: Number(m[3]), total: Number(m[4]), input: Number(m[5]),
      output: Number(m[6]), cached: Number(m[7]), state: m[8] });
  }
  return calls.sort((a, b) => a.at - b.at);
}

/**
 * @description Judge the measured conversations.
 * @param {Array<{sessionId: string, delivered: boolean, calls: object[]}>} measured - Per conversation, in order.
 * @param {{providers: string[]}} ledger - Providers the cost ledger names for the run.
 * @returns {{state: string, detail: string}} The verdict.
 */
function judgeMeasurement(measured, ledger) {
  const undelivered = measured.filter((m) => !m.delivered);
  if (undelivered.length) return { state: 'fail', detail: `${undelivered.length} of ${measured.length} conversation(s) got no answer: ${undelivered.map((m) => m.sessionId).join(', ')}` };
  if (measured.every((m) => !m.calls.length)) {
    const named = ledger.providers.length ? ledger.providers.join(', ') : 'no cost-ledger provider either';
    return { state: 'unavailable', detail: `No OpenAI-compatible call was logged during the ${measured.length} asks, so Jarvis answered on another brain (${named}). The invariant cache runs only on the OpenAI-compatible rail; which brain Jarvis uses is the operator's choice` };
  }
  const firsts = measured.map((m) => m.calls[0] || { state: 'no-call', cached: 0 });
  const sequence = firsts.map((c) => `${c.state}${c.cached ? `(${c.cached} cached)` : ''}`).join(' -> ');
  const coldOk = ['created', 'hit'].includes(firsts[0].state);
  const warmOk = firsts.slice(1).every((c) => c.state === 'hit' && c.cached > 0);
  if (coldOk && warmOk) return { state: 'pass', detail: `first-call cache states ${sequence}: every fresh conversation after the first reused the invariant preamble` };
  return { state: 'fail', detail: `first-call cache states ${sequence}: expected created (or hit) then hit with cached tokens on every later conversation` };
}

/**
 * @description Open one fresh conversation through the real ask route and measure its window of the call log.
 * @param {object} io - Ports with clock.
 * @param {string} sessionId - The conversation (a fixture tag).
 * @param {object} budgets - Budgets.
 * @param {string} container - The Jarvis bot container whose log is read.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<object>} The conversation (for cleanup) with its measured calls.
 */
async function measureConversation(io, sessionId, budgets, container, ledger) {
  const startedAt = io.now();
  const conversation = await thread.openConversation(io, sessionId, QUESTION, budgets, ledger);
  if (conversation.error) return { ...conversation, calls: [] };
  const endedAt = io.now() + budgets.logSlackMs;
  const lines = await io.logs(container, new Date(startedAt - budgets.logSlackMs).toISOString());
  return { ...conversation, calls: parseCallLines(lines, startedAt - budgets.logSlackMs, endedAt) };
}

/**
 * @description The owner's ledger rows and rollups for the run, grouped per conversation.
 * @param {object} io - api, sql, ownerSub.
 * @param {string} tag - The run's tag (every session id starts with it).
 * @param {number} runStart - Epoch ms the run started.
 * @returns {Promise<{providers: string[], bySession: Record<string, {ledgerInput: number, rollupInput: number}>}>} Usage.
 */
async function readUsage(io, tag, runStart) {
  const agents = await io.api('GET', '/api/agents');
  const list = Array.isArray(agents.json) ? agents.json : (Array.isArray(agents.json && agents.json.agents) ? agents.json.agents : []);
  const jarvis = list.find((a) => a && a.name === JARVIS_AGENT_NAME);
  const since = new Date(runStart).toISOString();
  const events = jarvis ? ((await io.sql('jarvis.cost-events', [io.ownerSub, jarvis.agentId, since])).rows || []) : [];
  const rollups = (await io.sql('jarvis.rollups', [io.ownerSub, since, `${tag}%`])).rows || [];
  const bySession = {};
  const bucket = (taskId) => {
    const key = String(taskId || '').match(new RegExp(`^(${tag}-\\d+)`));
    if (!key) return null;
    bySession[key[1]] = bySession[key[1]] || { ledgerInput: 0, rollupInput: 0 };
    return bySession[key[1]];
  };
  for (const row of events) { const b = bucket(row.task_id); if (b) b.ledgerInput += Number(row.input_tokens || 0); }
  for (const row of rollups) { const b = bucket(row.task_id); if (b) b.rollupInput += Number(row.total_input_tokens || 0); }
  const providers = [...new Set(events.filter((e) => bucket(e.task_id)).map((e) => `${e.provider_id || '?'}/${e.model_id || '?'}`))];
  return { providers, bySession };
}

/**
 * @description Render the measurement for the recall/cache architecture note.
 * @param {object} result - The case result.
 * @param {{date: string, commit?: string}} meta - When (ISO day/time) and which core it ran on.
 * @returns {string} The Markdown block, markers included.
 */
function renderMeasurementBlock(result, meta) {
  const rows = (result.evidence.conversations || []).map((m, i) => {
    const c = m.calls[0] || {};
    const cell = (v) => (v === undefined || v === null ? '-' : String(v));
    return `| ${i + 1} | ${cell(m.answerSeconds)} | ${m.calls.length} | ${cell(c.state)} | ${cell(c.input)} | ${cell(c.cached)} | ${cell(c.output)} | ${cell(c.latencyMs)} | ${cell(m.ledgerInput)} | ${cell(m.rollupInput)} |`;
  });
  return [DOC_START,
    `**Live measurement (${meta.date}${meta.commit ? `, core ${meta.commit}` : ''}; \`node scripts/operations/live-acceptance.js ${KEY} --record-doc\`).** `
      + `${String(result.state).toUpperCase()}: ${result.detail}`,
    '',
    '| Conversation | Answer (s) | Calls | Cache state (first call) | Input | Cached | Output | Call latency (ms) | Ledger input | chat_tasks input |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    DOC_END].join('\n');
}

/**
 * @description Put the block between the markers of the note (the markers must already be there).
 * @param {string} doc - The note's text.
 * @param {string} block - The rendered block (markers included).
 * @returns {string} The updated note.
 * @throws {Error} When the note carries no marker pair.
 */
function writeMeasurement(doc, block) {
  const start = doc.indexOf(DOC_START);
  const end = doc.indexOf(DOC_END);
  if (start < 0 || end < start) throw new Error('the note carries no live-acceptance:jarvis-prompt-cache marker pair');
  return `${doc.slice(0, start)}${block}${doc.slice(end + DOC_END.length)}`;
}

/**
 * @description Run the measurement once.
 * @param {object} ports - api, sql, logs, workspace, ownerSub.
 * @param {object} [options] - conversations, container, budget overrides; `tag` (tests only).
 * @returns {Promise<object>} The result with its cleanup receipt.
 */
async function run(ports, options = {}) {
  const missing = common.missingPorts(ports, NEEDS);
  if (missing.length) return common.unavailable(CASE_ID, `This runner has no ${missing.join('/')} port (the call log is read from the host); run node scripts/operations/live-acceptance.js ${KEY}.`);
  const io = common.withClock(ports);
  const budgets = common.budgetsFrom(DEFAULTS, options);
  const container = /^[\w.-]+$/.test(String(options.container || '')) ? options.container : DEFAULT_CONTAINER;
  const tag = options.tag || common.mintTag(KEY);
  const ledger = new common.CleanupLedger();
  const measured = [];
  const runStart = io.now();
  let verdict;
  try {
    for (let i = 1; i <= Math.min(10, budgets.conversations); i += 1) measured.push(await measureConversation(io, `${tag}-${i}`, budgets, container, ledger));
    const usage = await readUsage(io, tag, runStart);
    for (const m of measured) Object.assign(m, usage.bySession[m.sessionId] || { ledgerInput: 0, rollupInput: 0 });
    ledger.kept('cost-ledger', tag, 'oshal_cost_events rows and chat_tasks usage rollups record real spend');
    verdict = judgeMeasurement(measured, usage);
  } catch (error) {
    verdict = { state: 'fail', detail: `The case crashed: ${common.errorText(error)}` };
  }
  await thread.closeConversations(io, measured, ledger);
  return common.finish(CASE_ID, { state: verdict.state, detail: `${verdict.detail}.` }, ledger, { container, conversations: measured });
}

module.exports = { CASE_ID, KEY, TITLE, NEEDS, QUESTION, CALL_RE, DOC_START, DOC_END, parseCallLines, judgeMeasurement, renderMeasurementBlock, writeMeasurement, run };
