/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added five-cycle swarm ticket lifecycle state machine with transition guards
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added structured lifecycle transition logging for all public state-machine methods
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Upgraded to 7-phase lifecycle with complexity-driven phase skipping (legacy parity)
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import { createChildLogger } from '@/shared/logger';
import type { IntakeProvider } from '@/shared/types';
import { SWARM_PHASE_ORDER, type SwarmPhase, type PhaseGateConfig } from './phase-gate-config';

const logger = createChildLogger({ module: 'ticket-cycle-state-machine' });

/**
 * @description Legacy cycle order preserved for backward compatibility with existing tests and consumers.
 * New code should use SWARM_PHASE_ORDER from phase-gate-config.ts instead.
 */
export const SWARM_TICKET_CYCLE_ORDER = SWARM_PHASE_ORDER;

/**
 * @description One lifecycle cycle identifier. Now aliases SwarmPhase for 7-phase lifecycle.
 */
export type SwarmTicketCycle = SwarmPhase;

/**
 * @description Lifecycle status for one ticket cycle.
 */
export type SwarmTicketCycleStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

/**
 * @description One recorded cycle status snapshot.
 */
export interface SwarmTicketCycleRecord {
  cycle: SwarmTicketCycle;
  status: SwarmTicketCycleStatus;
  startedAt?: string;
  completedAt?: string;
  details?: Record<string, unknown>;
  error?: string;
}

/**
 * @description Lifecycle snapshot for a single ticket processing attempt.
 */
export interface SwarmTicketLifecycleSnapshot {
  provider: IntakeProvider;
  externalId: string;
  startedAt: string;
  completedAt?: string;
  overallStatus: 'in_progress' | 'completed' | 'failed';
  cycles: SwarmTicketCycleRecord[];
  complexity?: string;
  activePhaseCount?: number;
}

/**
 * @description State machine that enforces sequential execution for seven swarm processing phases.
 * Supports complexity-driven phase skipping — inactive phases are marked 'skipped' and do not
 * block progression to subsequent active phases.
 */
export class TicketCycleStateMachine {
  private readonly startedAt = new Date().toISOString();

  private completedAt?: string;

  private overallStatus: SwarmTicketLifecycleSnapshot['overallStatus'] = 'in_progress';

  private readonly cycleRecords = new Map<SwarmTicketCycle, SwarmTicketCycleRecord>(
    SWARM_PHASE_ORDER.map((cycle) => [
      cycle,
      {
        cycle,
        status: 'pending',
      },
    ]),
  );

  private readonly activePhases: Set<SwarmPhase>;

  private readonly complexity?: string;

  /**
   * @description Creates lifecycle state machine for one provider ticket.
   * @param provider - Intake provider key for the work item
   * @param externalId - Provider ticket identifier
   * @param phaseGateConfig - Optional phase gate configuration for complexity-driven skipping
   */
  constructor(
    private readonly provider: IntakeProvider,
    private readonly externalId: string,
    phaseGateConfig?: PhaseGateConfig,
  ) {
    if (phaseGateConfig) {
      this.activePhases = new Set(phaseGateConfig.activePhases);
      this.complexity = phaseGateConfig.complexity;
      // Mark inactive phases as skipped
      for (const phase of SWARM_PHASE_ORDER) {
        if (!this.activePhases.has(phase)) {
          this.updateRecord(phase, { status: 'skipped', completedAt: new Date().toISOString() });
        }
      }
    } else {
      // Default: all phases active (backward compatible)
      this.activePhases = new Set(SWARM_PHASE_ORDER);
    }

    logger.info(
      { provider, externalId, activePhaseCount: this.activePhases.size, complexity: this.complexity },
      'Initialized 7-phase ticket lifecycle state machine',
    );
  }

  /**
   * @description Checks if a phase is active (not skipped due to complexity gating).
   * @param cycle - Phase to check
   * @returns True if the phase should be executed
   */
  isActive(cycle: SwarmTicketCycle): boolean {
    return this.activePhases.has(cycle);
  }

  /**
   * @description Marks a cycle as in-progress after validating order.
   * @param cycle - Lifecycle cycle to start
   * @returns Updated lifecycle snapshot
   */
  begin(cycle: SwarmTicketCycle): SwarmTicketLifecycleSnapshot {
    this.ensureCanStart(cycle);
    this.updateRecord(cycle, {
      status: 'in_progress',
      startedAt: new Date().toISOString(),
      completedAt: undefined,
      error: undefined,
    });
    return this.logAndSnapshot(cycle, 'Phase started');
  }

  /**
   * @description Marks a cycle as completed and attaches cycle details.
   * @param cycle - Lifecycle cycle to mark complete
   * @param details - Structured details for audit and debugging
   * @returns Updated lifecycle snapshot
   */
  complete(cycle: SwarmTicketCycle, details: Record<string, unknown>): SwarmTicketLifecycleSnapshot {
    this.ensureStarted(cycle);
    this.updateRecord(cycle, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      details,
      error: undefined,
    });

    if (this.allActivePhasesComplete()) {
      this.overallStatus = 'completed';
      this.completedAt = new Date().toISOString();
    }

    return this.logAndSnapshot(cycle, 'Phase completed');
  }

  /**
   * @description Marks a cycle as failed and closes the lifecycle.
   * @param cycle - Lifecycle cycle that failed
   * @param error - Error object describing failure details
   * @returns Updated lifecycle snapshot
   */
  fail(cycle: SwarmTicketCycle, error: Error): SwarmTicketLifecycleSnapshot {
    this.updateRecord(cycle, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: error.message,
    });
    this.overallStatus = 'failed';
    this.completedAt = new Date().toISOString();

    logger.error(
      {
        err: error,
        provider: this.provider,
        externalId: this.externalId,
        cycle,
      },
      'Phase failed',
    );

    return this.snapshot();
  }

  /**
   * @description Returns current immutable lifecycle snapshot.
   * @returns Lifecycle snapshot with all cycle states
   */
  snapshot(): SwarmTicketLifecycleSnapshot {
    return {
      provider: this.provider,
      externalId: this.externalId,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      overallStatus: this.overallStatus,
      complexity: this.complexity,
      activePhaseCount: this.activePhases.size,
      cycles: SWARM_PHASE_ORDER.map((cycle) => {
        const record = this.cycleRecords.get(cycle);
        if (!record) {
          throw new Error(`Missing cycle record for ${cycle}`);
        }
        return { ...record };
      }),
    };
  }

  /**
   * @description Emits transition log and returns current snapshot.
   */
  private logAndSnapshot(cycle: SwarmTicketCycle, message: string): SwarmTicketLifecycleSnapshot {
    logger.info({ provider: this.provider, externalId: this.externalId, cycle }, message);
    return this.snapshot();
  }

  /**
   * @description Ensures a cycle can start only after prior active cycles are completed or skipped.
   */
  private ensureCanStart(cycle: SwarmTicketCycle): void {
    const cycleIndex = SWARM_PHASE_ORDER.indexOf(cycle);
    for (let index = 0; index < cycleIndex; index += 1) {
      const depCycle = SWARM_PHASE_ORDER[index];
      const depRecord = this.getRecord(depCycle);
      if (depRecord.status !== 'completed' && depRecord.status !== 'skipped') {
        throw new Error(`Cannot start phase ${cycle} before ${depCycle} is completed or skipped`);
      }
    }
  }

  /**
   * @description Ensures the targeted cycle has already started.
   */
  private ensureStarted(cycle: SwarmTicketCycle): void {
    const record = this.getRecord(cycle);
    if (record.status !== 'in_progress') {
      throw new Error(`Phase ${cycle} must be in_progress before completion`);
    }
  }

  /**
   * @description Checks if all active phases are completed.
   */
  private allActivePhasesComplete(): boolean {
    for (const phase of this.activePhases) {
      const record = this.getRecord(phase);
      if (record.status !== 'completed') return false;
    }
    return true;
  }

  private updateRecord(cycle: SwarmTicketCycle, patch: Partial<SwarmTicketCycleRecord>): void {
    const record = this.getRecord(cycle);
    this.cycleRecords.set(cycle, { ...record, ...patch });
  }

  private getRecord(cycle: SwarmTicketCycle): SwarmTicketCycleRecord {
    const record = this.cycleRecords.get(cycle);
    if (!record) throw new Error(`Unknown phase: ${cycle}`);
    return record;
  }
}
