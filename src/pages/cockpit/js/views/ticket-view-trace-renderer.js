/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the Run Trace ticket-detail sub-screen. The run-trace read model already renders a self-contained cost waterfall at GET /api/trace/:ticketId.html (built for embedding), but the only way to see it was the standalone Run Trace tool where the operator PASTES a ticket id for the ticket they are already looking at. This renderer embeds that same rendered waterfall in the ticket the operator has open. Lives in its own module (not the detail renderer, which is already inside the 800-line warn band).
 */

import { buildInlineEmptyState } from './ticket-view-helpers.js';
import { createUiLogger, serializeUiError } from '../../../shared/ui-debug.js';

const logger = createUiLogger('cockpit-ticket-view-trace-renderer');

/** TraceService only resolves a canonical ticket UUID (a sequence id is not a trace key). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @description The ticket's canonical UUID as the trace API keys it. The cockpit list/detail
 * payloads carry several id shapes (`id`, `ticketId`, `ticket_id`); the sequence id is deliberately
 * NOT accepted because TraceService rejects a non-UUID before it queries.
 * @param {Record<string, unknown>} ticket - Normalized ticket detail record.
 * @returns {string} The UUID, or '' when this record carries none.
 */
export function readTraceTicketId(ticket) {
  for (const key of ['id', 'ticketId', 'ticket_id']) {
    const value = ticket && ticket[key];
    if (typeof value === 'string' && UUID_RE.test(value.trim())) return value.trim();
  }
  return '';
}

/**
 * @description The embeddable rendered-waterfall URL for a ticket, or '' when the id cannot be a
 * trace key. Exported so the guard spec asserts the exact URL the iframe loads (a drift in the
 * `/api/trace/:ticketId.html` route shape would otherwise only show as a blank pane in a browser).
 * @param {string} ticketId - Canonical ticket UUID.
 * @returns {string} `/api/trace/<uuid>.html`, or '' for a non-UUID input.
 */
export function traceEmbedUrl(ticketId) {
  const id = String(ticketId || '').trim();
  if (!UUID_RE.test(id)) return '';
  return `/api/trace/${encodeURIComponent(id)}.html`;
}

/**
 * @description Builds the Run Trace sub-screen markup for a resolved state. Kept pure (state in,
 * HTML out) so the guard spec can assert every branch without a DOM.
 * @param {Record<string, unknown>} ticket - Normalized ticket detail record.
 * @param {{status:'ready'|'none'|'invalid'|'unavailable', spanCount?:number}} state - Resolved trace state.
 * @returns {string} The tab HTML.
 */
export function buildTraceTabMarkup(ticket, state) {
  if (state.status === 'invalid') {
    return buildInlineEmptyState('flow-arrow', 'No trace key for this ticket', 'A run trace is keyed by the ticket\'s canonical id; this record was opened without one.');
  }
  if (state.status === 'none') {
    return buildInlineEmptyState('flow-arrow', 'No run trace recorded yet', 'Phase transitions, bot runs, and model calls appear here as a cost waterfall once this ticket executes.');
  }
  if (state.status === 'unavailable') {
    return buildInlineEmptyState('flow-arrow', 'Run trace unavailable', 'The trace service did not answer. The Cost tab still shows recorded totals.');
  }

  const url = traceEmbedUrl(readTraceTicketId(ticket));
  const spans = Number.isFinite(state.spanCount) ? state.spanCount : 0;
  return `
    <div style="display:flex;flex-direction:column;gap:10px;height:100%">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span class="td-meta-item"><i class="ph ph-flow-arrow"></i> ${spans} span${spans === 1 ? '' : 's'}</span>
        <a class="td-action-btn" href="${url}" target="_blank" rel="noopener" style="margin-left:auto;text-decoration:none"><i class="ph ph-arrow-square-out"></i> Open full waterfall</a>
      </div>
      <iframe title="Run trace waterfall" src="${url}" loading="lazy"
        style="flex:1;width:100%;min-height:460px;border:1px solid var(--border-color);border-radius:var(--radius-md);background:var(--bg-card)"></iframe>
    </div>
  `;
}

/**
 * @description Renders the Run Trace sub-screen into the detail body. The JSON read model is probed
 * FIRST so a ticket with no trace shows the cockpit's own empty state instead of the trace service's
 * bare not-found page inside an iframe; only a real trace gets the embedded waterfall.
 * @param {HTMLElement} body - Ticket detail tab container.
 * @param {Record<string, unknown>} ticket - Normalized ticket detail record.
 * @param {{fetchImpl?: Function}} [deps] - Injected fetch (tests); defaults to the page's fetch.
 * @returns {Promise<void>} Resolves once the tab HTML is written.
 */
export async function renderTraceTab(body, ticket, deps = {}) {
  const ticketId = readTraceTicketId(ticket);
  if (!ticketId) {
    logger.warn('Run Trace tab opened on a ticket with no canonical UUID', { keys: Object.keys(ticket || {}) });
    body.innerHTML = buildTraceTabMarkup(ticket, { status: 'invalid' });
    return;
  }

  const fetchImpl = deps.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!fetchImpl) {
    logger.error('Run Trace tab has no fetch implementation available', {});
    body.innerHTML = buildTraceTabMarkup(ticket, { status: 'unavailable' });
    return;
  }

  let state = { status: 'unavailable' };
  try {
    const response = await fetchImpl(`/api/trace/${encodeURIComponent(ticketId)}`, { headers: { Accept: 'application/json' } });
    if (response.status === 404) {
      state = { status: 'none' };
    } else if (!response.ok) {
      throw new Error(`trace read failed: HTTP ${response.status}`);
    } else {
      const payload = await response.json();
      const spans = Array.isArray(payload?.trace?.spans) ? payload.trace.spans : [];
      state = spans.length > 0 ? { status: 'ready', spanCount: spans.length } : { status: 'none' };
    }
  } catch (error) {
    logger.error('Run Trace tab could not read the trace read model', {
      ticketId,
      error: serializeUiError(error),
    });
    state = { status: 'unavailable' };
  }

  logger.debug('Rendering Run Trace tab', { ticketId, status: state.status, spanCount: state.spanCount });
  body.innerHTML = buildTraceTabMarkup(ticket, state);
}
