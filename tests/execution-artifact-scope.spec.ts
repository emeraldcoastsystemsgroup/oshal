/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | IMP-2: Unit tests for execution artifact scope isolation — sibling child and review context/handover separation
 */

import { test, expect } from '@playwright/test';
import {
  deriveExecutionScope,
  deriveExecutionScopeId,
  resolveScopedContextFileName,
  resolveScopedHandoverFileName,
  resolveScopedHandoverPrefix,
} from '../src/features/swarm-orchestration/services/execution-artifact-scope-service';

test.describe('ExecutionArtifactScope — Context Isolation', () => {
  test('parent ticket returns unscoped (backwards compatible)', () => {
    const scope = deriveExecutionScope('ws-abc', 'ticket-123', null, null);
    expect(scope.scopeType).toBe('parent-ticket');
    expect(scope.scopeId).toBe('');
  });

  test('child ticket returns scoped by child externalId', () => {
    const scope = deriveExecutionScope('ws-abc', 'child-456', 'parent-123', null);
    expect(scope.scopeType).toBe('child-ticket');
    expect(scope.scopeId).toBe('child-456');
  });

  test('review ticket returns scoped by review round', () => {
    const scope = deriveExecutionScope('ws-abc', 'ticket-123', null, 2);
    expect(scope.scopeType).toBe('review-ticket');
    expect(scope.scopeId).toContain('review-ticket-123-r2');
  });

  test('parent context file is backwards compatible', () => {
    const scope = deriveExecutionScope('ws-abc', 'ticket-123', null, null);
    const fileName = resolveScopedContextFileName(scope, 'a0000000-0000-0000-0000-000000000001');
    expect(fileName).toBe('a0000000-0000-0000-0000-000000000001-context.md');
  });

  test('child context file includes scope prefix', () => {
    const scope = deriveExecutionScope('ws-abc', 'child-456', 'parent-123', null);
    const fileName = resolveScopedContextFileName(scope, 'a0000000-0000-0000-0000-000000000001');
    expect(fileName).toBe('child-456--a0000000-0000-0000-0000-000000000001-context.md');
  });

  test('sibling child tickets get different context files for same agent', () => {
    const scope1 = deriveExecutionScope('ws-abc', 'child-111', 'parent-123', null);
    const scope2 = deriveExecutionScope('ws-abc', 'child-222', 'parent-123', null);
    const file1 = resolveScopedContextFileName(scope1, 'code-developer');
    const file2 = resolveScopedContextFileName(scope2, 'code-developer');
    expect(file1).not.toBe(file2);
    expect(file1).toContain('child-111');
    expect(file2).toContain('child-222');
  });

  test('parent handover file is backwards compatible', () => {
    const scope = deriveExecutionScope('ws-abc', 'ticket-123', null, null);
    const fileName = resolveScopedHandoverFileName(scope, 'agent-001', 4, 1);
    expect(fileName).toBe('agent-001_PHASE_4_ROUND_1.md');
  });

  test('child handover file includes scope prefix', () => {
    const scope = deriveExecutionScope('ws-abc', 'child-456', 'parent-123', null);
    const fileName = resolveScopedHandoverFileName(scope, 'agent-001', 4, 1);
    expect(fileName).toBe('child-456--agent-001_PHASE_4_ROUND_1.md');
  });

  test('parent handover prefix is empty (reads all)', () => {
    const scope = deriveExecutionScope('ws-abc', 'ticket-123', null, null);
    const prefix = resolveScopedHandoverPrefix(scope);
    expect(prefix).toBe('');
  });

  test('child handover prefix filters to scope', () => {
    const scope = deriveExecutionScope('ws-abc', 'child-456', 'parent-123', null);
    const prefix = resolveScopedHandoverPrefix(scope);
    expect(prefix).toBe('child-456--');
  });

  test('deriveExecutionScopeId returns empty for parent', () => {
    const scopeId = deriveExecutionScopeId('ticket-123', undefined, undefined);
    expect(scopeId).toBe('');
  });

  test('deriveExecutionScopeId returns child externalId for child ticket', () => {
    const scopeId = deriveExecutionScopeId('child-456', 'parent-123', undefined);
    expect(scopeId).toBe('child-456');
  });

  test('deriveExecutionScopeId returns review scope for review round', () => {
    const scopeId = deriveExecutionScopeId('ticket-123', undefined, 3);
    expect(scopeId).toContain('review-ticket-123-r3');
  });

  test('scope IDs are filesystem-safe (no colons or slashes)', () => {
    const scope = deriveExecutionScope('ws-abc', 'review:ticket:r1', null, 1);
    expect(scope.scopeId).not.toContain(':');
    expect(scope.scopeId).not.toContain('/');
  });
});
