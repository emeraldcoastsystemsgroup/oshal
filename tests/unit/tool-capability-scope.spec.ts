import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  createAgentSelectorCapabilityResolver,
  resolveAgentCapabilityScope,
} from '../../src/app/composition/agent-capability-resolver';
import { createToolResolver } from '../../src/app/composition/tool-runtime-context';
import { ClineRuntimeConfigSyncService } from '../../src/features/llm-provider/services/cline-runtime-config-sync-service';
import { AuthMode, InstallMethod, ToolType, type Tool } from '../../src/shared/types/tool';

describe('tool capability scoping', () => {
  it('filters runtime prompt tools to the agent capability set while preserving core tools', async () => {
    const resolveTools = createToolResolver(
      {
        getAllTools: async () => [
          buildTool('presentron', ['presentation']),
          buildTool('finance-report', ['finance']),
          buildTool('rag-query', ['rag-query']),
        ],
      },
      { info: () => undefined, error: () => undefined },
      undefined,
      async () => ['presentation'],
    );

    const tools = await resolveTools('presentation-agent');
    const names = tools.map((tool) => tool.name);

    expect(names).toContain('read_file');
    expect(names).toContain('presentron');
    expect(names).not.toContain('finance-report');
    expect(names).not.toContain('rag-query');
  });

  it('uses composed selector routing keywords as tool capability scope', async () => {
    const resolveTools = createToolResolver(
      {
        getAllTools: async () => [
          buildTool('career_database', ['career-data']),
          buildTool('finance-report', ['finance']),
        ],
      },
      { info: () => undefined, error: () => undefined },
      { listAll: () => [{ toolName: 'career_database' }] } as any,
      async () => ({
        capabilities: ['application-strategy'],
        routingKeywords: ['career-database', 'job-search'],
        selectorDescriptor: 'Use for career planning and application workflows.',
      }),
    );

    const names = (await resolveTools('career-advisor')).map((tool) => tool.name);

    expect(names).toContain('career_database');
    expect(names).not.toContain('finance-report');
  });

  it('prefers composed selector data and falls back to manifest capabilities', async () => {
    const resolver = createAgentSelectorCapabilityResolver(
      {
        getComposedSelector: async () => ({
          capabilities: ['world-query'],
          routingKeywords: ['market-research'],
          selectorDescriptor: 'World analyst selector',
        }),
        getAgentProfile: async () => ({
          capabilities: ['profile-fallback'],
          routingKeywords: ['profile-keyword'],
        }),
      },
      async () => ['registry-fallback'],
    );

    const scope = await resolveAgentCapabilityScope('world-analyst', resolver);

    expect(scope.capabilities).toEqual(['world-query', 'registry-fallback']);
    expect(scope.routingKeywords).toEqual(['market-research']);
    expect(scope.selectorDescriptor).toBe('World analyst selector');
  });

  it('filters managed session MCP servers to the agent capability set', () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-runtime-scope-'));
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-output-scope-'));

    try {
      fs.writeFileSync(
        path.join(outputRoot, 'global-config.json'),
        JSON.stringify({
          presentronServiceConfig: {
            endpoint: 'http://presentron-mcp.custom:8081',
          },
          googleSearchMcpConfig: {
            url: 'http://google-search-mcp.custom:8090',
          },
        }, null, 2),
      );

      const runtimeSyncService = new ClineRuntimeConfigSyncService(runtimeRoot, outputRoot);
      const settings = runtimeSyncService.buildSessionMcpSettings({
        agentId: 'presentation-agent',
        capabilities: ['presentation'],
      }) as Record<string, any>;
      const servers = settings.mcpServers as Record<string, unknown>;

      expect(servers['presentron-mcp']).toBeTruthy();
      expect(servers.filesystem).toBeUndefined();
      expect(servers.fetch).toBeUndefined();
      expect(servers.playwright).toBeUndefined();
      expect(servers['google-search-mcp']).toBeUndefined();
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });
});

function buildTool(name: string, skills: string[]): Tool {
  const now = new Date();
  return {
    toolId: `tool-${name}`,
    name,
    displayName: name,
    type: ToolType.CLI,
    category: skills[0] ?? 'runtime',
    version: '1.0.0',
    installSpec: { method: InstallMethod.NONE },
    skills,
    selectorFragment: '',
    routingTags: skills,
    authGroup: '',
    defaultAuthMode: AuthMode.ASK,
    description: `${name} test tool`,
    inputSchema: { type: 'object', properties: {} },
    examples: [],
    requiresApproval: true,
    timeoutMs: 30000,
    tags: skills,
    enabled: true,
    registeredBy: 'test',
    registeredAt: now,
    createdAt: now,
    updatedAt: now,
  };
}
