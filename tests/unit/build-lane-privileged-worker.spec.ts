/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-081 guards: the build lane never sends work to the developer bot, whoever files the ticket. A stored PM assignment naming it (metadata.pmAssignedAgentId, which phase-4 routing takes first) is dropped and routing chooses another bot, through the real queue manager, processing service and routing handler over a recording mesh; normalizeCandidates, phase-aware routing and adaptive rerouting never offer it; the unsigned mesh hop refuses it with the signed hop's failure shape, in any letter case, and still sends a build specialist its work. Each fails on the tree before the fix.
 */

import type { ExternalWorkItem } from '@/entities/ticket';
import { AgentRouter } from '@/features/agent-management/services/agent-router';
import { PersonaLayerComposer } from '@/features/agent-management/services/persona-layer-composer';
import { PhaseRoutingService } from '@/features/swarm-orchestration/services/phase-routing-service';
import { PlanningRoundOrchestrator } from '@/features/swarm-orchestration/services/planning-round-orchestrator';
import { buildWorkItem } from '@/features/swarm-orchestration/services/queue-manager-dispatch-helpers';
import { TicketDecompositionService } from '@/features/swarm-orchestration/services/ticket-decomposition-service';
import { SwarmExecutionLifecycleService } from '@/features/swarm-orchestration/services/swarm-execution-lifecycle-service';
import { SwarmRoutingHandler } from '@/features/swarm-orchestration/services/swarm-routing-handler';
import { normalizeCandidates } from '@/features/swarm-orchestration/services/swarm-ticket-processing-support';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODE_DEVELOPER, DEVELOPER_BOT, GENERAL_BOT, approvedBuildTicket, buildSwarmLane, dispatchTargets, type SwarmBuildLane } from '../helpers/swarm-build-lane';

/** An ordinary user of the swarm. */
const USER_SUB = 'person-user-sub';
/** An operator who is not on the super-admin allowlist. */
const OPERATOR_SUB = 'person-operator-sub';

let lane: SwarmBuildLane | undefined;

beforeEach(() => {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', OPERATOR_SUB);
  vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  vi.stubEnv('OSHAL_SUPERADMIN_SUBS', '');
});
afterEach(() => {
  lane?.close();
  lane = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** True when an agent id names the developer bot in any letter case. */
function isDeveloperBot(agentId: string): boolean {
  return agentId.toLowerCase() === DEVELOPER_BOT;
}

describe('the build lane never sends work to the developer bot', () => {
  it('routes a stored ticket whose PM assignment names it to another bot, and sends it nothing', async () => {
    lane = buildSwarmLane(vi.stubEnv);
    const ticket = await approvedBuildTicket(lane.tickets, USER_SUB, { pmAssignedAgentId: DEVELOPER_BOT });
    await lane.dispatch(ticket);
    const targets = dispatchTargets(lane);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter(isDeveloperBot)).toEqual([]);
    expect((await lane.tickets.getTicket(ticket.ticketId))?.status).toBe('complete');
  });

  it("does the same for an operator's ticket: the lane, not the filer, decides", async () => {
    lane = buildSwarmLane(vi.stubEnv);
    const ticket = await approvedBuildTicket(lane.tickets, OPERATOR_SUB, { pmAssignedAgentId: DEVELOPER_BOT.toUpperCase() });
    await lane.dispatch(ticket);
    expect(dispatchTargets(lane).length).toBeGreaterThan(0);
    expect(dispatchTargets(lane).filter(isDeveloperBot)).toEqual([]);
  });
});

/** A routing work item for the handler. */
const ITEM = { externalId: 'tix-route', title: 'Change the platform build', body: 'Small change.' } as unknown as ExternalWorkItem;

describe('routing never offers a privileged worker', () => {
  it('normalizeCandidates drops it from explicit candidates, bids and the roster', async () => {
    const explicit = await normalizeCandidates([
      { agentId: DEVELOPER_BOT.toUpperCase(), score: 0.99, reason: 'explicit' }, { agentId: CODE_DEVELOPER, score: 0.5, reason: 'explicit' },
    ], undefined, 'title');
    expect(explicit.map((c) => c.agentId)).toEqual([CODE_DEVELOPER]);
    const bids = await normalizeCandidates(undefined, [
      { agentId: DEVELOPER_BOT, confidence: 0.99 }, { agentId: GENERAL_BOT, confidence: 0.4 },
    ] as never, 'title');
    expect(bids.map((c) => c.agentId)).toEqual([GENERAL_BOT]);
    const roster = { listAgents: async () => [{ agentId: DEVELOPER_BOT, name: 'oshal-developer', status: 'active' }] };
    expect(await normalizeCandidates(undefined, undefined, 'title', roster as never)).toEqual([]);
  });

  it('execution planning drops a PM assignment of it before routing, and keeps an ordinary one', async () => {
    const tickets = new TicketService(new InMemoryTicketStore());
    const assignedTo = async (pmAssignedAgentId: string): Promise<unknown> => {
      const routed: Array<Record<string, unknown> | undefined> = [];
      const orchestrator = new PlanningRoundOrchestrator({
        decompositionService: new TicketDecompositionService(), getMultiRoundDispatch: () => undefined,
        selectAgent: async (_item, _input, _units, phaseContext) => {
          routed.push(phaseContext);
          return { winner: { agentId: CODE_DEVELOPER, score: 1, reason: 'spec' }, ranked: [], strategy: 'keyword' };
        },
        registerParentsWithLifecycle: async () => undefined, persistWorkItems: async () => undefined,
      });
      const ticket = await approvedBuildTicket(tickets, USER_SUB, { pmAssignedAgentId });
      await orchestrator.execute({
        runId: 'run-1', item: buildWorkItem(ticket), input: {} as never, policy: {} as never,
        phaseGate: { complexity: 'low' } as never, workspaceTaskId: ticket.ticketId,
      });
      return routed[0]?.pmAssignedAgentId;
    };
    expect(await assignedTo(DEVELOPER_BOT)).toBeUndefined();
    expect(await assignedTo(DEVELOPER_BOT.toUpperCase())).toBeUndefined();
    expect(await assignedTo(CODE_DEVELOPER)).toBe(CODE_DEVELOPER);
  });

  it('phase-aware execution routing passes over a PM assignment of it', async () => {
    const handler = new SwarmRoutingHandler(new AgentRouter(), new PersonaLayerComposer());
    handler.setPhaseRoutingService(new PhaseRoutingService(new AgentRouter()));
    const input = {
      candidates: [{ agentId: DEVELOPER_BOT, score: 0.1, reason: 'roster' }, { agentId: CODE_DEVELOPER, score: 0.8, reason: 'roster' }],
      _currentPhase: 4, _ticketDepth: 0, _pmAssignedAgentId: DEVELOPER_BOT,
    };
    const decision = await handler.selectAgent(ITEM, input as never, []);
    expect(decision.winner.agentId).toBe(CODE_DEVELOPER);
    // An ordinary PM assignment still wins phase 4.
    const assigned = await handler.selectAgent(ITEM, { ...input, _pmAssignedAgentId: CODE_DEVELOPER } as never, []);
    expect(assigned.winner.agentId).toBe(CODE_DEVELOPER);
  });

  it('an adaptive reroute never picks it, even as the best-scored eligible agent', async () => {
    const handler = new SwarmRoutingHandler(new AgentRouter(), new PersonaLayerComposer());
    handler.setOnlineAgentIdsResolver(async () => { throw new Error('heartbeat read timed out'); });
    handler.setEligibilityService({
      evaluateAll: async () => [
        { agentId: DEVELOPER_BOT, agentName: 'oshal-developer', eligible: true, score: 0.99, rejectionReasons: [] },
        { agentId: GENERAL_BOT, agentName: 'general-bot', eligible: true, score: 0.4, rejectionReasons: [] },
      ],
    } as never);
    const decision = await handler.selectAgent(ITEM, { candidates: [{ agentId: CODE_DEVELOPER, score: 0.5, reason: 'roster' }] } as never, []);
    expect(decision.winner.agentId).toBe(GENERAL_BOT);
  });
});

/**
 * Runs one execution attempt through the real lifecycle's unsigned mesh hop, with a runner that calls dispatchExecution
 * (and, given a subtask, dispatchSubtask) once, as the real runner's first attempt does.
 */
async function runOnce(agentId: string, subtask = false): Promise<{ output: unknown; subtaskError: unknown; sent: string[] }> {
  const sent: string[] = [];
  let output: unknown;
  let subtaskError: unknown;
  const unit = { unitId: 'unit-1', title: 'Change', description: '', acceptanceCriteria: [], labels: [], depth: 0, parentUnitId: null };
  const lifecycle = new SwarmExecutionLifecycleService({
    executionPolicyRunner: {
      run: async (_item: unknown, _input: unknown, workUnits: unknown, routing: never, _policy: unknown, callbacks: Record<string, (...args: unknown[]) => Promise<unknown>>) => {
        output = await callbacks.dispatchExecution(routing, workUnits);
        if (subtask) subtaskError = await callbacks.dispatchSubtask(routing, { ...unit, unitId: 'unit-1-sub', depth: 1 }).then(() => null, (err: unknown) => err);
        return { workUnits, routing, verification: { status: 'passed' }, executionAttempts: 1, buildRegressionCount: 0, designRegressionCount: 0, policyDecisions: [], retryClasses: [] };
      },
    } as never,
    meshService: { send: async (envelope: { toAgentId: string }) => { sent.push(envelope.toAgentId); } } as never,
    routingHandler: {} as never, subtaskHandler: { persistSubtaskStatus: async () => undefined } as never, writebackHandler: {} as never,
    cyclePolicyService: {} as never, escalationStore: {} as never,
    getRegressionService: () => undefined, getGovernanceService: () => undefined, getSignedChildDispatch: () => undefined,
    selectAgent: async () => { throw new Error('not used'); },
  });
  const routing = { winner: { agentId, score: 1, reason: 'spec' }, ranked: [], strategy: 'catch-all' } as never;
  const item = { externalId: 'tix-mesh', title: 'Change', rawPayload: { metadata: {} } } as unknown as ExternalWorkItem;
  await lifecycle.runExecutionPolicy(item, {} as never, [unit] as never, routing, 'run-1', { maxRunDurationMs: 1_000 } as never, Date.now(), 'tix-mesh');
  return { output, subtaskError, sent };
}

describe('the unsigned mesh hop refuses a privileged worker', () => {
  it('returns a failure record and sends nothing, in any letter case, for execution and for a subtask', async () => {
    for (const agentId of [DEVELOPER_BOT, DEVELOPER_BOT.toUpperCase()]) {
      const { output, subtaskError, sent } = await runOnce(agentId, true);
      expect(output, agentId).toEqual({ status: 'failed', error: expect.stringContaining('privileged_worker_not_dispatchable') });
      expect(String((subtaskError as Error)?.message)).toContain('privileged_worker_not_dispatchable');
      expect(sent).toEqual([]);
    }
  });

  it('still sends a build specialist its work', async () => {
    const { output, subtaskError, sent } = await runOnce(CODE_DEVELOPER, true);
    expect(output).toBeUndefined();
    expect(subtaskError).toBeNull();
    expect(sent).toEqual([CODE_DEVELOPER, CODE_DEVELOPER]);
  });
});
