/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage to preserve shared OpenAI Codex runtime credentials even when persisted global provider selection is not Codex
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage for live agent startup manifest assembly and agentId propagation
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Prove trusted direct-mode system prompts retain bot attribution while bypassing filesystem persona resolution.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { test, expect } from '@playwright/test';
import { AgentStartupManifestService } from '../src/features/llm-provider/services/agent-startup-manifest-service';
import { ClineRuntimeConfigSyncService } from '../src/features/llm-provider/services/cline-runtime-config-sync-service';
import { ClineSessionRuntimeService } from '../src/features/llm-provider/services/cline-session-runtime-service';
import { LLMService, type LLMResponse, type SendRequestOptions } from '../src/features/llm-provider/services/llm-service';
import { runAgenticLoop } from '../src/features/chat-orchestration/services/agentic-loop';
import { TaskOrchestrator } from '../src/features/chat-orchestration/services/task-orchestrator';
import { InMemoryTaskStore } from '../src/entities/task';
import { InMemoryMessageStore } from '../src/entities/message';
import { StreamManager } from '../src/features/streaming';
import { AuthMode, InstallMethod, ToolType } from '../src/shared/types/tool';

/**
 * @description Minimal fake provider used to capture provider request options during runtime tests.
 */
class CapturingProvider extends LLMService {
  lastRequest: SendRequestOptions | null = null;

  constructor() {
    super('capture-provider', {});
  }

  /**
   * @description Capture provider request options and return a simple text response.
   * @param options - Provider request options from the orchestration path.
   * @returns Static completion response.
   */
  async sendRequest(options: SendRequestOptions): Promise<LLMResponse> {
    this.lastRequest = options;
    return {
      content: [{ type: 'text', text: 'captured' } as any],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'capture-model',
      stopReason: 'end_turn',
    };
  }
}

test.describe('Live Agent Startup Manifest', () => {
  test('writes a manifest with runtime, tool, selector, and MCP context', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-manifest-'));
    const service = new AgentStartupManifestService({
      loadAgentProfile: async () => ({
        agentId: 'agent-1',
        name: 'Manifest Bot',
        status: 'active',
        providerId: 'claude-code',
        modelId: 'gpt-5.4',
        persona: { role: 'developer', systemPrompt: 'Be precise.' },
        metadata: { owner: 'oshal' },
        projectUrl: 'https://git.example.com/team/repo',
        avatarUrl: 'https://example.com/avatar.png',
      }),
      loadAgentTools: async () => [createAgentTool()],
      loadComposedSelector: async () => ({
        agentId: 'agent-1',
        baseCapabilities: ['chat'],
        toolCapabilities: ['deploy'],
        capabilities: ['chat', 'deploy'],
        baseSelectorDescriptor: 'Base descriptor',
        toolSelectorFragments: 'Uses deployment tooling',
        selectorDescriptor: 'Base descriptor\n\nUses deployment tooling',
        baseRoutingKeywords: ['chat'],
        toolRoutingTags: ['deploy'],
        routingKeywords: ['chat', 'deploy'],
      }),
      readMcpSettings: () => ({
        mcpServers: {
          'chroma-mcp': { url: 'http://chroma-mcp:8082/mcp' },
          filesystem: { command: 'uvx', args: ['mcp-filesystem'] },
        },
      }),
      getMcpSettingsPath: () => '/tmp/.cline/mcp_settings.json',
    });

    const manifestPath = await service.prepareManifest({
      taskId: 'task-123',
      agentId: 'agent-1',
      workspacePath,
      binaryPath: '/usr/local/bin/cline',
      configDir: '/tmp/.cline',
      runtimeSelection: { provider: 'openai-codex', model: 'gpt-5.4', mode: 'plan' },
      systemPrompt: 'Layered runtime prompt',
      callableTools: [
        {
          name: 'execute_command',
          description: 'Execute a workspace command',
          input_schema: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ],
    });

    expect(fs.existsSync(manifestPath)).toBeTruthy();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.taskId).toBe('task-123');
    expect(manifest.runtime.provider).toBe('openai-codex');
    expect(manifest.agent.profile.name).toBe('Manifest Bot');
    expect(manifest.agent.selector.capabilities).toContain('deploy');
    expect(manifest.agent.enabledTools).toHaveLength(1);
    expect(manifest.agent.enabledTools[0].name).toBe('presentron');
    expect(manifest.agent.enabledTools[0].config.endpointUrl).toBe('http://presentron.local');
    expect(manifest.mcp.settingsPath).toBe('/tmp/.cline/mcp_settings.json');
    expect(manifest.mcp.servers).toHaveLength(2);
    expect(JSON.stringify(manifest)).not.toContain('super-secret-api-key');
  });

  test('builds session MCP settings and runtime config inside the task workspace', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-runtime-root-'));
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-output-root-'));
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-workspace-'));

    fs.mkdirSync(path.join(runtimeRoot, 'data'), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'config.json'), JSON.stringify({ provider: 'openai-codex' }, null, 2));
    fs.writeFileSync(path.join(runtimeRoot, 'data', 'globalState.json'), JSON.stringify({ mode: 'plan' }, null, 2));
    fs.writeFileSync(path.join(runtimeRoot, 'data', 'secrets.json'), JSON.stringify({ token: 'secret' }, null, 2));
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
    const sessionRuntimeService = new ClineSessionRuntimeService(runtimeSyncService, runtimeRoot);
    const sessionRuntime = sessionRuntimeService.prepareSessionRuntime(workspacePath);

    expect(fs.existsSync(path.join(sessionRuntime.configDir, 'config.json'))).toBeTruthy();
    expect(fs.existsSync(path.join(sessionRuntime.configDir, 'data', 'globalState.json'))).toBeTruthy();
    expect(fs.existsSync(path.join(sessionRuntime.configDir, 'data', 'secrets.json'))).toBeTruthy();
    expect(fs.existsSync(sessionRuntime.mcpSettingsPath)).toBeTruthy();

    const sessionGlobalState = JSON.parse(
      fs.readFileSync(path.join(sessionRuntime.configDir, 'data', 'globalState.json'), 'utf8'),
    ) as Record<string, any>;
    const sessionMcpSettings = JSON.parse(fs.readFileSync(sessionRuntime.mcpSettingsPath, 'utf8')) as Record<string, any>;

    expect(sessionGlobalState.focusChainSettings).toEqual({
      enabled: false,
      remindClineInterval: 0,
    });
    expect(sessionMcpSettings.mcpServers['chroma-mcp']).toBeUndefined();
    expect(sessionMcpSettings.mcpServers['google-search-mcp'].url).toBe('http://google-search-mcp.custom:8090');
    expect(sessionMcpSettings.mcpServers['presentron-mcp'].url).toBe('http://presentron-mcp.custom:8081');
    expect(sessionMcpSettings.mcpServers.filesystem.command).toBe('npx');
  });

  test('preserves shared OpenAI Codex credentials in runtime sync even when another provider is selected', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-runtime-root-'));
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-output-root-'));

    fs.mkdirSync(path.join(runtimeRoot, 'data'), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'config.json'), JSON.stringify({ provider: 'claude-code' }, null, 2));
    fs.writeFileSync(path.join(runtimeRoot, 'data', 'globalState.json'), JSON.stringify({ mode: 'act' }, null, 2));
    fs.writeFileSync(
      path.join(outputRoot, 'global-config.json'),
      JSON.stringify({
        actModeApiProvider: 'claude-code',
        actModeApiModelId: 'claude-sonnet-4-5-20250929',
      }, null, 2),
    );
    fs.writeFileSync(
      path.join(outputRoot, 'secrets.json'),
      JSON.stringify({
        'mock-user-001': {
          openAiCodexOauthCredentials: JSON.stringify({
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            accountId: 'acct-123',
            expiresAt: Date.now() + 60_000,
          }),
        },
      }, null, 2),
    );

    const runtimeSyncService = new ClineRuntimeConfigSyncService(runtimeRoot, outputRoot);
    const selection = runtimeSyncService.syncFromPersistedConfig('codex-mini-latest', 'mock-user-001');
    const secrets = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'data', 'secrets.json'), 'utf8')) as Record<string, string>;

    expect(selection.provider).toBe('claude-code');
    expect(secrets['openai-codex-oauth-credentials']).toBeTruthy();
    expect(secrets['openai-codex-oauth-credentials']).toContain('access-token');
  });

  test('passes agentId through the agentic loop provider call', async () => {
    const provider = new CapturingProvider();

    await runAgenticLoop(
      provider,
      [{ role: 'user', content: 'hello' } as any],
      'System prompt',
      [],
      async () => 'unused',
      { maxTurns: 1, taskId: 'task-agentic', agentId: 'agent-loop' },
    );

    expect(provider.lastRequest?.taskId).toBe('task-agentic');
    expect(provider.lastRequest?.agentId).toBe('agent-loop');
  });

  test('uses a trusted direct prompt without losing agent attribution', async () => {
    const provider = new CapturingProvider();
    const taskStore = new InMemoryTaskStore();
    const messageStore = new InMemoryMessageStore();
    const streamManager = new StreamManager();
    let promptResolverCalls = 0;
    const orchestrator = new TaskOrchestrator({
      taskStore,
      messageStore,
      streamManager,
      getProvider: () => provider,
      getTools: async () => [],
      executeTool: async () => 'unused',
      getSystemPrompt: async () => { promptResolverCalls++; return 'Filesystem prompt'; },
    });

    const result = await orchestrator.processMessage('task-direct', 'hello', {
      agenticMode: false,
      autoApprove: false,
      source: 'playwright',
      agentId: 'agent-direct',
      systemPromptOverride: 'Trusted package prompt',
    });

    expect(result.success).toBe(true);
    expect(provider.lastRequest?.taskId).toBe('task-direct');
    expect(provider.lastRequest?.agentId).toBe('agent-direct');
    expect(provider.lastRequest?.systemPrompt).toBe('Trusted package prompt');
    expect(promptResolverCalls).toBe(0);
  });
});

/**
 * @description Creates a fully-typed enabled tool fixture for manifest tests.
 * @returns Agent tool assignment with sanitized runtime configuration.
 */
function createAgentTool() {
  return {
    agentId: 'agent-1',
    toolId: 'tool-1',
    authMode: AuthMode.AUTO,
    installed: true,
    installVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    toolConfig: {
      auth: {
        type: 'api_key',
        enabled: true,
        apiKey: 'super-secret-api-key',
      },
      endpoint: {
        url: 'http://presentron.local',
      },
      metadata: {
        profile: 'default',
      },
    },
    tool: {
      toolId: 'tool-1',
      name: 'presentron',
      displayName: 'Presentron',
      type: ToolType.PRESENTRON,
      category: 'presentation',
      version: '1.0.0',
      installSpec: { method: InstallMethod.NONE },
      skills: ['slides', 'presentation'],
      selectorFragment: 'Creates presentations',
      routingTags: ['slides'],
      authGroup: 'presentron',
      defaultAuthMode: AuthMode.OFF,
      description: 'Generate presentation decks',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      usageInstructions: 'Provide a deck request.',
      examples: [],
      requiresApproval: false,
      timeoutMs: 30000,
      tags: ['presentron'],
      enabled: true,
      registeredBy: 'test',
      registeredAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}
