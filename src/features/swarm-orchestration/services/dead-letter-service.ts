/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial DeadLetterService — persisted poison-ticket policy for the queue manager (migration 081 / oshal_queue_dlq). Records every failed dispatch cycle AND every system escalation cycle per ticket; after QM_MAX_ATTEMPTS (env, default 3) the ticket is quarantined into the terminal 'dead_letter' state with reason metadata, the operator is notified on topic 'queue-dlq', and only an operator requeue (attempts reset, actor recorded) releases it. Covers the BACKLOG "Build phase auto-escalates" loop: N escalation cycles = poison. Fail-open discipline mirrors BudgetService: a missing pool/table never quarantines and never bricks dispatch.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix (dead-code guard): handleTicketStatusEvent now counts an escalation cycle ONLY when changedBy === 'system' (the queue-manager auto-loop actor) instead of the old changedBy !== 'user' exclusion — no producer ever emitted 'user', so manual operator escalations (now actor-tagged by the cockpit status routes) and bot self-escalations were being mis-counted and could terminal-quarantine a deliberately-escalated ticket.
 */

import type { TicketService } from '@/features/ticketing';
import { createChildLogger } from '@/shared/logger';
import { ticketEvents, type TicketStatusChangedEvent } from '@/shared/ticket-events';

const logger = createChildLogger({ module: 'dead-letter-service' });

/** @description Default failed-cycle ceiling when QM_MAX_ATTEMPTS is unset/invalid. */
export const DEFAULT_QM_MAX_ATTEMPTS = 3;

/**
 * @description Resolves the poison threshold from the environment at check time (so operators
 * can retune QM_MAX_ATTEMPTS without a restart, mirroring the BudgetService runaway knobs).
 * @param env - Environment bag (injectable for tests).
 * @returns The max failed dispatch/escalation cycles before quarantine (>= 1).
 */
export function readQmMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(String(env.QM_MAX_ATTEMPTS ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_QM_MAX_ATTEMPTS;
}

/**
 * @description Minimal Postgres surface the service needs (structurally a pg.Pool). Kept
 * local so this feature slice doesn't deep-import another slice's Pg contract.
 */
export interface DeadLetterPg {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * @description What kind of failed cycle is being recorded.
 *  - 'dispatch_failure'  : a dispatch attempt failed and was rolled back for retry.
 *  - 'escalation_cycle'  : the ticket transitioned to 'escalated' by the 'system' actor
 *                          (the queue-manager auto-escalate loop signature from the BACKLOG
 *                          bug — operator/agent escalations carry their own identity and don't count).
 */
export type DeadLetterFailureKind = 'dispatch_failure' | 'escalation_cycle';

/**
 * @description Result of recording one failed cycle — a result object, never a throw, so the
 * queue manager's dispatch path can hook this without new failure modes.
 */
export interface FailureCycleVerdict {
  /** Persisted attempts after this cycle (0 when persistence is unavailable — fail-open). */
  attempts: number;
  /** True when the ticket is now (or already was) quarantined in the DLQ. */
  quarantined: boolean;
  /** Machine-readable quarantine reason when quarantined. */
  reason?: string;
}

/** @description One DLQ entry as returned by the operator listing/requeue surface. */
export interface DeadLetterEntry {
  ticketId: string;
  attempts: number;
  lastError: string | null;
  lastFailureAt: string | null;
  quarantinedAt: string | null;
  reason: string | null;
  requeuedBy: string | null;
  requeuedAt: string | null;
  /** Joined ticket columns (null when the ticket row is gone). */
  title?: string | null;
  status?: string | null;
  ticketType?: string | null;
}

/** @description Result of an operator requeue — a result object mapped to HTTP by the route. */
export type RequeueResult =
  | { ok: true; entry: DeadLetterEntry }
  | { ok: false; error: 'not-found' | 'invalid-state' | 'unavailable' };

/**
 * @description Outbound quarantine alert hook. The app layer injects the real sender (the
 * notification-center NotificationRouter fanned out to the operator allowlist on topic
 * 'queue-dlq'); the service only formats the message. Must resolve, never gate quarantine.
 */
export type DeadLetterNotifier = (
  topic: string,
  message: { subject: string; body: string; shortText?: string },
) => Promise<unknown>;

/**
 * @description Construction dependencies. The ticket gateway is the real TicketService
 * (Pick keeps the unit-test surface small); pool null = degraded fail-open mode.
 */
export interface DeadLetterServiceDeps {
  /** Postgres for the oshal_queue_dlq table; null runs degraded (never quarantines). */
  pool: DeadLetterPg | null;
  /** Ticket lifecycle gateway — status flips go through the validated transition model. */
  ticketService: Pick<TicketService, 'getTicket' | 'updateStatus' | 'updateStatusAs'>;
  /** Quarantine alert hook (topic 'queue-dlq'); absent = logged no-op. */
  notify?: DeadLetterNotifier;
  /** Environment bag for QM_MAX_ATTEMPTS; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

const LIST_SQL = `
  SELECT d.ticket_id, d.attempts, d.last_error, d.last_failure_at, d.quarantined_at,
         d.reason, d.requeued_by, d.requeued_at,
         t.title, t.status, t.ticket_type
    FROM oshal_queue_dlq d
    LEFT JOIN tickets t ON t.ticket_id::text = d.ticket_id
   WHERE ($1::boolean OR d.quarantined_at IS NOT NULL)
   ORDER BY COALESCE(d.quarantined_at, d.last_failure_at) DESC NULLS LAST
   LIMIT 200`;

/**
 * @description Persisted dead-letter policy for the queue manager. One counter per ticket in
 * oshal_queue_dlq accumulates failed dispatch cycles (hooked from QueueManagerService's
 * rollback path) and system escalation cycles (subscribed from the shared ticketEvents bus —
 * the auto-escalate loop the BACKLOG documents). Reaching QM_MAX_ATTEMPTS quarantines the
 * ticket into the terminal 'dead_letter' state (validated transition + reason metadata),
 * notifies the operator on topic 'queue-dlq', and stops the retry churn: the poll loop only
 * pulls 'approved' tickets, so a dead_letter ticket is structurally undispatchable until an
 * operator requeues it (attempts reset, actor recorded in requeued_by/requeued_at).
 */
export class DeadLetterService {
  private readonly deps: DeadLetterServiceDeps;
  private listener: ((event: TicketStatusChangedEvent) => void) | null = null;

  /**
   * @description Constructs the service.
   * @param deps - Pool + ticket gateway + optional notifier/env (see DeadLetterServiceDeps).
   */
  constructor(deps: DeadLetterServiceDeps) {
    this.deps = deps;
  }

  /**
   * @description Subscribes to the shared ticket event bus so every non-human transition to
   * 'escalated' counts as one failed cycle — this is what catches the auto-escalate loop
   * (escalate → re-approve → escalate …) that no dispatch-path hook ever sees. Idempotent.
   * @returns Nothing.
   */
  start(): void {
    if (this.listener) {
      logger.warn('DeadLetterService escalation listener already attached');
      return;
    }
    this.listener = (event) => this.handleTicketStatusEvent(event);
    ticketEvents.onStatusChanged(this.listener);
    logger.info({ maxAttempts: readQmMaxAttempts(this.deps.env) }, 'DeadLetterService started — escalation-cycle listener attached');
  }

  /**
   * @description Detaches the escalation-cycle listener (tests / shutdown). Idempotent.
   * @returns Nothing.
   */
  stop(): void {
    if (!this.listener) return;
    ticketEvents.removeListener('status-changed', this.listener);
    this.listener = null;
    logger.info('DeadLetterService stopped — escalation-cycle listener detached');
  }

  /**
   * @description Event-bus entry point (public so tests can drive it directly). Counts a
   * failed cycle ONLY when a ticket lands in 'escalated' by the 'system' actor — the signature
   * of the queue-manager auto-escalate loop (circuit breaker / rollback / deferred sweep /
   * work-item reconciliation all transition with no explicit actor, defaulting to 'system').
   * A human operator's manual escalation carries their own identity (the cockpit status routes
   * call updateStatusAs with the caller) and a bot self-escalation carries its agentId — neither
   * is the runaway loop this policy quarantines, so neither is counted. (The earlier
   * `changedBy === 'user'` exclusion was dead code: no producer in the codebase emits 'user'.)
   * Never throws.
   * @param event - The ticket status transition from the shared bus.
   * @returns Nothing (fire-and-forget; persistence outcome is logged).
   */
  handleTicketStatusEvent(event: TicketStatusChangedEvent): void {
    if (event.toStatus !== 'escalated') return;
    if (event.changedBy !== 'system') {
      logger.debug(
        { ticketId: event.ticketId, changedBy: event.changedBy },
        'Non-system escalation (operator/agent action) — not counted toward dead-letter',
      );
      return;
    }
    void this.recordFailureCycle(
      event.ticketId,
      'escalation_cycle',
      `escalation cycle (changedBy=${event.changedBy}, from=${event.fromStatus})`,
    ).catch((err) => {
      // recordFailureCycle already guards, but the void chain must never surface a rejection.
      logger.error({ err, stack: (err as Error).stack, ticketId: event.ticketId }, 'Escalation-cycle recording failed unexpectedly');
    });
  }

  /**
   * @description Records one failed dispatch/escalation cycle for a ticket and quarantines it
   * when the persisted count reaches QM_MAX_ATTEMPTS. Fail-open: without a pool (or on any
   * write failure) it returns attempts=0/quarantined=false and NEVER quarantines — a broken
   * DLQ store must not brick the retry path.
   * @param ticketId - The failing ticket.
   * @param kind - Which failure signal produced this cycle.
   * @param lastError - Sanitized error text for the DLQ row (never secrets/prompts).
   * @returns The verdict (attempts so far, whether the ticket is now quarantined).
   */
  async recordFailureCycle(
    ticketId: string,
    kind: DeadLetterFailureKind,
    lastError?: string,
  ): Promise<FailureCycleVerdict> {
    if (!this.deps.pool) {
      logger.warn({ ticketId, kind }, 'recordFailureCycle: no DB pool — dead-letter tracking disabled (fail-open)');
      return { attempts: 0, quarantined: false };
    }
    const boundedError = lastError ? lastError.slice(0, 500) : null;
    let attempts: number;
    let alreadyQuarantined: boolean;
    try {
      const result = await this.deps.pool.query(
        `INSERT INTO oshal_queue_dlq (ticket_id, attempts, last_error, last_failure_at)
         VALUES ($1, 1, $2, NOW())
         ON CONFLICT (ticket_id) DO UPDATE
           SET attempts = oshal_queue_dlq.attempts + 1,
               last_error = COALESCE($2, oshal_queue_dlq.last_error),
               last_failure_at = NOW(),
               updated_at = NOW()
         RETURNING attempts, quarantined_at, reason`,
        [ticketId, boundedError],
      );
      attempts = Number(result.rows[0]?.attempts ?? 0);
      alreadyQuarantined = result.rows[0]?.quarantined_at != null;
      if (alreadyQuarantined) {
        // Already parked — don't re-flip status or re-notify on trailing failure signals.
        return { attempts, quarantined: true, reason: String(result.rows[0]?.reason ?? 'quarantined') };
      }
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, ticketId, kind }, 'recordFailureCycle: DLQ upsert failed — fail-open, no quarantine');
      return { attempts: 0, quarantined: false };
    }

    const maxAttempts = readQmMaxAttempts(this.deps.env);
    logger.info({ ticketId, kind, attempts, maxAttempts }, 'Failed queue cycle recorded');
    if (attempts < maxAttempts) {
      return { attempts, quarantined: false };
    }
    const reason = kind === 'escalation_cycle' ? 'escalation_loop_poison' : 'max_dispatch_attempts_poison';
    const quarantined = await this.quarantine(ticketId, reason, boundedError, attempts);
    return { attempts, quarantined, ...(quarantined ? { reason } : {}) };
  }

  /**
   * @description Quarantines one ticket: validated status flip to terminal 'dead_letter'
   * (with reason metadata — the ticket-service backstop guarantees it is never bare), then
   * marks the DLQ row, then alerts the operator on topic 'queue-dlq'. Ordering matters: if
   * the status flip fails (e.g. the ticket was cancelled meanwhile) the row is NOT marked
   * quarantined, so the DLQ view never claims a quarantine that didn't happen.
   * @param ticketId - The poison ticket.
   * @param reason - Machine-readable quarantine reason.
   * @param lastError - The most recent failure detail, for the metadata trail.
   * @param attempts - The persisted cycle count that tripped the policy.
   * @returns True when the ticket is now in 'dead_letter'.
   */
  private async quarantine(
    ticketId: string,
    reason: string,
    lastError: string | null,
    attempts: number,
  ): Promise<boolean> {
    try {
      await this.deps.ticketService.updateStatus(ticketId, 'dead_letter', {
        reason,
        source: 'dead-letter-service',
        attempts,
        maxAttempts: readQmMaxAttempts(this.deps.env),
        ...(lastError ? { lastError } : {}),
      });
    } catch (err) {
      logger.error(
        { err, stack: (err as Error).stack, ticketId, reason, attempts },
        'Quarantine status flip failed — ticket NOT moved to dead_letter (row left unquarantined for a later cycle)',
      );
      return false;
    }
    try {
      await this.deps.pool!.query(
        `UPDATE oshal_queue_dlq
            SET quarantined_at = NOW(), reason = $2, updated_at = NOW()
          WHERE ticket_id = $1`,
        [ticketId, reason],
      );
    } catch (err) {
      // Status already flipped — the ticket IS quarantined; only the row marker failed.
      logger.error({ err, stack: (err as Error).stack, ticketId }, 'DLQ row quarantine marker write failed (ticket already dead_letter)');
    }
    logger.warn({ ticketId, reason, attempts }, 'Ticket quarantined to dead-letter');
    this.fireQuarantineAlert(ticketId, reason, attempts, lastError);
    return true;
  }

  /**
   * @description Fire-and-forget operator alert on topic 'queue-dlq'. An unconfigured or
   * failing notifier is a logged skip — notification never gates or unwinds a quarantine.
   */
  private fireQuarantineAlert(ticketId: string, reason: string, attempts: number, lastError: string | null): void {
    const notify = this.deps.notify;
    if (!notify) {
      logger.info({ ticketId, reason }, 'No dead-letter notifier configured — quarantine alert skipped');
      return;
    }
    void notify('queue-dlq', {
      subject: `OSHAL queue DLQ: ticket ${ticketId} quarantined (${reason})`,
      body: [
        `Ticket ${ticketId} was quarantined to the dead-letter queue after ${attempts} failed cycles.`,
        `Reason: ${reason}`,
        lastError ? `Last error: ${lastError}` : 'Last error: (none recorded)',
        `Requeue via POST /api/queue/dlq/${ticketId}/requeue once the cause is fixed.`,
      ].join('\n'),
      shortText: `OSHAL DLQ: ticket ${ticketId} quarantined (${reason}, ${attempts} cycles).`,
    }).catch((err) => {
      logger.error({ err, stack: (err as Error).stack, ticketId }, 'Dead-letter quarantine alert send failed (non-fatal)');
    });
  }

  /**
   * @description Lists DLQ entries for the operator surface, joined with the live ticket row
   * (title/status/type). Quarantined-only by default; includeUnquarantined also shows tickets
   * accumulating attempts that haven't tripped the policy yet.
   * @param includeUnquarantined - True to include not-yet-quarantined attempt rows.
   * @returns Entries newest-first (empty on infra gap, logged — listing must not 500).
   */
  async listEntries(includeUnquarantined = false): Promise<DeadLetterEntry[]> {
    if (!this.deps.pool) {
      logger.warn('listEntries: no DB pool — returning empty DLQ');
      return [];
    }
    try {
      const result = await this.deps.pool.query(LIST_SQL, [includeUnquarantined]);
      return result.rows.map(mapDlqRow);
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack }, 'listEntries: DLQ read failed — returning empty list');
      return [];
    }
  }

  /**
   * @description Operator requeue: releases a quarantined ticket back to 'approved' with the
   * acting operator recorded (actor-aware status history + requeued_by/requeued_at on the DLQ
   * row) and the attempt counter reset to zero so the circuit breaker starts fresh.
   * @param ticketId - The quarantined ticket to release.
   * @param requeuedBy - The operator identity (email or sub) performing the release.
   * @returns Result object: ok+entry, or not-found / invalid-state / unavailable.
   */
  async requeue(ticketId: string, requeuedBy: string): Promise<RequeueResult> {
    if (!this.deps.pool) {
      logger.warn({ ticketId }, 'requeue: no DB pool — DLQ store unavailable');
      return { ok: false, error: 'unavailable' };
    }
    let row: Record<string, unknown> | undefined;
    try {
      const result = await this.deps.pool.query(
        `SELECT ticket_id, attempts, last_error, last_failure_at, quarantined_at, reason, requeued_by, requeued_at
           FROM oshal_queue_dlq WHERE ticket_id = $1`,
        [ticketId],
      );
      row = result.rows[0];
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, ticketId }, 'requeue: DLQ read failed');
      return { ok: false, error: 'unavailable' };
    }
    if (!row || row.quarantined_at == null) {
      logger.warn({ ticketId, hasRow: Boolean(row) }, 'requeue: ticket is not quarantined in the DLQ');
      return { ok: false, error: 'not-found' };
    }
    try {
      await this.deps.ticketService.updateStatusAs(ticketId, 'approved', requeuedBy, `Operator ${requeuedBy}`, {
        reason: 'dlq_requeue',
        source: 'dead-letter-service',
        requeuedBy,
        previousAttempts: Number(row.attempts ?? 0),
      });
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, ticketId, requeuedBy }, 'requeue: status flip to approved failed');
      return { ok: false, error: 'invalid-state' };
    }
    try {
      await this.deps.pool.query(
        `UPDATE oshal_queue_dlq
            SET attempts = 0, quarantined_at = NULL, reason = NULL,
                requeued_by = $2, requeued_at = NOW(), updated_at = NOW()
          WHERE ticket_id = $1`,
        [ticketId, requeuedBy],
      );
    } catch (err) {
      // Ticket already released; only the counter reset failed. Loud log so an operator
      // knows the next failure may quarantine faster than expected.
      logger.error({ err, stack: (err as Error).stack, ticketId }, 'requeue: DLQ counter reset failed after release (ticket IS approved)');
    }
    logger.info({ ticketId, requeuedBy }, 'Dead-letter ticket requeued to approved by operator');
    return {
      ok: true,
      entry: {
        ...mapDlqRow(row),
        attempts: 0,
        quarantinedAt: null,
        reason: null,
        requeuedBy,
        requeuedAt: new Date().toISOString(),
      },
    };
  }
}

/**
 * @description Maps a raw oshal_queue_dlq (+ joined tickets) row to the camel-cased entry.
 * @param row - Raw row from pg.
 * @returns The DeadLetterEntry.
 */
function mapDlqRow(row: Record<string, unknown>): DeadLetterEntry {
  return {
    ticketId: String(row.ticket_id ?? ''),
    attempts: Number(row.attempts ?? 0),
    lastError: readNullableText(row.last_error),
    lastFailureAt: readNullableStamp(row.last_failure_at),
    quarantinedAt: readNullableStamp(row.quarantined_at),
    reason: readNullableText(row.reason),
    requeuedBy: readNullableText(row.requeued_by),
    requeuedAt: readNullableStamp(row.requeued_at),
    title: readNullableText(row.title),
    status: readNullableText(row.status),
    ticketType: readNullableText(row.ticket_type),
  };
}

function readNullableText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNullableStamp(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}
