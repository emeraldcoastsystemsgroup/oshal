/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Subprocess proof that Token Chase capture writes bounded content-addressed workspace objects, full tool schemas, provenance refs and caller-declared non-replayable pins.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Workspace-bound checkpoint (BACKLOG "Workspace-bound checkpoint and tail replay"): the background writer now PRODUCES context.workspaceCommit (a real commit in the private .tokenchase/git, reachable under refs/tokenchase/<task>/<seq>), a `checkpoint` block with the tree digest and redacted paths, an honest ownerStore.bound:false + null version on a node with no store, and finishRun writes final.json reflecting the POST-tool tree after a tool-then-complete sequence. The old caller-supplied workspaceCommit/ownerStoreVersion strings are no longer accepted as provenance.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Owner-store plumbing: with a snapshotter configured (configureOwnerStore), the frame records context.ownerStoreVersion + ownerStore.bound:true and the lane writes store-<version>.json beside the frame. The snapshotter in this case is a duck-typed JS double naming what it copied; the REAL ciphertext snapshotter is proven by token-chase-owner-store-snapshot.spec.ts and consumed end-to-end by the bot-node tail route guard.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const modulePath = path.resolve('any-bot/server/services/token-chase/TokenChaseCapture.js');

/** Runs a capture script in a child with the flag ON, waiting for the background writers to drain. */
function captureInChild(root: string, body: string): void {
  const script = `
    const { tokenChase } = require(${JSON.stringify(modulePath)});
    const fs = require('fs'); const path = require('path');
    const root = ${JSON.stringify(root)};
    // Like the real loop, each LLM call yields to the event loop (the await), which is when the
    // background writer snapshots the tree: \`yield()\` stands in for that await here.
    const yieldTurn = () => tokenChase.flush();
    (async () => { ${body} })().then(() => tokenChase.flush());
  `;
  execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TOKEN_CHASE_CAPTURE: 'true' }, stdio: 'pipe' });
}

describe('Token Chase capture provenance contract', () => {
  it('writes the promised tree, schema, a REAL workspace commit, honest store posture and the non-replayable decision off the call path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-chase-capture-'));
    tempRoots.push(root);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'ignored'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'main.txt'), 'captured workspace text');
    fs.writeFileSync(path.join(root, 'node_modules', 'ignored', 'secret.txt'), 'must not enter the tree');
    captureInChild(root, `
      const handle = tokenChase.beginFrame({
        taskId: 'task-1', seq: 0, agentId: 'bot-1', workspaceDir: root,
        providerName: 'provider', systemPrompt: 'system', source: 'test', userSub: 'owner-1', replayable: false,
        pins: [{ tool: 'read_file', pinned: false }], history: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }]
      });
      tokenChase.endFrame(handle, { provider: 'provider', model: 'model', content: 'answer', contentBlocks: [], usage: { inputTokens: 2, outputTokens: 3 } });
    `);
    const framePath = path.join(root, '.tokenchase', 'frame-0000.json');
    const frame = JSON.parse(fs.readFileSync(framePath, 'utf8')) as any;
    expect(frame.replayable).toBe(false);
    expect(frame.pins).toEqual([{ tool: 'read_file', pinned: false }]);
    expect(frame.context.toolSchema[0].inputSchema.type).toBe('object');
    expect(frame.userSub).toBe('owner-1');
    expect(frame.phase).toBe('closed');
    expect(frame.response.content).toBe('answer');
    // The commit is REAL: git can resolve it from the private repository, under the per-seq ref.
    expect(frame.context.workspaceCommit).toMatch(/^[0-9a-f]{40}$/);
    const gitDir = path.join(root, '.tokenchase', 'git');
    expect(execFileSync('git', ['--git-dir', gitDir, 'rev-parse', 'refs/tokenchase/task-1/0'], { encoding: 'utf8' }).trim()).toBe(frame.context.workspaceCommit);
    expect(frame.checkpoint).toMatchObject({ complete: true, redactedPaths: [], error: null, ref: 'refs/tokenchase/task-1/0' });
    expect(frame.checkpoint.treeSha).toBe(frame.workspaceTree.treeSha);
    // No owner store on this node: the version is null and the posture says so, not a fabricated ref.
    expect(frame.context.ownerStoreVersion).toBeNull();
    expect(frame.ownerStore).toMatchObject({ bound: false, complete: false });
    expect(frame.workspaceTree.files).toHaveLength(1);
    const entry = frame.workspaceTree.files[0];
    expect(entry.path).toBe('src/main.txt');
    expect(entry.sha256).toBe(crypto.createHash('sha256').update('captured workspace text').digest('hex'));
    expect(fs.readFileSync(path.join(root, '.tokenchase', 'objects', entry.sha256), 'utf8')).toBe('captured workspace text');
    expect(fs.existsSync(path.join(root, '.tokenchase', 'objects', 'ignored'))).toBe(false);
    // The task workspace itself never gained a .git: the checkpoint repository is private to the capture dir.
    expect(fs.existsSync(path.join(root, '.git'))).toBe(false);
  });

  it('final.json reflects the POST-tool tree after a tool-then-complete sequence and links the last frame', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-chase-final-'));
    tempRoots.push(root);
    fs.writeFileSync(path.join(root, 'before.txt'), 'present before the tool ran');
    captureInChild(root, `
      const h1 = tokenChase.beginFrame({ taskId: 'task-2', seq: 1, agentId: 'bot-1', workspaceDir: root, providerName: 'p', systemPrompt: 's', history: [], tools: [], userSub: 'owner-2' });
      await yieldTurn();
      tokenChase.endFrame(h1, { provider: 'p', model: 'm', content: '<write_to_file><path>out.txt</path><content>artifact</content></write_to_file>', contentBlocks: [] });
      // The tool ran between the frames: the workspace changed AFTER frame 1's snapshot.
      fs.writeFileSync(path.join(root, 'out.txt'), 'artifact');
      const pin = { tool: 'write_to_file', callId: 'c1', replayClass: 'workspace-write', pinned: true, success: true, resultSha256: 'a'.repeat(64), inputSha256: 'b'.repeat(64) };
      const h2 = tokenChase.beginFrame({ taskId: 'task-2', seq: 2, agentId: 'bot-1', workspaceDir: root, providerName: 'p', systemPrompt: 's', history: [], tools: [], userSub: 'owner-2', pins: [pin] });
      await yieldTurn();
      tokenChase.endFrame(h2, { provider: 'p', model: 'm', content: '<attempt_completion><result>done</result></attempt_completion>', contentBlocks: [] });
      tokenChase.finishRun({ taskId: 'task-2', workspaceDir: root, userSub: 'owner-2', turns: 2, outcome: 'completed', pins: [] });
    `);
    const dir = path.join(root, '.tokenchase');
    const frame1 = JSON.parse(fs.readFileSync(path.join(dir, 'frame-0001.json'), 'utf8')) as any;
    const frame2 = JSON.parse(fs.readFileSync(path.join(dir, 'frame-0002.json'), 'utf8')) as any;
    const final = JSON.parse(fs.readFileSync(path.join(dir, 'final.json'), 'utf8')) as any;

    expect(frame1.workspaceTree.files.map((f: any) => f.path)).toEqual(['before.txt']);
    expect(frame2.workspaceTree.files.map((f: any) => f.path)).toEqual(['before.txt', 'out.txt']);
    expect(frame2.pins[0]).toMatchObject({ tool: 'write_to_file', pinned: true });
    expect(frame2.replayable).toBe(true);
    // final.json: the post-tool tree, a final commit chained to the last frame, the owner, and honest store posture.
    expect(final.phase).toBe('final');
    expect(final.outcome).toBe('completed');
    expect(final.turns).toBe(2);
    expect(final.userSub).toBe('owner-2');
    expect(final.workspaceTree.treeSha).toBe(frame2.workspaceTree.treeSha);
    expect(final.workspaceTree.files.map((f: any) => f.path)).toEqual(['before.txt', 'out.txt']);
    expect(final.workspaceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(final.checkpoint.ref).toBe('refs/tokenchase/task-2/final');
    const gitDir = path.join(dir, 'git');
    expect(execFileSync('git', ['--git-dir', gitDir, 'rev-parse', `${final.workspaceCommit}^`], { encoding: 'utf8' }).trim()).toBe(frame2.context.workspaceCommit);
    expect(execFileSync('git', ['--git-dir', gitDir, 'ls-tree', '-r', '--name-only', final.workspaceCommit], { encoding: 'utf8' }).trim().split(/\r?\n/).sort()).toEqual(['before.txt', 'out.txt']);
    expect(final.ownerStoreVersion).toBeNull();
    expect(final.ownerStore.bound).toBe(false);
    expect(final.replayable).toBe(true);
  });

  it('records the configured owner-store version and writes the store manifest beside the frame', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-chase-store-'));
    tempRoots.push(root);
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    captureInChild(root, `
      // Duck-typed snapshotter double (the real one is the TS owner-store-snapshot, proven separately).
      const copied = [];
      tokenChase.configureOwnerStore({ bound: true, snapshot(ownerSub, objectDir) {
        fs.mkdirSync(objectDir, { recursive: true });
        fs.writeFileSync(path.join(objectDir, 'c'.repeat(64)), 'v1:ciphertext-for-' + ownerSub);
        copied.push(ownerSub);
        return { version: 'd'.repeat(64), files: [{ path: 'vault/entities.enc', sha256: 'c'.repeat(64), bytes: 20 }], complete: true, warnings: [] };
      } });
      const h = tokenChase.beginFrame({ taskId: 'task-3', seq: 0, agentId: 'bot-1', workspaceDir: root, providerName: 'p', systemPrompt: 's', history: [], tools: [], userSub: 'owner-3' });
      await yieldTurn();
      tokenChase.endFrame(h, { provider: 'p', model: 'm', content: 'done', contentBlocks: [] });
      tokenChase.finishRun({ taskId: 'task-3', workspaceDir: root, userSub: 'owner-3', turns: 1, outcome: 'completed', pins: [] });
    `);
    const dir = path.join(root, '.tokenchase');
    const frame = JSON.parse(fs.readFileSync(path.join(dir, 'frame-0000.json'), 'utf8')) as any;
    const final = JSON.parse(fs.readFileSync(path.join(dir, 'final.json'), 'utf8')) as any;
    expect(frame.context.ownerStoreVersion).toBe('d'.repeat(64));
    expect(frame.ownerStore).toMatchObject({ bound: true, complete: true, version: 'd'.repeat(64), manifest: `store-${'d'.repeat(64)}.json` });
    expect(final.ownerStoreVersion).toBe('d'.repeat(64));
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, `store-${'d'.repeat(64)}.json`), 'utf8')) as any;
    expect(manifest.files[0].path).toBe('vault/entities.enc');
    expect(fs.readFileSync(path.join(dir, 'store-objects', 'c'.repeat(64)), 'utf8')).toBe('v1:ciphertext-for-owner-3');
  });
});
