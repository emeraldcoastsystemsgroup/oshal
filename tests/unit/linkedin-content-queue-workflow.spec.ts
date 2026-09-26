import { describe, expect, it, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { bindLinkedInContentWorker, LINKEDIN_CONTENT_QUEUE_AGENT_ID, LINKEDIN_CONTENT_QUEUE_WORKFLOW } from '@/app/linkedin-content-queue-workflow';

const OWNER = 'owner-linkedin-queue';
const TICKET = '11111111-1111-4111-8111-111111111111';

function poolDouble() {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const row = {
    id: 7, user_sub: OWNER, topic: 'release notes', goal: 'share the lesson', tone: 'credible',
    source_url: 'https://example.test/release', source_citations: ['https://example.test/release'],
    source_ticket_id: TICKET, body: 'A grounded post', score: 82, dimensions: {}, judge_mode: 'lexical-fallback',
    rationale: 'bounded test grade', refined: false, state: 'pending-approval', scheduled_for: null,
    publish_error: null, created_at: 'now', updated_at: 'now',
  };
  const pool = {
    query: async (text: string, params?: unknown[]) => {
      queries.push({ text, params });
      if (/SELECT .*source_ticket_id/i.test(text)) return { rows: [] };
      if (/INSERT INTO social_content_drafts/i.test(text)) return { rows: [row] };
      if (/UPDATE social_content_drafts/i.test(text)) return { rows: [row] };
      return { rows: [] };
    },
  };
  return { pool: pool as unknown as Pool, queries };
}

const workflow = { ticketType: LINKEDIN_CONTENT_QUEUE_WORKFLOW, pipeline: 'manifest-worker', workerBot: 'social-writer', name: 'LinkedIn Content Assistant' };
const ticket = {
  ticketId: TICKET, ticketType: LINKEDIN_CONTENT_QUEUE_WORKFLOW, title: 'LinkedIn post: release notes', description: 'A bounded ticket request',
  ownerSub: OWNER, metadata: {
    source: 'linkedin-content-queue', topic: 'release notes', goal: 'share the lesson', tone: 'credible',
    sourceUrl: 'https://example.test/release', sourceCitations: ['https://example.test/release', 'https://example.test/second'],
  },
} as never;

describe('LinkedIn content queue binding', () => {
  afterEach(() => { delete process.env.FORCE_LLM_PROVIDER; });

  it('turns the worker result into an owner-scoped graded pending-approval draft with citations', async () => {
    process.env.FORCE_LLM_PROVIDER = 'noop';
    const { pool, queries } = poolDouble();
    const binding = (await bindLinkedInContentWorker(pool, { processMessage: async () => ({ success: true, response: '' }) } as never)(ticket, workflow as never, LINKEDIN_CONTENT_QUEUE_AGENT_ID))!;
    expect(binding.reasonOnly).toBe(true);
    expect(binding.prompt).toContain('https://example.test/release');
    await binding.complete('A grounded post');
    const insert = queries.find((query) => /INSERT INTO social_content_drafts/i.test(query.text));
    expect(insert?.params?.[0]).toBe(OWNER);
    expect(insert?.params?.[6]).toBe(TICKET);
    expect(JSON.parse(String(insert?.params?.[5]))).toEqual(['https://example.test/release', 'https://example.test/second']);
  });

  it('refuses a forged queue ticket before producing a prompt', async () => {
    const { pool } = poolDouble();
    await expect(bindLinkedInContentWorker(pool, { processMessage: async () => ({ success: true }) } as never)(
      { ...ticket, metadata: { source: 'linkedin-content-queue', providerIntent: 'forged' } } as never,
      workflow as never,
      LINKEDIN_CONTENT_QUEUE_AGENT_ID,
    )).rejects.toThrow(/Invalid bound LinkedIn content ticket/);
  });
});

