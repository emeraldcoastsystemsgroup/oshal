import { describe, expect, it } from 'vitest';
import { applyDerivedQueueMetadata, TICKET_TYPE_TO_QUEUE_ID } from '../../src/entities/ticket/queue-classification';
import { TicketTypeSchema } from '../../src/entities/ticket/types';

describe('ticket type contracts', () => {
  it('accepts task as the Jarvis delegated-work ticket type', () => {
    expect(TicketTypeSchema.safeParse('task').success).toBe(true);
  });

  it('accepts every mapped app ticket type plus future manifest ticket types', () => {
    for (const ticketType of Object.keys(TICKET_TYPE_TO_QUEUE_ID)) {
      expect(TicketTypeSchema.safeParse(ticketType).success).toBe(true);
    }
    expect(TicketTypeSchema.safeParse('trading-decision').success).toBe(true);
    expect(TicketTypeSchema.safeParse('workflow-studio-published-type').success).toBe(true);
    expect(TicketTypeSchema.safeParse('').success).toBe(false);
  });

  it('classifies task tickets into the Jarvis queue', () => {
    const metadata = applyDerivedQueueMetadata(
      { source: 'jarvis' },
      { ticketType: 'task', metadata: { source: 'jarvis' } },
    );

    expect(metadata).toMatchObject({
      source: 'jarvis',
      queueId: 'jarvis',
      queueName: 'Jarvis',
    });
  });

  it('classifies trading decisions into the Intelligent Trades queue', () => {
    const metadata = applyDerivedQueueMetadata(
      { source: 'trading-trigger' },
      { ticketType: 'trading-decision', metadata: { source: 'trading-trigger' } },
    );

    expect(metadata).toMatchObject({
      source: 'trading-trigger',
      queueId: 'intelligent-trades',
      queueName: 'Intelligent Trades',
    });
  });
});
