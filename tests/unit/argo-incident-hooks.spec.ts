/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for the Argo incident hooks (ADR-078 §1): finalize-incident's mode→disposition mapping (must equal the in-process INCIDENT_MODE_DISPOSITION table, never a second copy) and record-cost's run marker (must carry ZERO cost — the phase pods already billed their own calls, so a non-zero marker would double-count every Argo run).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Isolated the default-agent parser assertion from worker AGENT_ID env leakage so the unit suite proves the no-DAG-agent fallback deterministically inside bot-node containers.
 */

import { describe, it, expect } from 'vitest';
import { parseFinalizeArgs, dispositionFor } from '../../src/app/finalize-incident';
import { parseRecordCostArgs, buildRunMarkerEvent, markerStatusFor } from '../../src/app/record-cost';
import { INCIDENT_MODE_DISPOSITION } from '../../src/features/swarm-orchestration/services/rca-mode';
import { TicketService } from '../../src/features/ticketing';

describe('finalize-incident: dispositionFor', () => {
  it('matches the in-process disposition table exactly (no second copy)', () => {
    for (const mode of ['A', 'B', 'C'] as const) {
      expect(dispositionFor(mode)).toEqual(INCIDENT_MODE_DISPOSITION[mode]);
    }
  });

  it('maps A/B to customer_action and C to escalated (ADR-069 §2b)', () => {
    expect(dispositionFor('A')).toEqual({ status: 'customer_action', disposition: 'proposed_solution' });
    expect(dispositionFor('B')).toEqual({ status: 'customer_action', disposition: 'human_action_needed' });
    expect(dispositionFor('C')).toEqual({ status: 'escalated', disposition: 'escalated' });
  });

  it('is case- and whitespace-insensitive (the DAG passes a raw string)', () => {
    expect(dispositionFor(' b ')).toEqual(INCIDENT_MODE_DISPOSITION.B);
    expect(dispositionFor('c')).toEqual(INCIDENT_MODE_DISPOSITION.C);
  });

  it('completes rather than strands the ticket when no mode was classified', () => {
    // The DAG's output parameter defaults to "unknown" — that must not leave a ticket
    // parked forever in a non-terminal state.
    for (const bad of ['unknown', '', 'D', 'garbage']) {
      expect(dispositionFor(bad)).toEqual({ status: 'complete', disposition: 'completed_no_mode' });
    }
  });
});

describe('finalize-incident: parseFinalizeArgs', () => {
  it('parses the DAG flags', () => {
    expect(parseFinalizeArgs(['--ticket-id=T-1', '--mode=C'])).toEqual({ ticketId: 'T-1', mode: 'C' });
  });

  it('defaults an omitted mode to unknown', () => {
    expect(parseFinalizeArgs(['--ticket-id=T-1']).mode).toBe('unknown');
  });

  it('ignores the generic MODE env var (vitest/bundlers set it) rather than hijacking disposition', () => {
    const prev = process.env.MODE;
    process.env.MODE = 'C';   // would escalate the ticket if we honoured it
    try {
      expect(parseFinalizeArgs(['--ticket-id=T-1']).mode).toBe('unknown');
    } finally {
      if (prev === undefined) delete process.env.MODE; else process.env.MODE = prev;
    }
  });

  it('fails loudly rather than finalize nothing', () => {
    expect(() => parseFinalizeArgs(['--mode=A'])).toThrow(/--ticket-id/);
  });
});

describe('record-cost: buildRunMarkerEvent', () => {
  const args = { ticketId: 'T-7', workflowStatus: 'Succeeded', agentId: 'rca-specialist' };

  it('carries ZERO cost — the phase pods already billed their own calls', () => {
    // Regression guard: summing phase spend here would double-count every Argo run
    // in every cost report, because the execution handler already wrote a row per call.
    const event = buildRunMarkerEvent(args);
    expect(event.totalCost).toBe(0);
    expect(event.inputCost).toBe(0);
    expect(event.outputCost).toBe(0);
    expect(event.inputTokens).toBe(0);
    expect(event.outputTokens).toBe(0);
    expect(event.requestCount).toBe(0);
  });

  it('links the marker to its ticket so the run is visible in the ledger', () => {
    const event = buildRunMarkerEvent(args);
    expect(event.ticketExternalId).toBe('T-7');
    expect(event.taskId).toContain('T-7');
    expect(event.agentId).toBe('rca-specialist');
    expect(event.providerId).toBe('argo-workflow');
    expect(event.estimated).toBe(false);
  });
});

describe('finalize-incident: every disposition must be REACHABLE through the real state machine', () => {
  // Double-check finding 2026-07-08 (live-proven): mode A/B mapped to 'customer_action',
  // which VALID_TRANSITIONS rejected from in_process_discovery — the whole DAG failed after
  // the RCA work succeeded, and the in-process pipeline silently downgraded A/B to
  // 'escalated'. The 25 original tests only asserted the mapping, never the transition.
  // This drives dispositionFor's statuses through the REAL TicketService validation.
  function serviceWithTicketIn(status: string): TicketService {
    const store = {
      get: async () => ({ ticketId: 'T-1', status }),
      updateStatus: async () => undefined,
    };
    return new TicketService(store as never);
  }

  it('accepts every mode disposition from in_process_discovery (the state the batch phase sets)', async () => {
    for (const mode of ['A', 'B', 'C', 'unknown']) {
      const svc = serviceWithTicketIn('in_process_discovery');
      const { status } = dispositionFor(mode);
      await expect(svc.updateStatus('T-1', status)).resolves.toBeUndefined();
    }
  });

  it('documents why the phase-start transition exists: backlog rejects the dispositions', async () => {
    // A ticket left in 'backlog' CANNOT take customer_action/complete — which is why
    // bot-node-batch moves it to in_process_discovery at phase start (submitter contract:
    // tickets are submitted in 'approved', which allows that move).
    const svc = serviceWithTicketIn('backlog');
    await expect(svc.updateStatus('T-1', dispositionFor('A').status)).rejects.toThrow(/Invalid state transition/);
    const approved = serviceWithTicketIn('approved');
    await expect(approved.updateStatus('T-1', 'in_process_discovery')).resolves.toBeUndefined();
  });
});

describe('record-cost: markerStatusFor', () => {
  it('maps Succeeded to completed and everything else to failed', () => {
    // A marker left 'processing' forever counts as an in-progress task in every
    // active-task surface — the counts drift upward with each workflow run.
    expect(markerStatusFor('Succeeded')).toBe('completed');
    expect(markerStatusFor(' succeeded ')).toBe('completed');
    expect(markerStatusFor('Failed')).toBe('failed');
    expect(markerStatusFor('Error')).toBe('failed');
    expect(markerStatusFor('Unknown')).toBe('failed');
    expect(markerStatusFor('')).toBe('failed');
  });
});

describe('record-cost: parseRecordCostArgs', () => {
  it('parses the DAG flags', () => {
    const args = parseRecordCostArgs(['--ticket-id=T-1', '--workflow-status=Failed']);
    expect(args).toMatchObject({ ticketId: 'T-1', workflowStatus: 'Failed' });
  });

  it('defaults the agent to argo-workflow when the DAG did not name one', () => {
    const prev = process.env.AGENT_ID;
    delete process.env.AGENT_ID;
    try {
      expect(parseRecordCostArgs(['--ticket-id=T-1']).agentId).toBe('argo-workflow');
    } finally {
      if (prev === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = prev;
    }
  });

  it('refuses an unattributable ledger row', () => {
    expect(() => parseRecordCostArgs(['--workflow-status=Succeeded'])).toThrow(/--ticket-id/);
  });
});
