/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — pins the autonomous-path tool-approval gate (any-bot/server/controllers/tool-approval-policy.js). This is the last deterministic thing standing between an injected ticket/email/web page and a shell on a bot node, and before extraction it was one expression with a flag name that reads like a typo. The load-bearing case is the FIRST test: the literal autoApprove payload AgentDispatchEngine sends on the unattended path must NOT auto-approve execute_command. The second test proves the block survives someone flipping the registry's requiresApproval to false, and the last two pin the current posture so a "cleanup" that switches per-tool keys on shows up as a failing test rather than a silent widening.
 */
import { describe, expect, it } from 'vitest';

const { shouldAutoApproveTool, NEVER_AUTO_APPROVE } = require('../../any-bot/server/controllers/tool-approval-policy');

/** The literal flags AgentDispatchEngine.js sends on the unattended ticket path. */
const DISPATCH_AUTO_APPROVE = {
  use_mcp_tool: true,
  execute_command: true,
  write_to_file: true,
  read_file: true,
};

describe('autonomous-path tool approval policy', () => {
  it('does NOT auto-approve execute_command with the real dispatch payload', () => {
    // Registry declares execute_command requiresApproval: true (tool-registry-baseline-tools.ts).
    expect(shouldAutoApproveTool(DISPATCH_AUTO_APPROVE, 'execute_command', true)).toBe(false);
  });

  it('still refuses execute_command if the registry approval flag is ever flipped off', () => {
    // requiresApproval:false is one edit away; NEVER_AUTO_APPROVE is what survives it.
    expect(shouldAutoApproveTool(DISPATCH_AUTO_APPROVE, 'execute_command', false)).toBe(false);
    expect(NEVER_AUTO_APPROVE.has('execute_command')).toBe(true);
  });

  it('does not treat the callers per-tool keys as approval (current, deliberate posture)', () => {
    // Callers pass write_to_file/use_mcp_tool/read_file; the policy reads `commandExecution`.
    // Nothing is auto-approved unattended. Changing this must be a reviewed decision, not a rename.
    expect(shouldAutoApproveTool(DISPATCH_AUTO_APPROVE, 'write_to_file', false)).toBe(false);
    expect(shouldAutoApproveTool(DISPATCH_AUTO_APPROVE, 'use_mcp_tool', false)).toBe(false);
    expect(shouldAutoApproveTool(DISPATCH_AUTO_APPROVE, 'read_file', false)).toBe(false);
  });

  it('preserves the legacy commandExecution flag for non-approval tools', () => {
    expect(shouldAutoApproveTool({ commandExecution: true }, 'read_file', false)).toBe(true);
    // …but never as an override of a registry-declared approval requirement.
    expect(shouldAutoApproveTool({ commandExecution: true }, 'read_file', true)).toBe(false);
  });

  it('is fail-closed on a missing or empty flag object', () => {
    expect(shouldAutoApproveTool(undefined, 'read_file', false)).toBe(false);
    expect(shouldAutoApproveTool({}, 'read_file', false)).toBe(false);
  });
});
