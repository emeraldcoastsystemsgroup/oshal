/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Standalone foreign A2A agent for the Plan F done-when proof. DELIBERATELY NOT OSHAL code — zero repo imports, zero npm deps, only Node built-ins (node:http, node:crypto). That independence IS the proof: it implements the Linux-Foundation A2A surface a third party would (well-known agent card, JSON-RPC 2.0 message/send + tasks/get + tasks/cancel) and does REAL deterministic work on the delegated task — word/line/char counts, a sha256 checksum, sorted unique tokens, and top-level JSON key sorting when the input carries a JSON block — then reports honest usage metadata so OSHAL's outbound harness can attribute real cost. Run: node tools/a2a-sample-agent/server.js --port 41241
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const AGENT_CARD_PATH = '/.well-known/agent-card.json';
const PROTOCOL_VERSION = '0.3.0';
// Deterministic synthetic per-token price so the "cost" this agent reports is a real,
// reproducible number the OSHAL harness can attribute — not a fabricated OSHAL estimate.
const USD_PER_TOKEN = 0.000002;

/** In-memory task store: taskId -> the fully-computed spec Task object. */
const tasks = new Map();

/**
 * @description Parses `--port <n>` (or `--port=<n>`) from argv.
 * @param {string[]} argv - process.argv.slice(2).
 * @returns {number} The chosen port (default 41241).
 */
function parsePort(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port' && argv[i + 1]) return Number(argv[i + 1]) || 41241;
    const inline = /^--port=(\d+)$/.exec(argv[i]);
    if (inline) return Number(inline[1]);
  }
  return 41241;
}

/**
 * @description Concatenates the text of an A2A message parts[] array.
 * @param {Array<object>} parts - Spec message parts.
 * @returns {string} The joined text of every text part.
 */
function textFromParts(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && (p.kind === 'text' || p.type === 'text') && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

/**
 * @description The REAL work: deterministic text analytics over the delegated task.
 * Nothing here echoes the input — every field is a computed measurement or transform.
 * @param {string} text - The delegated task text.
 * @returns {{ analysis: object, usage: object }} The computed analysis + honest usage.
 */
function analyze(text) {
  const words = (text.match(/[A-Za-z0-9]+/g) || []).map((w) => w.toLowerCase());
  const sortedUniqueWords = [...new Set(words)].sort();
  const analysis = {
    charCount: text.length,
    wordCount: words.length,
    lineCount: text.split(/\r\n|\r|\n/).length,
    sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    uniqueWordCount: sortedUniqueWords.length,
    sortedUniqueWords: sortedUniqueWords.slice(0, 200),
    jsonTopLevelKeysSorted: extractSortedJsonKeys(text),
  };
  const inputTokens = words.length;
  const outputTokens = sortedUniqueWords.length;
  const usage = {
    inputTokens,
    outputTokens,
    totalCostUsd: Number(((inputTokens + outputTokens) * USD_PER_TOKEN).toFixed(6)),
  };
  return { analysis, usage };
}

/**
 * @description If the text contains a JSON object, returns its top-level keys sorted;
 * otherwise null. Real structure work, not an echo.
 * @param {string} text - The delegated task text.
 * @returns {string[]|null} Sorted top-level keys, or null when no parseable object.
 */
function extractSortedJsonKeys(text) {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed).sort();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * @description Builds this agent's public A2A card — what a third-party discovery client
 * fetches to learn the endpoint, transport, and skill.
 * @param {string} baseUrl - The reachable base URL (scheme+host).
 * @returns {object} The spec AgentCard.
 */
function buildCard(baseUrl) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    name: 'A2A Sample Analytics Agent',
    description: 'Independent (non-OSHAL) A2A agent that computes deterministic text analytics for a delegated task.',
    url: `${baseUrl}/a2a`,
    preferredTransport: 'JSONRPC',
    version: '1.0.0',
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['application/json'],
    skills: [{
      id: 'text-analytics',
      name: 'Text Analytics',
      description: 'Word/line/char counts, sha256 checksum, sorted unique tokens, JSON key sorting.',
      tags: ['analytics', 'checksum', 'deterministic'],
    }],
  };
}

/**
 * @description Handles message/send: computes the analysis NOW, stores the finished task
 * as 'working' (so a client exercises tasks/get), and returns the task handle. The
 * artifact + usage are already computed and cached — tasks/get flips it to 'completed'.
 * @param {object} params - JSON-RPC params ({ message: { parts } }).
 * @returns {object} The spec Task in state 'working'.
 */
function handleMessageSend(params) {
  const message = (params && params.message) || {};
  const text = textFromParts(message.parts);
  const taskId = crypto.randomUUID();
  const contextId = message.contextId || crypto.randomUUID();
  const { analysis, usage } = analyze(text);
  const completed = {
    id: taskId,
    contextId,
    kind: 'task',
    status: { state: 'completed', timestamp: new Date().toISOString() },
    artifacts: [{
      artifactId: `analysis-${taskId}`,
      name: 'text-analysis',
      parts: [{ kind: 'text', text: JSON.stringify(analysis) }],
    }],
    metadata: { usage },
  };
  tasks.set(taskId, completed);
  return { id: taskId, contextId, kind: 'task', status: { state: 'working', timestamp: new Date().toISOString() } };
}

/**
 * @description Handles tasks/get: returns the stored, completed task (with artifacts +
 * usage) for a known id, or a JSON-RPC -32001 for an unknown one.
 * @param {object} params - JSON-RPC params ({ id }).
 * @returns {{ result?: object, error?: object }} The RPC result or error.
 */
function handleTasksGet(params) {
  const task = tasks.get(params && params.id);
  if (!task) return { error: { code: -32001, message: `Task not found: ${params && params.id}` } };
  return { result: task };
}

/**
 * @description Handles tasks/cancel: marks a known task canceled, else -32001.
 * @param {object} params - JSON-RPC params ({ id }).
 * @returns {{ result?: object, error?: object }} The RPC result or error.
 */
function handleTasksCancel(params) {
  const task = tasks.get(params && params.id);
  if (!task) return { error: { code: -32001, message: `Task not found: ${params && params.id}` } };
  const canceled = { ...task, status: { state: 'canceled', timestamp: new Date().toISOString() } };
  tasks.set(task.id, canceled);
  return { result: canceled };
}

/**
 * @description Dispatches one parsed JSON-RPC request to the right handler.
 * @param {object} body - The parsed JSON-RPC request.
 * @returns {object} The JSON-RPC response envelope.
 */
function dispatchRpc(body) {
  const id = body && body.id !== undefined ? body.id : null;
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC request' } };
  }
  const params = body.params || {};
  let outcome;
  if (body.method === 'message/send') outcome = { result: handleMessageSend(params) };
  else if (body.method === 'tasks/get') outcome = handleTasksGet(params);
  else if (body.method === 'tasks/cancel') outcome = handleTasksCancel(params);
  else outcome = { error: { code: -32601, message: `Method not found: ${body.method}` } };
  return { jsonrpc: '2.0', id, ...outcome };
}

/**
 * @description Reads and JSON-parses the full request body.
 * @param {import('node:http').IncomingMessage} req - The request.
 * @returns {Promise<object>} The parsed body ({} on empty/invalid).
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({ __parseError: true }); }
    });
  });
}

/**
 * @description The HTTP server: GET well-known card, POST anything → JSON-RPC.
 * @param {import('node:http').IncomingMessage} req - The request.
 * @param {import('node:http').ServerResponse} res - The response.
 * @returns {Promise<void>} Resolves when the response is written.
 */
async function handle(req, res) {
  const baseUrl = `http://${req.headers.host || 'localhost'}`;
  if (req.method === 'GET' && req.url && req.url.startsWith(AGENT_CARD_PATH)) {
    return sendJson(res, 200, buildCard(baseUrl));
  }
  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    if (body.__parseError) {
      return sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    return sendJson(res, 200, dispatchRpc(body));
  }
  return sendJson(res, 404, { error: 'not_found' });
}

/**
 * @description Serializes and writes a JSON response.
 * @param {import('node:http').ServerResponse} res - The response.
 * @param {number} status - HTTP status.
 * @param {object} payload - The body to serialize.
 * @returns {void}
 */
function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

const port = parsePort(process.argv.slice(2));
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    sendJson(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: String(err && err.message) } });
  });
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`a2a-sample-agent listening on http://127.0.0.1:${port} (card ${AGENT_CARD_PATH}, rpc /a2a)\n`);
});

module.exports = { analyze, buildCard, dispatchRpc, parsePort };
