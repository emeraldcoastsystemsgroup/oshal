/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added StuckAgentWatchdog — timeout/stall detection with auto-escalation (WS-7 #4)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SP-9: Added orphan work-item detection — items with no matching swarm_runs entry get auto-escalated alongside stuck items
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Ran the watchdog check cycle under runWithSystemIdentity — background escalation that writes the FORCE-RLS tickets table; SYSTEM keeps it visible once OSHAL_DB_GUC_STRICT denies the identity-less case.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';

const logger = createChildLogger({ module: 'stuck-agent-watchdog' });

/**
 * @description Default timeout thresholds.
 */
const DEFAULT_STUCK_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_POLL_INTERVAL_MS = 60 * 1000; // 1 minute

/**
 * @description A stuck work item detected by the watchdog.
 */
export interface StuckWorkItem {
  workItemId: string;
  externalId: string;
  assignedAgentId: string;
  status: string;
  stuckDurationMs: number;
  severity: 'warning' | 'critical';
  detectedAt: string;
}

/**
 * @description Watchdog action taken on a stuck item.
 */
export interface WatchdogAction {
  workItemId: string;
  agentId: string;
  action: 'escalated' | 'reassigned' | 'timed_out';
  reason: string;
  timestamp: string;
}

/**
 * @description Configuration for the watchdog.
 */
export interface WatchdogConfig {
  stuckThresholdMs: number;
  staleThresholdMs: number;
  pollIntervalMs: number;
  autoEscalate: boolean;
}

/**
 * @description StuckAgentWatchdog — monitors in-progress work items for timeout/stall.
 *
 * Periodically checks work_items table for items that have been in 'executing' or
 * 'assigned' status for longer than the configured threshold. When found:
 * - Warning: item has been stuck for > stuckThresholdMs
 * - Critical: item has been stuck for > staleThresholdMs
 * - Auto-escalate: optionally marks the item as 'escalated' and logs the action
 */
export class StuckAgentWatchdog {
  private readonly pool: Pool | null;
  private readonly config: WatchdogConfig;
  private readonly actions: WatchdogAction[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(pool: Pool | null = null, config?: Partial<WatchdogConfig>) {
    this.pool = pool;
    this.config = {
      stuckThresholdMs: config?.stuckThresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS,
      staleThresholdMs: config?.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS,
      pollIntervalMs: config?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      autoEscalate: config?.autoEscalate ?? true,
    };
  }

  /**
   * @description Start the watchdog polling loop.
   */
  start(): void {
    if (this.pollTimer) return;
    logger.info(
      { stuckMs: this.config.stuckThresholdMs, staleMs: this.config.staleThresholdMs, pollMs: this.config.pollIntervalMs },
      'Stuck agent watchdog started',
    );
    this.pollTimer = setInterval(() => {
      runWithSystemIdentity(() => this.check()).catch((err) => logger.error({ err }, 'Watchdog check failed'));
    }, this.config.pollIntervalMs);
  }

  /**
   * @description Stop the watchdog polling loop.
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      logger.info('Stuck agent watchdog stopped');
    }
  }

  /**
   * @description Run one watchdog check cycle.
   * @returns Array of stuck work items found
   */
  async check(): Promise<StuckWorkItem[]> {
    if (!this.pool) return [];

    try {
      const result = await this.pool.query(
        `SELECT work_item_id, external_id, assigned_agent_id, status,
          EXTRACT(EPOCH FROM (NOW() - updated_at)) * 1000 as stuck_duration_ms
        FROM work_items
        WHERE status IN ('assigned', 'executing', 'subtask-assigned', 'subtask-executing')
          AND EXTRACT(EPOCH FROM (NOW() - updated_at)) * 1000 > $1`,
        [this.config.stuckThresholdMs],
      );

      const stuck: StuckWorkItem[] = result.rows.map((row) => ({
        workItemId: row.work_item_id,
        externalId: row.external_id,
        assignedAgentId: row.assigned_agent_id || 'unassigned',
        status: row.status,
        stuckDurationMs: Math.round(parseFloat(row.stuck_duration_ms)),
        severity: parseFloat(row.stuck_duration_ms) > this.config.staleThresholdMs ? 'critical' : 'warning',
        detectedAt: new Date().toISOString(),
      }));

      // SP-9: Detect orphan work items (no matching swarm_runs entry, stuck > staleThreshold)
      const orphans = await this.detectOrphans();
      stuck.push(...orphans);

      if (stuck.length > 0) {
        logger.warn({ stuckCount: stuck.length, orphanCount: orphans.length, critical: stuck.filter((s) => s.severity === 'critical').length }, 'Stuck/orphan work items detected');

        if (this.config.autoEscalate) {
          for (const item of stuck.filter((s) => s.severity === 'critical')) {
            await this.escalateStuckItem(item);
          }
        }
      }

      return stuck;
    } catch (err) {
      logger.error({ err }, 'Watchdog database query failed');
      return [];
    }
  }

  /**
   * @description Get all watchdog actions taken.
   */
  getActions(limit = 50): WatchdogAction[] {
    return this.actions.slice(-limit);
  }

  /**
   * @description Escalate a critically stuck work item.
   */
  /**
   * @description SP-9: Detect orphan work items that have no matching swarm_runs entry.
   * These are items whose parent run was deleted or never committed.
   * @returns Orphan work items detected as critical stuck items
   */
  private async detectOrphans(): Promise<StuckWorkItem[]> {
    if (!this.pool) return [];
    try {
      const result = await this.pool.query(
        `SELECT wi.work_item_id, wi.external_id, wi.assigned_agent_id, wi.status,
          EXTRACT(EPOCH FROM (NOW() - wi.updated_at)) * 1000 as stuck_duration_ms
        FROM work_items wi
        LEFT JOIN swarm_runs sr ON wi.run_id = sr.run_id
        WHERE sr.run_id IS NULL
          AND wi.status IN ('pending', 'assigned', 'executing', 'subtask-pending', 'subtask-assigned', 'subtask-executing')
          AND EXTRACT(EPOCH FROM (NOW() - wi.updated_at)) * 1000 > $1`,
        [this.config.staleThresholdMs],
      );
      return result.rows.map((row) => ({
        workItemId: row.work_item_id,
        externalId: row.external_id,
        assignedAgentId: row.assigned_agent_id || 'unassigned',
        status: `orphan:${row.status}`,
        stuckDurationMs: Math.round(parseFloat(row.stuck_duration_ms)),
        severity: 'critical' as const,
        detectedAt: new Date().toISOString(),
      }));
    } catch (err) {
      logger.warn({ err }, 'Orphan work-item detection query failed');
      return [];
    }
  }

  private async escalateStuckItem(item: StuckWorkItem): Promise<void> {
    try {
      await this.pool!.query(
        `UPDATE work_items SET status = 'escalated', updated_at = NOW() WHERE work_item_id = $1`,
        [item.workItemId],
      );

      const action: WatchdogAction = {
        workItemId: item.workItemId,
        agentId: item.assignedAgentId,
        action: 'escalated',
        reason: `Stuck for ${Math.round(item.stuckDurationMs / 1000)}s (threshold: ${Math.round(this.config.staleThresholdMs / 1000)}s)`,
        timestamp: new Date().toISOString(),
      };
      this.actions.push(action);

      logger.warn(
        { workItemId: item.workItemId, agentId: item.assignedAgentId, stuckMs: item.stuckDurationMs },
        'Auto-escalated stuck work item',
      );
    } catch (err) {
      logger.error({ err, workItemId: item.workItemId }, 'Failed to escalate stuck work item');
    }
  }
}
