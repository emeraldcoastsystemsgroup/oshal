/**
 * The operator's HOT FALLBACK for an explicitly chosen BYO endpoint that has exhausted its
 * same-endpoint retry (operator decision 2026-09-22: "fix the retry but use the fallback ... keep a
 * HOT fallback as well - this portal has Codex and Claude Code", then "Configurable. Codex followed
 * by Claude Code, if either is available, by default - but this is configurable, there is literally
 * an API endpoint, it's already been set").
 *
 * WHO. Only the deployment OPERATOR, under exactly the gates that already govern lending the
 * portal's own vendor logins (ADR-127 / ADR-137 Amendment A "portal fallback"): `DEMO_MODE` truthy
 * AND the caller's sub in `OSHAL_OPERATOR_SUBS` — the same `cliBrainAvailable` predicate the chat
 * ladder's CLI rung reads. For any NON-operator caller nothing here runs: their explicit endpoint is
 * their billing/privacy boundary, `reportResolvedLlmFailure` keeps refusing to rotate it, and the
 * portal's logins are never lent to them. This is an operator decision superseding the narrow
 * "never rotate a BYO turn" rule for HIS OWN turns only; both rules are recorded side by side at
 * that refusal in free-tier-rotation.ts.
 *
 * WHAT. The chain is CONFIGURATION, read at turn time from the record ADR-162 already resolves the
 * brain from: the bot's own switch row if it carries a `fallback_order`, else the fleet-default
 * row's (migration 148), else `OSHAL_PROVIDER_FALLBACK_ORDER`, most specific first. Only when no
 * record carries a chain does the DEFAULT `['openai-codex', 'claude-code']` apply. The operator
 * changes the order with the endpoint that already exists — no restart:
 *   PUT /api/agents/provider-switch/fleet-default { "providerId": "<primary>", "fallbackOrder": ["openai-codex", "claude-code"] }
 * No provider is named in code as a fallback other than that default, and no second table, env
 * var or file holds the chain.
 *
 * HOT. Each rung is taken only if the readiness probe (fallback-rail-readiness.ts) says it is
 * available right now — login present and unexpired, key present, node reachable. A rung that is
 * not ready is skipped with its reason logged, never spent on. That gating is what makes
 * re-admitting `claude-code` to an automatic chain safe against the 2026-08-13 concern that
 * removed it (ADR-128 Amendment 1, "silent spend on a dying account"): a dying account's login
 * has lapsed, reads not-ready, and is skipped. The 2026-09-22 decision supersedes that removal for
 * this configurable, readiness-gated fallback ONLY; `DEMO_CLI_ORDER` is not changed.
 *
 * NEVER silent, never for others, never unbounded. One pass through the chain after the retry
 * budget; a rung that fails is followed by the next rung ONCE each, no retry within a rung, no
 * fallback-of-the-fallback; no fallback at all on a non-retryable failure (a 400/401 on the BYO
 * endpoint is not a capacity problem). Every fallback turn carries a machine-readable marker
 * (`brainFallback`) naming the provider that answered and why, and logs the switch at WARN with
 * the connection identity, the attempts, the reason and the rung — never the key. Cost lands under
 * the rail that served the turn, exactly as a normal turn on that rail would: a node rung records
 * at its node, a hosted rung records as the operator-key lane does.
 *
 * WHERE EACH RUNG CAN RUN, and the two halves of this module. A controller-INLINE turn cannot ride
 * a CLI (the controller refuses every unattended CLI; nothing here weakens that), so for it only a
 * hosted rung with an in-process lane (openai-compat-lanes) can serve: `planInlineHotFallback`
 * gates, resolves and probes the chain BEFORE the turn and hands the READY hosted rungs, with the
 * operator-key connection each rides, to the orchestrator, whose chain provider switches at the
 * model call — inside the same turn, one saved user message. A bot-NODE turn can ride any rung:
 * `recoverExplicitByoWall` re-dispatches once per ready rung with the rung stamped as the
 * dispatch's authoritative provider, and the node's own SEC-05 preflight re-enforces the
 * demo+operator carve for a CLI rung on its side.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the operator-only, readiness-gated, one-pass walk of the CONFIGURED fallback chain (switch-row fallback_order, ADR-162 precedence, default ['openai-codex','claude-code']) after an explicit BYO endpoint exhausted its same-endpoint retry: the inline plan the orchestrator's chain provider consumes at the model call, the node re-dispatch, the marker and the WARN line every such turn carries, and the clear not-ready error that names every rung's reason.
 *
 * @module byo-hot-fallback
 */

import { createChildLogger } from '@/shared/logger';
import {
  FLEET_DEFAULT_SWITCH_ID,
  classifyProviderId,
  resolveProviderFallbackChain,
  type ClassifiedProviderId,
  type ProviderSwitchCatalog,
  type RefusedProviderId,
} from '@/shared/llm-runtime';
import type { BrainFallbackMarker } from '@/shared/types';
import type { ProviderSwitchSnapshot } from '@/features/agent-management';
import { classifySameEndpointRetry, endpointHost, sameEndpointAttemptsOf, type ByoHostedFallbackRung } from '@/features/llm-provider';
import { installedProviderSwitchCatalog, installedProviderSwitchSnapshot } from '@/app/composition/provider-switch-runtime';
import { cliBrainAvailable } from './user-brain-resolution';
import { probeRungReadiness, type RungReadiness } from './fallback-rail-readiness';
import { OPENAI_COMPAT_LANES, laneKeyFromEnv } from './openai-compat-lanes';
import type { ByoLlmConnection } from './byo-llm-routes';

const logger = createChildLogger({ module: 'byo-hot-fallback' });

/**
 * The chain when NO record carries one (operator, 2026-09-22): Codex, then Claude Code. Applied
 * only when the switch rows and the environment are all silent; a configured chain — including a
 * deliberately EMPTY one — always wins over this.
 */
export const DEFAULT_HOT_FALLBACK_CHAIN: readonly string[] = Object.freeze(['openai-codex', 'claude-code']);

/** Where the effective chain came from, so the surface and the log can say so. */
export type HotFallbackChainSource = 'bot-row' | 'fleet-default' | 'environment' | 'default';

/** The effective, runnable chain for one scope. */
export interface HotFallbackChain {
  order: readonly string[];
  source: HotFallbackChainSource;
  /** Configured ids this build cannot run, each with its reason — never dropped silently. */
  refused: readonly RefusedProviderId[];
}

/** Injectable seams for the chain resolution (guards only; production reads the installed snapshot). */
export interface HotFallbackChainDeps {
  snapshot?: ProviderSwitchSnapshot | null;
  catalog?: ProviderSwitchCatalog | null;
  env?: NodeJS.ProcessEnv;
}

/** The catalog to classify against: injected, else the installed one, else an empty one. */
function catalogOrInstalled(catalog: ProviderSwitchCatalog | null | undefined): ProviderSwitchCatalog {
  return catalog ?? installedProviderSwitchCatalog() ?? { harnessTypes: [], clineApiProviders: [] };
}

/**
 * @description The effective fallback chain for a scope, from configuration: the bot's own switch
 * row, else the fleet-default row, else the environment override — the same precedence ADR-162
 * resolves the provider itself by — and the DEFAULT only when every one of those is silent.
 * `agentId: null` resolves the fleet-level chain (what the Settings surface shows).
 * @param agentId - The bot whose turn this is, or null for the fleet-level view.
 * @param deps - Guard seams; production reads the installed snapshot and catalog.
 * @returns The runnable order, its source, and any refused ids.
 */
export function resolveHotFallbackChain(agentId: string | null, deps: HotFallbackChainDeps = {}): HotFallbackChain {
  const snapshot = deps.snapshot === undefined ? installedProviderSwitchSnapshot() : deps.snapshot;
  const catalog = catalogOrInstalled(deps.catalog);
  const env = deps.env ?? process.env;
  const configured = snapshot
    ? (agentId
      ? snapshot.resolveFallbackChain(agentId, null)
      : resolveProviderFallbackChain({
        fleetRow: snapshot.status().fleetDefault,
        environmentOrder: env.OSHAL_PROVIDER_FALLBACK_ORDER ?? null,
        catalog,
      }))
    : resolveProviderFallbackChain({ environmentOrder: env.OSHAL_PROVIDER_FALLBACK_ORDER ?? null, catalog });
  if (configured.source !== 'none') {
    return { order: configured.order, source: configured.source, refused: configured.refused };
  }
  // Nothing configured anywhere: the default, validated against the same catalog so an id this
  // build cannot run is reported, not spent on.
  const order: string[] = [];
  const refused: RefusedProviderId[] = [];
  for (const id of DEFAULT_HOT_FALLBACK_CHAIN) {
    const classified = classifyProviderId(id, catalog);
    if (classified.ok) order.push(classified.providerId); else refused.push(classified);
  }
  return { order, source: 'default', refused };
}

/** The fleet-default row's scope id, for callers that want to name it in a message. */
export const HOT_FALLBACK_FLEET_SCOPE = FLEET_DEFAULT_SWITCH_ID;

/**
 * @description Thrown when the operator's explicit endpoint exhausted its retry and NO rung of the
 * hot fallback could answer — none was ready, or every ready rung failed. The message names the
 * endpoint, the attempts, the classified reason and every rung's status, because "the fallback
 * was not ready" is only actionable with the why.
 */
export class ByoFallbackUnavailableError extends Error {
  /** Machine code the routes branch on. */
  readonly code = 'BYO_FALLBACK_NOT_READY';

  /** HTTP status the chat routes map this to: the rail is temporarily unavailable, not broken. */
  readonly statusCode = 503;

  constructor(
    message: string,
    /** Every rung considered, with its verdict, in chain order. */
    readonly rungs: readonly RungReadiness[],
    /** The endpoint failure that started this. */
    readonly original: Error,
  ) {
    super(message);
    this.name = 'ByoFallbackUnavailableError';
  }
}

/** Renders the endpoint for a log line or a sentence: host and model, never the key. */
function describeEndpoint(endpoint: { baseUrl?: string; model?: string } | undefined): { host: string | null; model: string | null } {
  return { host: endpointHost(endpoint?.baseUrl), model: endpoint?.model ?? null };
}

/** The hosted connection a rung rides in-process — the operator-key lane shape, same env, same model rule. */
function hostedRungConnection(classified: ClassifiedProviderId): ByoLlmConnection | undefined {
  if (classified.botNodeRuntime !== 'cline-cli' || !classified.clineApiProvider) return undefined;
  const lane = OPENAI_COMPAT_LANES[classified.clineApiProvider.toLowerCase()];
  if (!lane) return undefined;
  const apiKey = laneKeyFromEnv(lane);
  const model = (process.env.OSHAL_OPERATOR_LLM_MODEL || '').trim() || lane.defaultModel;
  return apiKey && model ? { baseUrl: lane.baseUrl, apiKey, model } : undefined;
}

/** What an inline turn is handed before it runs. */
export interface InlineHotFallbackPlan {
  /** True when the gates admit this caller for this turn (explicit endpoint, demo deployment, operator). */
  applies: boolean;
  chain: HotFallbackChain | null;
  /** Every rung's verdict, in chain order — the surface of the not-ready error. */
  readiness: RungReadiness[];
  /** The READY hosted rungs with the connection each rides; what the orchestrator's chain provider gets. */
  rungs: ByoHostedFallbackRung[];
}

/**
 * @description Decide, BEFORE an inline turn, which hot-fallback rungs it may switch to at the
 * model call: nothing unless the endpoint was explicitly chosen and the caller is the deployment
 * operator under DEMO_MODE; otherwise the configured chain, each rung probed for the inline
 * transport (a CLI login cannot serve in-process and says so), and only the ready hosted rungs —
 * with the operator-key connection each rides — are handed on. Probing here IS the "hot": the
 * rungs are known ready before the endpoint has had a chance to fail.
 * @param input - The turn's agent, caller and whether its endpoint was explicit.
 * @returns The plan: whether the fallback applies, the readiness list, and the ready rungs.
 */
export async function planInlineHotFallback(input: {
  agentId: string;
  userSub: string | undefined;
  explicit: boolean;
  catalog?: ProviderSwitchCatalog | null;
}): Promise<InlineHotFallbackPlan> {
  if (!input.explicit) return { applies: false, chain: null, readiness: [], rungs: [] };
  if (!input.userSub || !cliBrainAvailable(input.userSub)) {
    logger.info({ agentId: input.agentId, hasSub: Boolean(input.userSub) }, 'hot fallback: not the deployment operator under DEMO_MODE — the chosen endpoint is the caller\'s own boundary; no fallback is planned');
    return { applies: false, chain: null, readiness: [], rungs: [] };
  }
  const catalog = catalogOrInstalled(input.catalog);
  const chain = resolveHotFallbackChain(input.agentId, { catalog });
  const readiness: RungReadiness[] = [];
  const rungs: ByoHostedFallbackRung[] = [];
  for (const [index, providerId] of chain.order.entries()) {
    const verdict = await probeRungReadiness({ providerId, transport: 'inline', catalog });
    readiness.push(verdict);
    if (!verdict.ready) continue;
    const classified = classifyProviderId(providerId, catalog);
    const connection = classified.ok ? hostedRungConnection(classified) : undefined;
    if (!connection) continue;
    rungs.push({ providerId, rung: index + 1, chainSource: chain.source, connection });
  }
  logger.info(
    { agentId: input.agentId, chain: chain.order, chainSource: chain.source, ready: rungs.map((r) => r.providerId), notReady: readiness.filter((r) => !r.ready).map((r) => `${r.providerId}: ${r.reason}`) },
    'hot fallback: planned for an explicit operator turn (inline) — ready rungs ride into the turn',
  );
  return { applies: true, chain, readiness, rungs };
}

/**
 * @description After an inline turn failed with the fallback planned: the clear error the caller
 * surfaces INSTEAD of the raw provider failure — naming the endpoint, the attempts, the reason and
 * every rung's status — or null when the fallback did not apply or the failure was not a capacity
 * wall (a 400/401 is not a capacity problem; the original failure is the honest answer).
 * @param plan - The plan the turn ran with.
 * @param failure - The surfaced failure (thrown, or lifted off the swallowed result).
 * @param endpoint - The endpoint that failed — host and model only are ever named.
 * @returns The not-ready error to throw, or null to surface the original failure.
 */
export function explainInlineFallbackMiss(
  plan: InlineHotFallbackPlan,
  failure: Error,
  endpoint: { baseUrl?: string; model?: string } | undefined,
): ByoFallbackUnavailableError | null {
  if (!plan.applies) return null;
  const classified = classifySameEndpointRetry(failure);
  if (!classified.retry) return null;
  const attempts = sameEndpointAttemptsOf(failure);
  const tried = new Set(plan.rungs.map((r) => r.providerId.toLowerCase()));
  const where = describeEndpoint(endpoint);
  const rungLines = plan.readiness.length
    ? plan.readiness.map((r) => `${r.providerId} — ${tried.has(r.providerId.toLowerCase()) ? 'tried and failed' : r.reason}`).join('; ')
    : `no fallback rung is configured (set fallbackOrder on the ${HOT_FALLBACK_FLEET_SCOPE} switch row)`;
  logger.warn({ ...where, attempts, reason: classified.reason, rungs: plan.readiness.map((r) => ({ providerId: r.providerId, ready: r.ready, reason: r.reason })) }, 'hot fallback: the chosen endpoint was exhausted and no rung could answer');
  return new ByoFallbackUnavailableError(
    `Your selected AI endpoint (${where.host ?? 'unknown host'}, ${where.model ?? 'unknown model'}) refused ${attempts} attempt${attempts === 1 ? '' : 's'} (${classified.reason}), and the hot fallback was not ready: ${rungLines}. Nothing else was tried.`,
    plan.readiness,
    failure,
  );
}

/** One rung of the node walk, resolved for execution. */
export interface HotFallbackRung {
  providerId: string;
  /** 0-based position in the chain. */
  index: number;
  classified: ClassifiedProviderId;
}

/** Everything the node-side fallback needs to know about the dispatch that just failed. */
export interface HotFallbackTurn<T> {
  agentId: string;
  userSub: string | undefined;
  /** True when the turn ran on an EXPLICITLY chosen endpoint (resolutionSource 'explicit'). */
  explicit: boolean;
  /** The endpoint that failed — host and model only are ever logged. */
  endpoint: { baseUrl?: string; model?: string } | undefined;
  /** The surfaced failure. */
  failure: Error;
  /** The client that can ping the agent's node. */
  botClient?: { healthCheck(agentId: string): Promise<boolean> };
  /** Re-dispatches the turn ONCE on a rung. Throws on failure. */
  executeRung: (rung: HotFallbackRung) => Promise<T>;
  /** Injectable chain (guards only). */
  chain?: HotFallbackChain;
  /** Injectable catalog (guards only). */
  catalog?: ProviderSwitchCatalog | null;
}

/**
 * @description The NODE half: after a dispatch on an explicitly chosen endpoint failed with a
 * capacity wall, for the deployment operator under the demo gates and only then, walk the
 * configured chain once — readiness-gated (login present + unexpired, node reachable), each ready
 * rung re-dispatched exactly once with the rung stamped as the authoritative provider — and answer
 * from the first rung that does. Returns null when the fallback does not apply (non-operator,
 * non-explicit, or a non-retryable failure), so the caller surfaces the original failure
 * unchanged; throws {@link ByoFallbackUnavailableError} when it applied and no rung could answer.
 * @param turn - The failed dispatch and how to re-dispatch it on a rung.
 * @returns The rung's result with the marker, or null when the fallback does not apply.
 * @throws ByoFallbackUnavailableError when every rung was not ready or failed.
 */
export async function recoverExplicitByoWall<T>(turn: HotFallbackTurn<T>): Promise<{ result: T; marker: BrainFallbackMarker } | null> {
  const where = { agentId: turn.agentId, ...describeEndpoint(turn.endpoint), transport: 'node' as const };
  if (!turn.explicit) return null;
  if (!turn.userSub || !cliBrainAvailable(turn.userSub)) {
    logger.info({ ...where, hasSub: Boolean(turn.userSub) }, 'hot fallback: not the deployment operator under DEMO_MODE — the chosen endpoint is the caller\'s own boundary; its failure surfaces unchanged');
    return null;
  }
  const classified = classifySameEndpointRetry(turn.failure);
  if (!classified.retry) {
    logger.info({ ...where, reason: classified.reason }, 'hot fallback: the endpoint failure is not a capacity wall — no fallback');
    return null;
  }
  const attempts = sameEndpointAttemptsOf(turn.failure);
  const catalog = catalogOrInstalled(turn.catalog);
  const chain = turn.chain ?? resolveHotFallbackChain(turn.agentId, { catalog });
  const considered: RungReadiness[] = [];
  logger.warn(
    { ...where, attempts, reason: classified.reason, chain: chain.order, chainSource: chain.source, refused: chain.refused.map((r) => r.providerId) },
    'hot fallback: the operator\'s chosen endpoint exhausted its same-endpoint retry — walking the configured fallback chain once',
  );
  for (const [index, providerId] of chain.order.entries()) {
    const readiness = await probeRungReadiness({ providerId, transport: 'node', agentId: turn.agentId, botClient: turn.botClient, catalog });
    considered.push(readiness);
    if (!readiness.ready) {
      logger.warn({ ...where, rung: index + 1, providerId, reason: readiness.reason }, 'hot fallback: rung is not ready — skipped, not spent on');
      continue;
    }
    const rungClassified = classifyProviderId(providerId, catalog);
    if (!rungClassified.ok) continue; // readiness already refused an unrunnable id; belt and braces
    try {
      const result = await turn.executeRung({ providerId, index, classified: rungClassified });
      const marker: BrainFallbackMarker = {
        reason: 'byo_exhausted', providerUsed: providerId, rung: index + 1, chainSource: chain.source,
        failedEndpoint: describeEndpoint(turn.endpoint), attempts, failure: classified.reason,
      };
      logger.warn(
        { ...where, attempts, reason: classified.reason, rung: index + 1, providerUsed: providerId, chainSource: chain.source },
        'hot fallback: answered by a fallback rung — the chosen endpoint was unavailable',
      );
      return { result, marker };
    } catch (rungError) {
      logger.warn({ ...where, err: rungError as Error, rung: index + 1, providerId }, 'hot fallback: rung failed — trying the next rung once, never this one again');
    }
  }
  const endpoint = describeEndpoint(turn.endpoint);
  const rungLines = considered.length
    ? considered.map((r) => `${r.providerId} — ${r.ready ? 'tried and failed' : r.reason}`).join('; ')
    : `no fallback rung is configured (set fallbackOrder on the ${HOT_FALLBACK_FLEET_SCOPE} switch row)`;
  throw new ByoFallbackUnavailableError(
    `Your selected AI endpoint (${endpoint.host ?? 'unknown host'}, ${endpoint.model ?? 'unknown model'}) refused ${attempts} attempt${attempts === 1 ? '' : 's'} (${classified.reason}), and the hot fallback was not ready: ${rungLines}. Nothing else was tried.`,
    considered,
    turn.failure,
  );
}
