/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Process Lab browser logic for scenario launch, run polling, and trace rendering
 */

import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';

const logger = createUiLogger('process-lab');
const REFRESH_INTERVAL_MS = 5000;

class ProcessLabApp {
  constructor() {
    this.state = {
      loading: false,
      runs: [],
      scenarios: [],
      selectedRun: null,
      selectedRunId: null,
    };
    this.elements = {
      detailHeading: document.getElementById('detailHeading'),
      metricActiveRuns: document.getElementById('metricActiveRuns'),
      metricAttention: document.getElementById('metricAttention'),
      metricRuns: document.getElementById('metricRuns'),
      metricScenarios: document.getElementById('metricScenarios'),
      refreshButton: document.getElementById('refreshButton'),
      runAllButton: document.getElementById('runAllButton'),
      runDetail: document.getElementById('runDetail'),
      runList: document.getElementById('runList'),
      scenarioGrid: document.getElementById('scenarioGrid'),
      statusBanner: document.getElementById('statusBanner'),
    };
    this.refreshTimer = null;
  }

  async init() {
    logger.info('Initializing Process Lab');
    this.bindEvents();
    await this.refresh({ focusLatest: true });
    this.refreshTimer = window.setInterval(() => {
      void this.refresh({ preserveSelection: true });
    }, REFRESH_INTERVAL_MS);
    window.addEventListener('beforeunload', () => {
      if (this.refreshTimer) {
        window.clearInterval(this.refreshTimer);
      }
    });
  }

  bindEvents() {
    this.elements.refreshButton.addEventListener('click', async () => {
      await this.refresh({ preserveSelection: true });
    });

    this.elements.runAllButton.addEventListener('click', async () => {
      await this.runAllScenarios();
    });

    this.elements.scenarioGrid.addEventListener('click', async (event) => {
      const button = event.target instanceof HTMLElement ? event.target.closest('[data-scenario-id]') : null;
      if (!button) {
        return;
      }
      const scenarioId = button.getAttribute('data-scenario-id');
      if (!scenarioId) {
        return;
      }
      await this.startScenario(scenarioId);
    });

    this.elements.runList.addEventListener('click', async (event) => {
      const button = event.target instanceof HTMLElement ? event.target.closest('[data-run-id]') : null;
      if (!button) {
        return;
      }
      const runId = button.getAttribute('data-run-id');
      if (!runId) {
        return;
      }
      await this.selectRun(runId);
    });
  }

  async refresh(options = {}) {
    const preserveSelection = options.preserveSelection === true;
    const focusLatest = options.focusLatest === true;

    this.setStatus('Refreshing Process Lab...', 'info');
    this.state.loading = true;

    try {
      const [scenarioPayload, runsPayload] = await Promise.all([
        requestJson('/api/process-lab/scenarios'),
        requestJson('/api/process-lab/runs?limit=30'),
      ]);

      this.state.scenarios = Array.isArray(scenarioPayload.scenarios) ? scenarioPayload.scenarios : [];
      this.state.runs = Array.isArray(runsPayload.runs) ? runsPayload.runs : [];

      if (preserveSelection && this.state.selectedRunId) {
        await this.fetchSelectedRun(this.state.selectedRunId);
      } else if (focusLatest && this.state.runs.length > 0) {
        await this.selectRun(this.state.runs[0].runId, true);
      } else if (!this.state.selectedRunId && this.state.runs.length > 0) {
        await this.selectRun(this.state.runs[0].runId, true);
      } else {
        this.render();
      }

      const attentionCount = this.state.runs.filter((run) => ['failed', 'attention'].includes(run.assessmentStatus)).length;
      this.setStatus(
        `Loaded ${this.state.scenarios.length} scenarios and ${this.state.runs.length} recent runs.`,
        attentionCount > 0 ? 'warning' : 'success',
      );
    } catch (error) {
      logger.error('Process Lab refresh failed', { error: serializeUiError(error) });
      this.setStatus(`Failed to refresh Process Lab: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      this.state.loading = false;
    }
  }

  async startScenario(scenarioId) {
    this.setStatus('Starting Process Lab scenario...', 'info');

    try {
      const payload = await requestJson('/api/process-lab/runs', {
        body: JSON.stringify({ scenarioId }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      const run = payload.run;
      this.state.selectedRunId = run?.runId || null;
      await this.refresh({ preserveSelection: true });
      this.setStatus(`Started ${run?.scenario?.name || 'Process Lab run'}.`, 'success');
    } catch (error) {
      logger.error('Failed to start Process Lab scenario', { error: serializeUiError(error), scenarioId });
      this.setStatus(`Failed to start scenario: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    }
  }

  async runAllScenarios() {
    if (!this.state.scenarios.length) {
      this.setStatus('No scenarios are available yet.', 'warning');
      return;
    }

    this.setStatus('Launching all Process Lab presets...', 'info');
    for (const scenario of this.state.scenarios) {
      try {
        await requestJson('/api/process-lab/runs', {
          body: JSON.stringify({ scenarioId: scenario.id }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        });
      } catch (error) {
        logger.warn('One Process Lab preset failed to start', {
          error: serializeUiError(error),
          scenarioId: scenario.id,
        });
      }
    }
    await this.refresh({ focusLatest: true });
    this.setStatus('Started the available presets. The run list will keep updating as they move.', 'success');
  }

  async selectRun(runId, silent = false) {
    this.state.selectedRunId = runId;
    await this.fetchSelectedRun(runId);
    if (!silent) {
      this.setStatus(`Loaded run ${runId.slice(0, 8)}.`, 'success');
    }
  }

  async fetchSelectedRun(runId) {
    try {
      const payload = await requestJson(`/api/process-lab/runs/${runId}`);
      this.state.selectedRun = payload.run || null;
      this.state.selectedRunId = payload.run?.runId || runId;
      this.render();
    } catch (error) {
      logger.warn('Failed to fetch selected Process Lab run', {
        error: serializeUiError(error),
        runId,
      });
      this.state.selectedRun = null;
      this.render();
    }
  }

  render() {
    this.renderMetrics();
    this.renderScenarios();
    this.renderRunList();
    this.renderRunDetail();
  }

  renderMetrics() {
    setText(this.elements.metricScenarios, String(this.state.scenarios.length));
    setText(this.elements.metricRuns, String(this.state.runs.length));
    setText(this.elements.metricActiveRuns, String(this.state.runs.filter((run) => run.status === 'running' || run.status === 'queued').length));
    setText(this.elements.metricAttention, String(this.state.runs.filter((run) => ['failed', 'attention'].includes(run.assessmentStatus)).length));
  }

  renderScenarios() {
    if (!this.state.scenarios.length) {
      this.elements.scenarioGrid.innerHTML = `<div class="empty-state">No Process Lab scenarios are configured.</div>`;
      return;
    }

    this.elements.scenarioGrid.innerHTML = this.state.scenarios.map((scenario) => `
      <article class="scenario-card" data-complexity="${escapeHtml(scenario.complexity)}">
        <div class="scenario-meta">
          <div>
            <span class="eyebrow">Preset Scenario</span>
            <h3>${escapeHtml(scenario.name)}</h3>
          </div>
          <span class="pill ${escapeHtml(scenario.complexity)}">${escapeHtml(scenario.complexity)}</span>
        </div>
        <p>${escapeHtml(scenario.description)}</p>
        <div class="scenario-stats">
          <div class="mini-stat">
            <span class="mini-stat-label">Planning Window</span>
            <span class="mini-stat-value">${escapeHtml(formatDuration(scenario.planningWaitMs))}</span>
          </div>
          <div class="mini-stat">
            <span class="mini-stat-label">Completion Window</span>
            <span class="mini-stat-value">${escapeHtml(formatDuration(scenario.completionWaitMs))}</span>
          </div>
        </div>
        <div class="scenario-actions">
          <span class="goal">${escapeHtml(scenario.goal)}</span>
          <button type="button" data-scenario-id="${escapeHtml(scenario.id)}">Run Trace</button>
        </div>
      </article>
    `).join('');
  }

  renderRunList() {
    if (!this.state.runs.length) {
      this.elements.runList.innerHTML = `<div class="empty-state">No Process Lab runs yet.</div>`;
      return;
    }

    this.elements.runList.innerHTML = this.state.runs.map((run) => {
      const isActive = run.runId === this.state.selectedRunId;
      return `
        <button type="button" class="run-row ${isActive ? 'active' : ''}" data-run-id="${escapeHtml(run.runId)}">
          <div class="run-row-top">
            <div>
              <div class="run-row-title">${escapeHtml(run.scenarioName)}</div>
              <div class="run-row-subtext mono">${escapeHtml(run.runId.slice(0, 8))}${run.ticketId ? ` - ticket ${escapeHtml(run.ticketId.slice(0, 8))}` : ''}</div>
            </div>
            <span class="pill ${escapeHtml(pillClassForRun(run))}">${escapeHtml(run.status)}</span>
          </div>
          <div class="run-row-bottom">
            <div class="latest-event">${escapeHtml(run.latestEvent?.message || 'Waiting for events...')}</div>
            <div class="mono-subtext">${escapeHtml(formatTimestamp(run.updatedAt))}</div>
          </div>
        </button>
      `;
    }).join('');
  }

  renderRunDetail() {
    const run = this.state.selectedRun;
    if (!run) {
      this.elements.detailHeading.textContent = 'Choose a run';
      this.elements.runDetail.innerHTML = 'Start a preset or select a recent run to inspect the trace.';
      this.elements.runDetail.className = 'run-detail-empty';
      return;
    }

    this.elements.detailHeading.textContent = run.scenario.name;
    this.elements.runDetail.className = '';
    this.elements.runDetail.innerHTML = `
      <div class="detail-layout">
        ${renderDetailHero(run)}
        <div class="detail-columns">
          <section class="subpanel">
            <h4>Event Timeline</h4>
            ${renderEventTimeline(run.events)}
          </section>
          <section class="subpanel">
            <h4>Assessment</h4>
            ${renderAssessment(run.assessment)}
          </section>
        </div>
        <section class="subpanel">
          <h4>Ticket Flow</h4>
          <p class="subpanel-copy">Chronological state changes recorded for the parent ticket.</p>
          ${renderFlowRibbon(run.artifacts?.statusHistory || [])}
        </section>
        <div class="detail-columns">
          <section class="subpanel">
            <h4>Ticket Snapshot</h4>
            ${renderTicketSnapshot(run)}
          </section>
          <section class="subpanel">
            <h4>Artifacts</h4>
            ${renderArtifactSummary(run.artifacts)}
          </section>
        </div>
        <div class="detail-columns">
          <section class="subpanel">
            <h4>Work Items</h4>
            ${renderWorkItems(run.artifacts?.workItems || [])}
          </section>
          <section class="subpanel">
            <h4>Child Tickets</h4>
            ${renderChildTickets(run.artifacts?.childTickets || [])}
          </section>
        </div>
        <div class="detail-columns">
          <section class="subpanel">
            <h4>Runtime Trace</h4>
            ${renderTrace(run.artifacts?.trace)}
          </section>
          <section class="subpanel">
            <h4>Related Swarm Runs</h4>
            ${renderSwarmRuns(run.artifacts?.relatedSwarmRuns || [])}
          </section>
        </div>
      </div>
    `;
  }

  setStatus(message, tone) {
    this.elements.statusBanner.textContent = message;
    this.elements.statusBanner.dataset.tone = tone;
  }
}

function renderDetailHero(run) {
  const latestTicketStatus = run.ticketStatus || run.artifacts?.ticket?.status || 'unknown';
  return `
    <section class="detail-hero">
      <div class="detail-hero-top">
        <div>
          <p class="panel-eyebrow">Run Overview</p>
          <h3>${escapeHtml(run.scenario.name)}</h3>
          <div class="row-subtext">${escapeHtml(run.scenario.goal)}</div>
        </div>
        <div class="detail-meta">
          <span class="pill ${escapeHtml(pillClassForRun(run))}">${escapeHtml(run.status)}</span>
          <span class="pill ${escapeHtml(ticketPillClass(latestTicketStatus))}">${escapeHtml(latestTicketStatus)}</span>
        </div>
      </div>
      <div class="stage-ribbon">
        ${(run.steps || []).map((step) => `
          <article class="stage-card" data-status="${escapeHtml(step.status)}">
            <div class="stage-label">${escapeHtml(step.label)}</div>
            <span class="stage-value">${escapeHtml(step.status)}</span>
            <div class="stage-note">${escapeHtml(step.message || 'Pending')}</div>
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

function renderEventTimeline(events) {
  if (!events.length) {
    return `<div class="empty-state">No events recorded yet.</div>`;
  }

  return `
    <div class="timeline-list">
      ${events.slice().reverse().map((event) => `
        <article class="timeline-item">
          <div class="timeline-meta">
            <span class="pill ${escapeHtml(event.level === 'error' ? 'high' : event.level === 'warning' ? 'medium' : 'low')}">${escapeHtml(event.level)}</span>
            <span class="mono-subtext">${escapeHtml(formatTimestamp(event.at))}</span>
          </div>
          <p class="timeline-message">${escapeHtml(event.message)}</p>
          ${event.data ? `<pre class="preformatted">${escapeHtml(JSON.stringify(event.data, null, 2))}</pre>` : ''}
        </article>
      `).join('')}
    </div>
  `;
}

function renderAssessment(assessment) {
  if (!assessment) {
    return `<div class="empty-state">Assessment has not been generated yet.</div>`;
  }

  return `
    <div class="assessment-status">
      <span class="status-dot ${escapeHtml(assessment.status)}"></span>
      <strong>${escapeHtml(assessment.status)}</strong>
    </div>
    <p class="subpanel-copy">${escapeHtml(assessment.heuristicSummary)}</p>
    <div class="finding-list">
      ${(assessment.findings || []).map((finding) => `
        <article class="finding-item" data-severity="${escapeHtml(finding.severity)}">
          <div class="finding-meta">
            <span class="pill ${escapeHtml(finding.severity === 'error' ? 'high' : finding.severity === 'warning' ? 'medium' : 'low')}">${escapeHtml(finding.severity)}</span>
            <span class="mono-subtext">${escapeHtml(finding.code)}</span>
          </div>
          <p class="finding-message">${escapeHtml(finding.message)}</p>
        </article>
      `).join('')}
    </div>
    ${assessment.aiSummary ? `
      <h4>AI Summary</h4>
      <pre class="preformatted">${escapeHtml(assessment.aiSummary)}</pre>
    ` : ''}
    ${assessment.aiSummaryError ? `
      <h4>AI Summary Error</h4>
      <div class="empty-state">${escapeHtml(assessment.aiSummaryError)}</div>
    ` : ''}
  `;
}

function renderFlowRibbon(statusHistory) {
  if (!statusHistory.length) {
    return `<div class="empty-state">No ticket status history was captured yet.</div>`;
  }

  return `
    <div class="flow-ribbon">
      ${dedupeStatusHistory(statusHistory).map(renderFlowChip).join('')}
    </div>
  `;
}

function renderFlowChip(entry) {
  const metadata = normalizeHistoryMetadata(entry);
  const activity = buildInternalActivityChip(metadata);
  const label = activity?.label || entry.toStatus;
  const pillClass = activity ? activity.pillClass : ticketPillClass(entry.toStatus);
  const detail = activity?.detail ? `<span class="mono-subtext">${escapeHtml(activity.detail)}</span>` : '';
  return `
    <div class="flow-chip" title="${escapeHtml(activity?.title || entry.toStatus)}">
      <span class="pill ${escapeHtml(pillClass)}">${escapeHtml(label)}</span>
      ${detail}
      <span class="mono-subtext">${escapeHtml(formatTimestamp(entry.createdAt))}</span>
    </div>
  `;
}

function normalizeHistoryMetadata(entry) {
  const raw = entry?.metadata;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

function readMetadataString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function buildInternalActivityChip(metadata) {
  const event = readMetadataString(metadata.event);
  const isInternalActivity = metadata.internalActivity === true
    || metadata.internalComment === true
    || readMetadataString(metadata.source) === 'swarm-agent-worker'
    || event.startsWith('execution_');
  if (!isInternalActivity) return null;

  const labels = {
    execution_started: 'worker start',
    execution_heartbeat: 'heartbeat',
    execution_finished: 'worker done',
    execution_failed: 'worker failed',
  };
  const elapsedMs = Number(metadata.elapsedMs);
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs >= 0 ? `${Math.round(elapsedMs / 1000)}s` : '';
  const agentId = readMetadataString(metadata.agentId);
  const failureClass = readMetadataString(metadata.failureClass);
  const detail = [agentId, elapsed ? `elapsed ${elapsed}` : '', failureClass.replace(/_/g, ' ')].filter(Boolean).join(' | ');
  return {
    label: labels[event] || 'worker note',
    title: detail || labels[event] || 'worker note',
    detail,
    pillClass: event === 'execution_failed' || metadata.resultSuccess === false ? 'high' : event === 'execution_finished' ? 'low' : 'medium',
  };
}

function renderTicketSnapshot(run) {
  const ticket = run.artifacts?.ticket;
  if (!ticket) {
    return `<div class="empty-state">Ticket details are not available.</div>`;
  }

  return `
    <div class="ticket-grid">
      ${renderKvCard('Ticket ID', ticket.ticketId, true)}
      ${renderKvCard('Status', ticket.status)}
      ${renderKvCard('State Group', ticket.stateGroup)}
      ${renderKvCard('Priority', ticket.priority)}
      ${renderKvCard('Workspace', ticket.workspaceId || 'None', true)}
      ${renderKvCard('Scenario', run.scenario.id)}
    </div>
  `;
}

function renderArtifactSummary(artifacts) {
  if (!artifacts) {
    return `<div class="empty-state">Artifacts have not been collected yet.</div>`;
  }

  return `
    <div class="artifact-grid">
      ${renderKvCard('Status Changes', String((artifacts.statusHistory || []).length))}
      ${renderKvCard('Child Tickets', String((artifacts.childTickets || []).length))}
      ${renderKvCard('Work Items', String((artifacts.workItems || []).length))}
      ${renderKvCard('Swarm Runs', String((artifacts.relatedSwarmRuns || []).length))}
      ${renderKvCard('Trace Count', String(artifacts.trace?.traceCount || 0))}
      ${renderKvCard('Anomalies', String(artifacts.trace?.anomalyCount || 0))}
    </div>
  `;
}

function renderWorkItems(workItems) {
  if (!workItems.length) {
    return `<div class="empty-state">No work items were linked to this ticket.</div>`;
  }

  return `
    <div class="table-shell">
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Status</th>
            <th>Agent</th>
            <th>Outputs</th>
          </tr>
        </thead>
        <tbody>
          ${workItems.map((item) => `
            <tr>
              <td>
                <strong>${escapeHtml(item.title)}</strong>
                <div class="mono-subtext mono">${escapeHtml(item.unitId)}</div>
              </td>
              <td>${escapeHtml(item.status)}</td>
              <td>${escapeHtml(item.assignedAgentId || 'Unassigned')}</td>
              <td>${escapeHtml(formatWorkItemOutputs(item))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderChildTickets(childTickets) {
  if (!childTickets.length) {
    return `<div class="empty-state">No child tickets were linked to this parent.</div>`;
  }

  return `
    <div class="simple-list">
      ${childTickets.map((ticket) => `
        <article class="simple-item">
          <div class="timeline-meta">
            <strong>${escapeHtml(ticket.title)}</strong>
            <span class="pill ${escapeHtml(ticketPillClass(ticket.status))}">${escapeHtml(ticket.status)}</span>
          </div>
          <div class="mono-subtext mono">${escapeHtml(ticket.ticketId)}</div>
        </article>
      `).join('')}
    </div>
  `;
}

function renderTrace(trace) {
  if (!trace) {
    return `<div class="empty-state">No runtime trace summary was available for this run.</div>`;
  }

  return `
    <div class="artifact-grid">
      ${renderKvCard('Workspace Task', trace.workspaceTaskId, true)}
      ${renderKvCard('Trace Count', String(trace.traceCount))}
      ${renderKvCard('Regression Handoffs', String(trace.regressionCount))}
    </div>
    ${trace.anomalies.length ? `
      <div class="finding-list">
        ${trace.anomalies.map((anomaly) => `
          <article class="finding-item" data-severity="warning">
            <div class="finding-meta">
              <span class="pill medium">${escapeHtml(anomaly.type)}</span>
              <span class="mono-subtext mono">${escapeHtml(anomaly.runtimeTaskId.slice(0, 8))}</span>
            </div>
            <p class="finding-message">${escapeHtml(anomaly.detail)}</p>
          </article>
        `).join('')}
      </div>
    ` : '<div class="empty-state">No trace anomalies were detected.</div>'}
  `;
}

function renderSwarmRuns(runs) {
  if (!runs.length) {
    return `<div class="empty-state">No related swarm run records were found.</div>`;
  }

  return `
    <div class="simple-list">
      ${runs.map((run) => `
        <article class="simple-item">
          <div class="timeline-meta">
            <strong>${escapeHtml(run.runId.slice(0, 8))}</strong>
            <span class="pill ${escapeHtml(run.status === 'failed' ? 'high' : run.status === 'in_progress' ? 'medium' : 'low')}">${escapeHtml(run.status)}</span>
          </div>
          <p class="timeline-message">Items: ${escapeHtml(String(run.itemCount))} - Processed entries: ${escapeHtml(String((run.processed || []).length))}</p>
          <div class="mono-subtext">${escapeHtml(formatTimestamp(run.startedAt))}</div>
        </article>
      `).join('')}
    </div>
  `;
}

function renderKvCard(label, value, mono = false) {
  return `
    <article class="kv-card">
      <span class="kv-label">${escapeHtml(label)}</span>
      <span class="kv-value ${mono ? 'mono' : ''}">${escapeHtml(value)}</span>
    </article>
  `;
}

function formatWorkItemOutputs(item) {
  const parts = [];
  if (item.hasExecutionOutput) {
    parts.push('execution');
  }
  if (item.hasVerificationResult) {
    parts.push('verification');
  }
  return parts.length ? parts.join(' + ') : 'none';
}

function dedupeStatusHistory(statusHistory) {
  const deduped = [];
  for (const entry of statusHistory) {
    const previous = deduped[deduped.length - 1];
    if (!previous || previous.toStatus !== entry.toStatus) {
      deduped.push(entry);
    }
  }
  return deduped;
}

function pillClassForRun(run) {
  if (run.status === 'failed') {
    return 'high';
  }
  if (run.assessmentStatus === 'failed' || run.assessmentStatus === 'attention') {
    return 'medium';
  }
  return 'low';
}

function ticketPillClass(status) {
  if (status === 'escalated' || status === 'cancelled') {
    return 'high';
  }
  if (status === 'approval_required' || status === 'customer_action') {
    return 'medium';
  }
  return 'low';
}

function formatDuration(ms) {
  const minutes = Math.round((Number(ms) || 0) / 60000);
  return `${minutes} min`;
}

function formatTimestamp(value) {
  if (!value) {
    return 'Unknown';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function setText(element, value) {
  if (element) {
    element.textContent = value;
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || `Request failed with status ${response.status}`);
  }

  return payload;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const app = new ProcessLabApp();
void app.init();
