/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the LinkedIn queue live-acceptance case's own logic over a doubled HTTP transport, an in-memory ticket port and a recording statement port: a pending-approval draft naming the ticket with its citation, plus an unconfirmed publish refused 428 = pass, and the case never approves and never sends a confirmation; the draft is rejected and deleted, the ticket re-read and deleted; a ticket that dies without a draft = fail with the ticket still removed; a draft the worker writes after the ticket is gone is caught and removed; a ticket that does not revalidate as the fixture is never deleted (red cleanup); an unmounted queue writes nothing. The worker, draft store and publish gate are proven by linkedin-content-queue-postgres.spec.ts; the real companion is `node scripts/operations/live-acceptance.js linkedin` on the box.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { fakeApi, fakeClock, type FakeHandler } from '../fixtures/live-acceptance-fake-api';

const requireCjs = createRequire(import.meta.url);
const linkedin = requireCjs('../../scripts/lib/live-acceptance-linkedin.js');

const OWNER = 'fixture|linkedin-owner';
const TAG = 'testlab-live-linkedin-0a1b2c3d';
const TICKET = '7e57ab1e-0000-4000-8000-000000000001';

interface Draft { id: number; state: string; sourceTicketId: string; sourceCitations: string[]; body: string; score: number }

function world(options: { draftAfterPolls?: number; ticketStatus?: string; lateDraft?: boolean; publishStatus?: number; topic?: string; over?: Record<string, FakeHandler> } = {}) {
  const fixture = linkedin.createFixture(TAG);
  const drafts: Draft[] = [];
  const tickets = new Map<string, Record<string, unknown>>();
  let polls = 0;
  let made = 0;
  const makeDraft = () => made++ < 1 && drafts.push({ id: 41, state: 'pending-approval', sourceTicketId: TICKET, sourceCitations: fixture.sourceCitations, body: 'A reviewed post.', score: 8.4 });
  const api = fakeApi({
    'POST /api/social/linkedin-content-queue': ({ body }) => {
      tickets.set(TICKET, { ticketId: TICKET, ownerSub: OWNER, ticketType: 'linkedin-content-post', status: 'approved', metadata: { topic: options.topic ?? (body as { topic: string }).topic } });
      return { status: 202, json: { ticket: { ticketId: TICKET, ticketType: 'linkedin-content-post', status: 'approved' } } };
    },
    'GET /api/linkedin-assistant/drafts': () => {
      polls += 1;
      if (!drafts.length && options.draftAfterPolls !== undefined && polls >= options.draftAfterPolls) makeDraft();
      return { status: 200, json: { drafts } };
    },
    'POST /api/linkedin-assistant/drafts/:id/publish': ({ body }) => ({ status: (body as { confirm?: boolean }).confirm ? 200 : (options.publishStatus ?? 428) }),
    'POST /api/linkedin-assistant/drafts/:id/reject': ({ params }) => { const d = drafts.find((x) => String(x.id) === params.id); if (d) d.state = 'rejected'; return { status: 200 }; },
    ...(options.over || {}),
  });
  const statements: Array<{ name: string; params: unknown[] }> = [];
  const sql = async (name: string, params: unknown[]) => {
    statements.push({ name, params });
    if (name === 'linkedin.draft-delete') drafts.splice(0);
    return { rows: [{ drafts: drafts.length }] };
  };
  const ticketPort = {
    get: async (id: string) => {
      const ticket = tickets.get(id) || null;
      if (ticket && options.ticketStatus) ticket.status = options.ticketStatus;
      return ticket;
    },
    delete: async (id: string) => { tickets.delete(id); if (options.lateDraft) makeDraft(); },
  };
  return { api, sql, statements, tickets, drafts, ports: { api: api.api, sql, tickets: ticketPort, ownerSub: OWNER, ...fakeClock() } };
}

describe('LinkedIn queue live acceptance', () => {
  it('passes on a cited pending-approval draft and a 428 gate, and never approves or confirms', async () => {
    const w = world({ draftAfterPolls: 3 });
    const result = await linkedin.run(w.ports, { tag: TAG });
    expect(result.state).toBe('pass');
    expect(result.detail).toContain(`draft 41 is pending-approval, scored 8.4, names ticket ${TICKET} and carries its 1 citation(s)`);
    expect(result.detail).toContain('refused 428');
    const filed = w.api.calls.find((c) => c.path === '/api/social/linkedin-content-queue')!.body as { topic: string; sourceCitations: string[] };
    expect(filed.topic.startsWith(TAG)).toBe(true);
    expect(filed.sourceCitations).toEqual([`https://oshal.example.com/testlab/${TAG}`]);
    expect(w.api.calls.some((c) => c.path.endsWith('/approve'))).toBe(false);
    expect(w.api.calls.filter((c) => c.path.endsWith('/publish')).map((c) => c.body)).toEqual([{}]);
    expect(w.statements.map((s) => s.name)).toEqual(expect.arrayContaining(['linkedin.draft-delete', 'linkedin.draft-residue']));
    expect(w.statements[0].params).toEqual([OWNER, TICKET]);
    expect(w.tickets.size).toBe(0);
    expect(result.cleanup.removed).toEqual(expect.arrayContaining([`ticket ${TICKET}`, 'linkedin-draft 41']));
    expect(result.cleanup.outstanding).toEqual([]);
  });

  it('fails a ticket that dies without a draft and still removes the ticket', async () => {
    const w = world({ ticketStatus: 'dead_letter' });
    const result = await linkedin.run(w.ports, { tag: TAG });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('(ticket dead_letter)');
    expect(w.tickets.size).toBe(0);
    expect(result.cleanup.removed).toEqual([`ticket ${TICKET}`]);
  });

  it('catches a draft the worker writes after the ticket is deleted', async () => {
    const w = world({ ticketStatus: 'failed', lateDraft: true });
    const result = await linkedin.run(w.ports, { tag: TAG });
    expect(w.drafts).toEqual([]);
    expect(result.cleanup.removed).toEqual(expect.arrayContaining(['linkedin-draft 41']));
    expect(result.cleanup.outstanding).toEqual([]);
  });

  it('fails when an unconfirmed publish is not refused', async () => {
    const result = await linkedin.run(world({ draftAfterPolls: 1, publishStatus: 409 }).ports, { tag: TAG });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('answered HTTP 409, not 428');
  });

  it('never deletes a ticket that does not revalidate as this run\'s fixture', async () => {
    const w = world({ draftAfterPolls: 1, topic: 'someone else\'s post' });
    const result = await linkedin.run(w.ports, { tag: TAG });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('did not revalidate as this run\'s fixture; not deleted');
    expect(w.tickets.size).toBe(1);
  });

  it('writes nothing when the queue route is not mounted', async () => {
    const w = world({ over: { 'POST /api/social/linkedin-content-queue': () => ({ status: 404 }) } });
    const result = await linkedin.run(w.ports, { tag: TAG });
    expect(result.state).toBe('unavailable');
    expect(w.statements).toEqual([]);
  });
});
