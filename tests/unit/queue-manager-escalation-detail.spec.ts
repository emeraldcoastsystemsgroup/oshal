/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Build-escalation debuggability (eval-wall 2026-06-22): proves summarizeFailedWorkItems / extractWorkItemError turn a pipeline_work_items_failed escalation from a bare count into per-item "why it failed" detail, bounded and secret-free.
 */

import { describe, expect, it } from 'vitest';
import {
  extractWorkItemError,
  summarizeFailedWorkItems,
} from '../../src/features/swarm-orchestration/services/queue-manager-service';

describe('build-escalation failure detail', () => {
  describe('extractWorkItemError', () => {
    it('pulls a string executionOutput directly', () => {
      expect(extractWorkItemError({ executionOutput: 'Cline exited with code 1' }))
        .toBe('Cline exited with code 1');
    });

    it('pulls a known error field from an object executionOutput', () => {
      expect(extractWorkItemError({ executionOutput: { status: 'failed', error: 'patch did not apply' } }))
        .toBe('patch did not apply');
      expect(extractWorkItemError({ executionOutput: { stderr: 'ENOENT: no such file' } }))
        .toBe('ENOENT: no such file');
    });

    it('falls back to metadata when executionOutput has nothing usable', () => {
      expect(extractWorkItemError({ executionOutput: { status: 'failed' }, metadata: { failureReason: 'agent offline' } }))
        .toBe('agent offline');
    });

    it('returns empty when no known error field is present (never dumps raw objects)', () => {
      expect(extractWorkItemError({ executionOutput: { tokens: 42, prompt: 'secret system prompt' } })).toBe('');
      expect(extractWorkItemError({})).toBe('');
    });

    it('caps very long errors so a history row stays small', () => {
      const long = 'x'.repeat(500);
      const out = extractWorkItemError({ executionOutput: long });
      expect(out.length).toBeLessThanOrEqual(301); // 300 + ellipsis
      expect(out.endsWith('…')).toBe(true);
    });
  });

  describe('summarizeFailedWorkItems', () => {
    it('summarizes only failed items with title + agent + error', () => {
      const summaries = summarizeFailedWorkItems([
        { status: 'completed', title: 'ok', unitId: 'u1' },
        {
          status: 'failed',
          unitId: 'u2',
          title: 'Write validator',
          assignedAgentId: 'agent-code-developer',
          executionOutput: { error: 'assertion failed in generated tests' },
        },
      ]);

      expect(summaries).toEqual([
        {
          unitId: 'u2',
          title: 'Write validator',
          assignedAgentId: 'agent-code-developer',
          error: 'assertion failed in generated tests',
        },
      ]);
    });

    it('omits absent optional fields rather than emitting undefined', () => {
      const summaries = summarizeFailedWorkItems([{ status: 'failed', unitId: 'u3' }]);
      expect(summaries).toEqual([{ unitId: 'u3' }]);
    });

    it('bounds the embedded set so an escalation row cannot balloon', () => {
      const many = Array.from({ length: 12 }, (_, i) => ({
        status: 'failed',
        unitId: `u${i}`,
        executionOutput: `err ${i}`,
      }));
      const summaries = summarizeFailedWorkItems(many);
      expect(summaries).toHaveLength(5);
      expect(summaries[0]).toMatchObject({ unitId: 'u0', error: 'err 0' });
    });

    it('returns empty when nothing failed', () => {
      expect(summarizeFailedWorkItems([{ status: 'completed' }, { status: 'pending' }])).toEqual([]);
    });
  });
});
