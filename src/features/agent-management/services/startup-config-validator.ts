/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Track B S7: Startup config validator — identifies agents with missing required runtime config at boot and exposes operator status endpoint
 */

import { createChildLogger } from '@/shared/logger';
import type { AgentConfigService } from './agent-config-service';
import type { ConfigField } from './capability-expansion-service';

const logger = createChildLogger({ module: 'startup-config-validator' });

/**
 * @description Config validation result for a single agent.
 */
export interface AgentConfigValidationResult {
  agentId: string;
  configuredFields: string[];
  missingRequiredFields: string[];
  valid: boolean;
}

/**
 * @description Summary of config validation across all registered agents.
 */
export interface StartupConfigReport {
  totalAgents: number;
  validAgents: number;
  invalidAgents: number;
  results: AgentConfigValidationResult[];
  generatedAt: string;
}

/**
 * @description Validates that agents with registered config schemas have all
 * required fields populated.
 *
 * Called at startup and on-demand via the operator config-status endpoint.
 * Logs warnings for each agent with missing required fields so operators can
 * identify configuration gaps before routing tickets to those agents.
 */
export class StartupConfigValidator {
  constructor(private readonly agentConfigService: AgentConfigService) {}

  /**
   * @description Run config validation across all agents that have a registered schema.
   * @returns Validation report with per-agent results and aggregate counts
   */
  async validateAll(): Promise<StartupConfigReport> {
    const configuredAgentIds = await this.agentConfigService.listConfiguredAgents();
    const results: AgentConfigValidationResult[] = [];

    for (const agentId of configuredAgentIds) {
      const result = await this.validateAgent(agentId);
      results.push(result);
      if (!result.valid) {
        logger.warn(
          { agentId, missingFields: result.missingRequiredFields },
          'Agent has missing required config fields — bot may fail at runtime',
        );
      }
    }

    const validAgents = results.filter((r) => r.valid).length;
    const report: StartupConfigReport = {
      totalAgents: results.length,
      validAgents,
      invalidAgents: results.length - validAgents,
      results,
      generatedAt: new Date().toISOString(),
    };

    logger.info(
      { totalAgents: report.totalAgents, validAgents: report.validAgents, invalidAgents: report.invalidAgents },
      'Startup config validation complete',
    );

    return report;
  }

  /**
   * @description Validate a single agent's config against its schema.
   * @param agentId - Agent to validate
   * @returns Per-agent validation result
   */
  async validateAgent(agentId: string): Promise<AgentConfigValidationResult> {
    const config = await this.agentConfigService.getConfig(agentId);

    if (!config || config.schema.length === 0) {
      return { agentId, configuredFields: [], missingRequiredFields: [], valid: true };
    }

    const values = config.values || {};
    const requiredFields = (config.schema as ConfigField[]).filter((f) => f.required);
    const missingRequiredFields = requiredFields
      .filter((f) => {
        const val = values[f.name];
        return val === undefined || val === null || String(val).trim() === '';
      })
      .map((f) => f.name);

    const configuredFields = Object.keys(values).filter((k) => {
      const val = values[k];
      return val !== undefined && val !== null && String(val).trim() !== '';
    });

    return {
      agentId,
      configuredFields,
      missingRequiredFields,
      valid: missingRequiredFields.length === 0,
    };
  }
}
