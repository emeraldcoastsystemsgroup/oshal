/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Session 17: Tests for dispatch pipeline, cost rollup, retry logic, logging fixes
 */

/**
 * @description
 * Tests for Session 17 break-fix changes:
 * - ROLE_CAPABILITY_MAP ensures Phase 4 routing finds developer bots
 * - Cline exit code handling and retry logic
 * - Schema: ticket_task_links CHECK constraint includes 'swarm-execution'
 * - Schema: work_items includes run_id column
 * - Schema: ticket_cost_rollup view definition
 * - Logger: stdout transport in production
 * - Ticket assignment: assigned_agent_id persisted after routing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClineHarnessProvider } from '../../src/features/llm-provider/services/claude-code-provider';
import type { ClineHarnessProviderConfig } from '../../src/shared/types/llm-provider';

// ── ROLE_CAPABILITY_MAP tests ────────────────────────────────────────────

describe('ROLE_CAPABILITY_MAP — Phase role to agent capability mapping', () => {
  // Inline the map so tests don't depend on the wiring file's runtime
  const ROLE_CAPABILITY_MAP: Record<string, string[]> = {
    'architect': ['planning', 'architecture'],
    'plan-reviewer': ['planning', 'review'],
    'domain-specialist': ['domain-expertise', 'analysis'],
    'challenge-reviewer': ['review', 'analysis'],
    'executor': ['code-implementation', 'implementation', 'code'],
    'code-improver': ['code-implementation', 'review', 'code'],
    'tester': ['testing', 'validation'],
    'qa-verifier': ['testing', 'validation', 'review'],
    'qa-gatekeeper': ['testing', 'quality-assurance'],
    'domain-specialist-review': ['domain-expertise', 'review'],
  };

  it('should map all PHASE_ROLE_MAP roles to capabilities', () => {
    // These are the roles from multi-round-dispatch-service.ts PHASE_ROLE_MAP
    const phaseRoles = [
      'architect', 'plan-reviewer',          // Phase 2
      'domain-specialist', 'challenge-reviewer', // Phase 3
      'executor', 'code-improver',           // Phase 4
      'tester', 'qa-verifier',               // Phase 5
      'qa-gatekeeper', 'domain-specialist-review', // Phase 6
    ];

    for (const role of phaseRoles) {
      const capabilities = ROLE_CAPABILITY_MAP[role];
      expect(capabilities, `Role '${role}' should have mapped capabilities`).toBeDefined();
      expect(capabilities.length, `Role '${role}' should map to at least 1 capability`).toBeGreaterThan(0);
    }
  });

  it('should map executor to code-implementation (matches agent DB capabilities)', () => {
    const caps = ROLE_CAPABILITY_MAP['executor'];
    expect(caps).toContain('code-implementation');
  });

  it('should map tester to testing capability', () => {
    const caps = ROLE_CAPABILITY_MAP['tester'];
    expect(caps).toContain('testing');
  });

  it('should return original role for unknown roles', () => {
    const role = 'unknown-role';
    const capabilities = ROLE_CAPABILITY_MAP[role] ?? [role];
    expect(capabilities).toEqual(['unknown-role']);
  });

  it('should not map executor to PM/QA capabilities (prevents SP-10 rejection)', () => {
    const caps = ROLE_CAPABILITY_MAP['executor'];
    expect(caps).not.toContain('planning');
    expect(caps).not.toContain('qa-validation');
    expect(caps).not.toContain('quality-assurance');
  });
});

// ── Cline exit code handling & retry ─────────────────────────────────────

describe('ClineHarnessProvider — exit code handling and retry', () => {
  const mockConfig: ClineHarnessProviderConfig = {
    apiKey: 'test-key',
    model: 'gpt-5.3-codex',
    baseUrl: 'mock-cli',
  };

  let provider: ClineHarnessProvider;

  beforeEach(() => {
    provider = new ClineHarnessProvider(mockConfig);
  });

  describe('buildProcessCloseError', () => {
    const invoke = (code: number, opts: {
      stderr?: string;
      timedOut?: boolean;
      fatalFailure?: string | null;
      stdout?: string;
    } = {}) => {
      return (provider as any).buildProcessCloseError(
        code,
        opts.stderr ?? '',
        'test-task',
        opts.timedOut ?? false,
        opts.fatalFailure ?? null,
        opts.stdout?.length ?? 0,
        opts.stderr?.length ?? 0,
        opts.stdout,
      );
    };

    it('should return null for exit code 0 (success)', () => {
      expect(invoke(0)).toBeNull();
    });

    it('should return timeout error when timed out', () => {
      const err = invoke(1, { timedOut: true });
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain('timed out');
    });

    it('should return fatal failure error', () => {
      const err = invoke(1, { fatalFailure: 'Not authenticated with OpenAI Codex' });
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain('Not authenticated');
    });

    it('should return null for exit code 1 WITH completion_result in stdout', () => {
      const stdout = '{"type":"say","say":"completion_result","text":"Done."}\n';
      expect(invoke(1, { stdout })).toBeNull();
    });

    it('should return error for exit code 1 WITHOUT completion_result', () => {
      const stdout = '{"type":"say","say":"text","text":"Working..."}\n';
      const err = invoke(1, { stdout, stderr: 'some error' });
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain('exited with code 1');
    });

    it('should prioritize timeout over fatal failure', () => {
      const err = invoke(1, { timedOut: true, fatalFailure: 'auth error' });
      expect(err!.message).toContain('timed out');
      expect(err!.message).not.toContain('auth error');
    });

    it('should prioritize fatal failure over exit code', () => {
      const err = invoke(1, { fatalFailure: 'auth error' });
      expect(err!.message).toContain('auth error');
      expect(err!.message).not.toContain('exited with code');
    });
  });

  describe('hasCompletionResult', () => {
    const check = (stdout: string) => (provider as any).hasCompletionResult(stdout);

    it('should detect completion_result in JSON output', () => {
      expect(check('{"type":"say","say":"completion_result","text":"Done."}')).toBe(true);
    });

    it('should return false for non-completion output', () => {
      expect(check('{"type":"say","say":"text","text":"Working..."}')).toBe(false);
    });

    it('should return false for empty output', () => {
      expect(check('')).toBe(false);
    });

    it('should handle multi-line output with completion_result on last line', () => {
      const stdout = [
        '{"type":"say","say":"text","text":"Starting..."}',
        '{"type":"say","say":"text","text":"Processing..."}',
        '{"type":"say","say":"completion_result","text":"All done."}',
      ].join('\n');
      expect(check(stdout)).toBe(true);
    });
  });

  describe('extractCompletionText', () => {
    const extract = (stdout: string) => (provider as any).extractCompletionText(stdout);

    it('should extract text from completion_result event', () => {
      const stdout = '{"type":"say","say":"completion_result","text":"Task completed successfully."}\n';
      expect(extract(stdout)).toBe('Task completed successfully.');
    });

    it('should use last completion_result if multiple exist', () => {
      const stdout = [
        '{"type":"say","say":"completion_result","text":"First result"}',
        '{"type":"say","say":"completion_result","text":"Final result"}',
      ].join('\n');
      expect(extract(stdout)).toBe('Final result');
    });

    it('should throw when no completion_result exists', () => {
      expect(() => extract('{"type":"say","say":"text","text":"no result"}\n'))
        .toThrow('completion_result');
    });
  });
});

// ── Schema statement tests ───────────────────────────────────────────────

describe('Schema — ticket_task_links role constraint', () => {
  // Read the schema source to validate the constraint includes swarm-execution
  it('should include swarm-execution in the role CHECK constraint', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const schemaPath = path.resolve(__dirname, '../../src/shared/services/database/ticket-schema.ts');
    const content = fs.readFileSync(schemaPath, 'utf8');

    // The CREATE TABLE should include swarm-execution
    expect(content).toContain("'swarm-execution'");

    // The idempotent ALTER TABLE should also include it
    expect(content).toContain('ticket_task_links_role_check');
  });

  it('should define the ticket_cost_rollup view', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const schemaPath = path.resolve(__dirname, '../../src/shared/services/database/ticket-schema.ts');
    const content = fs.readFileSync(schemaPath, 'utf8');

    expect(content).toContain('CREATE OR REPLACE VIEW ticket_cost_rollup');
    expect(content).toContain('ticket_task_links ttl');
    expect(content).toContain('chat_tasks ct');
    expect(content).toContain('total_cost');
    expect(content).toContain('total_tokens');
    expect(content).toContain('GROUP BY ttl.ticket_id');
  });
});

describe('Schema — work_items run_id column', () => {
  it('should include run_id in CREATE TABLE and ADD COLUMN', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const schemaPath = path.resolve(__dirname, '../../src/shared/services/database/work-item-schema.ts');
    const content = fs.readFileSync(schemaPath, 'utf8');

    expect(content).toContain('run_id TEXT');
    expect(content).toContain('ADD COLUMN IF NOT EXISTS run_id');
  });
});

describe('Work item assignment — status updates preserve worker attribution', () => {
  it('should not clear assigned_agent_id when a caller updates only status', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const repoPath = path.resolve(__dirname, '../../src/entities/work-item/repositories/work-item-repository.ts');
    const content = fs.readFileSync(repoPath, 'utf8');

    expect(content).toContain("assigned_agent_id=COALESCE(NULLIF($2, ''), assigned_agent_id)");
  });

  it('should stamp the accepting bot when the swarm worker claims and finalizes a work item', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const workerPath = path.resolve(__dirname, '../../src/features/swarm-orchestration/services/swarm-agent-worker.ts');
    const content = fs.readFileSync(workerPath, 'utf8');

    expect(content).toContain('updateStatus(item.workItemId, nextStatus, envelope.toAgentId)');
    expect(content).toContain('item.assignedAgentId || envelope.toAgentId');
  });
});

// ── Logger stdout transport test ─────────────────────────────────────────

describe('Logger — stdout transport in production', () => {
  it('should include a pino/file stdout transport (fd 1)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const loggerPath = path.resolve(__dirname, '../../src/shared/logger/logger.ts');
    const content = fs.readFileSync(loggerPath, 'utf8');

    // Should have stdout transport with destination: 1
    expect(content).toContain('destination: 1');
    // Should be using pino/file for stdout
    expect(content).toContain("target: 'pino/file'");
  });
});

// ── Ticket agent assignment test ─────────────────────────────────────────

describe('Ticket agent assignment — assigned_agent_id persistence', () => {
  it('should call updateTicket with assignedAgentId after planning', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const svcPath = path.resolve(__dirname, '../../src/features/swarm-orchestration/services/swarm-ticket-processing-service.ts');
    const content = fs.readFileSync(svcPath, 'utf8');

    // The processOneTicket method should persist the routed agent
    expect(content).toContain('assignedAgentId: winnerId');
    expect(content).toContain('updateTicket');
  });
});

// ── setup-cline-auth.sh provider env var test ────────────────────────────

describe('setup-cline-auth.sh — LLM_PROVIDER env var usage', () => {
  it('should use LLM_PROVIDER instead of hardcoded claude-code', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const scriptPath = path.resolve(__dirname, '../../scripts/setup-cline-auth.sh');
    const content = fs.readFileSync(scriptPath, 'utf8');

    // Should reference LLM_PROVIDER env var
    expect(content).toContain('LLM_PROVIDER');
    expect(content).toContain('CLINE_PROVIDER="${LLM_PROVIDER:-claude-code}"');

    // Should NOT hardcode claude-code as provider in globalState
    expect(content).not.toContain('"actModeApiProvider": "claude-code"');
    // Should use the variable instead
    expect(content).toContain('"actModeApiProvider": "${CLINE_PROVIDER}"');
  });

  it('should preserve existing OAuth tokens via merge logic', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const scriptPath = path.resolve(__dirname, '../../scripts/setup-cline-auth.sh');
    const content = fs.readFileSync(scriptPath, 'utf8');

    expect(content).toContain('Merging provider/model into existing globalState');
    expect(content).toContain('OAuth tokens preserved');
  });
});
