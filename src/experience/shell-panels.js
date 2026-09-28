/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Markup for the full-swarm work panels over existing routes: a moving item's indeterminate progress (the queue reports no percentage), a ticket's workflow (GET /api/v1/tickets/:id/workflow: stages with their recorded state, progress only from a recorded run, approval gates, status history, child tickets) and its actions: Approve only for a ticket held at approval_required whose current transition waits on a person (the homebase rule), Cancel through the owner-checked cancel route behind a confirmation. The server decides every action; a refusal is shown as returned.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | The Routines panel: the caller's schedules (GET /api/v1/agent/schedules) with their cadence, next and last run and an "On for me" switch only on their own prompt schedules (an application's or an operator's schedule says who manages it), an application's own routines first when opened from its panel, an empty state that offers to ask Jarvis for one, and the Workflow Studio definitions by name and version with a link to Workflow Studio, where workflows are edited, published and restored.
 */
(() => {
  'use strict';
  const S = () => window.OSHAL_SHELL;
  const esc = v => S().esc(v);
  const STAGE_WORDS = { done: 'Done', skipped: 'Skipped', waiting: 'Waiting', running: 'Running', failed: 'Stopped', pending: 'Not reached' };

  /**
   * @description An indeterminate bar for an item that is Working. The queue records no percentage for a ticket, so
   * the bar says it is moving, never how far.
   * @param {object} item A work item.
   * @returns {string} Markup, empty when the item is not Working.
   */
  function movingBar(item) {
    if (!item || item.status.label !== 'Working') return '';
    return '<span class="mini-progress live-indeterminate" role="progressbar" aria-label="In progress; the queue reports no percentage"><i></i></span>';
  }

  /** @description The ticket a work item stands for: the ticket itself, or the ticket behind a swarm task. */
  const ticketOf = item => item.kind === 'ticket' ? item.ref : item.ticketId || '';

  /**
   * @description The transition that put a ticket in its current status, from metadata.lastStatusTransition; only a
   * mirror of the current status describes it (row-level reason/nextAction may describe an older one).
   * @param {object} ticket The ticket from GET /api/tickets/:id.
   * @returns {{status: string, next: string}} The status and the next action ('' when no matching mirror).
   */
  function currentTransition(ticket) {
    const meta = ticket && ticket.metadata && typeof ticket.metadata === 'object' ? ticket.metadata : {};
    const status = String(ticket && ticket.status || ''), last = meta.lastStatusTransition && typeof meta.lastStatusTransition === 'object' ? meta.lastStatusTransition : null;
    return { status, next: last && String(last.status || '') === status && typeof last.nextAction === 'string' ? last.nextAction.trim() : '' };
  }

  /**
   * @description The actions a ticket offers from its current state: Approve for approval_required unless its children
   * dispatch on their own, Cancel while it is open. Nothing is offered when the ticket cannot be read.
   * @param {object} item The work item.
   * @param {{ok: boolean, status: number, body: any}} ticketRes GET /api/tickets/:id.
   * @returns {string} Action markup plus a feedback line.
   */
  function actionsMarkup(item, ticketRes) {
    if (!ticketRes || !ticketRes.ok || !ticketRes.body) return `<p class="note-line">This ticket’s current state could not be read (HTTP ${esc(ticketRes ? ticketRes.status : 0)}), so no action is offered.</p>`;
    const { status, next } = currentTransition(ticketRes.body), label = window.OSHAL_LIVE.statusOf(status);
    const approve = status === 'approval_required' && next !== 'none_children_dispatch_independently';
    const cancel = label.open && !window.OSHAL_LIVE.STATUS_GROUPS.done.includes(label.label);
    const note = status === 'approval_required' && !approve ? '<p class="note-line">Nothing here waits for your approval: its child tickets dispatch on their own.</p>' : '';
    const buttons = [approve ? S().primary('Approve', 'work-approve', `data-work="${esc(item.id)}"`) : '', cancel ? S().button('Cancel this work', 'work-cancel', 'action', `data-work="${esc(item.id)}"`) : ''].join('');
    return `${note}${buttons ? `<div class="drawer-actions work-actions" data-work-actions="${esc(item.id)}">${buttons}</div>` : ''}${approve ? '<p class="note-line">Approving moves it from Approval required to Approved, where the queue picks it up. The server decides whether you may.</p>' : ''}<p class="note-line" id="work-feedback" role="status"></p>`;
  }

  /** @description The confirmation that replaces the actions before a cancel is sent. */
  function cancelConfirm(item) {
    return `<p>Cancel “${esc(item.title)}”? The ticket stops; nothing it already delivered is undone.</p><div class="drawer-actions">${S().primary('Yes, cancel it', 'work-cancel-confirm', `data-work="${esc(item.id)}"`)}${S().button('Keep it', 'work-cancel-keep', 'action', `data-work="${esc(item.id)}"`)}</div>`;
  }

  /** @description The progress line of a workflow view: determinate from a recorded run, otherwise the plain state. */
  function progressLine(view, item) {
    if (view.progress) {
      const cur = view.current ? ` · now: ${esc(view.current.title)}` : '';
      return `<div class="demo-progress live-progress"><span>Step ${Math.min(view.progress.done + (view.current ? 1 : 0), view.progress.total)} of ${view.progress.total}${cur}<strong>${view.progress.pct}%</strong></span><div role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${view.progress.pct}" aria-label="Recorded workflow progress"><i style="width:${view.progress.pct}%"></i></div></div>`;
    }
    if (item.status.label === 'Working') return `<div class="demo-progress live-progress"><span>In progress<strong>no run recorded</strong></span><div class="live-indeterminate-track" role="progressbar" aria-label="In progress; no workflow run is recorded"><i></i></div></div>`;
    return '';
  }

  /** @description The ordered stage list of a workflow view. */
  function stagesList(view, limit) {
    const stages = view.stages.slice(0, limit);
    const more = view.stages.length > limit ? `<p class="note-line">…and ${view.stages.length - limit} more stages.</p>` : '';
    return stages.length ? `<ol class="live-stages">${stages.map(s => `<li class="stage-${esc(s.state)}"><span class="stage-mark" aria-hidden="true"></span><span><strong>${esc(s.title)}</strong><small>${esc([s.type.replace(/-/g, ' '), STAGE_WORDS[s.state] || s.state].filter(Boolean).join(' · '))}</small></span></li>`).join('')}</ol>${more}` : '<p class="note-line">No workflow stages are registered for this ticket type.</p>';
  }

  /**
   * @description The compact workflow section of a work panel: progress, the first stages and a way into the full view.
   * @param {object} view LIVE_VIEWS.workflowView output.
   * @param {object} item The work item.
   * @returns {string} Markup.
   */
  function workflowSection(view, item) {
    if (!view.ok) return `<p class="note-line">${view.status === 404 ? 'This ticket’s workflow is not visible to you.' : `Its workflow could not be read (HTTP ${esc(view.status || 'unreachable')}).`}</p>`;
    const name = view.name ? `<p class="small-label">${esc(view.name)}${view.runStatus ? ` · run ${esc(view.runStatus)}` : ''}</p>` : '';
    return `<h3>Its workflow</h3>${name}${progressLine(view, item)}${stagesList(view, 4)}${S().button('See its workflow →', 'ticket-workflow', 'action text', `data-work="${esc(item.id)}"`)}`;
  }

  function gateLine(g) {
    const when = g.decision ? `${esc(g.decision.toStatus)} by ${esc(g.decision.actor)}` : g.disposition === 'awaiting' ? 'awaiting a decision' : 'no recorded decision';
    return `<li>${esc(g.gateNodeId || 'Approval gate')} · ${when}</li>`;
  }

  /**
   * @description The full workflow view for the ticket-workflow panel: every stage, approval gates, the last status
   * changes and child tickets, each with its own unavailable state, plus the cockpit's Workflow tab.
   * @param {object} view LIVE_VIEWS.workflowView output.
   * @param {object} item The work item.
   * @returns {string} Markup.
   */
  function workflowPanel(view, item) {
    if (!view) return '<p class="note-line">Reading this ticket’s workflow…</p>';
    if (!view.ok) return workflowSection(view, item);
    const history = !view.historyAvailable ? '<p class="note-line">Status history is unavailable right now.</p>' : view.history.length ? `<ul class="artifact-steps">${view.history.map(h => `<li>${esc(window.OSHAL_LIVE.statusOf(h.fromStatus).label)} → ${esc(window.OSHAL_LIVE.statusOf(h.toStatus).label)}<small class="muted" style="display:block">${esc(h.changedByLabel || 'swarm')} · ${esc(new Date(h.createdAt).toLocaleString())}</small></li>`).join('')}</ul>` : '<p class="note-line">No status changes recorded.</p>';
    const gates = view.gates.length ? `<h3>Approval gates</h3><ul class="artifact-steps">${view.gates.map(gateLine).join('')}</ul>` : '';
    const children = !view.childrenAvailable ? '<p class="note-line">Child tickets are unavailable right now.</p>' : view.children.length ? `<h3>Child tickets</h3><ul class="artifact-steps">${view.children.slice(0, 6).map(c => `<li>${esc(c.title)} · ${esc(window.OSHAL_LIVE.statusOf(c.status).label)}</li>`).join('')}</ul>` : '';
    const run = view.runHistoryAvailable ? (view.progress ? '' : '<p class="note-line">No run is recorded for this ticket yet; stages show the registered route only.</p>') : '<p class="note-line">Run history is unavailable right now.</p>';
    return `${view.name ? `<span class="eyebrow muted">${esc(view.name)}</span>` : ''}${progressLine(view, item)}${run}${stagesList(view, 40)}${gates}<h3>Recent status changes</h3>${history}${children}<div class="drawer-actions">${S().link('Open the cockpit’s Workflow tab ↗', `/cockpit/?ticket=${encodeURIComponent(ticketOf(item))}`, 'action primary')}</div><p class="note-line">The stages are the workflow registered for this ticket type today, not a snapshot of the run.</p>`;
  }

  const whenNext = d => d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const ROUTINE_PROMPT = 'Every weekday at 8am, brief me on what is waiting for me across my swarm.';

  /** @description One routine row: what it asks, when it runs, and the caller's switch (or who manages it). */
  function routineRow(r) {
    const timing = [r.cadence, r.on ? (r.next ? `next ${whenNext(r.next)}` : 'no next run scheduled') : 'paused', `${r.runs} run${r.runs === 1 ? '' : 's'}`, r.last ? `last ${window.OSHAL_LIVE.relativeTime(r.last)}` : ''].filter(Boolean).join(' · ');
    const control = r.switchable
      ? `<label class="routine-toggle"><span>On for me</span><input type="checkbox" data-routine="${esc(r.id)}"${r.on ? ' checked' : ''} aria-label="${esc(`${r.on ? 'Pause' : 'Resume'} ${r.title}`)}"></label>`
      : `<span class="small-label">${r.managed === 'app' ? 'Managed by its application' : 'Managed by an operator'}</span>`;
    return `<div class="routine-row" data-routine-row="${esc(r.id)}"><span class="routine-copy"><strong>${esc(r.title)}</strong><small>${esc(timing)}</small></span>${control}</div><p class="note-line routine-note" data-routine-note="${esc(r.id)}" role="status"></p>`;
  }

  /** @description The routines half of the panel, an application's own routines first when one is named. */
  function routinesSection(view, app) {
    if (!view) return '<p class="note-line">Reading your routines…</p>';
    if (!view.ok) return `<p class="note-line">Your routines could not be read (HTTP ${esc(view.status || 'unreachable')}).</p>`;
    if (!view.routines.length) return `<p>You have no routines yet. Ask Jarvis for one in plain words; nothing is scheduled until you send it.</p><div class="drawer-actions">${S().button('Ask Jarvis for a weekday briefing', 'prompt', 'action', `data-prompt="${esc(ROUTINE_PROMPT)}"`)}</div>`;
    const own = app ? view.routines.filter(r => r.queue === app.id) : [];
    const rest = view.routines.filter(r => own.indexOf(r) < 0);
    const block = (title, list) => list.length ? `<h3>${esc(title)}</h3>${list.map(routineRow).join('')}` : '';
    return (app ? (own.length ? block(`For ${app.name}`, own) : `<p class="note-line">${esc(app.name)} has no routines of yours.</p>`) : '') + block(app ? 'Your other routines' : 'Your routines', rest);
  }

  /** @description The workflows half: Workflow Studio definitions by name, version and size, edited where they live. */
  function workflowsSection(view) {
    if (!view) return '<p class="note-line">Reading the workflows…</p>';
    if (!view.ok) return `<p class="note-line">Workflow Studio definitions could not be read (HTTP ${esc(view.status || 'unreachable')}).</p>`;
    const rows = view.workflows.slice(0, 8).map(w => `<div class="flow-step"><span>v${esc(w.version)}</span><span><strong>${esc(w.name)}</strong><small>${esc([`${w.nodeCount} step${w.nodeCount === 1 ? '' : 's'}`, w.updatedAt ? `updated ${window.OSHAL_LIVE.relativeTime(w.updatedAt)}` : ''].filter(Boolean).join(' · '))}</small></span></div>`).join('');
    const more = view.workflows.length > 8 ? `<p class="note-line">…and ${view.workflows.length - 8} more in Workflow Studio.</p>` : '';
    return `${rows || '<p class="note-line">No workflows are defined in Workflow Studio yet.</p>'}${more}`;
  }

  /**
   * @description The Routines panel: the caller's own schedules with a switch each (pause/resume only their own), and
   * the Workflow Studio definitions, which stay edited, published and restored in Workflow Studio.
   * @param {object|null} routines LIVE_VIEWS.routinesView output, or null while reading.
   * @param {object|null} workflows LIVE_VIEWS.workflowsView output, or null while reading.
   * @param {object|null} app The application the panel was opened from, if any.
   * @returns {string} Markup.
   */
  function routinesPanel(routines, workflows, app) {
    return `<p>Routines are your own scheduled requests. A switch here pauses or resumes one for you only; nobody else is enrolled or changed.</p>${routinesSection(routines, app)}<hr class="rule"><h3>Workflows</h3><p class="note-line">How work moves through the swarm. They are edited, published and restored in Workflow Studio.</p>${workflowsSection(workflows)}<div class="drawer-actions">${S().link('Open Workflow Studio ↗', '/workflow-studio/', 'action')}</div>`;
  }

  window.OSHAL_SHELL_PANELS = { movingBar, ticketOf, currentTransition, actionsMarkup, cancelConfirm, workflowSection, workflowPanel, routineRow, routinesPanel };
})();
