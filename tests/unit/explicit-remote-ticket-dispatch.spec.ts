import { describe, expect, test } from 'vitest';
import { explicitRemoteClientId } from '@/app/explicit-remote-ticket-dispatch';

const base = {
  ticketId: 'ticket-1',
  title: 'Run on desktop',
  description: '',
  metadata: {},
} as never;

describe('explicit remote ticket routing', () => {
  test('extracts an exact remote client id from the ticket description', () => {
    expect(explicitRemoteClientId({
      ...base,
      description: 'Use client oshal-chat-0ce849b6-8b95-4cf5-9223-ce22d638f1c9 for this work',
    })).toBe('oshal-chat-0ce849b6-8b95-4cf5-9223-ce22d638f1c9');
  });

  test('structured target wins over free text', () => {
    expect(explicitRemoteClientId({
      ...base,
      description: 'Use oshal-chat-11111111-1111-1111-1111-111111111111',
      metadata: { targetRemoteClientId: 'oshal-chat-22222222-2222-2222-2222-222222222222' },
    })).toBe('oshal-chat-22222222-2222-2222-2222-222222222222');
  });

  test('ordinary generic tasks remain eligible for normal bidding', () => {
    expect(explicitRemoteClientId({ ...base, description: 'Summarize my latest email' })).toBeNull();
  });
});
