/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Initial searchable structured log viewer.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Connect native traces and administrator levels; show refused reads and actual buffer retention.
 */

import { createUiLogger } from '../../../shared/ui-debug.js';
import { escapeLoggingHtml, loggingLevel, loggingQuery, loggingRequest, loggingStatus } from './logging-reader.js';
import { LoggingSettings } from './logging-settings.js';

const logger = createUiLogger('cockpit-logs-view');

/** @description Search admitted structured logs without concealing access or backend failures.
 * @param {HTMLElement|string} container The current cockpit view host.
 * @returns {LogsView} A disposable view with bounded queries and explicit runtime controls.
 */
export class LogsView {
  constructor(container) {
    this.container = typeof container === 'string' ? document.getElementById(container) : container;
    this.entries = [];
    this.modules = [];
    this.meta = { total: 0, hasMore: false };
    this.source = '';
    this.filters = { ticketId: '', traceId: '', level: '', module: '', search: '', range: '1h' };
    this.refreshTimer = null;
    this.autoRefresh = false;
    this.debounceTimer = null;
    this.requestVersion = 0;
    this.destroyed = false;
    this.settings = null;
  }

  /** @description Start the viewer and current administrator settings read.
   * @returns {Promise<void>} Completion of independent initial reads.
   */
  async render() {
    if (!this.container) return;
    this.container.innerHTML = this._shell();
    this._bindEvents();
    this.settings = new LoggingSettings(this.container.querySelector('#loggingSettings'));
    await Promise.all([this._loadModules(), this._loadLogs(), this.settings.render()]);
  }

  /** @description Stop polling and prevent late responses from replacing another view.
   * @returns {void} No further render activity.
   */
  destroy() {
    this.destroyed = true;
    this.requestVersion++;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.settings?.destroy();
    if (this.container) this.container.innerHTML = '';
  }

  _shell() {
    return `<div class="logs-view"><div class="logs-header">
      <div class="logs-title"><i class="codicon codicon-output"></i> Logs</div>
      ${this._filterShell()}
      <div class="logs-actions">
        <button class="logs-action-btn" id="logsAutoRefresh" title="Auto-refresh (10s)" aria-label="Auto-refresh logs"><i class="codicon codicon-sync"></i></button>
        <button class="logs-action-btn" id="logsRefresh" title="Refresh" aria-label="Refresh logs"><i class="codicon codicon-refresh"></i></button>
      </div></div>
      <div id="loggingSettings"></div>
      <div class="logs-status" id="logsStatus" role="status" aria-live="polite"></div>
      <div class="logs-body" id="logsBody"><div class="logs-loading">Loading logs…</div></div></div>`;
  }

  _filterShell() {
    const levels = ['error', 'warn', 'info', 'debug', 'trace'];
    const ranges = ['15m', '1h', '6h', '24h', 'all'];
    return `<div class="logs-filters">
      <input type="search" id="logsSearch" class="logs-input logs-search" placeholder="Search…" aria-label="Search logs" maxlength="256" />
      <input type="text" id="logsTicketId" class="logs-input logs-ticket" placeholder="Ticket ID" aria-label="Ticket ID" maxlength="96" />
      <input type="text" id="logsTraceId" class="logs-input logs-ticket" placeholder="Trace ID" aria-label="Trace ID" maxlength="96" />
      <select id="logsLevel" class="logs-select" aria-label="Filter log level"><option value="">All levels</option>${levels.map(level => `<option value="${level}">${level}</option>`).join('')}</select>
      <select id="logsModule" class="logs-select" aria-label="Filter module"><option value="">All modules</option></select>
      <div class="logs-range-group">${ranges.map(range => `<button class="logs-range-btn${range === '1h' ? ' active' : ''}" data-range="${range}">${range === 'all' ? 'All retained' : range}</button>`).join('')}</div>
    </div>`;
  }

  _bindEvents() {
    const c = this.container;
    for (const [id, key] of [['logsSearch', 'search'], ['logsTicketId', 'ticketId'], ['logsTraceId', 'traceId']]) {
      c.querySelector(`#${id}`).addEventListener('input', event => {
        this.filters[key] = event.target.value.trim();
        this._debouncedLoad();
      });
    }
    for (const [id, key] of [['logsLevel', 'level'], ['logsModule', 'module']]) {
      c.querySelector(`#${id}`).addEventListener('change', event => {
        this.filters[key] = event.target.value;
        this._loadLogs();
      });
    }
    c.querySelectorAll('.logs-range-btn').forEach(button => button.addEventListener('click', () => {
      c.querySelectorAll('.logs-range-btn').forEach(item => item.classList.remove('active'));
      button.classList.add('active');
      this.filters.range = button.dataset.range;
      this._loadLogs();
    }));
    c.querySelector('#logsRefresh').addEventListener('click', () => this._loadLogs());
    c.querySelector('#logsAutoRefresh').addEventListener('click', () => this._toggleRefresh());
  }

  _toggleRefresh() {
    this.autoRefresh = !this.autoRefresh;
    this.container.querySelector('#logsAutoRefresh').classList.toggle('active', this.autoRefresh);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = this.autoRefresh ? setInterval(() => this._loadLogs(), 10000) : null;
  }

  _debouncedLoad() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this._loadLogs(), 300);
  }

  async _loadModules() {
    try {
      const result = await loggingRequest('/api/v1/logs/modules');
      if (this.destroyed) return;
      if (!Array.isArray(result.modules)) throw new Error('The logging module response is invalid.');
      this.modules = result.modules;
      const select = this.container.querySelector('#logsModule');
      select.innerHTML = '<option value="">All modules</option>' + this.modules.map(module =>
        `<option value="${escapeLoggingHtml(module)}">${escapeLoggingHtml(module)}</option>`).join('');
      select.value = this.filters.module;
    } catch (error) {
      logger.error('logging-modules-read-failed', { err: new Error('Logging modules read failed'), status: error.status || 'transport' });
    }
  }

  async _loadLogs() {
    const version = ++this.requestVersion;
    const params = loggingQuery(this.filters, this._rangeToSince(this.filters.range));
    try {
      const result = await loggingRequest(`/api/v1/logs/query?${params}`);
      if (this.destroyed || version !== this.requestVersion) return;
      if (!Array.isArray(result.data) || !result.meta) throw new Error('The log response is invalid.');
      this.entries = result.data;
      this.meta = result.meta;
      this.source = result.source || '';
      this._renderBody();
      this._renderStatus();
    } catch (error) {
      logger.error('logging-query-failed', { err: new Error('Logging query failed'), status: error.status || 'transport' });
      if (!this.destroyed && version === this.requestVersion) this._renderError(error.message);
    }
  }

  _rangeToSince(range) {
    if (range === 'all') return null;
    const ms = { '15m': 900000, '1h': 3600000, '6h': 21600000, '24h': 86400000 };
    return new Date(Date.now() - (ms[range] || 3600000)).toISOString();
  }

  _renderStatus() {
    this.container.querySelector('#logsStatus').textContent = loggingStatus(this.meta, this.source);
  }

  _renderBody() {
    const body = this.container.querySelector('#logsBody');
    if (!this.entries.length) {
      body.innerHTML = '<div class="logs-empty">No retained entries match the current filters.</div>';
      return;
    }
    body.innerHTML = `<div class="logs-table">${this.entries.map((entry, index) => this._renderRow(entry, index)).join('')}</div>`;
    body.querySelectorAll('.logs-row').forEach(row => row.addEventListener('click', () => row.classList.toggle('expanded')));
    body.querySelectorAll('[data-log-filter]').forEach(link => link.addEventListener('click', event => {
      event.stopPropagation();
      const key = link.dataset.logFilter;
      const id = key === 'traceId' ? 'logsTraceId' : 'logsTicketId';
      this.filters[key] = link.dataset.logValue;
      this.container.querySelector(`#${id}`).value = this.filters[key];
      this._loadLogs();
    }));
  }

  _renderRow(entry, index) {
    const level = loggingLevel(entry.levelLabel);
    return `<div class="logs-row" data-index="${index}"><div class="logs-row-summary">
      <span class="logs-time">${escapeLoggingHtml(this._formatTime(entry.time))}</span>
      <span class="logs-level logs-level-${level}">${level}</span>
      <span class="logs-module">${escapeLoggingHtml(entry.module)}</span>
      <span class="logs-msg">${escapeLoggingHtml(String(entry.msg || '').slice(0, 200))}</span>
      </div><div class="logs-row-detail">${this._renderDetail(entry)}</div></div>`;
  }

  _renderDetail(entry) {
    const skip = new Set(['level', 'levelLabel', 'time', 'msg', 'name', 'pid', 'hostname', 'v', 'service', 'env']);
    const fields = Object.entries(entry).filter(([key, value]) => !skip.has(key) && value != null && value !== '').map(([key, value]) => {
      const text = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
      const linked = key === 'ticketId' || key === 'traceId';
      const rendered = linked ? `<button class="logs-detail-ticket" type="button" data-log-filter="${key}" data-log-value="${escapeLoggingHtml(value)}">${escapeLoggingHtml(text)}</button>` : escapeLoggingHtml(text);
      return `<div class="logs-detail-field"><span class="logs-detail-key">${escapeLoggingHtml(key)}</span><span class="logs-detail-val">${rendered}</span></div>`;
    });
    return fields.join('') || '<div class="logs-detail-field">No additional fields</div>';
  }

  _renderError(message) {
    this.container.querySelector('#logsStatus').textContent = 'Log read failed.';
    this.container.querySelector('#logsBody').innerHTML = `<div class="logs-empty" role="alert">${escapeLoggingHtml(message)}</div>`;
  }

  _formatTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
    });
  }
}
