/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | The LinkedIn queue binding turns a worker result into an owner-scoped graded pending-approval draft with citations, and refuses a forged queue ticket before producing a prompt. Branch logic over a pool double; the Postgres boundary is tests/unit/linkedin-content-queue-postgres.spec.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | The binding writes the draft id and citations back onto the source ticket (fresh draft and retried dispatch alike), refuses to write onto a ticket owned by someone else or of another type, and refuses a workflow registered without pipeline manifest-worker - the Social 1.5.0 shape that failed every installed ticket.
 */
import { describe, expect, it, afterEach } from 'vitest';
import type { Pool } from 'pg';
import type { InternalTicket } from '@/entities/ticket';
import { bindLinkedInContentWorker, LINKEDIN_CONTENT_QUEUE_AGENT_ID, LINKEDIN_CONTENT_QUEUE_WORKFLOW } from '@/app/linkedin-content-queue-workflow';
import { LINKEDIN_TICKET_PROVENANCE_KEY, type LinkedInTicketWriter } from '@/app/linkedin-content-ticket-provenance';

const OWNER = 'owner-linkedin-queue';
const TICKET = '11111111-1111-4111-8111-111111111111';

function poolDouble(existing = false) {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const row = {
    id: 7, user_sub: OWNER, topic: 'release notes', goal: 'share the lesson', tone: 'credible',
    source_url: 'https://example.test/release', source_citations: ['https://example.test/release'],
    source_ticket_id: TICKET, body: 'A grounded post', score: 82, dimensions: {}, judge_mode: 'lexical-fallback',
    rationale: 'bounded test grade', refined: false, state: 'pending-approval', scheduled_for: null,
    publish_error: null, published_post_id: null, publish_params_hash: null, created_at: 'now', updated_at: 'now',
  };
  const pool = {
    query: async (text: string, params?: unknown[]) => {
      queries.push({ text, params });
      if (/SELECT .*source_ticket_id=\$2/i.test(text)) return { rows: existing ? [row] : [] };
      if (/INSERT INTO social_content_drafts/i.test(text)) return { rows: [row] };
      if (/UPDATE social_content_drafts/i.test(text)) return { rows: [row] };
      return { rows: [] };
    },
  };
  return { pool: pool as unknown as Pool, queries };
}

/** An in-memory ticket service holding the one queue ticket; records every metadata write. */
function ticketsDouble(owner = OWNER, ticketType: string = LINKEDIN_CONTENT_QUEUE_WORKFLOW) {
  const writes: Array<Record<string, unknown>> = [];
  let metadata: Record<string, unknown> = { source: 'linkedin-content-queue' };
  const tickets = {
    getTicket: async (id: string) => (id === TICKET ? { ticketId: TICKET, ownerSub: owner, ticketType, metadata } : null),
    updateTicket: async (_id: string, updates: { metadata?: Record<string, unknown> }) => {
      metadata = updates.metadata ?? metadata;
      writes.push(metadata);
    },
  } as unknown as LinkedInTicketWriter;
  return { tickets, writes };
}

const workflow = { ticketType: LINKEDIN_CONTENT_QUEUE_WORKFLOW, pipeline: 'manifest-worker', workerBot: 'social-writer', name: 'LinkedIn Content Assistant' };
const ticket = {
  ticketId: TICKET, ticketType: LINKEDIN_CONTENT_QUEUE_WORKFLOW, title: 'LinkedIn post: release notes', description: 'A bounded ticket request',
  ownerSub: OWNER, metadata: {
    source: 'linkedin-content-queue', topic: 'release notes', goal: 'share the lesson', tone: 'credible',
    sourceUrl: 'https://example.test/release', sourceCitations: ['https://example.test/release', 'https://example.test/second'],
  },
} as unknown as InternalTicket;
const judge = { processMessage: async () => ({ success: true, response: '' }) } as never;

describe('LinkedIn content queue binding', () => {
  afterEach(() => { delete process.env.FORCE_LLM_PROVIDER; });

  it('turns the worker result into an owner-scoped graded pending-approval draft with citations', async () => {
    process.env.FORCE_LLM_PROVIDER = 'noop';
    const { pool, queries } = poolDouble();
    const { tickets } = ticketsDouble();
    const binding = (await bindLinkedInContentWorker(pool, judge, tickets)(ticket, workflow as never, LINKEDIN_CONTENT_QUEUE_AGENT_ID))!;
    expect(binding.reasonOnly).toBe(true);
    expect(binding.prompt).toContain('https://example.test/release');
    await binding.complete('A grounded post');
    const insert = queries.find((query) => /INSERT INTO social_content_drafts/i.test(query.text));
    expect(insert?.params?.[0]).toBe(OWNER);
    expect(insert?.params?.[6]).toBe(TICKET);
    expect(JSON.parse(String(insert?.params?.[5]))).toEqual(['https://example.test/release', 'https://example.test/second']);
  });

  it('writes the draft id back onto the source ticket, merging rather than replacing its metadata', async () => {
    process.env.FORCE_LLM_PROVIDER = 'noop';
    const { pool } = poolDouble();
    const { tickets, writes } = ticketsDouble();
    const binding = (await bindLinkedInContentWorker(pool, judge, tickets)(ticket, workflow as never, LINKEDIN_CONTENT_QUEUE_AGENT_ID))!;
    await binding.complete('A grounded post');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ source: 'linkedin-content-queue', [LINKEDIN_TICKET_PROVENANCE_KEY]: { draftId: 7 } });
  });

  it('a retried dispatch reuses the persisted draft and still writes its id to the ticket', async () => {
    const { pool, queries } = poolDouble(true);
    const { tickets, writes } = ticketsDouble();
    const binding = (await bindLinkedInContentWorker(pool, judge, tickets)(ticket, workflow as never, LINKEDIN_CONTENT_QUEUE_AGENT_ID))!;
    expect(binding.alreadyComplete).toBe(true);
    expect(queries.some((query) => /INSERT INTO social_content_drafts/i.test(query.text))).toBe(false);
    expect(writes[0]).toMatchObject({ [LINKEDIN_TICKET_PROVENANCE_KEY]: { draftId: 7 } });
  });

  it('refuses to write provenance onto a ticket owned by someone else or of another type', async () => {
    process.env.FORCE_LLM_PROVIDER = 'noop';
    for (const foreign of [ticketsDouble('someone-else'), ticketsDouble(OWNER, 'task')]) {
      const binding = (await bindLinkedInContentWorker(poolDouble().pool, judge, foreign.tickets)(ticket, workflow as never, LINKEDIN_CONTENT_QUEUE_AGENT_ID))!;
      await expect(binding.complete('A grounded post')).rejects.toThrow(/provenance refused/);
      expect(foreign.writes).toEqual([]);
    }
  });

  it('refuses a forged queue ticket before producing a prompt', async () => {
    const { pool } = poolDouble();
    await expect(bindLinkedInContentWorker(pool, { processMessage: async () => ({ success: true }) } as never, ticketsDouble().tickets)(
      { ...ticket, metadata: { source: 'linkedin-content-queue', providerIntent: 'forged' } } as never,
      workflow as never,
      LINKEDIN_CONTENT_QUEUE_AGENT_ID,
    )).rejects.toThrow(/Invalid bound LinkedIn content ticket/);
  });

  it('refuses a workflow registered without pipeline manifest-worker (the Social 1.5.0 shape)', async () => {
    const { pool, queries } = poolDouble();
    const { pipeline: _omitted, ...withoutPipeline } = workflow;
    await expect(bindLinkedInContentWorker(pool, judge, ticketsDouble().tickets)(ticket, withoutPipeline as never, LINKEDIN_CONTENT_QUEUE_AGENT_ID))
      .rejects.toThrow(/Invalid bound LinkedIn content ticket/);
    expect(queries).toEqual([]);
  });
});
