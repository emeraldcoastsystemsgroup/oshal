/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added swarm agent worker for consuming and executing mesh envelopes from Redis Streams
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added orphan recovery: claimOrphaned before polling for new messages
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fixed recordOutput to update work item status to completed after writing execution output
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Cleaned up debug logging after successful M3 pipeline validation
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Phase 4: Added orphan deduplication — skip already-completed work items before execution
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Multi-channel subscription: listen on agent direct channels + broadcast alongside ticket execution
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Fix assigned-callback gap: markAssigned() now called immediately after isAlreadyCompleted() and before handler — stops 60s inactivity timeout from firing while LLM is running
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Session 109: Added isTicketTerminal check — worker queries DB ticket status before executing envelope, ACKs and skips complete/escalated tickets. Prevents stale Redis stream re-dispatch.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Fixed child-ticket execution persistence so subtask-* statuses transition to terminal states and no longer stall execution polling
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | SP-10: Phase-to-bot enforcement — PM/QA bots reject Phase 4 EXECUTION envelopes, prevents misrouted execution work
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Remove broad throttle/auth keyword patterns from EXECUTION_FAILURE_PATTERNS: they scanned successful output content and force-escalated completed tickets whose answer merely mentioned 429/quota/unauthorized. Genuine failures still detected via result.success===false.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Ran the mesh poll loop under runWithSystemIdentity: envelope execution is background work (no request in scope) that reads/writes work items + records chat_tasks cost (FORCE-RLS). Stamping SYSTEM keeps it visible once OSHAL_DB_GUC_STRICT denies the identity-less case (previously it relied on the fail-open-to-operator branch deny removes).
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import type { MeshTransport, MeshEnvelope, MeshSubscription, ConsumedEnvelope } from '@/features/agent-management';
import type { WorkItemRepository } from '@/entities/work-item';
import type { WorkItemStatus } from '@/entities/work-item';

const logger = createChildLogger({ module: 'swarm-agent-worker' });

/**
 * @description Pluggable execution handler invoked for each consumed envelope.
 */
export type EnvelopeExecutionHandler = (envelope: MeshEnvelope) => Promise<EnvelopeExecutionResult>;

/**
 * @description Result returned by an envelope execution handler.
 */
export interface EnvelopeExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
}

/**
 * @description Handler for direct/broadcast messages received on agent channels.
 */
export type DirectMessageHandler = (envelope: MeshEnvelope, entryId: string) => Promise<void>;

/**
 * @description Construction options for SwarmAgentWorker.
 */
/**
 * @description Checks whether a ticket is in a terminal state (complete/escalated).
 * Returns true if the ticket should NOT be executed.
 */
export type TicketTerminalChecker = (ticketId: string) => Promise<boolean>;
export type TicketTerminalUpdater = (
  ticketId: string,
  status: 'complete' | 'escalated',
  metadata: Record<string, unknown>,
) => Promise<void>;
export type TicketAssignmentRecorder = (
  ticketId: string,
  agentId: string,
  metadata: {
    source: 'swarm-agent-worker';
    workItemId: string;
    correlationId: string;
    phase?: number;
    round?: number;
    roundUnitId?: string;
  },
) => Promise<void>;
export type TicketActivityRecorder = (
  ticketId: string,
  metadata: Record<string, unknown>,
) => Promise<void>;

/**
 * @description Construction options controlling channel subscriptions, consumer-group routing,
 * polling cadence, and the optional repository/handler/terminal-check hooks for a SwarmAgentWorker.
 */
export interface SwarmAgentWorkerOptions {
  transport: MeshTransport;
  channel?: string;
  consumerId?: string;
  /** Consumer group for execution envelopes. Separate from reply listener group. */
  consumerGroup?: string;
  pollIntervalMs?: number;
  handler?: EnvelopeExecutionHandler;
  workItemRepository?: WorkItemRepository;
  additionalChannels?: string[];
  directHandler?: DirectMessageHandler;
  /** @description Optional check to skip envelopes for tickets that are already complete/escalated in the DB. */
  isTicketTerminal?: TicketTerminalChecker;
  /** @description Optional bridge from terminal work-item results back to persisted ticket state. */
  updateTicketStatus?: TicketTerminalUpdater;
  /** @description Optional bridge from accepted work envelopes back to visible ticket assignment. */
  recordTicketAssignment?: TicketAssignmentRecorder;
  /** @description Optional bridge for internal worker heartbeat/activity notes. */
  recordTicketActivity?: TicketActivityRecorder;
  /** @description Interval for worker heartbeat notes while an envelope is executing. */
  activityHeartbeatMs?: number;
}

/**
 * @description Consumes mesh envelopes from a Redis Stream channel and executes them.
 */
export class SwarmAgentWorker {
  private readonly transport: MeshTransport;
  private readonly channel: string;
  private readonly consumerId: string;
  private readonly consumerGroup: string;
  private readonly pollIntervalMs: number;
  private readonly handler: EnvelopeExecutionHandler;
  private readonly workItemRepository?: WorkItemRepository;
  private readonly additionalChannels: string[];
  private readonly directHandler: DirectMessageHandler;
  private readonly isTicketTerminal?: TicketTerminalChecker;
  private readonly updateTicketStatus?: TicketTerminalUpdater;
  private readonly recordTicketAssignment?: TicketAssignmentRecorder;
  private readonly recordTicketActivity?: TicketActivityRecorder;
  private readonly activityHeartbeatMs: number;
  private readonly subscriptions: MeshSubscription[] = [];
  private running = false;

  /**
   * @description Initializes the worker from the supplied options, applying defaults for channel,
   * consumer id, consumer group, poll interval, and the execution/direct handlers when omitted.
   * @param options - Worker construction options.
   */
  constructor(options: SwarmAgentWorkerOptions) {
    this.transport = options.transport;
    this.channel = options.channel || 'swarm.ticket.execute';
    this.consumerId = options.consumerId || `worker-${randomUUID().slice(0, 8)}`;
    this.consumerGroup = options.consumerGroup || 'swarm-execution';
    this.pollIntervalMs = options.pollIntervalMs || Number(process.env.SWARM_WORKER_POLL_MS) || 3000;
    this.handler = options.handler || defaultHandler;
    this.workItemRepository = options.workItemRepository;
    this.additionalChannels = options.additionalChannels || [];
    this.directHandler = options.directHandler || defaultDirectHandler;
    this.isTicketTerminal = options.isTicketTerminal;
    this.updateTicketStatus = options.updateTicketStatus;
    this.recordTicketAssignment = options.recordTicketAssignment;
    this.recordTicketActivity = options.recordTicketActivity;
    this.activityHeartbeatMs = options.activityHeartbeatMs ?? readPositiveInteger(process.env.OSHAL_WORKER_HEARTBEAT_MS, 60_000);
  }

  /**
   * @description Starts the worker polling loop.
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    const transportWithPurge = this.transport as unknown as {
      purgeStaleConsumers?: (channel: string, consumerId: string) => Promise<void>;
    };
    if (typeof transportWithPurge.purgeStaleConsumers === 'function') {
      await transportWithPurge.purgeStaleConsumers(this.channel, this.consumerId);
    }

    for (const ch of this.additionalChannels) {
      const sub = this.transport.subscribe(ch, this.consumerId, this.directHandler, this.pollIntervalMs);
      this.subscriptions.push(sub);
      logger.info({ channel: ch, consumerId: this.consumerId }, 'Subscribed to additional channel');
    }

    logger.info(
      { channel: this.channel, consumerId: this.consumerId, additionalChannels: this.additionalChannels },
      'Swarm agent worker started',
    );
    // Run the whole poll loop under the trusted SYSTEM sentinel so every envelope's DB work
    // (work-item status, chat_tasks cost — FORCE-RLS) keeps operator visibility once
    // OSHAL_DB_GUC_STRICT denies the identity-less case. The async context propagates through
    // the loop and each awaited processEnvelope.
    runWithSystemIdentity(() => this.poll()).catch((err) => {
      logger.error({ err, channel: this.channel }, 'Worker poll loop exited unexpectedly — restarting');
      this.running = false;
      setTimeout(() => this.start(), 5000);
    });
  }

  /**
   * @description Stops the worker polling loop and all channel subscriptions.
   */
  stop(): void {
    this.running = false;
    for (const sub of this.subscriptions) {
      sub.stop();
    }
    this.subscriptions.length = 0;
    logger.info({ channel: this.channel, consumerId: this.consumerId }, 'Swarm agent worker stopped');
  }

  /**
   * @description Hot-swaps the worker to a new agent channel.
   * Used by the node pool to switch bot identities without restarting the process.
   * Stops current subscriptions → changes channel → restarts polling.
   *
   * @param newChannel - The new Redis stream channel to consume (e.g. agent.{newAgentId})
   * @param newAdditionalChannels - Optional additional channels to subscribe to
   */
  async reassign(newChannel: string, newAdditionalChannels?: string[]): Promise<void> {
    const previousChannel = this.channel;
    logger.info(
      { previousChannel, newChannel, consumerId: this.consumerId },
      'SwarmAgentWorker: reassigning to new channel (hot-swap)',
    );

    // Stop current polling and subscriptions
    this.stop();

    // Update channel — use Object.assign to bypass readonly
    Object.assign(this, { channel: newChannel });
    if (newAdditionalChannels) {
      Object.assign(this, { additionalChannels: newAdditionalChannels });
    }

    // Restart with new channel
    await this.start();

    logger.info(
      { previousChannel, newChannel, consumerId: this.consumerId },
      'SwarmAgentWorker: reassigned successfully',
    );
  }

  /**
   * @description Returns the current channel this worker is consuming from.
   */
  getChannel(): string {
    return this.channel;
  }

  /**
   * @description Returns whether the worker is actively polling.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * @description Polls the Redis stream for new envelopes and processes them.
   */
  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const transportWithClaim = this.transport as MeshTransport & {
          claimOrphaned?: (channel: string, consumerId: string, minIdleMs?: number, count?: number, group?: string) => Promise<ConsumedEnvelope[]>;
        };
        const orphaned = typeof transportWithClaim.claimOrphaned === 'function'
          ? await transportWithClaim.claimOrphaned(this.channel, this.consumerId, 5000, 5, this.consumerGroup)
          : [];
        for (const { entryId, envelope } of orphaned) {
          await this.processEnvelope(entryId, envelope);
        }
        // Use dedicated execution consumer group so the worker doesn't compete with
        // the reply listener on the same agent channel. Without this, the reply listener
        // consumes execution envelopes (like Round 2) and drops them.
        const transportWithGroup = this.transport as MeshTransport & {
          consumeWithGroup?: (channel: string, consumerId: string, group: string, count?: number) => Promise<ConsumedEnvelope[]>;
        };
        const consumed = typeof transportWithGroup.consumeWithGroup === 'function'
          ? await transportWithGroup.consumeWithGroup(this.channel, this.consumerId, this.consumerGroup, 5)
          : await this.transport.consume(this.channel, this.consumerId, 5);
        for (const { entryId, envelope } of consumed) {
          await this.processEnvelope(entryId, envelope);
        }
      } catch (error) {
        logger.error({ err: error, channel: this.channel }, 'Worker poll error');
      }
      if (this.running) {
        await sleep(this.pollIntervalMs);
      }
    }
  }

  /**
   * @description Processes a single consumed envelope and acknowledges it.
   * @param entryId - Redis stream entry ID
   * @param envelope - Parsed mesh envelope
   */
  private async processEnvelope(entryId: string, envelope: MeshEnvelope): Promise<void> {
    const startedAt = Date.now();
    logger.info(
      { correlationId: envelope.correlationId, toAgentId: envelope.toAgentId, entryId },
      'Processing mesh envelope',
    );
    try {
      // Delegate bid requests to the directHandler instead of processing as work items
      const payloadSignalType = (envelope.payload as Record<string, unknown>)?.signalType;
      if (payloadSignalType === 'BID_REQUEST') {
        await this.directHandler(envelope, entryId);
        await this.transport.ack(this.channel, entryId, this.consumerGroup);
        return;
      }

      // Check if the ticket itself is terminal (complete/escalated) before doing any work.
      // This prevents stale Redis stream messages from spawning cline on finished tickets.
      const ticketId = extractExactUuid(envelope.payload?.externalId);
      if (ticketId && this.isTicketTerminal) {
        try {
          if (await this.isTicketTerminal(ticketId)) {
            await this.transport.ack(this.channel, entryId, this.consumerGroup);
            logger.info(
              { correlationId: envelope.correlationId, ticketId, entryId },
              'Skipping envelope — ticket is in terminal state (complete/escalated)',
            );
            return;
          }
        } catch (err) {
          logger.warn({ err, ticketId }, 'Ticket terminal check failed (non-fatal) — proceeding with execution');
        }
      }

      // SP-10: Phase-to-bot enforcement — reject envelopes that violate phase-role rules.
      // When this fires, mark the matching work item as routing_failed so the
      // routing-watchdog picks it up at next sweep (much faster than waiting for
      // the 30-min stale threshold) and re-resolves to a non-PM/QA specialist.
      if (this.shouldRejectForPhaseViolation(envelope)) {
        await this.transport.ack(this.channel, entryId, this.consumerGroup);
        if (this.workItemRepository) {
          const externalId = envelope.payload?.externalId as string | undefined;
          const explicitRoundUnitId = envelope.payload?.roundUnitId as string | undefined;
          if (externalId) {
            try {
              const items = await this.workItemRepository.findByExternalIdAnyProvider(externalId);
              const targets = explicitRoundUnitId
                ? items.filter((it) => (it as { unitId?: string }).unitId === explicitRoundUnitId)
                : items.filter((it) => it.status === 'assigned' || it.status === 'pending');
              for (const it of targets) {
                await this.workItemRepository.updateStatus(it.workItemId, 'routing_failed');
              }
            } catch (err) {
              logger.warn({ err: (err as Error).message, externalId }, 'SP-10: failed to mark work item routing_failed (non-fatal)');
            }
          }
        }
        return;
      }

      const completedWorkItem = await this.findAlreadyCompletedWorkItem(envelope);
      if (completedWorkItem) {
        await this.updateTicketFromStoredWorkItem(envelope, completedWorkItem);
        await this.transport.ack(this.channel, entryId, this.consumerGroup);
        logger.info(
          { correlationId: envelope.correlationId, entryId },
          'Skipping already-completed work item (orphan dedup)',
        );
        return;
      }
      await this.markAssigned(envelope);
      await this.recordExecutionActivity(ticketId, envelope, 'execution_started', {
        entryId,
        elapsedMs: Date.now() - startedAt,
      });
      const stopHeartbeat = this.startExecutionHeartbeat(ticketId, envelope, startedAt);
      let result: EnvelopeExecutionResult;
      try {
        result = await this.handler(envelope);
      } catch (error) {
        await this.recordExecutionActivity(ticketId, envelope, 'execution_failed', {
          entryId,
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        stopHeartbeat();
      }
      await this.transport.ack(this.channel, entryId, this.consumerGroup);
      await this.recordResult(envelope, result);
      await this.recordExecutionActivity(ticketId, envelope, result.success ? 'execution_finished' : 'execution_failed', {
        entryId,
        elapsedMs: Date.now() - startedAt,
        resultSuccess: result.success,
        error: result.error,
      });
      logger.info(
        { correlationId: envelope.correlationId, success: result.success, durationMs: Date.now() - startedAt },
        'Mesh envelope processed',
      );
    } catch (error) {
      logger.error(
        { err: error, correlationId: envelope.correlationId, entryId, durationMs: Date.now() - startedAt },
        'Mesh envelope processing failed',
      );
    }
  }

  /**
   * @description Starts a periodic internal heartbeat for a running envelope.
   */
  private startExecutionHeartbeat(
    ticketId: string | undefined,
    envelope: MeshEnvelope,
    startedAt: number,
  ): () => void {
    if (!ticketId || !this.recordTicketActivity || this.activityHeartbeatMs <= 0) {
      return () => undefined;
    }
    const timer = setInterval(() => {
      this.recordExecutionActivity(ticketId, envelope, 'execution_heartbeat', {
        elapsedMs: Date.now() - startedAt,
      }).catch((err) => {
        logger.warn({ err, ticketId, correlationId: envelope.correlationId }, 'Failed to record worker heartbeat');
      });
    }, this.activityHeartbeatMs);
    (timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  }

  /**
   * @description Records a compact internal activity note for the ticket.
   */
  private async recordExecutionActivity(
    ticketId: string | undefined,
    envelope: MeshEnvelope,
    event: 'execution_started' | 'execution_heartbeat' | 'execution_finished' | 'execution_failed',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!ticketId || !this.recordTicketActivity) {
      return;
    }
    try {
      await this.recordTicketActivity(ticketId, {
        source: 'swarm-agent-worker',
        event,
        internalComment: true,
        correlationId: envelope.correlationId,
        agentId: envelope.toAgentId,
        channel: envelope.channel,
        workItemExternalId: envelope.payload?.externalId,
        roundUnitId: envelope.payload?.roundUnitId,
        phase: envelope.payload?.phase,
        round: envelope.payload?.round,
        ...metadata,
      });
    } catch (err) {
      logger.warn({ err, ticketId, event, correlationId: envelope.correlationId }, 'Failed to record ticket execution activity');
    }
  }

  /**
   * @description Marks the work item for this envelope as 'assigned' immediately before the LLM
   * handler is invoked. Without this, the work item stays 'pending' for the entire duration of
   * the LLM execution, causing the API server's inactivity timeout (60s) to fire and re-dispatch
   * the same ticket — the root cause of the dispatch retry storm.
   *
   * @param envelope - Mesh envelope being processed
   */
  private async markAssigned(envelope: MeshEnvelope): Promise<void> {
    if (!this.workItemRepository) return;
    const externalId = envelope.payload?.externalId as string | undefined;
    if (!externalId) return;

    const explicitRoundUnitId = envelope.payload?.roundUnitId as string | undefined;
    const phase = envelope.payload?.phase as number | undefined;
    const round = envelope.payload?.round as number | undefined;
    const roundUnitId = explicitRoundUnitId
      || (externalId && phase && round ? `${externalId}-phase-${phase}-round-${round}` : undefined);

    try {
      const items = await this.workItemRepository.findByExternalIdAnyProvider(externalId);
      const roundTargets = roundUnitId
        ? items.filter((item) => (item as { unitId?: string }).unitId === roundUnitId && isClaimableExecutionStatus(item.status))
        : [];
      const targets = roundTargets.length > 0
        ? roundTargets
        : items.filter((item) => isClaimableExecutionStatus(item.status));

      for (const item of targets) {
        const nextStatus = resolveActiveExecutionStatus(item.status);
        if (nextStatus !== item.status) {
          await this.workItemRepository.updateStatus(item.workItemId, nextStatus, envelope.toAgentId);
        }
        await this.recordAcceptedTicketAssignment(envelope, item.workItemId, roundUnitId);
        logger.info(
          { workItemId: item.workItemId, externalId, roundUnitId, nextStatus },
          'Work item marked assigned — bot has accepted the envelope',
        );
        break; // Only mark one item per round
      }
    } catch (error) {
      // Non-fatal: log and continue — the LLM should still run even if the status update fails
      logger.warn({ err: error, externalId, roundUnitId }, 'Failed to mark work item assigned (non-fatal)');
    }
  }

  private async recordAcceptedTicketAssignment(
    envelope: MeshEnvelope,
    workItemId: string,
    roundUnitId?: string,
  ): Promise<void> {
    if (!this.recordTicketAssignment) {
      return;
    }
    const ticketId = extractExactUuid(envelope.payload?.externalId);
    const agentId = envelope.toAgentId;
    if (!ticketId || !agentId) {
      return;
    }
    const phase = readOptionalNumber(envelope.payload, 'phase');
    const round = readOptionalNumber(envelope.payload, 'round');
    try {
      await this.recordTicketAssignment(ticketId, agentId, {
        source: 'swarm-agent-worker',
        workItemId,
        correlationId: envelope.correlationId,
        ...(phase != null ? { phase } : {}),
        ...(round != null ? { round } : {}),
        ...(roundUnitId ? { roundUnitId } : {}),
      });
    } catch (error) {
      logger.warn({ err: error, ticketId, agentId, workItemId }, 'Failed to record accepted ticket assignment (non-fatal)');
    }
  }

  /**
   * @description Checks whether the work item for this envelope is already completed with output.
   * Prevents XAUTOCLAIM orphan recovery from spawning redundant executions.
   * @param envelope - Mesh envelope to check
   * @returns True if the work item is already completed
   */
  private async findAlreadyCompletedWorkItem(envelope: MeshEnvelope): Promise<WorkItemExecutionSnapshot | null> {
    if (!this.workItemRepository) {
      return null;
    }
    const externalId = envelope.payload?.externalId as string | undefined;
    if (!externalId) {
      return null;
    }
    try {
      const items = await findByExternalIdCompat(this.workItemRepository, externalId);

      // If this envelope has round context, check the SPECIFIC round's work item.
      // Without this, Round 1's completed item causes Round 2 to be skipped.
      const phase = envelope.payload?.phase as number | undefined;
      const round = envelope.payload?.round as number | undefined;
      if (phase && round) {
        const roundUnitId = `${externalId}-phase-${phase}-round-${round}`;
        const roundItem = items.find((item) => (item as { unitId?: string }).unitId === roundUnitId);
        // If this round's specific item exists and is already terminal with stored output, skip it.
        // If it doesn't exist or is still active, it's NOT already completed.
        return roundItem && hasTerminalExecutionResult(roundItem.status, roundItem.executionOutput) ? roundItem : null;
      }

      // No round context — skip if ANY item for this ticket is already terminal with persisted output.
      return items.find((item) => hasTerminalExecutionResult(item.status, item.executionOutput)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * @description Stores terminal execution results on matching work items.
   * @param envelope - Processed envelope
   * @param result - Execution result
   */
  private async recordResult(envelope: MeshEnvelope, result: EnvelopeExecutionResult): Promise<void> {
    if (!this.workItemRepository) {
      return;
    }
    const externalId = envelope.payload?.externalId as string | undefined;
    // Reconstruct roundUnitId from envelope fields if not explicitly set
    const explicitRoundUnitId = envelope.payload?.roundUnitId as string | undefined;
    const phase = envelope.payload?.phase as number | undefined;
    const round = envelope.payload?.round as number | undefined;
    const roundUnitId = explicitRoundUnitId
      || (externalId && phase && round ? `${externalId}-phase-${phase}-round-${round}` : undefined);
    if (!externalId) {
      return;
    }
    try {
      const items = await findByExternalIdCompat(this.workItemRepository, externalId);

      // If envelope has a roundUnitId, only update THAT specific work item.
      // This prevents Round 1 completion from clobbering Round 2's work item.
      const targetItems = roundUnitId
        ? items.filter((item) => (item as { unitId?: string }).unitId === roundUnitId)
        : items;

      // Fall back to all non-completed items if roundUnitId match yields nothing
      const candidates = targetItems.length > 0
        ? targetItems
        : items.filter((item) => isRecordableExecutionStatus(item.status));

      for (const item of candidates) {
        if (isRecordableExecutionStatus(item.status)) {
          const persistedOutput = result.success
            ? result.output
            : {
                status: 'failed',
                error: result.error ?? 'Unknown agent execution error',
                output: result.output ?? null,
              };
          const terminalStatus = resolveTerminalExecutionStatus(item.status, result.success);
          await this.workItemRepository.setExecutionOutput(item.workItemId, persistedOutput);
          await this.workItemRepository.updateStatus(
            item.workItemId,
            terminalStatus,
            item.assignedAgentId || envelope.toAgentId,
          );
          await this.updateTicketTerminalState(envelope, result, terminalStatus, item.workItemId, roundUnitId);
          logger.info(
            { workItemId: item.workItemId, externalId, roundUnitId, success: result.success, terminalStatus },
            'Work item execution result stored',
          );
          break; // Only update one item per round
        }
      }
    } catch (error) {
      logger.error({ err: error, correlationId: envelope.correlationId }, 'Failed to record execution output');
    }
  }

  private async updateTicketTerminalState(
    envelope: MeshEnvelope,
    result: EnvelopeExecutionResult,
    terminalStatus: WorkItemStatus,
    workItemId: string,
    roundUnitId?: string,
  ): Promise<void> {
    if (!this.updateTicketStatus || (terminalStatus !== 'completed' && terminalStatus !== 'failed')) {
      return;
    }
    const ticketId = extractExactUuid(envelope.payload?.externalId);
    if (!ticketId) {
      return;
    }

    const failureMessage = detectExecutionFailure(result);
    const ticketStatus = terminalStatus === 'completed' && !failureMessage ? 'complete' : 'escalated';
    const metadata: Record<string, unknown> = {
      source: 'swarm-agent-worker',
      workItemId,
      roundUnitId,
      correlationId: envelope.correlationId,
      agentId: envelope.toAgentId,
      terminalStatus,
      resultSuccess: result.success,
    };
    if (ticketStatus === 'escalated') {
      const failureClass = classifyExecutionFailure(failureMessage || result.error || '');
      metadata.reason = 'swarm_worker_execution_failed';
      metadata.message = failureMessage || result.error || 'Worker execution failed';
      metadata.failureClass = failureClass;
      if (failureClass === 'provider_runtime_stall') {
        metadata.providerRuntime = 'claude-code-cli';
        metadata.nextAction = 'Check Claude Code auth/session, restart the stalled bot runtime, or route this ticket to a healthy fallback provider such as Bedrock.';
      }
    }

    try {
      await this.updateTicketStatus(ticketId, ticketStatus, metadata);
      logger.info(
        { ticketId, ticketStatus, workItemId, terminalStatus },
        'Ticket terminal state updated from work-item result',
      );
    } catch (error) {
      logger.warn({ err: error, ticketId, workItemId, ticketStatus }, 'Failed to update ticket terminal state');
    }
  }

  private async updateTicketFromStoredWorkItem(
    envelope: MeshEnvelope,
    item: WorkItemExecutionSnapshot,
  ): Promise<void> {
    const success = item.status === 'completed' || item.status === 'subtask-completed';
    await this.updateTicketTerminalState(
      envelope,
      { success, output: item.executionOutput, error: success ? undefined : 'Stored work item is failed' },
      item.status as WorkItemStatus,
      item.workItemId,
      item.unitId,
    );
  }

  /**
   * @description SP-10: Checks if this agent should reject the envelope based on phase-role rules.
   * PM and task-manager should not execute Phase 4 (EXECUTION) work.
   * Test-engineer/tester should not execute Phase 2 (PLANNING) architecture work.
   * @param envelope - Mesh envelope to validate
   * @returns True if the envelope should be rejected
   */
  private shouldRejectForPhaseViolation(envelope: MeshEnvelope): boolean {
    const payload = envelope.payload as Record<string, unknown> | undefined;
    if (!payload?.phase) return false;

    const phase = Number(payload.phase);
    const agentId = envelope.toAgentId;
    const agentLower = agentId.toLowerCase();

    const isPM = agentLower.includes('project-manager') || agentId === 'a0000000-0000-0000-0000-000000000001';
    const isQA = agentLower.includes('task-manager') || agentId === 'a0000000-0000-0000-0000-000000000006';

    // PM and QA must not execute Phase 4 (EXECUTION) work
    if ((isPM || isQA) && phase === 4 && payload.type !== 'verification-request') {
      logger.warn(
        { agentId, phase, correlationId: envelope.correlationId, type: payload.type },
        'SP-10: Rejecting Phase 4 execution envelope — PM/QA bots must not execute implementation work',
      );
      return true;
    }

    return false;
  }
}

/**
 * @description Default mirror handler that logs the envelope and returns success.
 * @param envelope - Mesh envelope to process
 * @returns Execution result with the mirrored payload
 */
async function defaultHandler(envelope: MeshEnvelope): Promise<EnvelopeExecutionResult> {
  logger.info(
    { correlationId: envelope.correlationId, toAgentId: envelope.toAgentId },
    'Default handler: mirroring envelope (no LLM provider configured)',
  );
  return { success: true, output: { echoed: true, toAgentId: envelope.toAgentId } };
}

/**
 * @description Default direct message handler — logs the envelope.
 * @param envelope - Received mesh envelope
 * @param entryId - Redis stream entry ID
 */
async function defaultDirectHandler(envelope: MeshEnvelope, entryId: string): Promise<void> {
  logger.info(
    { correlationId: envelope.correlationId, fromAgentId: envelope.fromAgentId, channel: envelope.channel, entryId },
    'Direct message received (no custom handler configured)',
  );
}

/**
 * @description Async sleep utility.
 * @param ms - Milliseconds to sleep
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @description Returns whether a work-item status can be claimed for active execution.
 * @param status - Work-item status to inspect.
 * @returns True when the status still represents claimable work.
 */
function isClaimableExecutionStatus(status: string): boolean {
  return status === 'pending'
    || status === 'routing_failed'
    || status === 'subtask-pending'
    || status === 'subtask-assigned';
}

/**
 * @description Returns whether a work-item status can still accept persisted execution output.
 * @param status - Work-item status to inspect.
 * @returns True when the status is still an active execution state.
 */
function isRecordableExecutionStatus(status: string): boolean {
  return status === 'pending'
    || status === 'assigned'
    || status === 'executing'
    || status === 'in-progress'
    || status === 'routing_failed'
    || status === 'subtask-pending'
    || status === 'subtask-assigned'
    || status === 'subtask-executing';
}

/**
 * @description Resolves the active status to persist after a worker claims the envelope.
 * @param status - Current work-item status.
 * @returns Next active status for the claim.
 */
function resolveActiveExecutionStatus(status: string): WorkItemStatus {
  if (status === 'subtask-pending' || status === 'subtask-assigned') {
    return 'subtask-executing';
  }
  if (status === 'pending') {
    return 'assigned';
  }
  if (status === 'routing_failed') {
    return 'assigned';
  }
  return status as WorkItemStatus;
}

/**
 * @description Resolves the terminal execution status based on whether the row is a subtask row.
 * @param status - Current work-item status.
 * @param success - Whether execution succeeded.
 * @returns Terminal status to persist.
 */
function resolveTerminalExecutionStatus(status: string, success: boolean): WorkItemStatus {
  if (status.startsWith('subtask-')) {
    return success ? 'subtask-completed' : 'subtask-failed';
  }
  return success ? 'completed' : 'failed';
}

/**
 * @description Returns whether a terminal execution result is already persisted for a work item.
 * @param status - Current work-item status.
 * @param executionOutput - Persisted execution output.
 * @returns True when the row is terminal and already has output.
 */
function hasTerminalExecutionResult(status: string, executionOutput: unknown): boolean {
  const isTerminal = status === 'completed'
    || status === 'failed'
    || status === 'subtask-completed'
    || status === 'subtask-failed';
  return isTerminal && executionOutput != null;
}

function detectExecutionFailure(result: EnvelopeExecutionResult): string | null {
  if (!result.success) {
    return result.error || 'Worker execution returned success=false';
  }
  const outputText = extractOutputText(result.output);
  if (!outputText) {
    return null;
  }
  for (const pattern of EXECUTION_FAILURE_PATTERNS) {
    const match = outputText.match(pattern);
    if (match) {
      return match[0];
    }
  }
  return null;
}

function classifyExecutionFailure(message: string): string {
  if (/CLI stalled|INACTIVITY CIRCUIT BREAKER|no output for 180s/i.test(message)) {
    return 'provider_runtime_stall';
  }
  if (/(429|too many requests|rate[-\s]?limit|quota|throttl\w*|ResourceExhausted|ThrottlingException|overloaded|temporarily unavailable)/i.test(message)) {
    return 'provider_throttle';
  }
  if (/(not authenticated|authentication|ANTHROPIC_API_KEY|invalid api key|OAuth (?:file|token|login|credentials)|oauth (?:token|login|credentials|expired|required|failed))/i.test(message)) {
    return 'provider_auth';
  }
  if (/(401 Unauthorized|403 Forbidden|unauthorized|OPENAI_API_KEY|failed to connect to websocket)/i.test(message)) {
    return 'provider_auth';
  }
  if (/Command failed with exit code/i.test(message)) {
    return 'provider_command_failed';
  }
  if (/(?:Claude Code|Cline|Codex|Gemini)[\w\s-]*CLI (?:encountered an error|error)|runtime failed before completion/i.test(message)) {
    return 'provider_runtime_error';
  }
  return 'worker_execution_failed';
}

// These patterns are scanned against the SUCCESS-path output content (see
// detectExecutionFailure) to catch an exit-0 run whose "answer" is actually a CLI
// runtime/stall banner. They MUST stay narrow to specific banner phrasing. Broad
// throttle/auth keyword patterns (429, quota, rate-limit, unauthorized, ...) were
// deliberately removed: on an RCA/DevOps platform those words appear in correct
// answers, and matching them here force-escalated successful tickets. Genuine
// throttle/auth failures surface via result.success===false (detectExecutionFailure
// returns result.error) and are still classified by classifyExecutionFailure.
const EXECUTION_FAILURE_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:Claude Code|Cline|Codex|Gemini)[\w\s-]*CLI encountered an error[:\w\s-]*/i,
  /(?:Claude Code|Cline|Codex|Gemini)[\w\s-]*CLI error[:\w\s-]*/i,
  /CLI stalled[\w\s-]*/i,
  /INACTIVITY CIRCUIT BREAKER/i,
  /Command failed with exit code \d+/i,
  /runtime failed before completion[:\w\s-]*/i,
  /returned success=false/i,
];

function extractOutputText(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (!output || typeof output !== 'object') {
    return '';
  }
  const record = output as Record<string, unknown>;
  return ['content', 'response', 'error', 'message', 'status']
    .map((key) => record[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');
}

function readOptionalNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const raw = (value as Record<string, unknown>)[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function extractExactUuid(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed : undefined;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() ? Number(value) : Number.NaN);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @description Read work items by external id across current and legacy repository contracts.
 * @param repository - Work item repository instance.
 * @param externalId - Work-item external id.
 * @returns Matching work items.
 */
async function findByExternalIdCompat(
  repository: WorkItemRepository,
  externalId: string,
): Promise<WorkItemExecutionSnapshot[]> {
  const repo = repository as unknown as {
    findByExternalIdAnyProvider?: (id: string) => Promise<WorkItemExecutionSnapshot[]>;
    findByExternalId?: (id: string, provider: string) => Promise<WorkItemExecutionSnapshot[]>;
  };
  if (typeof repo.findByExternalIdAnyProvider === 'function') {
    return repo.findByExternalIdAnyProvider(externalId);
  }
  if (typeof repo.findByExternalId === 'function') {
    return repo.findByExternalId(externalId, 'plane');
  }
  return [];
}

interface WorkItemExecutionSnapshot {
  workItemId: string;
  status: string;
  assignedAgentId?: string;
  executionOutput?: unknown;
  unitId?: string;
}
