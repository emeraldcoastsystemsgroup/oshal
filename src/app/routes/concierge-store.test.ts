import { describe, it, expect } from 'vitest';
import { ConciergeStore, isUuid } from './concierge-store';

const UUID = '11111111-2222-3333-4444-555555555555';

/** A fake pg Pool: returns queued responses in call order and records every (sql, params). */
function fakePool(responses: Array<{ rows: any[] }>) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  let i = 0;
  const pool = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return responses[i++] ?? { rows: [] };
    },
  };
  return { pool: pool as never, calls };
}

describe('isUuid', () => {
  it('accepts a valid uuid, rejects junk', () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(123 as never)).toBe(false);
  });
});

describe('ConciergeStore — construction', () => {
  it('rejects an unknown table prefix (guards SQL identifier interpolation)', () => {
    const { pool } = fakePool([]);
    expect(() => new ConciergeStore(pool, 'evil; DROP TABLE')).toThrow(/unknown prefix/);
    expect(() => new ConciergeStore(pool, 'spotify')).not.toThrow();
  });
});

describe('ConciergeStore.ensureConversation — IDOR guard', () => {
  it('returns the given id when the caller OWNS it (one ownership check, no insert)', async () => {
    const { pool, calls } = fakePool([{ rows: [{ '?column?': 1 }] }]); // ownership query → owned
    const store = new ConciergeStore(pool, 'movies');
    const id = await store.ensureConversation('user-1', UUID, 'hi');
    expect(id).toBe(UUID);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('SELECT 1 FROM movies_conversations');
    expect(calls[0].params).toEqual([UUID, 'user-1']);
  });

  it('creates a fresh conversation when the id is NOT owned (no cross-user access)', async () => {
    const { pool, calls } = fakePool([{ rows: [] }, { rows: [{ conversation_id: 'fresh' }] }]);
    const store = new ConciergeStore(pool, 'movies');
    const id = await store.ensureConversation('user-1', UUID, 'a long title to be sliced');
    expect(id).toBe('fresh');
    expect(calls[0].sql).toContain('SELECT 1 FROM movies_conversations'); // ownership check ran
    expect(calls[1].sql).toContain('INSERT INTO movies_conversations');
  });

  it('skips the ownership check entirely for a non-uuid id (goes straight to insert)', async () => {
    const { pool, calls } = fakePool([{ rows: [{ conversation_id: 'new' }] }]);
    const store = new ConciergeStore(pool, 'eats');
    const id = await store.ensureConversation('u', 'garbage-id', 'title');
    expect(id).toBe('new');
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('INSERT INTO eats_conversations');
  });
});

describe('ConciergeStore.resume — durable by-id, else latest', () => {
  it('resumes the owned id and returns its messages', async () => {
    const { pool, calls } = fakePool([
      { rows: [{ conversation_id: UUID }] },                       // by-id lookup (owned)
      { rows: [{ role: 'user', content: 'hey' }, { role: 'assistant', content: 'hi' }] },
    ]);
    const store = new ConciergeStore(pool, 'spotify');
    const out = await store.resume('u', UUID);
    expect(out.conversationId).toBe(UUID);
    expect(out.messages).toHaveLength(2);
    expect(calls[0].sql).toContain('WHERE conversation_id = $1 AND user_sub = $2');
  });

  it('falls back to the latest thread when no valid id is supplied', async () => {
    const { pool, calls } = fakePool([
      { rows: [{ conversation_id: 'latest' }] }, // latest lookup
      { rows: [] },                              // messages
    ]);
    const store = new ConciergeStore(pool, 'rides');
    const out = await store.resume('u', '');
    expect(out.conversationId).toBe('latest');
    expect(calls[0].sql).toContain('ORDER BY updated_at DESC LIMIT 1'); // went straight to latest
  });

  it('returns empty when the user has no conversations', async () => {
    const { pool } = fakePool([{ rows: [] }]);
    const store = new ConciergeStore(pool, 'rides');
    expect(await store.resume('u')).toEqual({ conversationId: null, messages: [] });
  });
});

describe('ConciergeStore — feedback is optional (rides has no feedback table)', () => {
  it('loadNotes/saveNote are no-ops and touch NO table when hasFeedback=false', async () => {
    const { pool, calls } = fakePool([]);
    const store = new ConciergeStore(pool, 'rides', false);
    expect(await store.loadNotes('u')).toEqual([]);
    await store.saveNote('u', 'a pref');
    expect(calls).toHaveLength(0); // never queried a (nonexistent) rides_feedback table
  });

  it('saveNote writes to <prefix>_feedback when the app has one', async () => {
    const { pool, calls } = fakePool([{ rows: [] }]);
    const store = new ConciergeStore(pool, 'eats'); // hasFeedback defaults true
    await store.saveNote('u', 'likes tacos');
    expect(calls[0].sql).toContain('INSERT INTO eats_feedback');
  });
});
