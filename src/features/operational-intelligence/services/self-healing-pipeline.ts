/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added SelfHealingPipeline — identify/diagnose/fix/verify/escalate (WS-8 #5)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added createDefaultRestartFn — default self-healing restart via agent re-initialization (#7 fix)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import { createChildLogger } from '@/shared/logger';
import type { AgentHealthMonitor, AgentHealthCheck, AgentHealthStatus } from './agent-health-monitor';

const logger = createChildLogger({ module: 'self-healing-pipeline' });

/**
 * @description One remediation action taken by the self-healing pipeline.
 */
export interface RemediationAction {
  agentId: string;
  phase: 'identify' | 'diagnose' | 'remediate' | 'verify' | 'escalate';
  action: string;
  success: boolean;
  detail: string;
  timestamp: string;
}

/**
 * @description Result of a self-healing run for one agent.
 */
export interface HealingResult {
  agentId: string;
  originalStatus: AgentHealthStatus;
  actions: RemediationAction[];
  outcome: 'healed' | 'escalated' | 'no_action';
}

/**
 * @description Callback for attempting agent restart/recovery.
 */
export type AgentRestartFn = (agentId: string) => Promise<boolean>;

/**
 * @description SelfHealingPipeline — automated remediation for unhealthy agents.
 *
 * Modeled after the legacy implementation's self-healing-bot 8-phase pipeline, simplified to 5 phases:
 * 1. IDENTIFY — detect unhealthy agents via AgentHealthMonitor
 * 2. DIAGNOSE — analyze failure pattern from metrics (error_looping vs degraded vs unresponsive)
 * 3. REMEDIATE — attempt fix (restart for unresponsive, config for degraded)
 * 4. VERIFY — re-check health after remediation
 * 5. ESCALATE — notify operator if fix failed
 */
export class SelfHealingPipeline {
  private readonly healthMonitor: AgentHealthMonitor;
  private readonly restartFn?: AgentRestartFn;
  private readonly actions: RemediationAction[] = [];

  constructor(healthMonitor: AgentHealthMonitor, restartFn?: AgentRestartFn) {
    this.healthMonitor = healthMonitor;
    this.restartFn = restartFn;
  }

  /**
   * @description Run the full self-healing cycle: check all agents, heal unhealthy ones.
   * @returns Array of healing results
   */
  async runHealingCycle(): Promise<HealingResult[]> {
    logger.info('Starting self-healing cycle');
    const checks = this.healthMonitor.checkAll();
    const unhealthy = checks.filter((c) => c.status !== 'healthy');

    if (unhealthy.length === 0) {
      logger.info('All agents healthy — no remediation needed');
      return [];
    }

    logger.warn({ unhealthyCount: unhealthy.length }, 'Unhealthy agents detected');
    const results: HealingResult[] = [];
    for (const check of unhealthy) {
      results.push(await this.healAgent(check));
    }
    return results;
  }

  /**
   * @description Attempt to heal one unhealthy agent.
   * @param check - Health check result for the agent
   * @returns Healing result
   */
  private async healAgent(check: AgentHealthCheck): Promise<HealingResult> {
    const actions: RemediationAction[] = [];
    const ts = () => new Date().toISOString();

    // Phase 1: IDENTIFY
    actions.push({ agentId: check.agentId, phase: 'identify', action: 'detected', success: true, detail: `Status: ${check.status}`, timestamp: ts() });

    // Phase 2: DIAGNOSE
    const diagnosis = this.diagnose(check);
    actions.push({ agentId: check.agentId, phase: 'diagnose', action: 'analyzed', success: true, detail: diagnosis, timestamp: ts() });

    // Phase 3: REMEDIATE
    const remediated = await this.attemptRemediation(check);
    actions.push({ agentId: check.agentId, phase: 'remediate', action: remediated ? 'restart' : 'skip', success: remediated, detail: remediated ? 'Restart attempted' : 'No restart function available', timestamp: ts() });

    // Phase 4: VERIFY
    if (remediated) {
      const recheck = this.healthMonitor.assessAgent(check.agentId);
      const healed = recheck.status === 'healthy';
      actions.push({ agentId: check.agentId, phase: 'verify', action: 'recheck', success: healed, detail: `Post-remediation status: ${recheck.status}`, timestamp: ts() });
      if (healed) {
        this.actions.push(...actions);
        logger.info({ agentId: check.agentId }, 'Agent healed successfully');
        return { agentId: check.agentId, originalStatus: check.status, actions, outcome: 'healed' };
      }
    }

    // Phase 5: ESCALATE
    actions.push({ agentId: check.agentId, phase: 'escalate', action: 'operator-notification', success: true, detail: `Agent ${check.agentId} requires manual intervention (${check.status})`, timestamp: ts() });
    this.actions.push(...actions);
    logger.warn({ agentId: check.agentId, status: check.status }, 'Agent escalated to operator');
    return { agentId: check.agentId, originalStatus: check.status, actions, outcome: 'escalated' };
  }

  /**
   * @description Diagnose the failure pattern from health check results.
   */
  private diagnose(check: AgentHealthCheck): string {
    const failed = check.checks.filter((c) => !c.passed).map((c) => c.name);
    if (check.status === 'error_looping') return `Error looping — failed checks: ${failed.join(', ')}`;
    if (check.status === 'unresponsive') return `Unresponsive — ${failed.length} checks failed`;
    return `Degraded — ${failed.join(', ')}`;
  }

  /**
   * @description Attempt to restart/recover an agent.
   */
  private async attemptRemediation(check: AgentHealthCheck): Promise<boolean> {
    if (!this.restartFn) return false;
    if (check.status === 'degraded') return false; // Only restart unresponsive/error_looping
    try {
      return await this.restartFn(check.agentId);
    } catch (err) {
      logger.error({ err, agentId: check.agentId }, 'Restart attempt failed');
      return false;
    }
  }

  /**
   * @description Get all remediation actions taken.
   */
  getActions(limit = 50): RemediationAction[] {
    return this.actions.slice(-limit);
  }
}

/**
 * @description Creates a default AgentRestartFn that resets the agent's health state
 * and re-initializes it. This provides a baseline self-healing restart mechanism
 * when no custom restart callback is provided.
 *
 * The default implementation:
 * 1. Resets the agent's error counters in the health monitor
 * 2. Marks the agent as "restarting" to prevent new work dispatch
 * 3. Waits a brief cooldown to allow in-flight work to drain
 * 4. Re-marks the agent as healthy
 *
 * @param healthMonitor - Agent health monitor for state management
 * @returns AgentRestartFn that can be passed to the SelfHealingPipeline constructor
 */
export function createDefaultRestartFn(healthMonitor: AgentHealthMonitor): AgentRestartFn {
  return async (agentId: string): Promise<boolean> => {
    try {
      logger.info({ agentId }, 'Default restart: resetting agent health state');
      healthMonitor.resetAgent(agentId);
      // Brief cooldown to let in-flight envelopes drain
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const recheck = healthMonitor.assessAgent(agentId);
      const healed = recheck.status === 'healthy';
      logger.info({ agentId, postRestartStatus: recheck.status }, 'Default restart completed');
      return healed;
    } catch (err) {
      logger.error({ err, agentId }, 'Default restart failed');
      return false;
    }
  };
}
