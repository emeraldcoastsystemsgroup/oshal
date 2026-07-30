/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the Runs panel for Workflow Studio: a rail-toggled left flyout listing past graph runs (GET /api/workflow-studio/runs) and a click-through run inspector showing each step's status, timing, agent, and redacted input/output (GET /api/workflow-studio/runs/:runId). Own module (sibling of workflow-studio-chat.js) so the 1700-line core stays untouched; auto-refreshes while a run is still executing.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The list was fetching every run the caller owns, so opening one workflow showed unrelated history: scope it to the open definition's published ticketType (via the shared workflowTicketTypeSlug) with a This-workflow/All-my-runs toggle, and turn the inspector's inert "Ticket <id>" text into a deep link to that ticket's cost trace so a run is one click from its spend.
 */

import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';
import { workflowTicketTypeSlug } from './workflow-studio-utils.js';

const logger = createUiLogger('workflow-studio-runs');

const REFRESH_MS = 15000;

/** Monochrome glyph per node type — mirrors the canvas NODE_ICONS so steps read the same. */
const STEP_ICONS = {
  'start': '▶', 'intake-source': '↧', 'planner': '☰', 'route-agent': '⇄',
  'ai-decision': '◆', 'logic-gate': '⎇', 'execute-agent': '▣',
  'parallel-split': '⋔', 'parallel-join': '⋕', 'approval-gate': '‖',
  'verify-output': '✓', 'review': '◎', 'deliver': '→', 'escalate': '▲',
  'agent-cluster': '⧉',
};

/** Chip tone per run/step status. */
const STATUS_TONES = {
  running: 'run-tone-active', suspended: 'run-tone-warn', completed: 'run-tone-ok',
  terminal: 'run-tone-ok', escalated: 'run-tone-danger', error: 'run-tone-danger',
  skipped: 'run-tone-muted', jump: 'run-tone-muted',
};

/**
 * @description The Runs panel: run-history list + per-step run inspector. Reads the
 * auth-gated run-history API; owns only its flyout (the core app's flyouts are closed
 * via window.workflowStudioApp.closeFlyouts so panels never stack).
 */
class WorkflowStudioRuns {
  constructor() {
    this.flyout = document.getElementById('runsFlyout');
    this.scopeBarEl = document.getElementById('runsScopeBar');
    this.listEl = document.getElementById('runsList');
    this.detailEl = document.getElementById('runDetail');
    this.titleEl = document.getElementById('runsFlyoutTitle');
    this.railButton = document.getElementById('railRunsButton');
    this.backButton = document.getElementById('runsBackButton');
    this.refreshButton = document.getElementById('runsRefreshButton');
    this.closeButton = document.getElementById('runsCloseButton');
    this.selectedRunId = null;
    this.refreshTimer = null;
    /** 'workflow' = only the open definition's runs; 'all' = every run the caller owns. */
    this.scope = 'all';
  }

  /**
   * @description The ticketType the open definition publishes (and records runs) under, or null
   * when no definition is selected. Derived from the SAME helper the publish path uses so the
   * join key can never drift.
   * @returns {string|null} the open workflow's ticketType slug, or null
   */
  openWorkflowTicketType() {
    try {
      const definition = window.workflowStudioApp?.state?.selectedDefinition;
      if (!definition || !(definition.slug || definition.name)) return null;
      return workflowTicketTypeSlug(definition);
    } catch (error) {
      logger.error('Could not read the open definition for run scoping', { error: serializeUiError(error) });
      return null;
    }
  }

  /**
   * @description Render the This-workflow / All-my-runs toggle. Hidden entirely when no
   * definition is open (there is nothing to scope to).
   */
  renderScopeBar() {
    if (!this.scopeBarEl) return;
    const ticketType = this.openWorkflowTicketType();
    if (!ticketType) {
      this.scopeBarEl.hidden = true;
      this.scopeBarEl.innerHTML = '';
      return;
    }
    const chip = (value, label, title) =>
      `<button type="button" class="chip run-scope-chip${this.scope === value ? ' is-active' : ''}" data-run-scope="${value}" title="${escapeHtml(title)}">${escapeHtml(label)}</button>`;
    this.scopeBarEl.hidden = false;
    this.scopeBarEl.innerHTML =
      chip('workflow', 'This workflow', `Runs recorded against ${ticketType}`) +
      chip('all', 'All my runs', 'Every workflow run you own');
    this.scopeBarEl.querySelectorAll('[data-run-scope]').forEach((button) => {
      button.addEventListener('click', () => this.setScope(button.getAttribute('data-run-scope')));
    });
  }

  /**
   * @description Switch the list scope and reload.
   * @param {string} scope - 'workflow' | 'all'
   */
  setScope(scope) {
    const next = scope === 'workflow' ? 'workflow' : 'all';
    if (next === this.scope) return;
    this.scope = next;
    this.renderScopeBar();
    void this.loadList();
  }

  /** @description Wire the rail toggle, header controls, and cross-flyout coordination. */
  init() {
    if (!this.flyout || !this.railButton) return;
    this.railButton.addEventListener('click', () => this.toggle());
    this.closeButton?.addEventListener('click', () => this.close());
    this.backButton?.addEventListener('click', () => this.showList());
    this.refreshButton?.addEventListener('click', () => this.refresh());
    // Opening one of the core flyouts should close this one (panels share the left overlay slot).
    document.getElementById('railAddButton')?.addEventListener('click', () => this.close());
    document.getElementById('railFilesButton')?.addEventListener('click', () => this.close());
  }

  /** @description Toggle the flyout; opening closes the core flyouts and loads fresh data. */
  toggle() {
    if (this.flyout.hidden) this.open();
    else this.close();
  }

  /** @description Open the panel on the run list and start the while-open auto-refresh. */
  open() {
    try { window.workflowStudioApp?.closeFlyouts?.(); } catch (error) {
      logger.error('closeFlyouts coordination failed', { error: serializeUiError(error) });
    }
    this.flyout.hidden = false;
    this.railButton.classList.add('is-active');
    // Default to the open workflow's own history — an author opening Runs from a canvas means
    // "how has THIS workflow run"; with no definition open there is nothing to scope to.
    this.scope = this.openWorkflowTicketType() ? 'workflow' : 'all';
    this.showList();
    if (!this.refreshTimer) this.refreshTimer = setInterval(() => this.refresh(true), REFRESH_MS);
  }

  /** @description Hide the panel and stop refreshing. */
  close() {
    if (!this.flyout || this.flyout.hidden) {
      this.railButton?.classList.remove('is-active');
      return;
    }
    this.flyout.hidden = true;
    this.railButton.classList.remove('is-active');
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
  }

  /** @description Switch to the run-list view and (re)load it. */
  showList() {
    this.selectedRunId = null;
    if (this.titleEl) this.titleEl.textContent = 'Run history';
    if (this.backButton) this.backButton.hidden = true;
    if (this.detailEl) { this.detailEl.hidden = true; this.detailEl.innerHTML = ''; }
    if (this.listEl) this.listEl.hidden = false;
    this.renderScopeBar();
    void this.loadList();
  }

  /**
   * @description Refresh whichever view is showing.
   * @param {boolean} background - true for timer refreshes (no error blanking)
   */
  refresh(background = false) {
    if (this.flyout.hidden) return;
    if (this.selectedRunId) void this.loadDetail(this.selectedRunId, background);
    else void this.loadList(background);
  }

  /**
   * @description Load + render the run list (newest first, caller-scoped by the API).
   * @param {boolean} background - suppress the loading placeholder on timer refreshes
   */
  async loadList(background = false) {
    if (!this.listEl) return;
    if (!background) this.listEl.innerHTML = '<p class="selection-state">Loading runs…</p>';
    const ticketType = this.scope === 'workflow' ? this.openWorkflowTicketType() : null;
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (ticketType) params.set('ticketType', ticketType);
      const payload = await this.fetchJson(`/api/workflow-studio/runs?${params.toString()}`);
      const runs = Array.isArray(payload.runs) ? payload.runs : [];
      if (runs.length === 0) {
        this.listEl.innerHTML = ticketType
          ? `<p class="selection-state">No runs recorded for <strong>${escapeHtml(ticketType)}</strong> yet. Publish this workflow and send it a ticket — every graph run lands here.</p>`
          : '<p class="selection-state">No runs yet. Publish a workflow and send it a ticket — every graph run lands here.</p>';
        return;
      }
      this.listEl.innerHTML = runs.map((run) => this.renderRunCard(run)).join('');
      this.listEl.querySelectorAll('[data-run-id]').forEach((card) => {
        card.addEventListener('click', () => this.showDetail(card.getAttribute('data-run-id')));
      });
    } catch (error) {
      logger.error('Run list load failed', { error: serializeUiError(error) });
      if (!background) this.listEl.innerHTML = `<p class="selection-state">Couldn't load runs: ${escapeHtml(error?.message || error)}</p>`;
    }
  }

  /**
   * @description One run card for the list.
   * @param {object} run - run summary from the API
   * @returns {string} card HTML
   */
  renderRunCard(run) {
    const duration = formatDuration(run.startedAt, run.finishedAt);
    const resumed = Number(run.resumedCount) > 0 ? `<span class="chip">resumed ×${Number(run.resumedCount)}</span>` : '';
    return `
      <article class="definition-card run-card" data-run-id="${escapeHtml(run.runId)}" role="button" tabindex="0">
        <h3>${escapeHtml(run.workflowName || run.ticketType || 'Workflow run')}</h3>
        <p class="run-when">${escapeHtml(formatWhen(run.startedAt))}${duration ? ` · ${escapeHtml(duration)}` : ''}</p>
        <div class="definition-meta">
          <span class="chip run-status ${STATUS_TONES[run.status] || 'run-tone-muted'}">${escapeHtml(run.status)}</span>
          ${run.ticketType ? `<span class="chip">${escapeHtml(run.ticketType)}</span>` : ''}
          <span class="chip">${Number(run.stepCount) || 0} steps</span>
          ${resumed}
        </div>
      </article>
    `;
  }

  /**
   * @description Switch to the inspector view for one run.
   * @param {string} runId - the run to inspect
   */
  showDetail(runId) {
    if (!runId) return;
    this.selectedRunId = runId;
    if (this.titleEl) this.titleEl.textContent = 'Run inspector';
    if (this.backButton) this.backButton.hidden = false;
    if (this.listEl) this.listEl.hidden = true;
    if (this.scopeBarEl) this.scopeBarEl.hidden = true;
    if (this.detailEl) this.detailEl.hidden = false;
    void this.loadDetail(runId);
  }

  /**
   * @description Load + render one run's steps (status, timing, agent, redacted input/output).
   * @param {string} runId - the run to load
   * @param {boolean} background - suppress the loading placeholder on timer refreshes
   */
  async loadDetail(runId, background = false) {
    if (!this.detailEl) return;
    if (!background) this.detailEl.innerHTML = '<p class="selection-state">Loading run…</p>';
    try {
      const payload = await this.fetchJson(`/api/workflow-studio/runs/${encodeURIComponent(runId)}`);
      const run = payload.run;
      if (!run) throw new Error('Run not found');
      const openSteps = new Set(
        [...this.detailEl.querySelectorAll('details.run-step[open]')].map((d) => d.getAttribute('data-step-id')),
      );
      const steps = Array.isArray(run.steps) ? run.steps : [];
      this.detailEl.innerHTML = `
        <div class="run-summary">
          <h3>${escapeHtml(run.workflowName || run.ticketType || 'Workflow run')}</h3>
          <div class="definition-meta">
            <span class="chip run-status ${STATUS_TONES[run.status] || 'run-tone-muted'}">${escapeHtml(run.status)}</span>
            ${run.outcome && run.outcome !== run.status ? `<span class="chip">${escapeHtml(run.outcome)}</span>` : ''}
            <span class="chip">${steps.length} steps</span>
          </div>
          <p class="run-when">${escapeHtml(formatWhen(run.startedAt))}${formatDuration(run.startedAt, run.finishedAt) ? ` · ${escapeHtml(formatDuration(run.startedAt, run.finishedAt))}` : ''}</p>
          ${run.reason ? `<p class="run-reason">${escapeHtml(run.reason)}</p>` : ''}
          ${renderTicketTrace(run.ticketId)}
        </div>
        <div class="run-steps">
          ${steps.length === 0 ? '<p class="selection-state">No steps recorded yet.</p>' : steps.map((step) => this.renderStep(step)).join('')}
        </div>
      `;
      openSteps.forEach((id) => {
        const el = this.detailEl.querySelector(`details.run-step[data-step-id="${CSS.escape(id)}"]`);
        if (el) el.open = true;
      });
    } catch (error) {
      logger.error('Run detail load failed', { error: serializeUiError(error), runId });
      if (!background) this.detailEl.innerHTML = `<p class="selection-state">Couldn't load this run: ${escapeHtml(error?.message || error)}</p>`;
    }
  }

  /**
   * @description One step row: icon, title, status, duration, agent — expandable to the
   * redacted input/output summaries.
   * @param {object} step - step record from the API
   * @returns {string} step HTML
   */
  renderStep(step) {
    const icon = STEP_ICONS[step.nodeType] || '□';
    const duration = formatDuration(step.startedAt, step.finishedAt);
    return `
      <details class="run-step" data-step-id="${escapeHtml(step.stepId)}">
        <summary>
          <span class="run-step-icon" aria-hidden="true">${icon}</span>
          <span class="run-step-titles">
            <span class="run-step-title">${escapeHtml(step.nodeTitle || step.nodeId)}</span>
            <span class="run-step-sub">${escapeHtml(step.nodeType)}${step.agentId ? ` · agent ${escapeHtml(String(step.agentId).slice(0, 8))}…` : ''}${duration ? ` · ${escapeHtml(duration)}` : ''}</span>
          </span>
          <span class="chip run-status ${STATUS_TONES[step.status] || 'run-tone-muted'}">${escapeHtml(step.status)}</span>
        </summary>
        <div class="run-step-io">
          ${step.startedAt ? `<p class="run-when">Started ${escapeHtml(formatWhen(step.startedAt))}</p>` : ''}
          ${renderIo('Input', step.inputSummary)}
          ${renderIo('Output', step.outputSummary)}
        </div>
      </details>
    `;
  }

  /**
   * @description GET a JSON API payload, throwing on HTTP or success=false failures.
   * @param {string} url - the endpoint
   * @returns {Promise<object>} the parsed payload
   */
  async fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
  }
}

/**
 * @description Render the run's ticket as a deep link into the run-trace surface, which keys off
 * exactly this ticket id (`/api/trace/app?ticketId=`) and is itself caller-scoped — so "what did
 * this run cost" is one click from the run, with no second lookup and no widened access.
 * @param {unknown} ticketId - the run's ticket id
 * @returns {string} paragraph HTML (plain text when there is no ticket id to link)
 */
function renderTicketTrace(ticketId) {
  const id = ticketId === null || ticketId === undefined ? '' : String(ticketId);
  if (!id) return '<p class="run-ticket">Ticket —</p>';
  const href = `/api/trace/app?ticketId=${encodeURIComponent(id)}`;
  return `<p class="run-ticket">Ticket <a class="run-ticket-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="Open the cost trace for ${escapeHtml(id)}">${escapeHtml(id.slice(0, 8))}…</a></p>`;
}

/**
 * @description Render one labelled input/output block as pretty JSON (already redacted server-side).
 * @param {string} label - "Input" | "Output"
 * @param {unknown} value - the summary payload
 * @returns {string} block HTML
 */
function renderIo(label, value) {
  if (value === null || value === undefined) {
    return `<div class="run-io"><span class="run-io-label">${label}</span><span class="run-io-empty">—</span></div>`;
  }
  let text;
  try { text = JSON.stringify(value, null, 2); } catch { text = String(value); }
  return `<div class="run-io"><span class="run-io-label">${label}</span><pre class="run-io-json">${escapeHtml(text)}</pre></div>`;
}

/**
 * @description Human duration between two ISO timestamps ("3.2s", "4m 12s"), or '' when open-ended.
 * @param {string} start - ISO start
 * @param {string} end - ISO end
 * @returns {string} formatted duration
 */
function formatDuration(start, end) {
  if (!start || !end) return '';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * @description Friendly "when" for a timestamp: relative under a day, locale date otherwise.
 * @param {string} iso - ISO timestamp
 * @returns {string} formatted time
 */
function formatWhen(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const ageMs = Date.now() - date.getTime();
  if (ageMs < 60000) return 'just now';
  if (ageMs < 3600000) return `${Math.floor(ageMs / 60000)}m ago`;
  if (ageMs < 86400000) return `${Math.floor(ageMs / 3600000)}h ago`;
  return date.toLocaleString();
}

/**
 * @description Escape a value for safe HTML interpolation.
 * @param {unknown} value - raw value
 * @returns {string} escaped text
 */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const runsPanel = new WorkflowStudioRuns();
runsPanel.init();
