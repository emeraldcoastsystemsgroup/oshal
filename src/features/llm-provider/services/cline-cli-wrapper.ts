/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of ClineCLIWrapper (agent API configuration contract)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Updated Change Log for attribution and timestamp compliance
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fixed ApiProvider type import to use LLM contract union and avoid shared index ambiguity
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Replaced deep type import with interface-derived return type to preserve barrel import compliance
 */

import { createChildLogger } from '@/shared/logger';
import type { IAgentApiConfiguration, ClineCLIConfig } from '@/shared/types';

const logger = createChildLogger({ module: 'cline-cli-wrapper' });

/**
 * @description
 * ClineCLIWrapper — Implements the agent API configuration contract for the Cline CLI agent.
 */
export class ClineCLIWrapper implements IAgentApiConfiguration {
  private config: ClineCLIConfig;

  /**
   * @description Construct a ClineCLIWrapper instance.
   * @param config - ClineCLIConfig object
   */
  constructor(config: ClineCLIConfig) {
    this.config = config;
    logger.info({ binaryPath: config.binaryPath }, 'ClineCLIWrapper initialized');
  }

  /**
   * @description Returns the provider type for this agent.
   * @returns The provider type as a string.
   */
  getProviderType(): ReturnType<IAgentApiConfiguration['getProviderType']> {
    logger.info({}, 'getProviderType called');
    return 'claude-code';
  }

  /**
   * @description Returns the agent's display name.
   * @returns The agent's name.
   */
  getAgentName(): string {
    logger.info({}, 'getAgentName called');
    return 'Cline CLI Agent';
  }

  /**
   * @description Returns the configuration object for the agent.
   * @returns The agent's configuration.
   */
  getConfig(): ClineCLIConfig {
    logger.info({}, 'getConfig called');
    return this.config;
  }

  /**
   * @description Validates the agent's configuration.
   * @returns True if valid, otherwise throws an error.
   * @throws Error if configuration is invalid
   */
  validateConfig(): boolean {
    logger.info({ config: this.config }, 'validateConfig called');
    if (!this.config.binaryPath || typeof this.config.binaryPath !== 'string') {
      logger.error({ config: this.config }, 'Invalid binaryPath in ClineCLIConfig');
      throw new Error('ClineCLIConfig: binaryPath is required and must be a string');
    }
    if (this.config.args && !Array.isArray(this.config.args)) {
      logger.error({ config: this.config }, 'Invalid args in ClineCLIConfig');
      throw new Error('ClineCLIConfig: args must be an array of strings');
    }
    if (this.config.env && typeof this.config.env !== 'object') {
      logger.error({ config: this.config }, 'Invalid env in ClineCLIConfig');
      throw new Error('ClineCLIConfig: env must be an object');
    }
    if (this.config.tools && !Array.isArray(this.config.tools)) {
      logger.error({ config: this.config }, 'Invalid tools in ClineCLIConfig');
      throw new Error('ClineCLIConfig: tools must be an array');
    }
    if (this.config.mcp && typeof this.config.mcp !== 'object') {
      logger.error({ config: this.config }, 'Invalid mcp in ClineCLIConfig');
      throw new Error('ClineCLIConfig: mcp must be an object');
    }
    logger.info({}, 'ClineCLIConfig validated successfully');
    return true;
  }
}
