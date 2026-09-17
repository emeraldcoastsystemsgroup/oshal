/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove abandoned workspace discovery stops at each awaited port without cancelling other HTTP requests or normal completed requests.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Exercise cancellation through the issuer-qualified coarse-access port.
 */
import express, { type Request, type Response } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createWorkspaceNavigationRoutes } from '@/app/routes/workspace-navigation-routes';
import type { SwarmApplicationRecord, SwarmApplicationSummary } from '@/features/swarm-apps';

const logs = vi.hoisted(() => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn() }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => logs }));
type Options = Parameters<typeof createWorkspaceNavigationRoutes>[0];
type Stage = 'actor' | 'list' | 'record' | 'discover' | 'access' | 'profile' | 'navigate';
const stages: Stage[] = ['actor', 'list', 'record', 'discover', 'access', 'profile', 'navigate'];
const actors = new AsyncLocalStorage<string>();

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function record(name: string): SwarmApplicationRecord {
  return { appId: name, name, displayName: name, description: '', version: '1.0.0', status: 'active',
    manifestPath: `/fixture/${name}/oshal-app.yaml`, agentIds: [], toolNames: [], scope: 'public',
    ownerSub: null, tenantId: null, guestTierApproved: null, loadedAt: new Date(0), updatedAt: new Date(0),
    manifest: { name, displayName: name, version: '1.0.0', status: 'active', theme: 'workspace',
      access: { supported: ['deny', 'viewer'], defaultTier: 'viewer' } } };
}

function summary(name: string): SwarmApplicationSummary {
  return { ...record(name), botCount: 0, toolCount: 0, icon: null, suite: null,
    loadedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), queueId: name, ticketType: null };
}

let server: Server, base: string, options: Options, hold: Stage | undefined, rejectHeld: boolean;
let entered: ReturnType<typeof deferred<void>>, released: ReturnType<typeof deferred<void>>;
let calls: Array<{ owner: string; stage: Stage; name?: string }>;
let exchanges: Map<string, { req: Request; res: Response; completed: ReturnType<typeof deferred<void>>; finished: ReturnType<typeof deferred<void>> }>;

async function port<T>(stage: Stage, value: T, name?: string): Promise<T> {
  const owner = actors.getStore()!; calls.push({ owner, stage, name });
  if (owner === 'abandoned' && stage === hold) {
    entered.resolve(); await released.promise;
    if (rejectHeld) throw new Error('Controlled policy port failed after disconnect');
  }
  return value;
}

function ports(): Options {
  return {
    resolveActor: req => port('actor', { issuer: 'https://identity.fixture.test', sub: req.get('x-fixture-user')!, isActive: true, isSwarmAdmin: false }),
    apps: {
      listApps: () => port('list', ['first', 'second'].map(summary)),
      getAppForViewer: name => port('record', record(name), name),
      synthesiseProfile: name => port('profile', { name, displayName: name, defaultView: 'home', ribbon: {
        items: [{ id: 'home', icon: '', label: name, section: 'top' as const,
          toolUi: { iframeUrl: `/api/${name}/app`, sidebarLabel: name } }], dynamicTools: { allow: [] } } }, name),
    },
    runtime: {
      snapshot: name => ({ app: name, source: 'fixture-source', catalogRevision: 'fixture-catalog', generation: 'fixture-generation' }),
      canDiscover: name => port('discover', true, name),
      canNavigateHttpPath: (_actor, pathname) => port('navigate', true, pathname),
    },
    access: { resolveForPrincipal: (appName, userSub) => port('access', { appName, userSub, tier: 'viewer', bundle: null, source: 'default' }, appName) },
  };
}

beforeEach(async () => {
  vi.clearAllMocks(); hold = undefined; rejectHeld = false; calls = []; exchanges = new Map();
  entered = deferred(); released = deferred(); options = ports();
  logs.info.mockImplementation((_fields, message) => {
    if (message === 'Workspace discovery completed' || message === 'Workspace discovery cancelled') exchanges.get(actors.getStore()!)?.finished.resolve();
  });
  const app = express();
  app.use((req, res, next) => {
    const owner = req.get('x-fixture-user')!, completed = deferred(), finished = deferred();
    exchanges.set(owner, { req, res, completed, finished }); req.once('close', () => completed.resolve());
    req.resume(); actors.run(owner, next);
  });
  app.use('/api/ui', createWorkspaceNavigationRoutes(options));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  released.resolve(); server?.closeAllConnections();
  if (server) await new Promise<void>(done => server.close(() => done()));
  vi.restoreAllMocks();
});

function open(owner: string) {
  const body = deferred<{ status: number; cache?: string; json: unknown }>(), closed = deferred();
  const client = request(`${base}/api/ui/workspaces`, { headers: { 'x-fixture-user': owner } }, res => {
    let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
    res.once('end', () => body.resolve({ status: res.statusCode!, cache: res.headers['cache-control'], json: JSON.parse(text) }));
  });
  client.once('error', error => { if (error.message !== 'fixture client abandoned') throw error; });
  client.once('close', () => closed.resolve()); client.end();
  return { client, body: body.promise, closed: closed.promise };
}

async function disconnect(client: ReturnType<typeof open>) {
  const responseClosed = deferred(); exchanges.get('abandoned')!.res.once('close', () => responseClosed.resolve());
  client.client.destroy(new Error('fixture client abandoned')); await client.closed; await responseClosed.promise;
}

it.each(stages)('stops subsequent discovery ports after disconnect while %s is in flight', async stage => {
  hold = stage; const client = open('abandoned'); await entered.promise;
  const started = calls.filter(call => call.owner === 'abandoned');
  const exchange = exchanges.get('abandoned')!, listeners = exchange.req.listeners('aborted');
  await disconnect(client); released.resolve(); await exchanges.get('abandoned')!.finished.promise;
  expect(calls.filter(call => call.owner === 'abandoned')).toEqual(started);
  expect(started.map(call => call.stage)).toEqual(stages.slice(0, stages.indexOf(stage) + 1));
  expect(logs.info).toHaveBeenCalledWith(expect.objectContaining({ readCount: started.length }), 'Workspace discovery cancelled');
  expect(logs.error).not.toHaveBeenCalled();
  expect(exchange.req.listeners('aborted').filter(listener => listeners.includes(listener))).toEqual([]);
  expect(exchange.res.listeners('close')).toEqual([]);
});

it('keeps another request and a fresh retry independent while one disconnected policy read is pending', async () => {
  hold = 'discover'; const abandoned = open('abandoned'); await entered.promise; await disconnect(abandoned);
  const active = await open('other').body;
  expect(active).toMatchObject({ status: 200, cache: 'private, no-store', json: { workspaces: [
    { name: 'first', href: '/cockpit/?app=first' }, { name: 'second', href: '/cockpit/?app=second' },
  ] } });
  released.resolve(); await exchanges.get('abandoned')!.finished.promise;
  expect(calls.filter(call => call.owner === 'abandoned')).toHaveLength(4);
  expect((await open('retry').body).status).toBe(200);
  expect(calls.filter(call => call.owner === 'retry' && call.stage === 'discover')).toHaveLength(2);
});

it('does not cancel a fully received GET whose normal request close precedes its response', async () => {
  hold = 'profile'; const active = open('abandoned'); await entered.promise;
  const exchange = exchanges.get('abandoned')!; await exchange.completed.promise;
  expect(exchange.req.complete).toBe(true); expect(exchange.req.aborted).toBe(false); expect(exchange.res.destroyed).toBe(false);
  released.resolve(); expect((await active.body).status).toBe(200);
  expect(logs.info.mock.calls.some(([, message]) => message === 'Workspace discovery cancelled')).toBe(false);
  expect(exchange.req.listeners('aborted')).toEqual([]); expect(exchange.res.listeners('close')).toEqual([]);
});

it('handles an in-flight failure after disconnect without a response or unavailable-error report', async () => {
  hold = 'navigate'; rejectHeld = true; const active = open('abandoned'); await entered.promise;
  const json = vi.spyOn(exchanges.get('abandoned')!.res, 'json');
  await disconnect(active); released.resolve(); await exchanges.get('abandoned')!.finished.promise;
  expect(json).not.toHaveBeenCalled(); expect(logs.error).not.toHaveBeenCalled();
  expect(calls.filter(call => call.owner === 'abandoned')).toHaveLength(7);
});

it('retains current denial decisions and checks them again on the next connected request', async () => {
  const canDiscover = vi.spyOn(options.runtime, 'canDiscover').mockResolvedValue(false);
  expect(await open('denied').body).toMatchObject({ status: 200, cache: 'private, no-store', json: { workspaces: [] } });
  expect(calls.some(call => call.stage === 'profile' || call.stage === 'navigate')).toBe(false);
  canDiscover.mockRestore();
  expect((await open('allowed').body).json).toMatchObject({ workspaces: [{ name: 'first' }, { name: 'second' }] });
});

it.each([401, 503])('retains a connected %s identity error and releases lifecycle listeners', async status => {
  vi.spyOn(options, 'resolveActor').mockRejectedValue(Object.assign(new Error('Controlled identity failure'), { status }));
  expect(await open('error').body).toEqual({ status, cache: 'private, no-store', json: {
    error: status === 401 ? 'authorization_identity_required' : 'workspace_navigation_unavailable',
  } });
  const exchange = exchanges.get('error')!;
  expect(exchange.req.listeners('aborted')).toEqual([]); expect(exchange.res.listeners('close')).toEqual([]);
  expect(calls).toEqual([]);
});
