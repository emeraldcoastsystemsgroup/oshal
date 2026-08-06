/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove trusted daemon settlement never substitutes a contradictory failure after a valid completed result callback transport failure, while strict-parse failure consistently settles and reports failed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteClientService, type RemoteClientConfig, type RemoteClientTask } from '@/features/remote-client';

const CONFIG: RemoteClientConfig = {
  clientId: 'desktop-a', clientName: 'Desktop A', controlPlaneUrl: 'https://controller.example/base',
  platform: 'windows', transport: 'http', mcpCommand: 'node', mcpArgs: [],
  heartbeatIntervalMs: 10_000, pollIntervalMs: 2_500, disablePolling: true,
  authHeaderName: 'x-remote-client-key',
};

afterEach(() => vi.unstubAllGlobals());

describe('RemoteClientService callback outcome integrity', () => {
  it('journal-completes a valid result and never sends a contradictory failure on callback refusal', async () => {
    const fixture = serviceFixture({ content: [{ type: 'text', text: '{"result":"applied","note":"verified"}' }] });
    const fetchMock = vi.fn(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await execute(fixture.service, callbackTask());
    expect(fixture.completeTask).toHaveBeenCalledTimes(1);
    expect(fixture.failTask).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(String((init as RequestInit).body)).result).toEqual({ result: 'applied', note: 'verified' });
    }
  });

  it('settles strict-parse failure as failed and sends only the matching failure result', async () => {
    const fixture = serviceFixture('prose around {"result":"applied","note":"not strict"}');
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await execute(fixture.service, callbackTask());
    expect(fixture.completeTask).not.toHaveBeenCalled();
    expect(fixture.failTask).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.result.result).toBe('failed');
  });
});

/** Build a daemon with trusted collaborators replaced by observable in-memory seams. */
function serviceFixture(output: unknown) {
  const service = new RemoteClientService(CONFIG);
  const completeTask = vi.fn(async (result) => result);
  const failTask = vi.fn(async (result) => result);
  Reflect.set(service, 'controlPlane', {
    completeTask, failTask, heartbeat: vi.fn(async () => ({ accepted: true })),
  });
  Reflect.set(service, 'mcpClient', {
    isReady: () => true,
    callTool: vi.fn(async () => output),
  });
  return { service, completeTask, failTask };
}

/** Invoke the private timer-owned executor exactly as pollOnce does. */
function execute(service: RemoteClientService, task: RemoteClientTask): Promise<void> {
  const run = Reflect.get(service, 'executeTask') as (task: RemoteClientTask) => Promise<void>;
  return run.call(service, task);
}

/** Build one callback-bearing task whose authority never enters input.arguments. */
function callbackTask(): RemoteClientTask {
  return {
    taskId: 'liprofile-7-a', correlationId: 'liprofile-7-a', fromAgentId: 'profile-operator',
    toAgentId: 'desktop-a', intent: 'mcp.call-tool',
    input: { name: 'codex.exec', arguments: { prompt: 'return strict JSON' } },
    artifacts: [], createdAt: new Date().toISOString(), status: 'queued',
    completionCallback: {
      kind: 'trusted-http-json-v1', url: 'https://controller.example/api/profile-studio/ingest',
      capability: `pscap_${'e'.repeat(43)}`,
      context: { userSub: 'opaque-owner', generation: 1, clientId: 'desktop-a', operation: 'resolve-profile-plan' },
    },
  };
}
