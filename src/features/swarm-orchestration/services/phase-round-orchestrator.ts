/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added PhaseRoundOrchestrator — multi-round state tracking per phase (ported from the legacy implementation)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'phase-round-orchestrator' });

/**
 * @description State of one round within a phase.
 */
export type RoundStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * @description One round entry within a phase orchestration.
 */
export interface RoundEntry {
  round: number;
  agentId: string;
  role: string;
  status: RoundStatus;
  startedAt?: string;
  completedAt?: string;
  output?: string;
}

/**
 * @description Full orchestration state for one ticket+phase combination.
 */
export interface PhaseRoundState {
  ticketId: string;
  phase: number;
  currentRound: number;
  maxRounds: number;
  state: 'round_in_progress' | 'all_rounds_complete' | 'failed';
  rounds: RoundEntry[];
  createdAt: string;
}

/**
 * @description Result of completing a round.
 */
export interface RoundCompletionResult {
  action: 'NEXT_ROUND' | 'PHASE_COMPLETE' | 'FAILED';
  state: PhaseRoundState;
  nextAgent?: { agentId: string; round: number; role: string };
}

/**
 * @description Round context injected into agent prompts.
 */
export interface RoundContext {
  currentRound: number;
  maxRounds: number;
  role: string;
  colleagues: Array<{ agentId: string; role: string; round: number }>;
  roleAssignments: Record<string, string>;
  previousRoundAgent?: string;
  previousRoundRole?: string;
}

/**
 * @description Agent assignment for a round.
 */
export interface RoundAssignment {
  agentId: string;
  role: string;
}

/**
 * @description Default round counts by phase. Phases 2-6 get 2 rounds (primary + reviewer).
 */
const DEFAULT_ROUNDS_PER_PHASE: Record<number, number> = {
  1: 1, // INTAKE — single pass
  2: 2, // PLANNING — architect + reviewer
  3: 2, // SPECIALIST_INPUT — specialist + challenge
  4: 2, // EXECUTION — executor + improver
  5: 2, // TESTING — tester + second tester
  6: 2, // REVIEW — task-manager + domain specialist
  7: 1, // DELIVERY — single pass
};

/**
 * @description PhaseRoundOrchestrator — manages multi-round execution within each phase.
 *
 * Ported from the legacy PhaseRoundOrchestrator.js. Each phase can have multiple rounds
 * where different agents contribute sequentially. The orchestrator tracks:
 * - Which round is current
 * - Which agent handles each round
 * - Round completion and advancement
 * - Context building for the next round's agent
 *
 * State is stored in-memory per ticket+phase combination. For production persistence,
 * the state can be serialized to Redis or Postgres.
 */
export class PhaseRoundOrchestrator {
  private readonly states = new Map<string, PhaseRoundState>();

  /**
   * @description Initialize round orchestration for a ticket+phase.
   * @param ticketId - External ticket identifier
   * @param phase - Phase number (1-7)
   * @param assignments - Ordered round assignments (agent + role per round)
   * @returns Initialized phase round state
   */
  initPhaseRounds(
    ticketId: string,
    phase: number,
    assignments: RoundAssignment[],
  ): PhaseRoundState {
    const maxRounds = assignments.length || DEFAULT_ROUNDS_PER_PHASE[phase] || 1;
    const rounds: RoundEntry[] = assignments.map((a, i) => ({
      round: i + 1,
      agentId: a.agentId,
      role: a.role,
      status: i === 0 ? 'in_progress' : 'pending',
      startedAt: i === 0 ? new Date().toISOString() : undefined,
    }));

    const state: PhaseRoundState = {
      ticketId,
      phase,
      currentRound: 1,
      maxRounds,
      state: 'round_in_progress',
      rounds,
      createdAt: new Date().toISOString(),
    };

    this.states.set(stateKey(ticketId, phase), state);
    logger.info(
      { ticketId, phase, maxRounds, firstAgent: assignments[0]?.agentId },
      'Phase rounds initialized',
    );
    return state;
  }

  /**
   * @description Check if round orchestration is active for a ticket+phase.
   * @param ticketId - External ticket identifier
   * @param phase - Phase number
   * @returns True if orchestration is active (rounds in progress)
   */
  isActive(ticketId: string, phase: number): boolean {
    const state = this.states.get(stateKey(ticketId, phase));
    return state?.state === 'round_in_progress';
  }

  /**
   * @description Get the current round's agent assignment.
   * @param ticketId - External ticket identifier
   * @param phase - Phase number
   * @returns Current round agent info, or null if not active
   */
  getCurrentRoundAgent(ticketId: string, phase: number): RoundEntry | null {
    const state = this.states.get(stateKey(ticketId, phase));
    if (!state || state.state !== 'round_in_progress') return null;
    return state.rounds.find((r) => r.round === state.currentRound) ?? null;
  }

  /**
   * @description Complete the current round and advance to next (or complete phase).
   * @param ticketId - External ticket identifier
   * @param phase - Phase number
   * @param agentId - Agent that completed the round
   * @param output - Agent's output/response
   * @returns Completion result indicating next action
   */
  completeRound(
    ticketId: string,
    phase: number,
    agentId: string,
    output?: string,
  ): RoundCompletionResult {
    const key = stateKey(ticketId, phase);
    const state = this.states.get(key);
    if (!state) {
      throw new Error(`No active orchestration for ticket ${ticketId} phase ${phase}`);
    }

    const currentRound = state.rounds.find((r) => r.round === state.currentRound);
    if (!currentRound) {
      throw new Error(`No round entry for round ${state.currentRound}`);
    }

    currentRound.status = 'completed';
    currentRound.completedAt = new Date().toISOString();
    currentRound.output = output;

    if (state.currentRound < state.maxRounds) {
      state.currentRound += 1;
      const nextRound = state.rounds.find((r) => r.round === state.currentRound);
      if (nextRound) {
        nextRound.status = 'in_progress';
        nextRound.startedAt = new Date().toISOString();
      }

      logger.info(
        { ticketId, phase, completedRound: state.currentRound - 1, nextRound: state.currentRound, nextAgent: nextRound?.agentId },
        'Round completed — advancing to next round',
      );

      return {
        action: 'NEXT_ROUND',
        state,
        nextAgent: nextRound ? { agentId: nextRound.agentId, round: nextRound.round, role: nextRound.role } : undefined,
      };
    }

    state.state = 'all_rounds_complete';
    logger.info({ ticketId, phase, totalRounds: state.maxRounds }, 'All rounds complete — phase finished');
    return { action: 'PHASE_COMPLETE', state };
  }

  /**
   * @description Fail the current round (e.g., agent error or timeout).
   */
  failRound(ticketId: string, phase: number, reason: string): RoundCompletionResult {
    const key = stateKey(ticketId, phase);
    const state = this.states.get(key);
    if (!state) {
      throw new Error(`No active orchestration for ticket ${ticketId} phase ${phase}`);
    }

    const currentRound = state.rounds.find((r) => r.round === state.currentRound);
    if (currentRound) {
      currentRound.status = 'failed';
      currentRound.completedAt = new Date().toISOString();
      currentRound.output = reason;
    }

    state.state = 'failed';
    logger.warn({ ticketId, phase, round: state.currentRound, reason }, 'Round failed');
    return { action: 'FAILED', state };
  }

  /**
   * @description Build round context for injection into the agent's prompt.
   * @param ticketId - External ticket identifier
   * @param phase - Phase number
   * @returns Round context with colleagues, roles, and previous round info
   */
  buildRoundContext(ticketId: string, phase: number): RoundContext | null {
    const state = this.states.get(stateKey(ticketId, phase));
    if (!state) return null;

    const current = state.rounds.find((r) => r.round === state.currentRound);
    if (!current) return null;

    const colleagues = state.rounds.map((r) => ({
      agentId: r.agentId,
      role: r.role,
      round: r.round,
    }));

    const roleAssignments: Record<string, string> = {};
    for (const r of state.rounds) {
      roleAssignments[r.role] = r.agentId;
    }

    const previousRound = state.currentRound > 1
      ? state.rounds.find((r) => r.round === state.currentRound - 1)
      : undefined;

    return {
      currentRound: state.currentRound,
      maxRounds: state.maxRounds,
      role: current.role,
      colleagues,
      roleAssignments,
      previousRoundAgent: previousRound?.agentId,
      previousRoundRole: previousRound?.role,
    };
  }

  /**
   * @description Get full state for a ticket+phase (for debugging/persistence).
   */
  getState(ticketId: string, phase: number): PhaseRoundState | null {
    return this.states.get(stateKey(ticketId, phase)) ?? null;
  }

  /**
   * @description Clear state for a ticket+phase after phase is complete.
   */
  clearState(ticketId: string, phase: number): void {
    this.states.delete(stateKey(ticketId, phase));
  }
}

function stateKey(ticketId: string, phase: number): string {
  return `${ticketId}:${phase}`;
}
