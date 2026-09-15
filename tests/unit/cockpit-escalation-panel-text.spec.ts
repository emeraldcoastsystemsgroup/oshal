/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the text an operator actually reads in the escalated-ticket panel: a durable swarm_escalations record, a detail derived from the recorded status transition when no durable row exists, and the genuinely-empty case which must stay honest instead of blaming the durable store.
 */

import { describe, expect, it } from 'vitest';
import {
  buildEscalationPanelMarkup,
} from '../../src/pages/cockpit/js/views/ticket-view-escalation-panel.js';

/**
 * @description Reduce the panel markup to the text a reader sees, so assertions
 * pin operator-visible wording rather than the inline styling around it.
 * @param html - Rendered panel markup.
 * @returns Whitespace-collapsed, entity-decoded text content.
 */
function renderedText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// The shape PostgresSwarmEscalationStore.list() returns (SwarmEscalationRecord).
const DURABLE_RECORD = {
  runId: 'run-7',
  ticketExternalId: 'ticket-durable',
  target: 'operator',
  severity: 'high',
  retryClass: 'verification_exhausted',
  reason: 'pipeline_work_items_failed because design evidence is missing',
  attemptState: { verificationAttempt: 3, buildRegressionCount: 1, designRegressionCount: 0 },
  createdAt: new Date().toISOString(),
};

// The shape a status transition records for every escalation (ticket_status_history
// metadata, mirrored onto the ticket row as metadata.lastStatusTransition). This is
// the exact field set the dispatch-failure path wrote for the ticket the operator hit.
const RECORDED_DETAIL = {
  reason: 'manifest_worker_dispatch_failed',
  source: 'dispatch-manifest-worker',
  severity: 'medium',
  nextAction: 'operator_review_required',
  message: 'authorization_recorded_delegation_required',
  previousStatus: 'approved',
  createdAt: new Date().toISOString(),
  origin: 'status-history',
};

describe('cockpit escalated-ticket panel text', () => {
  it('shows the durable escalation record reason, severity and retry class', () => {
    const text = renderedText(buildEscalationPanelMarkup({
      assignee: 'code-developer',
      escalation: DURABLE_RECORD,
    }));

    expect(text).toContain('Why it escalated');
    expect(text).toContain('pipeline_work_items_failed because design evidence is missing');
    expect(text).toContain('Severity: High');
    expect(text).toContain('Class: Verification Exhausted');
    expect(text).not.toContain('Escalation detail unavailable');
    expect(text).not.toContain('No escalation reason');
  });

  it('shows the recorded transition reason, its source and its next action when no durable row exists', () => {
    const text = renderedText(buildEscalationPanelMarkup({
      assignee: 'communications-bot',
      escalation: RECORDED_DETAIL,
    }));

    // The operator-visible bug: this panel used to claim no reason was available
    // while the transition record carried all three of these facts.
    expect(text).not.toContain('Escalation detail unavailable');
    expect(text).toContain('Why it escalated');
    expect(text).toContain('manifest_worker_dispatch_failed');
    expect(text).toContain('Source: Dispatch Manifest Worker');
    expect(text).toContain('Operator Review Required');
    // The recorded free-text message is supporting detail, not a replacement reason.
    expect(text).toContain('authorization_recorded_delegation_required');
  });

  it('stays honest when nothing recorded a reason at all', () => {
    const text = renderedText(buildEscalationPanelMarkup({ assignee: 'code-developer' }));

    expect(text).toContain('Escalation detail unavailable');
    expect(text).toContain('No escalation reason was recorded for this ticket.');
    expect(text).not.toContain('Source:');
    expect(text).not.toContain('Recommended next action');
    // The panel is still usable: de-escalation and generic next steps remain.
    expect(text).toContain('De-escalate to Approved');
  });

  it('does not invent a next action from an escalation that has no recorded one', () => {
    const text = renderedText(buildEscalationPanelMarkup({
      assignee: 'code-developer',
      escalation: { reason: 'operator_parked', createdAt: new Date().toISOString() },
    }));

    expect(text).toContain('operator_parked');
    expect(text).not.toContain('Recommended next action');
    expect(text).not.toContain('Source:');
  });

  it('escapes recorded text so a hostile reason cannot inject markup', () => {
    const html = buildEscalationPanelMarkup({
      escalation: { reason: '<img src=x onerror="alert(1)">', source: 'dispatch-manifest-worker' },
    });

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});
