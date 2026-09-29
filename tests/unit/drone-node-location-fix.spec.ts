/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L6: the drone node's position posts, across the real process and HTTP boundary. The REAL drone node (src/app/drone-node-server.ts, sim engine) runs as its own process with an isolated environment. A half credential pair (either variable alone) and a device id that is not a location device id each stop it at start with exit 1 and the reason. With the credential a group admin issued behind the step-up proof, it posts through a recording loopback relay to the localhost fixture server's REAL CLI-token middleware and /api/location ingest over a private PostgreSQL owned by the enforcing runtime role: the request is POST /api/location/devices/<id>/presence with Authorization: Bearer <token> and no X-Service-Secret (the heartbeat keeps the secret), the body carries the telemetry point, the observation time and mock:true, it posts again on DRONE_LOCATION_INTERVAL_S, and the fix is stored as device:<id> for the group, flagged mock and placed in the group place; the node never logs the position or the token. DRONE_LOCATION_INTERVAL_S=0 keeps the node running and heartbeating and posts nothing. Synthetic identities and coordinates only.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as net from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenant } from '@/app/routes/connector-tenancy';
import { asSession } from '../helpers/location-postgres-fixture';
import { MOCK_ISSUER, MOCK_SUB_HEADER, countRows, startLocationBrowserServer, type LocationBrowserServer } from '../helpers/location-browser-server';

const REPO_ROOT = resolve(__dirname, '../..');
const NODE_SECRET = 'drone-node-location-fixture-secret';
const ADMIN = 'loc-l6-node-admin';
const HOME = { lat: -12.35, lon: -31.99 };
const DEVICE_UUID = '00000000-0000-4000-8000-000000000169';
const NAVIGATE = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

/** A drone node process and everything it printed. */
interface NodeRun {
  child: ChildProcessWithoutNullStreams;
  output: string;
  exited: Promise<number | null>;
}

/** One request the relay saw, with the status the fixture server answered. */
interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  status: number;
}

/** The recording loopback relay the node posts to; it forwards every request to the fixture server. */
interface Relay {
  base: string;
  seen: Seen[];
  /** Requests received and not yet answered (a stopped node's last post can still be in flight). */
  pending: number;
  close: () => Promise<void>;
}

async function allocateLoopbackPort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

/** Start the real drone node on the sim engine with only the variables given (no inherited credentials). */
async function startNode(vars: Record<string, string>): Promise<NodeRun> {
  const port = await allocateLoopbackPort();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    NODE_ENV: 'test', LOG_LEVEL: 'info', SWARM_SERVICE_SECRET: NODE_SECRET, DRONE_PROVIDER: 'sim',
    DRONE_NODE_PORT: String(port), DRONE_NODE_ENDPOINT: `http://127.0.0.1:${port}`, DRONE_LINK_FAILSAFE_S: '0',
    DRONE_HOME_LAT: String(HOME.lat), DRONE_HOME_LON: String(HOME.lon), OSHAL_API_URL: 'http://127.0.0.1:1', ...vars,
  };
  // One process (the tsx loader in-process, not the tsx CLI's child), so stopping it leaves no orphan.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/app/drone-node-server.ts'], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const run: NodeRun = { child, output: '', exited: once(child, 'exit').then(([code]) => code as number | null) };
  child.stdout.on('data', (chunk) => { run.output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { run.output += chunk.toString(); });
  return run;
}

async function stopNode(run: NodeRun): Promise<void> {
  if (run.child.exitCode === null) run.child.kill();
  await run.exited;
}

async function exitCodeOf(vars: Record<string, string>): Promise<{ code: number | null; output: string }> {
  const run = await startNode(vars);
  const code = await Promise.race([run.exited, new Promise<'running'>((done) => setTimeout(() => done('running'), 45_000))]);
  if (code === 'running') await stopNode(run);
  return { code: code === 'running' ? -1 : code, output: run.output };
}

async function until(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function forward(target: string, relay: Relay, req: http.IncomingMessage, body: string, res: http.ServerResponse): Promise<void> {
  const { seen } = relay;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string' && !['host', 'content-length', 'connection'].includes(name)) headers[name] = value;
  }
  try {
    const upstream = await fetch(`${target}${req.url}`, { method: req.method, headers, body: body || undefined, redirect: 'manual' });
    const text = await upstream.text();
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, status: upstream.status });
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'text/plain' }).end(text);
  } catch (err) {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, status: 0 });
    res.writeHead(502, { 'content-type': 'text/plain' }).end(String((err as Error).message));
  } finally {
    relay.pending -= 1;
  }
}

async function startRelay(target: string): Promise<Relay> {
  const server = http.createServer((req, res) => {
    relay.pending += 1;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => { void forward(target, relay, req, Buffer.concat(chunks).toString('utf8'), res); });
  });
  const relay: Relay = {
    base: '', seen: [], pending: 0,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  relay.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return relay;
}

describe('the drone node refuses a broken location credential at start', () => {
  it('either variable alone is a half pair: exit 1 with the reason', async () => {
    const halves: Record<string, string>[] = [{ OSHAL_LOCATION_TOKEN: 'oshal_pat_fixture' }, { OSHAL_LOCATION_DEVICE_ID: DEVICE_UUID }];
    for (const vars of halves) {
      const { code, output } = await exitCodeOf(vars);
      expect(code, JSON.stringify(vars)).toBe(1);
      expect(output).toContain('OSHAL_LOCATION_DEVICE_ID and OSHAL_LOCATION_TOKEN go together');
    }
  }, 120_000);

  it('a device id that is not a location device id: exit 1 with the reason', async () => {
    const { code, output } = await exitCodeOf({ OSHAL_LOCATION_DEVICE_ID: 'drone-1', OSHAL_LOCATION_TOKEN: 'oshal_pat_fixture' });
    expect(code).toBe(1);
    expect(output).toContain('must be the location device id');
  }, 60_000);
});

describe('the drone node posts fixes under its location credential to the real ingest', () => {
  let fx: LocationBrowserServer;
  let relay: Relay;
  const ids = { group: '', place: '', drone: '' };
  let token = '';

  async function call(sub: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Record<string, any>> {
    const res = await fetch(`${fx.base}/api/location${path}`, {
      method, redirect: 'manual', headers: { [MOCK_SUB_HEADER]: sub, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, ...(await res.json().catch(() => ({})) as Record<string, any>) };
  }

  function navigate(sub: string, path: string): Promise<number> {
    return new Promise((done, fail) => {
      const req = http.request(`${fx.base}/api/location${path}`, { method: 'GET', headers: { [MOCK_SUB_HEADER]: sub, ...NAVIGATE } }, (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      });
      req.on('error', fail);
      req.end();
    });
  }

  /** The group admin issues the drone's credential behind the step-up proof, as Settings, Location does. */
  async function issueCredential(): Promise<string> {
    const params = { deviceId: ids.drone, precisionClass: 'exact' };
    const opened = await call(ADMIN, 'POST', '/step-up', { operation: 'approve-enrolment', params });
    expect(opened.status).toBe(201);
    expect(await navigate(ADMIN, `/step-up/${opened.challengeId}/start`)).toBe(303);
    const issued = await call(ADMIN, 'POST', `/devices/${ids.drone}/credential`, { precisionClass: 'exact' },
      { 'x-oshal-location-step-up': opened.challengeId });
    expect(issued.status).toBe(201);
    return String(issued.credential.token);
  }

  const presence = (): Seen[] => relay.seen.filter((s) => s.url.endsWith('/presence'));
  const heartbeatsFrom = (droneId: string): Seen[] => relay.seen.filter((s) => s.url === '/api/drone/nodes/heartbeat'
    && (JSON.parse(s.body) as { droneId?: string }).droneId === droneId);

  beforeAll(async () => {
    fx = await startLocationBrowserServer('drone-node-location-fix', [], { bearer: true });
    const admin = { sub: ADMIN, issuer: MOCK_ISSUER };
    ids.group = (await asSession(admin, () => createTenant(fx.runtime, { name: 'Household', createdBySub: ADMIN }))).tenant_id;
    ids.place = (await call(ADMIN, 'POST', '/places', { name: 'Field', center: HOME, groupId: ids.group })).place.placeId;
    ids.drone = (await call(ADMIN, 'POST', '/devices', { kind: 'drone', ref: 'drone-1', groupId: ids.group })).device.deviceId;
    token = await issueCredential();
    relay = await startRelay(fx.base);
  }, 180_000);

  afterAll(async () => {
    await relay?.close();
    await fx?.close();
  }, 60_000);

  it('posts a Bearer fix with no service secret, flagged mock for the sim engine, on the interval; stored as the device subject', async () => {
    const run = await startNode({ DRONE_NODE_ID: 'loc-fix-drone', OSHAL_API_URL: relay.base,
      OSHAL_LOCATION_DEVICE_ID: ids.drone, OSHAL_LOCATION_TOKEN: token, DRONE_LOCATION_INTERVAL_S: '1' });
    try {
      await until('two position posts', () => presence().length >= 2);
    } finally {
      await stopNode(run);
    }
    const first = presence()[0];
    expect(first).toMatchObject({ method: 'POST', url: `/api/location/devices/${ids.drone}/presence`, status: 201 });
    expect(first.headers.authorization).toBe(`Bearer ${token}`);
    expect(first.headers['x-service-secret']).toBeUndefined();
    const body = JSON.parse(first.body) as Record<string, unknown>;
    expect(body).toMatchObject({ lat: HOME.lat, lon: HOME.lon, mock: true });
    expect(Number.isNaN(Date.parse(String(body.observedAt)))).toBe(false);
    expect(presence().every((s) => s.status === 201 && s.headers['x-service-secret'] === undefined)).toBe(true);
    expect(heartbeatsFrom('loc-fix-drone')[0].headers['x-service-secret']).toBe(NODE_SECRET);
    const rows = (await fx.db.pool.query('SELECT DISTINCT subject_ref, tenant_id, owner_sub, source, mock_location FROM location_observations WHERE device_id = $1', [ids.drone])).rows;
    expect(rows).toEqual([{ subject_ref: `device:${ids.drone}`, tenant_id: ids.group, owner_sub: null, source: 'mavlink', mock_location: true }]);
    expect(await countRows(fx, 'location_observations WHERE device_id = $1', [ids.drone])).toBeGreaterThanOrEqual(2);
    expect(await countRows(fx, 'location_current WHERE subject_ref = $1 AND place_id = $2', [`device:${ids.drone}`, ids.place])).toBe(1);
    expect(run.output).toContain('Drone node up');
    expect(run.output).not.toContain(String(HOME.lat));
    expect(run.output).not.toContain(token);
  }, 120_000);

  it('DRONE_LOCATION_INTERVAL_S=0 keeps the node heartbeating and posts nothing', async () => {
    await until('the relay to go quiet', () => relay.pending === 0);
    relay.seen.length = 0;
    const before = await countRows(fx, 'location_observations');
    const run = await startNode({ DRONE_NODE_ID: 'loc-quiet-drone', OSHAL_API_URL: relay.base,
      OSHAL_LOCATION_DEVICE_ID: ids.drone, OSHAL_LOCATION_TOKEN: token, DRONE_LOCATION_INTERVAL_S: '0' });
    try {
      await until('two heartbeats', () => heartbeatsFrom('loc-quiet-drone').length >= 2);
    } finally {
      await stopNode(run);
    }
    expect(presence()).toEqual([]);
    expect(await countRows(fx, 'location_observations')).toBe(before);
    expect(run.output).toContain('no position will be posted');
  }, 120_000);
});
