/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the wedged-edge-node fix. The control-plane registry is in-memory, so an api restart drops every registration while the daemon keeps polling; register() ran once at start() and never again, so the node failed forever until a human restarted the machine. Proves both halves: the routes answer an unknown client 404 + code (not 400, which the daemon could not distinguish from a malformed call), and the daemon re-registers and recovers on that answer — deduped, floored, and never for a non-404.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | De-flake (BACKLOG "remote-client specs are flaky under full-suite parallelism"). Each of the three route tests booted its OWN express server, so each paid the one-time dynamic-import/transform of the real router graph on vitest's 5s DEFAULT — the cost the two sibling specs already document and buy 15s for, which is why they are not on the flaky list and this file was. Now one server per file in a beforeAll with an explicit 30s budget; the assertions themselves run in ms. The entry's stated cause (port contention) is disproven in place: listen(0) already binds an ephemeral port, so its "allocate ephemeral ports" done-when was already met and would have changed nothing.
 */

import express, { type Request, type Response } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ControlPlaneHttpError,
  RemoteClientNotFoundError,
  RemoteClientService,
  type RemoteClientConfig,
} from '../../src/features/remote-client';

const ENV_KEYS = ['REMOTE_CLIENT_SHARED_SECRET', 'OSHAL_OPERATOR_SUBS'];
let savedEnv: Record<string, string | undefined>;
const SECRET = 'test-remote-secret';

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.REMOTE_CLIENT_SHARED_SECRET = SECRET;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/**
 * The control plane's half of the contract: a poll naming a clientId this process has no record of
 * must be answerable. It used to be 400 Bad Request, which is both wrong (the request is fine — the
 * server forgot) and unactionable, since a daemon cannot tell it apart from a genuine bad call.
 */
describe('control plane answers an unregistered client so the daemon can recover', () => {
  // ONE server for the file, booted in a hook with an explicit budget. Previously each test booted
  // its own, so all three paid the one-time dynamic-import/transform of the real router graph on
  // vitest's 5s DEFAULT — the exact cost remote-client-device-ownership.spec.ts documents and
  // buys 15s for, and the reason it is not on the flaky list while this file was. The assertions
  // themselves run in milliseconds; it is the import that is slow, and only under the CPU
  // contention of a full parallel suite, which is why it presented as intermittent.
  //
  // NOTE for whoever picks up the BACKLOG entry: port contention is NOT the cause. `listen(0)`
  // already binds an EPHEMERAL port, so two suites cannot collide on one — the entry's "allocate
  // ephemeral ports" done-when was already satisfied and would have changed nothing.
  let server: { close: (cb: () => void) => void };
  let origin: string;

  beforeAll(async () => {
    const { createRemoteClientRoutes } = await import('../../src/app/routes/remote-client-routes');
    const app = express();
    app.use(express.json());
    app.use('/api/remote-clients', createRemoteClientRoutes());
    const listening = app.listen(0);
    server = listening;
    const address = listening.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    origin = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const machineHeaders = { 'x-remote-client-key': SECRET, 'content-type': 'application/json' };

  it('answers a task poll from an unknown client with 404 and a machine-readable code', async () => {
    const res = await fetch(`${origin}/api/remote-clients/ghost-client/tasks/next`, {
      headers: machineHeaders,
    });

    expect(res.status, 'a forgotten registration is not a malformed request').toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('remote_client_unregistered');
  });

  it('answers a heartbeat from an unknown client the same way', async () => {
    const res = await fetch(`${origin}/api/remote-clients/ghost-client/heartbeat`, {
      method: 'POST',
      headers: machineHeaders,
      body: JSON.stringify({
        clientId: 'ghost-client',
        status: 'online',
        controlPlaneReachable: true,
        mcpReady: true,
        toolCount: 0,
        lastSeenAt: new Date().toISOString(),
        version: '1.0.0',
      }),
    });

    expect(res.status).toBe(404);
    expect(((await res.json()) as { code?: string }).code).toBe('remote_client_unregistered');
  });

  it('answers a swarm-message poll from an unknown client the same way', async () => {
    const res = await fetch(`${origin}/api/remote-clients/ghost-client/swarm/next`, {
      headers: machineHeaders,
    });

    expect(res.status).toBe(404);
    expect(((await res.json()) as { code?: string }).code).toBe('remote_client_unregistered');
  });
});

/**
 * The daemon's half. These drive the REAL RemoteClientService recovery path with a stubbed control
 * plane and MCP client — the logic under test is the service's, not the transport's.
 */
describe('the daemon re-registers instead of wedging', () => {
  const CONFIG: RemoteClientConfig = {
    clientId: 'oshal-chat-test',
    clientName: 'test node',
    controlPlaneUrl: 'http://127.0.0.1:1/',
    platform: 'windows',
    transport: 'http',
    mcpCommand: 'node',
    mcpArgs: [],
    heartbeatIntervalMs: 10_000,
    pollIntervalMs: 2_500,
    disablePolling: false,
    authHeaderName: 'x-remote-client-key',
  };

  interface Stub {
    service: RemoteClientService;
    register: ReturnType<typeof vi.fn>;
    claimNextTask: ReturnType<typeof vi.fn>;
    heartbeat: ReturnType<typeof vi.fn>;
  }

  /**
   * @description Builds a service whose control plane and MCP child are stubs.
   *
   * The service owns both collaborators (it constructs them itself), so they are replaced on the
   * instance. Nothing is spawned and no socket is opened.
   *
   * @returns The service plus its stubbed control-plane methods.
   */
  function makeService(): Stub {
    const service = new RemoteClientService(CONFIG);
    const register = vi.fn().mockResolvedValue({ client: { agentId: 'agent-1' } });
    const claimNextTask = vi.fn();
    const heartbeat = vi.fn().mockResolvedValue({ accepted: true });

    Reflect.set(service, 'controlPlane', { register, claimNextTask, heartbeat });
    Reflect.set(service, 'mcpClient', {
      isReady: () => true,
      listTools: async () => ({ tools: [{ name: 'shell.exec' }] }),
    });
    Reflect.set(service, 'running', true);

    return { service, register, claimNextTask, heartbeat };
  }

  /** The exact shape the control plane now returns for a forgotten client. */
  const unregistered = () => new ControlPlaneHttpError(404, 'remote_client_unregistered', '{}');

  it('re-registers and retries the claim in the same pass', async () => {
    const { service, register, claimNextTask } = makeService();
    claimNextTask.mockRejectedValueOnce(unregistered()).mockResolvedValueOnce({ claimed: false, task: null });

    await service.pollOnce();

    expect(register, 'the daemon must re-register itself, not wait for a human').toHaveBeenCalledTimes(1);
    expect(claimNextTask, 'the queued task should not wait a full poll interval').toHaveBeenCalledTimes(2);
  });

  it('recovers from the heartbeat path too, which notices first', async () => {
    const { service, register, heartbeat } = makeService();
    heartbeat.mockRejectedValueOnce(unregistered());

    // sendHeartbeat is the private timer callback; drive it as the timer does.
    await (Reflect.get(service, 'sendHeartbeat') as (s: string, t: string | null) => Promise<void>)
      .call(service, 'online', null);

    expect(register).toHaveBeenCalledTimes(1);
  });

  it('re-registers ONCE when the poll and heartbeat timers both notice together', async () => {
    // Both timers run independently and will both see the failure. Without a shared in-flight
    // attempt this is where a restart turns into a registration flood from every node at once.
    const { service, register, claimNextTask, heartbeat } = makeService();
    // Registration stays in flight long enough for the second caller to arrive while the first is
    // still mid-attempt — the window the shared promise exists to cover.
    register.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ client: { agentId: 'agent-1' } }), 25)),
    );
    claimNextTask.mockRejectedValueOnce(unregistered()).mockResolvedValue({ claimed: false, task: null });
    heartbeat.mockRejectedValueOnce(unregistered()).mockResolvedValue({ accepted: true });

    await Promise.all([
      service.pollOnce(),
      (Reflect.get(service, 'sendHeartbeat') as (s: string, t: string | null) => Promise<void>)
        .call(service, 'online', null),
    ]);

    expect(register, 'concurrent failures must share one attempt').toHaveBeenCalledTimes(1);
  });

  it('does NOT re-register for an unrelated control-plane failure', async () => {
    // A 500 means the control plane is broken, not that it forgot us. Re-registering on every
    // error would spin against an outage and mask it.
    const { service, register, claimNextTask } = makeService();
    claimNextTask.mockRejectedValue(new ControlPlaneHttpError(500, null, 'boom'));

    await expect(service.pollOnce()).rejects.toThrow('Control-plane request failed: 500');
    expect(register).not.toHaveBeenCalled();
  });

  it('surfaces the original error when re-registration itself fails', async () => {
    // A control plane that is down must not be papered over as a silent no-op poll.
    const { service, register, claimNextTask } = makeService();
    claimNextTask.mockRejectedValue(unregistered());
    register.mockRejectedValue(new Error('control plane unreachable'));

    await expect(service.pollOnce()).rejects.toThrow('Control-plane request failed: 404');
  });

  it('backs off instead of flooding when it is STILL unregistered right after re-registering', async () => {
    const { service, register, claimNextTask } = makeService();
    claimNextTask.mockRejectedValue(unregistered());

    await expect(service.pollOnce()).rejects.toThrow();  // first pass: re-registers, claim fails again
    await expect(service.pollOnce()).rejects.toThrow();  // second pass: inside the floor
    await expect(service.pollOnce()).rejects.toThrow();

    expect(register, 'the retry floor must hold within one heartbeat interval').toHaveBeenCalledTimes(1);
  });
});

describe('the error types carry what the caller needs to decide', () => {
  it('treats a bare 404 as unregistered so an older control plane still heals', () => {
    // The code is the precise signal, but a control plane predating it must not wedge the fleet —
    // an old server is exactly the case where self-healing matters most.
    expect(new ControlPlaneHttpError(404, null, '').isUnregistered).toBe(true);
    expect(new ControlPlaneHttpError(404, 'remote_client_unregistered', '').isUnregistered).toBe(true);
    expect(new ControlPlaneHttpError(500, null, '').isUnregistered).toBe(false);
    expect(new ControlPlaneHttpError(403, null, '').isUnregistered).toBe(false);
  });

  it('identifies the missing client without matching on message text', () => {
    const err = new RemoteClientNotFoundError('ghost');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('remote_client_unregistered');
    expect(err.clientId).toBe('ghost');
  });
});
