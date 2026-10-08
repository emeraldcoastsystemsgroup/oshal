/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Add explicit administrator runtime diagnostic levels without muting audit records.
 */

import { createUiLogger } from '../../../shared/ui-debug.js';
import { escapeLoggingHtml, loggingRequest } from './logging-reader.js';

const logger = createUiLogger('cockpit-logging-settings');
const LEVELS = ['error', 'warn', 'info', 'debug', 'trace'];

/** @description Parse explicit module overrides; reject malformed or duplicate definitions.
 * @param {string} text One module=level declaration per line.
 * @returns {object} A validated finite override map.
 */
export function parseLoggingOverrides(text) {
  const entries = text.split('\n').map(line => line.trim()).filter(Boolean);
  if (entries.length > 32) throw new Error('Use at most 32 module overrides.');
  const result = Object.create(null);
  for (const line of entries) {
    const match = /^([a-zA-Z0-9_][a-zA-Z0-9_:.-]{0,95})\s*=\s*(error|warn|info|debug|trace)$/.exec(line);
    if (!match) throw new Error('Each override must use module=level.');
    if (Object.hasOwn(result, match[1])) throw new Error(`Duplicate module: ${match[1]}`);
    result[match[1]] = match[2];
  }
  return result;
}

/** @description Edit persisted runtime levels through the current administrator session.
 * @param {HTMLElement} container The settings host inside Logs.
 * @returns {LoggingSettings} A panel whose success state follows server acknowledgement.
 */
export class LoggingSettings {
  constructor(container) { this.container = container; this.destroyed = false; this.config = null; }

  /** @description Load effective settings; access refusal stays visible.
   * @returns {Promise<void>} Completion of the admitted configuration read.
   */
  async render() {
    try {
      const config = await loggingRequest('/api/admin/logging');
      if (this.destroyed) return;
      this.validateConfig(config);
      this.config = config;
      this.container.innerHTML = this.shell(config);
      this.renderEffective();
      this.container.querySelector('#loggingApply').addEventListener('click', () => this.apply());
    } catch (error) {
      if (this.destroyed) return;
      logger.error('logging-settings-read-failed', { err: new Error('Logging settings read failed'), status: error.status || 'transport' });
      this.container.textContent = error.message;
    }
  }

  shell(config) {
    const options = LEVELS.map(level => `<option value="${level}"${config.level === level ? ' selected' : ''}>${level}</option>`).join('');
    const overrides = Object.entries(config.module_levels || {}).map(([module, level]) => `${module}=${level}`).join('\n');
    return `<details class="logging-settings"><summary>Logging settings</summary>
      <div class="logging-settings-body"><label>Default diagnostic level
        <select id="loggingDefaultLevel" class="logs-select">${options}</select></label>
      <label>Module overrides <span>one module=level per line</span>
        <textarea id="loggingOverrides" class="logs-input" rows="3" spellcheck="false">${escapeLoggingHtml(overrides)}</textarea></label>
      <p>Changes apply to subsequent diagnostic events. Audit and cost records stay enabled.</p>
      <p id="loggingEffective"></p>
      <button id="loggingApply" class="logs-select" type="button">Apply levels</button>
      <span id="loggingSettingsStatus" role="status" aria-live="polite"></span></div></details>`;
  }

  validateConfig(config) {
    if (!config || !LEVELS.includes(config.level) || !config.module_levels ||
        typeof config.module_levels !== 'object' || Array.isArray(config.module_levels)) {
      throw new Error('The logging settings response is invalid.');
    }
    const text = Object.entries(config.module_levels).map(([module, level]) => `${module}=${level}`).join('\n');
    parseLoggingOverrides(text);
  }

  renderEffective() {
    const overrides = Object.entries(this.config.module_levels).map(([module, level]) => `${module}=${level}`);
    this.container.querySelector('#loggingEffective').textContent =
      `Effective default: ${this.config.level}${overrides.length ? ` · ${overrides.join(', ')}` : ' · no module overrides'}`;
  }

  async apply() {
    const button = this.container.querySelector('#loggingApply');
    const status = this.container.querySelector('#loggingSettingsStatus');
    button.disabled = true;
    status.textContent = 'Saving…';
    try {
      const body = { level: this.container.querySelector('#loggingDefaultLevel').value,
        module_levels: parseLoggingOverrides(this.container.querySelector('#loggingOverrides').value),
        expected_config: { level: this.config.level, module_levels: this.config.module_levels } };
      const config = await loggingRequest('/api/admin/logging', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (this.destroyed) return;
      this.validateConfig(config);
      this.config = config;
      this.renderEffective();
      status.textContent = `Applied: ${config.level}.`;
    } catch (error) {
      if (this.destroyed) return;
      logger.error('logging-settings-update-failed', { err: new Error('Logging settings update failed'), status: error.status || 'validation-or-transport' });
      status.textContent = error.message;
    } finally {
      if (!this.destroyed) button.disabled = false;
    }
  }

  /** @description Prevent a pending read or update from rendering into a departed view.
   * @returns {void} No subsequent panel mutation.
   */
  destroy() { this.destroyed = true; }
}
