/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | End-to-end real-boundary guard for BACKLOG "Workspace-bound checkpoint and tail replay" (ADR-046). Baseline: the REAL AgenticController loop with capture on (child process, tests/fixtures/token-chase-e2e-capture.cjs), the REAL file tools writing then reading an artifact, REAL git commits in the private .tokenchase/git, and one REAL live tool. Replay: the REAL bot-node route (registerBotNodeTokenChaseTailRoute on a real Express app behind the real service-secret gate, over a real loopback http server), reached through the REAL BotNodeTailReplayClient by the REAL controller TokenChaseTailReplayService over the REAL TokenChaseReadService. Proves: the no-edit tail reproduces the final tree digest from frame 0 and from a mid-run frame; the frame that consumed the live read is replayable:false and the tail stops at the frame that CALLED it, before running it; the controller never calls a provider (its only bot call is replayTail; replayCall would throw); the live workspace is untouched and the isolated roots are cleaned up. Doubled on purpose: the model turn (a scripted provider, explicitly identified) and the protected-bot transport check (a database posture proven in bot-node-application-authorization.spec.ts). The owner store is unbound here and reported so; its restore/compare is proven with real ciphertext in token-chase-bot-tail-route.spec.ts.
 */

import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerBotNodeTokenChaseTailRoute } from '../../src/app/bot-node-token-chase-tail-route';
import { authorizeBotNodeInternalCall } from '../../src/app/bot-node-request-auth';
import { BotNodeTailReplayClient } from '../../src/features/agent-management/services/bot-node-tail-replay-client';
import { TokenChaseReadService } from '../../src/features/token-chase/services/token-chase-read-service';
import { TokenChaseTailReplayService } from '../../src/features/token-chase/services/token-chase-tail-replay-service';
import { createOwnerStoreSnapshotter, readOwnerStoreConfig } from '../../src/features/token-chase/services/owner-store-snapshot';

const FIXTURE = path.resolve('tests/fixtures/token-chase-e2e-capture.cjs');
const OWNER = 'auth0|token-chase-e2e-owner';
const AGENT = 'bot-e2e';
const SECRET = 'token-chase-e2e-secret';
const ACCESS = { callerSub: OWNER, isAdmin: false };

let root: string;
let replayRoot: string;
let server: http.Server;
let baseUrl: string;
const savedEnv: Record<string, string | undefined> = {};
const replayCall = vi.fn(async () => { throw new Error('the controller must never re-fire a provider in a plain tail replay'); });

/** Runs the real agentic loop with capture on in a child process and returns what it reported. */
function capture(runId: string, mode: 'replayable' | 'live'): { success: boolean; turns: number; provider: string; captureEnabled: boolean } {
  fs.mkdirSync(path.join(root, runId), { recursive: true });
  const out = execFileSync(process.execPath, [FIXTURE, root, runId, mode, OWNER], {
    env: { ...process.env, TOKEN_CHASE_CAPTURE: 'true', SHARED_WORKSPACE_ROOT: root, OSHAL_WORKSPACE_ROOT: root },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  });
  const line = out.split(/\r?\n/).find((l) => l.startsWith('TC_E2E_RESULT '));
  if (!line) throw new Error(`fixture reported nothing:\n${out.slice(-2000)}`);
  return JSON.parse(line.slice('TC_E2E_RESULT '.length));
}

/** Reads one capture file of a run as JSON. */
function readCapture(runId: string, file: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, runId, '.tokenchase', file), 'utf8'));
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-e2e-'));
  replayRoot = path.join(root, '.tokenchase-replays');
  for (const key of ['SWARM_SERVICE_SECRET', 'SHARED_WORKSPACE_ROOT', 'OSHAL_WORKSPACE_ROOT']) savedEnv[key] = process.env[key];
  process.env.SWARM_SERVICE_SECRET = SECRET;
  process.env.SHARED_WORKSPACE_ROOT = root;
  process.env.OSHAL_WORKSPACE_ROOT = root;
  const app = express();
  app.use(express.json());
  registerBotNodeTokenChaseTailRoute(app, {
    agentId: AGENT, authorize: authorizeBotNodeInternalCall, pool: null,
    ownerStore: createOwnerStoreSnapshotter(readOwnerStoreConfig({})),
    reader: new TokenChaseReadService(), replayRoot,
    assertTransport: async () => undefined,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(root, { recursive: true, force: true });
});

/** The controller service wired to the REAL client against the real route; replayCall is a tripwire. */
function controllerService(): TokenChaseTailReplayService {
  const client = new BotNodeTailReplayClient((agentId) => (agentId === AGENT ? baseUrl : null));
  return new TokenChaseTailReplayService(new TokenChaseReadService(), {
    hasEndpoint: (agentId) => client.hasEndpoint(agentId),
    replayTail: (agentId, request) => client.replayTail(agentId, request),
    replayCall,
  });
}

describe('Token Chase checkpoint + tail replay, end to end over real boundaries', () => {
  it('the real agentic loop captured frames, per-turn pins, private-git commits and final.json', () => {
    const report = capture('run-e2e', 'replayable');
    expect(report).toMatchObject({ success: true, turns: 3, provider: 'scripted-fixture', captureEnabled: true });
    expect(fs.readFileSync(path.join(root, 'run-e2e', 'out.txt'), 'utf8')).toBe('artifact from the scripted turn');

    // The loop numbers frames from 1; a frame carries the pins of the tool results it CONSUMED.
    const frame1 = readCapture('run-e2e', 'frame-0001.json');
    const frame2 = readCapture('run-e2e', 'frame-0002.json');
    const frame3 = readCapture('run-e2e', 'frame-0003.json');
    const final = readCapture('run-e2e', 'final.json');
    expect(fs.existsSync(path.join(root, 'run-e2e', '.tokenchase', 'frame-0000.json'))).toBe(false);
    expect(frame1.pins ?? []).toEqual([]);
    expect(frame2.pins[0]).toMatchObject({ tool: 'write_to_file', replayClass: 'workspace-write', pinned: true, declared: true, success: true });
    expect(frame3.pins[0]).toMatchObject({ tool: 'read_file', replayClass: 'workspace-read', pinned: true });
    expect([frame1.replayable, frame2.replayable, frame3.replayable]).toEqual([true, true, true]);
    for (const seq of [1, 2, 3]) expect(readCapture('run-e2e', `frame-000${seq}.json`).context.workspaceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(final.outcome).toBe('completed');
    expect(final.workspaceTree.files.map((f: any) => f.path)).toContain('out.txt');
    expect(final.ownerStore.bound).toBe(false);
  }, 60_000);

  it('the no-edit tail reproduces the final tree from the first frame on the bot node, and the controller calls no provider', async () => {
    const result = await controllerService().replayForward('run-e2e', 1, ACCESS);
    const final = readCapture('run-e2e', 'final.json');

    expect(result).not.toBeNull();
    expect(result!.status).toBe('reproduced');
    expect(result!.agentId).toBe(AGENT);
    expect(result!.restore).toMatchObject({ source: 'commit', integrity: 'ok' });
    expect(result!.frames.map((f) => [f.status, f.tool])).toEqual([
      ['reproduced', 'write_to_file'], ['reproduced', 'read_file'], ['completed', 'attempt_completion'],
    ]);
    expect(result!.frames[0].pinVerified).toBe(true);
    expect(result!.frames[1].pinVerified).toBe(true);
    expect(result!.toolCalls).toBe(2);
    expect(result!.artifacts).toMatchObject({ reproduced: true, differingPaths: [], complete: true });
    expect(result!.artifacts.replayTreeSha).toBe(final.checkpoint.treeSha);
    expect(result!.storeVersion).toEqual({ baseline: null, replay: null, reproduced: null, bound: false });
    expect(result!.paidCalls).toBe(0);
    expect(result!.totalCostUsd).toBe(0);
    expect(result!.refire).toBeNull();
    expect(replayCall).not.toHaveBeenCalled();
  }, 60_000);

  it('reproduces from a mid-run frame too: the restored commit already holds the written artifact', async () => {
    const result = await controllerService().replayForward('run-e2e', 2, ACCESS);
    expect(result!.status).toBe('reproduced');
    expect(result!.restore.source).toBe('commit');
    expect(result!.restore.workspaceCommit).toBe(readCapture('run-e2e', 'frame-0002.json').context.workspaceCommit);
    expect(result!.frames.map((f) => f.status)).toEqual(['reproduced', 'completed']);
    expect(result!.toolCalls).toBe(1);
  }, 60_000);

  it('leaves the live workspace untouched and removes the isolated roots', () => {
    expect(fs.readFileSync(path.join(root, 'run-e2e', 'out.txt'), 'utf8')).toBe('artifact from the scripted turn');
    expect(fs.readdirSync(path.join(root, 'run-e2e')).sort()).toEqual(['.tokenchase', 'out.txt']);
    expect(fs.readdirSync(replayRoot)).toEqual([]);
  });

  it('a genuinely live read marks the consuming frame non-replayable and the tail stops at the frame that called it, before running it', async () => {
    const report = capture('run-live', 'live');
    expect(report).toMatchObject({ success: true, turns: 3 });
    // Frame 2's response CALLED weather_now; frame 3 CONSUMED its result and is the non-replayable one.
    const frame3 = readCapture('run-live', 'frame-0003.json');
    expect(frame3.replayable).toBe(false);
    expect(frame3.pins[0]).toMatchObject({ tool: 'weather_now', replayClass: 'live-read', declared: true, pinned: false });
    expect(readCapture('run-live', 'frame-0002.json').replayable).toBe(true);

    const fromStart = await controllerService().replayForward('run-live', 1, ACCESS);
    expect(fromStart!.status).toBe('stopped');
    expect(fromStart!.stoppedAtFrame).toBe(2);
    expect(fromStart!.frames.map((f) => f.status)).toEqual(['reproduced', 'live-tool']);
    expect(fromStart!.frames[1].reason).toMatch(/weather_now \(live-read\)/);
    expect(fromStart!.toolCalls).toBe(1);

    const fromConsumer = await controllerService().replayForward('run-live', 3, ACCESS);
    expect(fromConsumer!.status).toBe('stopped');
    expect(fromConsumer!.stoppedAtFrame).toBe(3);
    expect(fromConsumer!.frames[0].status).toBe('non-replayable');
    expect(replayCall).not.toHaveBeenCalled();
  }, 60_000);

  it('refuses a caller who does not own the run (404 from the node, null from the controller)', async () => {
    const result = await controllerService().replayForward('run-e2e', 1, { callerSub: 'auth0|someone-else', isAdmin: false });
    expect(result).toBeNull();
  });
});
