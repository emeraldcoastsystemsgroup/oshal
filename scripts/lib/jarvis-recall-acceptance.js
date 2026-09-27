/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the Jarvis cross-conversation recall acceptance case, written once and driven twice: by the signed-in Test Lab step (src/app/routes/test-lab-jarvis-recall.ts) and by the operator-PAT live proof (scripts/operations/jarvis-recall-live-proof.js). It seeds one uniquely tagged owner-bound thread holding a random codeword through the real task and message stores, asks for that codeword from a NEW thread through the real /api/jarvis/ask route without repeating it, requires the answer to carry it, requires the owner-scoped Token Chase capture of that ask to show conversation_query and/or conversation_fetch actually ran for this caller, and then deletes exactly the two threads, their messages, the chat ticket and the ask's workspace. An incomplete cleanup is a red result.
 */

'use strict';

// Lives in scripts/lib so the api image carries it (Dockerfile.oshal COPY scripts/lib/*.js) and the
// Test Lab step can require it, while the live proof can stage it into a running container that
// predates the step. No dependency beyond node built-ins: every product boundary is a port.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Test Lab scenario id and the case name every result line carries. */
const CASE_ID = 'jarvis-cross-thread-recall';
/** Every id this case mints; cleanup refuses to touch anything that does not match. */
const FIXTURE_ID_RE = /^testlab-recall-[ab]-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
/** The codeword shape; matched case-insensitively so markdown or casing never hides it. */
const CODEWORD_RE = /TESTLAB-RECALL-[0-9A-F]{8}/gi;
/** Runtime tool names of the two recall tools (bot-node-read-only-tools.ts) and their short labels. */
const RECALL_TOOLS = Object.freeze({ conversation_query: 'query', conversation_fetch: 'fetch' });
/** Budgets, overridable per run. The answer budget sits above Jarvis's own decision timeout. */
const DEFAULT_BUDGETS = Object.freeze({ answerBudgetMs: 120_000, settleBudgetMs: 180_000, pollMs: 3_000 });
/** The Token Chase capture directory and its end-of-run record, as the capture lane writes them. */
const CAPTURE_DIR = '.tokenchase';
const FINAL_FILE = 'final.json';

/**
 * Owner-scoped residue of one run. chat_messages needs no owner predicate: it cascades from
 * chat_tasks and its row policy already walls it to the task owner.
 */
const RESIDUE_SQL = `SELECT
    (SELECT count(*) FROM chat_tasks WHERE owner_sub = $1 AND task_id = ANY($2::text[]))::int AS chat_tasks,
    (SELECT count(*) FROM chat_messages WHERE task_id = ANY($2::text[]))::int AS chat_messages,
    (SELECT count(*) FROM tickets WHERE owner_sub = $1 AND ticket_type = 'chat'
        AND metadata->>'taskId' = ANY($2::text[]))::int AS chat_tickets,
    (SELECT count(*) FROM jarvis_tasks WHERE user_sub = $1 AND session_id = ANY($2::text[]))::int AS work_items`;

/**
 * @description Mint one run's fixture: two thread ids, a drill label that names thread A, and a
 * codeword that appears ONLY inside thread A's messages. The question for thread B names the drill,
 * never the codeword, so the only way to answer is to read the other conversation.
 * @param {() => string} [uuid] - UUID source (injectable for tests).
 * @param {(n: number) => Buffer} [bytes] - Random byte source (injectable for tests).
 * @returns {{id: string, threadA: string, threadB: string, marker: string, codeword: string, title: string,
 *   messages: Array<{role: 'user'|'assistant', text: string}>, question: string}} The fixture.
 */
function createRecallFixture(uuid = crypto.randomUUID, bytes = crypto.randomBytes) {
  const id = uuid();
  const drill = bytes(3).toString('hex');
  const codeword = `TESTLAB-RECALL-${bytes(4).toString('hex').toUpperCase()}`;
  const title = `Recall drill ${drill}`;
  return {
    id,
    threadA: `testlab-recall-a-${id}`,
    threadB: `testlab-recall-b-${id}`,
    marker: `test-lab-recall:${id}`,
    codeword,
    title,
    messages: [
      { role: 'user', text: `Please keep this for our recall drill ${drill}: the codeword is ${codeword}.` },
      { role: 'assistant', text: `Noted. The codeword for recall drill ${drill} is ${codeword}.` },
    ],
    question: `In a different conversation of mine, titled "${title}", I gave you a codeword. `
      + 'Which codeword was it? Look it up in that conversation and answer with the codeword itself.',
  };
}

/**
 * @description Every codeword-shaped token in a text, upper-cased, so a wrong codeword is told
 * apart from a missing one.
 * @param {unknown} text - An answer or frame body.
 * @returns {string[]} The distinct codewords found.
 */
function extractCodewords(text) {
  const found = String(text ?? '').match(CODEWORD_RE) || [];
  return [...new Set(found.map((word) => word.toUpperCase()))];
}

/**
 * @description Map a recorded tool name onto its recall label. Accepts the kebab-case catalog
 * spelling as well as the runtime name, and nothing else.
 * @param {unknown} name - A pin's tool name.
 * @returns {'query'|'fetch'|null} The label, or null for any other tool.
 */
function recallToolLabel(name) {
  const key = String(name ?? '').trim().toLowerCase().replace(/-/g, '_');
  return Object.prototype.hasOwnProperty.call(RECALL_TOOLS, key) ? RECALL_TOOLS[key] : null;
}

/**
 * @description Reduce the capture of one ask to what this case asserts: which recall tools ran
 * successfully, whether any frame belongs to someone else, and whether the model's own frames ever
 * wrote the codeword (the diagnostic that separates "never recalled" from "recalled too late").
 * @param {Array<{ownerSub?: string|null, pins?: unknown, responseContent?: unknown}>} frames - Frame details.
 * @param {string} ownerSub - The caller the capture must be stamped with.
 * @param {string} codeword - The fixture codeword.
 * @returns {{frames: number, query: number, fetch: number, failedRecall: number, foreignFrames: number,
 *   codewordInFrames: boolean}} The evidence summary.
 */
function summarizeToolEvidence(frames, ownerSub, codeword) {
  const summary = { frames: 0, query: 0, fetch: 0, failedRecall: 0, foreignFrames: 0, codewordInFrames: false };
  for (const frame of Array.isArray(frames) ? frames : []) {
    summary.frames += 1;
    if (frame.ownerSub !== ownerSub) summary.foreignFrames += 1;
    if (extractCodewords(frame.responseContent).includes(codeword)) summary.codewordInFrames = true;
    for (const pin of Array.isArray(frame.pins) ? frame.pins : []) {
      const label = recallToolLabel(pin && pin.tool);
      if (!label) continue;
      if (pin.success === true) summary[label] += 1;
      else summary.failedRecall += 1;
    }
  }
  return summary;
}

/**
 * @description Owner-scoped counts of everything one run can leave behind.
 * @param {object} ports - The run's ports (query, withOwner, ownerSub).
 * @param {string[]} taskIds - The run's thread ids.
 * @returns {Promise<{chatTasks: number, chatMessages: number, chatTickets: number, workItems: number}>} Counts.
 */
async function readResidue(ports, taskIds) {
  const { rows } = await ports.withOwner(() => ports.query(RESIDUE_SQL, [ports.ownerSub, taskIds]));
  const row = rows[0] || {};
  return {
    chatTasks: Number(row.chat_tasks || 0),
    chatMessages: Number(row.chat_messages || 0),
    chatTickets: Number(row.chat_tickets || 0),
    workItems: Number(row.work_items || 0),
  };
}

/**
 * @description Write thread A through the REAL task and message stores, exactly as a Jarvis turn
 * persists (persistJarvisTurn's message shape, ensureSessionTask's task shape), then prove it is
 * durable in PostgreSQL. A store that fell back to memory would otherwise "seed" nothing the bot
 * can ever find.
 * @param {object} ports - taskStore, messageStore, withOwner, ownerSub, agentId, threadMetadata, query.
 * @param {ReturnType<typeof createRecallFixture>} fixture - The run's fixture.
 * @returns {Promise<void>} Resolves once the durable read-back matches.
 */
async function seedRecallThread(ports, fixture) {
  await ports.withOwner(async () => {
    const created = await ports.taskStore.create({
      taskId: fixture.threadA, title: fixture.title, processingMode: 'agentic',
      ...(ports.agentId ? { agentId: ports.agentId } : {}), ownerSub: ports.ownerSub,
      metadata: { ...(ports.threadMetadata || {}), origin: 'jarvis-chat', testLabFixture: fixture.marker },
    });
    if (!created || created.ownerSub !== ports.ownerSub || (created.metadata || {}).testLabFixture !== fixture.marker) {
      throw new Error('The task store did not create the exact owner-bound fixture thread.');
    }
    for (const message of fixture.messages) {
      await ports.messageStore.save({
        taskId: fixture.threadA, role: message.role, type: message.role === 'user' ? 'task' : 'say',
        text: message.text, contentBlocks: [], metadata: { testLabFixture: fixture.marker },
      });
    }
  });
  const residue = await readResidue(ports, [fixture.threadA]);
  if (residue.chatTasks !== 1 || residue.chatMessages !== fixture.messages.length) {
    throw new Error(`The fixture thread is not durable in PostgreSQL (tasks=${residue.chatTasks}, messages=${residue.chatMessages}).`);
  }
}

/**
 * Poll answers that are not final. `expired` is also what /ask/result answers when its session read
 * cannot reach PostgreSQL for a moment (seen live: a pool connect timeout mid-ask), so it is retried
 * until the budget ends like a server error or a dropped request - only `done` and `error` settle.
 */
const RETRYABLE_POLL = /^(pending|expired|HTTP 5\d\d|request failed)$/;

/**
 * @description Poll one ask until it settles (`done` / `error`) or the budget runs out.
 * @param {object} ports - api, sleep, now.
 * @param {string} jobId - The ask's job id.
 * @param {{answerBudgetMs: number, pollMs: number}} budgets - Budgets.
 * @returns {Promise<{status: string, answer: string, error: string|null, elapsedMs: number}>} The settled job.
 */
async function pollAnswer(ports, jobId, budgets) {
  const started = ports.now();
  let last = { status: 'pending', answer: '', error: null };
  while (ports.now() - started < budgets.answerBudgetMs) {
    await ports.sleep(budgets.pollMs);
    const poll = await ports.api('GET', `/api/jarvis/ask/result?jobId=${encodeURIComponent(jobId)}`)
      .catch((error) => ({ status: 0, json: { error: error instanceof Error ? error.message : String(error) } }));
    const status = poll.status === 200 ? String(poll.json.status || 'unknown') : poll.status ? `HTTP ${poll.status}` : 'request failed';
    last = { status, answer: typeof poll.json.answer === 'string' ? poll.json.answer : '', error: poll.json.error ?? null };
    if (!RETRYABLE_POLL.test(status)) break;
  }
  return { ...last, elapsedMs: ports.now() - started };
}

/**
 * @description Ask the recall question on thread B through the real route as the caller.
 * @param {object} ports - api, sleep, now.
 * @param {ReturnType<typeof createRecallFixture>} fixture - The run's fixture.
 * @param {object} budgets - Budgets.
 * @returns {Promise<{accepted: boolean, httpStatus: number, jobId: string|null, chatTicketId: string|null,
 *   status: string, answer: string, error: string|null, elapsedMs: number}>} The ask outcome.
 */
async function askRecallQuestion(ports, fixture, budgets) {
  const ask = await ports.api('POST', '/api/jarvis/ask', { message: fixture.question, sessionId: fixture.threadB });
  const jobId = typeof ask.json.jobId === 'string' ? ask.json.jobId : null;
  const chatTicketId = typeof ask.json.chatTicketId === 'string' ? ask.json.chatTicketId : null;
  if (ask.status !== 202 || !jobId || ask.json.sessionId !== fixture.threadB) {
    return { accepted: false, httpStatus: ask.status, jobId, chatTicketId, status: 'refused',
      answer: '', error: String(ask.json.error ?? 'no jobId'), elapsedMs: 0 };
  }
  const settled = await pollAnswer(ports, jobId, budgets);
  return { accepted: true, httpStatus: ask.status, jobId, chatTicketId, ...settled };
}

/**
 * @description The ask's workspace directory, only when it is exactly <root>/<thread B id>.
 * @param {object} ports - workspaceRoot.
 * @param {string} threadB - The thread B id.
 * @returns {string|null} The directory, or null when no root is known or the id is not a fixture id.
 */
function workspaceDirFor(ports, threadB) {
  if (!ports.workspaceRoot || !FIXTURE_ID_RE.test(threadB)) return null;
  const root = path.resolve(ports.workspaceRoot);
  const dir = path.resolve(root, threadB);
  return path.dirname(dir) === root && path.basename(dir) === threadB ? dir : null;
}

/**
 * @description Wait (bounded) until the bot finished the ask: its capture wrote final.json. The bot
 * keeps running after Jarvis's decision timeout answers the caller, so both the evidence read and
 * the workspace removal have to wait for this or they race the writer.
 * @param {object} ports - workspaceRoot, sleep, now.
 * @param {string} threadB - The thread B id.
 * @param {object} budgets - settleBudgetMs, pollMs.
 * @returns {Promise<'final'|'no-capture'|'still-running'>} Why the wait ended.
 */
async function waitForBotFinish(ports, threadB, budgets) {
  const dir = workspaceDirFor(ports, threadB);
  if (!dir) return 'no-capture';
  const started = ports.now();
  while (ports.now() - started < budgets.settleBudgetMs) {
    if (fs.existsSync(path.join(dir, CAPTURE_DIR, FINAL_FILE))) return 'final';
    await ports.sleep(budgets.pollMs);
  }
  return fs.existsSync(path.join(dir, CAPTURE_DIR)) ? 'still-running' : 'no-capture';
}

/**
 * @description Read the ask's capture through the owner-scoped Token Chase routes, as the caller:
 * the run's frames, then each frame's pins (the tool calls executed before it) and recorded owner.
 * @param {object} ports - api.
 * @param {string} threadB - The thread B id (the capture's run id).
 * @returns {Promise<Array<{seq: number, ownerSub: string|null, pins: unknown[], responseContent: string|null}>>} Frames.
 */
async function readCapturedFrames(ports, threadB) {
  const run = await ports.api('GET', `/api/token-chase/runs/${encodeURIComponent(threadB)}`);
  if (run.status !== 200 || !Array.isArray(run.json.frames)) return [];
  const frames = [];
  for (const summary of run.json.frames) {
    const seq = Number(summary && summary.seq);
    if (!Number.isInteger(seq) || seq < 0) continue;
    const detail = await ports.api('GET', `/api/token-chase/runs/${encodeURIComponent(threadB)}/frames/${seq}`);
    // GET /runs/:runId/frames/:seq answers { frame: TokenChaseFrameDetail } (token-chase-routes.ts).
    const frame = detail.status === 200 && detail.json.frame && typeof detail.json.frame === 'object' ? detail.json.frame : null;
    if (!frame) continue;
    frames.push({ seq, ownerSub: frame.ownerSub ?? null, pins: Array.isArray(frame.pins) ? frame.pins : [],
      responseContent: typeof frame.responseContent === 'string' ? frame.responseContent : null });
  }
  return frames;
}

/**
 * @description Remove the ask's workspace (its Token Chase capture included) after re-checking that
 * every captured frame was stamped with this caller. Never touches a directory it did not derive
 * from its own fixture id.
 * @param {object} ports - workspaceRoot, ownerSub.
 * @param {string} threadB - The thread B id.
 * @returns {string|null} An error sentence, or null when removed or never created.
 */
function removeAskWorkspace(ports, threadB) {
  const dir = workspaceDirFor(ports, threadB);
  if (!dir || !fs.existsSync(dir)) return null;
  const capture = path.join(dir, CAPTURE_DIR);
  const frames = fs.existsSync(capture) ? fs.readdirSync(capture).filter((name) => /^frame-\d+\.json$/.test(name)) : [];
  for (const name of frames) {
    const owner = JSON.parse(fs.readFileSync(path.join(capture, name), 'utf8')).userSub ?? null;
    if (owner !== ports.ownerSub) return `workspace ${threadB} holds a frame stamped for another owner; not removed`;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return fs.existsSync(dir) ? `workspace ${threadB} still exists after removal` : null;
}

/**
 * @description Run one cleanup call and turn a non-2xx answer into an error sentence.
 * @param {object} ports - api.
 * @param {string} method - HTTP method.
 * @param {string} route - API path.
 * @param {unknown} body - JSON body or undefined.
 * @param {number[]} [okStatuses] - Statuses that count as done (404 = already gone).
 * @returns {Promise<string|null>} An error sentence, or null.
 */
async function cleanupCall(ports, method, route, body, okStatuses = [200, 204, 404]) {
  try {
    const result = await ports.api(method, route, body);
    return okStatuses.includes(result.status) ? null : `${method} ${route} returned HTTP ${result.status}`;
  } catch (error) {
    return `${method} ${route} failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * @description Delete exactly what the run created, through the same owner-scoped routes a user
 * would use, then prove it from the database: both threads, their messages, the chat ticket, the
 * ask job and the ask's workspace. Anything left is returned as an error sentence.
 * @param {object} ports - The run's ports.
 * @param {ReturnType<typeof createRecallFixture>} fixture - The run's fixture.
 * @param {{accepted: boolean, jobId: string|null, chatTicketId: string|null}|null} ask - The ask outcome.
 * @param {'final'|'no-capture'|'still-running'|null} finish - Whether the bot finished.
 * @returns {Promise<string[]>} Cleanup errors; empty means everything is gone.
 */
async function cleanUpRecallCase(ports, fixture, ask, finish) {
  const errors = [];
  const push = (error) => { if (error) errors.push(error); };
  if (ask && ask.accepted) {
    push(await cleanupCall(ports, 'POST', '/api/jarvis/thread/close', { sessionId: fixture.threadB }, [200]));
    if (ask.chatTicketId) push(await cleanupCall(ports, 'DELETE', `/api/tickets/${encodeURIComponent(ask.chatTicketId)}`));
    push(await cleanupCall(ports, 'DELETE', `/api/tasks/${encodeURIComponent(fixture.threadB)}`));
    if (ask.jobId) push(await cleanupCall(ports, 'POST', '/api/jarvis/ask/dismiss', { jobId: ask.jobId }, [200]));
  }
  push(await cleanupCall(ports, 'DELETE', `/api/tasks/${encodeURIComponent(fixture.threadA)}`));
  if (finish === 'still-running') push(`the bot was still writing ${fixture.threadB}'s workspace; it was left for a later cleanup`);
  else {
    try { push(removeAskWorkspace(ports, fixture.threadB)); } catch (error) {
      push(`workspace removal failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    const residue = await readResidue(ports, [fixture.threadA, fixture.threadB]);
    const left = Object.entries(residue).filter(([, count]) => count > 0).map(([name, count]) => `${name}=${count}`);
    if (left.length) push(`residue remains for ${fixture.threadA}/${fixture.threadB}: ${left.join(', ')}`);
  } catch (error) {
    push(`residue check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return errors;
}

/**
 * @description Decide the verdict from the ask outcome and the capture evidence.
 * @param {ReturnType<typeof createRecallFixture>} fixture - The run's fixture.
 * @param {object} ask - The ask outcome.
 * @param {ReturnType<typeof summarizeToolEvidence>} evidence - The capture summary.
 * @param {string} finish - Why the bot-finish wait ended.
 * @returns {{state: 'pass'|'fail'|'degraded', detail: string}} The verdict before cleanup.
 */
function decideVerdict(fixture, ask, evidence, finish) {
  if (!ask.accepted) return { state: 'fail', detail: `POST /api/jarvis/ask refused the new thread: HTTP ${ask.httpStatus} ${ask.error}.` };
  const said = extractCodewords(ask.answer);
  const toolLine = `recall tools: conversation_query x${evidence.query}, conversation_fetch x${evidence.fetch}`
    + ` over ${evidence.frames} captured frame(s)`;
  if (ask.status !== 'done' || !said.includes(fixture.codeword)) {
    const late = evidence.codewordInFrames ? ' The bot\'s own captured frames DID write the codeword, after the answer had already been returned.' : '';
    const wrong = said.length ? ` It named ${said.join(', ')} instead.` : '';
    return { state: 'fail', detail: `Jarvis did not answer with the other thread's codeword (status=${ask.status}, `
      + `${Math.round(ask.elapsedMs / 1000)}s).${wrong} Answer began: "${ask.answer.slice(0, 200)}". ${toolLine}.${late}` };
  }
  if (evidence.foreignFrames) return { state: 'fail', detail: `The capture of this ask holds ${evidence.foreignFrames} frame(s) stamped for another owner.` };
  if (evidence.query + evidence.fetch > 0) {
    return { state: 'pass', detail: `Jarvis answered with the other thread's codeword in ${Math.round(ask.elapsedMs / 1000)}s; ${toolLine}, all stamped for this caller.` };
  }
  if (!evidence.frames) {
    return { state: 'degraded', detail: `Jarvis answered with the codeword, but the ask left no Token Chase capture (${finish}), so tool use cannot be proven on this deployment.` };
  }
  return { state: 'fail', detail: `Jarvis answered with the codeword but the capture shows no successful recall tool call (${toolLine}).` };
}

/**
 * @description Run the whole case once. Seeding, asking and evidence can each fail; cleanup always
 * runs after anything was written, and a cleanup miss turns any verdict red.
 * @param {object} ports - api, ownerSub, taskStore, messageStore, query, withOwner, agentId?,
 *   threadMetadata?, workspaceRoot?, sleep?, now?.
 * @param {Partial<typeof DEFAULT_BUDGETS> & {fixture?: ReturnType<typeof createRecallFixture>}} [options] - Budgets / fixture.
 * @returns {Promise<{caseId: string, state: 'pass'|'fail'|'degraded', detail: string, evidence: object}>} The result.
 */
async function runJarvisRecallAcceptance(ports, options = {}) {
  const io = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: () => Date.now(), ...ports };
  const budgets = { ...DEFAULT_BUDGETS, ...pickBudgets(options) };
  const fixture = options.fixture || createRecallFixture();
  const ids = [fixture.threadA, fixture.threadB];
  let verdict = { state: 'fail', detail: 'The case did not finish.' };
  let ask = null;
  let finish = null;
  let evidence = summarizeToolEvidence([], io.ownerSub, fixture.codeword);
  let wrote = false;
  try {
    const before = await readResidue(io, ids);
    if (Object.values(before).some((count) => count > 0)) throw new Error('The generated thread ids are already occupied.');
    wrote = true;
    await seedRecallThread(io, fixture);
    ask = await askRecallQuestion(io, fixture, budgets);
    finish = ask.accepted ? await waitForBotFinish(io, fixture.threadB, budgets) : null;
    if (ask.accepted) evidence = summarizeToolEvidence(await readCapturedFrames(io, fixture.threadB), io.ownerSub, fixture.codeword);
    verdict = decideVerdict(fixture, ask, evidence, finish);
  } catch (error) {
    verdict = { state: 'fail', detail: error instanceof Error ? error.message : String(error) };
  }
  const cleanupErrors = wrote ? await cleanUpRecallCase(io, fixture, ask, finish) : [];
  const detail = cleanupErrors.length ? `${verdict.detail} CLEANUP INCOMPLETE: ${cleanupErrors.join('; ')}.`
    : `${verdict.detail}${wrote ? ' Both threads, their messages, the chat ticket and the ask workspace were removed.' : ''}`;
  return { caseId: CASE_ID, state: cleanupErrors.length ? 'fail' : verdict.state, detail,
    evidence: { threadA: fixture.threadA, threadB: fixture.threadB, answerSeconds: ask ? Math.round(ask.elapsedMs / 1000) : null,
      askStatus: ask ? ask.status : null, botFinish: finish, ...evidence, cleanupErrors } };
}

/**
 * @description Keep only numeric, positive budget overrides.
 * @param {object} options - Caller options.
 * @returns {Partial<typeof DEFAULT_BUDGETS>} The accepted overrides.
 */
function pickBudgets(options) {
  const picked = {};
  for (const key of Object.keys(DEFAULT_BUDGETS)) {
    const value = Number(options[key]);
    if (Number.isFinite(value) && value > 0) picked[key] = value;
  }
  return picked;
}

module.exports = {
  CASE_ID,
  FIXTURE_ID_RE,
  RECALL_TOOLS,
  DEFAULT_BUDGETS,
  RESIDUE_SQL,
  createRecallFixture,
  extractCodewords,
  recallToolLabel,
  summarizeToolEvidence,
  readResidue,
  seedRecallThread,
  askRecallQuestion,
  readCapturedFrames,
  cleanUpRecallCase,
  decideVerdict,
  runJarvisRecallAcceptance,
};
