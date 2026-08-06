/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added focused project-manager intake behavior coverage.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Prove the authenticated owner is copied to both canonical ticket and chat-task rows so RLS ownership agrees with the request identity.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveProjectManagerTicketExecutionContext } from '../../src/features/chat-orchestration/services/project-manager-ticket-intake';

describe('project-manager ticket intake', () => {
  it('creates approved work so QueueManager can pick it up immediately', async () => {
    const createdTicket = {
      ticketId: '11111111-1111-4111-8111-111111111111',
      title: 'Build a validation dashboard',
      status: 'approved',
      metadata: { queueId: 'default', queueName: 'Default' },
    };
    const taskStore = {
      create: vi.fn(async () => ({ taskId: 'pm-task-1' })),
    };
    const ticketService = {
      createTicket: vi.fn(async (input: Record<string, unknown>) => ({
        ...createdTicket,
        title: input.title,
        status: input.status,
        metadata: input.metadata,
      })),
      linkTask: vi.fn(async () => {}),
    };

    const result = await resolveProjectManagerTicketExecutionContext(
      { taskStore, ticketService } as never,
      {
        requestedTaskId: 'requested-task',
        resolvedAgentId: 'a0000000-0000-0000-0000-000000000001',
        source: 'swarmbot-chat',
        text: 'please create a ticket to build a validation dashboard',
        ownerSub: 'auth0|pm-owner',
      },
    );

    expect(ticketService.createTicket).toHaveBeenCalledWith(expect.objectContaining({
      status: 'approved',
      ticketType: 'build',
      ownerSub: 'auth0|pm-owner',
    }));
    expect(taskStore.create).toHaveBeenCalledWith(expect.objectContaining({ ownerSub: 'auth0|pm-owner' }));
    expect(result.ticketCreated).toBe(true);
    expect(result.ticketStatus).toBe('approved');
    expect(result.taskId).toBe('pm-task-1');
  });
});
