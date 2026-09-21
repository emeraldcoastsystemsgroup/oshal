/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the one thing a node enrolment is judged on being VISIBLE: a computer that finished enrolling is bound to a person, and until now no cockpit surface said so - the device list rendered name, status and heartbeat, so a correctly enrolled node and one that came up bound to nobody looked identical. Two halves, each crossing its own boundary. The ROUTE half drives the real remote-client router over real HTTP with the real registry and the real authz helpers: an owner sees `you`, an operator sees `another-person` for somebody else's box and `unowned` for an unbound one, no owner subject id travels inside the ownership block, and a MACHINE caller still receives the exact record shape the node daemon and the dispatchers parse. The PAGE half executes the real inline script of src/pages/cockpit/tools/devices.html under a minimal fake DOM (no jsdom in this repo), fed the VERBATIM bytes the route just produced, and reads the ownership back out of the rendered table - so the two halves meet at the real wire shape rather than at a fixture somebody wrote twice. The AI Test Lab half asserts the DEVICE_SCENARIOS card is registered, that every suite it names exists on disk, and that its live step - run against the same real router - passes with the bound and unbound counts in its detail and FAILS against a device list that answers 200 with a healthy-looking computer whose binding block is gone.
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiOrigin } from '../helpers';
import { RemoteTaskJournalService } from '@/features/remote-client';
import { DEVICE_SCENARIOS } from '@/app/routes/test-lab-device-scenarios';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { InMemoryRemoteTaskJournalFixture } from '../helpers/in-memory-remote-task-journal';

const ENV_KEYS = [
  'OSHAL_OPERATOR_SUBS',
  'OSHAL_OPERATOR_EMAILS',
  'OSHAL_ALLOW_LEGACY_UNOWNED',
  'REMOTE_CLIENT_SHARED_SECRET',
  'REMOTE_CLIENT_CONTROL_PLANE_TOKEN',
  'REMOTE_CLIENT_AUTH_HEADER',
];
let savedEnv: Record<string, string | undefined>;

const SECRET = 'test-ownership-visibility-secret';
const OWNER = 'auth0|owns-a-laptop';
const OTHER = 'auth0|owns-a-different-laptop';
const OPERATOR = 'auth0|the-operator';

const DEVICES_PAGE = path.resolve(__dirname, '../../src/pages/cockpit/tools/devices.html');

interface OwnershipView {
  state?: string;
  owned?: boolean;
  label?: string;
  hint?: string;
}
interface ListedClient {
  clientId: string;
  clientName?: string;
  status?: string;
  ownerSub?: string;
  ownership?: OwnershipView;
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.REMOTE_CLIENT_SHARED_SECRET = SECRET;
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/**
 * The real router graph is imported ONCE in a file hook rather than inside an it(): the
 * express + authz + agent-management + chat-orchestration transform is a one-time cost of
 * several seconds and charging it to the first test's budget is the documented remote-client
 * full-suite flake. The route FACTORY still runs per boot, so each test's env is read as usual.
 */
let routerGraph: typeof import('../../src/app/routes/remote-client-routes');

beforeAll(async () => {
  routerGraph = await import('../../src/app/routes/remote-client-routes');
}, 120_000);

const servers: Array<{ close: (cb: () => void) => void }> = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
  servers.length = 0;
});

/**
 * @description Boots a fresh express app around the REAL remote-client router, with a
 * header-driven stand-in for the OIDC session so one app can serve several signed-in people.
 * @returns The base URL of the mounted device routes.
 */
async function bootApp(): Promise<string> {
  const { createRemoteClientRoutes, remoteClientRegistry } = routerGraph;
  const app = express();
  app.use(express.json());
  app.use(headerDrivenOidc());
  app.use('/api/remote-clients', createRemoteClientRoutes({
    taskJournalService: new RemoteTaskJournalService(new InMemoryRemoteTaskJournalFixture()),
  }));
  for (let attempt = 0; attempt < 20 && !remoteClientRegistry.isTaskJournalReady(); attempt += 1) {
    await Promise.resolve();
  }
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve) => (server as unknown as { once(e: string, cb: () => void): void }).once('listening', resolve));
  const address = (server as unknown as { address(): { port: number } | string | null }).address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
  lastBoundPort = address.port;
  return `http://127.0.0.1:${address.port}/api/remote-clients`;
}

/** The port the most recent bootApp() bound, which the Test Lab step is pointed at through PORT. */
let lastBoundPort = 0;

/** @description Registers a device as the node daemon does (machine trust), optionally asserting its owner. */
async function registerDevice(base: string, clientId: string, ownerSub?: string): Promise<void> {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-remote-client-key': SECRET },
    body: JSON.stringify({
      clientId,
      name: `Device ${clientId}`,
      transport: 'http',
      platform: 'windows',
      controlPlaneUrl: apiOrigin(),
      capabilities: ['mcp.call-tool'],
      tags: ['test'],
      ...(ownerSub ? { ownerSub } : {}),
    }),
  });
  expect(res.status).toBe(201);
}

/** @description Reads the device list exactly as a signed-in person's browser would, returning the raw body text too. */
async function listAs(base: string, sub: string): Promise<{ body: string; clients: ListedClient[] }> {
  const res = await fetch(base, { headers: { 'x-test-sub': sub } });
  expect(res.status).toBe(200);
  const body = await res.text();
  return { body, clients: (JSON.parse(body) as { clients: ListedClient[] }).clients };
}

/** @description Finds one device in a list by id, failing loudly rather than returning undefined. */
function pick(clients: ListedClient[], clientId: string): ListedClient {
  const found = clients.find((c) => c.clientId === clientId);
  if (!found) throw new Error(`device ${clientId} was not in the list`);
  return found;
}

describe('the device list says who each computer is bound to', () => {
  it('tells the owner their own computer is bound to THEM', async () => {
    const base = await bootApp();
    await registerDevice(base, 'vis-owner-box', OWNER);

    const { clients } = await listAs(base, OWNER);
    const device = pick(clients, 'vis-owner-box');
    expect(device.ownership).toBeDefined();
    expect(device.ownership?.state).toBe('you');
    expect(device.ownership?.owned).toBe(true);
    expect(device.ownership?.label).toBe('You');
  }, 30_000);

  it('separates an unbound computer from a bound one for the operator doing the enrolment proof', async () => {
    // This is the pair the bare-machine proof actually has to tell apart: a node that installed,
    // connected and registered but never bound to a person LOOKS healthy - online, heartbeating -
    // and receives no owner-scoped work at all.
    const base = await bootApp();
    await registerDevice(base, 'vis-bound-box', OTHER);
    await registerDevice(base, 'vis-unbound-box');

    const { clients } = await listAs(base, OPERATOR);
    const bound = pick(clients, 'vis-bound-box');
    const unbound = pick(clients, 'vis-unbound-box');

    expect(bound.ownership?.owned).toBe(true);
    expect(bound.ownership?.state).toBe('another-person');
    expect(unbound.ownership?.owned).toBe(false);
    expect(unbound.ownership?.state).toBe('unowned');
    expect(unbound.ownership?.label).toBe('Unowned');
    expect(unbound.ownership?.hint).toContain('enrolment did not complete');
  }, 30_000);

  it('never carries an owner subject id inside the ownership block', async () => {
    // The block is what a page renders. `ownerSub` remains on the record for the callers that
    // already read it, but nothing a surface prints may be built out of somebody's identity.
    const base = await bootApp();
    await registerDevice(base, 'vis-privacy-box', OTHER);

    const { clients } = await listAs(base, OPERATOR);
    const device = pick(clients, 'vis-privacy-box');
    expect(device.ownerSub).toBe(OTHER);
    expect(JSON.stringify(device.ownership)).not.toContain(OTHER);
    expect(JSON.stringify(device.ownership)).not.toContain('auth0|');
  }, 30_000);

  it('leaves the MACHINE caller record shape exactly as the daemon and dispatchers parse it', async () => {
    const base = await bootApp();
    await registerDevice(base, 'vis-machine-box', OWNER);

    const res = await fetch(base, { headers: { 'x-remote-client-key': SECRET } });
    expect(res.status).toBe(200);
    const clients = ((await res.json()) as { clients: ListedClient[] }).clients;
    const device = pick(clients, 'vis-machine-box');
    expect(device.ownerSub).toBe(OWNER);
    expect(Object.prototype.hasOwnProperty.call(device, 'ownership')).toBe(false);
  }, 30_000);
});

describe('the cockpit device view renders what the route decided', () => {
  it('shows a bound computer as owned and an unbound one as Unowned, from the real response bytes', async () => {
    const base = await bootApp();
    await registerDevice(base, 'page-bound-box', OPERATOR);
    await registerDevice(base, 'page-unbound-box');
    const { body } = await listAs(base, OPERATOR);

    const rendered = await renderDevicesPage(body);

    expect(rendered).toContain('<th>Bound to</th>');
    // The operator's own machine reads as theirs, and says so in the column, not in a tooltip alone.
    expect(rendered).toMatch(/data-owned="true"[^>]*>You</);
    expect(rendered).toMatch(/data-owned="false"[^>]*>Unowned</);
    expect(rendered).toContain('page-bound-box');
    expect(rendered).toContain('page-unbound-box');
  }, 30_000);

  it('reads a response with no ownership block as UNKNOWN rather than as owned', async () => {
    // Fail-closed in the direction that matters: the surface must never paint a computer as bound
    // to somebody because a response did not say. It has no session identity of its own to guess with.
    const rendered = await renderDevicesPage(JSON.stringify({
      clients: [{ clientId: 'legacy-box', clientName: 'Legacy box', status: 'online' }],
      count: 1,
    }));

    expect(rendered).toContain('<th>Bound to</th>');
    expect(rendered).toMatch(/data-owned="unknown"[^>]*>Unknown</);
    expect(rendered).not.toContain('data-owned="true"');
  }, 30_000);
});

describe('the remote-node binding card is registered in the AI Test Lab', () => {
  it('is in SCENARIOS, and every suite it names exists on disk', () => {
    for (const scenario of DEVICE_SCENARIOS) {
      expect(SCENARIOS.map((s) => s.id)).toContain(scenario.id);
      expect(scenario.regressionTests?.length).toBeGreaterThan(0);
      for (const test of scenario.regressionTests ?? []) {
        expect(existsSync(path.resolve(process.cwd(), test.path)), `${test.path} is registered but missing`).toBe(true);
      }
    }
  });

  it('its live step passes against the REAL router and counts the bound and the unbound', async () => {
    const base = await bootApp();
    await registerDevice(base, 'lab-bound-box', OPERATOR);
    await registerDevice(base, 'lab-unbound-box');
    const savedPort = process.env.PORT;
    process.env.PORT = String(lastBoundPort);
    try {
      const result = await DEVICE_SCENARIOS[0].steps[0].run(`x-test-sub=${OPERATOR}`, {});
      expect(result.state).toBe('pass');
      // The registry is shared across this file's boots, so the fleet is larger than the two
      // registered here; what the card must report is BOTH populations, counted, not a fixed total.
      const counted = /(\d+) of (\d+) computers are bound to an account; (\d+) unowned/.exec(result.detail);
      expect(counted, `the card did not count both populations: ${result.detail}`).not.toBeNull();
      expect(Number(counted?.[1])).toBeGreaterThanOrEqual(1);
      expect(Number(counted?.[3])).toBeGreaterThanOrEqual(1);
    } finally {
      if (savedPort === undefined) delete process.env.PORT;
      else process.env.PORT = savedPort;
    }
  }, 30_000);

  it('its live step FAILS when the surface stops saying who a computer is bound to', async () => {
    // What the card is for: a device list that lost its binding block still answers 200 with a
    // healthy-looking, heartbeating computer in it, and the card must not read that as a pass.
    const app = express();
    app.get('/api/remote-clients', (_req, res) => {
      res.json({ clients: [{ clientId: 'silent-box', clientName: 'Silent box', status: 'online' }], count: 1 });
    });
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => (server as unknown as { once(e: string, cb: () => void): void }).once('listening', resolve));
    const savedPort = process.env.PORT;
    process.env.PORT = String((server.address() as { port: number }).port);
    try {
      const result = await DEVICE_SCENARIOS[0].steps[0].run('x-test-sub=whoever', {});
      expect(result.state).toBe('fail');
      expect(result.detail).toContain('do not say who they are bound to');
    } finally {
      if (savedPort === undefined) delete process.env.PORT;
      else process.env.PORT = savedPort;
    }
  }, 30_000);
});

/**
 * @description Executes the REAL inline script of the cockpit devices page under a minimal fake
 * DOM (this repo carries no jsdom), with `/api/remote-clients` answered by the supplied body, and
 * returns the HTML the page wrote into its computers list. The fake exposes only what a browser
 * would, so a new DOM dependency in the page fails here first.
 * @param remoteClientsBody - The verbatim response body the page should receive for the device list.
 * @returns The innerHTML of the page's `#computers` container after its first load.
 */
async function renderDevicesPage(remoteClientsBody: string): Promise<string> {
  const html = await readFile(DEVICES_PAGE, 'utf8');
  const match = /<script>\r?\n([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error('the devices page no longer carries a bare inline <script> block');
  const source = match[1];

  const elements = new Map<string, Record<string, unknown>>();
  const makeElement = (id: string): Record<string, unknown> => ({
    id,
    innerHTML: '',
    textContent: '',
    className: '',
    value: '',
    href: '',
    download: '',
    hidden: false,
    disabled: false,
    parentNode: { hidden: false },
    addEventListener: () => undefined,
    appendChild: () => undefined,
    remove: () => undefined,
    click: () => undefined,
  });
  const documentStub = {
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    createElement: () => makeElement('created'),
    body: { appendChild: () => undefined },
  };
  const fetchStub = async (url: string) => {
    if (String(url).startsWith('/api/remote-clients')) {
      return { ok: true, status: 200, text: async () => remoteClientsBody, json: async () => JSON.parse(remoteClientsBody) };
    }
    return { ok: false, status: 403, json: async () => ({}) };
  };

  const run = new Function(
    'window', 'document', 'navigator', 'location', 'fetch', 'setTimeout', 'setInterval', 'URL',
    source,
  );
  run(
    { confirm: () => false },
    documentStub,
    { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)', userAgentData: null },
    { origin: 'http://127.0.0.1:35457' },
    fetchStub,
    () => 0,
    () => 0,
    { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined },
  );

  // The page's own timers are stubbed out; these ticks are the spec's, and let the page's first
  // (real, already-resolved) fetch chain settle before the table is read back.
  for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  const box = elements.get('computers');
  if (!box) throw new Error('the devices page never asked for its computers container');
  return String(box.innerHTML);
}

/**
 * @description Stands in for the OIDC session middleware, driven by an x-test-sub request header,
 * or by the same name as a cookie - the Test Lab step carries a session the way a browser does.
 */
function headerDrivenOidc() {
  return (req: Request, _res: Response, next: NextFunction) => {
    const fromCookie = /(?:^|;\s*)x-test-sub=([^;]+)/.exec(String(req.headers.cookie || ''))?.[1];
    const sub = String(req.headers['x-test-sub'] || fromCookie || '').trim();
    if (sub) {
      (req as { oidc?: unknown }).oidc = {
        user: { sub, email: `${sub.replace(/[^a-z0-9]/gi, '-')}@example.test` },
        isAuthenticated: () => true,
      };
    }
    next();
  };
}
