/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Two-user device-ownership proof for the repo-audit 2026-07-05 finding: a second non-operator user gets 403 enqueueing to / reading results from a device they don't own; owner + operator + machine (shared secret) callers keep working; session chat identity is pinned to the session sub; session re-registration cannot take over another user's device.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Control-plane URL fixtures follow PLAYWRIGHT_PORT via the shared apiOrigin() helper instead of hardcoded localhost:35457 literals (byte-identical under the default env)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | First test gets the sibling 15s budget: it pays the one-time router-graph import/transform, which exceeds the 5s default on a cold vite cache (fresh npm ci) — surfaced by the trunk cutover's fresh install
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiOrigin } from '../helpers';

const ENV_KEYS = [
  'OSHAL_OPERATOR_SUBS',
  'OSHAL_OPERATOR_EMAILS',
  'OSHAL_ALLOW_LEGACY_UNOWNED',
  'REMOTE_CLIENT_SHARED_SECRET',
  'REMOTE_CLIENT_CONTROL_PLANE_TOKEN',
  'REMOTE_CLIENT_AUTH_HEADER',
];
let savedEnv: Record<string, string | undefined>;

const SECRET = 'test-remote-secret';
const OWNER = 'auth0|device-owner';
const INTRUDER = 'auth0|other-user';
const OPERATOR = 'auth0|the-operator';

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

describe('remote-client device ownership binding', () => {
  const servers: Array<{ close: (cb: () => void) => void }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
    servers.length = 0;
  });

  /**
   * Boots a fresh express app around the REAL remote-client router. sessionSub
   * switches the simulated signed-in user per request via the x-test-sub header,
   * so one app serves the owner, the intruder, and the operator.
   */
  async function bootApp(): Promise<string> {
    // Import fresh so the module-level registry is shared within one app but the
    // route wiring picks up this test's env.
    const { createRemoteClientRoutes } = await import('../../src/app/routes/remote-client-routes');
    const app = express();
    app.use(express.json());
    app.use(headerDrivenOidc());
    app.use('/api/remote-clients', createRemoteClientRoutes());
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
    return `http://127.0.0.1:${address.port}/api/remote-clients`;
  }

  /** Registers a device AS THE NODE DAEMON (shared secret) asserting its owner. */
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
        capabilities: ['mcp.call-tool', 'shell.exec'],
        tags: ['test'],
        ...(ownerSub ? { ownerSub } : {}),
      }),
    });
    expect(res.status).toBe(201);
  }

  function taskBody(taskId: string): Record<string, unknown> {
    return {
      taskId,
      correlationId: `corr-${taskId}`,
      fromAgentId: 'test-suite',
      toAgentId: 'device-1',
      intent: 'mcp.call-tool',
      input: { name: 'shell.exec', arguments: { command: 'whoami' } },
      createdAt: new Date().toISOString(),
    };
  }

  it('scopes the device LIST and single-device read to what the caller owns', async () => {
    // A device list is a list of real people's computers. It also hands out the clientId, which is
    // what pins dispatch — so an unscoped list was the discovery half of the cross-user dispatch hole.
    const base = await bootApp();
    await registerDevice(base, 'device-1', OWNER);
    await registerDevice(base, 'device-2', INTRUDER);

    const listAs = async (sub: string) => {
      const res = await fetch(base, { headers: { 'x-test-sub': sub } });
      return ((await res.json()) as { clients: Array<{ clientId: string }> }).clients.map((c) => c.clientId).sort();
    };

    expect(await listAs(OWNER)).toEqual(['device-1']);
    expect(await listAs(INTRUDER)).toEqual(['device-2']);
    expect(await listAs(OPERATOR)).toEqual(['device-1', 'device-2']);   // operators see the fleet

    // Machine callers (node daemon + platform dispatchers) still need every device to route work.
    const machine = await fetch(base, { headers: { 'x-remote-client-key': SECRET } });
    expect(((await machine.json()) as { clients: unknown[] }).clients).toHaveLength(2);

    // A single-device read by a non-owner 404s (not 403) so ids cannot be probed for existence.
    expect((await fetch(`${base}/device-1`, { headers: { 'x-test-sub': INTRUDER } })).status).toBe(404);
    expect((await fetch(`${base}/device-1`, { headers: { 'x-test-sub': OWNER } })).status).toBe(200);
    // 15s, same as the completion-flow test below: the FIRST test in the file pays the one-time
    // dynamic-import/transform of the real router graph, which blows the default 5s budget on a
    // cold vite cache (fresh npm ci / fresh clone / CI) while the assertions themselves run in ms.
  }, 15_000);

  it('refuses mesh task INJECTION from one user\'s device onto another user\'s device', async () => {
    // The mesh subscriber converts an inbound envelope into registry.enqueueTask, and toTaskEnvelope
    // accepts a verbatim embedded task (arbitrary intent/input = codex.exec at danger-full-access).
    // POST /:clientId/swarm/send is device-gated on the SENDER's box and then sends to an unchecked
    // body `toAgentId` — so owning one node was a licence to execute on anyone else's. Guarding the
    // CONVERSION covers direct and broadcast alike; the sender id is server-derived, not body-supplied.
    const base = await bootApp();
    const { mayInjectTask } = await import('../../src/app/routes/remote-client-routes');
    await registerDevice(base, 'device-owner-box', OWNER);
    await registerDevice(base, 'device-intruder-box', INTRUDER);

    expect(mayInjectTask('device-intruder-box', 'device-owner-box')).toBe(false);  // cross-user: refused
    expect(mayInjectTask('device-owner-box', 'device-owner-box')).toBe(true);      // its own box
    expect(mayInjectTask('swarm-bot-agent-id', 'device-owner-box')).toBe(true);    // platform sender
  });

  it('blocks ADOPTION of an existing unowned device by a non-operator (ownership takeover)', async () => {
    // With OSHAL_ALLOW_LEGACY_UNOWNED on, canAccessResource admits ANY signed-in user against a null
    // owner, and registry.register() lets a supplied ownerSub overwrite — so re-registering someone
    // else's unbound clientId made you its permanent owner, and every later gate then said yes.
    process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'true';
    const base = await bootApp();
    await registerDevice(base, 'device-legacy');            // machine registration, no owner asserted

    const takeover = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': INTRUDER },
      body: JSON.stringify({
        clientId: 'device-legacy', name: 'Device device-legacy', transport: 'http',
        platform: 'windows', controlPlaneUrl: apiOrigin(), capabilities: ['shell.exec'],
      }),
    });
    expect(takeover.status).toBe(403);

    // The device is still unbound — the intruder did not become its owner.
    const after = await fetch(`${base}/device-legacy`, { headers: { 'x-remote-client-key': SECRET } });
    expect(((await after.json()) as { client: { ownerSub?: string } }).client.ownerSub).toBeUndefined();

    // The node itself (machine trust) re-registers normally, and an operator may still adopt.
    await registerDevice(base, 'device-legacy');
  });

  it('403s a second non-operator user enqueueing to and reading results from a device they do not own', async () => {
    const base = await bootApp();
    await registerDevice(base, 'device-1', OWNER);

    // Intruder cannot enqueue a shell-exec-class task.
    const enqueue = await fetch(`${base}/device-1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': INTRUDER },
      body: JSON.stringify(taskBody('task-intruder')),
    });
    expect(enqueue.status).toBe(403);

    // Owner CAN enqueue; the node (secret) claims + completes with a result.
    const ownerEnqueue = await fetch(`${base}/device-1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': OWNER },
      body: JSON.stringify(taskBody('task-owner')),
    });
    expect(ownerEnqueue.status).toBe(201);

    const claim = await fetch(`${base}/device-1/tasks/next`, {
      headers: { 'x-remote-client-key': SECRET },
    });
    expect(claim.status).toBe(200);

    const complete = await fetch(`${base}/device-1/tasks/task-owner/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-remote-client-key': SECRET },
      body: JSON.stringify({ correlationId: 'corr-task-owner', output: { screenshot: 'data:image/png;base64,SECRETPIXELS' } }),
    });
    expect(complete.status).toBe(200);

    // Intruder cannot read the completed result (the screenshot); owner can.
    const intruderRead = await fetch(`${base}/device-1/tasks/task-owner/result`, {
      headers: { 'x-test-sub': INTRUDER },
    });
    expect(intruderRead.status).toBe(403);

    const ownerRead = await fetch(`${base}/device-1/tasks/task-owner/result`, {
      headers: { 'x-test-sub': OWNER },
    });
    expect(ownerRead.status).toBe(200);
    const result = (await ownerRead.json()) as { output?: { screenshot?: string } };
    expect(result.output?.screenshot).toContain('SECRETPIXELS');
  }, 15_000);

  it('lets an operator act on any device, and machine callers stay unaffected', async () => {
    const base = await bootApp();
    await registerDevice(base, 'device-1', OWNER);

    const operatorEnqueue = await fetch(`${base}/device-1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': OPERATOR },
      body: JSON.stringify(taskBody('task-operator')),
    });
    expect(operatorEnqueue.status).toBe(201);

    // Machine caller (platform dispatcher holding the secret) enqueues freely.
    const machineEnqueue = await fetch(`${base}/device-1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-remote-client-key': SECRET },
      body: JSON.stringify(taskBody('task-machine')),
    });
    expect(machineEnqueue.status).toBe(201);
  });

  it('fails closed on UNOWNED devices: session non-operators are denied, operator passes', async () => {
    const base = await bootApp();
    await registerDevice(base, 'device-unowned');

    const intruderEnqueue = await fetch(`${base}/device-unowned/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': INTRUDER },
      body: JSON.stringify(taskBody('task-x')),
    });
    expect(intruderEnqueue.status).toBe(403);

    const operatorEnqueue = await fetch(`${base}/device-unowned/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': OPERATOR },
      body: JSON.stringify(taskBody('task-y')),
    });
    expect(operatorEnqueue.status).toBe(201);
  });

  it('blocks a session re-registration takeover of another user\'s device', async () => {
    const base = await bootApp();
    await registerDevice(base, 'device-1', OWNER);

    const takeover = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': INTRUDER },
      body: JSON.stringify({
        clientId: 'device-1',
        name: 'Hijacked Device',
        transport: 'http',
        platform: 'windows',
        controlPlaneUrl: apiOrigin(),
        ownerSub: INTRUDER,
      }),
    });
    expect(takeover.status).toBe(403);
  });

  it('keeps ownership sticky across an owner-less machine re-registration', async () => {
    const base = await bootApp();
    await registerDevice(base, 'device-1', OWNER);
    // Node refresh without ownerSub (e.g. an older daemon build) must NOT unbind.
    await registerDevice(base, 'device-1');

    const intruderEnqueue = await fetch(`${base}/device-1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': INTRUDER },
      body: JSON.stringify(taskBody('task-z')),
    });
    expect(intruderEnqueue.status).toBe(403);

    const ownerEnqueue = await fetch(`${base}/device-1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': OWNER },
      body: JSON.stringify(taskBody('task-w')),
    });
    expect(ownerEnqueue.status).toBe(201);
  });

  it('operator can reassign ownership via POST /:clientId/owner; non-operator cannot', async () => {
    const base = await bootApp();
    await registerDevice(base, 'device-1', OWNER);

    const denied = await fetch(`${base}/device-1/owner`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': INTRUDER },
      body: JSON.stringify({ ownerSub: INTRUDER }),
    });
    expect(denied.status).toBe(403);

    const reassigned = await fetch(`${base}/device-1/owner`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': OPERATOR },
      body: JSON.stringify({ ownerSub: INTRUDER }),
    });
    expect(reassigned.status).toBe(200);

    // The new owner can now enqueue; the old owner is denied.
    const newOwnerEnqueue = await fetch(`${base}/device-1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': INTRUDER },
      body: JSON.stringify(taskBody('task-new-owner')),
    });
    expect(newOwnerEnqueue.status).toBe(201);

    const oldOwnerEnqueue = await fetch(`${base}/device-1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': OWNER },
      body: JSON.stringify(taskBody('task-old-owner')),
    });
    expect(oldOwnerEnqueue.status).toBe(403);
  });
});

/**
 * Simulates the validated OIDC session per request: x-test-sub sets the signed-in
 * sub (mirrors how the real middleware exposes req.oidc). No header = anonymous.
 */
function headerDrivenOidc() {
  return (req: Request, _res: Response, next: NextFunction) => {
    const sub = String(req.headers['x-test-sub'] || '').trim();
    if (sub) {
      (req as { oidc?: unknown }).oidc = {
        user: { sub, email: `${sub.replace(/[^a-z0-9]/gi, '-')}@example.test` },
        isAuthenticated: () => true,
      };
    }
    next();
  };
}
