/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR                          | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Phase 0 tool-execution hardening: (1) cli command-template validation rejects shell metacharacters in static segments while accepting real production templates; (2) ToolAuthInterceptor always fails closed for exec-style unregistered tools and, under strict mode, for any unregistered tool — while preserving the default graceful-allow path.
 */

import { describe, it, expect } from 'vitest';
import { validateCliCommandTemplate } from '../../src/features/tool-registry/services/cli-command-validator';
import { ToolAuthInterceptor } from '../../src/features/tool-approval/services/tool-auth-interceptor';
import type { ApprovalWorkflowService } from '../../src/features/tool-approval/services/approval-workflow-service';

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

  async function runTool(opts: { strict?: boolean; toolName: string }): Promise<string> {
    const interceptor = new ToolAuthInterceptor({
      approvalService: approvalStub,
      lookupAuthMode: lookupNull,
      failClosedUnregistered: opts.strict ?? false,
    });
    const executor = interceptor.createInterceptedExecutor(
      async (name) => `EXECUTED:${name}`,
      'agent-1',
      'task-1',
    );
    return executor(opts.toolName, {});
  }

  it('allows an ordinary unregistered tool in default (non-strict) mode', async () => {
    expect(await runTool({ toolName: 'read_file' })).toBe('EXECUTED:read_file');
  });

  it('always blocks exec-style unregistered tools even in default mode', async () => {
    for (const name of ['execute_command', 'bash', 'Shell', 'run_command', 'eval']) {
      const out = await runTool({ toolName: name });
      expect(out, name).toContain('[BLOCKED]');
    }
  });

  it('blocks any unregistered tool in strict mode', async () => {
    expect(await runTool({ strict: true, toolName: 'read_file' })).toContain('[BLOCKED]');
  });

  it('still allows registered-but-unrelated tools through strict mode is not triggered when lookup resolves', async () => {
    // Sanity: when lookup returns auto, the tool runs regardless of strict mode.
    const interceptor = new ToolAuthInterceptor({
      approvalService: approvalStub,
      lookupAuthMode: async (_agentId, toolName) => ({
        authMode: 'auto' as const,
        tool: { toolId: 't1', name: toolName } as never,
      }),
      failClosedUnregistered: true,
    });
    const executor = interceptor.createInterceptedExecutor(
      async (name) => `EXECUTED:${name}`,
      'agent-1',
      'task-1',
    );
    expect(await executor('read_file', {})).toBe('EXECUTED:read_file');
  });
});
