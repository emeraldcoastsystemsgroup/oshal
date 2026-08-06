/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added behavioral guards for Task Explorer owner isolation, DB-backed browsing, guessed-folder denial, bounded previews/trees, path redaction, traversal rejection, and symlink/junction containment.
 */

import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaskExplorerRoutes } from '../../src/app/routes/task-explorer-routes';
import type { AppContext } from '../../src/app/composition-root';
import type { ITaskStore } from '../../src/entities/task';
import type { ITicketStore } from '../../src/entities/ticket';
import { TaskExplorerWorkspaceService } from '../../src/features/task-explorer/services/task-explorer-workspace-service';
import { InMemoryWorkspaceStore } from '../../src/features/ticketing/services/in-memory-workspace-store';
import { WorkspaceService } from '../../src/features/ticketing/services/workspace-service';

const OWNER_A = 'auth0|workspace-owner-a';
const OWNER_B = 'auth0|workspace-owner-b';
const ROOT_ENV_KEYS = [
  'OSHAL_WORKSPACE_ROOT',
  'SHARED_WORKSPACE_ROOT',
  'CLINE_WORKSPACE_ROOT',
  'WORKSPACE_ROOT',
] as const;

interface Fixture {
  base: string;
  root: string;
  explorer: TaskExplorerWorkspaceService;
  taskStore: ITaskStore;
  workspaceService: WorkspaceService;
  workspaceLinks: Map<string, string>;
  workspaceAId: string;
  workspaceBId: string;
  workspaceAPath: string;
  workspaceBPath: string;
}

let savedEnv: Record<string, string | undefined> = {};
let fixture: Fixture;

beforeEach(async () => {
  savedEnv = Object.fromEntries(ROOT_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ROOT_ENV_KEYS) delete process.env[key];
  fixture = await createFixture();
});

afterEach(() => {
  fs.rmSync(fixture.base, { recursive: true, force: true });
  for (const key of ROOT_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('Task Explorer workspace isolation', () => {
  it('denies cross-owner task/workspace guesses and never treats a folder name as authority', async () => {
    const guessedPath = path.join(fixture.root, 'guessed-folder');
    fs.mkdirSync(guessedPath);
    fs.writeFileSync(path.join(guessedPath, 'secret.txt'), 'unowned secret');

    await expect(fixture.explorer.getWorkspaceFiles('task-b', OWNER_A)).rejects.toThrow('Workspace not found');
    await expect(fixture.explorer.getWorkspaceFiles(fixture.workspaceBId, OWNER_A)).rejects.toThrow('Workspace not found');
    await expect(fixture.explorer.getWorkspaceFiles('guessed-folder', OWNER_A)).rejects.toThrow('Workspace not found');
    await expect(fixture.explorer.getWorkspaceFiles('task-a', OWNER_A.toUpperCase())).rejects.toThrow('Workspace not found');

    const operatorTree = await fixture.explorer.getWorkspaceFiles('task-b', OWNER_A, true);
    expect(operatorTree.exists).toBe(true);
  });

  it('scopes browse results to DB-owned records and emits no host paths', async () => {
    const ownerView = await fixture.explorer.browseWorkspaces(OWNER_A);
    expect(ownerView.basePath).toBe('workspace');
    expect(ownerView.workspaces).toEqual([
      expect.objectContaining({ name: 'workspace-a', path: fixture.workspaceAId }),
    ]);
    expect(JSON.stringify(ownerView)).not.toContain(fixture.root);
    expect(JSON.stringify(ownerView)).not.toContain('workspace-b');

    const operatorView = await fixture.explorer.browseWorkspaces(OWNER_A, true);
    expect(operatorView.workspaces.map((item) => item.name).sort()).toEqual(['workspace-a', 'workspace-b']);
  });

  it('threads the authenticated request subject into route-level tree and browse checks', async () => {
    const { server, baseUrl } = await serveTaskExplorer();
    try {
      const denied = await fetch(`${baseUrl}/api/v1/workspace/task-b/files`, {
        headers: { 'x-test-user-sub': OWNER_A },
      });
      const browse = await fetch(`${baseUrl}/api/v1/workspace/browse`, {
        headers: { 'x-test-user-sub': OWNER_A },
      });
      const browseBody = await browse.json() as { data: { workspaces: Array<{ name: string }> } };
      expect(denied.status).toBe(404);
      expect(browse.status).toBe(200);
      expect(browseBody.data.workspaces.map((workspace) => workspace.name)).toEqual(['workspace-a']);
    } finally {
      await closeServer(server);
    }
  });

  it('reads only the preview budget and rejects encoded traversal', async () => {
    const previewBytes = 256 * 1024;
    fs.writeFileSync(path.join(fixture.workspaceAPath, 'large.txt'), 'a'.repeat(previewBytes + 4_096));
    fs.writeFileSync(path.join(fixture.root, 'outside.txt'), 'outside');

    const preview = await fixture.explorer.getWorkspaceFileContent('task-a', 'large.txt', OWNER_A);
    expect((preview.content as string).length).toBe(previewBytes);
    expect(preview.truncated).toBe(true);
    expect(preview).not.toHaveProperty('absolutePath');
    expect(JSON.stringify(preview)).not.toContain(fixture.root);

    await expect(
      fixture.explorer.getWorkspaceFileContent('task-a', '../outside.txt', OWNER_A),
    ).rejects.toThrow('escapes workspace root');
  });

  it('rejects a symlink or Windows junction before tree or preview traversal', async () => {
    const outside = path.join(fixture.base, 'outside-tree');
    const link = path.join(fixture.workspaceAPath, 'linked-outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret');
    createDirectoryLink(outside, link);

    await expect(fixture.explorer.getWorkspaceFiles('task-a', OWNER_A)).rejects.toThrow('links are not supported');
    await expect(
      fixture.explorer.getWorkspaceFileContent('task-a', 'linked-outside/secret.txt', OWNER_A),
    ).rejects.toThrow('links are not supported');
  });
});

describe('Task Explorer traversal budgets', () => {
  it('bounds top-level browse scans even when a workspace contains only directories', async () => {
    for (let index = 0; index < 1_001; index += 1) {
      fs.mkdirSync(path.join(fixture.workspaceAPath, `directory-${String(index).padStart(4, '0')}`));
    }

    const browse = await fixture.explorer.browseWorkspaces(OWNER_A);
    expect(browse.workspaces[0]).toMatchObject({ truncated: true });
    expect(browse.workspaces[0].fileCount).toBeLessThanOrEqual(1);
  });

  it('stops at the global file-count limit instead of enumerating an unbounded directory', async () => {
    writeNumberedFiles(fixture.workspaceAPath, 505);
    const tree = await fixture.explorer.getWorkspaceFiles('task-a', OWNER_A);
    const scanned = tree.scanned as { files: number; entries: number };
    expect(tree.truncated).toBe(true);
    expect(scanned.files).toBe(500);
    expect(scanned.entries).toBeLessThanOrEqual(501);
  });

  it('stops before admitting a file beyond the aggregate byte budget', async () => {
    fs.rmSync(path.join(fixture.workspaceAPath, 'owner-a.txt'));
    const hugePath = path.join(fixture.workspaceAPath, 'huge.txt');
    fs.closeSync(fs.openSync(hugePath, 'w'));
    fs.truncateSync(hugePath, (32 * 1024 * 1024) + 1);

    const tree = await fixture.explorer.getWorkspaceFiles('task-a', OWNER_A);
    const scanned = tree.scanned as { files: number; fileBytes: number };
    expect(tree.truncated).toBe(true);
    expect(scanned.files).toBe(0);
    expect(scanned.fileBytes).toBe(0);
  });

  it('stops recursive descent at the configured depth budget', async () => {
    let current = fixture.workspaceAPath;
    for (let depth = 0; depth < 12; depth += 1) {
      current = path.join(current, `depth-${depth}`);
      fs.mkdirSync(current);
    }
    fs.writeFileSync(path.join(current, 'too-deep.txt'), 'hidden by depth budget');

    const tree = await fixture.explorer.getWorkspaceFiles('task-a', OWNER_A);
    expect(tree.truncated).toBe(true);
    expect(JSON.stringify(tree)).not.toContain('too-deep.txt');
  });
});

async function createFixture(): Promise<Fixture> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-explorer-isolation-'));
  const root = path.join(base, 'workspace');
  process.env.OSHAL_WORKSPACE_ROOT = root;
  const workspaceLinks = new Map<string, string>();
  const workspaceService = new WorkspaceService(new InMemoryWorkspaceStore(), ticketStore(workspaceLinks));
  const workspaceAPath = path.join(root, 'task-a');
  const workspaceBPath = path.join(root, 'task-b');
  const workspaceA = await workspaceService.createWorkspace(workspaceInput('workspace-a', workspaceAPath, OWNER_A));
  const workspaceB = await workspaceService.createWorkspace(workspaceInput('workspace-b', workspaceBPath, OWNER_B));
  workspaceLinks.set('task-a', workspaceA.workspaceId);
  workspaceLinks.set('task-b', workspaceB.workspaceId);
  fs.writeFileSync(path.join(workspaceAPath, 'owner-a.txt'), 'owner a');
  fs.writeFileSync(path.join(workspaceBPath, 'owner-b.txt'), 'owner b');
  const tasks = taskStore();
  const explorer = new TaskExplorerWorkspaceService(tasks, workspaceService);
  return {
    base, root, explorer, taskStore: tasks, workspaceService, workspaceLinks,
    workspaceAId: workspaceA.workspaceId, workspaceBId: workspaceB.workspaceId,
    workspaceAPath, workspaceBPath,
  };
}

function workspaceInput(name: string, workspacePath: string, ownerSub: string) {
  return { name, path: workspacePath, ownerSub, metadata: {}, projectName: null };
}

function taskStore(): ITaskStore {
  const tasks = new Map([
    ['task-a', { taskId: 'task-a', ownerSub: OWNER_A }],
    ['task-b', { taskId: 'task-b', ownerSub: OWNER_B }],
  ]);
  return { get: vi.fn(async (taskId: string) => tasks.get(taskId) ?? null) } as unknown as ITaskStore;
}

function ticketStore(workspaceLinks: Map<string, string>): ITicketStore {
  return {
    get: vi.fn(async () => null),
    getTicketLinksForTask: vi.fn(async () => []),
    getWorkspaceLinks: vi.fn(async (ticketId: string) => {
      const workspaceId = workspaceLinks.get(ticketId);
      return workspaceId ? [{ ticketId, workspaceId }] : [];
    }),
  } as unknown as ITicketStore;
}

function createDirectoryLink(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

function writeNumberedFiles(directory: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    fs.writeFileSync(path.join(directory, `file-${String(index).padStart(4, '0')}.txt`), 'x');
  }
}

async function serveTaskExplorer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use((req, _res, next) => {
    const sub = req.header('x-test-user-sub') ?? '';
    (req as typeof req & { oidc: { user: { sub: string } } }).oidc = { user: { sub } };
    next();
  });
  const ctx = {
    taskStore: fixture.taskStore,
    messageStore: {},
    workspaceService: fixture.workspaceService,
  } as AppContext;
  app.use('/api/v1', createTaskExplorerRoutes(ctx));
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Task Explorer test server failed to bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
