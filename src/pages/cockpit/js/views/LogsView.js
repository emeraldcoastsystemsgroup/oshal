/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — searchable log viewer with ticket-trace, level, module, and time-range filters
 */

import { ApiClient } from '../api-client.js';
import { createUiLogger } from '../../../shared/ui-debug.js';

const logger = createUiLogger('cockpit-logs-view');

/**
 * @description Searchable log viewer for the cockpit.
 * Reads structured pino JSON logs from the backend, filterable by
 * ticket ID (with trace support for child tickets), level, module, and free text.
 */
export class LogsView {
  constructor(container) {
    this.container = typeof container === 'string' ? document.getElementById(container) : container;
    this.api = new ApiClient();
    this.entries = [];
    this.modules = [];
    this.meta = { total: 0, hasMore: false };
    this.filters = { ticketId: '', level: '', module: '', search: '', range: '1h' };
    this.refreshTimer = null;
    this.autoRefresh = false;
    this.debounceTimer = null;
  }

  async render() {
    if (!this.container) return;
    this.container.innerHTML = this._shell();
    this._bindEvents();
    await this._loadModules();
    await this._loadLogs();
  }

  destroy() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.container) this.container.innerHTML = '';
  }

  // ── Shell ───────────────────────────────────────────────────────

  _shell() {
    return `<div class="logs-view">
      <div class="logs-header">
        <div class="logs-title"><i class="codicon codicon-output"></i> Logs</div>
        <div class="logs-filters">
          <div class="logs-filter-group">
            <input type="text" id="logsSearch" class="logs-input logs-search" placeholder="Search..." title="Free text search" />
          </div>
          <div class="logs-filter-group">
            <input type="text" id="logsTicketId" class="logs-input logs-ticket" placeholder="Ticket ID" title="Filter by ticket (includes children)" />
          </div>
          <div class="logs-filter-group">
            <select id="logsLevel" class="logs-select" title="Log level">
              <option value="">All levels</option>
              <option value="error">Error</option>
              <option value="warn">Warn</option>
              <option value="info">Info</option>
              <option value="debug">Debug</option>
            </select>
          </div>
          <div class="logs-filter-group">
            <select id="logsModule" class="logs-select" title="Module">
              <option value="">All modules</option>
            </select>
          </div>
          <div class="logs-filter-group logs-range-group">
            <button class="logs-range-btn active" data-range="15m">15m</button>
            <button class="logs-range-btn" data-range="1h">1h</button>
            <button class="logs-range-btn" data-range="6h">6h</button>
            <button class="logs-range-btn" data-range="24h">24h</button>
            <button class="logs-range-btn" data-range="all">All</button>
          </div>
        </div>
        <div class="logs-actions">
          <button class="logs-action-btn" id="logsAutoRefresh" title="Auto-refresh (10s)">
            <i class="codicon codicon-sync"></i>
          </button>
          <button class="logs-action-btn" id="logsRefresh" title="Refresh">
            <i class="codicon codicon-refresh"></i>
          </button>
        </div>
      </div>
      <div class="logs-status" id="logsStatus"></div>
      <div class="logs-body" id="logsBody">
        <div class="logs-loading"><i class="codicon codicon-loading codicon-modifier-spin"></i></div>
      </div>
    </div>`;
  }

  // ── Events ──────────────────────────────────────────────────────

  _bindEvents() {
    const c = this.container;

    // Text search (debounced)
    c.querySelector('#logsSearch')?.addEventListener('input', (e) => {
      this.filters.search = e.target.value;
      this._debouncedLoad();
    });

    // Ticket ID (debounced)
    c.querySelector('#logsTicketId')?.addEventListener('input', (e) => {
      this.filters.ticketId = e.target.value.trim();
      this._debouncedLoad();
    });

    // Level select
    c.querySelector('#logsLevel')?.addEventListener('change', (e) => {
      this.filters.level = e.target.value;
      this._loadLogs();
    });

    // Module select
    c.querySelector('#logsModule')?.addEventListener('change', (e) => {
      this.filters.module = e.target.value;
      this._loadLogs();
    });

    // Time range buttons
    c.querySelectorAll('.logs-range-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        c.querySelectorAll('.logs-range-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.filters.range = btn.dataset.range;
        this._loadLogs();
      });
    });

    // Refresh
    c.querySelector('#logsRefresh')?.addEventListener('click', () => this._loadLogs());

    // Auto-refresh toggle
    c.querySelector('#logsAutoRefresh')?.addEventListener('click', () => {
      this.autoRefresh = !this.autoRefresh;
      c.querySelector('#logsAutoRefresh')?.classList.toggle('active', this.autoRefresh);
      if (this.autoRefresh) {
        this.refreshTimer = setInterval(() => this._loadLogs(), 10000);
      } else if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
      }
    });

    // Set default range
    this.filters.range = '1h';
    c.querySelector('.logs-range-btn[data-range="1h"]')?.classList.add('active');
    c.querySelector('.logs-range-btn[data-range="15m"]')?.classList.remove('active');
  }

  _debouncedLoad() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this._loadLogs(), 300);
  }

  // ── Data loading ────────────────────────────────────────────────

  async _loadModules() {
    try {
      const result = await this.api.getSafe('/api/v1/logs/modules', { modules: [] });
      this.modules = result.modules || [];
      const select = this.container.querySelector('#logsModule');
      if (select) {
        const current = select.value;
        select.innerHTML = '<option value="">All modules</option>' +
          this.modules.map(m => `<option value="${m}"${m === current ? ' selected' : ''}>${m}</option>`).join('');
      }
    } catch (err) {
      logger.warn('Failed to load log modules', err);
    }
  }

  async _loadLogs() {
    const params = new URLSearchParams();
    if (this.filters.ticketId) params.set('ticketId', this.filters.ticketId);
    if (this.filters.level) params.set('level', this.filters.level);
    if (this.filters.module) params.set('module', this.filters.module);
    if (this.filters.search) params.set('search', this.filters.search);

    const since = this._rangeToSince(this.filters.range);
    if (since) params.set('since', since);

    params.set('limit', '500');

    try {
      const result = await this.api.getSafe(`/api/v1/logs/query?${params}`, { data: [], meta: {} });
      this.entries = result.data || [];
      this.meta = result.meta || { total: 0, hasMore: false };
      this._renderBody();
      this._renderStatus();
    } catch (err) {
      logger.warn('Failed to load logs', err);
      this._renderError();
    }
  }

  _rangeToSince(range) {
    if (range === 'all') return null;
    const ms = { '15m': 15 * 60000, '1h': 3600000, '6h': 6 * 3600000, '24h': 24 * 3600000 };
    return new Date(Date.now() - (ms[range] || 3600000)).toISOString();
  }

  // ── Rendering ───────────────────────────────────────────────────

  _renderStatus() {
    const el = this.container.querySelector('#logsStatus');
    if (!el) return;
    const parts = [`${this.meta.total} entries`];
    if (this.meta.hasMore) parts.push('(truncated)');
    if (this.filters.ticketId) parts.push(`ticket: ${this.filters.ticketId.slice(0, 12)}...`);
    el.textContent = parts.join(' \u00b7 ');
  }

  _renderBody() {
    const body = this.container.querySelector('#logsBody');
    if (!body) return;

    if (this.entries.length === 0) {
      body.innerHTML = '<div class="logs-empty">No log entries match the current filters</div>';
      return;
    }

    body.innerHTML = `<div class="logs-table">${this.entries.map((e, i) => this._renderRow(e, i)).join('')}</div>`;

    // Bind row expansion
    body.querySelectorAll('.logs-row').forEach((row) => {
      row.addEventListener('click', () => {
        row.classList.toggle('expanded');
      });
    });

    // Bind ticket ID clicks in detail
    body.querySelectorAll('.logs-detail-ticket').forEach((link) => {
      link.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const tid = link.dataset.ticketId;
        const input = this.container.querySelector('#logsTicketId');
        if (input && tid) {
          input.value = tid;
          this.filters.ticketId = tid;
          this._loadLogs();
        }
      });
    });
  }

  _renderRow(entry, index) {
    const time = this._formatTime(entry.time);
    const lvl = (entry.levelLabel || 'info').toLowerCase();
    const mod = entry.module || '';
    const msg = this._escapeHtml(entry.msg || '').slice(0, 200);
    const detail = this._renderDetail(entry);

    return `<div class="logs-row" data-index="${index}">
      <div class="logs-row-summary">
        <span class="logs-time">${time}</span>
        <span class="logs-level logs-level-${lvl}">${lvl}</span>
        <span class="logs-module">${this._escapeHtml(mod)}</span>
        <span class="logs-msg">${msg}</span>
      </div>
      <div class="logs-row-detail">${detail}</div>
    </div>`;
  }

  _renderDetail(entry) {
    const skip = new Set(['level', 'levelLabel', 'time', 'msg', 'name', 'pid', 'hostname', 'v', 'service', 'env']);
    const fields = Object.entries(entry)
      .filter(([k]) => !skip.has(k) && entry[k] !== undefined && entry[k] !== null && entry[k] !== '')
      .map(([k, v]) => {
        const val = typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
        const isTicket = k === 'ticketId';
        const valHtml = isTicket
          ? `<span class="logs-detail-ticket" data-ticket-id="${this._escapeHtml(String(v))}">${this._escapeHtml(val)}</span>`
          : this._escapeHtml(val);
        return `<div class="logs-detail-field"><span class="logs-detail-key">${this._escapeHtml(k)}</span><span class="logs-detail-val">${valHtml}</span></div>`;
      });
    return fields.length > 0 ? fields.join('') : '<div class="logs-detail-field"><span class="logs-detail-key">No additional fields</span></div>';
  }

  _renderError() {
    const body = this.container.querySelector('#logsBody');
    if (body) body.innerHTML = '<div class="logs-empty">Failed to load logs</div>';
  }

  // ── Helpers ─────────────────────────────────────────────────────

  _formatTime(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    } catch { return iso; }
  }

  _escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
