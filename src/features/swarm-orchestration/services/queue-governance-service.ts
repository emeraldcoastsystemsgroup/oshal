/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial QueueGovernanceService — ticket lifecycle state tracking, cooldown enforcement, circuit-breaker detection, stale-ticket detection, reroute handling. Stage 2 of the complex-ticket reference gap plan.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Session 21: Added PostgresGovernanceStore — governance records survive restarts
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'queue-governance-service' });

// ---------------------------------------------------------------------------
// Lifecycle State
// ---------------------------------------------------------------------------

/**
 * @description Operator-visible ticket lifecycle states.
 * Maps to the target governance model defined in swarm-processing-design-contract.md.
 */
export type TicketLifecycleState =
  | 'todo'
  | 'routing'
  | 'in_progress'
  | 'in_review'
  | 'approval_required'
  | 'escalated'
  | 'done'
  | 'failed';

/**
 * @description Valid state transitions for the ticket lifecycle.
 */
const VALID_TRANSITIONS: Record<TicketLifecycleState, TicketLifecycleState[]> = {
  todo: ['routing'],
  routing: ['in_progress', 'failed'],
  in_progress: ['in_review', 'escalated', 'failed'],
  in_review: ['done', 'in_progress', 'approval_required', 'escalated'],
  approval_required: ['in_progress', 'escalated', 'failed'],
  escalated: ['todo', 'failed'],
  done: [],
  failed: ['todo'],
};

// ---------------------------------------------------------------------------
// Governance Record
// ---------------------------------------------------------------------------

/**
 * @description Tracks governance state for a single ticket in the queue.
 */
export interface TicketGovernanceRecord {
  ticketId: string;
  state: TicketLifecycleState;
  currentPhase?: string;
  currentRound?: number;
  assignedAgentId?: string;
  regressionCount: number;
  attemptCount: number;
  consecutiveFailures: number;
  lastAttemptAt?: string;
  lastStateChangeAt: string;
  cooldownUntil?: string;
  circuitBreakerTripped: boolean;
  reroute?: RerouteRequest;
  staleDetectedAt?: string;
  metadata?: Record<string, unknown>;
}

/**
 * @description A reroute request for a ticket.
 */
export interface RerouteRequest {
  targetAgentId: string;
  reason: string;
  requestedAt: string;
  requestedBy?: string;
}

// ---------------------------------------------------------------------------
// Governance Configuration
// ---------------------------------------------------------------------------

/**
 * @description Configuration for queue governance behavior.
 */
export interface QueueGovernanceConfig {
  /** Minimum time (ms) between processing attempts for the same ticket. */
  cooldownMs: number;
  /** Number of consecutive failures before tripping the circuit breaker. */
  circuitBreakerThreshold: number;
  /** Time (ms) a ticket can be in_progress before being flagged as stale. */
  staleThresholdMs: number;
  /** Maximum total attempts before permanent escalation. */
  maxTotalAttempts: number;
  /** Time (ms) before a circuit breaker resets (allows retry). */
  circuitBreakerResetMs: number;
}

const DEFAULT_GOVERNANCE_CONFIG: QueueGovernanceConfig = {
  cooldownMs: 60_000,
  circuitBreakerThreshold: 3,
  staleThresholdMs: 600_000, // 10 minutes
  maxTotalAttempts: 10,
  circuitBreakerResetMs: 300_000, // 5 minutes
};

// ---------------------------------------------------------------------------
// Governance Store Interface
// ---------------------------------------------------------------------------

/**
 * @description Persistence interface for ticket governance records.
 * Implementations may use Postgres, in-memory Map, or any backing store.
 */
export interface GovernanceStore {
  get(ticketId: string): Promise<TicketGovernanceRecord | undefined>;
  set(record: TicketGovernanceRecord): Promise<void>;
  getAll(): Promise<TicketGovernanceRecord[]>;
  getByState(state: TicketLifecycleState): Promise<TicketGovernanceRecord[]>;
  delete(ticketId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-Memory Governance Store
// ---------------------------------------------------------------------------

/**
 * @description In-memory implementation of the GovernanceStore.
 * Suitable for local development and testing. Production should use Postgres-backed store.
 */
export class InMemoryGovernanceStore implements GovernanceStore {
  private readonly records = new Map<string, TicketGovernanceRecord>();

  async get(ticketId: string): Promise<TicketGovernanceRecord | undefined> {
    return this.records.get(ticketId);
  }

  async set(record: TicketGovernanceRecord): Promise<void> {
    this.records.set(record.ticketId, record);
  }

  async getAll(): Promise<TicketGovernanceRecord[]> {
    return Array.from(this.records.values());
  }

  async getByState(state: TicketLifecycleState): Promise<TicketGovernanceRecord[]> {
    return Array.from(this.records.values()).filter((r) => r.state === state);
  }

  async delete(ticketId: string): Promise<void> {
    this.records.delete(ticketId);
  }
}

// ---------------------------------------------------------------------------
// Postgres Governance Store
// ---------------------------------------------------------------------------

const GOVERNANCE_TABLE = 'ticket_governance';

/**
 * @description Postgres-backed GovernanceStore. Governance records survive restarts.
 * Table is created idempotently on first access.
 */
export class PostgresGovernanceStore implements GovernanceStore {
  private schemaReady = false;

  constructor(private readonly pool: Pool) {}

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${GOVERNANCE_TABLE} (
        ticket_id TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'todo',
        current_phase TEXT,
        current_round INTEGER,
        assigned_agent_id TEXT,
        regression_count INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TIMESTAMPTZ,
        last_state_change_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        cooldown_until TIMESTAMPTZ,
        circuit_breaker_tripped BOOLEAN NOT NULL DEFAULT FALSE,
        reroute JSONB,
        stale_detected_at TIMESTAMPTZ,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    this.schemaReady = true;
    logger.info('Governance table schema ensured');
  }

  async get(ticketId: string): Promise<TicketGovernanceRecord | undefined> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(`SELECT * FROM ${GOVERNANCE_TABLE} WHERE ticket_id = $1`, [ticketId]);
    return rows[0] ? this.toRecord(rows[0]) : undefined;
  }

  async set(record: TicketGovernanceRecord): Promise<void> {
    await this.ensureSchema();
    const toIso = (v?: string): string | null => {
      if (!v) return null;
      try { return new Date(v).toISOString(); } catch { return v; }
    };
    await this.pool.query(`
      INSERT INTO ${GOVERNANCE_TABLE} (
        ticket_id, state, current_phase, current_round, assigned_agent_id,
        regression_count, attempt_count, consecutive_failures,
        last_attempt_at, last_state_change_at, cooldown_until,
        circuit_breaker_tripped, reroute, stale_detected_at, metadata, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
      ON CONFLICT (ticket_id) DO UPDATE SET
        state = EXCLUDED.state, current_phase = EXCLUDED.current_phase,
        current_round = EXCLUDED.current_round, assigned_agent_id = EXCLUDED.assigned_agent_id,
        regression_count = EXCLUDED.regression_count, attempt_count = EXCLUDED.attempt_count,
        consecutive_failures = EXCLUDED.consecutive_failures, last_attempt_at = EXCLUDED.last_attempt_at,
        last_state_change_at = EXCLUDED.last_state_change_at, cooldown_until = EXCLUDED.cooldown_until,
        circuit_breaker_tripped = EXCLUDED.circuit_breaker_tripped, reroute = EXCLUDED.reroute,
        stale_detected_at = EXCLUDED.stale_detected_at, metadata = EXCLUDED.metadata,
        updated_at = NOW()
    `, [
      record.ticketId, record.state, record.currentPhase ?? null, record.currentRound ?? null,
      record.assignedAgentId ?? null, record.regressionCount, record.attemptCount,
      record.consecutiveFailures, toIso(record.lastAttemptAt), toIso(record.lastStateChangeAt) || new Date().toISOString(),
      toIso(record.cooldownUntil), record.circuitBreakerTripped,
      record.reroute ? JSON.stringify(record.reroute) : null,
      record.staleDetectedAt ?? null, record.metadata ? JSON.stringify(record.metadata) : '{}',
    ]);
  }

  async getAll(): Promise<TicketGovernanceRecord[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(`SELECT * FROM ${GOVERNANCE_TABLE} ORDER BY updated_at DESC`);
    return rows.map((r) => this.toRecord(r));
  }

  async getByState(state: TicketLifecycleState): Promise<TicketGovernanceRecord[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(`SELECT * FROM ${GOVERNANCE_TABLE} WHERE state = $1`, [state]);
    return rows.map((r) => this.toRecord(r));
  }

  async delete(ticketId: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(`DELETE FROM ${GOVERNANCE_TABLE} WHERE ticket_id = $1`, [ticketId]);
  }

  private toRecord(row: Record<string, unknown>): TicketGovernanceRecord {
    return {
      ticketId: String(row.ticket_id),
      state: String(row.state) as TicketLifecycleState,
      currentPhase: row.current_phase ? String(row.current_phase) : undefined,
      currentRound: row.current_round != null ? Number(row.current_round) : undefined,
      assignedAgentId: row.assigned_agent_id ? String(row.assigned_agent_id) : undefined,
      regressionCount: Number(row.regression_count) || 0,
      attemptCount: Number(row.attempt_count) || 0,
      consecutiveFailures: Number(row.consecutive_failures) || 0,
      lastAttemptAt: row.last_attempt_at ? String(row.last_attempt_at) : undefined,
      lastStateChangeAt: String(row.last_state_change_at),
      cooldownUntil: row.cooldown_until ? String(row.cooldown_until) : undefined,
      circuitBreakerTripped: Boolean(row.circuit_breaker_tripped),
      reroute: row.reroute ? (row.reroute as RerouteRequest) : undefined,
      staleDetectedAt: row.stale_detected_at ? String(row.stale_detected_at) : undefined,
      metadata: row.metadata ? (row.metadata as Record<string, unknown>) : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Queue Governance Service
// ---------------------------------------------------------------------------

/**
 * @description QueueGovernanceService — operational governance layer for ticket processing.
 *
 * Responsibilities:
 * - Track ticket lifecycle states with valid transitions
 * - Enforce cooldown periods between processing attempts
 * - Detect and flag stale tickets (stuck in_progress)
 * - Trip circuit breaker after consecutive failures
 * - Handle reroute requests
 * - Provide queue state for cockpit API inspection
 *
 * This service is extracted from QueueManagerService to keep both files
 * under the 800-line governance threshold.
 */
export class QueueGovernanceService {
  private readonly config: QueueGovernanceConfig;
  private readonly store: GovernanceStore;

  constructor(store: GovernanceStore, config?: Partial<QueueGovernanceConfig>) {
    this.config = { ...DEFAULT_GOVERNANCE_CONFIG, ...config };
    this.store = store;
  }

  // -------------------------------------------------------------------------
  // Lifecycle State Management
  // -------------------------------------------------------------------------

  /**
   * @description Initialize a governance record for a new ticket entering the queue.
   * @param ticketId - The ticket identifier.
   * @returns The created governance record.
   */
  async initializeTicket(ticketId: string): Promise<TicketGovernanceRecord> {
    const now = new Date().toISOString();
    const record: TicketGovernanceRecord = {
      ticketId,
      state: 'todo',
      regressionCount: 0,
      attemptCount: 0,
      consecutiveFailures: 0,
      lastStateChangeAt: now,
      circuitBreakerTripped: false,
    };

    await this.store.set(record);
    logger.info({ ticketId, state: 'todo' }, 'Ticket governance initialized');
    return record;
  }

  /**
   * @description Transition a ticket to a new lifecycle state.
   * Validates that the transition is legal before applying.
   * @param ticketId - The ticket identifier.
   * @param newState - The target state.
   * @returns The updated governance record, or null if transition is invalid.
   */
  async transitionState(
    ticketId: string,
    newState: TicketLifecycleState,
  ): Promise<TicketGovernanceRecord | null> {
    const record = await this.store.get(ticketId);
    if (!record) {
      logger.warn({ ticketId, newState }, 'No governance record found for transition');
      return null;
    }

    if (!this.isValidTransition(record.state, newState)) {
      logger.warn(
        { ticketId, from: record.state, to: newState },
        'Invalid state transition attempted',
      );
      return null;
    }

    record.state = newState;
    record.lastStateChangeAt = new Date().toISOString();
    await this.store.set(record);

    logger.info({ ticketId, state: newState }, 'Ticket state transitioned');
    return record;
  }

  /**
   * @description Check if a state transition is valid.
   * @param from - Current state.
   * @param to - Target state.
   * @returns True if the transition is allowed.
   */
  isValidTransition(from: TicketLifecycleState, to: TicketLifecycleState): boolean {
    return VALID_TRANSITIONS[from]?.includes(to) ?? false;
  }

  // -------------------------------------------------------------------------
  // Cooldown Enforcement
  // -------------------------------------------------------------------------

  /**
   * @description Check if a ticket is currently in cooldown (too soon to reprocess).
   * @param ticketId - The ticket identifier.
   * @returns True if the ticket is in cooldown and should not be processed.
   */
  async isInCooldown(ticketId: string): Promise<boolean> {
    const record = await this.store.get(ticketId);
    if (!record?.cooldownUntil) return false;

    const now = Date.now();
    const cooldownEnd = new Date(record.cooldownUntil).getTime();
    return now < cooldownEnd;
  }

  /**
   * @description Apply cooldown to a ticket after a processing attempt.
   * @param ticketId - The ticket identifier.
   */
  async applyCooldown(ticketId: string): Promise<void> {
    const record = await this.store.get(ticketId);
    if (!record) return;

    const cooldownUntil = new Date(Date.now() + this.config.cooldownMs).toISOString();
    record.cooldownUntil = cooldownUntil;
    record.lastAttemptAt = new Date().toISOString();
    record.attemptCount++;

    await this.store.set(record);
    logger.debug({ ticketId, cooldownUntil }, 'Cooldown applied');
  }

  // -------------------------------------------------------------------------
  // Circuit Breaker
  // -------------------------------------------------------------------------

  /**
   * @description Check if the circuit breaker is tripped for a ticket.
   * A tripped circuit breaker means the ticket should not be processed.
   * @param ticketId - The ticket identifier.
   * @returns True if the circuit breaker is active.
   */
  async isCircuitBreakerTripped(ticketId: string): Promise<boolean> {
    const record = await this.store.get(ticketId);
    if (!record) return false;

    if (!record.circuitBreakerTripped) return false;

    // Check if circuit breaker has expired (auto-reset)
    if (record.lastAttemptAt) {
      const elapsed = Date.now() - new Date(record.lastAttemptAt).getTime();
      if (elapsed >= this.config.circuitBreakerResetMs) {
        record.circuitBreakerTripped = false;
        record.consecutiveFailures = 0;
        await this.store.set(record);
        logger.info({ ticketId }, 'Circuit breaker auto-reset');
        return false;
      }
    }

    return true;
  }

  /**
   * @description Record a failure and potentially trip the circuit breaker.
   * @param ticketId - The ticket identifier.
   * @param reason - The failure reason.
   * @returns True if the circuit breaker was tripped by this failure.
   */
  async recordFailure(ticketId: string, reason: string): Promise<boolean> {
    const record = await this.store.get(ticketId);
    if (!record) return false;

    record.consecutiveFailures++;
    record.lastAttemptAt = new Date().toISOString();

    const tripped = record.consecutiveFailures >= this.config.circuitBreakerThreshold;
    if (tripped) {
      record.circuitBreakerTripped = true;
      logger.warn(
        { ticketId, failures: record.consecutiveFailures, reason },
        'Circuit breaker tripped',
      );
    }

    // Check total attempt limit
    if (record.attemptCount >= this.config.maxTotalAttempts) {
      record.state = 'escalated';
      record.lastStateChangeAt = new Date().toISOString();
      logger.warn(
        { ticketId, attempts: record.attemptCount },
        'Max total attempts reached — ticket escalated',
      );
    }

    await this.store.set(record);
    return tripped;
  }

  /**
   * @description Record a successful processing, resetting failure counters.
   * @param ticketId - The ticket identifier.
   */
  async recordSuccess(ticketId: string): Promise<void> {
    const record = await this.store.get(ticketId);
    if (!record) return;

    record.consecutiveFailures = 0;
    record.circuitBreakerTripped = false;
    record.lastAttemptAt = new Date().toISOString();
    record.staleDetectedAt = undefined;
    await this.store.set(record);
  }

  // -------------------------------------------------------------------------
  // Stale Ticket Detection
  // -------------------------------------------------------------------------

  /**
   * @description Scan for tickets that have been in_progress longer than the stale threshold.
   * Should be called on each poll cycle.
   * @returns Array of ticket IDs detected as stale.
   */
  async detectStaleTickets(): Promise<string[]> {
    const inProgress = await this.store.getByState('in_progress');
    const now = Date.now();
    const staleIds: string[] = [];

    for (const record of inProgress) {
      const elapsed = now - new Date(record.lastStateChangeAt).getTime();
      if (elapsed >= this.config.staleThresholdMs && !record.staleDetectedAt) {
        record.staleDetectedAt = new Date().toISOString();
        await this.store.set(record);
        staleIds.push(record.ticketId);
        logger.warn(
          { ticketId: record.ticketId, elapsedMs: elapsed },
          'Stale ticket detected',
        );
      }
    }

    return staleIds;
  }

  // -------------------------------------------------------------------------
  // Reroute Handling
  // -------------------------------------------------------------------------

  /**
   * @description Submit a reroute request for a ticket.
   * The ticket will be reassigned to a different agent on the next processing attempt.
   * @param ticketId - The ticket identifier.
   * @param targetAgentId - The agent to reroute to.
   * @param reason - Why the reroute was requested.
   * @param requestedBy - Who requested the reroute (optional).
   * @returns The updated governance record, or null if ticket not found.
   */
  async requestReroute(
    ticketId: string,
    targetAgentId: string,
    reason: string,
    requestedBy?: string,
  ): Promise<TicketGovernanceRecord | null> {
    const record = await this.store.get(ticketId);
    if (!record) {
      logger.warn({ ticketId }, 'Reroute requested for unknown ticket');
      return null;
    }

    record.reroute = {
      targetAgentId,
      reason,
      requestedAt: new Date().toISOString(),
      requestedBy,
    };

    await this.store.set(record);
    logger.info({ ticketId, targetAgentId, reason }, 'Reroute requested');
    return record;
  }

  /**
   * @description Consume and clear a pending reroute request for a ticket.
   * Returns the reroute if one exists, then clears it.
   * @param ticketId - The ticket identifier.
   * @returns The reroute request, or undefined if none pending.
   */
  async consumeReroute(ticketId: string): Promise<RerouteRequest | undefined> {
    const record = await this.store.get(ticketId);
    if (!record?.reroute) return undefined;

    const reroute = record.reroute;
    record.reroute = undefined;
    await this.store.set(record);

    logger.info({ ticketId, targetAgentId: reroute.targetAgentId }, 'Reroute consumed');
    return reroute;
  }

  // -------------------------------------------------------------------------
  // Pre-Processing Gate
  // -------------------------------------------------------------------------

  /**
   * @description Check if a ticket is eligible for processing.
   * Combines cooldown, circuit-breaker, and max-attempt checks.
   * @param ticketId - The ticket identifier.
   * @returns Object with eligible flag and reason if not eligible.
   */
  async checkProcessingEligibility(
    ticketId: string,
  ): Promise<{ eligible: boolean; reason?: string }> {
    const record = await this.store.get(ticketId);

    if (!record) {
      return { eligible: true }; // New ticket, no governance record yet
    }

    if (record.state === 'done' || record.state === 'failed') {
      return { eligible: false, reason: `Ticket is in terminal state: ${record.state}` };
    }

    if (record.state === 'escalated') {
      return { eligible: false, reason: 'Ticket is escalated — requires operator intervention' };
    }

    if (record.state === 'approval_required') {
      return { eligible: false, reason: 'Ticket requires operator approval' };
    }

    if (await this.isInCooldown(ticketId)) {
      return { eligible: false, reason: `Ticket is in cooldown until ${record.cooldownUntil}` };
    }

    if (await this.isCircuitBreakerTripped(ticketId)) {
      return { eligible: false, reason: 'Circuit breaker is active for this ticket' };
    }

    if (record.attemptCount >= this.config.maxTotalAttempts) {
      return { eligible: false, reason: 'Max total attempts reached' };
    }

    return { eligible: true };
  }

  // -------------------------------------------------------------------------
  // Queue State Inspection (for Cockpit APIs)
  // -------------------------------------------------------------------------

  /**
   * @description Get the full queue state for cockpit inspection.
   * @returns All governance records.
   */
  async getQueueState(): Promise<TicketGovernanceRecord[]> {
    return this.store.getAll();
  }

  /**
   * @description Get tickets in a specific lifecycle state.
   * @param state - The state to filter by.
   * @returns Governance records matching the state.
   */
  async getTicketsByState(state: TicketLifecycleState): Promise<TicketGovernanceRecord[]> {
    return this.store.getByState(state);
  }

  /**
   * @description Get the governance record for a specific ticket.
   * @param ticketId - The ticket identifier.
   * @returns The governance record, or undefined if not found.
   */
  async getTicketGovernance(ticketId: string): Promise<TicketGovernanceRecord | undefined> {
    return this.store.get(ticketId);
  }

  /**
   * @description Get a summary of the queue state for operator dashboards.
   * @returns Object with counts per lifecycle state.
   */
  async getQueueSummary(): Promise<Record<TicketLifecycleState, number>> {
    const all = await this.store.getAll();
    const summary: Record<TicketLifecycleState, number> = {
      todo: 0,
      routing: 0,
      in_progress: 0,
      in_review: 0,
      approval_required: 0,
      escalated: 0,
      done: 0,
      failed: 0,
    };

    for (const record of all) {
      summary[record.state]++;
    }

    return summary;
  }

  /**
   * @description Update phase/round/agent tracking on a governance record.
   * @param ticketId - The ticket identifier.
   * @param phase - Current phase name.
   * @param round - Current round number.
   * @param agentId - Currently assigned agent ID.
   */
  async updateProcessingState(
    ticketId: string,
    phase: string,
    round: number,
    agentId?: string,
  ): Promise<void> {
    const record = await this.store.get(ticketId);
    if (!record) return;

    record.currentPhase = phase;
    record.currentRound = round;
    if (agentId) record.assignedAgentId = agentId;

    await this.store.set(record);
    logger.debug({ ticketId, phase, round, agentId }, 'Processing state updated');
  }

  /**
   * @description Increment the regression count for a ticket.
   * @param ticketId - The ticket identifier.
   * @returns The new regression count.
   */
  async incrementRegression(ticketId: string): Promise<number> {
    const record = await this.store.get(ticketId);
    if (!record) return 0;

    record.regressionCount++;
    await this.store.set(record);

    logger.info(
      { ticketId, regressionCount: record.regressionCount },
      'Regression count incremented',
    );
    return record.regressionCount;
  }
}