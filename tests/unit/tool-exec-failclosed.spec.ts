/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR                          | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Phase 0 tool-execution hardening: (1) cli command-template validation rejects shell metacharacters in static segments while accepting real production templates; (2) ToolAuthInterceptor always fails closed for exec-style unregistered tools and, under strict mode, for any unregistered tool — while preserving the default graceful-allow path.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-04 closure: every unknown tool and a missing interceptor deny by default; no raw executor fallback remains.
 */

import { describe, it, expect, vi } from 'vitest';
import { validateCliCommandTemplate } from '../../src/features/tool-registry/services/cli-command-validator';
import { ToolAuthInterceptor } from '../../src/features/tool-approval/services/tool-auth-interceptor';
import type { ApprovalWorkflowService } from '../../src/features/tool-approval/services/approval-workflow-service';
import { TaskOrchestrator } from '../../src/features/chat-orchestration/services/task-orchestrator';

describe('validateCliCommandTemplate', () => {
  // These are the real templates shipped in swarm-apps/*.yaml — must keep passing.
  const PRODUCTION_TEMPLATES = [
    'node /app/scripts/oshal-jobhunter.js query',
    'node /app/scripts/oshal-vault.js status {input}',
    'node /app/scripts/oshal-vault.js issue {input}',
    'node /app/scripts/oshal-world.js neighbors {input}',
    'node /app/scripts/oshal-feeds.js query',
  ];

  it('accepts real production templates', () => {
    for (const tpl of PRODUCTION_TEMPLATES) {
      expect(validateCliCommandTemplate(tpl), tpl).toEqual({ ok: true });
    }
  });

  it('accepts dotted input tokens', () => {
    expect(validateCliCommandTemplate('mytool --q {input.query} --task {taskId}')).toEqual({ ok: true });
  });

  it.each([
    ['command separator', 'mytool {input.q}; rm -rf /tmp/x'],
    ['pipe', 'mytool {input.q} | sh'],
    ['command substitution $(', 'mytool $(env)'],
    ['backtick', 'mytool `whoami`'],
    ['output redirect', 'mytool {input.q} > /etc/passwd'],
    ['input redirect', 'mytool < /etc/shadow'],
    ['background operator', 'mytool {input.q} & curl evil.com'],
    ['shell expansion', 'mytool ${HOME}'],
    ['newline', 'mytool {input.q}\nrm -rf /'],
  ])('rejects %s', (_label, tpl) => {
    const result = validateCliCommandTemplate(tpl);
    expect(result.ok).toBe(false);
  });

  it('rejects empty templates', () => {
    expect(validateCliCommandTemplate('').ok).toBe(false);
    expect(validateCliCommandTemplate('   ').ok).toBe(false);
  });

  it('rejects unsupported template tokens', () => {
    const result = validateCliCommandTemplate('mytool {process.env.SECRET}');
    expect(result.ok).toBe(false);
  });
});

describe('ToolAuthInterceptor — unregistered fail-closed behavior', () => {
  // lookupAuthMode always returns null => every tool is "unregistered".
  const lookupNull = async () => null;
  const approvalStub = {} as unknown as ApprovalWorkflowService;

  async function runTool(toolName: string): Promise<string> {
    const interceptor = new ToolAuthInterceptor({
      approvalService: approvalStub,
      lookupAuthMode: lookupNull,
    });
    const executor = interceptor.createInterceptedExecutor(
      async (name) => `EXECUTED:${name}`,
      'agent-1',
      'task-1',
    );
    return executor(toolName, {});
  }

  it('blocks an ordinary unregistered tool by default', async () => {
    expect(await runTool('read_file')).toContain('[BLOCKED]');
  });

  it('blocks exec-style unregistered tools', async () => {
    for (const name of ['execute_command', 'bash', 'Shell', 'run_command', 'eval']) {
      const out = await runTool(name);
      expect(out, name).toContain('[BLOCKED]');
    }
  });

  it('allows a registered auto tool', async () => {
    const interceptor = new ToolAuthInterceptor({
      approvalService: approvalStub,
      lookupAuthMode: async (_agentId, toolName) => ({
        authMode: 'auto' as const,
        tool: { toolId: 't1', name: toolName } as never,
      }),
    });
    const executor = interceptor.createInterceptedExecutor(
      async (name) => `EXECUTED:${name}`,
      'agent-1',
      'task-1',
    );
    expect(await executor('read_file', {})).toBe('EXECUTED:read_file');
  });

  it('does not expose the raw task executor when authorization wiring is missing', async () => {
    const rawExecutor = vi.fn(async () => 'EXECUTED');
    const orchestrator = new TaskOrchestrator({
      taskStore: {} as never,
      messageStore: {} as never,
      streamManager: {} as never,
      getProvider: () => ({}) as never,
      getTools: async () => [],
      executeTool: rawExecutor,
      getSystemPrompt: async () => '',
    });
    const getExecutor = (
      orchestrator as unknown as {
        getExecutor: (taskId: string, agentId?: string, userSub?: string) =>
          (toolName: string, toolInput: Record<string, unknown>) => Promise<string>;
      }
    ).getExecutor.bind(orchestrator);
    await expect(getExecutor('task-1', 'agent-1', 'owner-1')('read_file', {}))
      .resolves.toContain('[BLOCKED]');
    expect(rawExecutor).not.toHaveBeenCalled();
  });
});
