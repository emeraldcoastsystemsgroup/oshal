import { describe, expect, it } from 'vitest';
import { linkedChatTaskStatusForTerminalTicket } from '../../src/features/ticketing/services/ticket-store-postgres';

describe('linked chat task terminal sync', () => {
  it('maps terminal ticket states to closed chat task states', () => {
    expect(linkedChatTaskStatusForTerminalTicket('complete')).toBe('completed');
    expect(linkedChatTaskStatusForTerminalTicket('escalated')).toBe('failed');
    expect(linkedChatTaskStatusForTerminalTicket('cancelled')).toBe('cancelled');
  });

  it('leaves non-terminal ticket states alone', () => {
    expect(linkedChatTaskStatusForTerminalTicket('backlog')).toBeNull();
    expect(linkedChatTaskStatusForTerminalTicket('approved')).toBeNull();
    expect(linkedChatTaskStatusForTerminalTicket('in_process_build')).toBeNull();
  });
});
