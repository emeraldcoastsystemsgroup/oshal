import { describe, expect, it } from 'vitest';
import {
  classifyKnowledgeScope,
  knowledgeDocumentVisible,
} from '../../src/features/memory/services/memory-layer-utils';
import type { KnowledgeMemoryDocument } from '../../src/shared/types';

// Build a valid KnowledgeMemoryDocument with only the fields under test overridden.
function mkDoc(overrides: Partial<KnowledgeMemoryDocument>): KnowledgeMemoryDocument {
  return {
    knowledgeId: '00000000-0000-4000-8000-000000000000',
    collection: 'swarm-knowledge',
    title: 'doc',
    source: 'ingest',
    chunkCount: 1,
    documentCount: 1,
    metadata: {},
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('classifyKnowledgeScope', () => {
  it('an owner makes it private (even when also agent-scoped)', () => {
    expect(classifyKnowledgeScope({ ownerSub: 'u1' })).toBe('private');
    expect(classifyKnowledgeScope({ ownerSub: 'u1', agentId: 'bot-a' })).toBe('private');
  });

  it('an agent (no owner) makes it bot-scoped', () => {
    expect(classifyKnowledgeScope({ agentId: 'bot-a' })).toBe('bot');
  });

  it('neither owner nor agent is general swarm knowledge', () => {
    expect(classifyKnowledgeScope({})).toBe('swarm');
  });
});

describe('knowledgeDocumentVisible (permission scope)', () => {
  const shared = mkDoc({});
  const botShared = mkDoc({ agentId: 'bot-a', collection: 'agent-knowledge-bot-a' });
  const mine = mkDoc({ ownerSub: 'me', collection: 'my-knowledge' });
  const theirs = mkDoc({ ownerSub: 'someone-else', collection: 'my-knowledge' });

  it('an operator sees everything, including another user\'s private docs', () => {
    const op = { visibleTo: { callerSub: 'me', isOperator: true } };
    expect(knowledgeDocumentVisible(shared, op)).toBe(true);
    expect(knowledgeDocumentVisible(botShared, op)).toBe(true);
    expect(knowledgeDocumentVisible(mine, op)).toBe(true);
    expect(knowledgeDocumentVisible(theirs, op)).toBe(true);
  });

  it('a non-operator sees shared + their own, but never another user\'s private doc', () => {
    const user = { visibleTo: { callerSub: 'me', isOperator: false } };
    expect(knowledgeDocumentVisible(shared, user)).toBe(true);
    expect(knowledgeDocumentVisible(botShared, user)).toBe(true);
    expect(knowledgeDocumentVisible(mine, user)).toBe(true);
    expect(knowledgeDocumentVisible(theirs, user)).toBe(false); // the isolation boundary
  });

  it('no permission scope means no owner filtering (internal/catalog use)', () => {
    expect(knowledgeDocumentVisible(theirs, {})).toBe(true);
  });

  it('the agent filter excludes docs for other bots regardless of permission', () => {
    const opForBotB = { agentId: 'bot-b', visibleTo: { callerSub: 'me', isOperator: true } };
    expect(knowledgeDocumentVisible(botShared, opForBotB)).toBe(false);
    expect(knowledgeDocumentVisible(mkDoc({ agentId: 'bot-b' }), opForBotB)).toBe(true);
  });
});
