/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Write-gated live proof for fresh build-ticket terminal state.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Harden polling against transient non-JSON auth/gateway responses so the proof
 *                     |               | records them and keeps waiting for the truthful terminal ticket state.
 */

/**
 * @description
 * Creates one real build ticket and waits for a truthful terminal state. This is
 * intentionally gated behind OSHAL_E2E_ALLOW_WRITES because it creates work.
 */
import { test, expect } from './fixtures';
import { ALLOW_WRITES, openCockpit } from './helpers';

type TicketResponse = {
  success?: boolean;
  ticket?: { ticketId?: string; id?: string; status?: string; metadata?: Record<string, unknown> };
  ticketId?: string;
  id?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  error?: string;
};

type HistoryResponse = {
  history?: Array<{
    toStatus?: string;
    to_status?: string;
    changedBy?: string;
    changed_by?: string;
    metadata?: Record<string, unknown>;
  }>;
};

type FetchJsonResult<T> = {
  status: number;
  contentType: string | null;
  json: T | null;
  textStart: string;
};

const TERMINAL = new Set(['complete', 'escalated']);

test('write-gated: fresh build ticket completes or escalates with useful metadata', async ({
  page,
}, testInfo) => {
  test.skip(!ALLOW_WRITES, 'Set OSHAL_E2E_ALLOW_WRITES=1 to create a real verification build ticket.');
  test.setTimeout(900_000);

  await openCockpit(page);

  const title = `OSHAL live build proof ${new Date().toISOString()}`;
  const create = await page.evaluate(async ({ ticketTitle }) => {
    const res = await fetch('/api/v1/tickets', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: ticketTitle,
        description: 'Live gated proof: build pipeline must complete or escalate with useful metadata.',
        ticketType: 'build',
        status: 'approved',
        priority: 'low',
        labels: ['live-e2e', 'fresh-build-proof'],
        submitToSwarm: true,
        metadata: {
          source: 'live-e2e',
          reason: 'fresh_build_terminal_state_proof',
          proofGate: 'wave1-trust-gate',
        },
      }),
    });
    const body = await res.json().catch(async () => ({ error: await res.text() }));
    return { status: res.status, body };
  }, { ticketTitle: title }) as { status: number; body: TicketResponse };

  expect(create.status).toBeGreaterThanOrEqual(200);
  expect(create.status).toBeLessThan(300);
  const ticket = create.body.ticket || create.body;
  const ticketId = ticket.ticketId || ticket.id;
  expect(ticketId, 'created ticket id').toBeTruthy();

  await testInfo.attach('created-build-ticket.json', {
    body: JSON.stringify(create.body, null, 2),
    contentType: 'application/json',
  });

  let latest: TicketResponse = create.body;
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(10_000);
    const poll = await page.evaluate(async ({ id }) => {
      const res = await fetch(`/api/v1/tickets/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
      const text = await res.text();
      let json: TicketResponse | null = null;
      try { json = JSON.parse(text); } catch { /* keep textStart for evidence */ }
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        json,
        textStart: text.slice(0, 240),
      };
    }, { id: ticketId }) as FetchJsonResult<TicketResponse>;

    if (!poll.json) {
      latest = {
        error: `non-json ticket poll: HTTP ${poll.status} ${poll.contentType || ''} ${poll.textStart}`,
      };
      continue;
    }
    latest = poll.json;

    const status = String((latest.ticket || latest).status || '').toLowerCase();
    if (TERMINAL.has(status)) break;
  }

  const latestTicket = latest.ticket || latest;
  const finalStatus = String(latestTicket.status || '').toLowerCase();
  await testInfo.attach('final-build-ticket.json', {
    body: JSON.stringify(latest, null, 2),
    contentType: 'application/json',
  });

  expect(TERMINAL.has(finalStatus), `ticket ${ticketId} terminal status`).toBeTruthy();

  if (finalStatus === 'escalated') {
    const historyPoll = await page.evaluate(async ({ id }) => {
      const res = await fetch(`/api/v1/tickets/${encodeURIComponent(id)}/history`, { credentials: 'same-origin' });
      const text = await res.text();
      let json: HistoryResponse | null = null;
      try { json = JSON.parse(text); } catch { /* keep textStart for evidence */ }
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        json,
        textStart: text.slice(0, 240),
      };
    }, { id: ticketId }) as FetchJsonResult<HistoryResponse>;
    const history = historyPoll.json || { history: [] };
    await testInfo.attach('build-ticket-history.json', {
      body: JSON.stringify(history, null, 2),
      contentType: 'application/json',
    });
    const escalation = (history.history || []).find((entry) =>
      String(entry.toStatus || entry.to_status || '').toLowerCase() === 'escalated',
    );
    const metadata = escalation?.metadata || latestTicket.metadata || {};
    expect(String(metadata.reason || '')).toBeTruthy();
    expect(String(metadata.source || escalation?.changedBy || escalation?.changed_by || '')).toBeTruthy();
  }
});
