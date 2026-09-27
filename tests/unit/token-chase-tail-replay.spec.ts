/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Token Chase forward TAIL replay (ADR-046 §1/§8): it restages frame N's content-addressed workspace tree (hash-verified, into an isolated root), replays N..end on the accountable bot, STOPS at the first divergence reporting WHICH frame + why, serves pinned reads while warning on unpinned ones per-frame, and — the backward-compat contract — still single-replays frames that carry no pins/workspaceTree.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The controller delegates (BACKLOG "Workspace-bound checkpoint and tail replay"): replayForward hands the run, start frame and caller access to the producing bot node's replayTail and relays its verdict verbatim (reproduced, diverged with the differing paths, stopped at a live tool); it never restores, executes or writes anything itself (no fs import, no restage method); 'no-endpoint' stays fail-closed with NO node call; and the prompt re-fire pass runs only when asked (refire:true), keeping the divergence stop, the fromFrame start, the pinned/unpinned warnings and the non-replayable stop. The bot-side execution is a double here by design — the real route is proven in token-chase-bot-tail-route.spec.ts and end to end in token-chase-checkpoint-replay-e2e.spec.ts.
 */

import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  TokenChaseTailReplayService,
  type TailFrameSource,
  type TailReplayCallResponse,
  type TailReplayer,
} from '../../src/features/token-chase/services/token-chase-tail-replay-service';
import type { TokenChaseFrameDetail, TokenChaseAccess } from '../../src/features/token-chase/services/token-chase-read-service';
import type { TailReplayNodeRequest, TailReplayNodeResponse } from '../../src/features/agent-management/services/bot-node-tail-replay-client';

const ACCESS: TokenChaseAccess = { callerSub: 'user-1', isAdmin: false };

/** @description Builds a full captured frame with replayable defaults, overridable per test. */
function frame(over: Partial<TokenChaseFrameDetail> & { seq: number }): TokenChaseFrameDetail {
  return {
    seq: over.seq,
    providerRequested: 'claude-code',
    harnessFired: 'harness:claude-code-cli',
    model: 'claude-sonnet-4-6',
    inputMessages: 1,
    tools: [],
    tokensIn: 100,
    tokensOut: 50,
    latencyMs: 800,
    replayable: true,
    phase: 'closed',
    agentId: 'bot-a',
    source: 'swarm',
    systemPrompt: 'you are a bot',
    responseContent: `baseline-${over.seq}`,
    responseBlocks: [],
    history: [{ role: 'user', content: `q-${over.seq}` }],
    toolSchema: [],
    workspaceCommit: null,
    ownerStoreVersion: null,
    ownerSub: 'user-1',
    ...over,
  };
}

/** @description An in-memory frame source for the controller under test. */
function makeSource(frames: TokenChaseFrameDetail[]): TailFrameSource {
  const bySeq = new Map(frames.map((f) => [f.seq, f]));
  return {
    async getFrames() { return frames.map((f) => ({ seq: f.seq })).sort((a, b) => a.seq - b.seq); },
    async getFrame(_runId: string, seq: number) { return bySeq.get(seq) ?? null; },
  };
}

/** @description The verdict a bot node returns, overridable per test. */
function nodeResponse(over: Partial<TailReplayNodeResponse> = {}): TailReplayNodeResponse {
  return {
    success: true, runId: 'run-1', fromFrame: 0, agentId: 'bot-a', ownerSub: 'user-1', status: 'reproduced',
    restore: { source: 'commit', workspaceCommit: 'a'.repeat(40), filesRestored: 2, integrity: 'ok', treeSha: 'b'.repeat(64), warnings: [] },
    store: { bound: false, restored: false, files: 0, version: null, reason: 'no owner store configured on this node' },
    framesInTail: 2,
    frames: [
      { seq: 0, status: 'reproduced', tool: 'write_to_file', replayClass: 'workspace-write', pinVerified: true, servedFromCapture: false, reason: null, warnings: [] },
      { seq: 1, status: 'completed', tool: 'attempt_completion', replayClass: null, pinVerified: null, servedFromCapture: false, reason: null, warnings: [] },
    ],
    stoppedAtFrame: null, stopReason: null, toolCalls: 1,
    artifacts: { baselineTreeSha: 'c'.repeat(64), replayTreeSha: 'c'.repeat(64), reproduced: true, differingPaths: [], redactedPaths: [], complete: true, warnings: [] },
    storeVersion: { baseline: null, replay: null, reproduced: null, bound: false },
    paidCalls: 0, costUsd: 0, durationMs: 12,
    ...over,
  };
}

interface ReplayerSpy extends TailReplayer {
  tailCalls: Array<{ agentId: string; request: TailReplayNodeRequest }>;
  callCalls: number[];
}

/** @description A replayer double recording every node call; re-fire content per seq is test-controlled. */
function makeReplayer(options: {
  node?: TailReplayNodeResponse;
  reply?: (seq: number) => string;
  reachable?: (agentId: string) => boolean;
} = {}): ReplayerSpy {
  const spy: ReplayerSpy = {
    tailCalls: [],
    callCalls: [],
    hasEndpoint: options.reachable ?? (() => true),
    async replayTail(agentId, request) {
      spy.tailCalls.push({ agentId, request });
      return options.node ?? nodeResponse();
    },
    async replayCall(_agentId, request): Promise<TailReplayCallResponse> {
      spy.callCalls.push(request.seq ?? -1);
      const reply = options.reply ?? ((seq: number) => `baseline-${seq}`);
      return {
        success: true, content: reply(request.seq ?? -1),
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, cost: 0.01,
        model: 'claude-sonnet-4-6', provider: 'harness:claude-code-cli', latencyMs: 700,
      };
    },
  };
  return spy;
}

describe('TokenChaseTailReplayService.replayForward — delegation to the accountable bot node', () => {
  it('hands the run, start frame and caller access to the producing node and relays a reproduced verdict', async () => {
    const replayer = makeReplayer();
    const svc = new TokenChaseTailReplayService(makeSource([frame({ seq: 0 }), frame({ seq: 1 })]), replayer);

    const result = await svc.replayForward('run-1', 0, ACCESS);

    expect(replayer.tailCalls).toEqual([{ agentId: 'bot-a', request: { runId: 'run-1', fromFrame: 0, access: { callerSub: 'user-1', isAdmin: false } } }]);
    expect(result).toMatchObject({ runId: 'run-1', fromFrame: 0, agentId: 'bot-a', status: 'reproduced', framesInTail: 2, toolCalls: 1, paidCalls: 0, totalCostUsd: 0, refire: null });
    expect(result!.artifacts.reproduced).toBe(true);
    expect(result!.restore.source).toBe('commit');
    expect(result!.frames.map((f) => f.status)).toEqual(['reproduced', 'completed']);
    // A plain tail replay spends nothing: the prompt re-fire is never issued unless asked.
    expect(replayer.callCalls).toEqual([]);
  });

  it('relays a diverged verdict with the differing paths the node named', async () => {
    const node = nodeResponse({
      status: 'diverged',
      artifacts: { baselineTreeSha: 'c'.repeat(64), replayTreeSha: 'd'.repeat(64), reproduced: false, differingPaths: ['late.txt'], redactedPaths: [], complete: true, warnings: [] },
    });
    const svc = new TokenChaseTailReplayService(makeSource([frame({ seq: 0 })]), makeReplayer({ node }));

    const result = await svc.replayForward('run-1', 0, ACCESS);

    expect(result!.status).toBe('diverged');
    expect(result!.artifacts.differingPaths).toEqual(['late.txt']);
    expect(result!.artifacts.reproduced).toBe(false);
  });

  it('relays a stopped verdict at the frame whose response called a live tool', async () => {
    const node = nodeResponse({
      status: 'stopped', stoppedAtFrame: 1, stopReason: 'Frame 1 calls execute_command (side-effect); a hermetic replay refuses to re-run it.',
      frames: [
        { seq: 0, status: 'reproduced', tool: 'write_to_file', replayClass: 'workspace-write', pinVerified: true, servedFromCapture: false, reason: null, warnings: [] },
        { seq: 1, status: 'live-tool', tool: 'execute_command', replayClass: 'side-effect', pinVerified: null, servedFromCapture: false, reason: 'Frame 1 calls execute_command (side-effect); a hermetic replay refuses to re-run it.', warnings: [] },
      ],
    });
    const svc = new TokenChaseTailReplayService(makeSource([frame({ seq: 0 }), frame({ seq: 1 })]), makeReplayer({ node }));

    const result = await svc.replayForward('run-1', 0, ACCESS);

    expect(result!.status).toBe('stopped');
    expect(result!.stoppedAtFrame).toBe(1);
    expect(result!.stopReason).toContain('execute_command');
    expect(result!.frames[1].status).toBe('live-tool');
  });

  it('fails closed with NO node call when the producing agent has no reachable bot node', async () => {
    const replayer = makeReplayer({ reachable: () => false });
    const svc = new TokenChaseTailReplayService(makeSource([frame({ seq: 0 })]), replayer);

    const result = await svc.replayForward('run-1', 0, ACCESS);

    expect(replayer.tailCalls).toEqual([]);
    expect(replayer.callCalls).toEqual([]);
    expect(result).toMatchObject({ status: 'stopped', stoppedAtFrame: 0, framesInTail: 0, paidCalls: 0, refire: null });
    expect(result!.stopReason).toMatch(/accountable node/);
    expect(result!.restore.source).toBe('none');
    expect(result!.artifacts.reproduced).toBeNull();
  });

  it('never restores or replays on the controller: no filesystem access, no restage method', () => {
    // The CHANGE LOG names what was removed; the code below it must not contain it.
    const source = fs.readFileSync('src/features/token-chase/services/token-chase-tail-replay-service.ts', 'utf8');
    const code = source.slice(source.indexOf('*/') + 2);
    expect(code).not.toMatch(/from 'node:fs/);
    expect(code).not.toMatch(/mkdtemp|writeFile|restageTree|readTreeObject/);
    const methods = Object.getOwnPropertyNames(TokenChaseTailReplayService.prototype).sort();
    expect(methods).toEqual(['constructor', 'refireOneFrame', 'refireTail', 'replayForward']);
  });

  it('returns null when the start frame is absent / not visible', async () => {
    const replayer = makeReplayer();
    const svc = new TokenChaseTailReplayService(makeSource([]), replayer);
    expect(await svc.replayForward('run-1', 0, ACCESS)).toBeNull();
    expect(replayer.tailCalls).toEqual([]);
  });
});

describe('TokenChaseTailReplayService.replayForward — optional prompt re-fire pass (refire:true)', () => {
  it('re-fires N..end on the node and completes when every frame reproduces baseline', async () => {
    const frames = [frame({ seq: 0 }), frame({ seq: 1 }), frame({ seq: 2 })];
    const replayer = makeReplayer();
    const svc = new TokenChaseTailReplayService(makeSource(frames), replayer);

    const result = await svc.replayForward('run-1', 0, ACCESS, { refire: true });

    expect(replayer.tailCalls).toHaveLength(1);
    expect(replayer.callCalls).toEqual([0, 1, 2]);
    expect(result!.refire).not.toBeNull();
    expect(result!.refire!.status).toBe('completed');
    expect(result!.refire!.outcomes.every((o) => o.status === 'deterministic')).toBe(true);
    expect(result!.refire!.stoppedAtFrame).toBeNull();
    expect(result!.refire!.totalCostUsd).toBeCloseTo(0.03, 5);
    expect(result!.paidCalls).toBe(3);
    expect(result!.totalCostUsd).toBeCloseTo(0.03, 5);
  });

  it('STOPS the re-fire pass at the first divergent frame and reports WHICH frame + why', async () => {
    const frames = [frame({ seq: 0 }), frame({ seq: 1 }), frame({ seq: 2 }), frame({ seq: 3 })];
    const replayer = makeReplayer({ reply: (s) => (s === 2 ? 'totally unrelated garbage output tokens' : `baseline-${s}`) });
    const svc = new TokenChaseTailReplayService(makeSource(frames), replayer);

    const result = await svc.replayForward('run-1', 0, ACCESS, { refire: true });

    expect(result!.refire!.status).toBe('stopped');
    expect(result!.refire!.stoppedAtFrame).toBe(2);
    expect(result!.refire!.stopReason).toContain('2');
    expect(result!.refire!.outcomes).toHaveLength(3); // 0, 1, then the stop at 2 — frame 3 is never re-fired.
    expect(result!.refire!.outcomes[2].status).toBe('divergent');
    expect(replayer.callCalls).toEqual([0, 1, 2]);
    // The hermetic verdict is independent of the re-fire pass and is still relayed.
    expect(result!.status).toBe('reproduced');
  });

  it('starts the re-fire at fromFrame (earlier frames are not re-fired)', async () => {
    const frames = [frame({ seq: 0 }), frame({ seq: 1 }), frame({ seq: 2 })];
    const svc = new TokenChaseTailReplayService(makeSource(frames), makeReplayer());

    const result = await svc.replayForward('run-1', 1, ACCESS, { refire: true });

    expect(result!.refire!.outcomes.map((o) => o.seq)).toEqual([1, 2]);
  });

  it('serves pinned reads and warns per-frame on unpinned reads (without stopping)', async () => {
    const pinned = frame({ seq: 0, pins: [{ pinned: true, tool: 'read_file' }, { pinned: false, tool: 'web_fetch' }] });
    const svc = new TokenChaseTailReplayService(makeSource([pinned]), makeReplayer());

    const result = await svc.replayForward('run-1', 0, ACCESS, { refire: true });

    expect(result!.refire!.status).toBe('completed');
    const o = result!.refire!.outcomes[0];
    expect(o.pinnedReads).toBe(1);
    expect(o.unpinnedReads).toBe(1);
    expect(o.warnings.some((w) => /unpinned/i.test(w) && /web_fetch/.test(w))).toBe(true);
  });

  it('backward compat: a frame with no pins/workspaceTree still re-fires', async () => {
    const plain = frame({ seq: 0 }); // no pins, no workspaceTree
    const node = nodeResponse({ restore: { source: 'none', workspaceCommit: null, filesRestored: 0, integrity: 'none', treeSha: 'e'.repeat(64), warnings: [] } });
    const svc = new TokenChaseTailReplayService(makeSource([plain]), makeReplayer({ node }));

    const result = await svc.replayForward('run-1', 0, ACCESS, { refire: true });

    expect(result!.restore.integrity).toBe('none');
    expect(result!.refire!.outcomes[0].status).toBe('deterministic');
    expect(result!.refire!.outcomes[0].pinnedReads).toBe(0);
    expect(result!.refire!.outcomes[0].unpinnedReads).toBe(0);
  });

  it('stops the re-fire pass with no-endpoint when a later tail frame has no reachable bot node', async () => {
    const frames = [frame({ seq: 0 }), frame({ seq: 1, agentId: 'gone' })];
    const svc = new TokenChaseTailReplayService(makeSource(frames), makeReplayer({ reachable: (a) => a === 'bot-a' }));

    const result = await svc.replayForward('run-1', 0, ACCESS, { refire: true });

    expect(result!.refire!.status).toBe('stopped');
    expect(result!.refire!.stoppedAtFrame).toBe(1);
    expect(result!.refire!.outcomes[1].status).toBe('no-endpoint');
  });

  it('stops the re-fire pass at a non-replayable frame (live side-effect) with a warning', async () => {
    const frames = [frame({ seq: 0 }), frame({ seq: 1, replayable: false })];
    const svc = new TokenChaseTailReplayService(makeSource(frames), makeReplayer());

    const result = await svc.replayForward('run-1', 0, ACCESS, { refire: true });

    expect(result!.refire!.status).toBe('stopped');
    expect(result!.refire!.stoppedAtFrame).toBe(1);
    expect(result!.refire!.outcomes[1].status).toBe('non-replayable');
    expect(result!.refire!.outcomes[1].warnings.some((w) => /non-replayable/i.test(w))).toBe(true);
  });

  it('reports an empty re-fire pass when the start frame exists but nothing replayable is listed', async () => {
    const source: TailFrameSource = {
      async getFrames() { return []; },
      async getFrame(_r, seq) { return seq === 5 ? frame({ seq: 5 }) : null; },
    };
    const node = nodeResponse({ status: 'empty', framesInTail: 0, frames: [] });
    const svc = new TokenChaseTailReplayService(source, makeReplayer({ node }));

    const result = await svc.replayForward('run-1', 5, ACCESS, { refire: true });

    expect(result!.status).toBe('empty');
    expect(result!.refire!.status).toBe('empty');
    expect(result!.refire!.outcomes).toHaveLength(0);
  });

  it('surfaces a node failure instead of pretending the tail ran', async () => {
    const replayer = makeReplayer();
    replayer.replayTail = vi.fn(async () => { throw new Error('Bot node tail replay returned 500: restore failed'); });
    const svc = new TokenChaseTailReplayService(makeSource([frame({ seq: 0 })]), replayer);

    await expect(svc.replayForward('run-1', 0, ACCESS)).rejects.toThrow(/returned 500/);
  });
});
