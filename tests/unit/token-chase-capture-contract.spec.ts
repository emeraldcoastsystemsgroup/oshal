/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Subprocess proof that Token Chase capture writes bounded content-addressed workspace objects, full tool schemas, provenance refs and caller-declared non-replayable pins.
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

describe('Token Chase capture provenance contract', () => {
  it('writes the promised tree, schema, refs and non-replayable decision off the call path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-chase-capture-'));
    tempRoots.push(root);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'ignored'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'main.txt'), 'captured workspace text');
    fs.writeFileSync(path.join(root, 'node_modules', 'ignored', 'secret.txt'), 'must not enter the tree');
    const modulePath = path.resolve('any-bot/server/services/token-chase/TokenChaseCapture.js');
    const script = `
      const { tokenChase } = require(${JSON.stringify(modulePath)});
      const handle = tokenChase.beginFrame({
        taskId: 'task-1', seq: 0, agentId: 'bot-1', workspaceDir: ${JSON.stringify(root)},
        providerName: 'provider', systemPrompt: 'system', source: 'test', userSub: 'owner-1',
        workspaceCommit: 'commit-abc', ownerStoreVersion: 'encrypted-ref-1', replayable: false,
        pins: [{ tool: 'read_file', pinned: false }], history: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } } }]
      });
      tokenChase.endFrame(handle, { provider: 'provider', model: 'model', content: 'answer', contentBlocks: [], usage: { inputTokens: 2, outputTokens: 3 } });
      setTimeout(() => {}, 80);
    `;
    execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TOKEN_CHASE_CAPTURE: 'true' }, stdio: 'pipe' });
    const framePath = path.join(root, '.tokenchase', 'frame-0000.json');
    const frame = JSON.parse(fs.readFileSync(framePath, 'utf8')) as any;
    expect(frame.replayable).toBe(false);
    expect(frame.pins).toEqual([{ tool: 'read_file', pinned: false }]);
    expect(frame.context.toolSchema[0].parameters.type).toBe('object');
    expect(frame.context.workspaceCommit).toBe('commit-abc');
    expect(frame.context.ownerStoreVersion).toBe('encrypted-ref-1');
    expect(frame.workspaceTree.files).toHaveLength(1);
    const entry = frame.workspaceTree.files[0];
    expect(entry.path).toBe('src/main.txt');
    expect(entry.sha256).toBe(crypto.createHash('sha256').update('captured workspace text').digest('hex'));
    expect(fs.readFileSync(path.join(root, '.tokenchase', 'objects', entry.sha256), 'utf8')).toBe('captured workspace text');
    expect(fs.existsSync(path.join(root, '.tokenchase', 'objects', 'ignored'))).toBe(false);
  });
});
