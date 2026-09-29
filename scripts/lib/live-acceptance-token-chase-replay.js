/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for "Workspace-bound checkpoint and tail replay" (ADR-046), the replay the read-only token-chase-checkpoint-replay card never fires. Three legs over the real controller route POST /api/token-chase/runs/<runId>/tail-replay, which delegates to the bot node that produced the run. (a) Reproduced: the newest captured run visible to the caller whose frames consumed only workspace file-tool results (every pin workspace-read/workspace-write and pinned, at least one write, a completed final checkpoint), replayed from its first frame, must come back `reproduced` with artifacts.reproduced true, no differing path, replayTreeSha equal to final.checkpoint.treeSha (read independently through GET .../final) and no paid call; when no such run exists the case starts one tagged run on a file-tool-capable bot through POST /api/tasks/<tag>/messages, waits for its capture, replays it and removes it (chat task, ticket if any, ask workspace, residue read as zero). (b) Live-read: a separate captured run whose tail consumed a live-read or side-effect result must, replayed from its first frame, stop at the frame that CALLED the tool with frame status `live-tool` and every earlier frame `reproduced`, and replayed from the consuming frame answer `non-replayable`. (c) `--expect-store-bound` (host runner) also requires a store-bound run and storeVersion {bound:true, reproduced:true}; without the flag the store verdict is evidence only. A leg with no suitable run is UNAVAILABLE naming what would produce one (TOKEN_CHASE_CAPTURE, a bot with file tools, a conversation that reads live data, TOKEN_CHASE_OWNER_STORE_SNAPSHOT=on), never a pass; a run whose bot has no reachable node is UNAVAILABLE naming the bot.
 */

'use strict';

const common = require('./live-acceptance-common.js');

const CASE_ID = 'token-chase-tail-replay-live';
const KEY = 'token-chase-replay';
const TITLE = 'Token Chase tail replay: a file-tools run reproduced on its bot node, a live-read run stopped before the live tool';
const NEEDS = Object.freeze(['api', 'sql', 'workspace', 'ownerSub']);
const BASE = '/api/token-chase';
/** Replay classes the hermetic tail re-executes from the checkpoint; a file-tools-only run has only these. */
const FILE_CLASSES = Object.freeze(['workspace-read', 'workspace-write']);
/** Replay classes the hermetic tail refuses before running anything. */
const LIVE_CLASSES = Object.freeze(['live-read', 'side-effect']);
/** How far the scan of captured runs goes: runs newest first, frames per run (each frame is one detail read). */
const SCAN = Object.freeze({ maxRuns: 30, maxFrames: 12 });
/** Bounds: how long a started run may keep writing after its turn was cut off by the HTTP ceiling, and how long a
 *  capture may take to close after the turn answered (the capture writer runs off the call path). */
const DEFAULT_BUDGETS = Object.freeze({ settleBudgetMs: 300_000, captureGraceMs: 30_000, pollMs: 3_000 });
/** The bot a started run goes to, by registry name; the host runner's environment may name another. */
const AGENT_ENV = 'OSHAL_VERIFY_TOKEN_CHASE_AGENT';
const DEFAULT_AGENT = 'general-bot';
/** The artifact a started run writes and reads back, so its tail has a workspace-write and a workspace-read. */
const ARTIFACT_FILE = 'replay-check.txt';
/** The stop reason the controller reports when the producing bot has no reachable node. */
const NO_ENDPOINT_RE = /No reachable bot node/i;
/** What produces a live-read run when none is captured. */
const LIVE_RUN_STEP = 'one conversation whose bot reads live data (for example a Jarvis conversation that searches other conversations) captures one';
/** What produces a store-bound run when none is captured. */
const STORE_BOUND_STEP = 'set TOKEN_CHASE_OWNER_STORE_SNAPSHOT=on on that bot\'s node, recreate it, and capture one run there';

/**
 * @description The turn a started run asks for: write one file, read it back, finish; no other tool.
 * @param {string} tag - The run's fixture tag (also its task id and the file's content).
 * @returns {string} The message.
 */
function runPrompt(tag) {
  return `Test Lab run ${tag}. Using only your workspace file tools: call write_to_file to create ${ARTIFACT_FILE} in your `
    + `workspace containing exactly the line "${tag}", then call read_file on ${ARTIFACT_FILE}, then finish with attempt_completion `
    + 'quoting the file contents. Do not run any command, search, connector or other tool.';
}

/**
 * @description The pins a frame consumed, reduced to what classification needs.
 * @param {object} frame - A frame detail as GET .../frames/<seq> returns it.
 * @returns {Array<{tool: string, replayClass: string, pinned: boolean}>} The pins (none for a pre-pin frame).
 */
function pinsOf(frame) {
  const raw = Array.isArray(frame && frame.pins) ? frame.pins : [];
  return raw.map((pin) => ({ tool: String((pin && pin.tool) || '?'), replayClass: String((pin && pin.replayClass) || 'undeclared'), pinned: Boolean(pin && pin.pinned) }));
}

/**
 * @description Whether a pin is one the hermetic tail can re-execute (a file tool, pinned).
 * @param {{replayClass: string, pinned: boolean}} pin - The pin.
 * @returns {boolean} True for a pinned workspace-read or workspace-write.
 */
function isFilePin(pin) {
  return pin.pinned && FILE_CLASSES.includes(pin.replayClass);
}

/**
 * @description Whether a pin is a live result the tail must refuse.
 * @param {{replayClass: string, pinned: boolean}} pin - The pin.
 * @returns {boolean} True for live-read, side-effect, or anything unpinned.
 */
function isLivePin(pin) {
  return !pin.pinned || LIVE_CLASSES.includes(pin.replayClass);
}

/**
 * @description Classify one captured run for the legs: `file-only` (every consumed result a pinned file
 * tool, at least one write, a completed final checkpoint), `live` (the first live result consumed after a
 * file-only prefix; names the calling and consuming frames), else `other` with why.
 * @param {{frames: Array<{seq: number, phase: string, replayable: boolean, pins: object[]}>, final: object|null}} run - The run as readRun returns it.
 * @returns {{kind: 'file-only'|'live'|'other', reason: string|null, callingSeq?: number, consumingSeq?: number, liveTool?: string, tools?: string[]}} The classification.
 */
function classifyRun(run) {
  const frames = run.frames;
  if (!frames.length) return { kind: 'other', reason: 'no frame' };
  if (frames.some((f) => f.phase === 'open')) return { kind: 'other', reason: 'a frame is still open' };
  const tools = [];
  for (let i = 0; i < frames.length; i += 1) {
    for (const pin of frames[i].pins) {
      if (isLivePin(pin)) {
        if (i === 0) return { kind: 'other', reason: `frame ${frames[0].seq} consumed ${pin.tool} with no calling frame` };
        return { kind: 'live', reason: null, callingSeq: frames[i - 1].seq, consumingSeq: frames[i].seq, liveTool: pin.tool, liveClass: pin.replayClass, tools };
      }
      if (!isFilePin(pin)) return { kind: 'other', reason: `${pin.tool} is ${pin.replayClass}, neither a file tool nor live` };
      tools.push(pin.tool);
    }
  }
  const writes = frames.flatMap((f) => f.pins).filter((p) => p.replayClass === 'workspace-write').length;
  if (!writes) return { kind: 'other', reason: tools.length ? 'file reads only, nothing written' : 'no tool result consumed' };
  const final = run.final;
  if (!final) return { kind: 'other', reason: 'no final checkpoint' };
  if (final.outcome !== 'completed') return { kind: 'other', reason: `final outcome ${final.outcome}` };
  if (typeof final.treeSha !== 'string' || !final.treeSha) return { kind: 'other', reason: 'final checkpoint has no tree digest' };
  if (final.checkpointComplete !== true) return { kind: 'other', reason: 'final checkpoint is incomplete (bounded snapshot)' };
  return { kind: 'file-only', reason: null, tools };
}

/**
 * @description Read one run through the caller's own routes: its frame summaries, each frame's pins and
 * owner-facing fields, and its final checkpoint (null when the run has none).
 * @param {object} io - api.
 * @param {string} runId - The run.
 * @returns {Promise<{runId: string, frames: object[], final: object|null, skipped: string|null}>} The run, or why it was skipped.
 */
async function readRun(io, runId) {
  const list = await io.api('GET', `${BASE}/runs/${encodeURIComponent(runId)}`);
  const summaries = list.status === 200 && Array.isArray(list.json.frames) ? list.json.frames : [];
  if (!summaries.length) return { runId, frames: [], final: null, skipped: `GET ${BASE}/runs/<id> answered HTTP ${list.status} with no frame` };
  if (summaries.length > SCAN.maxFrames) return { runId, frames: [], final: null, skipped: `${summaries.length} frames, more than the ${SCAN.maxFrames} the scan reads` };
  const frames = [];
  for (const summary of [...summaries].sort((a, b) => Number(a.seq) - Number(b.seq))) {
    const detail = await io.api('GET', `${BASE}/runs/${encodeURIComponent(runId)}/frames/${Number(summary.seq)}`);
    const frame = detail.status === 200 && detail.json.frame ? detail.json.frame : null;
    if (!frame) return { runId, frames: [], final: null, skipped: `frame ${summary.seq} answered HTTP ${detail.status}` };
    frames.push({ seq: Number(frame.seq), phase: String(frame.phase || 'unknown'), replayable: frame.replayable !== false, agentId: frame.agentId || null,
      ownerStoreVersion: frame.ownerStoreVersion || null, pins: pinsOf(frame) });
  }
  const finalRes = await io.api('GET', `${BASE}/runs/${encodeURIComponent(runId)}/final`);
  const final = finalRes.status === 200 && finalRes.json.final ? finalRes.json.final : null;
  return { runId, frames, final, skipped: null };
}

/**
 * @description Scan the caller's captured runs, newest first, for the runs each leg needs.
 * @param {object} io - api.
 * @param {{storeBound: boolean}} want - Whether leg (c) needs a store-bound file-only run.
 * @returns {Promise<{fileOnly: object|null, fileOnlyUnbound: object|null, live: object|null, listed: number, scanned: number, listStatus: number, skipped: string[]}>} What was found.
 */
async function scanRuns(io, want) {
  const list = await io.api('GET', `${BASE}/runs`);
  const runs = list.status === 200 && Array.isArray(list.json.runs) ? list.json.runs : [];
  const found = { fileOnly: null, fileOnlyUnbound: null, live: null, listed: runs.length, scanned: 0, listStatus: list.status, skipped: [] };
  const enough = () => found.live && (want.storeBound ? found.fileOnly : found.fileOnly || found.fileOnlyUnbound);
  for (const summary of runs.slice(0, SCAN.maxRuns)) {
    if (enough()) break;
    const run = await readRun(io, String(summary.runId));
    found.scanned += 1;
    if (run.skipped) { found.skipped.push(`${run.runId}: ${run.skipped}`); continue; }
    const kind = classifyRun(run);
    const entry = { ...run, ...kind };
    if (kind.kind === 'live' && !found.live) found.live = entry;
    else if (kind.kind === 'file-only') {
      const bound = run.final.storeBound === true;
      if (bound && !found.fileOnly) found.fileOnly = entry;
      else if (!bound && !found.fileOnlyUnbound) found.fileOnlyUnbound = entry;
    } else if (kind.reason) found.skipped.push(`${run.runId}: ${kind.reason}`);
  }
  return found;
}

/**
 * @description One tail replay through the controller route.
 * @param {object} io - api.
 * @param {string} runId - The run.
 * @param {number} fromFrame - The start frame.
 * @returns {Promise<{tail: object|null, error: string|null}>} The node's verdict as the controller relayed it, or why not.
 */
async function replayTail(io, runId, fromFrame) {
  const res = await io.api('POST', `${BASE}/runs/${encodeURIComponent(runId)}/tail-replay`, { fromFrame });
  const tail = res.status === 200 && res.json.tailReplay ? res.json.tailReplay : null;
  if (!tail) return { tail: null, error: `POST ${BASE}/runs/<id>/tail-replay {fromFrame: ${fromFrame}} answered HTTP ${res.status}${res.json.error ? ` (${res.json.error})` : ''}` };
  return { tail, error: null };
}

/**
 * @description Whether the controller refused the tail because the producing bot has no reachable node.
 * @param {object} tail - The tail verdict.
 * @returns {boolean} True for the fail-closed no-endpoint result.
 */
function noEndpoint(tail) {
  return tail.status === 'stopped' && NO_ENDPOINT_RE.test(String(tail.stopReason || ''));
}

/**
 * @description Judge the reproduced leg: the no-edit tail reproduced the final artifacts on the bot node.
 * @param {object} tail - The tail verdict.
 * @param {{treeSha: string}} final - The run's final checkpoint, read independently.
 * @param {boolean} expectStoreBound - Whether the owner store must also be bound and reproduced.
 * @returns {{ok: boolean, detail: string}} The judgement, naming the first thing wrong.
 */
function judgeReproduced(tail, final, expectStoreBound) {
  const artifacts = tail.artifacts || {};
  const store = tail.storeVersion || {};
  const differing = Array.isArray(artifacts.differingPaths) ? artifacts.differingPaths : [];
  const problems = [];
  if (tail.status !== 'reproduced') problems.push(`status ${tail.status}${tail.stopReason ? ` (${tail.stopReason})` : ''}`);
  if (artifacts.reproduced !== true) problems.push(`artifacts.reproduced ${JSON.stringify(artifacts.reproduced ?? null)}`);
  if (differing.length) problems.push(`differing paths ${differing.join(', ')}`);
  if (!artifacts.replayTreeSha || artifacts.replayTreeSha !== final.treeSha) problems.push(`replayTreeSha ${artifacts.replayTreeSha || 'null'} is not final.checkpoint.treeSha ${final.treeSha}`);
  if (Number(tail.paidCalls) !== 0) problems.push(`${tail.paidCalls} paid call(s) in a plain tail`);
  if (expectStoreBound && !(store.bound === true && store.reproduced === true)) problems.push(`storeVersion bound ${JSON.stringify(store.bound ?? null)}, reproduced ${JSON.stringify(store.reproduced ?? null)}`);
  if (problems.length) return { ok: false, detail: `the tail replay did not reproduce the run: ${problems.join('; ')}` };
  const store_ = expectStoreBound ? ' and the owner-store version' : '';
  return { ok: true, detail: `the no-edit tail reproduced the final tree${store_} on the bot node (${tail.toolCalls} tool call(s) re-executed, replayTreeSha ${artifacts.replayTreeSha}, no differing path, 0 paid calls)` };
}

/**
 * @description Judge the live leg: from the first frame the tail stops at the calling frame with
 * `live-tool` after reproducing every earlier frame; from the consuming frame it is `non-replayable`.
 * @param {object} fromStart - The tail verdict from the first frame.
 * @param {object} fromConsumer - The tail verdict from the consuming frame.
 * @param {{callingSeq: number, consumingSeq: number, liveTool: string}} run - The classified live run.
 * @returns {{ok: boolean, detail: string}} The judgement.
 */
function judgeLiveStop(fromStart, fromConsumer, run) {
  const problems = [];
  const frames = Array.isArray(fromStart.frames) ? fromStart.frames : [];
  const last = frames[frames.length - 1] || {};
  if (fromStart.status !== 'stopped') problems.push(`from the first frame the status is ${fromStart.status}, not stopped`);
  if (fromStart.stoppedAtFrame !== run.callingSeq) problems.push(`stopped at frame ${fromStart.stoppedAtFrame}, not the calling frame ${run.callingSeq}`);
  if (last.status !== 'live-tool') problems.push(`the calling frame's status is ${last.status || 'missing'}, not live-tool`);
  if (last.status === 'live-tool' && !String(last.reason || '').includes(run.liveTool)) problems.push(`the live-tool reason does not name ${run.liveTool}`);
  const earlier = frames.slice(0, -1).filter((f) => f.status !== 'reproduced').map((f) => `${f.seq}:${f.status}`);
  if (earlier.length) problems.push(`earlier frame(s) not reproduced: ${earlier.join(', ')}`);
  const first = (Array.isArray(fromConsumer.frames) ? fromConsumer.frames : [])[0] || {};
  if (fromConsumer.status !== 'stopped' || fromConsumer.stoppedAtFrame !== run.consumingSeq) problems.push(`from the consuming frame ${run.consumingSeq} the status is ${fromConsumer.status} stopped at ${fromConsumer.stoppedAtFrame}`);
  if (first.status !== 'non-replayable') problems.push(`the consuming frame's status is ${first.status || 'missing'}, not non-replayable`);
  if (problems.length) return { ok: false, detail: `the live-read run did not stop as required: ${problems.join('; ')}` };
  return { ok: true, detail: `the tail from frame ${frames[0] ? frames[0].seq : '?'} reproduced ${frames.length - 1} frame(s) and stopped at frame ${run.callingSeq} before running ${run.liveTool} (live-tool); from the consuming frame ${run.consumingSeq} it answered non-replayable` };
}

/**
 * @description Resolve the bot a started run goes to, by registry name (or id) through GET /api/agents.
 * @param {object} io - api.
 * @param {string} agentName - The name or id.
 * @returns {Promise<{agentId: string|null, error: string|null}>} The id, or why not.
 */
async function resolveAgent(io, agentName) {
  const res = await io.api('GET', '/api/agents');
  const list = Array.isArray(res.json) ? res.json : (Array.isArray(res.json && res.json.agents) ? res.json.agents : []);
  const hit = list.find((a) => a && (a.name === agentName || a.agentId === agentName));
  if (!hit || typeof hit.agentId !== 'string') return { agentId: null, error: `no registered bot is named ${agentName} (GET /api/agents HTTP ${res.status})` };
  return { agentId: hit.agentId, error: null };
}

/**
 * @description Start one tagged file-tools run on the named bot and wait for its capture to close.
 * @param {object} io - api, workspace, sleep, now.
 * @param {{tag: string, agent: string, budgets: object}} plan - The run's plan.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{tag: string, agentId: string|null, ticketId: string|null, state: string, error: string|null}>} What happened.
 */
async function startRun(io, plan, ledger) {
  const started = { tag: plan.tag, agentId: null, ticketId: null, state: 'absent', error: null };
  const agent = await resolveAgent(io, plan.agent);
  if (!agent.agentId) return { ...started, error: agent.error };
  started.agentId = agent.agentId;
  ledger.created('chat-task', plan.tag, `a file-tools run on ${plan.agent}`);
  let send;
  try {
    send = await io.api('POST', `/api/tasks/${encodeURIComponent(plan.tag)}/messages`, { text: runPrompt(plan.tag), agentId: agent.agentId, agenticMode: true });
  } catch (error) {
    send = { status: 0, json: {}, aborted: common.errorText(error) }; // The turn keeps running at the node; the workspace poll below follows it.
  }
  if (send.json && typeof send.json.ticketId === 'string') { started.ticketId = send.json.ticketId; ledger.created('chat-ticket', send.json.ticketId); }
  if (send.status !== 200 && !send.aborted) return { ...started, error: `POST /api/tasks/<tag>/messages on ${plan.agent} answered HTTP ${send.status}${send.json.error ? ` (${send.json.error})` : ''}` };
  if (send.json && typeof send.json.taskIdUsed === 'string' && send.json.taskIdUsed !== plan.tag) {
    return { ...started, error: `the turn landed in task ${send.json.taskIdUsed}, not the tagged task` };
  }
  // A turn the HTTP ceiling cut off keeps running at the node: follow it for the settle budget. A turn that
  // answered gets the capture grace, because the capture writer closes final.json off the call path.
  const budgetMs = send.aborted ? plan.budgets.settleBudgetMs : plan.budgets.captureGraceMs;
  const settled = await common.pollUntil(io, { budgetMs, pollMs: plan.budgets.pollMs }, async () => {
    const state = await io.workspace.state(plan.tag);
    return { done: state === 'final', value: state };
  });
  started.state = String(settled.value);
  if (started.state !== 'final') {
    started.error = started.state === 'running' ? `the run on ${plan.agent} was still writing its capture after ${Math.round(settled.elapsedMs / 1000)}s`
      : `the run on ${plan.agent} wrote no Token Chase capture (workspace ${started.state} after ${Math.round(settled.elapsedMs / 1000)}s): TOKEN_CHASE_CAPTURE is off on its node, or the turn took the tool-less path`;
  }
  return started;
}

/**
 * @description Remove a started run: its chat task and messages, its ticket if one was made, its ask
 * workspace (never while the bot still writes it), then prove from the database that nothing is left.
 * @param {object} io - api, sql, workspace, ownerSub.
 * @param {{tag: string, ticketId: string|null, state: string}} started - What startRun returned.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function removeRun(io, started, ledger) {
  await ledger.attempt(`run ${started.tag}`, async () => {
    const problems = [];
    const task = await io.api('DELETE', `/api/tasks/${encodeURIComponent(started.tag)}`);
    if (![200, 204, 404].includes(task.status)) problems.push(`task delete answered HTTP ${task.status}`);
    if (started.ticketId) {
      const ticket = await io.api('DELETE', `/api/tickets/${encodeURIComponent(started.ticketId)}`);
      if (![200, 204, 404].includes(ticket.status)) problems.push(`ticket delete answered HTTP ${ticket.status}`);
      else ledger.removed('chat-ticket', started.ticketId);
    }
    if ((await io.workspace.state(started.tag)) === 'running') problems.push('the bot was still writing the ask workspace; it was left');
    else {
      const left = await io.workspace.remove(started.tag);
      if (left) problems.push(left);
    }
    if (problems.length) return `${started.tag}: ${problems.join(', ')}`;
    const row = ((await io.sql('jarvis.residue', [io.ownerSub, [started.tag]])).rows || [])[0] || {};
    const residue = Object.entries(row).filter(([, n]) => Number(n) > 0).map(([k, n]) => `${k}=${n}`);
    if (residue.length) return `residue remains for ${started.tag}: ${residue.join(', ')}`;
    ledger.removed('chat-task', started.tag);
    return null;
  });
}

/**
 * @description Leg (a): replay the file-only run and judge it; a bot without a node is a named gap.
 * @param {object} io - api.
 * @param {object} run - The classified file-only run.
 * @param {boolean} expectStoreBound - Leg (c)'s requirement folded in.
 * @returns {Promise<{state: string, detail: string, evidence: object}>} The leg.
 */
async function reproducedLeg(io, run, expectStoreBound) {
  const fromFrame = run.frames[0].seq;
  const { tail, error } = await replayTail(io, run.runId, fromFrame);
  const evidence = { runId: run.runId, fromFrame, agentId: run.frames[0].agentId, tools: run.tools, finalTreeSha: run.final.treeSha, storeBound: run.final.storeBound === true };
  if (!tail) return { state: 'fail', detail: `reproduced leg on run ${run.runId}: ${error}`, evidence };
  Object.assign(evidence, { status: tail.status, restore: tail.restore, artifacts: tail.artifacts, storeVersion: tail.storeVersion, toolCalls: tail.toolCalls, paidCalls: tail.paidCalls });
  if (noEndpoint(tail)) return { state: 'unavailable', detail: `reproduced leg on run ${run.runId}: the producing bot ${run.frames[0].agentId || '(unknown)'} has no reachable bot node, so the tail cannot run on an accountable node`, evidence };
  const judged = judgeReproduced(tail, run.final, expectStoreBound);
  return { state: judged.ok ? 'pass' : 'fail', detail: `reproduced leg on run ${run.runId}: ${judged.detail}`, evidence };
}

/**
 * @description Leg (b): replay the live run from its first frame and from the consuming frame, then judge.
 * @param {object} io - api.
 * @param {object} run - The classified live run.
 * @returns {Promise<{state: string, detail: string, evidence: object}>} The leg.
 */
async function liveLeg(io, run) {
  const fromFrame = run.frames[0].seq;
  const evidence = { runId: run.runId, fromFrame, agentId: run.frames[0].agentId, liveTool: run.liveTool, liveClass: run.liveClass, callingSeq: run.callingSeq, consumingSeq: run.consumingSeq,
    consumingFrameReplayable: run.frames.find((f) => f.seq === run.consumingSeq).replayable };
  const start = await replayTail(io, run.runId, fromFrame);
  if (!start.tail) return { state: 'fail', detail: `live-read leg on run ${run.runId}: ${start.error}`, evidence };
  if (noEndpoint(start.tail)) return { state: 'unavailable', detail: `live-read leg on run ${run.runId}: the producing bot ${run.frames[0].agentId || '(unknown)'} has no reachable bot node`, evidence };
  const consumer = await replayTail(io, run.runId, run.consumingSeq);
  if (!consumer.tail) return { state: 'fail', detail: `live-read leg on run ${run.runId}: ${consumer.error}`, evidence };
  Object.assign(evidence, { fromStart: { status: start.tail.status, stoppedAtFrame: start.tail.stoppedAtFrame, frames: start.tail.frames },
    fromConsumer: { status: consumer.tail.status, stoppedAtFrame: consumer.tail.stoppedAtFrame, frames: consumer.tail.frames } });
  const judged = judgeLiveStop(start.tail, consumer.tail, run);
  return { state: judged.ok ? 'pass' : 'fail', detail: `live-read leg on run ${run.runId}: ${judged.detail}`, evidence };
}

/**
 * @description The file-only run leg (a) uses: the scanned one, else one the case starts now.
 * @param {object} io - Ports.
 * @param {object} found - What scanRuns found.
 * @param {{tag: string, agent: string, budgets: object, expectStoreBound: boolean, startRun: boolean}} plan - The plan.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @param {object[]} startedRuns - Filled with the run this call starts (for cleanup).
 * @returns {Promise<{run: object|null, gap: string|null, started: object|null}>} The run, or the named gap.
 */
async function fileOnlyRun(io, found, plan, ledger, startedRuns) {
  const existing = found.fileOnly || (plan.expectStoreBound ? null : found.fileOnlyUnbound);
  if (existing) return { run: existing, gap: null, started: null };
  const unboundOnly = plan.expectStoreBound && found.fileOnlyUnbound;
  if (!plan.startRun) return { run: null, gap: unboundOnly ? `the only file-tools run(s) captured are not store-bound; ${STORE_BOUND_STEP}` : 'no captured run consumed only workspace file-tool results with a completed final checkpoint (no run was started: startRun is off)', started: null };
  const started = await startRun(io, { tag: plan.tag, agent: plan.agent, budgets: plan.budgets }, ledger);
  startedRuns.push(started);
  if (started.error) return { run: null, gap: `no captured file-tools-only run, and starting one did not yield a capture: ${started.error}`, started };
  const run = await readRun(io, started.tag);
  if (run.skipped) return { run: null, gap: `the started run ${started.tag} could not be read: ${run.skipped}`, started };
  const kind = classifyRun(run);
  if (kind.kind !== 'file-only') {
    const why = kind.kind === 'live' ? `it consumed ${kind.liveTool} (${kind.liveClass})` : kind.reason;
    return { run: null, gap: `the run started on ${plan.agent} is not file-tools-only (${why}); name a bot that answers such a turn with its file tools alone: ${AGENT_ENV}="<bot name>" node scripts/operations/live-acceptance.js ${KEY}`, started };
  }
  if (plan.expectStoreBound && run.final.storeBound !== true) return { run: null, gap: `the run started on ${plan.agent} is not store-bound; ${STORE_BOUND_STEP}`, started };
  return { run: { ...run, ...kind }, gap: null, started };
}

/**
 * @description Combine the legs into one verdict: any fail is a fail, else any gap is unavailable, else pass.
 * @param {Array<{name: string, state: string, detail: string}>} legs - The legs.
 * @returns {{state: string, detail: string}} The verdict.
 */
function combine(legs) {
  const state = legs.some((l) => l.state === 'fail') ? 'fail' : legs.some((l) => l.state === 'unavailable') ? 'unavailable' : 'pass';
  return { state, detail: `${legs.map((l) => `${l.detail}`).join('; ')}.` };
}

/**
 * @description The body of the case: scan, leg (a) with (c) folded in, leg (b).
 * @param {object} io - Ports.
 * @param {object} plan - The run's plan.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @param {object[]} startedRuns - Filled with any run the case starts.
 * @returns {Promise<{legs: object[], evidence: object}>} The legs and the evidence.
 */
async function exercise(io, plan, ledger, startedRuns) {
  const found = await scanRuns(io, { storeBound: plan.expectStoreBound });
  const evidence = { expectStoreBound: plan.expectStoreBound, runsListed: found.listed, runsScanned: found.scanned, skipped: found.skipped.slice(0, 10), started: null };
  if (found.listStatus !== 200) {
    const state = found.listStatus === 404 ? 'unavailable' : 'fail';
    return { legs: [{ name: 'runs', state, detail: `GET ${BASE}/runs answered HTTP ${found.listStatus}${state === 'unavailable' ? ' (the Token Chase routes are not mounted on this deployment)' : ''}` }], evidence };
  }
  const legs = [];
  const chosen = await fileOnlyRun(io, found, plan, ledger, startedRuns);
  if (chosen.started) evidence.started = { tag: chosen.started.tag, agentId: chosen.started.agentId, state: chosen.started.state };
  if (chosen.run) {
    const leg = await reproducedLeg(io, chosen.run, plan.expectStoreBound);
    legs.push({ name: 'reproduced', ...leg });
    evidence.reproduced = leg.evidence;
  } else legs.push({ name: 'reproduced', state: 'unavailable', detail: `reproduced leg: ${chosen.gap}` });
  if (found.live) {
    const leg = await liveLeg(io, found.live);
    legs.push({ name: 'live', ...leg });
    evidence.live = leg.evidence;
  } else {
    const captured = found.listed ? `none of the ${found.scanned} newest captured run(s) consumed a live-read or side-effect result` : 'nothing is captured yet (TOKEN_CHASE_CAPTURE on a bot node plus one agentic run)';
    legs.push({ name: 'live', state: 'unavailable', detail: `live-read leg: ${captured}; ${LIVE_RUN_STEP}` });
  }
  return { legs, evidence };
}

/**
 * @description Run the case once.
 * @param {object} ports - api, sql, workspace, ownerSub.
 * @param {object} [options] - `expectStoreBound` (leg c; the host flag --expect-store-bound), `agent` (the bot a started
 *   run goes to; else OSHAL_VERIFY_TOKEN_CHASE_AGENT from `env`, default process.env, else general-bot), `startRun`
 *   (default true), budget overrides, `tag` (tests only).
 * @returns {Promise<object>} The result with its cleanup receipt.
 */
async function run(ports, options = {}) {
  const missing = common.missingPorts(ports, NEEDS);
  if (missing.length) return common.unavailable(CASE_ID, `This runner has no ${missing.join('/')} port.`);
  const io = common.withClock(ports);
  const env = options.env || process.env;
  const agent = String(options.agent || env[AGENT_ENV] || DEFAULT_AGENT).trim() || DEFAULT_AGENT;
  const plan = { tag: options.tag || common.mintTag(KEY), agent, budgets: common.budgetsFrom(DEFAULT_BUDGETS, options),
    expectStoreBound: options.expectStoreBound === true, startRun: options.startRun !== false };
  const ledger = new common.CleanupLedger();
  const startedRuns = [];
  let verdict;
  let evidence = {};
  try {
    const outcome = await exercise(io, plan, ledger, startedRuns);
    verdict = combine(outcome.legs);
    evidence = outcome.evidence;
  } catch (error) {
    verdict = { state: 'fail', detail: `The case crashed: ${common.errorText(error)}` };
  }
  for (const started of startedRuns.filter((s) => s.agentId)) await removeRun(io, started, ledger);
  if (verdict.state === 'unavailable' && !startedRuns.length) verdict.detail += ' Nothing was written.';
  return common.finish(CASE_ID, verdict, ledger, { agent, ...evidence });
}

module.exports = { CASE_ID, KEY, TITLE, NEEDS, AGENT_ENV, DEFAULT_AGENT, ARTIFACT_FILE, runPrompt, classifyRun, judgeReproduced, judgeLiveStop, run };
