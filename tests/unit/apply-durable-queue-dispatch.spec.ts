/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the durable job-apply
 *   queue: a per-résumé apply ticket that loses the race for the single desktop (dispatcher returns
 *   retryable) must DEFER (go back to approved) so the next poll re-attempts it — NOT escalate to a
 *   terminal state. Without this, minting one ticket per posting would kill every ticket but the
 *   first (they'd all 409 while the first is in flight). Also pins: a hard failure still escalates,
 *   an accepted dispatch marks the ticket active + records the browser taskId/postingId.
 */
import { describe, expect, it, vi } from 'vitest';
import { dispatchManifestWorkerTicket } from '@/features/swarm-orchestration/services/dispatch-manifest-worker';

const WORKFLOW = { ticketType: 'task', name: 'Jarvis Assistant Task', pipeline: 'manifest-worker', workerBot: 'general-bot' } as never;

function applyTicket() {
  return {
    ticketId: '1986677e-82de-4239-a8c3-c238e727d5d5',
    title: 'Apply: Airtable — Staff TPM',
    description: 'Auto-submit my generated resume application to this job posting.\nPosting ID: 833653',
    metadata: { postingId: 833653, applyPostingId: '833653' },
    ownerSub: 'example-user-sub',
    status: 'approved',
  } as never;
}

/** A ticketService stub that records every updateStatus(status, meta) call. */
function recordingDeps(dispatchResult: Record<string, unknown>) {
  const calls: Array<{ status: string; meta?: Record<string, unknown> }> = [];
  const deps = {
    activeTicketIds: new Set<string>(),
    dispatchStartTimes: new Map<string, number>(),
    ticketService: { updateStatus: vi.fn(async (_id: string, status: string, meta?: Record<string, unknown>) => { calls.push({ status, meta }); }) },
    dispatchJobApplicationTask: vi.fn(async () => dispatchResult),
  } as never;
  return { deps, calls };
}

describe('durable job-apply queue: dispatcher outcome routing', () => {
  it('DEFERS (approved) — not escalates — when the desktop is busy (retryable)', async () => {
    const { deps, calls } = recordingDeps({ handled: true, accepted: false, retryable: true, error: 'a submission is already in progress for this user' });
    await dispatchManifestWorkerTicket(applyTicket(), WORKFLOW, deps);
    const last = calls[calls.length - 1];
    expect(last.status).toBe('approved');
    expect(last.meta?.reason).toBe('browser_submission_deferred_desktop_busy');
    // It must NOT have escalated the ticket to a terminal state.
    expect(calls.some((c) => c.status === 'escalated')).toBe(false);
  });

  it('ESCALATES on a hard (non-retryable) dispatch failure', async () => {
    const { deps, calls } = recordingDeps({ handled: true, accepted: false, error: 'resume packet not synced' });
    await dispatchManifestWorkerTicket(applyTicket(), WORKFLOW, deps);
    const last = calls[calls.length - 1];
    expect(last.status).toBe('escalated');
    expect(last.meta?.reason).toBe('browser_submission_dispatch_failed');
  });

  it('marks the ticket ACTIVE and records the browser taskId/postingId on accept', async () => {
    const { deps, calls } = recordingDeps({ handled: true, accepted: true, taskId: 'codex-task-9', postingId: 833653 });
    await dispatchManifestWorkerTicket(applyTicket(), WORKFLOW, deps);
    const last = calls[calls.length - 1];
    expect(last.status).toBe('in_process_build');
    expect(last.meta?.reason).toBe('browser_submission_active');
    expect(last.meta?.remoteTaskId).toBe('codex-task-9');
    expect(last.meta?.postingId).toBe(833653);
  });
});
