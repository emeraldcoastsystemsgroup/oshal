/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression tests for dynamic tool execution, prompt exposure, and bot compose registration
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { test, expect } from '@playwright/test';
import { StreamManager } from '../src/features/streaming';
import { ToolExecutorService } from '../src/features/chat-orchestration/services/tool-executor-service';
import { DynamicToolExecutorRegistry } from '../src/features/tool-registry';
import { createToolResolver } from '../src/app/composition/tool-runtime-context';
import { DynamicComposeService } from '../src/features/agent-management/services/dynamic-compose-service';
import { AuthMode, InstallMethod, ToolType, type Tool } from '../src/shared/types/tool';

test.describe('Dynamic registration framework', () => {
  test('executes a runtime-registered CLI tool through the server-side executor', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-runtime-cli-'));
    const previousWorkspaceRoot = process.env.CLINE_WORKSPACE_ROOT;
    process.env.CLINE_WORKSPACE_ROOT = workspaceRoot;

    const registry = new DynamicToolExecutorRegistry();
    registry.register({
      toolName: 'runtime-mirror-test',
      executorType: 'cli',
      cliCommand: 'node -e "console.log(process.argv[1])" {input.message}',
      runtimeRegistered: true,
      registeredAt: new Date().toISOString(),
    });

    try {
      const executor = new ToolExecutorService({
        streamManager: new StreamManager(),
        dynamicToolExecutorRegistry: registry,
      });
      const result = await executor.executeTool('runtime-cli-task', 'runtime-mirror-test', {
        message: 'dynamic-registration-ok',
      });

      expect(result).toContain('exitCode: 0');
      expect(result).toContain('dynamic-registration-ok');
    } finally {
      if (previousWorkspaceRoot === undefined) {
        delete process.env.CLINE_WORKSPACE_ROOT;
      } else {
        process.env.CLINE_WORKSPACE_ROOT = previousWorkspaceRoot;
      }
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('exposes runtime-registered tools in the prompt resolver', async () => {
    const registry = new DynamicToolExecutorRegistry();
    registry.register({
      toolName: 'runtime-prompt-test',
      executorType: 'cli',
      cliCommand: 'node --version',
      runtimeRegistered: true,
      registeredAt: new Date().toISOString(),
    });

    const fakeService = {
      getAllTools: async () => [buildTool('runtime-prompt-test')],
    };
    const fakeLogger = {
      info: () => undefined,
      error: () => undefined,
    };

    const resolveTools = createToolResolver(fakeService, fakeLogger, registry);
    const tools = await resolveTools('agent-a');

    expect(tools.some((tool) => tool.name === 'runtime-prompt-test')).toBeTruthy();
  });

  test('generates dynamic bot compose services as bot-node workers', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-dynamic-compose-'));
    const composePath = path.join(tempDir, 'docker-compose.dynamic.yml');
    const previousImage = process.env.OSHAL_BOT_IMAGE;
    process.env.OSHAL_BOT_IMAGE = 'oshal-bot:test';

    try {
      const service = new DynamicComposeService(composePath);
      const result = service.upsertService({
        agentName: 'runtime-test-agent',
        agentId: 'a0000000-0000-0000-0000-000000099999',
      });
      expect(result.success).toBeTruthy();

      const doc = yaml.load(fs.readFileSync(composePath, 'utf8')) as any;
      const worker = doc.services['runtime-test-agent'];
      expect(worker.image).toBe('oshal-bot:test');
      expect(worker.environment.BOT_RUNTIME).toBe('bot-node');
      expect(worker.environment.REDIS_URL).toBe('redis://oshal-redis:6379');
      expect(worker.environment.DATABASE_URL).toBe('postgresql://oshal:oshal@oshal-db:5432/oshal');
      expect(worker.environment.WORKSPACE_DIR).toBe('/app/workspace-shared');
      expect(worker.environment.CONFIG_OUTPUT_DIR).toBe('/app/output');
      expect(worker.environment.JWT_SECRET).toBeTruthy();
      expect(worker.volumes).toContain('oshal_workspace:/app/workspace-shared:rw');
      expect(worker.volumes).toContain('./config-seed:/app/config-seed:ro');
      expect(worker.networks).toContain('oshal');
    } finally {
      if (previousImage === undefined) {
        delete process.env.OSHAL_BOT_IMAGE;
      } else {
        process.env.OSHAL_BOT_IMAGE = previousImage;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function buildTool(name: string): Tool {
  const now = new Date();
  return {
    toolId: '00000000-0000-0000-0000-000000000123',
    name,
    displayName: 'Runtime Prompt Test',
    type: ToolType.CLI,
    category: 'runtime',
    version: '1.0.0',
    installSpec: { method: InstallMethod.NONE },
    skills: [],
    selectorFragment: '',
    routingTags: [],
    authGroup: '',
    defaultAuthMode: AuthMode.ASK,
    description: 'Runtime prompt exposure test tool',
    inputSchema: { type: 'object', properties: {} },
    examples: [],
    requiresApproval: true,
    timeoutMs: 30000,
    tags: ['runtime-registered'],
    enabled: true,
    registeredBy: 'test',
    registeredAt: now,
    createdAt: now,
    updatedAt: now,
  };
}
