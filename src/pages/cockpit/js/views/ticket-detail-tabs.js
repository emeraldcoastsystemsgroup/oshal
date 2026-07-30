/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — config-driven ticket-detail sub-screen (tab) visibility so only screens relevant to a ticket's process show. Replaces the hardcoded tab list that surfaced the incident-only "RCA & Remediation" screen on every ticket regardless of process.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Registered the Run Trace sub-screen. The run-trace read model already renders an embeddable cost waterfall (GET /api/trace/:ticketId.html) but the only way to reach it was the standalone tool, where the operator pastes the id of the ticket they already have open; the trace now sits on the ticket itself. Ungated: a trace is generic to every process, and a ticket without one shows the renderer's own empty state.
 */

/**
 * Ticket-detail sub-screen configuration.
 *
 * A ticket's detail view is a set of reusable sub-screens (tabs). Not every screen applies to every
 * process — the RCA & Remediation screen is meaningful for an incident/RCA workflow, but noise on an
 * eats order, a world-intelligence read, or a build ticket. This module is the single declarative
 * source of truth for "which sub-screens does this process show", so screens can be reused across
 * processes/roles/views without each one hand-coding its own tab list.
 *
 * Today visibility keys off the ticket's PROCESS (its ticketType). It is the seed of the broader
 * per-app/per-role screen configuration: a swarm-app manifest can later declare its own detail-screen
 * set and override `PROCESS_ONLY_TABS` without touching the renderer.
 */

/** The full catalog of ticket-detail sub-screens, in display order. `extraHtml` is appended inside
 *  the tab button (e.g. the Feed live-connection dot). `iconHtml` prefixes the label. */
export const TICKET_DETAIL_TABS = [
  { key: 'feed', label: 'Feed', extraHtml: ' <span id="tvLiveDot" title="Connecting…" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#6b7280;margin-left:4px;vertical-align:middle;transition:background 0.4s"></span>' },
  { key: 'process', label: 'Process' },
  { key: 'description', label: 'Description' },
  { key: 'artifacts', label: 'Work Artifacts' },
  { key: 'rca', label: 'RCA &amp; Remediation', iconHtml: '<i class="ph ph-file-text"></i> ' },
  { key: 'cost', label: 'Cost' },
  { key: 'trace', label: 'Run Trace', iconHtml: '<i class="ph ph-flow-arrow"></i> ' },
];

/** Processes (ticketType values) that the incident/RCA workflow produces — the only ones for which the
 *  RCA & Remediation screen is relevant. Everything else hides it. */
const RCA_PROCESSES = new Set(['incident', 'rca', 'incident-rca']);

/** Tabs that only appear for specific processes; absent from this map = shown for every process. */
const PROCESS_GATED_TABS = {
  rca: (ticketType) => RCA_PROCESSES.has(ticketType),
};

/**
 * @description Resolve the ordered list of detail sub-screens to render for a ticket's process.
 * @param {string} ticketType - The ticket's process type (e.g. 'incident', 'eats', 'world', 'build').
 * @returns {Array<{key:string,label:string,iconHtml?:string,extraHtml?:string}>} The tabs to render.
 */
export function resolveDetailTabs(ticketType) {
  const type = String(ticketType || '').toLowerCase().trim();
  return TICKET_DETAIL_TABS.filter((tab) => {
    const gate = PROCESS_GATED_TABS[tab.key];
    return gate ? gate(type) : true;
  });
}
