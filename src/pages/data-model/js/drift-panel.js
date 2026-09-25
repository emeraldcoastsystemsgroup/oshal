/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Operator schema diff and explicit reviewed-fingerprint baseline capture, with honest detector state and text-only evidence rendering.
 */

import { createUiLogger, serializeUiError } from '../../shared/ui-debug.js';
const logger = createUiLogger('data-model-drift');
const API = '/api/admin/data-model/drift';

function cell(row, text, tag = 'td') {
  const node = document.createElement(tag);
  node.textContent = text;
  row.append(node);
}

/**
 * @description Render the same structure-only change list that the detector publishes.
 * @param {HTMLElement} root - Dedicated explorer panel.
 * @returns {{load: (refresh?: boolean) => Promise<void>}} Read-only refresh handle.
 */
export function createDriftPanel(root) {
  return new DriftPanel(root);
}

class DriftPanel {
  constructor(root) {
    this.root = root;
    this.current = null;
    this.busy = false;
    this.summary = root.querySelector('[data-drift-summary]');
    this.note = root.querySelector('[data-drift-note]');
    this.table = root.querySelector('table');
    this.rows = root.querySelector('tbody');
    this.capture = root.querySelector('[data-drift-capture]');
    this.refresh = root.querySelector('[data-drift-refresh]');
    this.refresh.addEventListener('click', () => { void this.load(true); });
    this.capture.addEventListener('click', () => { void this.acknowledge(); });
  }

  /** @description Show comparison evidence without interpreting catalog names as markup.
   * @param {object} body - Operator comparison response.
   * @returns {void}
   */
  render(body) {
    this.current = body;
    const report = body.report;
    const state = body.available ? report?.state ?? 'unavailable' : 'unavailable';
    this.summary.textContent = `What changed since baseline — ${state}`;
    this.root.dataset.state = state;
    this.note.textContent = [body.unavailableReason || report?.reason,
      state === 'first-run' ? 'Record an initial baseline to begin automatic comparisons.' : '',
      state === 'explained' ? 'Review and record the migrated shape before monitoring later unexplained changes.' : '',
      body.monitor ? `Detector: ${body.monitor.state}. ${body.monitor.detail} ${body.monitor.checkedAt ? `Last check: ${body.monitor.checkedAt}` : ''}` : 'Detector status is not available from this server.',
      body.monitor ? 'Checks run every minute.' : 'Automatic monitoring requires a configured compatible server.',
      'Recording a baseline acknowledges the current shape; it does not close an existing ticket.',
    ].filter(Boolean).join(' ');
    this.rows.replaceChildren();
    for (const change of report?.changes ?? []) {
      const row = document.createElement('tr');
      for (const text of [change.relation, change.kind, change.before, change.after]) cell(row, text);
      this.rows.append(row);
    }
    this.table.hidden = !this.rows.childElementCount;
    this.capture.disabled = this.busy || !body.captureSupported || !body.available || !body.digest?.fingerprint;
    if (report?.alarm) this.root.open = true;
  }

  /** @description Read without acknowledging the baseline.
   * @param {boolean} force - Request a fresh catalog snapshot.
   * @returns {Promise<void>}
   */
  async load(force = false) {
    if (this.busy) return;
    this.busy = true;
    this.capture.disabled = true;
    this.refresh.disabled = true;
    try {
      const response = await fetch(`${API}${force ? '?refresh=1' : ''}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `Schema comparison returned HTTP ${response.status}.`);
      this.busy = false;
      this.render(body);
    } catch (error) {
      this.current = null;
      this.rows.replaceChildren();
      this.table.hidden = true;
      this.root.dataset.state = 'unavailable';
      this.summary.textContent = 'What changed since baseline — unavailable';
      this.note.textContent = error.message;
      logger.error('Schema diff read failed', { error: serializeUiError(error) });
    } finally { this.busy = false; this.refresh.disabled = false; }
  }

  /** @description Record only the shape the operator confirmed reviewing.
   * @returns {Promise<void>}
   */
  async acknowledge() {
    const fingerprint = this.current?.digest?.fingerprint;
    if (this.busy || !this.current?.captureSupported || !fingerprint) return;
    if (!window.confirm('Record this reviewed schema as the baseline? This acknowledges the displayed changes. Existing tickets remain open.')) return;
    this.busy = true;
    this.capture.disabled = true;
    this.refresh.disabled = true;
    try {
      const response = await fetch(`${API}/baseline`, { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true, fingerprint }) });
      const body = await response.json();
      if (!response.ok || !body.captured) throw new Error(body.error || body.unavailableReason || 'The baseline was not recorded.');
      this.busy = false;
      await this.load(true);
    } catch (error) {
      logger.error('Schema baseline capture failed', { error: serializeUiError(error) });
      this.note.textContent = error.message;
      this.current = null;
    } finally { this.busy = false; this.refresh.disabled = false; }
  }
}
