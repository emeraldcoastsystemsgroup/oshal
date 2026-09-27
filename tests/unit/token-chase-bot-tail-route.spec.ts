/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the bot-node tail executor route (BACKLOG "Workspace-bound checkpoint and tail replay", ADR-046 §3). Real boundaries: the capture is written by the REAL lane in a child process (real private-git commits, real per-turn pins from turn-provenance.js, real file-tool handlers producing the baseline artifact); the route is the REAL registrar on a real Express app behind the REAL service-secret gate over a real loopback http server; the hermetic tail re-executes the REAL file-tool handlers through the real ToolRegistry against an isolated worktree; the owner store is a REAL AES-256-GCM ciphertext vault versioned, snapshotted, restored and re-versioned through the real snapshotter and exact-subject-store guards. Proves: reproduced (tree digest and store version match final.json), diverged with the differing path named (a side effect the tool loop never produced) and with a store-version drift, stopped at a side-effect tool BEFORE it runs, stopped at a non-replayable frame, object-restage fallback for a pre-commit frame, 401/400/403/404 refusals, and isolated-root cleanup. Doubled on purpose: the model turn (scripted response strings) and the protected-bot transport seam (assertTransport; the real check is a database posture proven in bot-node-application-authorization.spec.ts).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The snapshotter is async and writes objects into the node's one object directory. bindStore awaits it and takes the object directory: the legacy per-run .tokenchase/store-objects cases still restore (a run captured before the move), and a new case captures into the node directory only, with no store-objects under the run, and still restores, re-versions and reproduces the store version.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  executeTailReplayOnNode,
  parseTailReplayNodeRequest,
  registerBotNodeTokenChaseTailRoute,
  resolveTokenChaseReplayRoot,
} from '../../src/app/bot-node-token-chase-tail-route';
import { authorizeBotNodeInternalCall } from '../../src/app/bot-node-request-auth';
import { TokenChaseReadService } from '../../src/features/token-chase/services/token-chase-read-service';
import { createOwnerStoreSnapshotter, readOwnerStoreConfig, type OwnerStoreSnapshotter } from '../../src/features/token-chase/services/owner-store-snapshot';
import { ensureExactSubjectStoreDirectory } from '../../src/shared/security/exact-subject-store';
import { encryptField } from '../../src/features/personal-data/vault-crypto';
import type { TailReplayNodeResponse } from '../../src/features/agent-management/services/bot-node-tail-replay-client';

const requireModule = createRequire(import.meta.url);
const CAPTURE = path.resolve('any-bot/server/services/token-chase/TokenChaseCapture.js');
const PROVENANCE = path.resolve('any-bot/server/services/token-chase/turn-provenance.js');
const FILE_TOOLS = path.resolve('any-bot/server/services/tools/fileTools.js');
const checkpoint = requireModule('../../any-bot/server/services/token-chase/workspace-checkpoint.js') as {
  restageFromObjects(input: { files: unknown[]; objectDir: string; targetDir: string }): { restored: number; total: number; warnings: string[] };
};

const OWNER = 'auth0|token-chase-route-owner';
const AGENT = 'bot-route';
const SECRET = 'token-chase-route-secret';
const ACCESS = { callerSub: OWNER, isAdmin: false };
const WRITE = '<write_to_file><path>out.txt</path><content>artifact</content></write_to_file>';
const DONE = '<attempt_completion><result>done</result></attempt_completion>';

let root: string;
let replayRoot: string;
const savedEnv: Record<string, string | undefined> = {};
const servers: http.Server[] = [];
const unbound = (): OwnerStoreSnapshotter => createOwnerStoreSnapshotter(readOwnerStoreConfig({}));

/** Writes a capture with the REAL lane in a child (the flag is read at module load), driving real file-tool handlers and real pins. */
function captureInChild(runId: string, body: string): void {
  const workspace = path.join(root, runId);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'before.txt'), 'present before the tool ran\n');
  const script = `
    const { tokenChase } = require(${JSON.stringify(CAPTURE)});
    const { createTurnProvenance } = require(${JSON.stringify(PROVENANCE)});
    const { fileToolDefinitions } = require(${JSON.stringify(FILE_TOOLS)});
    const fs = require('fs'); const path = require('path');
    const root = ${JSON.stringify(workspace)}; const RUN = ${JSON.stringify(runId)}; const OWNER = ${JSON.stringify(OWNER)};
    const yieldTurn = () => tokenChase.flush();
    const defs = Object.fromEntries(fileToolDefinitions().map((d) => [d.name, d]));
    const turns = createTurnProvenance(tokenChase, root);
    const tools = [{ name: 'write_to_file', description: 'w', inputSchema: {} }, { name: 'execute_command', description: 'x', inputSchema: {} }];
    const open = (seq) => tokenChase.beginFrame({ taskId: RUN, seq, agentId: ${JSON.stringify(AGENT)}, workspaceDir: root, providerName: 'scripted', systemPrompt: 's', history: [], tools, userSub: OWNER, pins: turns.drain() });
    const close = (h, content) => tokenChase.endFrame(h, { provider: 'scripted', model: 'v1', content, contentBlocks: [] });
    const runWrite = async () => {
      const input = { path: 'out.txt', content: 'artifact' };
      const result = await defs.write_to_file.handler({ ...input, taskWorkspace: root });
      turns.record({ tool: 'write_to_file', callId: 'c1', toolDefinition: defs.write_to_file, input, result, success: true });
    };
    (async () => { ${body} })().then(() => tokenChase.flush()).then(() => tokenChase.flush());
  `;
  execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TOKEN_CHASE_CAPTURE: 'true' }, stdio: 'pipe', timeout: 60_000 });
}

/** The reproducible baseline: write out.txt, then complete. */
const REPRODUCIBLE = `
  const h0 = open(0); await yieldTurn(); close(h0, ${JSON.stringify(WRITE)});
  await runWrite();
  const h1 = open(1); await yieldTurn(); close(h1, ${JSON.stringify(DONE)});
  tokenChase.finishRun({ taskId: RUN, workspaceDir: root, userSub: OWNER, turns: 2, outcome: 'completed', pins: turns.drain() });
`;

function readCapture(runId: string, file: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, runId, '.tokenchase', file), 'utf8'));
}
function writeCapture(runId: string, file: string, value: unknown): void {
  fs.writeFileSync(path.join(root, runId, '.tokenchase', file), JSON.stringify(value, null, 2));
}

async function boot(ownerStore: OwnerStoreSnapshotter, assertTransport?: () => Promise<void>): Promise<string> {
  const app = express();
  app.use(express.json());
  registerBotNodeTokenChaseTailRoute(app, {
    agentId: AGENT, authorize: authorizeBotNodeInternalCall, pool: null, ownerStore,
    reader: new TokenChaseReadService(), replayRoot, assertTransport: assertTransport ?? (async () => undefined),
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: TailReplayNodeResponse & { error?: string } }> {
  const res = await fetch(`${url}/api/token-chase/replay-tail`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-service-secret': SECRET, ...headers }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as TailReplayNodeResponse & { error?: string } };
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-route-'));
  replayRoot = path.join(root, '.tokenchase-replays');
  for (const key of ['SWARM_SERVICE_SECRET', 'SHARED_WORKSPACE_ROOT', 'OSHAL_WORKSPACE_ROOT', 'SESSION_SECRET']) savedEnv[key] = process.env[key];
  process.env.SWARM_SERVICE_SECRET = SECRET;
  process.env.SHARED_WORKSPACE_ROOT = root;
  process.env.OSHAL_WORKSPACE_ROOT = root;
  process.env.SESSION_SECRET = 'token-chase-route-test-secret-0001';
  captureInChild('run-ok', REPRODUCIBLE);
}, 60_000);

afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))); });
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('POST /api/token-chase/replay-tail — hermetic no-edit tail on the bot node', () => {
  it('restores frame 0 from its checkpoint commit, re-executes the real write and reproduces final.json', async () => {
    const url = await boot(unbound());
    const { status, json } = await post(url, { runId: 'run-ok', fromFrame: 0, access: ACCESS });
    const final = readCapture('run-ok', 'final.json');

    expect(status).toBe(200);
    expect(json).toMatchObject({ success: true, runId: 'run-ok', fromFrame: 0, agentId: AGENT, ownerSub: OWNER, status: 'reproduced', framesInTail: 2, toolCalls: 1, paidCalls: 0, costUsd: 0 });
    expect(json.restore).toMatchObject({ source: 'commit', workspaceCommit: readCapture('run-ok', 'frame-0000.json').context.workspaceCommit, filesRestored: 1, integrity: 'ok' });
    expect(json.frames).toEqual([
      expect.objectContaining({ seq: 0, status: 'reproduced', tool: 'write_to_file', replayClass: 'workspace-write', pinVerified: true }),
      expect.objectContaining({ seq: 1, status: 'completed', tool: 'attempt_completion' }),
    ]);
    expect(json.artifacts).toMatchObject({ baselineTreeSha: final.checkpoint.treeSha, replayTreeSha: final.checkpoint.treeSha, reproduced: true, differingPaths: [], complete: true });
    expect(json.store).toMatchObject({ bound: false, restored: false });
    expect(json.storeVersion).toEqual({ baseline: null, replay: null, reproduced: null, bound: false });
    // The isolated roots are gone and the live workspace never changed.
    expect(fs.readdirSync(replayRoot)).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'run-ok')).sort()).toEqual(['.tokenchase', 'before.txt', 'out.txt']);
  }, 60_000);

  it('reports diverged and names the path when the baseline holds an artifact the tool loop never produced', async () => {
    captureInChild('run-late', `
      const h0 = open(0); await yieldTurn(); close(h0, ${JSON.stringify(WRITE)});
      await runWrite();
      const h1 = open(1); await yieldTurn(); close(h1, ${JSON.stringify(DONE)});
      fs.writeFileSync(path.join(root, 'late.txt'), 'written outside the tool loop');
      tokenChase.finishRun({ taskId: RUN, workspaceDir: root, userSub: OWNER, turns: 2, outcome: 'completed', pins: turns.drain() });
    `);
    const url = await boot(unbound());
    const { json } = await post(url, { runId: 'run-late', fromFrame: 0, access: ACCESS });
    expect(json.status).toBe('diverged');
    expect(json.artifacts.reproduced).toBe(false);
    expect(json.artifacts.differingPaths).toEqual(['late.txt']);
    expect(json.frames.map((f) => f.status)).toEqual(['reproduced', 'completed']);
  }, 60_000);

  it('stops at a side-effect tool BEFORE running it, and at the non-replayable frame that consumed it', async () => {
    captureInChild('run-live', `
      const h0 = open(0); await yieldTurn(); close(h0, '<execute_command><command>echo hi</command></execute_command>');
      turns.record({ tool: 'execute_command', callId: 'c1', toolDefinition: defs.execute_command, input: { command: 'echo hi' }, result: { stdout: 'hi' }, success: true });
      const h1 = open(1); await yieldTurn(); close(h1, ${JSON.stringify(DONE)});
      tokenChase.finishRun({ taskId: RUN, workspaceDir: root, userSub: OWNER, turns: 2, outcome: 'completed', pins: turns.drain() });
    `);
    expect(readCapture('run-live', 'frame-0001.json').replayable).toBe(false);
    const url = await boot(unbound());

    const fromStart = (await post(url, { runId: 'run-live', fromFrame: 0, access: ACCESS })).json;
    expect(fromStart.status).toBe('stopped');
    expect(fromStart.stoppedAtFrame).toBe(0);
    expect(fromStart.toolCalls).toBe(0);
    expect(fromStart.frames[0]).toMatchObject({ status: 'live-tool', tool: 'execute_command', replayClass: 'side-effect' });
    expect(fromStart.stopReason).toMatch(/execute_command \(side-effect\)/);

    const fromConsumer = (await post(url, { runId: 'run-live', fromFrame: 1, access: ACCESS })).json;
    expect(fromConsumer.status).toBe('stopped');
    expect(fromConsumer.stoppedAtFrame).toBe(1);
    expect(fromConsumer.frames[0].status).toBe('non-replayable');
  }, 60_000);

  it('falls back to the object restage for a frame captured without a checkpoint commit', async () => {
    captureInChild('run-precommit', REPRODUCIBLE);
    const frame0 = readCapture('run-precommit', 'frame-0000.json');
    frame0.context.workspaceCommit = null; // a pre-commit frame, or one whose commit failed open
    writeCapture('run-precommit', 'frame-0000.json', frame0);
    const url = await boot(unbound());
    const { json } = await post(url, { runId: 'run-precommit', fromFrame: 0, access: ACCESS });
    expect(json.status).toBe('reproduced');
    expect(json.restore).toMatchObject({ source: 'objects', workspaceCommit: null, filesRestored: 1, integrity: 'ok' });
    // The restage refuses a traversing manifest entry and a digest mismatch, never writes them.
    const target = path.join(root, 'restage-check');
    const restage = checkpoint.restageFromObjects({
      files: [{ path: '../escape.txt', sha256: 'a'.repeat(64) }, { path: 'ghost.txt', sha256: 'b'.repeat(64) }],
      objectDir: path.join(root, 'run-precommit', '.tokenchase', 'objects'), targetDir: target,
    });
    expect(restage).toMatchObject({ restored: 0, total: 2 });
    expect(restage.warnings.join('\n')).toMatch(/unsafe manifest entry/);
    expect(restage.warnings.join('\n')).toMatch(/missing tree object/);
    expect(fs.existsSync(path.join(root, 'escape.txt'))).toBe(false);
  }, 60_000);
});

describe('POST /api/token-chase/replay-tail — owner store (real ciphertext)', () => {
  /** Seeds one owner's vault with an AES-256-GCM field the way the Personal Data Vault stores it, snapshots it into the capture, and binds the frames to that version. */
  async function bindStore(runId: string, objects: 'legacy-run-dir' | 'node-dir' = 'legacy-run-dir'): Promise<{ storeRoot: string; snapshotter: OwnerStoreSnapshotter; version: string }> {
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-route-store-'));
    const subject = ensureExactSubjectStoreDirectory(storeRoot, 'default', OWNER);
    fs.mkdirSync(path.join(subject.subjectDir, 'vault'), { recursive: true });
    fs.writeFileSync(path.join(subject.subjectDir, 'vault', 'entities.enc'), encryptField(OWNER, 'the quick brown vault entry')!, 'utf8');
    const objectDir = path.join(storeRoot, 'node-objects');
    const snapshotter = createOwnerStoreSnapshotter({ storeRoot, tenant: 'default', maxObjectBytes: 1024 * 1024, objectDir });
    const captureDir = path.join(root, runId, '.tokenchase');
    // A run captured before objects moved to the node directory kept them in its own store-objects.
    const manifest = objects === 'legacy-run-dir' ? await snapshotter.snapshot(OWNER, path.join(captureDir, 'store-objects')) : await snapshotter.snapshot(OWNER);
    fs.writeFileSync(path.join(captureDir, `store-${manifest.version}.json`), JSON.stringify(manifest, null, 2));
    for (const file of ['frame-0000.json', 'frame-0001.json']) {
      const frame = readCapture(runId, file);
      frame.context.ownerStoreVersion = manifest.version;
      writeCapture(runId, file, frame);
    }
    const final = readCapture(runId, 'final.json');
    final.ownerStoreVersion = manifest.version;
    writeCapture(runId, 'final.json', final);
    return { storeRoot, snapshotter, version: manifest.version };
  }

  it('restores the ciphertext into an isolated root, re-versions it and reproduces the store version', async () => {
    captureInChild('run-store', REPRODUCIBLE);
    const { snapshotter, version, storeRoot } = await bindStore('run-store');
    const url = await boot(snapshotter);
    const { json } = await post(url, { runId: 'run-store', fromFrame: 0, access: ACCESS });
    expect(json.status).toBe('reproduced');
    expect(json.store).toEqual({ bound: true, restored: true, files: 1, version, reason: null });
    expect(json.storeVersion).toEqual({ baseline: version, replay: version, reproduced: true, bound: true });
    expect(json.artifacts.reproduced).toBe(true);
    expect(fs.readdirSync(replayRoot)).toEqual([]);
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }, 60_000);

  it('restores from the node object directory when the run holds no store-objects of its own', async () => {
    captureInChild('run-store-node', REPRODUCIBLE);
    const { snapshotter, version, storeRoot } = await bindStore('run-store-node', 'node-dir');
    expect(fs.existsSync(path.join(root, 'run-store-node', '.tokenchase', 'store-objects'))).toBe(false);
    expect(fs.readdirSync(snapshotter.objectDir!)).toHaveLength(1);
    const url = await boot(snapshotter);
    const { json } = await post(url, { runId: 'run-store-node', fromFrame: 0, access: ACCESS });
    expect(json.status).toBe('reproduced');
    expect(json.store).toEqual({ bound: true, restored: true, files: 1, version, reason: null });
    expect(json.storeVersion).toEqual({ baseline: version, replay: version, reproduced: true, bound: true });
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }, 60_000);

  it('reports diverged when the run ended on a different store version than the restored one', async () => {
    captureInChild('run-store-drift', REPRODUCIBLE);
    const { snapshotter, version, storeRoot } = await bindStore('run-store-drift');
    const final = readCapture('run-store-drift', 'final.json');
    final.ownerStoreVersion = 'f'.repeat(64);
    writeCapture('run-store-drift', 'final.json', final);
    const url = await boot(snapshotter);
    const { json } = await post(url, { runId: 'run-store-drift', fromFrame: 0, access: ACCESS });
    expect(json.status).toBe('diverged');
    expect(json.artifacts.reproduced).toBe(true);
    expect(json.storeVersion).toEqual({ baseline: 'f'.repeat(64), replay: version, reproduced: false, bound: true });
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }, 60_000);

  it('says storeBound:false honestly when the frame carries a version but this node has no store', async () => {
    captureInChild('run-store-unbound', REPRODUCIBLE);
    const { storeRoot } = await bindStore('run-store-unbound');
    const url = await boot(unbound());
    const { json } = await post(url, { runId: 'run-store-unbound', fromFrame: 0, access: ACCESS });
    expect(json.store).toMatchObject({ bound: false, restored: false, reason: 'no owner store configured on this node' });
    expect(json.storeVersion.reproduced).toBeNull();
    expect(json.storeVersion.bound).toBe(false);
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }, 60_000);
});

describe('POST /api/token-chase/replay-tail — refusals and wiring', () => {
  it('refuses without the service secret, on a malformed body, when the transport is protected, and for a non-owner', async () => {
    const url = await boot(unbound());
    expect((await post(url, { runId: 'run-ok', fromFrame: 0, access: ACCESS }, { 'x-service-secret': '' })).status).toBe(401);
    expect((await post(url, { runId: 'run-ok', fromFrame: 0, access: ACCESS }, { 'x-service-secret': 'wrong' })).status).toBe(401);
    expect((await post(url, { runId: 'run-ok', fromFrame: -1, access: ACCESS })).status).toBe(400);
    expect((await post(url, { runId: 'run-ok', fromFrame: 0 })).status).toBe(400);
    expect((await post(url, { runId: 'run-ok', fromFrame: 0, access: { callerSub: 'auth0|someone-else', isAdmin: false } })).status).toBe(404);
    expect((await post(url, { runId: 'run-ok', fromFrame: 7, access: ACCESS })).status).toBe(404);
    const protectedUrl = await boot(unbound(), async () => { throw new Error('authorization_bot_transport_unavailable'); });
    expect((await post(protectedUrl, { runId: 'run-ok', fromFrame: 0, access: ACCESS })).status).toBe(403);
  });

  it('an admin caller sees the run; the executor returns null (not a throw) for an unknown run', async () => {
    const admin = await executeTailReplayOnNode({ agentId: AGENT, authorize: authorizeBotNodeInternalCall, pool: null, ownerStore: unbound(), reader: new TokenChaseReadService(), replayRoot, assertTransport: async () => undefined }, { runId: 'run-ok', fromFrame: 0, access: { callerSub: 'auth0|operator', isAdmin: true } });
    expect(admin?.status).toBe('reproduced');
    const missing = await executeTailReplayOnNode({ agentId: AGENT, authorize: authorizeBotNodeInternalCall, pool: null, ownerStore: unbound(), reader: new TokenChaseReadService(), replayRoot }, { runId: 'no-such-run', fromFrame: 0, access: ACCESS });
    expect(missing).toBeNull();
  }, 60_000);

  it('parses the request strictly and resolves the replay root under the shared workspace root by default', () => {
    expect(parseTailReplayNodeRequest({ runId: ' run-1 ', fromFrame: '2', access: { callerSub: 'u', isAdmin: 'yes' } })).toEqual({ runId: 'run-1', fromFrame: 2, access: { callerSub: 'u', isAdmin: false } });
    expect(parseTailReplayNodeRequest({ runId: 'run-1', fromFrame: 0, access: { callerSub: '', isAdmin: true } })).toEqual({ runId: 'run-1', fromFrame: 0, access: { callerSub: null, isAdmin: true } });
    expect(parseTailReplayNodeRequest({ runId: '', fromFrame: 0, access: ACCESS })).toBeNull();
    expect(parseTailReplayNodeRequest({ runId: 'run-1', fromFrame: 'x', access: ACCESS })).toBeNull();
    expect(parseTailReplayNodeRequest(null)).toBeNull();
    expect(resolveTokenChaseReplayRoot({ TOKEN_CHASE_REPLAY_ROOT: '/home/user/replays' })).toBe(path.resolve('/home/user/replays'));
    expect(resolveTokenChaseReplayRoot({})).toBe(path.join(root, '.tokenchase-replays'));
  });

  it('bot-node-server.ts mounts the route behind the bot-node gate with the ownership pool and the owner store', () => {
    const source = fs.readFileSync('src/app/bot-node-server.ts', 'utf8');
    expect(source).toContain("import { registerBotNodeTokenChaseTailRoute } from './bot-node-token-chase-tail-route';");
    expect(source).toContain('registerBotNodeTokenChaseTailRoute(app, { agentId, authorize: authorizeBotNodeCall, pool, ownerStore });');
  });
});
