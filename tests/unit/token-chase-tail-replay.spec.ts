/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Token Chase forward TAIL replay (ADR-046 §1/§8): it restages frame N's content-addressed workspace tree (hash-verified, into an isolated root), replays N..end on the accountable bot, STOPS at the first divergence reporting WHICH frame + why, serves pinned reads while warning on unpinned ones per-frame, and — the backward-compat contract — still single-replays frames that carry no pins/workspaceTree.
 */

import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  TokenChaseTailReplayService,
  type TailFrameSource,
  type TailReplayCallResponse,
  type TailReplayer,
} from '../../src/features/token-chase/services/token-chase-tail-replay-service';
import type { TokenChaseFrameDetail, TokenChaseAccess } from '../../src/features/token-chase/services/token-chase-read-service';

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
    ...over,
  };
}

/** @description An in-memory frame source + object store for the tail replay under test. */
function makeSource(frames: TokenChaseFrameDetail[], objects: Record<string, Buffer> = {}): TailFrameSource {
  const bySeq = new Map(frames.map((f) => [f.seq, f]));
  return {
    async getFrames() {
      return frames.map((f) => ({ seq: f.seq })).sort((a, b) => a.seq - b.seq);
    },
    async getFrame(_runId: string, seq: number) {
      return bySeq.get(seq) ?? null;
    },
    async readTreeObject(_runId: string, sha256: string) {
      return objects[sha256.toLowerCase()] ?? null;
    },
  };
}

/** @description A replayer whose per-seq response content the test controls; matching content grades deterministic. */
function makeReplayer(reply: (seq: number) => string, reachable: (agentId: string) => boolean = () => true): TailReplayer {
  return {
    hasEndpoint: reachable,
    async replayCall(_agentId, request): Promise<TailReplayCallResponse> {
      return {
        success: true,
        content: reply(request.seq ?? -1),
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        cost: 0.01,
        model: 'claude-sonnet-4-6',
        provider: 'harness:claude-code-cli',
        latencyMs: 700,
      };
    },
  };
}

const tempRoots: string[] = [];
/** @description Mints an isolated restage root under the OS temp dir, cleaned up after each test. */
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tail-test-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

describe('TokenChaseTailReplayService.replayForward', () => {
  it('replays N..end and completes when every frame reproduces baseline', async () => {
    const frames = [frame({ seq: 0 }), frame({ seq: 1 }), frame({ seq: 2 })];
    const svc = new TokenChaseTailReplayService(makeSource(frames), makeReplayer((s) => `baseline-${s}`), { replayRoot: tempRoot() });

    const result = await svc.replayForward('run-1', 0, ACCESS);

    expect(result).not.toBeNull();
    expect(result!.status).toBe('completed');
    expect(result!.framesInTail).toBe(3);
    expect(result!.outcomes).toHaveLength(3);
    expect(result!.outcomes.every((o) => o.status === 'deterministic')).toBe(true);
    expect(result!.stoppedAtFrame).toBeNull();
    expect(result!.totalCostUsd).toBeCloseTo(0.03, 5);
  });

  it('STOPS at the first divergent frame and reports WHICH frame + why', async () => {
    const frames = [frame({ seq: 0 }), frame({ seq: 1 }), frame({ seq: 2 }), frame({ seq: 3 })];
    // Frame 2 diverges — its replay shares no tokens with the baseline.
    const replayer = makeReplayer((s) => (s === 2 ? 'totally unrelated garbage output tokens' : `baseline-${s}`));
    const svc = new TokenChaseTailReplayService(makeSource(frames), replayer, { replayRoot: tempRoot() });

    const result = await svc.replayForward('run-1', 0, ACCESS);

    expect(result!.status).toBe('stopped');
    expect(result!.stoppedAtFrame).toBe(2);
    expect(result!.stopReason).toContain('2');
    expect(result!.outcomes).toHaveLength(3); // 0, 1, then the stop at 2 — frame 3 is never replayed.
    expect(result!.outcomes[2].status).toBe('divergent');
    expect(result!.outcomes[2].verdict?.status).toBe('divergent');
  });

  it('starts the tail at fromFrame (earlier frames are not replayed)', async () => {
    const frames = [frame({ seq: 0 }), frame({ seq: 1 }), frame({ seq: 2 })];
    const svc = new TokenChaseTailReplayService(makeSource(frames), makeReplayer((s) => `baseline-${s}`), { replayRoot: tempRoot() });

    const result = await svc.replayForward('run-1', 1, ACCESS);

    expect(result!.framesInTail).toBe(2);
    expect(result!.outcomes.map((o) => o.seq)).toEqual([1, 2]);
  });

  it('serves pinned reads and warns per-frame on unpinned reads (without stopping)', async () => {
    const pinned = frame({ seq: 0, pins: [{ pinned: true, tool: 'read_file' }, { pinned: false, tool: 'web_fetch' }] });
    const svc = new TokenChaseTailReplayService(makeSource([pinned]), makeReplayer((s) => `baseline-${s}`), { replayRoot: tempRoot() });

    const result = await svc.replayForward('run-1', 0, ACCESS);

    expect(result!.status).toBe('completed');
    const o = result!.outcomes[0];
    expect(o.pinnedReads).toBe(1);
    expect(o.unpinnedReads).toBe(1);
    expect(o.warnings.some((w) => /unpinned/i.test(w) && /web_fetch/.test(w))).toBe(true);
  });

  it('backward compat: a frame with no pins/workspaceTree still single-replays', async () => {
    const plain = frame({ seq: 0 }); // no pins, no workspaceTree
    const svc = new TokenChaseTailReplayService(makeSource([plain]), makeReplayer((s) => `baseline-${s}`), { replayRoot: tempRoot() });

    const result = await svc.replayForward('run-1', 0, ACCESS);

    expect(result!.status).toBe('completed');
    expect(result!.restage.attempted).toBe(false);
    expect(result!.restage.integrity).toBe('none');
    expect(result!.outcomes[0].status).toBe('deterministic');
    expect(result!.outcomes[0].pinnedReads).toBe(0);
    expect(result!.outcomes[0].unpinnedReads).toBe(0);
  });

  it('restages frame N\'s content-addressed workspace tree, hash-verified, into the isolated root', async () => {
    const content = Buffer.from('hello world', 'utf8');
    const sha = crypto.createHash('sha256').update(content).digest('hex');
    const start = frame({ seq: 0, workspaceTree: { files: [{ path: 'src/a.txt', sha256: sha }] } });
    const root = tempRoot();
    const svc = new TokenChaseTailReplayService(makeSource([start], { [sha]: content }), makeReplayer((s) => `baseline-${s}`), { replayRoot: root });

    const result = await svc.replayForward('run-1', 0, ACCESS);

    expect(result!.restage.attempted).toBe(true);
    expect(result!.restage.filesStaged).toBe(1);
    expect(result!.restage.filesTotal).toBe(1);
    expect(result!.restage.integrity).toBe('ok');
    const staged = path.join(result!.restage.root!, 'src', 'a.txt');
    expect(fs.readFileSync(staged, 'utf8')).toBe('hello world');
  });

  it('marks restage integrity partial and never writes a hash-mismatched object', async () => {
    const wrong = Buffer.from('tampered', 'utf8');
    const sha = crypto.createHash('sha256').update(Buffer.from('original', 'utf8')).digest('hex');
    const start = frame({ seq: 0, workspaceTree: { files: [{ path: 'a.txt', sha256: sha }] } });
    const svc = new TokenChaseTailReplayService(makeSource([start], { [sha]: wrong }), makeReplayer((s) => `baseline-${s}`), { replayRoot: tempRoot() });

    const result = await svc.replayForward('run-1', 0, ACCESS);

    expect(result!.restage.attempted).toBe(true);
    expect(result!.restage.filesStaged).toBe(0);
    expect(result!.restage.integrity).toBe('partial');
    expect(result!.restage.warnings.some((w) => /mismatch/i.test(w))).toBe(true);
    expect(fs.existsSync(path.join(result!.restage.root!, 'a.txt'))).toBe(false);
  });

  it('drops manifest entries with traversing paths', async () => {
    const content = Buffer.from('x', 'utf8');
    const sha = crypto.createHash('sha256').update(content).digest('hex');
    const start = frame({ seq: 0, workspaceTree: { files: [{ path: '../escape.txt', sha256: sha }, { path: 'ok.txt', sha256: sha }] } });
    const svc = new TokenChaseTailReplayService(makeSource([start], { [sha]: content }), makeReplayer((s) => `baseline-${s}`), { replayRoot: tempRoot() });

    const result = await svc.replayForward('run-1', 0, ACCESS);

    // The traversing entry is filtered before restage; only the safe one is a manifest file.
    expect(result!.restage.filesTotal).toBe(1);
    expect(result!.restage.filesStaged).toBe(1);
  });

  it('stops with no-endpoint when a tail frame has no reachable bot node', async () => {
    const frames = [frame({ seq: 0 }), frame({ seq: 1, agentId: 'gone' })];
    const svc = new TokenChaseTailReplayService(makeSource(frames), makeReplayer((s) => `baseline-${s}`, (a) => a === 'bot-a'), { replayRoot: tempRoot() });

    const result = await svc.replayForward('run-1', 0, ACCESS);

    expect(result!.status).toBe('stopped');
    expect(result!.stoppedAtFrame).toBe(1);
    expect(result!.outcomes[1].status).toBe('no-endpoint');
  });

  it('stops at a non-replayable frame (live side-effect) with a warning', async () => {
    const frames = [frame({ seq: 0 }), frame({ seq: 1, replayable: false })];
    const svc = new TokenChaseTailReplayService(makeSource(frames), makeReplayer((s) => `baseline-${s}`), { replayRoot: tempRoot() });

    const result = await svc.replayForward('run-1', 0, ACCESS);

    expect(result!.status).toBe('stopped');
    expect(result!.stoppedAtFrame).toBe(1);
    expect(result!.outcomes[1].status).toBe('non-replayable');
    expect(result!.outcomes[1].warnings.some((w) => /non-replayable/i.test(w))).toBe(true);
  });

  it('returns null when the start frame is absent / not visible', async () => {
    const svc = new TokenChaseTailReplayService(makeSource([]), makeReplayer((s) => `baseline-${s}`), { replayRoot: tempRoot() });
    expect(await svc.replayForward('run-1', 0, ACCESS)).toBeNull();
  });

  it('reports empty when the start frame exists but the tail has nothing replayable listed', async () => {
    // getFrame resolves seq 5, but getFrames lists no frames >= 5 (e.g. filtered by visibility).
    const source: TailFrameSource = {
      async getFrames() { return []; },
      async getFrame(_r, seq) { return seq === 5 ? frame({ seq: 5 }) : null; },
      async readTreeObject() { return null; },
    };
    const svc = new TokenChaseTailReplayService(source, makeReplayer((s) => `baseline-${s}`), { replayRoot: tempRoot() });

    const result = await svc.replayForward('run-1', 5, ACCESS);

    expect(result!.status).toBe('empty');
    expect(result!.outcomes).toHaveLength(0);
  });
});
