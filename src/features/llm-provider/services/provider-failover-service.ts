/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added opt-in LLM provider failover for provider-runtime stalls.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Kept in sync with any-bot providerFailureClassifier SEQ 3: a logged-out CLI login classifies as auth, and the providers' own "<vendor> CLI task failed" banner as a runtime failure.
 */

import { createChildLogger } from '@/shared/logger';
import {
  LLMService,
  type CostResult,
  type LLMResponse,
  type SendRequestOptions,
  type TokenUsage,
} from './llm-service';

const logger = createChildLogger({ module: 'provider-failover-service' });

export type ProviderFailoverPredicate = (error: unknown) => boolean;

export interface ProviderFailoverServiceConfig {
  primary: LLMService;
  fallback: LLMService;
  reason: string;
  shouldFailover: ProviderFailoverPredicate;
}

/**
 * @description Wraps an LLM provider and retries through a fallback provider
 * only when a caller-supplied classifier marks the primary failure eligible.
 */
export class ProviderFailoverService extends LLMService {
  private readonly primary: LLMService;
  private readonly fallback: LLMService;
  private readonly reason: string;
  private readonly shouldFailover: ProviderFailoverPredicate;
  private lastSuccessfulProvider: LLMService;

  constructor(config: ProviderFailoverServiceConfig) {
    super(`failover:${config.primary.getProviderName()}`, {});
    this.primary = config.primary;
    this.fallback = config.fallback;
    this.reason = config.reason;
    this.shouldFailover = config.shouldFailover;
    this.lastSuccessfulProvider = config.primary;
    logger.info(
      {
        primaryProvider: config.primary.getProviderName(),
        fallbackProvider: config.fallback.getProviderName(),
        reason: config.reason,
      },
      'ProviderFailoverService initialized',
    );
  }

  async sendRequest(options: SendRequestOptions): Promise<LLMResponse> {
    this.requestCount++;
    try {
      const response = await this.primary.sendRequest(options);
      // Classify a SUCCESSFUL response with the narrow banner check, not the broad
      // shouldFailover predicate (which is correct only for thrown errors below).
      if (isProviderFailureResponse(response)) {
        logger.warn(
          {
            reason: this.reason,
            primaryProvider: this.primary.getProviderName(),
            fallbackProvider: this.fallback.getProviderName(),
            taskId: options.taskId,
            agentId: options.agentId,
          },
          'Primary provider returned failover-eligible failure text; invoking fallback provider',
        );
        return await this.sendFallbackRequest(options, response);
      }
      this.lastSuccessfulProvider = this.primary;
      return response;
    } catch (primaryError) {
      if (!this.shouldFailover(primaryError)) {
        throw primaryError;
      }

      logger.warn(
        {
          err: primaryError,
          reason: this.reason,
          primaryProvider: this.primary.getProviderName(),
          fallbackProvider: this.fallback.getProviderName(),
          taskId: options.taskId,
          agentId: options.agentId,
        },
        'Primary provider failed with failover-eligible error; invoking fallback provider',
      );

      return await this.sendFallbackRequest(options, primaryError);
    }
  }

  private async sendFallbackRequest(options: SendRequestOptions, primaryError: unknown): Promise<LLMResponse> {
    try {
      const response = await this.fallback.sendRequest(options);
      if (isProviderFailureResponse(response)) {
        throw new Error(`Fallback provider returned provider failure text: ${formatError(response)}`);
      }
      this.lastSuccessfulProvider = this.fallback;
      logger.info(
        {
          reason: this.reason,
          primaryProvider: this.primary.getProviderName(),
          fallbackProvider: this.fallback.getProviderName(),
          taskId: options.taskId,
          agentId: options.agentId,
        },
        'Provider failover completed successfully',
      );
      return response;
    } catch (fallbackError) {
      throw new Error(
        [
          `Provider failover failed for ${this.reason}.`,
          `primary=${this.primary.getProviderName()}`,
          `fallback=${this.fallback.getProviderName()}`,
          `primaryError=${formatError(primaryError)}`,
          `fallbackError=${formatError(fallbackError)}`,
        ].join(' '),
      );
    }
  }

  calculateCost(usage: TokenUsage): CostResult {
    return this.lastSuccessfulProvider.calculateCost(usage);
  }

  getProviderName(): string {
    return `failover:${this.primary.getProviderName()}->${this.fallback.getProviderName()}`;
  }
}

/**
 * @description True when the provider failure is a CLI/runtime/auth/throttle
 * class that can be retried through another healthy provider lane.
 */
export function isProviderRuntimeStall(error: unknown): boolean {
  const message = formatError(error);
  return isProviderRecoverableRuntimeFailure(error);
}

export function isProviderRecoverableRuntimeFailure(error: unknown): boolean {
  const message = formatError(error);
  return /CLI stalled|INACTIVITY CIRCUIT BREAKER|no output for \d+s|no output for 180s|runtime stall/i.test(message)
    || /\b(?:429|too many requests|rate[-\s]?limit(?:ed)?|retry-after|quota|insufficient_quota|resource_exhausted|throttl\w*|ThrottlingException|ResourceExhaustedException|ServiceUnavailableException|overloaded|temporarily unavailable)\b/i.test(message)
    || /\b(?:401 Unauthorized|403 Forbidden|unauthorized|not authenticated|not logged in|logged out|login required|please run \/login|run \/login|authentication (?:issue|failed|required)|invalid api key|invalid_api_key|ANTHROPIC_API_KEY|OPENAI_API_KEY|OAuth (?:file|token|login|credentials)|oauth (?:token|login|credentials|expired|required|failed))\b/i.test(message)
    || /(?:Claude Code|Cline|Codex|Gemini)[\w\s-]*CLI (?:encountered an error|error|task failed)|Command failed with exit code \d+|runtime failed before completion|failed to connect to websocket/i.test(message);
}

/**
 * @description Narrow failure detector for a SUCCESSFUL response (exit-0 run whose
 * text is actually a CLI runtime/stall banner). Deliberately EXCLUDES the broad
 * throttle/auth keyword patterns — those appear in valid answers (an RCA answer that
 * explains a 429 or a quota error) and must not trigger failover away from a correct
 * response. Broad throttle/auth classification belongs only on the error channel
 * (isProviderRecoverableRuntimeFailure applied to a thrown error / stderr).
 */
export function isProviderFailureResponse(response: unknown): boolean {
  const message = formatError(response);
  return /CLI stalled|INACTIVITY CIRCUIT BREAKER|no output for \d+s|no output for 180s|runtime stall/i.test(message)
    || /(?:Claude Code|Cline|Codex|Gemini)[\w\s-]*CLI (?:encountered an error|error|task failed)|Command failed with exit code \d+|runtime failed before completion|failed to connect to websocket/i.test(message);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
