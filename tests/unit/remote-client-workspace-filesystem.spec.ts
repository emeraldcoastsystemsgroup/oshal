/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Drive held-task workspace upload/download routes against real files and prove link-free parents, single-link reads, atomic private publication, traversal refusal, and external-data preservation.
 */

import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const CLIENT_ID = 'desktop-workspace-proof';
const TASK_ID = 'task-workspace-proof';
const FOLDER_ID = 'apply-11111111-2222-4333-8444-555555555555';
const ENV_KEYS = ['SHARED_WORKSPACE_ROOT', 'WORKSPACE_DIR', 'WORKSPACE_ROOT'] as const;

let savedEnv: Record<string, string | undefined>;
let base: string;
let workspace: string;
let outside: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-remote-workspace-'));
  const sharedRoot = path.join(base, 'shared');
  workspace = path.join(sharedRoot, FOLDER_ID);
  outside = path.join(base, 'outside');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside);
  process.env.SHARED_WORKSPACE_ROOT = sharedRoot;
  delete process.env.WORKSPACE_DIR;
  delete process.env.WORKSPACE_ROOT;
  vi.resetModules();
  const { registerRemoteClientWorkspaceRoutes } = await import(
    '../../src/app/routes/remote-client-workspace-routes'
  );
  const router = express.Router();
  const registry = {
    getInFlightTask: vi.fn(async (clientId: string, taskId: string) =>
      clientId === CLIENT_ID && taskId === TASK_ID ? { workspacePath: FOLDER_ID } : null),
  };
  registerRemoteClientWorkspaceRoutes(router, (_req, _res, next) => next(), {
    registry: registry as never,
    isMachineCaller: () => false,
  });
  const app = express();
  app.use('/api/remote-clients', router);
  server = await listen(app);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Remote workspace test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(base, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('held remote workspace filesystem boundary', () => {
  it('publishes nested uploads privately and returns only the exact held file', async () => {
    const content = Buffer.from('validated confirmation bytes');
    const response = await request('PUT', 'nested/confirmation.txt', content);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true, path: 'nested/confirmation.txt', bytes: content.length,
    });

    const target = path.join(workspace, 'nested', 'confirmation.txt');
    expect(fs.readFileSync(target)).toEqual(content);
    if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(uploadTemps(workspace)).toEqual([]);

    const downloaded = await request('GET', 'nested/confirmation.txt');
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(content);
    const manifest = await fetch(
      `${baseUrl}/api/remote-clients/${CLIENT_ID}/tasks/${TASK_ID}/workspace`,
    );
    expect(await manifest.json()).toMatchObject({
      folderId: FOLDER_ID,
      files: [expect.objectContaining({ path: 'nested/confirmation.txt', size: content.length })],
    });
  });

  it('refuses a linked parent for reads and writes without touching external data', async () => {
    const marker = path.join(outside, 'junction-marker.txt');
    fs.writeFileSync(marker, 'external-original');
    createDirectoryLink(outside, path.join(workspace, 'linked-parent'));

    const read = await request('GET', 'linked-parent/junction-marker.txt');
    const write = await request('PUT', 'linked-parent/junction-marker.txt', Buffer.from('attacker-write'));

    expect(read.status).toBe(400);
    expect(write.status).toBe(400);
    expect(fs.readFileSync(marker, 'utf8')).toBe('external-original');
    expect(fs.existsSync(path.join(outside, 'new-file.txt'))).toBe(false);
    expect(uploadTemps(workspace)).toEqual([]);
  });

  it('refuses a multi-link target and traversal without changing its external referent', async () => {
    const external = path.join(outside, 'hardlink-marker.txt');
    const target = path.join(workspace, 'hardlink-marker.txt');
    fs.writeFileSync(external, 'hardlink-original');
    fs.linkSync(external, target);

    expect((await request('GET', 'hardlink-marker.txt')).status).toBe(400);
    expect((await request('PUT', 'hardlink-marker.txt', Buffer.from('replacement'))).status).toBe(400);
    expect((await request('PUT', '../../outside/escaped.txt', Buffer.from('escape'))).status).toBe(400);
    expect(fs.readFileSync(external, 'utf8')).toBe('hardlink-original');
    expect(fs.existsSync(path.join(outside, 'escaped.txt'))).toBe(false);
    expect(uploadTemps(workspace)).toEqual([]);
  });

  it('does not reveal a workspace for a task the client does not hold', async () => {
    const url = `${baseUrl}/api/remote-clients/wrong-client/tasks/${TASK_ID}/workspace`;
    const response = await fetch(url);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'No workspace for a task this client holds' });
  });
});

/** Start an ephemeral HTTP server. */
function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve, reject) => {
    const current = app.listen(0, '127.0.0.1', () => resolve(current));
    current.on('error', reject);
  });
}

/** Issue one held-task file request with a safely encoded relative path. */
function request(method: 'GET' | 'PUT', filePath: string, body?: Buffer): Promise<Response> {
  const route = `/api/remote-clients/${CLIENT_ID}/tasks/${TASK_ID}/workspace/file`;
  return fetch(`${baseUrl}${route}?path=${encodeURIComponent(filePath)}`, {
    method,
    headers: method === 'PUT' ? { 'content-type': 'application/octet-stream' } : undefined,
    body,
  });
}

/** Recursively list temporary upload entries retained beneath one task folder. */
function uploadTemps(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.oshal-upload-')) found.push(entry.name);
    else if (entry.isDirectory()) found.push(...uploadTemps(path.join(directory, entry.name)));
  }
  return found;
}

/** Create a directory link without requiring Windows file-symlink privileges. */
function createDirectoryLink(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}
