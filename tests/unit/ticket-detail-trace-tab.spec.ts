/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Run Trace ticket-detail sub-screen: the tab is registered for every process, the embedded URL is EXACTLY the route the run-trace surface serves (/api/trace/:ticketId.html), a ticket with spans gets the iframe, and a 404 / a transport failure / a non-UUID id each get an honest empty state instead of a broken frame. Would go red if the tab were dropped from the catalog, the route shape drifted, or the renderer started iframing a trace it never confirmed exists.
 */

import { describe, expect, it } from 'vitest';
import { TICKET_DETAIL_TABS, resolveDetailTabs } from '../../src/pages/cockpit/js/views/ticket-detail-tabs.js';
import {
  buildTraceTabMarkup,
  readTraceTicketId,
  renderTraceTab,
  traceEmbedUrl,
} from '../../src/pages/cockpit/js/views/ticket-view-trace-renderer.js';

const TICKET_ID = '0813978b-1f06-4148-810f-1f71a7fbc505';

/** The detail body the renderer writes into (innerHTML is all it touches). */
function fakeBody(): { innerHTML: string } {
  return { innerHTML: '' };
}

/** A fetch stub answering the trace JSON probe with the given status/payload. */
function fakeFetch(status: number, payload?: unknown): { calls: string[]; impl: (url: string) => Promise<unknown> } {
  const calls: string[] = [];
  return {
    calls,
    impl: async (url: string) => {
      calls.push(url);
      return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => payload,
      };
    },
  };
}

describe('ticket detail — Run Trace sub-screen registration', () => {
  it('the trace tab is in the catalog and shows for every process (a trace is process-agnostic)', () => {
    expect(TICKET_DETAIL_TABS.map((t) => t.key)).toContain('trace');
    for (const process of ['incident', 'build', 'eats', '', 'world']) {
      expect(resolveDetailTabs(process).map((t) => t.key)).toContain('trace');
    }
  });

  it('the embed URL is exactly the rendered-waterfall route, and a non-UUID id has none', () => {
    // Drift guard on the contract with src/app/routes/trace-routes.ts — that route matches
    // '/:ticketId.html' and TraceService rejects anything that is not a canonical UUID.
    expect(traceEmbedUrl(TICKET_ID)).toBe(`/api/trace/${TICKET_ID}.html`);
    expect(traceEmbedUrl('42')).toBe('');
    expect(traceEmbedUrl('')).toBe('');
    expect(readTraceTicketId({ id: TICKET_ID })).toBe(TICKET_ID);
    expect(readTraceTicketId({ ticket_id: TICKET_ID, id: '17' })).toBe(TICKET_ID);
    expect(readTraceTicketId({ id: '17', sequenceId: 17 })).toBe('');
  });
});

describe('ticket detail — Run Trace rendering', () => {
  it('embeds the waterfall (and a full-view link) once the read model reports spans', async () => {
    const body = fakeBody();
    const fetcher = fakeFetch(200, { success: true, trace: { spans: [{ id: 's1' }, { id: 's2' }] } });
    await renderTraceTab(body, { id: TICKET_ID }, { fetchImpl: fetcher.impl });

    expect(fetcher.calls).toEqual([`/api/trace/${TICKET_ID}`]);
    expect(body.innerHTML).toContain(`<iframe title="Run trace waterfall" src="/api/trace/${TICKET_ID}.html"`);
    expect(body.innerHTML).toContain('2 spans');
    expect(body.innerHTML).toContain('Open full waterfall');
  });

  it('a ticket with no trace shows an empty state and NO iframe (never the API 404 page in a frame)', async () => {
    const body = fakeBody();
    const fetcher = fakeFetch(404);
    await renderTraceTab(body, { id: TICKET_ID }, { fetchImpl: fetcher.impl });

    expect(body.innerHTML).not.toContain('<iframe');
    expect(body.innerHTML).toContain('No run trace recorded yet');
  });

  it('an empty-span trace is treated as no trace, not as a blank waterfall', async () => {
    const body = fakeBody();
    const fetcher = fakeFetch(200, { success: true, trace: { spans: [] } });
    await renderTraceTab(body, { id: TICKET_ID }, { fetchImpl: fetcher.impl });
    expect(body.innerHTML).toContain('No run trace recorded yet');
    expect(body.innerHTML).not.toContain('<iframe');
  });

  it('a transport failure degrades to an honest notice, and a non-UUID ticket never calls the API', async () => {
    const body = fakeBody();
    await renderTraceTab(body, { id: TICKET_ID }, {
      fetchImpl: async () => { throw new Error('network down'); },
    });
    expect(body.innerHTML).toContain('Run trace unavailable');

    const calls: string[] = [];
    const other = fakeBody();
    await renderTraceTab(other, { id: '17' }, { fetchImpl: async (url: string) => { calls.push(url); return { status: 200, ok: true, json: async () => ({}) }; } });
    expect(calls).toEqual([]);
    expect(other.innerHTML).toContain('No trace key for this ticket');
  });

  it('the ready markup is pure and carries no iframe when the state says there is nothing to show', () => {
    expect(buildTraceTabMarkup({ id: TICKET_ID }, { status: 'ready', spanCount: 1 })).toContain('1 span<');
    expect(buildTraceTabMarkup({ id: TICKET_ID }, { status: 'invalid' })).not.toContain('<iframe');
    expect(buildTraceTabMarkup({ id: TICKET_ID }, { status: 'unavailable' })).not.toContain('<iframe');
  });
});
