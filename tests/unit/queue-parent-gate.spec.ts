import { describe, expect, it } from 'vitest';
import type { OshalTicketState } from '../../src/entities/ticket';
import { terminalChildStatusForParentState } from '../../src/features/swarm-orchestration/services/queue-manager-service';

describe('queue parent gate', () => {
  it('parks approved children when their parent is terminal', () => {
    expect(terminalChildStatusForParentState('escalated')).toBe('escalated');
    expect(terminalChildStatusForParentState('cancelled')).toBe('cancelled');
  });

  it('leaves non-terminal parent states for normal dispatch gating', () => {
    const nonTerminalParentStates: OshalTicketState[] = [
      'backlog',
      'approved',
      'in_process_discovery',
      'in_process_design',
      'in_process_build',
      'approval_required',
      'customer_action',
      'complete',
      'paused',
    ];

    for (const parentStatus of nonTerminalParentStates) {
      expect(terminalChildStatusForParentState(parentStatus)).toBeNull();
    }
  });
});
