/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted escalated-ticket panel rendering from the main cockpit ticket detail renderer to restore file-size compliance after escalation guidance work
 */

import { timeAgo } from '../utils/formatters.js';

/**
 * @description Build the escalated-ticket guidance panel markup for the ticket detail header.
 * @param {Record<string, unknown>} ticket - Normalized ticket detail record.
 * @returns {string} Escalation panel HTML.
 */
export function buildEscalationPanelMarkup(ticket) {
  const escalation = ticket?.escalation || null;
  const guidance = buildEscalationGuidance(ticket, escalation);
  const reason = String(escalation?.reason || '').trim() || 'No durable escalation reason is available for this ticket yet.';
  const createdAt = String(escalation?.createdAt || '').trim();
  const chips = [
    escalation?.target ? `Target: ${formatEscalationLabel(escalation.target)}` : '',
    escalation?.severity ? `Severity: ${formatEscalationLabel(escalation.severity)}` : '',
    escalation?.retryClass ? `Class: ${formatEscalationLabel(escalation.retryClass)}` : '',
    createdAt ? `Raised: ${timeAgo(createdAt)}` : '',
  ].filter(Boolean);
  const attemptSummary = buildEscalationAttemptSummary(escalation?.attemptState);

  return `<div id="tvEscalationPanel" style="display:flex;flex-direction:column;gap:12px;padding:14px;border:1px solid color-mix(in srgb, var(--accent-primary) 45%, var(--glass-border));border-radius:var(--radius-lg);background:linear-gradient(180deg, rgba(59,130,246,0.12), rgba(15,23,42,0.12));box-shadow:0 10px 28px rgba(15,23,42,0.12)">
    <div style="display:flex;align-items:flex-start;gap:10px">
      <div style="width:32px;height:32px;border-radius:50%;background:rgba(59,130,246,0.18);display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <i class="ph ph-warning-circle" style="font-size:18px;color:var(--accent-primary)"></i>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;min-width:0">
        <strong style="font-size:13px;color:var(--text-primary)">Escalated Ticket Guidance</strong>
        <span style="font-size:12px;color:var(--text-muted);line-height:1.5">This ticket is parked outside normal swarm automation until an operator resolves the blocker or explicitly de-escalates it.</span>
      </div>
    </div>
    ${chips.length ? `<div style="display:flex;flex-wrap:wrap;gap:8px">${chips.map((chip) => `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:var(--radius-pill);background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.08);font-size:11px;color:var(--text-secondary)">${escapeHtml(chip)}</span>`).join('')}</div>` : ''}
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;flex-direction:column;gap:4px">
        <strong style="font-size:12px;color:var(--text-secondary)">${escalation ? 'Why it escalated' : 'Escalation detail unavailable'}</strong>
        <div style="padding:10px 12px;border-radius:var(--radius-md);background:rgba(15,23,42,0.18);border:1px solid rgba(255,255,255,0.08);font-size:12px;color:var(--text-primary);line-height:1.55">${escapeHtml(reason)}</div>
      </div>
      ${attemptSummary ? `<div style="display:flex;flex-direction:column;gap:4px"><strong style="font-size:12px;color:var(--text-secondary)">Attempt snapshot</strong><div style="font-size:12px;color:var(--text-muted);line-height:1.5">${escapeHtml(attemptSummary)}</div></div>` : ''}
      <div style="display:flex;flex-direction:column;gap:4px">
        <strong style="font-size:12px;color:var(--text-secondary)">Next steps</strong>
        <ol style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;color:var(--text-primary);font-size:12px;line-height:1.55">${guidance.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
      </div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
      <button class="td-action-btn" id="tvDeescalateBtn" type="button"><i class="ph ph-arrow-u-up-left"></i> De-escalate to Approved</button>
      ${guidance.showRedisLink ? `<a class="td-action-btn" id="tvOpenRedisVisibilityBtn" href="/redis-visibility/" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none"><i class="ph ph-graph"></i> Open Redis Visibility</a>` : ''}
      <span style="font-size:11px;color:var(--text-muted)">De-escalating returns the ticket to the normal queue entry state so the swarm can pick it up again.</span>
    </div>
  </div>`;
}

function buildEscalationGuidance(ticket, escalation) {
  const reasonText = `${String(escalation?.reason || '')} ${String(escalation?.retryClass || '')}`.toLowerCase();
  const isInfraRouteIssue = /(redis|mesh|channel|dispatch|routing|route|queue|stream|consumer|transport|connection|network|timeout|resource|quota|capacity)/.test(reasonText);
  const evidenceMatch = reasonText.match(/because ([a-z_\- ]+) evidence is missing/);

  if (isInfraRouteIssue) {
    return {
      showRedisLink: true,
      steps: [
        'Confirm the cockpit API and every swarm bot are using the same REDIS_URL and SWARM_MESH_TRANSPORT values.',
        'Open Redis Visibility and verify this ticket still has healthy queue, stream, or mesh traffic.',
        `Check that ${ticket.assignee || 'the assigned bot'} is online and bound to the expected runtime channels before retrying.`,
        'After fixing the runtime or routing mismatch, de-escalate the ticket to Approved so it can re-enter the swarm queue.',
      ],
    };
  }

  if (evidenceMatch) {
    const evidenceClass = evidenceMatch[1].replace(/[_-]+/g, ' ').trim() || 'required';
    return {
      showRedisLink: false,
      steps: [
        `Review the missing ${evidenceClass} evidence called out in the escalation reason.`,
        'Add the missing proof, artifact, or reviewer note to the ticket thread or linked workspace.',
        'De-escalate the ticket to Approved once the blocker is addressed so the swarm can retry from the normal queue.',
      ],
    };
  }

  return {
    showRedisLink: false,
    steps: [
      'Review the feed and Process tab to confirm the last failed automation step.',
      'Check the assigned bot, project routing, and current swarm health before retrying.',
      'Use De-escalate to Approved when you are ready to return this ticket to the swarm queue.',
    ],
  };
}

function buildEscalationAttemptSummary(attemptState) {
  const verificationAttempt = Number(attemptState?.verificationAttempt);
  const buildRegressionCount = Number(attemptState?.buildRegressionCount);
  const designRegressionCount = Number(attemptState?.designRegressionCount);
  const parts = [];

  if (Number.isFinite(verificationAttempt) && verificationAttempt > 0) parts.push(`Verification attempts: ${verificationAttempt}`);
  if (Number.isFinite(buildRegressionCount) && buildRegressionCount >= 0) parts.push(`Build regressions: ${buildRegressionCount}`);
  if (Number.isFinite(designRegressionCount) && designRegressionCount >= 0) parts.push(`Design regressions: ${designRegressionCount}`);

  return parts.join(' · ');
}

function formatEscalationLabel(value) {
  return String(value || '')
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}