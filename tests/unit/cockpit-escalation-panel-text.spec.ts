/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the text an operator actually reads in the escalated-ticket panel: a durable swarm_escalations record, a detail derived from the recorded status transition when no durable row exists, and the genuinely-empty case which must stay honest instead of blaming the durable store.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard the text for a ticket escalated more than once: a durable record left over from an earlier run must not be read as the explanation for the escalation on screen, and when the current escalation recorded nothing the panel must say so rather than show the old reason.
 */

import { describe, expect, it } from 'vitest';
import {
  buildEscalationPanelMarkup,
} from '../../src/pages/cockpit/js/views/ticket-view-escalation-panel.js';
import { selectEscalationDetail } from '../../src/pages/cockpit/js/views/ticket-view-helpers.js';

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

// The operator's ticket 60cb33b5. A swarm run left a durable escalation record on 06-21;
// the escalation the ticket is actually in was raised 06-22 and recorded no reason. The
// lookup is by ticket id and returns the newest record, so the panel presented the 06-21
// row as the current explanation. Nine of the 24 escalated tickets holding a durable
// record on that database were being explained by a record older than their escalation.
describe('cockpit escalated-ticket panel text on a ticket escalated more than once', () => {
  const EARLIER_RUN_REASON = 'Verification exhausted policy budget after attempt 2.';
  const EARLIER_RUN_RECORD = {
    runId: 'run-d1b4e6d1',
    ticketExternalId: '60cb33b5-0202-4311-8983-7ac573b4d89c',
    target: 'human_review',
    severity: 'medium',
    retryClass: 'deterministic',
    reason: EARLIER_RUN_REASON,
    createdAt: '2026-06-21T04:36:12.162Z',
  };
  const CURRENT_ESCALATION_AT = '2026-06-22T14:27:24.373Z';

  it('says no reason was recorded rather than explaining it with the earlier run', () => {
    const text = renderedText(buildEscalationPanelMarkup({
      assignee: 'code-developer',
      escalation: selectEscalationDetail(null, EARLIER_RUN_RECORD, CURRENT_ESCALATION_AT),
    }));

    expect(text).not.toContain(EARLIER_RUN_REASON);
    expect(text).not.toContain('Class: Deterministic');
    expect(text).toContain('Escalation detail unavailable');
    expect(text).toContain('No escalation reason was recorded for this ticket.');
    expect(text).toContain('De-escalate to Approved');
  });

  it('still shows a durable record that belongs to the escalation on screen', () => {
    // 12 ms ahead of its own transition: the ordering every same-run record is written in.
    const currentRecord = { ...EARLIER_RUN_RECORD, createdAt: '2026-06-22T14:27:24.361Z' };
    const text = renderedText(buildEscalationPanelMarkup({
      assignee: 'code-developer',
      escalation: selectEscalationDetail(null, currentRecord, CURRENT_ESCALATION_AT),
    }));

    expect(text).toContain('Why it escalated');
    expect(text).toContain(EARLIER_RUN_REASON);
    expect(text).toContain('Severity: Medium');
    expect(text).not.toContain('No escalation reason');
  });

  it('shows the current escalation reason when an earlier run also left a record', () => {
    const currentDetail = {
      reason: 'parent_terminal_state',
      source: 'queue-parent-gate',
      severity: 'medium',
      createdAt: '2026-06-22T19:16:31.395Z',
    };
    const priorRecord = { ...EARLIER_RUN_RECORD, createdAt: '2026-06-22T19:16:17.811Z' };
    const text = renderedText(buildEscalationPanelMarkup({
      assignee: 'code-developer',
      escalation: selectEscalationDetail(currentDetail, priorRecord, currentDetail.createdAt),
    }));

    expect(text).toContain('parent_terminal_state');
    expect(text).toContain('Source: Queue Parent Gate');
    expect(text).not.toContain(EARLIER_RUN_REASON);
  });

  it('leaves the three original selection outcomes rendering as they did', () => {
    const durableOnly = renderedText(buildEscalationPanelMarkup({
      escalation: selectEscalationDetail(null, DURABLE_RECORD, DURABLE_RECORD.createdAt),
    }));
    const transitionOnly = renderedText(buildEscalationPanelMarkup({
      escalation: selectEscalationDetail(RECORDED_DETAIL, null, RECORDED_DETAIL.createdAt),
    }));
    const neither = renderedText(buildEscalationPanelMarkup({
      escalation: selectEscalationDetail(null, null, ''),
    }));

    expect(durableOnly).toContain('pipeline_work_items_failed because design evidence is missing');
    expect(transitionOnly).toContain('manifest_worker_dispatch_failed');
    expect(neither).toContain('No escalation reason was recorded for this ticket.');
  });
});

