/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | IMP-1: Agent eligibility service — richer availability model beyond heartbeat-only filtering
 */

import { createChildLogger } from '@/shared/logger';
import type { AgentRuntimeRegistryService, AgentRuntimeRegistration } from './agent-runtime-registry-service';
import type { AgentProfileRepository } from '@/entities/agent';

const logger = createChildLogger({ module: 'agent-eligibility-service' });

/**
 * @description Per-agent eligibility snapshot with rejection reasons.
 */
export interface AgentEligibilitySnapshot {
  agentId: string;
  agentName: string;
  online: boolean;
  dbActive: boolean;
  eligible: boolean;
  score: number;
  rejectionReasons: string[];
}

/**
 * @description Options for evaluating eligibility.
 */
export interface EligibilityEvaluationOptions {
  excludeAgentIds?: string[];
  requiredCapabilities?: string[];
  phase?: number;
}

/**
 * @description Evaluates agent eligibility beyond simple heartbeat presence.
 * Combines runtime availability, DB status, capability matching, and policy exclusions.
 */
export class AgentEligibilityService {
  constructor(
    private readonly runtimeRegistry?: AgentRuntimeRegistryService,
    private readonly profileRepository?: AgentProfileRepository,
  ) {}

  /**
   * @description Evaluates all known agents and returns eligibility snapshots with rejection reasons.
   * @param options - Evaluation criteria (exclusions, capabilities, phase)
   * @returns Array of eligibility snapshots, sorted by score descending
   */
  async evaluateAll(options: EligibilityEvaluationOptions = {}): Promise<AgentEligibilitySnapshot[]> {
    const registrations = this.runtimeRegistry
      ? await this.runtimeRegistry.listAgentRegistrations()
      : [];

    const dbAgents = this.profileRepository
      ? await this.profileRepository.listAgents().catch(() => [])
      : [];

    const dbStatusMap = new Map(dbAgents.map((a) => [a.agentId, a]));
    const excludeSet = new Set(options.excludeAgentIds ?? []);

    const snapshots: AgentEligibilitySnapshot[] = registrations.map((reg) => {
      return this.evaluateOne(reg, dbStatusMap.get(reg.agentId), excludeSet, options);
    });

    // Include DB agents not in runtime (offline but known)
    for (const agent of dbAgents) {
      if (!registrations.some((r) => r.agentId === agent.agentId)) {
        snapshots.push({
          agentId: agent.agentId,
          agentName: agent.name,
          online: false,
          dbActive: agent.status === 'active',
          eligible: false,
          score: 0,
          rejectionReasons: ['bot_offline: no runtime heartbeat'],
        });
      }
    }

    snapshots.sort((a, b) => b.score - a.score);

    logger.info(
      {
        total: snapshots.length,
        eligible: snapshots.filter((s) => s.eligible).length,
        excluded: excludeSet.size,
      },
      'Agent eligibility evaluation complete',
    );

    return snapshots;
  }

  /**
   * @description Returns only eligible agents from the full evaluation.
   * @param options - Evaluation criteria
   * @returns Eligible agent snapshots
   */
  async getEligible(options: EligibilityEvaluationOptions = {}): Promise<AgentEligibilitySnapshot[]> {
    const all = await this.evaluateAll(options);
    return all.filter((s) => s.eligible);
  }

  private evaluateOne(
    reg: AgentRuntimeRegistration,
    dbAgent: { status: string; baseCapabilities?: string[] | null } | undefined,
    excludeSet: Set<string>,
    options: EligibilityEvaluationOptions,
  ): AgentEligibilitySnapshot {
    const reasons: string[] = [];
    let score = 0.5;

    const online = reg.status === 'online';
    const dbActive = !dbAgent || dbAgent.status === 'active';

    if (!online) reasons.push('bot_offline: no heartbeat or expired TTL');
    if (!dbActive) reasons.push(`bot_disabled: DB status is "${dbAgent?.status}"`);
    if (excludeSet.has(reg.agentId)) reasons.push('policy_excluded: agent in exclusion list');

    if (options.requiredCapabilities && options.requiredCapabilities.length > 0) {
      const caps = new Set(reg.capabilities ?? []);
      const dbCaps = new Set(dbAgent?.baseCapabilities ?? []);
      const allCaps = new Set([...caps, ...dbCaps]);
      const missing = options.requiredCapabilities.filter((c) => !allCaps.has(c));
      if (missing.length > 0) {
        reasons.push(`missing_capability: ${missing.join(', ')}`);
      } else {
        score += 0.2;
      }
    }

    if (online && dbActive) score += 0.3;

    const eligible = online && dbActive && !excludeSet.has(reg.agentId) && reasons.length === 0;

    return {
      agentId: reg.agentId,
      agentName: reg.agentName,
      online,
      dbActive,
      eligible,
      score: eligible ? score : 0,
      rejectionReasons: reasons,
    };
  }
}
