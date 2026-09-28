/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Workflow tab renderer: registered for every process, escapes every untrusted field, labels the definition as current rather than a run snapshot, refuses to pair one decision to a repeated gate visit, and drops a stale response.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Typecheck-clean under tsconfig.tests.json: the stub tab body is passed through an unknown cast to the HTMLElement the renderer declares, since the test only needs innerHTML and querySelectorAll.
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveDetailTabs } from '../../src/pages/cockpit/js/views/ticket-detail-tabs.js';
import { buildWorkflowTabMarkup, renderWorkflowTab } from '../../src/pages/cockpit/js/views/ticket-view-workflow-renderer.js';

describe('ticket workflow cockpit tab', () => {
  it('is registered for every ticket process', () => {
    for (const type of ['build', 'incident', 'chat', 'import-review', '']) {
      expect(resolveDetailTabs(type).map((tab) => tab.key)).toContain('workflow');
    }
  });

  it('escapes graph, run, lifecycle and child fields without pretending current graph is a run snapshot', () => {
    const html = buildWorkflowTabMarkup({
      ticket: { title: '<script>alert(1)</script>', ticketType: 'build', queueId: '<script>queue</script>', queueName: '<Queue>', status: 'approved' },
      definition: { name: 'Today <graph>', pipeline: 'graph', nodes: [{ id: 'n1', type: 'approval-gate', title: '<img src=x>', agentBinding: '' }], edges: [] },
      runHistoryAvailable: true,
      run: { runId: 'run-1', workflowName: 'Earlier graph', status: 'completed', steps: [{ seq: 1, nodeId: 'old', nodeType: 'approval-gate', nodeTitle: 'Old <step>', status: 'suspended', inputSummary: { value: '</pre><script>' } }] },
      approvalGates: [{ gateNodeId: 'old', workflowRunId: 'run-1', requestedAt: '2026-09-25T12:00:00Z',
        disposition: 'transitioned', decision: { toStatus: 'approved', actor: '<owner>', decidedAt: '2026-09-25T12:01:00Z' } }],
      historyAvailable: true,
      history: [{ fromStatus: 'approval_required', toStatus: 'approved', changedByLabel: '<owner>', createdAt: '2026-09-25T12:00:00Z' }],
      childrenAvailable: true,
      children: [{ ticketId: 'child-1', title: '<child>', status: 'approved', assignedAgentId: 'bot-a' }],
    });
    expect(html).toContain('current registered definition, not a snapshot');
    expect(html).toContain('Approver assignment is not declared');
    expect(html).toContain('bot bot-a');
    expect(html).toContain('Queue: &lt;Queue&gt; (&lt;script&gt;queue&lt;/script&gt;)');
    expect(html).toContain('Transitioned to approved · actor &lt;owner&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x>');
    expect(html).not.toContain('</pre><script>');
  });

  it('shows an honest empty state for workflow-less tickets and unavailable sources', () => {
    const html = buildWorkflowTabMarkup({ ticket: { title: 'Chat' }, definition: null,
      runHistoryAvailable: false, historyAvailable: false, childrenAvailable: false });
    expect(html).toContain('No workflow is registered');
    expect(html).toContain('Run history is unavailable');
    expect(html).toContain('Status history is unavailable');
  });

  it('does not assign one decision to a particular step when a gate is visited twice', () => {
    const html = buildWorkflowTabMarkup({ ticket: { title: 'Repeat' }, runHistoryAvailable: true,
      run: { runId: 'run-1', status: 'suspended', steps: [
        { seq: 1, nodeId: 'gate', nodeType: 'approval-gate', status: 'suspended' },
        { seq: 2, nodeId: 'gate', nodeType: 'approval-gate', status: 'suspended' },
      ] },
      approvalGates: [{ gateNodeId: 'gate', workflowRunId: 'run-1', disposition: 'transitioned',
        requestedAt: '2026-09-25T12:00:00Z', decision: { toStatus: 'approved', actor: 'Operator One', decidedAt: '2026-09-25T12:01:00Z' } }],
      historyAvailable: true, childrenAvailable: true });
    expect(html).toContain('Repeated gate visits cannot be paired to individual step receipts');
    expect(html).toContain('Operator One');
  });

  it('fetches the ticket-specific endpoint and ignores a stale tab response', async () => {
    const body = { innerHTML: '', querySelectorAll: vi.fn(() => []) };
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, ticket: { title: 'Ticket' } }) }));
    await renderWorkflowTab(body as unknown as HTMLElement, { id: 'ticket / 1' }, { fetchImpl, isCurrent: () => false });
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/tickets/ticket%20%2F%201/workflow', { headers: { Accept: 'application/json' } });
    expect(body.innerHTML).toBe('<p>Loading workflow…</p>');
  });
});
