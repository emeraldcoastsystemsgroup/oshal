/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial multi-round dispatch service — wraps PhaseRoundOrchestrator for phases 2-6 with agent selection, dispatch, output collection, and handover enforcement
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added PHASE_DISPLAY_NAMES map — work item titles now show human-readable phase names instead of raw phase numbers (e.g. "Architecture Pre-Round" instead of "Phase 8")
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fix dispatch retry storm: dedup guard before workItemRepository.create(), inactivity clock only resets on assigned (not pending) items
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Fix poll-on-stale-failed bug: awaitRoundOutput no longer returns stale failed rows when a fresh pending/assigned dispatch is in flight
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Session 109: Extended dedup guard to also block work item creation when completed/failed item exists for same round. Prevents re-creating finished work. See ADR-023.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Session 109: Added failed output detection — if round output has status=failed, abort phase instead of advancing to next round.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed retired legacy product references (provider name is noop; narration removed)
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Idle-timeout directive (adversarial-review follow-up): OUTPUT_MAX_WAIT_MS raised 30min→2h (env-tunable) so output-waiting never gives up before a bot's 60-min idle ceiling.
 */

import { createChildLogger } from '@/shared/logger';
import { taskSubdirs } from '@/shared/workspace-task-dirs';
import {
  PhaseRoundOrchestrator,
  type RoundAssignment,
} from './phase-round-orchestrator';
import type { MeshEnvelope, MeshCommunicationService } from '@/features/agent-management';
import type { WorkItemRepository } from '@/entities/work-item';
import type { RALFHandoverManager } from './ralf-handover-manager';
import type { DecomposedWorkUnit } from './ticket-decomposition-service';
import type { SwarmCyclePolicy } from './swarm-cycle-policy';
import { buildExecutionEnvelope, sleep } from './swarm-ticket-processing-support';

const logger = createChildLogger({ module: 'multi-round-dispatch-service' });

/**
 * @description Human-readable phase names for work item titles and logs.
 * Maps internal phase numbers to display labels shown in cockpit.
 */
const PHASE_DISPLAY_NAMES: Record<number, string> = {
  2: 'Planning',
  3: 'Specialist Review',
  4: 'Execution',
  5: 'Testing',
  6: 'QA Review',
  7: 'Delivery',
  8: 'Architecture Pre-Round',
};

const OUTPUT_POLL_MS = 3000;
// Idle-timeout directive 2026-07-24: raised 30min→2h (env OUTPUT_MAX_WAIT_MS) so waiting
// for a bot's output never gives up before the bot's own 60-min idle ceiling could.
const OUTPUT_MAX_WAIT_MS = Number(process.env.OUTPUT_MAX_WAIT_MS) || 2 * 60 * 60 * 1000;

/**
 * @description Phase role assignments matching the legacy implementation's PhaseRoundOrchestrator pattern.
 * Each phase with 2 rounds gets a primary agent and a reviewer agent.
 */
const PHASE_ROLE_MAP: Record<number, { primaryRole: string; reviewerRole: string }> = {
  2: { primaryRole: 'architect', reviewerRole: 'plan-reviewer' },
  3: { primaryRole: 'domain-specialist', reviewerRole: 'challenge-reviewer' },
  4: { primaryRole: 'executor', reviewerRole: 'code-improver' },
  5: { primaryRole: 'tester', reviewerRole: 'qa-verifier' },
  6: { primaryRole: 'qa-gatekeeper', reviewerRole: 'domain-specialist-review' },
};

/**
 * @description Result from executing one round within a phase.
 */
export interface RoundExecutionResult {
  agentId: string;
  role: string;
  round: number;
  output: unknown;
  handoverValidated: boolean;
  durationMs: number;
}

/**
 * @description Result from executing all rounds in a phase.
 */
export interface PhaseDispatchResult {
  phase: number;
  rounds: RoundExecutionResult[];
  finalOutput: unknown;
  allRoundsComplete: boolean;
  handoversEnforced: boolean;
}

/**
 * @description Callback to select an agent for a specific phase/round role.
 */
export type AgentSelectorFn = (
  ticketId: string,
  phase: number,
  role: string,
  excludeAgentIds: string[],
) => Promise<string>;

/**
 * @description Dependencies for MultiRoundDispatchService.
 */
/**
 * @description Callback to record an agent assignment to a ticket.
 */
export type RecordAgentAssignmentFn = (
  ticketId: string,
  agentId: string,
  role: string,
  phase: string,
) => Promise<void>;

/**
 * @description Constructor dependencies for MultiRoundDispatchService — the mesh
 * transport used to dispatch envelopes, optional work-item persistence and handover
 * validation collaborators, and the agent-selection/assignment-recording callbacks.
 */
export interface MultiRoundDispatchDeps {
  meshService: MeshCommunicationService;
  workItemRepository?: WorkItemRepository;
  handoverManager?: RALFHandoverManager;
  selectAgent: AgentSelectorFn;
  recordAgentAssignment?: RecordAgentAssignmentFn;
}

/**
 * @description Orchestrates multi-round dispatch within each phase using PhaseRoundOrchestrator.
 * For phases 2-6, dispatches to a primary agent (round 1) and a reviewer agent (round 2).
 * Enforces handover completion between rounds and collects output from each agent.
 *
 * Ported from the legacy implementation, where PhaseRoundOrchestrator managed 2 rounds per phase
 * with different agents contributing sequentially.
 */
export class MultiRoundDispatchService {
  private readonly orchestrator = new PhaseRoundOrchestrator();
  private readonly meshService: MeshCommunicationService;
  private readonly workItemRepository?: WorkItemRepository;
  private readonly handoverManager?: RALFHandoverManager;
  private readonly selectAgent: AgentSelectorFn;
  private readonly recordAgentAssignment?: RecordAgentAssignmentFn;

  /**
   * @description Wire the service to its collaborators, retaining the mesh transport,
   * agent selector, and optional repository/handover/assignment dependencies.
   * @param deps - Mesh transport, agent selector, and optional persistence/handover collaborators
   */
  constructor(deps: MultiRoundDispatchDeps) {
    this.meshService = deps.meshService;
    this.workItemRepository = deps.workItemRepository;
    this.handoverManager = deps.handoverManager;
    this.selectAgent = deps.selectAgent;
    this.recordAgentAssignment = deps.recordAgentAssignment;
  }

  /**
   * @description Execute a phase with multi-round dispatch.
   * Selects agents for each round, dispatches sequentially, collects output,
   * and enforces handover completion between rounds.
   *
   * @param runId - Parent swarm run identifier
   * @param ticketId - External ticket identifier
   * @param phase - Phase number (2-6 for multi-round)
   * @param workUnits - Work units to dispatch
   * @param primaryAgentId - Pre-selected primary agent (from routing)
   * @param policy - Cycle policy for timeouts
   * @returns Phase dispatch result with per-round outputs
   */
  async executePhaseWithRounds(
    runId: string,
    ticketId: string,
    phase: number,
    workUnits: DecomposedWorkUnit[],
    primaryAgentId: string,
    policy: SwarmCyclePolicy,
    workspaceTaskId?: string,
  ): Promise<PhaseDispatchResult> {
    const phaseRoles = PHASE_ROLE_MAP[phase];
    if (!phaseRoles) {
      return this.executeSingleRound(runId, ticketId, phase, workUnits, primaryAgentId, policy, workspaceTaskId);
    }

    const reviewerAgentId = await this.resolveReviewerAgent(
      ticketId, phase, phaseRoles.reviewerRole, primaryAgentId,
    );

    const assignments: RoundAssignment[] = [
      { agentId: primaryAgentId, role: phaseRoles.primaryRole },
      { agentId: reviewerAgentId, role: phaseRoles.reviewerRole },
    ];

    this.orchestrator.initPhaseRounds(ticketId, phase, assignments);
    logger.info(
      { ticketId, phase, primaryAgentId, reviewerAgentId, roles: phaseRoles },
      'Multi-round phase initialized',
    );

    const rounds: RoundExecutionResult[] = [];
    let finalOutput: unknown = undefined;
    let allComplete = false;

    for (let roundIdx = 0; roundIdx < assignments.length; roundIdx++) {
      const currentAgent = this.orchestrator.getCurrentRoundAgent(ticketId, phase);
      if (!currentAgent) {
        logger.warn({ ticketId, phase, roundIdx }, 'No current round agent — breaking');
        break;
      }

      const roundResult = await this.executeOneRound(
        runId, ticketId, phase, currentAgent.round,
        currentAgent.agentId, currentAgent.role,
        workUnits, finalOutput, policy, workspaceTaskId,
      );
      rounds.push(roundResult);
      finalOutput = roundResult.output;

      // Detect failed execution output — cline exit code 1 or agent error
      const outputIsFailure = finalOutput != null
        && typeof finalOutput === 'object'
        && (finalOutput as Record<string, unknown>).status === 'failed';
      if (outputIsFailure) {
        const failError = (finalOutput as Record<string, unknown>).error ?? 'unknown';
        logger.error(
          { ticketId, phase, round: currentAgent.round, agentId: currentAgent.agentId, error: failError },
          'Round output indicates execution failure — aborting phase instead of advancing',
        );
        break;
      }

      const outputSummary = finalOutput == null
        ? '(no output received — execution may have timed out)'
        : typeof finalOutput === 'string' ? finalOutput.slice(0, 500) : JSON.stringify(finalOutput).slice(0, 500);
      const completionResult = this.orchestrator.completeRound(
        ticketId, phase, currentAgent.agentId,
        outputSummary,
      );

      if (completionResult.action === 'PHASE_COMPLETE') {
        allComplete = true;
        break;
      }
      if (completionResult.action === 'FAILED') {
        logger.error({ ticketId, phase, round: currentAgent.round }, 'Round failed — aborting phase');
        break;
      }
    }

    this.orchestrator.clearState(ticketId, phase);

    const handoversEnforced = rounds.every((r) => r.handoverValidated);
    logger.info(
      {
        ticketId, phase, roundCount: rounds.length, allComplete, handoversEnforced,
        agents: rounds.map((r) => ({ agentId: r.agentId, role: r.role })),
      },
      'Multi-round phase completed',
    );

    return { phase, rounds, finalOutput, allRoundsComplete: allComplete, handoversEnforced };
  }

  /**
   * @description Execute a single-round phase (for phases 1 and 7).
   */
  private async executeSingleRound(
    runId: string,
    ticketId: string,
    phase: number,
    workUnits: DecomposedWorkUnit[],
    agentId: string,
    policy: SwarmCyclePolicy,
    workspaceTaskId?: string,
  ): Promise<PhaseDispatchResult> {
    const roundResult = await this.executeOneRound(
      runId, ticketId, phase, 1, agentId, 'primary', workUnits, undefined, policy, workspaceTaskId,
    );

    return {
      phase,
      rounds: [roundResult],
      finalOutput: roundResult.output,
      allRoundsComplete: true,
      handoversEnforced: roundResult.handoverValidated,
    };
  }

  /**
   * @description Execute one round: dispatch envelope, await output, validate handover.
   */
  private async executeOneRound(
    runId: string,
    ticketId: string,
    phase: number,
    round: number,
    agentId: string,
    role: string,
    workUnits: DecomposedWorkUnit[],
    previousOutput: unknown,
    policy: SwarmCyclePolicy,
    workspaceTaskId?: string,
  ): Promise<RoundExecutionResult> {
    const startedAt = Date.now();
    const roundContext = this.orchestrator.buildRoundContext(ticketId, phase);

    logger.info(
      { ticketId, phase, round, agentId, role, workUnitCount: workUnits.length },
      'Dispatching round',
    );

    // Each round gets a unique unitId so output polling can distinguish Round 1 from Round 2.
    // Without this, the poll finds Round 1's completed output before Round 2 even starts.
    const roundUnitId = `${ticketId}-phase-${phase}-round-${round}`;

    const envelope = this.buildRoundEnvelope(
      runId, ticketId, phase, round, agentId, role, workUnits, previousOutput, roundContext, workspaceTaskId,
    );
    // Inject roundUnitId into envelope so the worker stores output on the correct work item
    (envelope.payload as Record<string, unknown>).roundUnitId = roundUnitId;

    // Dedup guard: skip creation if a pending/assigned/completed work item already exists for this round.
    // Without this guard, every retry cycle adds a new duplicate row in the DB.
    if (this.workItemRepository) {
      try {
        const existingItems = await this.workItemRepository.findByExternalIdAnyProvider(ticketId);
        const matchingRoundItem = existingItems.find(
          (wi) => (wi as { unitId?: string }).unitId === roundUnitId,
        );
        const alreadyExists = matchingRoundItem
          && (matchingRoundItem.status === 'pending' || matchingRoundItem.status === 'assigned');
        const alreadyCompleted = matchingRoundItem
          && (matchingRoundItem.status === 'completed' || matchingRoundItem.status === 'failed');
        if (alreadyCompleted) {
          logger.info({ ticketId, phase, round, roundUnitId, status: matchingRoundItem.status }, 'Skipping work item creation — round already completed (dedup)');
        } else if (alreadyExists) {
          logger.info({ ticketId, phase, round, roundUnitId }, 'Skipping work item creation — existing pending/assigned item found (dedup)');
        } else {
          await this.workItemRepository.create({
            swarmRunId: runId,
            externalId: ticketId,
            provider: 'direct',
            unitId: roundUnitId,
            title: `${PHASE_DISPLAY_NAMES[phase] ?? `Phase ${phase}`} Round ${round}: ${workUnits[0]?.title ?? ticketId}`,
            description: workUnits[0]?.description ?? '',
            labels: [],
            acceptanceCriteria: [],
            depth: 0,
          });
          logger.info({ ticketId, phase, round, roundUnitId }, 'Pre-created per-round work item for output tracking');
        }
      } catch (err) {
        logger.warn({ ticketId, roundUnitId, err: (err as Error).message }, 'Failed to pre-create round work item');
      }
    }

    await this.meshService.send(envelope);

    // Record every agent that touches this ticket
    if (this.recordAgentAssignment) {
      this.recordAgentAssignment(ticketId, agentId, role, `phase-${phase}`).catch((err) => {
        logger.warn({ err: (err as Error).message, ticketId, agentId, role }, 'Failed to record agent assignment (non-fatal)');
      });
    }

    const output = await this.awaitRoundOutput(ticketId, policy, roundUnitId);
    let handoverValidated = this.validateHandover(ticketId, agentId, phase, round);
    const durationMs = Date.now() - startedAt;

    // Handover enforcement: if no handover found in root workspace developer-handovers/,
    // log a hard warning. The QM checks this and can return the ticket.
    if (!handoverValidated) {
      logger.warn(
        { ticketId, phase, round, agentId },
        'HANDOVER MISSING — agent did not write developer handover to root workspace. Round output accepted but flagged.',
      );
      // Give the agent benefit of the doubt — the handover might be written under
      // a slightly different filename. Check once more with a relaxed match.
      handoverValidated = this.validateHandoverRelaxed(ticketId, phase, round);
      if (handoverValidated) {
        logger.info({ ticketId, phase, round }, 'Handover found on relaxed check');
      }
    }

    logger.info(
      { ticketId, phase, round, agentId, role, durationMs, handoverValidated, hasOutput: output !== undefined },
      'Round completed',
    );

    return { agentId, role, round, output, handoverValidated, durationMs };
  }

  /**
   * @description Build a mesh envelope with round context for dispatching to an agent.
   */
  private buildRoundEnvelope(
    runId: string,
    ticketId: string,
    phase: number,
    round: number,
    agentId: string,
    role: string,
    workUnits: DecomposedWorkUnit[],
    previousOutput: unknown,
    roundContext: ReturnType<PhaseRoundOrchestrator['buildRoundContext']>,
    workspaceTaskId?: string,
  ): MeshEnvelope {
    const resolvedWorkspaceId = workspaceTaskId || ticketId;
    const base = buildExecutionEnvelope(runId, agentId, ticketId, workUnits, resolvedWorkspaceId);

    const payload = base.payload as Record<string, unknown>;
    payload.phase = phase;
    payload.round = round;
    payload.role = role;
    payload.agentId = agentId;
    payload.workspaceTaskId = resolvedWorkspaceId;
    payload.ticketDepth = 0; // Multi-round dispatch is always root-level (children don't use multi-round)

    if (roundContext) {
      payload.roundContext = roundContext;
    }
    if (previousOutput) {
      payload.previousRoundOutput = typeof previousOutput === 'string'
        ? previousOutput.slice(0, 4000)
        : JSON.stringify(previousOutput).slice(0, 4000);
    }

    return base;
  }

  /**
   * @description Poll work items for execution completion output.
   * Checks DB for completed/failed status. If the work item is still 'assigned'
   * (agent actively processing), keeps waiting up to 30 minutes. Only times out
   * when the agent is no longer active AND no output has appeared.
   */
  /**
   * @description Poll for a specific round's work item output by unitId.
   * Each round has its own work item so we don't confuse Round 1 output with Round 2.
   */
  private async awaitRoundOutput(
    ticketId: string,
    policy: SwarmCyclePolicy,
    roundUnitId: string,
  ): Promise<unknown> {
    if (!this.workItemRepository) return undefined;

    const maxWaitMs = OUTPUT_MAX_WAIT_MS;
    const startedAt = Date.now();
    let lastAgentActiveMs = startedAt;

    while (Date.now() - startedAt < maxWaitMs) {
      // Query all items for this ticket, then filter to THIS round's unitId
      const allItems = await this.workItemRepository.findByExternalIdAnyProvider(ticketId);
      const roundItems = allItems.filter((wi) => (wi as { unitId?: string }).unitId === roundUnitId);

      // Check for completed output on THIS round's work item
      const completed = roundItems.filter((wi) => wi.status === 'completed' && wi.executionOutput);
      if (completed.length > 0) {
        const elapsed = Date.now() - startedAt;
        logger.info({ ticketId, roundUnitId, elapsedMs: elapsed }, 'Round output received');
        return completed[0].executionOutput;
      }

      // Check for failed — but ONLY when there is no pending/assigned item in flight.
      // If a pending item exists it means a fresh dispatch just went out; the failed rows
      // are from prior retry cycles and must be ignored or we return stale output immediately.
      const hasFreshDispatch = roundItems.some((wi) => wi.status === 'pending' || wi.status === 'assigned');
      if (!hasFreshDispatch) {
        const failed = roundItems.filter((wi) => wi.status === 'failed' && wi.executionOutput);
        if (failed.length > 0) {
          logger.warn({ ticketId, roundUnitId }, 'Round output received with failed status (no active dispatch)');
          return failed[0].executionOutput;
        }
      }

      // Check if agent is actively processing THIS round's item.
      // Only reset the inactivity clock when the item is 'assigned' (bot has picked it up).
      // 'pending' items that are never picked up must not keep the clock from expiring —
      // otherwise a dropped envelope causes an infinite wait instead of a 60s timeout.
      const assigned = roundItems.filter((wi) => wi.status === 'assigned');
      const pending = roundItems.filter((wi) => wi.status === 'pending');
      const active = [...assigned, ...pending];
      if (assigned.length > 0) {
        lastAgentActiveMs = Date.now();
      } else if (Date.now() - lastAgentActiveMs > 60_000) {
        logger.warn(
          { ticketId, roundUnitId, elapsedMs: Date.now() - startedAt },
          'No active or completed work item for this round for 60s — agent may have dropped the envelope',
        );
        break;
      }

      // Progress log every 30s
      const elapsed = Date.now() - startedAt;
      if (elapsed > 0 && elapsed % 30_000 < OUTPUT_POLL_MS) {
        logger.info(
          { ticketId, roundUnitId, elapsedMs: elapsed, activeCount: active.length, maxWaitMs },
          'Waiting for agent to complete round output',
        );
      }

      await sleep(OUTPUT_POLL_MS);
    }

    logger.warn(
      { ticketId, roundUnitId, maxWaitMs, elapsedMs: Date.now() - startedAt },
      'Timed out waiting for round output',
    );
    return undefined;
  }

  /**
   * @description Validate that the agent wrote a handover document for this round.
   * @returns True if handover exists and has required sections
   */
  private validateHandover(
    ticketId: string,
    agentId: string,
    phase: number,
    round: number,
  ): boolean {
    if (!this.handoverManager) return true;

    try {
      const handover = this.handoverManager.readAgentHandover(agentId, ticketId);
      if (!handover) {
        logger.warn({ ticketId, agentId, phase, round }, 'No handover document found');
        return false;
      }
      const hasRequiredContent = handover.content.length > 50;
      if (!hasRequiredContent) {
        logger.warn({ ticketId, agentId, phase, round, handoverLength: handover.content.length }, 'Handover too short');
        return false;
      }
      logger.info({ ticketId, agentId, phase, round }, 'Handover validated');
      return true;
    } catch (err) {
      logger.warn({ err, ticketId, agentId }, 'Handover validation failed');
      return false;
    }
  }

  /**
   * @description Relaxed handover check — scans both root workspace and agent-scoped
   * workspace developer-handovers/ for any file matching the phase/round pattern.
   * Agents write handovers to {ticketId}__{agentId}/developer-handovers/ but the
   * strict check only looks at {ticketId}/developer-handovers/.
   */
  private validateHandoverRelaxed(
    ticketId: string,
    phase: number,
    round: number,
  ): boolean {
    try {
      const fs = require('fs');
      const path = require('path');
      const wsRoot = process.env.SHARED_WORKSPACE_ROOT
        || (fs.existsSync('/app/workspace') ? '/app/workspace' : path.resolve(process.cwd(), 'workspace-shared'));
      const phasePattern = `PHASE_${phase}_ROUND_${round}`;
      const altPattern = `phase-${phase}-round-${round}`;

      // ADR-060: handovers may live flat, under users/<owner>/, or _shared/, plus agent
      // variants (<ticketId>__*) — check every location the bot could have written them.
      for (const dir of taskSubdirs(wsRoot, ticketId, 'developer-handovers')) {
        const files = fs.readdirSync(dir) as string[];
        if (files.find((f: string) => f.includes(phasePattern) || f.includes(altPattern))) return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * @description Resolve a reviewer agent that is different from the primary agent.
   */
  private async resolveReviewerAgent(
    ticketId: string,
    phase: number,
    role: string,
    excludePrimaryId: string,
  ): Promise<string> {
    try {
      return await this.selectAgent(ticketId, phase, role, [excludePrimaryId]);
    } catch (err) {
      // Phase-aware fallback: when agent selection fails, pick a default that
      // does NOT trip SP-10 (PM/QA bots reject Phase 4 execution envelopes).
      // The previous hardcoded `task-manager` fallback caused the build
      // pipeline to stall on Phase 4 with "PM/QA bots must not execute
      // implementation work" errors and no auto-retry (Issue #15).
      const phaseFallback: Record<number, string> = {
        2: 'a0000000-0000-0000-0000-000000000003', // PLANNING reviewer → code-reviewer
        3: 'a0000000-0000-0000-0000-000000000003', // SPECIALIST_INPUT challenge → code-reviewer
        4: 'a0000000-0000-0000-0000-000000000002', // EXECUTION code-improver → code-developer (NOT PM/QA)
        5: 'a0000000-0000-0000-0000-000000000005', // TESTING qa-verifier → test-engineer
        6: 'a0000000-0000-0000-0000-000000000006', // REVIEW domain-specialist-review → task-manager (review IS its job)
      };
      const fallback = phaseFallback[phase] ?? 'a0000000-0000-0000-0000-000000000006';
      logger.warn(
        { err: (err as Error).message, ticketId, phase, role, fallback },
        'Failed to select reviewer agent — using phase-aware fallback',
      );
      return fallback;
    }
  }
}