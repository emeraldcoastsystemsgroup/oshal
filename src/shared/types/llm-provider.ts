/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of LLM provider shared types and interfaces for agent API configuration (Claude Code, Cline CLI)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Updated Change Log for attribution and timestamp compliance
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Operator directive 2026-08-13 — nothing hardcoded: configuration decides and the swarm env file is the fallback. ClineCLIConfig gained the optional `provider` field so a caller can declare Cline's backing provider instead of inheriting a literal.
 */

/**
 * @description
 * Supported API providers for LLM services. Add new providers as needed.
 */
export type ApiProvider =
  | 'openai'
  | 'anthropic'
  | 'azure-openai'
  | 'noop'
  | 'openai-codex'  // the swarm's default backing provider (ADR-128)
  | 'cline-cli'     // the Cline harness naming ITSELF, when no backing provider is configured
  | 'claude-code'; // Cline CLI harness — routes to whatever backend provider/model is configured

/**
 * @description
 * Interface for agent API configuration contracts. All agent wrappers must implement this.
 */
export interface IAgentApiConfiguration {
  /**
   * @description Returns the provider type for this agent.
   * @returns The provider type as a string.
   */
  getProviderType(): ApiProvider;

  /**
   * @description Returns the agent's display name.
   * @returns The agent's name.
   */
  getAgentName(): string;

  /**
   * @description Returns the configuration object for the agent.
   * @returns The agent's configuration.
   */
  getConfig(): Record<string, unknown>;

  /**
   * @description Validates the agent's configuration.
   * @returns True if valid, otherwise throws an error.
   */
  validateConfig(): boolean;
}

/**
 * @description
 * Configuration options for the Cline runtime provider.
 */
export interface ClineHarnessProviderConfig {
  [key: string]: unknown;
  /**
   * @description The API key for the Claude Code provider.
   */
  apiKey: string;
  /**
   * @description The model to use (e.g., 'claude-3-haiku-20240307').
   */
  model: string;
  /**
   * @description Optional: Base URL for Claude Code API.
   */
  baseUrl?: string;
  /**
   * @description Optional: Bot-level provider override (e.g. 'openai-codex', 'anthropic').
   * Takes priority over global-config.json but is overridden by per-request providerId.
   * Set from the bot's registry `apiType` declaration.
   */
  configuredProvider?: string;
}

/**
 * @description
 * Configuration options for the Cline CLI agent.
 */
export interface ClineCLIConfig {
  [key: string]: unknown;
  /**
   * @description Path to the Cline CLI binary.
   */
  binaryPath: string;
  /**
   * @description Optional: Additional CLI arguments.
   */
  args?: string[];
  /**
   * @description Optional: Environment variables for the CLI agent.
   */
  env?: Record<string, string>;
  /**
   * @description Tools to be passed to the agent (layer 1).
   */
  tools?: unknown[];
  /**
   * @description MCP configuration to be passed to the agent (layer 0).
   */
  mcp?: Record<string, unknown>;
  /**
   * @description Optional: the backing provider Cline drives. Configuration, not a literal
   * (operator directive 2026-08-13) — when absent, the swarm env file answers. See
   * ClineCLIWrapper.getProviderType.
   */
  provider?: string;
}
