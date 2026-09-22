/**
 * The in-turn half of the operator's HOT FALLBACK (operator decision 2026-09-22).
 *
 * An LLMService decorator over the explicitly chosen BYO provider (already wrapped in its
 * same-endpoint retry) and the READY rungs of the configured fallback chain the entry point
 * resolved, gated and probed BEFORE the turn. When the primary's model call surfaces a capacity
 * wall after its retry is exhausted, the call is re-issued once per rung, in order, and the first
 * rung that answers becomes the provider for the rest of the turn. All of it happens at the model
 * call, inside one orchestrator turn: the user message is saved once, tool results are kept, the
 * error is broadcast once — the fallback is never a second turn.
 *
 * WHO decides is deliberately NOT here. This class never reads DEMO_MODE, OSHAL_OPERATOR_SUBS, a
 * switch row or a login file: it receives rungs or it receives none. The app layer
 * (byo-hot-fallback.ts) applies the ADR-127/137 gates and the readiness probe and hands only what
 * may run to an operator's turn; a non-operator turn arrives with no rungs and this decorator is
 * never constructed for it.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the chain decorator: primary (with its retry) then each pre-gated rung once, the sticky switch for the remainder of the turn, the marker the turn reports, and the WARN line (connection identity, attempts, reason, rung — never a key).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | "Each rung tried at most once" is now per TURN, not per model call. The walk was re-entered on every later sendRequest while the primary was still active, so an agentic turn whose primary recovered and then walled again could walk the chain a second time. It is bounded by the same decision that made the same-endpoint budget per-turn: this decorator is built once per orchestrator turn, so a single flag makes the promise true, and the comments say per-call or per-turn where they mean it.
 *
 * @module hot-fallback-chain-provider
 */

import { createChildLogger } from '@/shared/logger';
import type { BrainFallbackMarker } from '@/shared/types';
import { LLMService, type CostResult, type LLMResponse, type SendRequestOptions, type TokenUsage } from './llm-service';
import { classifySameEndpointRetry, endpointHost, sameEndpointAttemptsOf } from './same-endpoint-retry';

const logger = createChildLogger({ module: 'hot-fallback-chain-provider' });

/** One READY rung, as the entry point resolved it: the provider that runs it and its identity. */
export interface HotFallbackRungProvider {
  providerId: string;
  /** 1-based position in the configured chain. */
  rung: number;
  chainSource: string;
  provider: LLMService;
  /** Model the rung runs, for the log line. */
  model?: string;
}

/** What the log lines identify the primary endpoint by. Never the key. */
export interface HotFallbackPrimaryIdentity {
  agentId?: string;
  baseUrl?: string;
  model?: string;
}

/**
 * @description Thrown when the primary exhausted its retry with a capacity wall and every rung
 * failed too. Carries which rungs were tried so the entry point can name them.
 */
export class HotFallbackRungsExhaustedError extends Error {
  readonly code = 'BYO_FALLBACK_NOT_READY';

  constructor(message: string, readonly triedRungs: readonly string[], readonly original: Error) {
    super(message);
    this.name = 'HotFallbackRungsExhaustedError';
  }
}

/**
 * @description The chain decorator. `sendRequest` goes to the primary until the primary surfaces
 * a retryable wall; then each rung is tried once, in order; the first to answer is the provider
 * for every later call in the turn, and {@link brainFallback} reports the switch.
 *
 * ONE INSTANCE IS ONE TURN, and ONE WALK. `createGovernedByoHostedProvider` builds this decorator
 * inside `TaskOrchestrator.resolveProvider`, which runs once per `processMessage` — so its lifetime
 * is exactly the orchestrator turn, and the walked flag is what makes "each rung is tried at most
 * once" a promise about the TURN rather than about one model call. An agentic turn makes up to 25
 * model calls; without the flag a primary that recovered and then walled again would start a second
 * walk and spend a second billed call on a rung that had already been tried.
 */
export class HotFallbackChainProvider extends LLMService {
  private active: LLMService;
  private taken: BrainFallbackMarker | null = null;
  /** True once the chain has been walked in this turn; the walk never happens twice. */
  private walked = false;

  constructor(
    private readonly primary: LLMService,
    private readonly identity: HotFallbackPrimaryIdentity,
    private readonly rungs: readonly HotFallbackRungProvider[],
  ) {
    super(primary.getProviderName(), {});
    this.active = primary;
  }

  /** The marker, once a rung answered; null while the primary is still the provider. */
  get brainFallback(): BrainFallbackMarker | null {
    return this.taken;
  }

  async sendRequest(options: SendRequestOptions): Promise<LLMResponse> {
    if (this.active !== this.primary) return this.active.sendRequest(options);
    let primaryFailure: Error;
    try {
      return await this.primary.sendRequest(options);
    } catch (err) {
      primaryFailure = err instanceof Error ? err : new Error(String(err));
    }
    const classified = classifySameEndpointRetry(primaryFailure);
    // A non-retryable failure (a 400 or a 401 on the chosen endpoint is an authorization or request
    // verdict, not a capacity wall) never reaches a rung: spending a billed call elsewhere would not
    // answer it. Nor does a second wall after the chain has already been walked this turn.
    if (!classified.retry || this.walked || this.rungs.length === 0) throw primaryFailure;
    this.walked = true;
    return this.walkRungs(options, primaryFailure, classified.reason);
  }

  /** Try each rung once, in order; the first that answers becomes the active provider. Once a turn. */
  private async walkRungs(options: SendRequestOptions, primaryFailure: Error, reason: string): Promise<LLMResponse> {
    const attempts = sameEndpointAttemptsOf(primaryFailure);
    const failedEndpoint = { host: endpointHost(this.identity.baseUrl), model: this.identity.model ?? null };
    const where = { agentId: this.identity.agentId, ...failedEndpoint, attempts, reason };
    logger.warn({ ...where, chain: this.rungs.map((r) => r.providerId) }, 'hot fallback: the chosen endpoint exhausted its same-endpoint retry — trying the ready rungs once each, in order');
    const tried: string[] = [];
    for (const rung of this.rungs) {
      tried.push(rung.providerId);
      try {
        const response = await rung.provider.sendRequest(options);
        this.active = rung.provider;
        this.taken = {
          reason: 'byo_exhausted', providerUsed: rung.providerId, rung: rung.rung, chainSource: rung.chainSource,
          failedEndpoint, attempts, failure: reason,
        };
        logger.warn(
          { ...where, rung: rung.rung, providerUsed: rung.providerId, rungModel: rung.model ?? null, chainSource: rung.chainSource },
          'hot fallback: answered by a fallback rung — the chosen endpoint was unavailable; this rung serves the rest of the turn',
        );
        return response;
      } catch (rungError) {
        logger.warn({ ...where, rung: rung.rung, providerId: rung.providerId, err: rungError as Error }, 'hot fallback: rung failed — trying the next rung once, never this one again');
      }
    }
    throw new HotFallbackRungsExhaustedError(
      `${primaryFailure.message}; the hot fallback rungs ${tried.join(', ')} were tried once each and all failed`,
      tried,
      primaryFailure,
    );
  }

  override calculateCost(usage: TokenUsage): CostResult {
    return this.active.calculateCost(usage);
  }

  /** The provider that is ACTUALLY serving, so a cost row written after the turn names the rung. */
  override getProviderName(): string {
    return this.active.getProviderName();
  }
}
