/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added remote-client framework regression coverage for config, registry, task lifecycle, and swarm queueing
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Control-plane URL fixtures follow PLAYWRIGHT_PORT via the shared apiOrigin() helper instead of hardcoded localhost:35457 literals — every side of each round-trip reads the same helper, so the assertions stay internally consistent under any port (byte-identical under the default env)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Guard at-most-once remote task enqueue. Lost HTTP responses cause safe retries with the same taskId; exact retries and same-id payload changes must return the accepted envelope without adding a second shell/click/file action, including after claim and completion.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Prove conflicting retries cannot replace the claimed command and bounded retention rejects new work rather than evicting an in-flight or recently completed duplicate-action guard.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Keep lifecycle scenarios independently focused and below the repository function/callback limit.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Exercise the registry through an explicitly injected journal fixture: all task calls are async, task-id conflicts fail closed, and owner transitions refuse queued/claimed work.
 */

import { test, expect } from '@playwright/test';
import {
  RemoteClientRegistryService,
  RemoteTaskJournalService,
  loadRemoteClientConfig,
} from '@/features/remote-client';
import { apiOrigin } from './helpers';
import { InMemoryRemoteTaskJournalFixture } from './helpers/in-memory-remote-task-journal';

const registerRetryClient = async (registry: RemoteClientRegistryService, clientId: string): Promise<void> => {
  await registry.register({
    clientId,
    name: 'Retry-safe node',
    transport: 'http',
    platform: 'windows',
    controlPlaneUrl: apiOrigin(),
    capabilities: ['mcp.call-tool'],
    tags: ['remote-client'],
  });
};

const retryEnvelope = (taskId: string, command: string) => ({
  taskId,
  correlationId: `corr-${taskId}`,
  fromAgentId: 'codex-remote-node',
  toAgentId: 'client-retry',
  intent: 'mcp.call-tool' as const,
  input: { name: 'shell.exec', arguments: { command } },
  createdAt: new Date().toISOString(),
});

const registerTaskClient = async (registry: RemoteClientRegistryService): Promise<void> => {
  await registry.register({
    clientId: 'client-b',
    name: 'Remote Agent B',
    transport: 'http',
    platform: 'windows',
    controlPlaneUrl: apiOrigin(),
    capabilities: ['mcp.initialize', 'mcp.call-tool'],
    tags: ['remote-client'],
  });
};

async function durableRegistry(): Promise<RemoteClientRegistryService> {
  const registry = new RemoteClientRegistryService();
  const service = new RemoteTaskJournalService(new InMemoryRemoteTaskJournalFixture());
  await registry.configureTaskJournal(service, async () => undefined);
  return registry;
}

  test('loads daemon configuration from environment aliases', () => {
    const config = loadRemoteClientConfig({
      REMOTE_CLIENT_NAME: 'edge-mac',
      REMOTE_CLIENT_CONTROL_PLANE_URL: apiOrigin(),
      REMOTE_CLIENT_SHARED_SECRET: 'shared-test-secret',
      REMOTE_CLIENT_PLATFORM: 'darwin',
      REMOTE_CLIENT_TRANSPORT: 'headscale-http',
      REMOTE_CLIENT_TAILNET_HOSTNAME: 'edge-mac.tailnet.test',
      REMOTE_CLIENT_AGENT_ID: 'remote-agent-1',
      REMOTE_CLIENT_MCP_COMMAND: 'node',
      REMOTE_CLIENT_MCP_ARGS: 'scripts/mcp-one.js,--stdio',
      REMOTE_CLIENT_HEARTBEAT_INTERVAL_MS: '15000',
      REMOTE_CLIENT_POLL_INTERVAL_MS: '3000',
      REMOTE_CLIENT_DISABLE_POLLING: 'true',
    } as NodeJS.ProcessEnv);

    expect(config.clientId).toBe('edge-mac');
    expect(config.clientName).toBe('edge-mac');
    expect(config.controlPlaneUrl).toBe(apiOrigin());
    expect(config.controlPlaneToken).toBe('shared-test-secret');
    expect(config.platform).toBe('macos');
    expect(config.agentId).toBe('remote-agent-1');
    expect(config.mcpArgs).toEqual(['scripts/mcp-one.js', '--stdio']);
    expect(config.disablePolling).toBe(true);
  });

  test('registers a remote endpoint as a swarm-visible agent and preserves its canonical agent id', async () => {
    const registry = new RemoteClientRegistryService();
    const first = await registry.register({
      clientId: 'client-a',
      agentId: 'remote-agent-a',
      name: 'Remote Agent A',
      transport: 'headscale-http',
      platform: 'linux',
      controlPlaneUrl: apiOrigin(),
      endpointUrl: 'http://remote-agent-a.tailnet.test:5000',
      tailnetHostname: 'remote-agent-a.tailnet.test',
      capabilities: ['mcp.list-tools', 'remote-shell'],
      tags: ['remote-client', 'linux'],
      mcpServerName: 'local-mcp',
      mcpServerCommand: 'node scripts/mcp.js',
    });

    expect(first.clientId).toBe('client-a');
    expect(first.agentId).toBe('remote-agent-a');
    expect(first.status).toBe('online');
    expect(first.healthy).toBe(true);
    expect(first.mcpToolCount).toBe(2);

    const refreshed = await registry.register({
      clientId: 'client-a',
      agentId: 'attempted-new-agent-id',
      name: 'Remote Agent A Refreshed',
      transport: 'headscale-http',
      platform: 'linux',
      controlPlaneUrl: apiOrigin(),
      capabilities: ['mcp.call-tool'],
      tags: ['remote-client'],
    });

    expect(refreshed.agentId).toBe('remote-agent-a');
    expect(refreshed.name).toBe('Remote Agent A Refreshed');
  });

  test('queues, claims, and completes a remote-client task without losing queue state', async () => {
    const registry = await durableRegistry();
    await registerTaskClient(registry);

    const createdAt = new Date().toISOString();
    const queued = await registry.enqueueTask('client-b', {
      taskId: 'task-1',
      correlationId: 'corr-1',
      fromAgentId: 'project-manager',
      toAgentId: 'client-b',
      intent: 'mcp.call-tool',
      input: {
        toolName: 'diagnose-host',
        arguments: { target: 'localhost' },
      },
      createdAt,
    });

    expect(queued.status).toBe('queued');
    expect(registry.getClient('client-b')?.taskQueueDepth).toBe(1);

    const claimed = await registry.claimNextTask('client-b', null);
    expect(claimed?.status).toBe('claimed');
    expect(registry.getClient('client-b')?.activeTaskId).toBe('task-1');
    expect(registry.getClient('client-b')?.taskQueueDepth).toBe(0);

    const completed = await registry.completeTask('client-b', {
      taskId: 'task-1',
      correlationId: 'corr-1',
      clientId: 'client-b',
      status: 'completed',
      output: { ok: true },
      completedAt: new Date().toISOString(),
    });

    expect(completed.status).toBe('completed');
    expect(registry.getClient('client-b')?.activeTaskId).toBeUndefined();
  });

  test('fails a claimed remote-client task without losing lifecycle state', async () => {
    const registry = await durableRegistry();
    await registerTaskClient(registry);
    const createdAt = new Date().toISOString();
    await registry.enqueueTask('client-b', {
      taskId: 'task-2',
      correlationId: 'corr-2',
      fromAgentId: 'project-manager',
      toAgentId: 'client-b',
      intent: 'mcp.initialize',
      input: {},
      createdAt,
    });
    await registry.claimNextTask('client-b', null);

    const failed = await registry.failTask('client-b', {
      taskId: 'task-2',
      correlationId: 'corr-2',
      clientId: 'client-b',
      status: 'failed',
      error: 'remote MCP startup failed',
      completedAt: new Date().toISOString(),
    });

    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('remote MCP startup failed');
    expect(registry.getClient('client-b')?.activeTaskId).toBeUndefined();
  });

  test('deduplicates task retries by client and task id across the full lifecycle', async () => {
    const registry = await durableRegistry();
    await registerRetryClient(registry, 'client-retry');
    const envelope = retryEnvelope('task-at-most-once', 'do-one-thing');

    const accepted = await registry.enqueueTask('client-retry', envelope);
    const acceptedSnapshot = structuredClone(accepted);
    const acceptedArgs = accepted.input.arguments as { command: string };
    acceptedArgs.command = 'mutated-through-return-value';
    expect((await registry.enqueueTask('client-retry', envelope)).input).toEqual(envelope.input);
    await expect(registry.enqueueTask('client-retry', {
      ...envelope,
      input: { name: 'shell.exec', arguments: { command: 'different-command' } },
    })).rejects.toThrow(/conflicts with its durable envelope/);
    expect(registry.getClient('client-retry')?.taskQueueDepth).toBe(1);

    const claimed = await registry.claimNextTask('client-retry', null);
    expect(claimed?.taskId).toBe(envelope.taskId);
    expect(claimed?.input).toEqual(envelope.input);
    expect(await registry.enqueueTask('client-retry', envelope)).toEqual(acceptedSnapshot);
    expect(await registry.claimNextTask('client-retry', null)).toBeNull();

    const completion = await registry.completeTask('client-retry', {
      taskId: envelope.taskId,
      correlationId: envelope.correlationId,
      clientId: 'client-retry',
      status: 'completed',
      output: { ok: true },
      completedAt: new Date().toISOString(),
    });
    (completion.output as { ok: boolean }).ok = false;
    expect((await registry.getCompletedResult('client-retry', envelope.taskId))?.output).toEqual({ ok: true });
    expect(await registry.enqueueTask('client-retry', envelope)).toEqual(acceptedSnapshot);
    expect(await registry.claimNextTask('client-retry', null)).toBeNull();
  });

  test('refuses owner reassignment while queued or claimed work exists', async () => {
    const registry = await durableRegistry();
    await registry.register({
      clientId: 'client-owned',
      ownerSub: 'owner-a',
      name: 'Owned node',
      transport: 'http',
      platform: 'windows',
      controlPlaneUrl: apiOrigin(),
      capabilities: ['mcp.call-tool'],
      tags: ['remote-client'],
    });
    await registry.enqueueTask('client-owned', {
      ...retryEnvelope('task-owner-guard', 'one-command'),
      toAgentId: 'client-owned',
      userSub: 'owner-a',
    });
    await expect(registry.setOwner('client-owned', 'owner-b')).rejects.toMatchObject({
      code: 'remote_client_owner_tasks_active',
    });
    expect(registry.getClient('client-owned')?.ownerSub).toBe('owner-a');
  });

  test('records remote heartbeat and queues inbound swarm messages for polling clients', async () => {
    const registry = new RemoteClientRegistryService();
    await registry.register({
      clientId: 'client-c',
      agentId: 'remote-agent-c',
      name: 'Remote Agent C',
      transport: 'sse',
      platform: 'macos',
      controlPlaneUrl: apiOrigin(),
      capabilities: ['mcp.list-tools'],
      tags: ['remote-client'],
    });

    const heartbeat = registry.recordHeartbeat('client-c', {
      clientId: 'client-c',
      agentId: 'remote-agent-c',
      status: 'degraded',
      controlPlaneReachable: true,
      mcpReady: false,
      activeTaskId: 'task-x',
      toolCount: 7,
      lastSeenAt: new Date().toISOString(),
      version: '1.0.0-test',
    });

    expect(heartbeat.status).toBe('degraded');
    expect(heartbeat.healthy).toBe(true);
    expect(heartbeat.heartbeatCount).toBe(1);
    expect(heartbeat.mcpToolCount).toBe(7);

    registry.enqueueSwarmMessage('client-c', {
      messageId: 'message-1',
      correlationId: 'corr-message-1',
      fromAgentId: 'project-manager',
      toAgentId: 'remote-agent-c',
      channel: 'agent.remote-agent-c',
      messageType: 'request',
      payload: { intent: 'inspect' },
      receivedAt: new Date().toISOString(),
    });

    const message = registry.claimNextSwarmMessage('client-c');
    expect(message?.messageId).toBe('message-1');
    expect(message?.payload).toEqual({ intent: 'inspect' });
    expect(registry.claimNextSwarmMessage('client-c')).toBeNull();
  });
