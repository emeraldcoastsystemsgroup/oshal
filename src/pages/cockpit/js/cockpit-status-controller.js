/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted cockpit status-bar metrics and cost-indicator orchestration from app.js to enforce shell file-size governance without changing operator behavior
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG "One slow boot drops the task, message and memory stores to in-memory for the life of the process": the status bar now carries the persistence indicator. The retry/registry work made the degraded state real and visible at GET /api/readiness and in oshal-verify.sh, but an operator watching the cockpit still saw a box that looked entirely healthy while a store advertised as durable was writing to a Map. The indicator is silent while persistence is ok/off and speaks only for the two states that need an operator: MEMORY, and unreadable.
 */

import { createUiLogger } from '../../shared/ui-debug.js';
import { formatCost } from './utils/formatters.js';

const logger = createUiLogger('cockpit-status-controller');

/**
 * @description Manage cockpit status-bar metrics, cost-indicator updates, and polling timers.
 */
export class CockpitStatusController {
  /**
   * @description Create a status controller with the cockpit API client used for
   * metrics reads and cost-tracker state.
   *
   * @param {{ api: { getSafe: (endpoint: string, fallback: unknown) => Promise<unknown>, getCostStatus: () => Record<string, unknown> } }} options - Controller collaborators.
   * @returns {void}
   */
  constructor(options) {
    this.api = options.api;
    logger.info('Created cockpit status controller', {
      hasApi: Boolean(this.api),
    });
  }

  /**
   * @description Initialize the cockpit cost indicator and react to future spend updates.
   *
   * @returns {void}
   */
  initCostIndicator() {
    logger.info('Initializing cockpit cost indicator');
    window.addEventListener('cost-updated', (event) => {
      this.updateCostIndicator(event.detail);
    });
    this.updateCostIndicator(this.api.getCostStatus());
  }

  /**
   * @description Load summary metrics and update the cockpit status bar.
   *
   * @returns {Promise<void>} Resolves when the latest summary has been rendered.
   */
  async loadMetrics() {
    logger.debug('Loading cockpit summary metrics');
    const response = await this.api.getSafe('/api/v1/metrics/summary', null);
    if (!response) {
      logger.debug('Cockpit summary metrics returned no response');
      return;
    }

    const data = response.data || response;
    const rawAgents = (data?.agents && typeof data.agents === 'object') ? data.agents.total : data?.agents;
    this.updateStatusBar({
      agents: this.normalizeStatusNumber(rawAgents, 0),
      tickets: this.normalizeStatusNumber(data?.total, 0),
      cost: this.normalizeStatusNumber(data?.estimatedTotalCost, 0),
      queue: this.normalizeStatusNumber(data?.queue, 0),
    });
    logger.debug('Updated cockpit summary metrics', {
      agents: this.normalizeStatusNumber(rawAgents, 0),
      tickets: this.normalizeStatusNumber(data?.total, 0),
      cost: this.normalizeStatusNumber(data?.estimatedTotalCost, 0),
      queue: this.normalizeStatusNumber(data?.queue, 0),
    });
  }

  /**
   * @description Read readiness and render the status-bar persistence indicator.
   *
   * The state this exists for: a store that advertises durable storage, lost its database
   * at boot, and is serving from an in-memory Map. Before this, that fact reached only a
   * boot-log ERROR line, GET /api/readiness and scripts/oshal-verify.sh - never the surface
   * the operator actually watches.
   *
   * @returns {Promise<void>} Resolves once the indicator reflects the latest read.
   */
  async loadPersistence() {
    const report = await this.api.getReadiness();
    this.renderPersistenceIndicator(report);
  }

  /**
   * @description Write one readiness report into the status-bar persistence indicator.
   *
   * Three outcomes, kept apart on purpose:
   *   - `null` report            -> UNKNOWN. Readiness could not be read, so the cockpit does
   *                                 NOT get to imply storage is fine; "could not look" is not
   *                                 "found nothing wrong".
   *   - persistence leg `fail`   -> DEGRADED. A configured store is serving from memory; the
   *                                 leg detail (store, attempts, reason) becomes the tooltip.
   *   - anything else (ok / off) -> hidden. A healthy box, and a deliberately database-less
   *                                 one, add no noise to a four-item status bar.
   *
   * @param {Record<string, unknown>|null} report - The readiness report, or null when unreadable.
   * @returns {void}
   */
  renderPersistenceIndicator(report) {
    const item = document.getElementById('statusPersistenceItem');
    const label = document.getElementById('statusPersistence');
    if (!item || !label) {
      return;
    }

    const leg = report && report.legs ? report.legs.persistence : null;
    const state = leg && typeof leg.state === 'string' ? leg.state : null;

    if (report === null || !state) {
      item.classList.remove('hidden');
      item.dataset.persistenceState = 'unknown';
      label.textContent = 'Storage: unknown';
      label.className = 'status-persistence status-warning';
      item.title = 'Readiness could not be read, so durable storage is unverified — not confirmed healthy.';
      logger.warn('Cockpit persistence indicator unreadable', { hasReport: report !== null });
      return;
    }

    if (state === 'fail') {
      item.classList.remove('hidden');
      item.dataset.persistenceState = 'degraded';
      label.textContent = 'Storage: IN MEMORY';
      label.className = 'status-persistence status-error';
      item.title = `Degraded persistence — writes are lost on restart. ${leg.detail || 'no detail'}`;
      logger.warn('Cockpit persistence indicator degraded', { detail: leg.detail });
      return;
    }

    item.classList.add('hidden');
    item.dataset.persistenceState = state;
    label.textContent = '';
    label.className = 'status-persistence';
    item.title = leg.detail || '';
    logger.debug('Cockpit persistence indicator healthy', { state });
  }

  /**
   * @description Start the recurring cockpit polling cadence for metrics and live bot refreshes.
   *
   * @param {{ refreshBots?: () => Promise<void> | void }} [options] - Optional polling callbacks.
   * @returns {number[]} Polling timer ids.
   */
  startPolling(options = {}) {
    logger.info('Starting cockpit status polling', {
      hasRefreshBots: typeof options.refreshBots === 'function',
    });
    const timers = [
      window.setInterval(() => void this.loadMetrics(), 30000),
      // Readiness is heavier than the metrics summary (redis, disk, a db ping), so the
      // persistence indicator runs on its own slower cadence rather than doubling the
      // 30s metrics poll.
      window.setInterval(() => void this.loadPersistence(), 60000),
    ];
    if (typeof options.refreshBots === 'function') {
      timers.push(window.setInterval(() => {
        void options.refreshBots();
      }, 30000));
    }
    return timers;
  }

  /**
   * @description Normalize raw metric values into finite status-bar numbers.
   *
   * @param {unknown} value - Raw metric value.
   * @param {number} [fallback=0] - Fallback value when parsing fails.
   * @returns {number} Normalized numeric value.
   */
  normalizeStatusNumber(value, fallback = 0) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return fallback;
  }

  /**
   * @description Update the cockpit cost badge with the latest spend status.
   *
   * @param {Record<string, unknown>} costStatus - Cost status from the cockpit API client.
   * @returns {void}
   */
  updateCostIndicator(costStatus) {
    const statusCostElement = document.getElementById('statusCost');
    if (!statusCostElement) {
      return;
    }

    const dailySpent = Number(costStatus.dailySpent || 0);
    const dailyLimit = Number(costStatus.dailyLimit || 0) || null;
    const bucketSpent = Number(costStatus.bucketSpent || 0);
    const bucketLimit = Number(costStatus.bucketLimit || 0) || null;
    let displayText = formatCost(dailySpent);
    let status = 'normal';

    if ((dailyLimit && dailySpent >= dailyLimit * 0.9) || (bucketLimit && bucketSpent >= bucketLimit * 0.9)) {
      status = 'warning';
      displayText += ' ⚠️';
    }
    if (costStatus.dailyLimitReached || costStatus.bucketLimitReached) {
      status = 'error';
      displayText += ' 🚫';
    }

    statusCostElement.textContent = displayText;
    statusCostElement.className = `status-cost status-${status}`;
    statusCostElement.title = this.getCostTooltip(costStatus);
    logger.debug('Updated cockpit cost indicator', {
      status,
      dailySpent,
      dailyLimit,
      bucketSpent,
      bucketLimit,
    });
  }

  /**
   * @description Build the tooltip shown on the cockpit cost indicator.
   *
   * @param {Record<string, unknown>} costStatus - Cost status from the cockpit API client.
   * @returns {string} Multi-line cost tooltip.
   */
  getCostTooltip(costStatus) {
    const dailySpent = Number(costStatus.dailySpent || 0);
    const dailyLimit = Number(costStatus.dailyLimit || 0) || null;
    const bucketSpent = Number(costStatus.bucketSpent || 0);
    const bucketLimit = Number(costStatus.bucketLimit || 0) || null;
    const parts = [
      dailyLimit
        ? `Daily: $${dailySpent.toFixed(4)} / $${dailyLimit.toFixed(2)}`
        : `Daily: $${dailySpent.toFixed(4)} (no limit)`,
      bucketLimit
        ? `Bucket: $${bucketSpent.toFixed(4)} / $${bucketLimit.toFixed(2)}`
        : `Bucket: $${bucketSpent.toFixed(4)} (no limit)`,
    ];
    return parts.join('\n');
  }

  // Write normalized metric values into the cockpit status-bar DOM.
  updateStatusBar(status) {
    const agents = this.normalizeStatusNumber(status?.agents, 0);
    const tickets = this.normalizeStatusNumber(status?.tickets, 0);
    const cost = this.normalizeStatusNumber(status?.cost, 0);
    const queue = this.normalizeStatusNumber(status?.queue, 0);
    const updateElement = (id, text) => {
      const element = document.getElementById(id);
      if (element) {
        element.textContent = text;
      }
    };

    updateElement('statusBots', `${agents} bots`);
    updateElement('statusTickets', `${tickets} tickets`);
    updateElement('statusCost', formatCost(cost));
    updateElement('statusQueue', `Q: ${queue}`);
    logger.debug('Rendered cockpit status bar', {
      agents,
      tickets,
      cost,
      queue,
    });
  }
}
