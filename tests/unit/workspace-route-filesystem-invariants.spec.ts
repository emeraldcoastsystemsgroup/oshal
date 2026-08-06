/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added HTTP and service guards for server-controlled workspace paths, immutable exact owners, redacted responses, cross-user ID denial, and filesystem validation before database deletion.
 */

import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceRoutes } from '../../src/app/routes/workspace-routes';
import type { AppContext } from '../../src/app/composition-root';
import type { ITicketStore } from '../../src/entities/ticket';
import { InMemoryWorkspaceStore } from '../../src/features/ticketing/services/in-memory-workspace-store';
import { WorkspaceService } from '../../src/features/ticketing/services/workspace-service';

const OWNER_A = 'auth0|workspace-api-owner-a';
const OWNER_B = 'auth0|workspace-api-owner-b';
const ROOT_ENV_KEYS = [
  'OSHAL_WORKSPACE_ROOT',
  'SHARED_WORKSPACE_ROOT',
  'CLINE_WORKSPACE_ROOT',
  'WORKSPACE_ROOT',
  'OSHAL_OPERATOR_SUBS',
] as const;

interface RouteFixture {
  base: string;
  root: string;
  baseUrl: string;
  server: Server;
  store: InMemoryWorkspaceStore;
  service: WorkspaceService;
}

let savedEnv: Record<string, string | undefined> = {};
let fixture: RouteFixture;

beforeEach(async () => {
  savedEnv = Object.fromEntries(ROOT_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ROOT_ENV_KEYS) delete process.env[key];
  fixture = await startRouteFixture();
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(fixture.base, { recursive: true, force: true });
  for (const key of ROOT_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('workspace route immutable fields', () => {
  it('rejects caller-supplied path/owner and creates an owner-stamped managed path', async () => {
    const outside = path.join(fixture.base, 'caller-selected');
    const rejected = await api('/api/workspaces', OWNER_A, {
      method: 'POST',
      body: { name: 'unsafe', path: outside, ownerSub: OWNER_B },
    });
    expect(rejected.status).toBe(400);

    const created = await api('/api/workspaces', OWNER_A, {
      method: 'POST',
      body: { name: 'owner-a-workspace', metadata: { color: 'blue' } },
    });
    expect(created.status).toBe(201);
    expect(created.body).not.toHaveProperty('path');
    expect(created.body.ownerSub).toBe(OWNER_A);

    const record = await fixture.store.get(created.body.workspaceId as string);
    expect(record?.ownerSub).toBe(OWNER_A);
    expect(record?.path.startsWith(`${fixture.root}${path.sep}managed${path.sep}`)).toBe(true);
    expect(fs.statSync(record!.path).isDirectory()).toBe(true);
  });

  it('rejects path/owner updates at both HTTP and service boundaries', async () => {
    const created = await createWorkspace('immutable-workspace');
    const before = await fixture.store.get(created.workspaceId);
    const response = await api(`/api/workspaces/${created.workspaceId}`, OWNER_A, {
      method: 'PATCH',
      body: { path: path.join(fixture.base, 'escape'), ownerSub: OWNER_B },
    });
    expect(response.status).toBe(400);
    await expect(fixture.service.updateWorkspace(
      created.workspaceId,
      { path: path.join(fixture.base, 'escape') } as never,
    )).rejects.toThrow('immutable');

    const after = await fixture.store.get(created.workspaceId);
    expect(after?.path).toBe(before?.path);
    expect(after?.ownerSub).toBe(before?.ownerSub);
  });

  it('returns 404 for cross-user get/delete guesses and keeps the workspace intact', async () => {
    const created = await createWorkspace('cross-user-workspace');
    const record = await fixture.store.get(created.workspaceId);
    const getResponse = await api(`/api/workspaces/${created.workspaceId}`, OWNER_B);
    const deleteResponse = await api(`/api/workspaces/${created.workspaceId}`, OWNER_B, { method: 'DELETE' });
    const listResponse = await api('/api/workspaces', OWNER_B);

    expect(getResponse.status).toBe(404);
    expect(deleteResponse.status).toBe(404);
    expect(listResponse.body).toMatchObject({ workspaces: [], count: 0 });
    expect(await fixture.store.get(created.workspaceId)).not.toBeNull();
    expect(fs.existsSync(record!.path)).toBe(true);
  });

  it('does not mutate an existing workspace when another owner reuses its name', async () => {
    const created = await createWorkspace('globally-conflicting-name');
    const before = await fixture.store.get(created.workspaceId);
    const response = await api('/api/workspaces', OWNER_B, {
      method: 'POST',
      body: { name: 'globally-conflicting-name', metadata: { attacker: true } },
    });

    expect(response.status).toBe(409);
    const after = await fixture.store.get(created.workspaceId);
    expect(after).toEqual(before);
    expect(after?.metadata).not.toHaveProperty('attacker');
  });
});

describe('workspace delete ordering and containment', () => {
  it('keeps the DB record when the target was replaced by a junction or symlink', async () => {
    const created = await createWorkspace('linked-delete-workspace');
    const record = await fixture.store.get(created.workspaceId);
    const outside = path.join(fixture.base, 'outside-delete-target');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'must-survive.txt'), 'survives');
    fs.rmSync(record!.path, { recursive: true });
    createDirectoryLink(outside, record!.path);

    const response = await api(`/api/workspaces/${created.workspaceId}`, OWNER_A, { method: 'DELETE' });

    expect(response.status).toBe(400);
    expect(await fixture.store.get(created.workspaceId)).not.toBeNull();
    expect(fs.readFileSync(path.join(outside, 'must-survive.txt'), 'utf8')).toBe('survives');
  });

  it('refuses an out-of-root stored target before deleting authoritative state', async () => {
    const outside = path.join(fixture.base, 'outside-row-target');
    fs.mkdirSync(outside);
    const record = await fixture.store.create({ name: 'malformed-row', path: outside, ownerSub: OWNER_A });

    await expect(fixture.service.deleteWorkspace(record.workspaceId)).rejects.toThrow('below the shared');
    expect(await fixture.store.get(record.workspaceId)).not.toBeNull();
    expect(fs.existsSync(outside)).toBe(true);
  });
});

async function startRouteFixture(): Promise<RouteFixture> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-workspace-route-'));
  const root = path.join(base, 'workspace');
  process.env.OSHAL_WORKSPACE_ROOT = root;
  const store = new InMemoryWorkspaceStore();
  const service = new WorkspaceService(store, emptyTicketStore());
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sub = req.header('x-test-user-sub') ?? '';
    (req as typeof req & { oidc: { user: { sub: string } } }).oidc = { user: { sub } };
    next();
  });
  app.use('/api/workspaces', createWorkspaceRoutes({ workspaceService: service } as AppContext));
  const server = await listen(app);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port');
  return { base, root, server, store, service, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function api(
  requestPath: string,
  sub: string,
  options: { method?: string; body?: Record<string, unknown> } = {},
) {
  const response = await fetch(`${fixture.baseUrl}${requestPath}`, {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json', 'x-test-user-sub': sub },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function createWorkspace(name: string): Promise<{ workspaceId: string }> {
  const response = await api('/api/workspaces', OWNER_A, { method: 'POST', body: { name } });
  expect(response.status).toBe(201);
  return { workspaceId: String(response.body.workspaceId) };
}

function emptyTicketStore(): ITicketStore {
  return {
    get: vi.fn(async () => null),
    getTicketLinksForTask: vi.fn(async () => []),
    getWorkspaceLinks: vi.fn(async () => []),
  } as unknown as ITicketStore;
}

function createDirectoryLink(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}
