/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-081: isSuperAdminSub (fail-closed sub allowlist) + the privileged 'oshal-dev' dispatch gate — non-superadmin owners escalate with superadmin_required BEFORE any bot resolution; allowlisted owners pass the gate; non-privileged ticket types are untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSuperAdminSub } from '../../src/shared/middleware/superadmin';
import { dispatchManifestWorkerTicket } from '../../src/features/swarm-orchestration/services/dispatch-manifest-worker';
import type { InternalTicket } from '../../src/entities/ticket/internal-ticket';

const SAVED = process.env.OSHAL_SUPERADMIN_SUBS;

beforeEach(() => { process.env.OSHAL_SUPERADMIN_SUBS = 'admin-sub-1, Admin-Sub-2'; });
afterEach(() => {
  if (SAVED === undefined) delete process.env.OSHAL_SUPERADMIN_SUBS;
  else process.env.OSHAL_SUPERADMIN_SUBS = SAVED;
});

describe('isSuperAdminSub (queue-side allowlist)', () => {
  it('accepts allowlisted subs case-insensitively', () => {
    expect(isSuperAdminSub('admin-sub-1')).toBe(true);
    expect(isSuperAdminSub('ADMIN-SUB-2')).toBe(true);
  });

  it('fails closed: unknown, null, empty, and empty-allowlist all deny', () => {
    expect(isSuperAdminSub('someone-else')).toBe(false);
    expect(isSuperAdminSub(null)).toBe(false);
    expect(isSuperAdminSub('')).toBe(false);
    process.env.OSHAL_SUPERADMIN_SUBS = '';
    expect(isSuperAdminSub('admin-sub-1')).toBe(false);
  });
});

function makeTicket(over: Partial<InternalTicket> = {}): InternalTicket {
  return {
    ticketId: 'tix-1', title: 'Add a thing to the platform', description: 'do it',
    ticketType: 'oshal-dev', status: 'approved', priority: 'medium', labels: [],
    ownerSub: 'someone-else', metadata: {},
    ...over,
  } as unknown as InternalTicket;
}

function makeDeps() {
  return {
    activeTicketIds: new Set<string>(),
    dispatchStartTimes: new Map<string, number>(),
    resolveAgentIdByName: vi.fn().mockResolvedValue(undefined),
    ticketService: { updateStatus: vi.fn().mockResolvedValue(undefined) } as never,
  };
}

describe("privileged 'oshal-dev' dispatch gate (ADR-081)", () => {
  const workflow = { ticketType: 'oshal-dev', name: 'OSHAL Platform Development', pipeline: 'manifest-worker', workerBot: 'oshal-developer' } as never;

  it('escalates superadmin_required for a non-allowlisted owner, before any bot resolution', async () => {
    const deps = makeDeps();
    await dispatchManifestWorkerTicket(makeTicket({ ownerSub: 'someone-else' } as never), workflow, deps as never);

    expect(deps.resolveAgentIdByName).not.toHaveBeenCalled();
    expect((deps.ticketService as { updateStatus: ReturnType<typeof vi.fn> }).updateStatus)
      .toHaveBeenCalledWith('tix-1', 'escalated', expect.objectContaining({ reason: 'superadmin_required' }));
    expect(deps.activeTicketIds.size).toBe(0);   // never claimed a slot
  });

  it('lets an allowlisted owner through the gate (reaches worker resolution)', async () => {
    const deps = makeDeps();
    await dispatchManifestWorkerTicket(makeTicket({ ownerSub: 'admin-sub-1' } as never), workflow, deps as never);

    expect(deps.resolveAgentIdByName).toHaveBeenCalledWith('oshal-developer');
    // Resolver returned undefined → escalates for the NORMAL reason, proving the gate passed.
    expect((deps.ticketService as { updateStatus: ReturnType<typeof vi.fn> }).updateStatus)
      .toHaveBeenCalledWith('tix-1', 'escalated', expect.objectContaining({ reason: 'manifest_worker_agent_unresolved' }));
  });

  it('does not gate non-privileged ticket types', async () => {
    const deps = makeDeps();
    const taskWorkflow = { ticketType: 'task', name: 'Jarvis Assistant Task', pipeline: 'manifest-worker', workerBot: 'project-manager' } as never;
    await dispatchManifestWorkerTicket(makeTicket({ ownerSub: 'someone-else' } as never), taskWorkflow, deps as never);

    expect(deps.resolveAgentIdByName).toHaveBeenCalledWith('project-manager');
  });
});
