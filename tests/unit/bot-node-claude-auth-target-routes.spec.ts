/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove the actual bot-node Claude Code status/import target routes require strict machine auth, perform no credential probe on denial, and never disclose the mounted credential path.
 */

import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBotNodeClaudeAuthRoutes } from '../../src/app/bot-node-claude-auth-routes';

const SECRET = 'claude-target-test-secret';
const servers: Array<{ close: (cb: () => void) => void }> = [];
let savedSecret: string | undefined;

beforeEach(() => {
  savedSecret = process.env.SWARM_SERVICE_SECRET;
  delete process.env.SWARM_SERVICE_SECRET;
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(resolve))));
  if (savedSecret === undefined) delete process.env.SWARM_SERVICE_SECRET;
  else process.env.SWARM_SERVICE_SECRET = savedSecret;
});

async function boot(fileExists: (path: string) => boolean): Promise<string> {
  const app = express();
  registerBotNodeClaudeAuthRoutes(app, {
    agentId: 'agent-1',
    botName: 'test-bot',
    oauthFilePath: 'C:\\private\\claude-credential.json',
    fileExists,
  });
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}/api/claude-code/auth`;
}

describe('bot-node Claude Code auth propagation targets', () => {
  it('returns 503 when service auth is unconfigured without probing the credential file', async () => {
    const fileExists = vi.fn(() => true);
    const base = await boot(fileExists);
    expect((await fetch(`${base}/status`)).status).toBe(503);
    expect((await fetch(`${base}/import`, { method: 'POST' })).status).toBe(503);
    expect(fileExists).not.toHaveBeenCalled();
  });

  it('returns 401 for missing/wrong machine credentials without touching the credential file', async () => {
    process.env.SWARM_SERVICE_SECRET = SECRET;
    const fileExists = vi.fn(() => true);
    const base = await boot(fileExists);
    expect((await fetch(`${base}/status`)).status).toBe(401);
    expect((await fetch(`${base}/import`, {
      method: 'POST',
      headers: { 'x-service-secret': 'wrong' },
    })).status).toBe(401);
    expect(fileExists).not.toHaveBeenCalled();
  });

  it('serves authorized status/import without returning a host credential path or copying OAuth data', async () => {
    process.env.SWARM_SERVICE_SECRET = SECRET;
    const fileExists = vi.fn(() => true);
    const base = await boot(fileExists);
    const headers = { 'x-service-secret': SECRET };

    const statusResponse = await fetch(`${base}/status`, { headers });
    expect(statusResponse.status).toBe(200);
    const status = await statusResponse.json() as Record<string, unknown>;
    expect(status).toMatchObject({ success: true, authenticated: true, botName: 'test-bot', agentId: 'agent-1' });
    expect(status).not.toHaveProperty('filePath');

    const importResponse = await fetch(`${base}/import`, { method: 'POST', headers });
    expect(importResponse.status).toBe(200);
    const imported = await importResponse.json() as Record<string, unknown>;
    expect(imported).toMatchObject({ success: true, imported: false, filePresent: true });
    expect(imported).not.toHaveProperty('filePath');
    expect(fileExists).toHaveBeenCalledTimes(2);
  });
});
