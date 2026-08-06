/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SEC-04: prove every MCP transport fails closed without exact caller/tool scope, current registry attestation, and server-owned approval.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Exercise the remote stdio client's caller/tool/snapshot checks before its private JSON-RPC transport can run.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Lock both edge-agent launch surfaces against raw mesh-to-MCP execution and discovered-tool capability advertisement.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Prove the Vids remote worker binds its private local executor to the claimed durable task target and immutable tool inventory.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Reject ambiguous server identifiers and lock attestation minting plus proxy transport references behind private class fields.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Mutate a discovered tool object after registration and prove transport remains bound to the authorized registration-time name.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Lock the only direct Chroma backend JSON-RPC calls to their two literal private adapter operations.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { DynamicToolExecutorRegistry } from '../../src/features/tool-registry/services/dynamic-tool-executor-registry';
import { McpStdioClient } from '../../src/features/remote-client/services/mcp-stdio-client';

const requireModule = createRequire(import.meta.url);
const ToolRegistry = requireModule('../../any-bot/server/services/ToolRegistry.js');
const MCPServiceV2 = requireModule('../../any-bot/server/services/MCPServiceV2.js');
const { UnifiedMCPProxy } = requireModule('../../any-bot/server/app-modules/unified-mcp-proxy.js');
const { VidsWorker } = requireModule('../../packages/oshal-vids-operator/src/worker/remote-client.js');
const {
  assertMcpExecutionAttestation,
  canonicalMcpToolName,
} = requireModule('../../any-bot/server/services/mcp-tool-authorization.js');

interface McpContext {
  userSub: string;
  agentId: string;
  taskId: string;
  allowedTools: string[];
  authorizedScopes: string[];
}

function context(capability: string): McpContext {
  return {
    userSub: 'owner-a',
    agentId: 'agent-a',
    taskId: 'task-a',
    allowedTools: [capability],
    authorizedScopes: [`tool:${capability}`],
  };
}

function fakeStore() {
  return {
    upsertTool: vi.fn(),
    recordToolExecution: vi.fn(),
    updateServerStatus: vi.fn(),
    updateServerToolsCount: vi.fn(),
    getServerStats: vi.fn(() => ({})),
  };
}

describe('legacy MCP transport authorization', () => {
  it('uses an unambiguous bounded server/tool capability name', () => {
    expect(canonicalMcpToolName('safe-server', 'read_public_status'))
      .toBe('mcp_safe-server_read_public_status');
    expect(() => canonicalMcpToolName('safe_server', 'read_public_status'))
      .toThrow('serverName is invalid');
    expect(() => canonicalMcpToolName('a'.repeat(128), 'b'.repeat(128)))
      .toThrow('pair is too long');
  });

  it('keeps an advertised stdio tool privileged and unreachable through raw handlers', async () => {
    const registry = new ToolRegistry();
    const store = fakeStore();
    const service = new MCPServiceV2({ mcp: { timeout: 1_000 } }, registry, store);
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    Reflect.set(service, 'serverManager', {
      isServerRunning: () => true,
      callTool,
      getServerInfo: () => ({ id: 'plane-mcp', status: 'connected', tools: [], resources: [], prompts: [] }),
    });
    const discoveredTool = {
      name: 'create_project',
      description: 'Privileged Plane write',
      inputSchema: { type: 'object', properties: {} },
    };
    service.registerTool('plane-mcp', discoveredTool);
    discoveredTool.name = 'delete_project';

    const capability = canonicalMcpToolName('plane-mcp', 'create_project');
    const tool = registry.get(capability);
    const proxy = new UnifiedMCPProxy(service, null, registry);

    expect(tool.requiresApproval).toBe(true);
    expect((service as { executeTool?: unknown }).executeTool).toBeUndefined();
    await expect(tool.handler({}, context(capability)))
      .rejects.toThrow('attestation is missing or stale');
    await expect(proxy.executeTool('plane-mcp', 'create_project', {}, {
      ...context(capability),
      approved: true,
    })).rejects.toThrow('requires approval before execution');
    expect(callTool).not.toHaveBeenCalled();

    const snapshot = registry.capture(capability);
    await expect(registry.executeSnapshot(snapshot, {}, {
      ...context(capability),
      approved: true,
      extraEnv: { OSHAL_USER_SUB: 'owner-a' },
    })).resolves.toMatchObject({ success: true, tool: 'create_project' });
    expect(callTool).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledWith('plane-mcp', 'create_project', {});
    await expect(service.accessResource('plane-mcp', 'secret://resource'))
      .rejects.toThrow('Direct MCP resource access is retired');
  });

  it('requires every exact caller and authority field before an auto tool may execute', async () => {
    const registry = new ToolRegistry();
    const capability = canonicalMcpToolName('safe-server', 'read_public_status');
    const handler = vi.fn(async (_input: unknown, trustedContext: unknown) => {
      assertMcpExecutionAttestation(registry, trustedContext, capability);
      return { status: 'ok' };
    });
    registry.register({
      name: capability,
      handler,
      requiresApproval: false,
      inputSchema: { type: 'object', properties: {} },
    });
    const proxy = new UnifiedMCPProxy({ hasServer: () => true }, null, registry);
    const good = context(capability);

    for (const missing of ['userSub', 'agentId', 'taskId', 'allowedTools', 'authorizedScopes'] as const) {
      const incomplete = { ...good } as Record<string, unknown>;
      delete incomplete[missing];
      await expect(proxy.executeTool('safe-server', 'read_public_status', {}, incomplete))
        .rejects.toThrow();
    }
    await expect(proxy.executeTool('safe-server', 'read_public_status', {}, {
      ...good,
      allowedTools: ['mcp_safe-server_another_tool'],
    })).rejects.toThrow('not allowlisted');
    await expect(proxy.executeTool('safe-server', 'read_public_status', {}, {
      ...good,
      authorizedScopes: ['tool:mcp_safe-server_another_tool'],
    })).rejects.toThrow('missing exact scope');
    await expect(proxy.executeTool('safe-server', 'read_public_status', {}, good))
      .resolves.toEqual({ status: 'ok' });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('denies when the canonical registry/interceptor is absent', async () => {
    const capability = canonicalMcpToolName('safe-server', 'read_public_status');
    const proxy = new UnifiedMCPProxy({ hasServer: () => true }, null, null);
    await expect(proxy.executeTool('safe-server', 'read_public_status', {}, context(capability)))
      .rejects.toThrow('authorization is unavailable');
  });
});

describe('MCP execution inventory', () => {
  const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

  it('contains no legacy raw service or transport executor callsite', () => {
    const route = read('any-bot/server/app-modules/routes-mcp-voice-queue.js');
    const proxy = read('any-bot/server/app-modules/unified-mcp-proxy.js');
    const httpService = read('any-bot/server/services/MCPService.js');
    const stdioService = read('any-bot/server/services/MCPServiceV2.js');
    const edge = read('src/features/edge-agent/edge-agent-server.ts');
    const edgeCli = read('scripts/edge-agent.ts');
    const remote = read('src/features/remote-client/services/remote-client-service.ts');
    const client = read('src/features/remote-client/services/mcp-stdio-client.ts');
    const vidsWorker = read('packages/oshal-vids-operator/src/worker/remote-client.js');
    const swarmMemory = read('any-bot/server/services/queue-manager/SwarmMemoryService.js');

    expect(route).not.toMatch(/application\.mcpService(?:HTTP)?\.executeTool/);
    expect(route).toContain('application.mcpProxy.executeTool');
    expect(proxy).not.toMatch(/this\.(?:stdio|http)\.executeTool/);
    expect(proxy).toContain('this.#toolRegistry.executeSnapshot');
    expect(proxy).not.toMatch(/this\.(?:stdio|http|toolRegistry)\s*=/);
    expect(httpService).not.toMatch(/\basync executeTool\s*\(/);
    expect(stdioService).not.toMatch(/\basync executeTool\s*\(/);
    expect(httpService).toContain('assertMcpExecutionAttestation');
    expect((httpService.match(/axios\.post\(/g) ?? [])).toHaveLength(1);
    expect((stdioService.match(/serverManager\.callTool\(/g) ?? [])).toHaveLength(1);
    expect(stdioService).toContain('assertMcpExecutionAttestation');
    expect(edge).not.toMatch(/state\.mcp\.callTool/);
    expect(edgeCli).not.toMatch(/mcp\.callTool/);
    expect(edgeCli).not.toMatch(/\.\.\.mcpTools/);
    expect(edgeCli).toContain('owner-bound remote-task authorization broker');
    expect(remote).toMatch(/mcpClient\.callTool\(toolName, args, \{/);
    expect(client).toContain('private async request');
    expect((client.match(/this\.request\('tools\/call'/g) ?? [])).toHaveLength(1);
    expect(read('any-bot/server/services/ToolRegistry.js')).toContain('async #executeCapturedTool');
    expect(vidsWorker).not.toMatch(/this\.callTool\(/);
    expect(vidsWorker).toContain('this.authorizeToolTask(task)');
    expect(vidsWorker).toContain('this.#executeAuthorizedTool');
    expect((swarmMemory.match(/method:\s*'tools\/call'/g) ?? [])).toHaveLength(2);
    expect((swarmMemory.match(/name:\s*'chroma_(?:add|query)_documents'/g) ?? []))
      .toHaveLength(2);
    expect(swarmMemory).not.toMatch(/params:\s*\{\s*name:\s*(?:toolName|`)/);
  });

  it('freezes runtime descriptors used by the internal bridge request-start check', () => {
    const registry = new DynamicToolExecutorRegistry();
    const source = {
      toolName: 'app-tool',
      executorType: 'api' as const,
      apiEndpoint: 'POST /api/original',
      runtimeRegistered: true,
      registeredAt: new Date().toISOString(),
    };
    registry.register(source);
    source.apiEndpoint = 'POST /api/replaced';

    const resolved = registry.resolve('app-tool');
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(resolved?.apiEndpoint).toBe('POST /api/original');
  });
});

describe('remote stdio MCP authorization', () => {
  it('rejects missing, non-allowlisted, and undiscovered calls before transport access', async () => {
    const client = new McpStdioClient({ command: 'unused-test-process' });
    const callTool = client.callTool.bind(client) as (
      name: string,
      args: Record<string, unknown>,
      context?: Record<string, unknown>,
    ) => Promise<unknown>;
    const authority = {
      taskId: 'task-a', callerId: 'agent-a', targetId: 'remote-a', allowedTools: ['safe-read'],
    };

    await expect(callTool('safe-read', {})).rejects.toThrow('context is missing or invalid');
    await expect(callTool('other-tool', {}, authority)).rejects.toThrow('not authorized');
    await expect(callTool('safe-read', {}, authority)).rejects.toThrow('discovered capability snapshot');

    const discovered = Reflect.get(client, 'discoveredTools') as Set<string>;
    discovered.add('safe-read');
    await expect(callTool('safe-read', {}, authority)).rejects.toThrow('not connected');
  });
});

describe('application remote-worker authorization', () => {
  const config = {
    clientId: 'vids-client-a', agentId: 'vids-agent-a', pollMs: 1, backoffCapMs: 2,
  };
  const task = {
    taskId: 'task-a', correlationId: 'correlation-a', fromAgentId: 'dispatcher-a',
    toAgentId: 'vids-agent-a', intent: 'mcp.call-tool',
    input: { name: 'content.list', arguments: { limit: 1 } },
  };

  it('accepts only the registered tool on this claimed worker target', () => {
    const worker = new VidsWorker(config, {});
    expect(worker.authorizeToolTask(task)).toMatchObject({
      taskId: 'task-a', callerId: 'dispatcher-a', targetId: 'vids-agent-a',
      toolName: 'content.list', args: { limit: 1 },
    });
    expect(() => worker.authorizeToolTask({ ...task, toAgentId: 'another-worker' }))
      .toThrow('targets another worker');
    expect(() => worker.authorizeToolTask({
      ...task, input: { name: 'unknown.tool', arguments: {} },
    })).toThrow('not registered');
  });
});
