/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | n8n-import-analyze builtin through the real ToolExecutorService and DynamicToolExecutorRegistry: the report is valid, size-bounded JSON without source names or values, source JSON never reaches stream events, a failure reports only the generic sensitive-tool error, and runtime descriptors cannot replace the reserved executor.
 */
import { describe, expect, it, vi } from 'vitest';
import { ToolExecutorService } from '../../src/features/chat-orchestration/services/tool-executor-service';
import { DynamicToolExecutorRegistry } from '../../src/features/tool-registry/services/dynamic-tool-executor-registry';
import type { StreamManager } from '../../src/features/streaming';

function makeExecutor() {
  const broadcastToolExecution = vi.fn();
  const registry = new DynamicToolExecutorRegistry();
  registry.seedBuiltinDescriptors();
  const executor = new ToolExecutorService({
    streamManager: { broadcastToolExecution } as unknown as StreamManager,
    dynamicToolExecutorRegistry: registry,
  });
  return { executor, registry, broadcastToolExecution };
}

function workflow(nodeCount = 2, linkCount = 1): string {
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    id: `private-id-${index}`,
    name: `Private node ${index}`,
    type: index ? 'n8n-nodes-base.set' : 'n8n-nodes-base.manualTrigger',
    typeVersion: 1,
    parameters: index ? { value: 'private-secret-value' } : {},
  }));
  return JSON.stringify({
    name: 'Private workflow title',
    active: true,
    nodes,
    connections: linkCount ? {
      'Private node 0': { main: [Array.from({ length: linkCount }, () => ({
        node: 'Private node 1', type: 'main', index: 0,
      }))] },
    } : {},
    pinData: { 'Private node 1': [{ json: { password: 'private-pinned-sentinel' } }] },
  });
}

describe('n8n analysis swarm builtin', () => {
  it('is fixed, analysis-only, and never broadcasts source JSON or returns private fields', async () => {
    const { executor, registry, broadcastToolExecution } = makeExecutor();
    expect(registry.resolve('n8n-import-analyze')).toMatchObject({
      executorType: 'builtin', builtinKey: 'n8n-import-analyze', runtimeRegistered: false,
    });
    expect(() => registry.register({
      toolName: 'n8n-import-analyze', executorType: 'api', apiEndpoint: 'https://example.invalid/upload',
      runtimeRegistered: true, registeredAt: new Date().toISOString(),
    })).toThrow(/reserved/);
    expect(() => registry.register({
      toolName: 'alias-import', executorType: 'builtin', builtinKey: 'n8n-import-analyze',
      runtimeRegistered: true, registeredAt: new Date().toISOString(),
    })).toThrow(/reserved/);

    const result = await executor.executeTool('ticket-1', 'n8n-import-analyze', { jsonText: workflow() });
    const report = JSON.parse(result);
    expect(report).toMatchObject({ analysisOnly: true, executable: false, publishable: false,
      nodeCount: 2, connectionCount: 1, omittedNodeCount: 0, omittedConnectionCount: 0 });
    expect(report.nodes[0]).toMatchObject({ type: 'n8n-nodes-base.manualTrigger', status: 'needs_configuration' });
    for (const secret of ['private-secret-value', 'private-pinned-sentinel', 'Private workflow title', 'Private node 0', 'private-id-0']) {
      expect(result).not.toContain(secret);
      expect(JSON.stringify(broadcastToolExecution.mock.calls)).not.toContain(secret);
    }
    expect(broadcastToolExecution.mock.calls[0][1]).toEqual({ name: 'n8n-import-analyze' });
  });

  it('returns valid bounded JSON with honest total and omitted counts for a large graph', async () => {
    const { executor } = makeExecutor();
    const result = await executor.executeTool('ticket-1', 'n8n-import-analyze', { jsonText: workflow(200, 400) });
    const report = JSON.parse(result);
    expect(result.length).toBeLessThanOrEqual(12_000);
    expect(report).toMatchObject({ nodeCount: 200, connectionCount: 400,
      omittedNodeCount: 190, omittedConnectionCount: 390,
      analysisOnly: true, executable: false, publishable: false });
    expect(report.nodes).toHaveLength(10);
    expect(report.connections).toHaveLength(10);
  });

  it('refuses invalid and oversize input without leaking it to stream events', async () => {
    const { executor, broadcastToolExecution } = makeExecutor();
    const privateInput = 'private-secret-value'.repeat(30_000);
    await expect(executor.executeTool('ticket-1', 'n8n-import-analyze', { jsonText: privateInput }))
      .rejects.toThrow(/byte_limit_exceeded/);
    expect(JSON.stringify(broadcastToolExecution.mock.calls)).not.toContain('private-secret-value');
    expect(broadcastToolExecution.mock.calls.at(-1)?.[1]).toMatchObject({
      name: 'n8n-import-analyze', error: 'Sensitive tool execution failed',
    });
  });
});
