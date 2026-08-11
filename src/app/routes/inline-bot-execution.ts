/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Cost-governance interactive gate: executeBotOrInline is the chokepoint both remote BotNodeClient.execute and inline-orchestrator executions flow through (ADR-036 direct sync path), so a HARD user-scope budget breach now blocks interactive execution here — queued dispatch is separately gated in the queue manager. Fail-open on infra gaps per BudgetService semantics.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-090 skill-profile GENERAL carrier: executeBotOrInline is the shared bot-execution chokepoint, so resolve the calling app's domain profile ONCE here (controller-side; the bot holds no registry — ADR-036), guarded on request.app && request.capability. Inline path weaves the composed block into the text before processMessage; remote path sets request.pattern so it rides to the bot node's assembled-prompt append. Generalizes email-routes' hand-wired composition off request.app/capability instead of a hardcoded app. No-op for every call that omits app/capability.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG "Bot-endpoint privilege model" (diagnosis bot-endpoint-priv): executeBotOrInline now runs assertExecuteEntitlement BEFORE dispatching either branch — controller-INLINE bots resolve to a null endpoint (CONTROLLER_INLINE_CONTAINERS) and bypassed the bot-node HTTP entitlement gate entirely, so exactly the ADR-087 operator/swarm-scoped machinery (project-manager, codex-packer) had NO execute-time per-caller check; remote calls now also get an early controller-side denial. Reuses the SAME pure decideExecuteEntitlement the bot-node gate runs (no policy copy to drift). Mode: warn default (log-only), enforce throws CallerNotEntitledError (statusCode 403).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Security hardening: reject generic credential carriers and require deterministic provider intents to execute on a dedicated audited bot node; inline model requests receive caller identity but never connector secrets.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-127 inline hosted brain: the INLINE branch resolves the caller's hosted user-brain ladder (resolveUserLlmConnection) when the target bot's registry harness is an unbrokered CLI and no byoLlmConnection was threaded — the SEC-05 refusal must never be the user-facing answer. Shared helpers (agentRequiresHostedBrain / resolveHostedBrainForCliAgent, NoHostedBrainError code NO_HOSTED_BRAIN) are exported so message-routes rides the SAME condition and the two chat entry points cannot drift.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Review hardening: the registry loader is a lazy dynamic import (the raw require could not load the .ts module under vitest, silently no-op'ing the condition in every route spec — the guard gap the first review caught); agentRequiresHostedBrain is pure over supplied entries; identity-less callers refuse with NO_HOSTED_BRAIN before the ladder so an anonymous turn can never ride the platform lane. Entry-point guards live in tests/unit/inline-hosted-brain-entry-points.spec.ts, mutation-tested on both wirings.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Turn-time hosted-brain failover (retryHostedBrainTurn): resolution-time probing cannot cover a lane exhausting its quota BETWEEN probe and completion (Gemini free tier = 20/day), so the 429 was handed to the caller as the answer. On a resolver-owned connection the failed turn now reports through reportResolvedLlmFailure (cools the free-tier row / drops the operator-lane verdict) and replays ONCE on the next resolved lane; same-lane re-resolution and explicit BYO connections surface the original failure unretried. resolveHostedBrainMeta returns the FULL connection (metadata needed to cool the right lane) and hostedBrainWire strips to the three wire fields at the processMessage boundary.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Close the failover's blind spot (live 2026-08-11: the 429 STILL became the answer): the agentic loop catches provider errors internally (task-orchestrator handleError) and RESOLVES with { success:false, error } — so the route-level catch entry 7 added never fired on exactly the live path. swallowedTurnFailure detects the failure-shaped RESULT and both entry points feed it through the SAME retryHostedBrainTurn; retryability still belongs to reportResolvedLlmFailure's pattern gate, so genuine content failures stay failures. Cost: a replayed turn re-appends the user message to the thread (cosmetic duplicate) — accepted over shipping a provider's quota wall as the assistant's reply.
 */

import type { AppContext } from '@/app/composition/app-context';
import type { BotNodeClient, BotNodeRequest, BotNodeResponse } from '@/features/agent-management';
import type { TaskUsageSummary } from '@/shared/types';
import { createChildLogger } from '@/shared/logger';
import { BudgetService } from '@/features/cost-governance';
import { isUnbrokeredAutonomousProvider } from '@/features/llm-provider';
import { composeSkillProfilePrompt, resolveSkillProfileByApp } from '@/shared/skill-profiles';
import { assertExecuteEntitlement } from '@/app/bot-node-execute-entitlement';
import { reportResolvedLlmFailure, resolveUserLlmConnection, type ResolvedUserLlmConnection } from './free-tier-rotation';
import type { ByoLlmConnection } from './byo-llm-routes';

const logger = createChildLogger({ module: 'inline-bot-execution' });

/**
 * @description Thrown when a turn targets a CLI-harness bot but the caller has NO hosted
 * brain anywhere on the user-brain ladder (ADR-127). The message is the user-facing answer —
 * it names Settings → AI Providers instead of surfacing the raw SEC-05 refusal.
 */
export class NoHostedBrainError extends Error {
  /** Machine code the chat routes branch on. */
  readonly code = 'NO_HOSTED_BRAIN';

  constructor() {
    super(
      'No AI engine is connected for this account, so this assistant cannot answer yet. '
      + 'Open Settings → AI Providers to connect a hosted provider or add your own endpoint, then try again.',
    );
    this.name = 'NoHostedBrainError';
  }
}

/**
 * @description The registry facts hosted-brain resolution reads. Structural (not the full
 * SwarmBotDefinition) so guard specs can inject minimal entries and so this route module
 * depends on nothing but the two fields it actually consumes.
 */
export interface RegistryHarnessFacts {
  agentId?: string;
  harnessType?: string;
}

/**
 * @description Injectable seams for {@link resolveHostedBrainForCliAgent} — used ONLY by guard
 * specs; production callers pass nothing and get the real registry + the real ladder.
 */
export interface HostedBrainResolutionOverrides {
  /** Registry reader override for condition tests; production loads the real active registry. */
  loadRegistry?: () => ReadonlyArray<RegistryHarnessFacts>;
  /** Ladder override for condition tests; production always walks resolveUserLlmConnection. */
  resolveConnection?: (pool: AppContext['pool'], userSub: string) => Promise<ByoLlmConnection | undefined>;
  /** Failure-report override for retry tests; production always calls reportResolvedLlmFailure. */
  reportFailure?: (pool: AppContext['pool'], connection: ResolvedUserLlmConnection, error: unknown) => Promise<boolean>;
}

/**
 * @description Default registry reader. A LAZY dynamic import rather than a static import for
 * the same reason provider-runtime's defaultLoadHarnessRegistry gives: this module sits on the
 * controller route graph, and an eager edge onto the swarm extension is exactly what the
 * two-runtimes boundary guard pins. Dynamic import (not `require`) because the raw require
 * cannot load the .ts module under vitest, which silently no-op'd the condition in every route
 * spec — the guard gap the 2026-08-11 review caught. Failures return [] (no override, so the
 * turn proceeds to the registry provider and its existing refusal path).
 * @returns The active registry entries, or [] when the registry is unavailable.
 */
async function defaultLoadSwarmRegistry(): Promise<ReadonlyArray<RegistryHarnessFacts>> {
  try {
    // The '.js' extension is the nodenext ESM contract: it is the emitted filename in dist,
    // and the TS/vitest resolvers map it back to the .ts source during tests.
    const mod = await import('../extensions/swarm/swarm-bot-registry.js');
    return mod.getActiveRegistry() as ReadonlyArray<RegistryHarnessFacts>;
  } catch (err) {
    logger.warn({ err }, 'hosted-brain resolution: registry unavailable — no hosted-brain override');
    return [];
  }
}

/**
 * @description Whether this agent's registry harness is one the controller refuses to run
 * unattended (the unbrokered CLI set) — i.e. whether a controller-side turn for it NEEDS a
 * hosted brain. Pure over the supplied entries so both entry points and the guard specs share
 * one condition with no hidden loader state.
 * @param agentId - The target bot's agent UUID.
 * @param registry - The active registry entries to consult.
 * @returns True when the bot's declared harness is an unbrokered autonomous CLI.
 */
export function agentRequiresHostedBrain(
  agentId: string,
  registry: ReadonlyArray<RegistryHarnessFacts>,
): boolean {
  const entry = registry.find((bot) => bot.agentId === agentId);
  return Boolean(entry?.harnessType && isUnbrokeredAutonomousProvider(entry.harnessType));
}

/**
 * @description The ONE resolve-condition both chat entry points ride (ADR-127): when the
 * target bot's registry harness is an unbrokered CLI, resolve the caller's hosted user-brain
 * ladder (explicit BYO → free tiers → platform lane → operator key) and return the FULL
 * resolved connection — resolver metadata included, because turn-time failover
 * ({@link retryHostedBrainTurn}) needs `resolutionSource`/`connectionId` to cool the right
 * lane. Hosted/other harnesses get NO override (undefined), and a CLI-harness bot with
 * nothing on the ladder throws {@link NoHostedBrainError} so callers answer with
 * Settings → AI Providers, never the raw SEC-05 refusal.
 * @param pool - pg pool for the ladder's per-user reads.
 * @param agentId - The target bot's agent UUID.
 * @param userSub - The caller's OIDC sub; identity-less callers get no override.
 * @param overrides - Injectable seams for guard specs only.
 * @returns The full resolved connection, or undefined for no override.
 * @throws NoHostedBrainError when a CLI-harness bot has no resolvable hosted brain.
 */
export async function resolveHostedBrainMeta(
  pool: AppContext['pool'],
  agentId: string,
  userSub: string | undefined,
  overrides?: HostedBrainResolutionOverrides,
): Promise<ByoLlmConnection | undefined> {
  const registry = overrides?.loadRegistry ? overrides.loadRegistry() : await defaultLoadSwarmRegistry();
  if (!agentRequiresHostedBrain(agentId, registry)) {
    return undefined;
  }
  // An identity-less caller never walks the ladder: the platform free lane would otherwise
  // resolve for sub '' and an anonymous turn would ride the deployment's own key. No override
  // (NOT a refusal) — internal/swarm-dispatch turns carry no user and must behave exactly as
  // they did before this feature. Guests carry real `guest-…` subs, so the ladder's designed
  // non-operator legs still govern them.
  if (!userSub) {
    logger.info({ agentId }, 'hosted-brain resolution: identity-less caller — no override');
    return undefined;
  }
  const resolveConnection = overrides?.resolveConnection
    ?? (resolveUserLlmConnection as (pool: AppContext['pool'], userSub: string) => Promise<ByoLlmConnection | undefined>);
  let connection: ByoLlmConnection | undefined;
  try {
    connection = await resolveConnection(pool, userSub);
  } catch (err) {
    // A ladder FAILURE (DB down, misconfigured lane) is not "no brain": fail open with no
    // override so the turn behaves exactly as it did before this feature existed, instead of
    // converting an infrastructure error into a user-facing refusal.
    logger.warn({ err, agentId }, 'hosted-brain resolution: ladder failed — no override');
    return undefined;
  }
  if (!connection) {
    logger.warn({ agentId }, 'hosted-brain resolution: nothing on the ladder — refusing with NO_HOSTED_BRAIN');
    throw new NoHostedBrainError();
  }
  logger.info({ agentId, model: connection.model }, 'hosted-brain resolution: CLI-harness bot rides the resolved hosted connection');
  return connection;
}

/**
 * @description Strips a resolved connection to exactly the three wire fields the turn may
 * see — resolver metadata (resolutionSource, connectionId, …) never travels into
 * processMessage options or the provider.
 * @param connection - The full resolved connection, or undefined.
 * @returns The wire trio, or undefined.
 */
export function hostedBrainWire(connection: ByoLlmConnection | undefined): ByoLlmConnection | undefined {
  return connection
    ? { baseUrl: connection.baseUrl, apiKey: connection.apiKey, model: connection.model }
    : undefined;
}

/**
 * @description Back-compat wrapper over {@link resolveHostedBrainMeta} returning only the
 * wire trio. Callers that need turn-time failover use the meta form + retryHostedBrainTurn.
 * @param pool - pg pool for the ladder's per-user reads.
 * @param agentId - The target bot's agent UUID.
 * @param userSub - The caller's OIDC sub; identity-less callers get no override.
 * @param overrides - Injectable seams for guard specs only.
 * @returns The hosted connection to thread as byoLlmConnection, or undefined for no override.
 * @throws NoHostedBrainError when a CLI-harness bot has no resolvable hosted brain.
 */
export async function resolveHostedBrainForCliAgent(
  pool: AppContext['pool'],
  agentId: string,
  userSub: string | undefined,
  overrides?: HostedBrainResolutionOverrides,
): Promise<ByoLlmConnection | undefined> {
  return hostedBrainWire(await resolveHostedBrainMeta(pool, agentId, userSub, overrides));
}

/**
 * @description Turn-time failover (the half resolution-time probing cannot cover): a lane can
 * pass its probe and then hit a provider wall mid-turn — Gemini's free tier is 20 requests a
 * day, so the quota exhausts BETWEEN resolution and completion. When the failed turn ran on a
 * connection this module resolved, report the failure (cools the free-tier row / drops the
 * cached operator-lane verdict) and re-resolve ONCE; the caller replays the turn on the next
 * lane. Explicit BYO connections are a user-selected billing boundary — reportResolvedLlmFailure
 * refuses those, so they surface their own errors unretried, exactly like the Jarvis path.
 * @param pool - pg pool for the ladder's reads.
 * @param agentId - The target bot's agent UUID.
 * @param userSub - The caller's OIDC sub.
 * @param first - The full resolved connection the failed turn ran on (undefined = no retry).
 * @param error - The turn failure.
 * @param overrides - Injectable seams for guard specs only.
 * @returns The next lane's wire trio to replay on, or null when no retry is warranted.
 */
export async function retryHostedBrainTurn(
  pool: AppContext['pool'],
  agentId: string,
  userSub: string | undefined,
  first: ByoLlmConnection | undefined,
  error: unknown,
  overrides?: HostedBrainResolutionOverrides,
): Promise<ByoLlmConnection | null> {
  if (!first) return null;
  const report = overrides?.reportFailure
    ?? (reportResolvedLlmFailure as (pool: AppContext['pool'], connection: ResolvedUserLlmConnection, error: unknown) => Promise<boolean>);
  const shouldRetry = await report(pool, first as ResolvedUserLlmConnection, error).catch((reportErr) => {
    logger.warn({ err: reportErr, agentId }, 'hosted-brain retry: failure report failed — no retry');
    return false;
  });
  if (!shouldRetry) return null;
  let second: ByoLlmConnection | undefined;
  try {
    second = await resolveHostedBrainMeta(pool, agentId, userSub, overrides);
  } catch {
    return null; // the ladder is now empty (NoHostedBrainError) — surface the ORIGINAL failure
  }
  if (!second || (second.baseUrl === first.baseUrl && second.model === first.model)) {
    return null; // same lane again — a replay would reproduce the wall
  }
  logger.info(
    { agentId, failedModel: first.model, retryModel: second.model },
    'hosted-brain retry: lane failed mid-turn — replaying once on the next lane',
  );
  return hostedBrainWire(second) ?? null;
}

/**
 * @description Detects a provider failure the orchestrator caught INTERNALLY: the agentic
 * loop wraps every turn in handleError, which marks the task failed and RESOLVES with
 * `{ success: false, error }` instead of throwing — so a route-level catch around
 * processMessage never fires for exactly the mid-turn quota walls turn-time failover exists
 * for (live 2026-08-11: a Gemini 429 rode this shape straight into the chat as the answer).
 * Both entry points call this on the RESOLVED result and feed the synthesized Error through
 * {@link retryHostedBrainTurn}, whose retryability gate (reportResolvedLlmFailure's pattern
 * match) still decides — a genuine content failure stays a failure, unretried.
 * @param result - The resolved orchestrator result.
 * @returns An Error carrying the result's error text, or undefined when the turn succeeded.
 */
export function swallowedTurnFailure(
  result: { success?: boolean; error?: string | null } | null | undefined,
): Error | undefined {
  if (result && result.success === false && typeof result.error === 'string' && result.error.trim()) {
    return new Error(result.error);
  }
  return undefined;
}

/**
 * @description Executes a bot request on its remote any-bot node when one exists;
 * otherwise runs controller-inline bots through the local orchestrator. Both paths sit
 * behind the cost-governance budget gate: a HARD user-scope daily cap definitively
 * exceeded throws before any LLM work starts (fail-open on infra gaps — a missing
 * budgets table or DB hiccup never blocks execution).
 * @param ctx - App context (pool + inline orchestrator).
 * @param botClient - Bot-node client used for remote any-bot execution.
 * @param agentId - The target bot's agent UUID.
 * @param request - The execution request (userSub is the accountable spend owner).
 * @returns The bot-node response (remote or inline-normalized).
 * @throws CallerNotEntitledError (statusCode 403) in enforce mode when an interactive
 *   identity caller (userSub + direct:true) is not entitled to the target bot.
 */
export async function executeBotOrInline(
  ctx: AppContext,
  botClient: BotNodeClient,
  agentId: string,
  request: BotNodeRequest,
): Promise<BotNodeResponse> {
  // Execute-time entitlement (BACKLOG "Bot-endpoint privilege model"): the SAME pure decision
  // the bot-node HTTP gate runs, applied at THIS controller chokepoint because inline bots
  // (null endpoint) never reach that gate and remote calls deserve an early denial. Runs
  // FIRST — an unentitled caller must not consume budget checks or profile resolution.
  // warn (default): logs the would-be denial and proceeds; enforce: throws (403).
  assertExecuteEntitlement({
    userSub: request.userSub,
    direct: request.direct === true,
    targetAgentId: agentId,
    taskId: request.taskId ?? null,
    surface: 'executeBotOrInline',
  });

  const carriesCreds = Boolean(request.creds && Object.keys(request.creds).length > 0);
  const hasDedicatedEndpoint = botClient.hasEndpoint(agentId);
  if (carriesCreds && !request.providerIntent) {
    const error = new Error('Connector credentials require a validated deterministic provider intent') as Error & { code: string };
    error.code = 'UNSCOPED_CREDENTIAL_CARRIER';
    throw error;
  }
  if (!hasDedicatedEndpoint && (request.providerIntent || carriesCreds)) {
    const error = new Error('Deterministic provider intents require a dedicated audited bot-node handler') as Error & { code: string };
    error.code = 'PROVIDER_INTENT_REQUIRES_BOT_NODE';
    throw error;
  }

  // BudgetService holds no per-instance caches, so per-call construction is safe.
  const verdict = await new BudgetService(ctx.pool).checkBudget(request.userSub ?? null);
  if (!verdict.allowed) {
    throw new Error(
      `Budget governance blocked execution (${verdict.reason}): spend $${verdict.spend?.toFixed(2)} >= cap $${verdict.cap}`,
    );
  }

  // ADR-090 skill-profile GENERAL carrier: resolve the calling app's domain profile for this
  // capability ONCE, controller-side (the bot holds no registry — ADR-036). Guarded on BOTH app +
  // capability, so every non-app call resolves to '' — an exact no-op. composeSkillProfilePrompt
  // returns '' when no app registered a profile for that capability. This generalizes email-routes'
  // hand-wired composition to ANY app's execute / inline-concierge path, keyed off the request.
  const skillPattern = request.app && request.capability
    ? composeSkillProfilePrompt('', request.capability, resolveSkillProfileByApp(request.app, request.capability))
    : '';

  if (hasDedicatedEndpoint) {
    // Remote path: the resolved block rides to the bot node as request.pattern (→ envelope.payload).
    // The bot-node execution handler appends it to its assembled prompt in BOTH prompt branches —
    // the layered branch builds from persona layers + buildUserMessage, never from `text`, which is
    // exactly why weaving into `text` (as the inline path does) would never reach it there.
    if (skillPattern) request.pattern = skillPattern;
    return botClient.execute(agentId, request);
  }

  const start = Date.now();
  // Inline (controller-hosted concierge) path: no envelope/bot node, so weave the resolved block into
  // the text before processMessage — same effect as the remote append, one place.
  const inlineText = skillPattern ? `${request.text}${skillPattern}` : request.text;
  // ADR-127 inline hosted brain: an inline bot whose registry harness is an unbrokered CLI has no
  // admissible in-process runtime (SEC-05 refuses those unconditionally on the controller), so when
  // the caller did not thread a connection, resolve the user-brain ladder HERE — the same hosted
  // rungs Jarvis rides. Throws NO_HOSTED_BRAIN (naming Settings → AI Providers) when nothing
  // resolves; hosted/other harnesses pass through with no override. A caller-threaded connection
  // is an explicit billing boundary — used verbatim, never retried elsewhere.
  const resolvedBrain = request.byoLlmConnection
    ? undefined
    : await resolveHostedBrainMeta(ctx.pool, agentId, request.userSub);
  const runTurn = (byoLlmConnection: typeof request.byoLlmConnection) =>
    ctx.orchestrator.processMessage(request.taskId, inlineText, {
      agenticMode: request.agenticMode ?? true,
      autoApprove: false,
      source: 'inline-bot',
      agentId,
      userSub: request.userSub,
      providerId: request.providerId,
      model: request.model,
      interactionMode: request.direct ? 'task' : 'chat',
      byoLlmConnection,
    } as any);
  let result: Awaited<ReturnType<typeof runTurn>>;
  try {
    result = await runTurn(request.byoLlmConnection ?? hostedBrainWire(resolvedBrain));
  } catch (turnError) {
    // Turn-time failover: a lane that passed its resolution probe can hit its quota mid-turn
    // (Gemini free tier = 20/day). Cool the lane and replay ONCE on the next vendor.
    const nextLane = await retryHostedBrainTurn(
      ctx.pool, agentId, request.userSub, resolvedBrain, turnError,
    );
    if (!nextLane) throw turnError;
    result = await runTurn(nextLane);
  }

  // The agentic loop catches provider errors internally and resolves with a failed result —
  // the catch above never sees those. Same failover, keyed off the result shape instead.
  const swallowed = swallowedTurnFailure(result);
  if (swallowed) {
    const nextLane = await retryHostedBrainTurn(
      ctx.pool, agentId, request.userSub, resolvedBrain, swallowed,
    );
    if (nextLane) result = await runTurn(nextLane);
  }

  if (!result.success) {
    throw new Error(`Inline bot execution failed: ${result.error || 'Unknown error'}`);
  }

  const usage = result.usageSummary;
  const model = firstUsageModel(usage) ?? request.model ?? 'inline-orchestrator';
  return {
    success: true,
    response: result.response ?? '',
    usage: {
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      totalTokens: usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    cost: usage?.totalCost ?? 0,
    model,
    provider: (request.byoLlmConnection || resolvedBrain) ? 'byo-llm' : 'inline-orchestrator',
    durationMs: Date.now() - start,
    taskId: request.taskId,
  };
}

function firstUsageModel(usage?: TaskUsageSummary): string | null {
  const names = Object.keys(usage?.byModel ?? {});
  return names.length > 0 ? names[0] : null;
}
