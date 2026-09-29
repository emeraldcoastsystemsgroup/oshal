/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the token-chase-replay live-acceptance case's own logic over a doubled Token Chase API (run listing, frame summaries and details with per-frame pins, the final checkpoint, a tail-replay route whose verdict is computed from the run's pins the way the node's runner reports it, the agents list, the chat message route that starts a captured run, task delete, the workspace and residue ports): a file-tools-only run reproduced (status, artifacts.reproduced, no differing path, replayTreeSha equal to the independently read final treeSha, 0 paid calls) and a live-read run stopped at the calling frame with live-tool and non-replayable from the consuming frame = pass, starting nothing; with no file-tools run captured, one tagged run started on the named bot, replayed and removed (task, workspace, residue zero). Red: a differing path, a node that says reproduced beside a differing path, a wrong tree digest, a live-tool stop reported as reproduced, a consuming frame replayed instead of refused, a store-bound run whose store version did not reproduce under --expect-store-bound, an unremoved workspace, a failed task delete. Unavailable, never pass: no live-read run, nothing captured, a started run that used a side-effect tool (removed), a bot with no reachable node, capture off on the started run, a refused start, an unbound run under --expect-store-bound, a missing port. The real companion is `node scripts/operations/live-acceptance.js token-chase-replay` on the box; the route, runner and node boundaries are proven by tests/unit/token-chase-*.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { fakeApi, fakeClock, type FakeReply } from '../fixtures/live-acceptance-fake-api';

const requireCjs = createRequire(import.meta.url);
const replay = requireCjs('../../scripts/lib/live-acceptance-token-chase-replay.js');

const OWNER = 'fixture|replay-owner';
const TAG = 'testlab-live-token-chase-replay-0a1b2c3d';
const AGENT = 'a0000000-0000-0000-0000-000000000099';
const FINAL_SHA = 'f'.repeat(64);
const OTHER_SHA = 'e'.repeat(64);
const STORE_SHA = 'd'.repeat(64);
const HOST_COMMAND = 'OSHAL_VERIFY_TOKEN_CHASE_AGENT="<bot name>" node scripts/operations/live-acceptance.js token-chase-replay';

interface Pin { tool: string; replayClass: string; pinned: boolean; declared?: boolean }
interface Frame { seq: number; phase?: string; replayable?: boolean; pins?: Pin[] }
interface Final { outcome: string; treeSha: string | null; checkpointComplete: boolean; storeBound: boolean; ownerStoreVersion: string | null }
interface Run { runId: string; kind: 'file' | 'live' | 'chat' | 'reads'; frames: Frame[]; final: Final | null; modified: string; agentId?: string }

const write: Pin = { tool: 'write_to_file', replayClass: 'workspace-write', pinned: true, declared: true };
const read: Pin = { tool: 'read_file', replayClass: 'workspace-read', pinned: true, declared: true };
const query: Pin = { tool: 'conversation_query', replayClass: 'live-read', pinned: false, declared: false };
const command: Pin = { tool: 'execute_command', replayClass: 'side-effect', pinned: false, declared: true };

function final(o: Partial<Final> = {}): Final {
  return { outcome: 'completed', treeSha: FINAL_SHA, checkpointComplete: true, storeBound: false, ownerStoreVersion: null, ...o };
}
/** A run that wrote then read one file: frames 1 (calls write), 2 (consumes write, calls read), 3 (consumes read, completes). */
function fileRun(runId: string, modified: string, o: { storeBound?: boolean } = {}): Run {
  return { runId, kind: 'file', modified, frames: [{ seq: 1, pins: [] }, { seq: 2, pins: [write] }, { seq: 3, pins: [read] }],
    final: final({ storeBound: o.storeBound === true, ownerStoreVersion: o.storeBound ? STORE_SHA : null }) };
}
/** A run whose frame 2 called a live read that frame 3 consumed (non-replayable), after one file write. */
function liveRun(runId: string, modified: string, pin: Pin = query): Run {
  return { runId, kind: 'live', modified, frames: [{ seq: 1, pins: [] }, { seq: 2, pins: [write] }, { seq: 3, pins: [pin], replayable: false }], final: final() };
}
/** A plain conversation: one frame, no tool result consumed. */
function chatRun(runId: string, modified: string): Run {
  return { runId, kind: 'chat', modified, frames: [{ seq: 1, pins: [] }], final: final() };
}

interface WorldOptions {
  runs?: Run[]; diverge?: boolean; inconsistent?: boolean; wrongTreeSha?: boolean; paid?: boolean; noEndpoint?: boolean; storeDiverged?: boolean;
  liveAsReproduced?: boolean; consumerRuns?: boolean; startFails?: FakeReply; startAborts?: boolean; startedPin?: Pin; captureOff?: boolean;
  removeFails?: boolean; taskDeleteFails?: boolean; agents?: Array<{ agentId: string; name: string }>; runningPolls?: number;
}

/** The node's verdict for a tail of one run, as the controller relays it. */
function nodeVerdict(run: Run, fromFrame: number, o: WorldOptions): Record<string, unknown> {
  const frames = run.frames.filter((f) => f.seq >= fromFrame);
  const stop = (stoppedAtFrame: number, outcomes: unknown[], stopReason: string) => ({ status: 'stopped', stoppedAtFrame, stopReason, frames: outcomes, toolCalls: outcomes.length - 1,
    restore: { source: 'commit', integrity: 'ok' }, artifacts: { baselineTreeSha: FINAL_SHA, replayTreeSha: null, reproduced: null, differingPaths: [] },
    storeVersion: { baseline: null, replay: null, reproduced: null, bound: false }, paidCalls: 0, totalCostUsd: 0 });
  if (o.noEndpoint) return stop(fromFrame, [], `No reachable bot node for agent ${AGENT} — replay must run on an accountable node.`);
  const reproduced = () => {
    const outcomes = frames.map((f, i) => (i === frames.length - 1 ? { seq: f.seq, status: 'completed', tool: 'attempt_completion' }
      : { seq: f.seq, status: 'reproduced', tool: frames[i + 1].pins?.[0]?.tool ?? null, pinVerified: true }));
    const bound = run.final?.storeBound === true;
    return { status: o.diverge ? 'diverged' : 'reproduced', stoppedAtFrame: null, stopReason: null, frames: outcomes, toolCalls: outcomes.length - 1,
      restore: { source: 'commit', integrity: 'ok' },
      artifacts: { baselineTreeSha: FINAL_SHA, replayTreeSha: o.wrongTreeSha ? OTHER_SHA : FINAL_SHA, reproduced: !o.diverge, differingPaths: o.diverge || o.inconsistent ? ['replay-check.txt'] : [], redactedPaths: [], complete: true },
      storeVersion: bound ? { baseline: STORE_SHA, replay: o.storeDiverged ? OTHER_SHA : STORE_SHA, reproduced: !o.storeDiverged, bound: true } : { baseline: null, replay: null, reproduced: null, bound: false },
      paidCalls: o.paid ? 1 : 0, totalCostUsd: 0 };
  };
  if (run.kind !== 'live') return reproduced();
  const consuming = run.frames.find((f) => f.pins?.some((p) => !p.pinned))!;
  const live = consuming.pins![0];
  if (fromFrame < consuming.seq) {
    if (o.liveAsReproduced) return reproduced();
    const before = frames.filter((f) => f.seq < consuming.seq - 1).map((f, i) => ({ seq: f.seq, status: 'reproduced', tool: frames[i + 1].pins?.[0]?.tool ?? null }));
    return stop(consuming.seq - 1, [...before, { seq: consuming.seq - 1, status: 'live-tool', tool: live.tool, replayClass: live.replayClass,
      reason: `Frame ${consuming.seq - 1} calls ${live.tool} (${live.replayClass}), which the hermetic tail refuses.` }], 'live tool');
  }
  if (o.consumerRuns) return reproduced();
  return stop(consuming.seq, [{ seq: consuming.seq, status: 'non-replayable', tool: null, reason: `Frame ${consuming.seq} depends on a live read.` }], 'non-replayable');
}

/** The doubled deployment: captured runs, the tail-replay node verdicts, the chat route that starts a run, and its cleanup. */
function world(o: WorldOptions = {}) {
  const runs = new Map<string, Run>((o.runs || []).map((r) => [r.runId, r]));
  const chatTasks = new Set<string>();
  const log: string[] = [];
  const statements: Array<{ name: string; params: unknown[] }> = [];
  let polls = 0;
  const detail = (run: Run, f: Frame) => ({ seq: f.seq, phase: f.phase || 'closed', replayable: f.replayable !== false, agentId: run.agentId || AGENT, ownerSub: OWNER,
    ownerStoreVersion: run.final?.ownerStoreVersion ?? null, pins: f.pins || [], history: [{ role: 'user', content: 'fixture' }], toolSchema: [] });
  const startRun = (id: string) => {
    chatTasks.add(id);
    runs.set(id, o.captureOff ? { runId: id, kind: 'chat', modified: '2026-09-28T13:00:00Z', frames: [], final: null }
      : o.startedPin ? liveRun(id, '2026-09-28T13:00:00Z', o.startedPin) : fileRun(id, '2026-09-28T13:00:00Z'));
    log.push('start');
  };
  const api = fakeApi({
    'GET /api/token-chase/runs': () => ({ status: 200, json: { runs: [...runs.values()].filter((r) => r.frames.length).sort((a, b) => b.modified.localeCompare(a.modified))
      .map((r) => ({ runId: r.runId, frameCount: r.frames.length, modified: r.modified })) } }),
    'GET /api/token-chase/runs/:id': ({ params }) => {
      const run = runs.get(params.id);
      return { status: 200, json: { runId: params.id, frames: run ? run.frames.map((f) => ({ seq: f.seq, phase: f.phase || 'closed', replayable: f.replayable !== false, tools: [] })) : [] } };
    },
    'GET /api/token-chase/runs/:id/frames/:seq': ({ params }) => {
      const run = runs.get(params.id);
      const frame = run?.frames.find((f) => f.seq === Number(params.seq));
      return run && frame ? { status: 200, json: { frame: detail(run, frame) } } : { status: 404, json: { error: 'Frame not found' } };
    },
    'GET /api/token-chase/runs/:id/final': ({ params }) => {
      const run = runs.get(params.id);
      return run?.final ? { status: 200, json: { runId: params.id, final: { taskId: params.id, ...run.final } } } : { status: 404, json: { error: 'Final checkpoint not found' } };
    },
    'POST /api/token-chase/runs/:id/tail-replay': ({ params, body }) => {
      const run = runs.get(params.id);
      log.push(`replay ${params.id} from ${(body as { fromFrame: number }).fromFrame}`);
      return run ? { status: 200, json: { tailReplay: { runId: params.id, fromFrame: (body as { fromFrame: number }).fromFrame, agentId: AGENT, ...nodeVerdict(run, (body as { fromFrame: number }).fromFrame, o) } } }
        : { status: 404, json: { error: 'Start frame not found' } };
    },
    'GET /api/agents': () => ({ status: 200, json: { success: true, agents: o.agents || [{ agentId: AGENT, name: 'general-bot', status: 'online' }] } }),
    'POST /api/tasks/:id/messages': ({ params }) => {
      if (o.startFails) return o.startFails;
      startRun(params.id);
      if (o.startAborts) throw new Error('The operation was aborted due to timeout');
      return { status: 200, json: { success: true, taskId: params.id, taskIdUsed: params.id, agentId: AGENT, ticketCreated: false, ticketId: null } };
    },
    'DELETE /api/tasks/:id': ({ params }) => {
      if (o.taskDeleteFails) return { status: 500, json: { error: 'Failed to delete task' } };
      const had = chatTasks.delete(params.id);
      log.push('delete-task');
      return { status: had ? 204 : 404 };
    },
  });
  const workspace = {
    state: async (id: string) => {
      if (!runs.has(id)) return 'absent';
      const run = runs.get(id)!;
      if (!run.frames.length) return 'no-capture';
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
const BOTH = [chatRun('run-chat', '2026-09-28T12:30:00Z'), liveRun('run-live', '2026-09-28T12:20:00Z'), fileRun('run-file', '2026-09-28T12:10:00Z')];

describe('token-chase-replay live acceptance', () => {
  it('passes on a captured file-tools run reproduced and a live-read run stopped, starting nothing', async () => {
    const w = world({ runs: BOTH });
    const result = await run(w);
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('reproduced leg on run run-file: the no-edit tail reproduced the final tree on the bot node (2 tool call(s) re-executed, replayTreeSha '
      + `${FINAL_SHA}, no differing path, 0 paid calls)`);
    expect(result.detail).toContain('live-read leg on run run-live: the tail from frame 1 reproduced 1 frame(s) and stopped at frame 2 before running conversation_query (live-tool); '
      + 'from the consuming frame 3 it answered non-replayable');
    expect(result.evidence).toMatchObject({ agent: 'general-bot', expectStoreBound: false, runsListed: 3, runsScanned: 3, started: null,
      reproduced: { runId: 'run-file', fromFrame: 1, tools: ['write_to_file', 'read_file'], finalTreeSha: FINAL_SHA, status: 'reproduced', storeBound: false, toolCalls: 2, paidCalls: 0 },
      live: { runId: 'run-live', liveTool: 'conversation_query', liveClass: 'live-read', callingSeq: 2, consumingSeq: 3, consumingFrameReplayable: false, fromStart: { status: 'stopped', stoppedAtFrame: 2 }, fromConsumer: { status: 'stopped', stoppedAtFrame: 3 } } });
    expect(result.evidence.reproduced.artifacts.replayTreeSha).toBe(FINAL_SHA);
    expect(result.evidence.skipped).toEqual(['run-chat: no tool result consumed']);
    expect(w.log).toEqual(['replay run-file from 1', 'replay run-live from 1', 'replay run-live from 3']);
    expect(w.api.calls.filter((c) => c.method !== 'GET')).toHaveLength(3);
    expect(result.cleanup).toEqual({ created: 0, removed: [], kept: [], outstanding: [], errors: [] });
    expect(result.detail).not.toContain('Nothing was written');
  });

  it('starts one tagged file-tools run on the named bot when none is captured, replays it and removes it', async () => {
    const w = world({ runs: [chatRun('run-chat', '2026-09-28T12:30:00Z'), liveRun('run-live', '2026-09-28T12:20:00Z')] });
    const result = await run(w);
    expect(result.state).toBe('pass');
    expect(result.detail).toContain(`reproduced leg on run ${TAG}: the no-edit tail reproduced the final tree on the bot node`);
    const start = w.api.calls.find((c) => c.method === 'POST' && c.path === `/api/tasks/${TAG}/messages`)!;
    expect(start.body).toEqual({ text: replay.runPrompt(TAG), agentId: AGENT, agenticMode: true });
    expect(replay.runPrompt(TAG)).toContain(`create ${replay.ARTIFACT_FILE}`);
    expect(replay.runPrompt(TAG)).toContain('Do not run any command');
    expect(w.log).toEqual(['start', `replay ${TAG} from 1`, 'replay run-live from 1', 'replay run-live from 3', 'delete-task', 'remove-workspace']);
    expect(result.evidence.started).toEqual({ tag: TAG, agentId: AGENT, state: 'final' });
    expect(result.cleanup).toMatchObject({ created: 1, removed: [`chat-task ${TAG}`], outstanding: [], errors: [] });
    expect(w.statements).toEqual([{ name: 'jarvis.residue', params: [OWNER, [TAG]] }]);
    expect(w.runs.has(TAG)).toBe(false);
    expect(w.chatTasks.size).toBe(0);
  });

  it('follows a started run the HTTP ceiling cut off until its capture closes', async () => {
    const w = world({ runs: [liveRun('run-live', '2026-09-28T12:20:00Z')], startAborts: true, runningPolls: 3 });
    const result = await run(w);
    expect(result.state).toBe('pass');
    expect(result.evidence.started).toEqual({ tag: TAG, agentId: AGENT, state: 'final' });
    expect(result.cleanup).toMatchObject({ removed: [`chat-task ${TAG}`], outstanding: [], errors: [] });
  });

  it('fails on a differing path, on a node that says reproduced beside a differing path, and on a wrong tree digest', async () => {
    const diverged = await run(world({ runs: BOTH, diverge: true }));
    expect(diverged.state).toBe('fail');
    expect(diverged.detail).toContain('reproduced leg on run run-file: the tail replay did not reproduce the run: status diverged; artifacts.reproduced false; differing paths replay-check.txt');
    const inconsistent = await run(world({ runs: BOTH, inconsistent: true }));
    expect(inconsistent.state).toBe('fail');
    expect(inconsistent.detail).toContain('the tail replay did not reproduce the run: differing paths replay-check.txt');
    const wrong = await run(world({ runs: BOTH, wrongTreeSha: true }));
    expect(wrong.state).toBe('fail');
    expect(wrong.detail).toContain(`replayTreeSha ${OTHER_SHA} is not final.checkpoint.treeSha ${FINAL_SHA}`);
    const paid = await run(world({ runs: BOTH, paid: true }));
    expect(paid.state).toBe('fail');
    expect(paid.detail).toContain('1 paid call(s) in a plain tail');
  });

  it('fails when a live-tool stop is reported as reproduced, or the consuming frame is replayed instead of refused', async () => {
    const asReproduced = await run(world({ runs: BOTH, liveAsReproduced: true }));
    expect(asReproduced.state).toBe('fail');
    expect(asReproduced.detail).toContain('live-read leg on run run-live: the live-read run did not stop as required: from the first frame the status is reproduced, not stopped');
    expect(asReproduced.detail).toContain('reproduced leg on run run-file: the no-edit tail reproduced');
    const consumed = await run(world({ runs: BOTH, consumerRuns: true }));
    expect(consumed.state).toBe('fail');
    expect(consumed.detail).toContain('from the consuming frame 3 the status is reproduced stopped at null');
    expect(consumed.detail).toContain("the consuming frame's status is completed, not non-replayable");
  });

  it('is unavailable, never pass, when a leg has no suitable run, naming what produces one', async () => {
    const noLive = await run(world({ runs: [fileRun('run-file', '2026-09-28T12:10:00Z')] }));
    expect(noLive.state).toBe('unavailable');
    expect(noLive.detail).toContain('reproduced leg on run run-file: the no-edit tail reproduced');
    expect(noLive.detail).toContain('live-read leg: none of the 1 newest captured run(s) consumed a live-read or side-effect result; one conversation whose bot reads live data');
    expect(noLive.detail).toContain('Nothing was written.');
    const nothing = await run(world(), { startRun: false });
    expect(nothing.state).toBe('unavailable');
    expect(nothing.detail).toContain('reproduced leg: no captured run consumed only workspace file-tool results with a completed final checkpoint (no run was started: startRun is off)');
    expect(nothing.detail).toContain('live-read leg: nothing is captured yet (TOKEN_CHASE_CAPTURE on a bot node plus one agentic run)');
    const w = world({ runs: [liveRun('run-live', '2026-09-28T12:20:00Z')], startedPin: command });
    const sideEffect = await run(w);
    expect(sideEffect.state).toBe('unavailable');
    expect(sideEffect.detail).toContain(`reproduced leg: the run started on general-bot is not file-tools-only (it consumed execute_command (side-effect)); name a bot that answers such a turn with its file tools alone: ${HOST_COMMAND}`);
    expect(sideEffect.detail).not.toContain('Nothing was written');
    expect(sideEffect.cleanup).toMatchObject({ created: 1, removed: [`chat-task ${TAG}`], outstanding: [], errors: [] });
    expect(w.runs.has(TAG)).toBe(false);
    const noNode = await run(world({ runs: BOTH, noEndpoint: true }));
    expect(noNode.state).toBe('unavailable');
    expect(noNode.detail).toContain(`reproduced leg on run run-file: the producing bot ${AGENT} has no reachable bot node, so the tail cannot run on an accountable node`);
    expect(noNode.detail).toContain(`live-read leg on run run-live: the producing bot ${AGENT} has no reachable bot node`);
  });

  it('is unavailable when the started run captured nothing, the start was refused, or the bot is unknown', async () => {
    const off = await run(world({ runs: [liveRun('run-live', '2026-09-28T12:20:00Z')], captureOff: true }));
    expect(off.state).toBe('unavailable');
    expect(off.detail).toContain('starting one did not yield a capture: the run on general-bot wrote no Token Chase capture (workspace no-capture after 30s): TOKEN_CHASE_CAPTURE is off on its node');
    expect(off.cleanup).toMatchObject({ removed: [`chat-task ${TAG}`], outstanding: [], errors: [] });
    const refused = world({ runs: [liveRun('run-live', '2026-09-28T12:20:00Z')], startFails: { status: 403, json: { error: 'caller_not_entitled_to_agent' } } });
    const result = await run(refused);
    expect(result.state).toBe('unavailable');
    expect(result.detail).toContain('POST /api/tasks/<tag>/messages on general-bot answered HTTP 403 (caller_not_entitled_to_agent)');
    expect(result.cleanup).toMatchObject({ created: 1, removed: [`chat-task ${TAG}`], outstanding: [], errors: [] });
    const unknown = await run(world({ runs: [liveRun('run-live', '2026-09-28T12:20:00Z')] }), { agent: 'no-such-bot' });
    expect(unknown.state).toBe('unavailable');
    expect(unknown.detail).toContain('no registered bot is named no-such-bot');
    expect(unknown.cleanup).toEqual({ created: 0, removed: [], kept: [], outstanding: [], errors: [] });
  });

  it('under --expect-store-bound prefers a store-bound run and requires its store version reproduced', async () => {
    const bound = fileRun('run-bound', '2026-09-28T12:00:00Z', { storeBound: true });
    const w = world({ runs: [...BOTH, bound] });
    const result = await run(w, { expectStoreBound: true });
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('reproduced leg on run run-bound: the no-edit tail reproduced the final tree and the owner-store version on the bot node');
    expect(result.evidence.reproduced).toMatchObject({ runId: 'run-bound', storeBound: true, storeVersion: { bound: true, reproduced: true } });
    expect(w.log).toContain('replay run-bound from 1');
    expect(w.log).not.toContain('replay run-file from 1');
    const unbound = await run(world({ runs: BOTH }), { expectStoreBound: true, startRun: false });
    expect(unbound.state).toBe('unavailable');
    expect(unbound.detail).toContain("reproduced leg: the only file-tools run(s) captured are not store-bound; set TOKEN_CHASE_OWNER_STORE_SNAPSHOT=on on that bot's node, recreate it, and capture one run there");
    const started = await run(world({ runs: [liveRun('run-live', '2026-09-28T12:20:00Z')] }), { expectStoreBound: true });
    expect(started.state).toBe('unavailable');
    expect(started.detail).toContain('the run started on general-bot is not store-bound; set TOKEN_CHASE_OWNER_STORE_SNAPSHOT=on');
    const diverged = await run(world({ runs: [...BOTH, bound], storeDiverged: true }), { expectStoreBound: true });
    expect(diverged.state).toBe('fail');
    expect(diverged.detail).toContain('the tail replay did not reproduce the run: storeVersion bound true, reproduced false');
    const plain = await run(world({ runs: [...BOTH, bound], storeDiverged: true }));
    expect(plain.state).toBe('pass');
    expect(plain.evidence.reproduced.storeVersion).toEqual({ baseline: null, replay: null, reproduced: null, bound: false });
  });

  it('turns an unremoved workspace or a failed task delete into a red result', async () => {
    const left = await run(world({ runs: [liveRun('run-live', '2026-09-28T12:20:00Z')], removeFails: true }));
    expect(left.state).toBe('fail');
    expect(left.detail).toContain(`CLEANUP INCOMPLETE: ${TAG}: workspace ${TAG} still exists after removal; chat-task ${TAG} was not removed.`);
    const stuck = await run(world({ runs: [liveRun('run-live', '2026-09-28T12:20:00Z')], taskDeleteFails: true }));
    expect(stuck.state).toBe('fail');
    expect(stuck.detail).toContain(`CLEANUP INCOMPLETE: ${TAG}: task delete answered HTTP 500`);
  });

  it('is unavailable without a port, calling nothing, and is unavailable when the routes are not mounted', async () => {
    const w = world({ runs: BOTH });
    const result = await replay.run({ ...w.ports, workspace: undefined }, { tag: TAG, env: {} });
    expect(result.state).toBe('unavailable');
    expect(result.detail).toBe('This runner has no workspace port. Nothing was written.');
    expect(w.api.calls).toEqual([]);
    const unmounted = world();
    const missing = await replay.run({ ...unmounted.ports, api: fakeApi({}).api }, { tag: TAG, env: {} });
    expect(missing.state).toBe('unavailable');
    expect(missing.detail).toContain('GET /api/token-chase/runs answered HTTP 404 (the Token Chase routes are not mounted on this deployment)');
  });

  it('classifies runs from their pins: reads only, an open frame, a live pin with no calling frame and an unknown class are never file-only', () => {
    const frames = (list: Frame[]) => list.map((f) => ({ seq: f.seq, phase: f.phase || 'closed', replayable: f.replayable !== false, pins: f.pins || [] }));
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }, { seq: 2, pins: [read] }]), final: final() })).toEqual({ kind: 'other', reason: 'file reads only, nothing written' });
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }, { seq: 2, pins: [write], phase: 'open' }]), final: final() })).toEqual({ kind: 'other', reason: 'a frame is still open' });
    expect(replay.classifyRun({ frames: frames([{ seq: 1, pins: [query] }]), final: final() })).toEqual({ kind: 'other', reason: 'frame 1 consumed conversation_query with no calling frame' });
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }, { seq: 2, pins: [{ tool: 'add', replayClass: 'pure', pinned: true }] }]), final: final() })).toEqual({ kind: 'other', reason: 'add is pure, neither a file tool nor live' });
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }, { seq: 2, pins: [write] }]), final: final({ checkpointComplete: false }) })).toEqual({ kind: 'other', reason: 'final checkpoint is incomplete (bounded snapshot)' });
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }, { seq: 2, pins: [write] }]), final: null })).toEqual({ kind: 'other', reason: 'no final checkpoint' });
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }, { seq: 2, pins: [write] }]), final: final() })).toEqual({ kind: 'file-only', reason: null, tools: ['write_to_file'] });
    expect(replay.classifyRun({ frames: frames([{ seq: 1 }, { seq: 2, pins: [write] }, { seq: 3, pins: [command], replayable: false }]), final: final() }))
      .toEqual({ kind: 'live', reason: null, callingSeq: 2, consumingSeq: 3, liveTool: 'execute_command', liveClass: 'side-effect', tools: ['write_to_file'] });
  });
});
