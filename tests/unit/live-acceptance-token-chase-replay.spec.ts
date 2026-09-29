/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the token-chase-replay live-acceptance case's own logic over a doubled Token Chase API (run listing, frame summaries and details with per-frame pins, the final checkpoint, a tail-replay route whose verdict is computed from the run's pins the way the node's runner reports it, the agents list, the chat message route that starts a captured run, task delete, the workspace and residue ports): a file-tools-only run reproduced (status, artifacts.reproduced, no differing path, replayTreeSha equal to the independently read final treeSha, 0 paid calls) and a live-read run stopped at the calling frame with live-tool and non-replayable from the consuming frame = pass, starting nothing; with no file-tools run captured, one tagged run started on the named bot, replayed and removed (task, workspace, residue zero). Red: a differing path, a node that says reproduced beside a differing path, a wrong tree digest, a live-tool stop reported as reproduced, a consuming frame replayed instead of refused, a store-bound run whose store version did not reproduce under --expect-store-bound, an unremoved workspace, a failed task delete. Unavailable, never pass: no live-read run, nothing captured, a started run that used a side-effect tool (removed), a bot with no reachable node, capture off on the started run, a refused start, an unbound run under --expect-store-bound, a missing port. The real companion is `node scripts/operations/live-acceptance.js token-chase-replay` on the box; the route, runner and node boundaries are proven by tests/unit/token-chase-*.spec.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The case changed (its change log entry 2) and so did what this spec stands on. The doubled-port cases drive question-tool runs: one run serves both legs, the tail from the first frame is asked for once, and the red cases add a restore that is not ok and a tool call re-executed; the unavailable cases pin the messages to what the run shows (the tools the node offered, a failed call, a model that did not call the tool). New real-boundary cases answer the defect the 2026-09-29 sweep found, which the doubled ports could not see: the case is driven against the REAL bot-node registry (registerBotNodeReadOnlyTools on the real any-bot ToolRegistry), the REAL prompt authorization resolver, the REAL agentic loop with the REAL capture lane (frames, per-turn pins, private-git commits, final.json), the REAL read service, the REAL controller tail service and the REAL bot-node tail executor, with the real workspace state and removal functions. They hold QUESTION_TOOLS to the registered set, prove a bot granted the file tools still runs none of them on a bot node, and prove the started run passes both legs. Doubled on purpose and named: the model turn (provider scripted-fixture, which does what the prompt asks with the tools it was offered), the per-bot grant rows (read by the real resolver), the chat task store with its residue read, the agent list, and the controller-to-node HTTP hop (real in token-chase-checkpoint-replay-e2e.spec.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BOT_NODE_READ_ONLY_TOOL_NAMES, registerBotNodeReadOnlyTools, type BotNodeReadOnlyToolDeps, type ReadOnlyToolRegistration } from '@/app/bot-node-read-only-tools';
import { executeTailReplayOnNode } from '@/app/bot-node-token-chase-tail-route';
import { createPromptAuthorizationResolver } from '@/app/prompt-authorization-resolver';
import { TokenChaseReadService, TokenChaseTailReplayService, createOwnerStoreSnapshotter, readOwnerStoreConfig } from '@/features/token-chase';
import { fakeApi, fakeClock, type FakeHandler, type FakeReply } from '../fixtures/live-acceptance-fake-api';

// The capture lane reads its flag once at module load; vitest hoists this above every import.
vi.hoisted(() => { process.env.TOKEN_CHASE_CAPTURE = 'true'; });

const requireCjs = createRequire(import.meta.url);
const replay = requireCjs('../../scripts/lib/live-acceptance-token-chase-replay.js');
const common = requireCjs('../../scripts/lib/live-acceptance-common.js');
const AgenticController = requireCjs('../../any-bot/server/controllers/AgenticController');
const ToolRegistry = requireCjs('../../any-bot/server/services/ToolRegistry');
const { tokenChase } = requireCjs('../../any-bot/server/services/token-chase/TokenChaseCapture');
const { classifyTool } = requireCjs('../../any-bot/server/services/token-chase/turn-provenance');

const OWNER = 'fixture|replay-owner';
const ACCESS = { callerSub: OWNER, isAdmin: false };
const TAG = 'testlab-live-token-chase-replay-0a1b2c3d';
const JARVIS = 'a0000000-0000-0000-0000-000000000050';
const GENERAL = 'a0000000-0000-0000-0000-000000000099';
const FILE_BOT = 'a0000000-0000-0000-0000-0000000000f1';
const FINAL_SHA = 'f'.repeat(64);
const OTHER_SHA = 'e'.repeat(64);
const STORE_SHA = 'd'.repeat(64);
const HOST_COMMAND = 'OSHAL_VERIFY_TOKEN_CHASE_AGENT="<bot name>" node scripts/operations/live-acceptance.js token-chase-replay';
const QUESTION_TOOLS = ['rag_query', 'graph_query', 'conversation_query', 'conversation_fetch'];
/** What a bot node offers a bot that holds the two conversation grants. */
const OFFERED = ['conversation_query', 'conversation_fetch', 'attempt_completion'];
const REPRODUCED = (runId: string, files: number, tools = 'conversation_query', sha = FINAL_SHA, store = '') => `reproduced leg on run ${runId}: the no-edit tail on the bot node restored the checkpoint of the first frame `
  + `(${files} file(s), integrity ok) and the restored tree is the final tree (replayTreeSha ${sha}, no differing path)${store}; 0 tool calls re-executed and 0 paid calls, because the run read only through ${tools}`;

interface Pin { tool: string; replayClass: string; pinned: boolean; declared?: boolean; success?: boolean }
interface Frame { seq: number; phase?: string; replayable?: boolean; pins?: Pin[]; tools?: string[] }
interface Final { outcome: string; treeSha: string | null; checkpointComplete: boolean; storeBound: boolean; ownerStoreVersion: string | null }
interface Run { runId: string; frames: Frame[]; final: Final | null; modified: string }

const query: Pin = { tool: 'conversation_query', replayClass: 'live-read', pinned: false, declared: false, success: true };
const fetched: Pin = { tool: 'conversation_fetch', replayClass: 'live-read', pinned: false, declared: false, success: true };
const failed: Pin = { ...query, success: false };
const write: Pin = { tool: 'write_to_file', replayClass: 'workspace-write', pinned: true, declared: true, success: true };
const read: Pin = { tool: 'read_file', replayClass: 'workspace-read', pinned: true, declared: true, success: true };
const command: Pin = { tool: 'execute_command', replayClass: 'side-effect', pinned: false, declared: true, success: true };

function final(o: Partial<Final> = {}): Final {
  return { outcome: 'completed', treeSha: FINAL_SHA, checkpointComplete: true, storeBound: false, ownerStoreVersion: null, ...o };
}
/** A bot-node run that read through a question tool: frame 1 calls it, frame 2 consumed the result (non-replayable) and completed. */
function questionRun(runId: string, modified: string, o: { storeBound?: boolean; pins?: Pin[] } = {}): Run {
  return { runId, modified, frames: [{ seq: 1, pins: [], tools: OFFERED }, { seq: 2, pins: o.pins || [query], replayable: false, tools: OFFERED }],
    final: final({ storeBound: o.storeBound === true, ownerStoreVersion: o.storeBound ? STORE_SHA : null }) };
}
/** A run from a runtime that holds file tools, which no bot node is: one file write, then a command that frame 3 consumed. */
function commandRun(runId: string, modified: string): Run {
  return { runId, modified, frames: [{ seq: 1, pins: [] }, { seq: 2, pins: [write] }, { seq: 3, pins: [command], replayable: false }], final: final() };
}
/** A plain answer: one frame, no tool result consumed, with the tools the node offered. */
function chatRun(runId: string, modified: string, tools: string[] = ['attempt_completion']): Run {
  return { runId, modified, frames: [{ seq: 1, pins: [], tools }], final: final() };
}

interface WorldOptions {
  runs?: Run[]; diverge?: boolean; inconsistent?: boolean; wrongTreeSha?: boolean; paid?: boolean; badRestore?: boolean; reExecuted?: boolean; noEndpoint?: boolean;
  storeDiverged?: boolean; liveAsReproduced?: boolean; consumerRuns?: boolean; startFails?: FakeReply; startAborts?: boolean; started?: (id: string) => Run;
  captureOff?: boolean; removeFails?: boolean; taskDeleteFails?: boolean; agents?: Array<{ agentId: string; name: string }>; runningPolls?: number;
}

/** The node's verdict for a tail of one run, as the controller relays it. */
function nodeVerdict(run: Run, fromFrame: number, o: WorldOptions): Record<string, unknown> {
  const unbound = { baseline: null, replay: null, reproduced: null, bound: false };
  if (o.noEndpoint) {
    return { status: 'stopped', stoppedAtFrame: fromFrame, stopReason: `No reachable bot node for agent ${JARVIS}: replay must run on an accountable node.`, frames: [], toolCalls: 0,
      restore: { source: 'none', filesRestored: 0, integrity: 'none' }, artifacts: { baselineTreeSha: null, replayTreeSha: null, reproduced: null, differingPaths: [] },
      storeVersion: unbound, paidCalls: 0, totalCostUsd: 0 };
  }
  const base = {
    restore: { source: 'commit', filesRestored: 1, integrity: o.badRestore ? 'mismatch' : 'ok' },
    artifacts: { baselineTreeSha: FINAL_SHA, replayTreeSha: o.wrongTreeSha ? OTHER_SHA : FINAL_SHA, reproduced: !o.diverge, differingPaths: o.diverge || o.inconsistent ? ['brief.txt'] : [], redactedPaths: [], complete: true },
    storeVersion: run.final?.storeBound ? { baseline: STORE_SHA, replay: o.storeDiverged ? OTHER_SHA : STORE_SHA, reproduced: !o.storeDiverged, bound: true } : unbound,
    paidCalls: o.paid ? 1 : 0, totalCostUsd: 0,
  };
  const frames = run.frames.filter((f) => f.seq >= fromFrame);
  const toolAfter = (i: number) => frames[i + 1]?.pins?.[0]?.tool ?? null;
  const ranToEnd = () => ({ ...base, status: 'reproduced', stoppedAtFrame: null, stopReason: null, toolCalls: frames.length - 1,
    frames: frames.map((f, i) => (i === frames.length - 1 ? { seq: f.seq, status: 'completed', tool: 'attempt_completion' } : { seq: f.seq, status: 'reproduced', tool: toolAfter(i), pinVerified: true })) });
  const consuming = run.frames.find((f) => f.pins?.some((p) => !p.pinned));
  if (!consuming) return ranToEnd();
  const live = consuming.pins!.find((p) => !p.pinned)!;
  if (fromFrame < consuming.seq) {
    if (o.liveAsReproduced) return ranToEnd();
    const before = frames.filter((f) => f.seq < consuming.seq - 1).map((f, i) => ({ seq: f.seq, status: 'reproduced', tool: toolAfter(i) }));
    return { ...base, status: 'stopped', stoppedAtFrame: consuming.seq - 1, stopReason: 'live tool', toolCalls: before.length + (o.reExecuted ? 1 : 0),
      frames: [...before, { seq: consuming.seq - 1, status: 'live-tool', tool: live.tool, replayClass: live.replayClass,
        reason: `Frame ${consuming.seq - 1} calls ${live.tool} (${live.replayClass}); a hermetic replay refuses to re-run it.` }] };
  }
  if (o.consumerRuns) return ranToEnd();
  return { ...base, status: 'stopped', stoppedAtFrame: consuming.seq, stopReason: 'non-replayable', toolCalls: 0,
    frames: [{ seq: consuming.seq, status: 'non-replayable', tool: null, reason: `Frame ${consuming.seq} depends on a live read.` }] };
}

/** What one doubled deployment holds, shared by its routes and its ports. */
interface WorldState { runs: Map<string, Run>; chatTasks: Set<string>; log: string[]; start: (id: string) => void }

/** The Token Chase read and tail-replay routes of the doubled deployment. */
function tokenChaseRoutes(s: WorldState, o: WorldOptions): Record<string, FakeHandler> {
  const detail = (run: Run, f: Frame) => ({ seq: f.seq, phase: f.phase || 'closed', replayable: f.replayable !== false, agentId: JARVIS, ownerSub: OWNER,
    ownerStoreVersion: run.final?.ownerStoreVersion ?? null, pins: f.pins || [], tools: f.tools || [], history: [{ role: 'user', content: 'fixture' }], toolSchema: [] });
  return {
    'GET /api/token-chase/runs': () => ({ status: 200, json: { runs: [...s.runs.values()].filter((r) => r.frames.length).sort((a, b) => b.modified.localeCompare(a.modified))
      .map((r) => ({ runId: r.runId, frameCount: r.frames.length, modified: r.modified })) } }),
    'GET /api/token-chase/runs/:id': ({ params }) => {
      const run = s.runs.get(params.id);
      return { status: 200, json: { runId: params.id, frames: run ? run.frames.map((f) => ({ seq: f.seq, phase: f.phase || 'closed', replayable: f.replayable !== false, tools: f.tools || [] })) : [] } };
    },
    'GET /api/token-chase/runs/:id/frames/:seq': ({ params }) => {
      const run = s.runs.get(params.id);
      const frame = run?.frames.find((f) => f.seq === Number(params.seq));
      return run && frame ? { status: 200, json: { frame: detail(run, frame) } } : { status: 404, json: { error: 'Frame not found' } };
    },
    'GET /api/token-chase/runs/:id/final': ({ params }) => {
      const run = s.runs.get(params.id);
      return run?.final ? { status: 200, json: { runId: params.id, final: { taskId: params.id, ...run.final } } } : { status: 404, json: { error: 'Final checkpoint not found' } };
    },
    'POST /api/token-chase/runs/:id/tail-replay': ({ params, body }) => {
      const run = s.runs.get(params.id);
      const { fromFrame } = body as { fromFrame: number };
      s.log.push(`replay ${params.id} from ${fromFrame}`);
      return run ? { status: 200, json: { tailReplay: { runId: params.id, fromFrame, agentId: JARVIS, ...nodeVerdict(run, fromFrame, o) } } } : { status: 404, json: { error: 'Start frame not found' } };
    },
  };
}

/** The agent list, the chat route that starts a run and the task delete of the doubled deployment. */
function chatRoutes(s: WorldState, o: WorldOptions): Record<string, FakeHandler> {
  return {
    'GET /api/agents': () => ({ status: 200, json: { success: true, agents: o.agents || [{ agentId: JARVIS, name: 'oshal-assistant', status: 'online' }] } }),
    'POST /api/tasks/:id/messages': ({ params }) => {
      if (o.startFails) return o.startFails;
      s.start(params.id);
      if (o.startAborts) throw new Error('The operation was aborted due to timeout');
      return { status: 200, json: { success: true, taskId: params.id, taskIdUsed: params.id, agentId: JARVIS, ticketCreated: false, ticketId: null } };
    },
    'DELETE /api/tasks/:id': ({ params }) => {
      if (o.taskDeleteFails) return { status: 500, json: { error: 'Failed to delete task' } };
      const had = s.chatTasks.delete(params.id);
      s.log.push('delete-task');
      return { status: had ? 204 : 404 };
    },
  };
}

/** The doubled deployment: captured runs, the tail-replay node verdicts, the chat route that starts a run, and its cleanup. */
function world(o: WorldOptions = {}) {
  const runs = new Map<string, Run>((o.runs || []).map((r) => [r.runId, r]));
  const chatTasks = new Set<string>();
  const log: string[] = [];
  const statements: Array<{ name: string; params: unknown[] }> = [];
  let polls = 0;
  const start = (id: string) => {
    chatTasks.add(id);
    runs.set(id, o.captureOff ? { runId: id, modified: '2026-09-28T13:00:00Z', frames: [], final: null } : (o.started || ((run: string) => questionRun(run, '2026-09-28T13:00:00Z')))(id));
    log.push('start');
  };
  const state: WorldState = { runs, chatTasks, log, start };
  const api = fakeApi({ ...tokenChaseRoutes(state, o), ...chatRoutes(state, o) });
  const workspace = {
    state: async (id: string) => {
      if (!runs.has(id)) return 'absent';
      if (!runs.get(id)!.frames.length) return 'no-capture';
      polls += 1;
      return polls <= (o.runningPolls || 0) ? 'running' : 'final';
    },
    remove: async (id: string) => { log.push('remove-workspace'); if (o.removeFails) return `workspace ${id} still exists after removal`; runs.delete(id); return null; },
  };
  const sql = async (name: string, params: unknown[]) => {
    statements.push({ name, params });
    const [sub, ids] = params as [string, string[]];
    expect(sub).toBe(OWNER);
    return { rows: [{ chat_tasks: ids.filter((id) => chatTasks.has(id)).length, chat_messages: 0, chat_tickets: 0, work_items: 0 }] };
  };
  const ports = { api: api.api, sql, workspace, ownerSub: OWNER, ...fakeClock() };
  return { api, ports, runs, chatTasks, log, statements };
}

const run = (w: ReturnType<typeof world>, options: Record<string, unknown> = {}) => replay.run(w.ports, { tag: TAG, env: {}, ...options });
const CAPTURED = [chatRun('run-chat', '2026-09-28T12:30:00Z'), questionRun('run-q', '2026-09-28T12:20:00Z'), commandRun('run-cmd', '2026-09-28T12:10:00Z')];
const LIVE_Q = (runId: string) => `live-read leg on run ${runId}: the tail from frame 1 reproduced 0 frame(s) and stopped at frame 1 before running conversation_query (live-tool); from the consuming frame 2 it answered non-replayable`;

describe('token-chase-replay live acceptance', () => {
  it('passes both legs on one captured question-tool run, asking for its first-frame tail once and starting nothing', async () => {
    const w = world({ runs: CAPTURED });
    const result = await run(w);
    expect(result.state).toBe('pass');
    expect(result.detail).toContain(REPRODUCED('run-q', 1));
    expect(result.detail).toContain(LIVE_Q('run-q'));
    expect(result.evidence).toMatchObject({ agent: 'oshal-assistant', expectStoreBound: false, runsListed: 3, runsScanned: 2, started: null,
      reproduced: { runId: 'run-q', fromFrame: 1, tools: ['conversation_query'], finalTreeSha: FINAL_SHA, status: 'stopped', storeBound: false, toolCalls: 0, paidCalls: 0, restore: { integrity: 'ok' } },
      live: { runId: 'run-q', liveTool: 'conversation_query', liveClass: 'live-read', callingSeq: 1, consumingSeq: 2, consumingFrameReplayable: false, fromStart: { status: 'stopped', stoppedAtFrame: 1 }, fromConsumer: { status: 'stopped', stoppedAtFrame: 2 } } });
    expect(result.evidence.reproduced.artifacts.replayTreeSha).toBe(FINAL_SHA);
    expect(result.evidence.skipped).toEqual(['run-chat: no tool result consumed']);
    expect(w.log).toEqual(['replay run-q from 1', 'replay run-q from 2']);
    expect(w.api.calls.filter((c) => c.method !== 'GET')).toHaveLength(2);
    expect(result.cleanup).toEqual({ created: 0, removed: [], kept: [], outstanding: [], errors: [] });
    expect(result.detail).not.toContain('Nothing was written');
  });

  it('starts one tagged question-tool run on oshal-assistant when none is captured, judges both legs on it and removes it', async () => {
    const w = world({ runs: [chatRun('run-chat', '2026-09-28T12:30:00Z')] });
    const result = await run(w);
    expect(result.state).toBe('pass');
    expect(result.detail).toContain(REPRODUCED(TAG, 1));
    expect(result.detail).toContain(LIVE_Q(TAG));
    const start = w.api.calls.find((c) => c.method === 'POST' && c.path === `/api/tasks/${TAG}/messages`)!;
    expect(start.body).toEqual({ text: replay.runPrompt(TAG), agentId: JARVIS, agenticMode: true });
    expect(replay.DEFAULT_AGENT).toBe('oshal-assistant');
    expect(replay.runPrompt(TAG)).toContain(`Call your conversation_query tool exactly once with the query "${TAG}"`);
    expect(replay.runPrompt(TAG)).toContain('do not write any file');
    expect(replay.runPrompt(TAG)).not.toMatch(/write_to_file|read_file/);
    expect(w.log).toEqual(['start', `replay ${TAG} from 1`, `replay ${TAG} from 2`, 'delete-task', 'remove-workspace']);
    expect(result.evidence.started).toEqual({ tag: TAG, agentId: JARVIS, state: 'final' });
    expect(result.cleanup).toMatchObject({ created: 1, removed: [`chat-task ${TAG}`], outstanding: [], errors: [] });
    expect(w.statements).toEqual([{ name: 'jarvis.residue', params: [OWNER, [TAG]] }]);
    expect(w.runs.has(TAG)).toBe(false);
    expect(w.chatTasks.size).toBe(0);
  });

  it('starts the run on the bot the host runner names', async () => {
    const w = world({ agents: [{ agentId: JARVIS, name: 'oshal-assistant' }, { agentId: GENERAL, name: 'general-bot' }] });
    const result = await run(w, { env: { OSHAL_VERIFY_TOKEN_CHASE_AGENT: 'general-bot' } });
    expect(result.evidence.agent).toBe('general-bot');
    expect(w.api.calls.find((c) => c.method === 'POST' && c.path === `/api/tasks/${TAG}/messages`)!.body).toMatchObject({ agentId: GENERAL });
  });

  it('follows a started run the HTTP ceiling cut off until its capture closes', async () => {
    const w = world({ startAborts: true, runningPolls: 3 });
    const result = await run(w);
    expect(result.state).toBe('pass');
    expect(result.evidence.started).toEqual({ tag: TAG, agentId: JARVIS, state: 'final' });
    expect(result.cleanup).toMatchObject({ removed: [`chat-task ${TAG}`], outstanding: [], errors: [] });
  });

  it('fails on a differing path, a wrong tree digest, a paid call, a restore that is not ok and a tool call re-executed', async () => {
    const diverged = await run(world({ runs: CAPTURED, diverge: true }));
    expect(diverged.state).toBe('fail');
    expect(diverged.detail).toContain('reproduced leg on run run-q: the tail replay did not reproduce the run: artifacts.reproduced false; differing paths brief.txt');
    expect(diverged.detail).toContain(LIVE_Q('run-q'));
    const inconsistent = await run(world({ runs: CAPTURED, inconsistent: true }));
    expect(inconsistent.state).toBe('fail');
    expect(inconsistent.detail).toContain('the tail replay did not reproduce the run: differing paths brief.txt');
    const wrong = await run(world({ runs: CAPTURED, wrongTreeSha: true }));
    expect(wrong.state).toBe('fail');
    expect(wrong.detail).toContain(`replayTreeSha ${OTHER_SHA} is not final.checkpoint.treeSha ${FINAL_SHA}`);
    const paid = await run(world({ runs: CAPTURED, paid: true }));
    expect(paid.state).toBe('fail');
    expect(paid.detail).toContain('1 paid call(s) in a plain tail');
    const restore = await run(world({ runs: CAPTURED, badRestore: true }));
    expect(restore.state).toBe('fail');
    expect(restore.detail).toContain('the tail replay did not reproduce the run: restore integrity mismatch, not ok');
    const reExecuted = await run(world({ runs: CAPTURED, reExecuted: true }));
    expect(reExecuted.state).toBe('fail');
    expect(reExecuted.detail).toContain('1 tool call(s) re-executed in a run with no replayable tool');
  });

  it('fails when a live-tool stop is reported as reproduced, or the consuming frame is replayed instead of refused', async () => {
    const asReproduced = await run(world({ runs: CAPTURED, liveAsReproduced: true }));
    expect(asReproduced.state).toBe('fail');
    expect(asReproduced.detail).toContain('reproduced leg on run run-q: the tail replay did not reproduce the run: status reproduced, not stopped, on a run that consumed a live read');
    expect(asReproduced.detail).toContain('live-read leg on run run-q: the live-read run did not stop as required: from the first frame the status is reproduced, not stopped');
    const consumed = await run(world({ runs: CAPTURED, consumerRuns: true }));
    expect(consumed.state).toBe('fail');
    expect(consumed.detail).toContain(REPRODUCED('run-q', 1));
    expect(consumed.detail).toContain('from the consuming frame 2 the status is reproduced stopped at null');
    expect(consumed.detail).toContain("the consuming frame's status is completed, not non-replayable");
  });

  it('names what the started run shows when it is not a question-tool run, and never sends the operator after file tools', async () => {
    const noGrant = world({ started: (id) => chatRun(id, '2026-09-28T13:00:00Z') });
    const refused = await run(noGrant);
    expect(refused.state).toBe('unavailable');
    expect(refused.detail).toContain('reproduced leg: the run started on oshal-assistant consumed no tool result: its node offered the model attempt_completion and not conversation_query, '
      + 'so the node resolved no executable grant (auto and installed) of conversation_query for oshal-assistant. A bot node registers only the read-only question tools '
      + `(${QUESTION_TOOLS.join(', ')}), so the run this leg needs comes from a bot that runs on its own node and holds such a grant: ${HOST_COMMAND}`);
    expect(refused.detail).toContain('live-read leg: nothing was captured before this case ran (TOKEN_CHASE_CAPTURE on a bot node plus one agentic run); the run this case started consumed none either; one conversation whose bot reads live data');
    expect(refused.detail).not.toMatch(/file tools alone|file-tools-only|write_to_file/);
    expect(refused.detail).not.toContain('Nothing was written');
    expect(refused.cleanup).toMatchObject({ created: 1, removed: [`chat-task ${TAG}`], outstanding: [], errors: [] });
    expect(noGrant.runs.has(TAG)).toBe(false);
    const notCalled = await run(world({ started: (id) => chatRun(id, '2026-09-28T13:00:00Z', OFFERED) }));
    expect(notCalled.state).toBe('unavailable');
    expect(notCalled.detail).toContain('reproduced leg: the run started on oshal-assistant consumed no tool result: its node offered conversation_query and the model finished without calling it');
    const callFailed = await run(world({ started: (id) => questionRun(id, '2026-09-28T13:00:00Z', { pins: [failed] }) }));
    expect(callFailed.state).toBe('unavailable');
    expect(callFailed.detail).toContain('reproduced leg: the run started on oshal-assistant is not a question-tool run: every conversation_query call failed on the node');
    expect(callFailed.detail).toContain(LIVE_Q(TAG));
    const fileTools = await run(world({ started: (id) => commandRun(id, '2026-09-28T13:00:00Z') }));
    expect(fileTools.state).toBe('unavailable');
    expect(fileTools.detail).toContain('reproduced leg: the run started on oshal-assistant is not a question-tool run: it consumed write_to_file (workspace-write), which is not a read-only question tool');
  });

  it('is unavailable, never pass, when no run can be used, and judges the live leg on any run that consumed a live read', async () => {
    const nothing = await run(world(), { startRun: false });
    expect(nothing.state).toBe('unavailable');
    expect(nothing.detail).toContain('reproduced leg: no captured run consumed only read-only question-tool results with a completed final checkpoint (no run was started: startRun is off)');
    expect(nothing.detail).toContain('live-read leg: nothing was captured before this case ran (TOKEN_CHASE_CAPTURE on a bot node plus one agentic run); one conversation whose bot reads live data');
    expect(nothing.detail).toContain('Nothing was written.');
    const chatOnly = await run(world({ runs: [chatRun('run-chat', '2026-09-28T12:30:00Z')] }), { startRun: false });
    expect(chatOnly.detail).toContain('live-read leg: none of the 1 newest captured run(s) consumed a live-read or side-effect result; one conversation whose bot reads live data');
    const other = await run(world({ runs: [commandRun('run-cmd', '2026-09-28T12:10:00Z')] }), { startRun: false });
    expect(other.state).toBe('unavailable');
    expect(other.detail).toContain('live-read leg on run run-cmd: the tail from frame 1 reproduced 1 frame(s) and stopped at frame 2 before running execute_command (live-tool); from the consuming frame 3 it answered non-replayable');
    expect(other.evidence.skipped).toEqual(['run-cmd: not a question-tool run (it consumed write_to_file (workspace-write), which is not a read-only question tool)']);
    const noNode = await run(world({ runs: CAPTURED, noEndpoint: true }));
    expect(noNode.state).toBe('unavailable');
    expect(noNode.detail).toContain(`reproduced leg on run run-q: the producing bot ${JARVIS} has no reachable bot node, so the tail cannot run on an accountable node`);
    expect(noNode.detail).toContain(`live-read leg on run run-q: the producing bot ${JARVIS} has no reachable bot node`);
  });

  it('is unavailable when the started run captured nothing, the start was refused, or the bot is unknown', async () => {
    const off = await run(world({ captureOff: true }));
    expect(off.state).toBe('unavailable');
    expect(off.detail).toContain('starting one did not yield a capture: the run on oshal-assistant wrote no Token Chase capture (workspace no-capture after 30s): TOKEN_CHASE_CAPTURE is off on its node');
    expect(off.cleanup).toMatchObject({ removed: [`chat-task ${TAG}`], outstanding: [], errors: [] });
    const result = await run(world({ startFails: { status: 403, json: { error: 'caller_not_entitled_to_agent' } } }));
    expect(result.state).toBe('unavailable');
    expect(result.detail).toContain('POST /api/tasks/<tag>/messages on oshal-assistant answered HTTP 403 (caller_not_entitled_to_agent)');
    expect(result.cleanup).toMatchObject({ created: 1, removed: [`chat-task ${TAG}`], outstanding: [], errors: [] });
    const unknown = await run(world(), { agent: 'no-such-bot' });
    expect(unknown.state).toBe('unavailable');
    expect(unknown.detail).toContain('no registered bot is named no-such-bot');
    expect(unknown.cleanup).toEqual({ created: 0, removed: [], kept: [], outstanding: [], errors: [] });
  });

  it('under --expect-store-bound prefers a store-bound run and requires its store version reproduced', async () => {
    const plainRun = questionRun('run-q', '2026-09-28T12:20:00Z');
    const bound = questionRun('run-bound', '2026-09-28T12:00:00Z', { storeBound: true });
    const w = world({ runs: [plainRun, bound] });
    const result = await run(w, { expectStoreBound: true });
    expect(result.state).toBe('pass');
    expect(result.detail).toContain(REPRODUCED('run-bound', 1, 'conversation_query', FINAL_SHA, ' and the owner-store version reproduced'));
    expect(result.detail).toContain(LIVE_Q('run-bound'));
    expect(result.evidence.reproduced).toMatchObject({ runId: 'run-bound', storeBound: true, storeVersion: { bound: true, reproduced: true } });
    expect(w.log).toEqual(['replay run-bound from 1', 'replay run-bound from 2']);
    const unbound = await run(world({ runs: [plainRun] }), { expectStoreBound: true, startRun: false });
    expect(unbound.state).toBe('unavailable');
    expect(unbound.detail).toContain("reproduced leg: the only question-tool run(s) captured are not store-bound; set TOKEN_CHASE_OWNER_STORE_SNAPSHOT=on on that bot's node, recreate it, and capture one run there");
    expect(unbound.detail).toContain(LIVE_Q('run-q'));
    const started = await run(world(), { expectStoreBound: true });
    expect(started.state).toBe('unavailable');
    expect(started.detail).toContain('the run started on oshal-assistant is not store-bound; set TOKEN_CHASE_OWNER_STORE_SNAPSHOT=on');
    expect(started.detail).toContain(LIVE_Q(TAG));
    const diverged = await run(world({ runs: [plainRun, bound], storeDiverged: true }), { expectStoreBound: true });
    expect(diverged.state).toBe('fail');
    expect(diverged.detail).toContain('the tail replay did not reproduce the run: storeVersion bound true, reproduced false');
    const plain = await run(world({ runs: [plainRun, bound], storeDiverged: true }));
    expect(plain.state).toBe('pass');
    expect(plain.evidence.reproduced).toMatchObject({ runId: 'run-q', storeVersion: { baseline: null, replay: null, reproduced: null, bound: false } });
  });

  it('turns an unremoved workspace or a failed task delete into a red result', async () => {
    const left = await run(world({ removeFails: true }));
    expect(left.state).toBe('fail');
    expect(left.detail).toContain(`CLEANUP INCOMPLETE: ${TAG}: workspace ${TAG} still exists after removal; chat-task ${TAG} was not removed.`);
    const stuck = await run(world({ taskDeleteFails: true }));
    expect(stuck.state).toBe('fail');
    expect(stuck.detail).toContain(`CLEANUP INCOMPLETE: ${TAG}: task delete answered HTTP 500`);
  });

  it('is unavailable without a port, calling nothing, and is unavailable when the routes are not mounted', async () => {
    const w = world({ runs: CAPTURED });
    const result = await replay.run({ ...w.ports, workspace: undefined }, { tag: TAG, env: {} });
    expect(result.state).toBe('unavailable');
    expect(result.detail).toBe('This runner has no workspace port. Nothing was written.');
    expect(w.api.calls).toEqual([]);
    const unmounted = world();
    const missing = await replay.run({ ...unmounted.ports, api: fakeApi({}).api }, { tag: TAG, env: {} });
    expect(missing.state).toBe('unavailable');
    expect(missing.detail).toContain('GET /api/token-chase/runs answered HTTP 404 (the Token Chase routes are not mounted on this deployment)');
  });

  it('classifies runs from their pins: only a run that read through question tools alone, with a completed checkpoint, is a question-tool run', () => {
    const frames = (list: Frame[]) => list.map((f) => ({ seq: f.seq, phase: f.phase || 'closed', replayable: f.replayable !== false, pins: (f.pins || []).map((p) => ({ ...p, success: p.success !== false })) }));
    const asked = { reason: null, callingSeq: 1, consumingSeq: 2, liveTool: 'conversation_query', liveClass: 'live-read' };
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }, { seq: 2, pins: [query] }]), final: final() })).toEqual({ ...asked, kind: 'question', tools: ['conversation_query'], questionGap: null });
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }, { seq: 2, pins: [query] }, { seq: 3, pins: [fetched] }]), final: final() }))
      .toEqual({ ...asked, kind: 'question', tools: ['conversation_query', 'conversation_fetch'], questionGap: null });
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }, { seq: 2, pins: [failed] }, { seq: 3, pins: [query] }]), final: final() })).toMatchObject({ kind: 'question', questionGap: null });
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }, { seq: 2, pins: [failed] }]), final: final() })).toMatchObject({ kind: 'live', questionGap: 'every conversation_query call failed on the node' });
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }, { seq: 2, pins: [query] }]), final: final({ checkpointComplete: false }) })).toMatchObject({ kind: 'live', questionGap: 'final checkpoint is incomplete (bounded snapshot)' });
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }, { seq: 2, pins: [query] }]), final: final({ outcome: 'max-turns' }) })).toMatchObject({ kind: 'live', questionGap: 'final outcome max-turns' });
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }, { seq: 2, pins: [query] }]), final: final({ treeSha: null }) })).toMatchObject({ kind: 'live', questionGap: 'final checkpoint has no tree digest' });
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }, { seq: 2, pins: [query] }]), final: null })).toMatchObject({ kind: 'live', questionGap: 'no final checkpoint' });
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }, { seq: 2, pins: [query] }, { seq: 3, pins: [command] }]), final: final() }))
      .toMatchObject({ kind: 'live', callingSeq: 1, consumingSeq: 2, questionGap: 'it consumed execute_command (side-effect), which is not a read-only question tool' });
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }, { seq: 2, pins: [write] }, { seq: 3, pins: [command], replayable: false }]), final: final() }))
      .toEqual({ kind: 'live', reason: null, callingSeq: 2, consumingSeq: 3, liveTool: 'execute_command', liveClass: 'side-effect', tools: ['write_to_file', 'execute_command'],
        questionGap: 'it consumed write_to_file (workspace-write), which is not a read-only question tool' });
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }, { seq: 2, pins: [write] }, { seq: 3, pins: [read] }]), final: final() })).toEqual({ kind: 'other', reason: 'only workspace file-tool results consumed (write_to_file, read_file), no live read' });
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }]), final: final() })).toEqual({ kind: 'other', reason: 'no tool result consumed' });
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }, { seq: 2, pins: [query], phase: 'open' }]), final: final() })).toEqual({ kind: 'other', reason: 'a frame is still open' });
    expect(replay.classifyRun({ frames: frames([{ seq: 1, pins: [query] }]), final: final() })).toEqual({ kind: 'other', reason: 'frame 1 consumed conversation_query with no calling frame' });
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }, { seq: 2, pins: [{ tool: 'add', replayClass: 'pure', pinned: true }] }]), final: final() })).toEqual({ kind: 'other', reason: 'add is pure, neither a file tool nor live' });
    expect(replay.classifyRun({ frames: [], final: final() })).toEqual({ kind: 'other', reason: 'no frame' });
  });
});

/** The per-bot grants of the fixture deployment, by persisted tool name (auto and installed): the two conversation
 *  grants on the assistant, none on general-bot, and one bot granted the file tools. */
const GRANTS: Record<string, string[]> = { [JARVIS]: ['conversation-query', 'conversation-fetch'], [GENERAL]: [], [FILE_BOT]: ['read-file', 'write-file'] };
const BOTS = [{ agentId: GENERAL, name: 'general-bot' }, { agentId: JARVIS, name: 'oshal-assistant' }, { agentId: FILE_BOT, name: 'file-granted-bot' }];
/** Tool calls the scripted model knows how to write, in the XML form the agentic loop parses. */
const CALLS: Record<string, (words: string) => string> = {
  write_to_file: (words) => `<write_to_file><path>replay-check.txt</path><content>${words}</content></write_to_file>`,
  read_file: () => '<read_file><path>replay-check.txt</path></read_file>',
  conversation_query: (words) => `<conversation_query><query>${words}</query></conversation_query>`,
};

/**
 * The model turn, doubled and named: provider `scripted-fixture`, model `scripted-v1`. It does what the prompt asks, one
 * tool per turn in the order the prompt names them, then completes. It calls a tool only when its node offered it,
 * unless `insists`, which asks for the tool anyway.
 */
function scriptedModel(insists: boolean) {
  return {
    generateResponse: async (history: Array<{ role: string; content: unknown }>, options: { tools?: Array<{ name: string }> }) => {
      const prompt = String(history[0]?.content ?? '');
      const offered = (options.tools || []).map((tool) => tool.name);
      const wanted = Object.keys(CALLS).filter((name) => prompt.includes(name)).sort((a, b) => prompt.indexOf(a) - prompt.indexOf(b))
        .filter((name) => insists || offered.includes(name));
      const next = wanted[history.filter((message) => message.role === 'assistant').length];
      const content = next ? CALLS[next](TAG) : '<attempt_completion><result>done</result></attempt_completion>';
      return { content, contentBlocks: [], provider: 'scripted-fixture', model: 'scripted-v1', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, cost: 0 };
    },
  };
}

/** The tool registry exactly as a bot node builds it (src/app/bot-node-runtime.ts): empty, then the read-only question tools. */
function botNodeRegistry() {
  const registry = new ToolRegistry();
  registerBotNodeReadOnlyTools(registry as ReadOnlyToolRegistration, {
    pool: null, graphConnector: null, ragOwnerScopingIsDatabaseEnforced: async () => true,
    ragService: { search: async () => [], searchAllCollections: async () => [] } as unknown as BotNodeReadOnlyToolDeps['ragService'],
  });
  return registry;
}

/** The real controller tail service over the real node executor; the HTTP hop between them is the scoped double. */
function nodeTails(reader: TokenChaseReadService, replayRoot: string) {
  return new TokenChaseTailReplayService(reader, {
    hasEndpoint: (agentId) => agentId in GRANTS,
    replayTail: async (agentId, request) => {
      const verdict = await executeTailReplayOnNode({ agentId, authorize: (_req, _res, next) => next(), pool: null, ownerStore: createOwnerStoreSnapshotter(readOwnerStoreConfig({})), reader, replayRoot }, request);
      if (!verdict) throw new Error('Start frame not found');
      return verdict;
    },
    replayCall: async () => { throw new Error('a plain tail replay must never re-fire a provider'); },
  });
}

/** Each route of the case, carried to the service the real route calls. */
function realRoutes(reader: TokenChaseReadService, tails: TokenChaseTailReplayService, turn: (taskId: string, text: string, agentId: string) => Promise<void>): Record<string, FakeHandler> {
  return {
    'GET /api/token-chase/runs': async () => ({ status: 200, json: { runs: await reader.listRuns(ACCESS) } }),
    'GET /api/token-chase/runs/:id': async ({ params }) => ({ status: 200, json: { runId: params.id, frames: await reader.getFrames(params.id, ACCESS) } }),
    'GET /api/token-chase/runs/:id/frames/:seq': async ({ params }) => {
      const frame = await reader.getFrame(params.id, Number(params.seq), ACCESS);
      return frame ? { status: 200, json: { frame } } : { status: 404, json: { error: 'Frame not found' } };
    },
    'GET /api/token-chase/runs/:id/final': async ({ params }) => {
      const record = await reader.getFinal(params.id, ACCESS);
      return record ? { status: 200, json: { runId: params.id, final: record } } : { status: 404, json: { error: 'Final checkpoint not found' } };
    },
    'POST /api/token-chase/runs/:id/tail-replay': async ({ params, body }) => {
      const tailReplay = await tails.replayForward(params.id, (body as { fromFrame: number }).fromFrame, ACCESS);
      return tailReplay ? { status: 200, json: { tailReplay } } : { status: 404, json: { error: 'Start frame not found' } };
    },
    'GET /api/agents': () => ({ status: 200, json: { success: true, agents: BOTS } }),
    'POST /api/tasks/:id/messages': async ({ params, body }) => {
      const { text, agentId } = body as { text: string; agentId: string };
      await turn(params.id, text, agentId);
      return { status: 200, json: { success: true, taskId: params.id, taskIdUsed: params.id, agentId, ticketCreated: false, ticketId: null } };
    },
    'DELETE /api/tasks/:id': () => ({ status: 204 }),
  };
}

/**
 * A deployment whose bot nodes are real where the defect lived: the registry a bot node builds, the prompt authorization
 * resolver over the grant rows, the agentic loop with the capture lane on, the read service, the controller tail service
 * and the node's tail executor.
 */
function realDeployment(root: string, o: { insists?: boolean } = {}) {
  const registry = botNodeRegistry();
  const grantRows = { getAutoExecutableTools: async (agentId: string) => (GRANTS[agentId] || []).map((name) => ({ name, enabled: true, skills: [], authGroup: 'agent-tools' })) };
  const authorize = createPromptAuthorizationResolver(grantRows as unknown as Parameters<typeof createPromptAuthorizationResolver>[0])!;
  const reader = new TokenChaseReadService();
  const replayRoot = path.join(root, '.tokenchase-replays');
  const turn = async (taskId: string, text: string, agentId: string): Promise<void> => {
    const workspace = path.join(root, taskId);
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'brief.txt'), 'what the workspace held when the turn began\n');
    const authority = await authorize(agentId);
    const tasks = { getTask: async () => ({ id: taskId, workspace_dir: workspace, source: 'swarm', messages: [] }), addMessage: async () => undefined, updateMetrics: async () => undefined };
    const loop = new AgenticController({ bedrockProvider: scriptedModel(o.insists === true), clineProvider: null, claudeCodeProvider: null, codexProvider: null, antigravityProvider: null,
      getCurrentProvider: () => 'scripted-fixture' }, registry, { broadcast() {} }, tasks);
    await loop.processAgenticTask(taskId, text, [], { use_mcp_tool: true }, { agentId, source: 'swarm', allowedTools: authority.allowedTools, authorizedScopes: authority.scopes, extraEnv: { OSHAL_USER_SUB: OWNER } });
    await tokenChase.flush();
    await tokenChase.flush();
  };
  const api = fakeApi(realRoutes(reader, nodeTails(reader, replayRoot), turn));
  const ports = { api: api.api, ownerSub: OWNER, sql: async () => ({ rows: [{ chat_tasks: 0, chat_messages: 0, chat_tickets: 0, work_items: 0 }] }),
    workspace: { state: async (id: string) => common.fixtureWorkspaceState(root, id), remove: async (id: string) => common.removeFixtureWorkspace(root, id, OWNER) } };
  return { registry, reader, api, ports, turn, replayRoot };
}

describe('token-chase-replay live acceptance against the real bot-node registry, loop, capture and tail', () => {
  const ROOT_KEYS = ['SHARED_WORKSPACE_ROOT', 'OSHAL_WORKSPACE_ROOT'];
  const saved: Record<string, string | undefined> = {};
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-replay-case-'));
    for (const key of ROOT_KEYS) { saved[key] = process.env[key]; process.env[key] = root; }
  });

  afterAll(() => {
    for (const key of ROOT_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Every frame of a captured run, as the read service serves it to its owner. */
  async function framesOf(node: ReturnType<typeof realDeployment>, runId: string) {
    const summaries = await node.reader.getFrames(runId, ACCESS);
    return Promise.all(summaries.map(async (summary) => (await node.reader.getFrame(runId, summary.seq, ACCESS))!));
  }

  it('captures with the flag on, and the case names exactly the tools a bot node registers, each a live read', () => {
    expect(tokenChase.isEnabled(), 'TOKEN_CHASE_CAPTURE must be on before the capture lane loads').toBe(true);
    const tools = realDeployment(root).registry.getAll() as Array<{ name: string; requiresApproval: boolean }>;
    expect(tools.map((tool) => tool.name)).toEqual([...replay.QUESTION_TOOLS]);
    expect([...replay.QUESTION_TOOLS]).toEqual([...BOT_NODE_READ_ONLY_TOOL_NAMES]);
    expect(replay.QUESTION_TOOLS).toContain(replay.RUN_TOOL);
    for (const tool of tools) {
      expect(tool.requiresApproval, tool.name).toBe(false);
      expect(classifyTool(tool), tool.name).toEqual({ replayClass: 'live-read', declared: false });
    }
  });

  it('a bot granted the file tools still runs none of them on a bot node, even for a model that asks anyway', async () => {
    const node = realDeployment(root, { insists: true });
    await node.turn('run-file-ask', 'Call write_to_file to create replay-check.txt, then call read_file on replay-check.txt, then finish.', FILE_BOT);
    try {
      const frames = await framesOf(node, 'run-file-ask');
      expect(frames.map((frame) => frame.tools)).toEqual([['attempt_completion'], ['attempt_completion'], ['attempt_completion']]);
      expect(frames.flatMap((frame) => (frame.pins as unknown[]) || [])).toEqual([]);
      expect(frames.map((frame) => frame.responseContent)[0]).toContain('<write_to_file>');
      expect(fs.readdirSync(path.join(root, 'run-file-ask')).sort()).toEqual(['.tokenchase', 'brief.txt']);
    } finally {
      fs.rmSync(path.join(root, 'run-file-ask'), { recursive: true, force: true });
    }
  }, 60_000);

  it('passes both legs on the run it starts on oshal-assistant, through the real registry, and removes it', async () => {
    const node = realDeployment(root);
    const result = await replay.run(node.ports, { tag: TAG, env: {} });
    expect(result.detail).toContain(REPRODUCED(TAG, 1, 'conversation_query', result.evidence.reproduced?.finalTreeSha));
    expect(result.detail).toContain(LIVE_Q(TAG));
    expect(result.state).toBe('pass');
    expect(result.evidence).toMatchObject({ agent: 'oshal-assistant', runsListed: 0, started: { tag: TAG, agentId: JARVIS, state: 'final' },
      reproduced: { runId: TAG, fromFrame: 1, agentId: JARVIS, tools: ['conversation_query'], status: 'stopped', toolCalls: 0, paidCalls: 0, storeBound: false,
        restore: { source: 'commit', filesRestored: 1, integrity: 'ok' }, artifacts: { reproduced: true, differingPaths: [], complete: true } },
      live: { runId: TAG, liveTool: 'conversation_query', liveClass: 'live-read', callingSeq: 1, consumingSeq: 2, consumingFrameReplayable: false } });
    expect(result.evidence.reproduced.finalTreeSha).toMatch(/^[0-9a-f]{64}$/);
    expect(result.evidence.reproduced.artifacts.replayTreeSha).toBe(result.evidence.reproduced.finalTreeSha);
    expect(result.evidence.live.fromStart.frames).toMatchObject([{ seq: 1, status: 'live-tool', tool: 'conversation_query', replayClass: 'live-read' }]);
    expect(result.evidence.live.fromConsumer.frames).toMatchObject([{ seq: 2, status: 'non-replayable' }]);
    expect(node.api.calls.filter((call) => call.path.endsWith('/tail-replay')).map((call) => call.body)).toEqual([{ fromFrame: 1 }, { fromFrame: 2 }]);
    expect(result.cleanup).toMatchObject({ created: 1, removed: [`chat-task ${TAG}`], outstanding: [], errors: [] });
    expect(fs.existsSync(path.join(root, TAG))).toBe(false);
    expect(fs.readdirSync(node.replayRoot)).toEqual([]);
  }, 60_000);

  it('passes on a captured question-tool run without starting one, and leaves that run in place', async () => {
    const node = realDeployment(root);
    await node.turn('run-captured', replay.runPrompt('run-captured'), JARVIS);
    try {
      const frames = await framesOf(node, 'run-captured');
      expect(frames.map((frame) => frame.tools)).toEqual([OFFERED, OFFERED]);
      expect(frames.map((frame) => frame.replayable)).toEqual([true, false]);
      expect(frames[1].pins).toMatchObject([{ tool: 'conversation_query', replayClass: 'live-read', declared: false, pinned: false, success: true }]);
      const result = await replay.run(node.ports, { tag: TAG, env: {}, startRun: false });
      expect(result.detail).toContain(REPRODUCED('run-captured', 1, 'conversation_query', result.evidence.reproduced?.finalTreeSha));
      expect(result.state).toBe('pass');
      expect(result.evidence).toMatchObject({ runsListed: 1, runsScanned: 1, started: null, skipped: [] });
      expect(result.cleanup).toEqual({ created: 0, removed: [], kept: [], outstanding: [], errors: [] });
      expect(node.api.calls.filter((call) => call.method !== 'GET').map((call) => call.path)).toEqual(['/api/token-chase/runs/run-captured/tail-replay', '/api/token-chase/runs/run-captured/tail-replay']);
      expect(fs.readdirSync(path.join(root, 'run-captured')).sort()).toEqual(['.tokenchase', 'brief.txt']);
    } finally {
      fs.rmSync(path.join(root, 'run-captured'), { recursive: true, force: true });
    }
  }, 60_000);

  it('names the missing grant when the bot it starts on holds none, and removes the run', async () => {
    const node = realDeployment(root);
    const result = await replay.run(node.ports, { tag: TAG, env: { OSHAL_VERIFY_TOKEN_CHASE_AGENT: 'general-bot' } });
    expect(result.state).toBe('unavailable');
    expect(result.detail).toContain('reproduced leg: the run started on general-bot consumed no tool result: its node offered the model attempt_completion and not conversation_query, '
      + 'so the node resolved no executable grant (auto and installed) of conversation_query for general-bot.');
    expect(result.detail).toContain(HOST_COMMAND);
    expect(result.evidence).toMatchObject({ agent: 'general-bot', started: { tag: TAG, agentId: GENERAL, state: 'final' } });
    expect(node.api.calls.filter((call) => call.path.endsWith('/tail-replay'))).toEqual([]);
    expect(result.cleanup).toMatchObject({ created: 1, removed: [`chat-task ${TAG}`], outstanding: [], errors: [] });
    expect(fs.existsSync(path.join(root, TAG))).toBe(false);
  }, 60_000);
});
