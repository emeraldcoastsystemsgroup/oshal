/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted cockpit ticket cost tab rendering to support per-bot usage tables while keeping the main detail renderer under the hard file-size limit
 */

import { formatCost } from '../utils/formatters.js';
import { buildInlineEmptyState } from './ticket-view-helpers.js';

/**
 * @description Render the cockpit ticket cost tab with model and bot cost breakdowns.
 * @param {HTMLElement} body - Ticket detail tab container.
 * @param {Record<string, unknown>} ticket - Normalized ticket detail record.
 * @param {Record<string, unknown>} costData - Ticket cost payload from the activity endpoint.
 */
export function renderCostTab(body, ticket, costData) {
  const totalCost = readNumber(costData?.totalCost || costData?.estimatedCost || ticket?.cost);
  const totalTokens = readNumber(costData?.totalTokens);
  const totalRequests = readNumber(costData?.totalRequests);
  const usageByModel = normalizeModelUsage(costData?.usageByModel);
  const usageByAgent = normalizeAgentUsage(costData?.usageByAgent, costData?.contributingBots);
  const modelRows = Object.entries(usageByModel).sort((left, right) => right[1].totalTokens - left[1].totalTokens);
  const botRows = Object.values(usageByAgent).sort((left, right) => {
    if (right.totalCost !== left.totalCost) return right.totalCost - left.totalCost;
    return right.totalTokens - left.totalTokens;
  });
  const topModel = readString(costData?.modelId) || modelRows[0]?.[0] || '';
  const projectName = readString(costData?.projectName) || readString(ticket?.project) || 'Default';
  const hasTelemetry = totalCost > 0 || totalTokens > 0 || totalRequests > 0 || modelRows.length > 0 || botRows.length > 0;

  const metricsMarkup = `
    <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:16px">
      <div class="dash-metric-card"><span class="dash-metric-value" style="font-size:20px">${hasTelemetry ? formatCost(totalCost) : '--'}</span><span class="dash-metric-label">Total Cost</span></div>
      <div class="dash-metric-card"><span class="dash-metric-value" style="font-size:20px">${hasTelemetry ? totalTokens.toLocaleString() : '--'}</span><span class="dash-metric-label">Tokens</span></div>
      <div class="dash-metric-card"><span class="dash-metric-value" style="font-size:20px">${hasTelemetry ? totalRequests.toLocaleString() : '--'}</span><span class="dash-metric-label">Requests</span></div>
      <div class="dash-metric-card"><span class="dash-metric-value" style="font-size:20px">${hasTelemetry ? escapeHtml(topModel || '—') : '--'}</span><span class="dash-metric-label">Top Model</span></div>
    </div>
  `;
  const contextMarkup = hasTelemetry
    ? `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">
        <span class="td-meta-item"><i class="ph ph-folder"></i> Project: ${escapeHtml(projectName)}</span>
        <span class="td-meta-item"><i class="ph ph-ticket"></i> Ticket: ${escapeHtml(String(ticket?.sequenceId || ticket?.id || ''))}</span>
      </div>`
    : '';
  const costByBotMarkup = botRows.length > 0
    ? `<div style="margin-bottom:18px"><div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px">Cost by Bot</div><div class="table-shell"><table><thead><tr><th>Bot</th><th>Provider</th><th>Requests</th><th>Input Tokens</th><th>Output Tokens</th><th>Total Tokens</th><th>Est. Cost</th></tr></thead><tbody>${botRows.map((bot) => `
        <tr>
          <td>${escapeHtml(bot.agentName)}</td>
          <td>${escapeHtml(bot.providerId || '—')}</td>
          <td>${escapeHtml(String(bot.totalRequests))}</td>
          <td>${escapeHtml(bot.totalInputTokens.toLocaleString())}</td>
          <td>${escapeHtml(bot.totalOutputTokens.toLocaleString())}</td>
          <td>${escapeHtml(bot.totalTokens.toLocaleString())}</td>
          <td>${escapeHtml(formatCost(bot.totalCost))}</td>
        </tr>
      `).join('')}</tbody></table></div></div>`
    : '';
  const modelUsageMarkup = modelRows.length > 0
    ? `<div><div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px">Cost by Model</div><div class="table-shell"><table><thead><tr><th>Model</th><th>Requests</th><th>Tokens</th><th>Est. Cost</th></tr></thead><tbody>${modelRows.map(([modelId, stats]) => `
        <tr>
          <td>${escapeHtml(modelId)}</td>
          <td>${escapeHtml(String(stats.requestCount))}</td>
          <td>${escapeHtml(stats.totalTokens.toLocaleString())}</td>
          <td>${escapeHtml(formatCost(stats.totalCost))}</td>
        </tr>
      `).join('')}</tbody></table></div></div>`
    : '';

  body.innerHTML = `${metricsMarkup}${contextMarkup}${hasTelemetry ? `${costByBotMarkup}${modelUsageMarkup}` : buildInlineEmptyState('chart-line-down', 'No cost telemetry recorded yet', 'Measured usage will appear here after model-backed work runs.')}`;
}

function normalizeModelUsage(value) {
  const usage = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(usage).map(([modelId, stats]) => [modelId, {
    requestCount: readNumber(stats?.requestCount),
    totalCost: readNumber(stats?.totalCost),
    totalTokens: readNumber(stats?.totalTokens),
  }]));
}

function normalizeAgentUsage(value, contributingBots) {
  const normalized = {};
  const usage = value && typeof value === 'object' && !Array.isArray(value) ? value : {};

  Object.entries(usage).forEach(([agentId, stats]) => {
    normalized[agentId] = {
      agentId,
      agentName: readString(stats?.agentName) || agentId,
      providerId: readString(stats?.providerId),
      totalRequests: readNumber(stats?.totalRequests),
      totalInputTokens: readNumber(stats?.totalInputTokens),
      totalOutputTokens: readNumber(stats?.totalOutputTokens),
      totalTokens: readNumber(stats?.totalTokens),
      totalCost: readNumber(stats?.totalCost),
    };
  });

  if (Array.isArray(contributingBots)) {
    contributingBots.forEach((bot) => {
      const agentId = readString(bot?.agentId) || readString(bot?.agentName);
      if (!agentId) return;
      normalized[agentId] = {
        agentId,
        agentName: readString(bot?.agentName) || agentId,
        totalRequests: readNumber(bot?.totalRequests),
        totalInputTokens: readNumber(bot?.totalInputTokens),
        totalOutputTokens: readNumber(bot?.totalOutputTokens),
        totalTokens: readNumber(bot?.totalTokens),
        totalCost: readNumber(bot?.totalCost),
      };
    });
  }

  return normalized;
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}