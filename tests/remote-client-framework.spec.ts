/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added remote-client framework regression coverage for config, registry, task lifecycle, and swarm queueing
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Control-plane URL fixtures follow PLAYWRIGHT_PORT via the shared apiOrigin() helper instead of hardcoded localhost:35457 literals — every side of each round-trip reads the same helper, so the assertions stay internally consistent under any port (byte-identical under the default env)
 */

import { test, expect } from '@playwright/test';
import {
  RemoteClientRegistryService,
  loadRemoteClientConfig,
} from '@/features/remote-client';
import { apiOrigin } from './helpers';

test.describe('remote-client framework contracts', () => {
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

  test('registers a remote endpoint as a swarm-visible agent and preserves its canonical agent id', () => {
    const registry = new RemoteClientRegistryService();
    const first = registry.register({
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

    const refreshed = registry.register({
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

  test('queues, claims, completes, and fails remote-client tasks without losing queue state', () => {
    const registry = new RemoteClientRegistryService();
    registry.register({
      clientId: 'client-b',
      name: 'Remote Agent B',
      transport: 'http',
      platform: 'windows',
      controlPlaneUrl: apiOrigin(),
      capabilities: ['mcp.initialize', 'mcp.call-tool'],
      tags: ['remote-client'],
    });

    const createdAt = new Date().toISOString();
    const queued = registry.enqueueTask('client-b', {
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

    const claimed = registry.claimNextTask('client-b');
    expect(claimed?.status).toBe('claimed');
    expect(registry.getClient('client-b')?.activeTaskId).toBe('task-1');
    expect(registry.getClient('client-b')?.taskQueueDepth).toBe(0);

    const completed = registry.completeTask('client-b', {
      taskId: 'task-1',
      correlationId: 'corr-1',
      clientId: 'client-b',
      status: 'completed',
      output: { ok: true },
      completedAt: new Date().toISOString(),
    });

    expect(completed.status).toBe('completed');
    expect(registry.getClient('client-b')?.activeTaskId).toBeUndefined();

    registry.enqueueTask('client-b', {
      taskId: 'task-2',
      correlationId: 'corr-2',
      fromAgentId: 'project-manager',
      toAgentId: 'client-b',
      intent: 'mcp.initialize',
      input: {},
      createdAt,
    });
    registry.claimNextTask('client-b');

    const failed = registry.failTask('client-b', {
      taskId: 'task-2',
      correlationId: 'corr-2',
      clientId: 'client-b',
      error: 'remote MCP startup failed',
    });

    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('remote MCP startup failed');
    expect(registry.getClient('client-b')?.activeTaskId).toBeUndefined();
  });

  test('records remote heartbeat and queues inbound swarm messages for polling clients', () => {
    const registry = new RemoteClientRegistryService();
    registry.register({
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
});
