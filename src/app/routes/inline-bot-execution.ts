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
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Diagnosability: every declined retry in retryHostedBrainTurn now logs its reason (not-a-wall / ladder-empty / same-lane). The same-lane branch declining SILENTLY in 7ms is what hid the probe-passes-on-a-quota-trickle trap (fixed in free-tier-rotation seq 10) behind a mystery.
 * 10 | maintainer@emeraldcoastsystemsgroup.com  | ADR-127 REMOTE brain (stampRemoteBrain): a dedicated-node dispatch for a CLI-harness bot now carries the caller's resolved brain — the FULL ladder including the demo-CLI carve, so the operator's turns ride the mounted login stamped as the ADR-034 authoritative provider and guests ride a hosted lane as byoLlmConnection. Before this, only jarvis-orchestrator stamped its own dispatches; every other node route dispatched brainless and the node's static default governed regardless of who was calling.
 * 11 | maintainer@emeraldcoastsystemsgroup.com  | One harness resolution for guard AND executor (live 2026-08-13, career.oshal.ai swarmbot popup): agentRequiresHostedBrain matched the registry by agentId ONLY, but provider-runtime's resolveHarnessForAgent ALSO falls back to the entry named by process BOT_NAME. The controller runs BOT_NAME=project-manager (harness codex-cli), so every agent absent from the registry — 84 of 116 active rows on the operator box — was EXECUTED through a CLI harness while this guard answered "not a CLI bot", skipped the ladder, and let assertAuditedAutonomousHarness hand the user its raw SEC-05 text (reproduced on email-bot a695dd5f-…). resolveGoverningEntry now mirrors the executor's two-step lookup, so both entry points resolve a brain for exactly the agents that will need one. The refusal itself, demoOperatorCliUnlock, and the node path are untouched — this closes a guard gap, it does not widen what may execute.
 * 12 | maintainer@emeraldcoastsystemsgroup.com  | Refuse inline specialist dispatch until that transport can carry the required bounded package context.
 * 13 | maintainer@emeraldcoastsystemsgroup.com  | ONE bot-invocation chokepoint, the INLINE half (BACKLOG "One bot-invocation chokepoint - the INLINE half of /api/send-message"): the admission gates executeBotOrInline applied inline in its own body - specialist-context, the two credential-carrier refusals and the cost-governance HARD cap - are extracted into the exported assertBotInvocationAdmissible so a caller that CANNOT take this function's bot-node request shape (message-routes' inline branch carries a ticketContext and an interactionMode BotNodeRequest has no room for) clears the same decision instead of no decision at all. Behaviour here is byte-identical except the budget refusal is now the typed BudgetBlockedError (same message, code budget_cap_exceeded, statusCode 402) so a route can say WHY rather than 500. Entitlement stays asserted by each caller - one assert, one audit line. Guard: tests/unit/send-message-budget-gate.spec.ts.
 * 14 | maintainer@emeraldcoastsystemsgroup.com  | Bounded SAME-endpoint retry for an explicitly chosen BYO turn (operator decision 2026-09-22). The inline branch previously had exactly two outcomes for a provider wall: rotate to another lane, or surface the error - and rotation is permanently refused for an explicit BYO endpoint, so those turns got NO retry at all and an intermittently tripping provider spend cap cost the whole turn. isExplicitByoTurn names the two shapes of explicit choice (caller-threaded connection, or a ladder resolution whose top rung was the user own BYO row) and the first attempt is wrapped in runWithSameEndpointRetry, which replays the SAME URL/key/account under an attempt, backoff and wall-clock bound. The rotation legs below are untouched, resolver-owned lanes are not wrapped (rotating beats waiting out a backoff on a known-walled lane), and the wrapper reads swallowedTurnFailure so it sees the resolved-failure shape the agentic loop produces.
 * 15 | maintainer@emeraldcoastsystemsgroup.com  | Reworked after review refuted seq 14 on two counts, and extended with the operator's hot fallback (2026-09-22). (a) "caller-threaded means explicit" was FALSE: jarvis-orchestrator threads free-tier/platform/operator-key lanes as byoLlmConnection too, so every Jarvis hosted turn — free-tier users included — took 3 attempts before Jarvis's own rotation. isExplicitByoTurn now keys on resolutionSource === 'explicit' ONLY, carried on the request as byoLlmResolutionSource by the caller that resolved it; a threaded connection with no source gets one attempt. (b) Wrapping processMessage replayed the WHOLE turn — three saved user messages, three error broadcasts. The retry now rides options.byoLlmRetry into the orchestrator, which wraps the provider call. (c) runInlineTurnWithRecovery is the ONE inline turn body both entry points share: first attempt → rotation for resolver-owned lanes → the operator-only, readiness-gated hot fallback (byo-hot-fallback.ts) for an exhausted explicit endpoint; the remote branch recovers the same way by re-dispatching once per ready rung with the rung stamped as the authoritative provider. A fallback turn returns the brainFallback marker.
 * 16 | maintainer@emeraldcoastsystemsgroup.com  | Mark a resolved CLI brain as required provider authority so protected direct bot execution can verify the controller's stamp instead of rejecting a present provider as unconfigured.
 * 17 | maintainer@emeraldcoastsystemsgroup.com  | Honor the explicit `bot-default` user choice on remote turns by stamping the SAME canonical runtime record queued dispatch uses (per-bot switch > fleet switch > agent_config > registry), with required authority. Existing explicit provider/BYO choices and the `auto` user ladder are unchanged.
 * 18 | maintainer@emeraldcoastsystemsgroup.com  | Replace, rather than merge, the authoritative config slice for `bot-default`: a model-only incoming request could otherwise retain stale model/version/fallback fields when the canonical bot record omitted them.
 * 19 | maintainer@emeraldcoastsystemsgroup.com  | Resolve explicit `bot-default` strictly and enforce the same SEC-05 autonomous-CLI boundary as the node: a safe hosted canonical record is stamped, an unavailable or guest-ineligible CLI record degrades to the caller's hosted ladder, and resolver outages remain retryable instead of becoming a deterministic no-brain refusal.
 * 20 | maintainer@emeraldcoastsystemsgroup.com  | Treat every dedicated bot-node default as an autonomous-runtime choice, not the raw provider spelling: catalog API ids such as Gemini reconcile to Cline on the worker. A non-carved caller (including a user whose old saved choice outlives the carve) now falls to hosted before canonical resolution; the demo operator retains the per-bot record.
 * 21 | maintainer@emeraldcoastsystemsgroup.com | Bind protected inline responses and their stream events to durable controller-owned execution lineage before release.
 * 22 | maintainer@emeraldcoastsystemsgroup.com | Concierge node route. The ~24 inline app concierges answered NO_HOSTED_BRAIN for the deployment operator whenever the hosted lane was off, because an inline turn can never run the operator's CLI login (SEC-05 refuses every controller CLI). resolveBotDispatchRoute decides each turn's transport once: the bot's own node (dedicated), the concierge node (an interactive turn by the carved operator whose resolved brain is an Antigravity CLI login, to an inline app bot, with no explicit BYO/provider/credential choice, while OSHAL_CONCIERGE_NODE_URL is set and the node's health check passes), or the existing inline path. executeBotOrInline takes an optional precomputed route; admission is unchanged; a concierge turn stamps the already-resolved brain through stampRemoteBrain, makes a protected bot non-agentic, and runs through the same remote recovery and cost settlement as a dedicated node (the protected persona rides BotNodeClient's existing botPersona carrier). An inline turn whose concierge was unhealthy and whose hosted ladder is empty refuses with NoHostedBrainError detail concierge_node_unavailable, which the chat routes include in the 422 body.
 */

import type { AppContext } from '@/app/composition/app-context';
import { canonicalBotWorkspaceId } from '@/app/bot-node-request-scope';
import {
  BotNodeClient,
  createConciergeEndpointResolver,
  normalizeConciergeNodeUrl,
  resolveRequiredDispatchConfigFields,
  type BotNodeRequest,
  type BotNodeResponse,
  type BrainFallbackMarker,
  type RuntimeParamsResolver,
} from '@/features/agent-management';
import type { ProcessResult, TaskUsageSummary } from '@/shared/types';
import { createChildLogger } from '@/shared/logger';
import { BudgetService, type BudgetDecision } from '@/features/cost-governance';
import { isUnbrokeredAutonomousProvider } from '@/features/llm-provider';
import { composeSkillProfilePrompt, resolveSkillProfileByApp } from '@/shared/skill-profiles';
import { assertExecuteEntitlement } from '@/app/bot-node-execute-entitlement';
import { reportResolvedLlmFailure, resolveUserLlmConnection, type ResolvedUserLlmConnection } from './free-tier-rotation';
import { explainInlineFallbackMiss, planInlineHotFallback, recoverExplicitByoWall } from './byo-hot-fallback';
import type { ByoHostedFallbackRung } from '@/features/llm-provider';
import { cliBrainAvailable, resolveUserBrain, type ResolvedBrain } from './user-brain-resolution';
import type { ByoLlmConnection } from './byo-llm-routes';
import { getSpecialistContextRegistry, SpecialistContextError } from '@/shared/specialist-context';
import { runProtectedInlineTurn } from './protected-inline-execution';
import { isApplicationExecutionProtected } from '@/shared/application-authorization-execution';
import { isProtectedAgent } from '@/shared/protected-results';

const logger = createChildLogger({ module: 'inline-bot-execution' });

/**
 * @description Thrown when a turn targets a CLI-harness bot but the caller has NO hosted
 * brain anywhere on the user-brain ladder (ADR-127). The message is the user-facing answer —
 * it names Settings → AI Providers instead of surfacing the raw SEC-05 refusal.
 */
export class NoHostedBrainError extends Error {
  /** Machine code the chat routes branch on. */
  readonly code = 'NO_HOSTED_BRAIN';

  /** Why the turn had no brain beyond an empty ladder, when that is known (`concierge_node_unavailable`). */
  readonly detail?: string;

  constructor(detail?: string) {
    super(
      'No AI engine is connected for this account, so this assistant cannot answer yet. '
      + 'Open Settings → AI Providers to connect a hosted provider or add your own endpoint, then try again.',
    );
    this.name = 'NoHostedBrainError';
    if (detail) this.detail = detail;
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
  /** Registry bot name — the key the process `BOT_NAME` fallback matches on. See
   *  {@link resolveGoverningEntry}; provider-runtime's executor reads the same field. */
  name?: string;
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
  /** Full-ladder override for remote-stamp tests; production always walks resolveUserBrain. */
  resolveBrain?: (pool: AppContext['pool'], userSub: string) => Promise<ResolvedBrain>;
  /** Canonical per-bot > fleet > agent_config > registry resolver for `bot-default`. */
  runtimeParamsResolver?: RuntimeParamsResolver;
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
 * @description Resolves the registry entry that will ACTUALLY govern this agent's execution —
 * the same two-step provider-runtime's `resolveHarnessForAgent` uses: match the explicit
 * registry agentId, else fall back to the entry named by the process `BOT_NAME`/`AGENT_ID`.
 *
 * The fallback is not optional detail. The controller runs with `BOT_NAME=project-manager`
 * (harness `codex-cli`), so every agent absent from the registry — 84 of 116 active rows on
 * the 2026-08-13 operator box — is executed through project-manager's CLI harness. Resolving
 * the brain off `agentId` alone made this function answer "no CLI harness here" for exactly
 * those agents, so the ladder never ran and `assertAuditedAutonomousHarness` threw its raw
 * SEC-05 text at the user (reproduced live on email-bot a695dd5f-…). One resolution, used by
 * both the executor and this guard, is what keeps them from disagreeing again.
 * @param agentId - The target bot's agent UUID.
 * @param registry - The active registry entries to consult.
 * @returns The governing entry, or undefined when neither lookup matches.
 */
function resolveGoverningEntry(
  agentId: string,
  registry: ReadonlyArray<RegistryHarnessFacts>,
): RegistryHarnessFacts | undefined {
  const botName = process.env.BOT_NAME?.trim() || process.env.AGENT_ID?.trim();
  return registry.find((bot) => bot.agentId === agentId)
    ?? (botName ? registry.find((bot) => bot.name === botName) : undefined);
}

/**
 * @description Whether the harness that will actually run this agent is one the controller
 * refuses to run unattended (the unbrokered CLI set) — i.e. whether a controller-side turn for
 * it NEEDS a hosted brain. Pure over the supplied entries (plus the same `BOT_NAME` env the
 * executor reads) so both entry points and the guard specs share one condition with no hidden
 * loader state.
 * @param agentId - The target bot's agent UUID.
 * @param registry - The active registry entries to consult.
 * @returns True when the governing harness is an unbrokered autonomous CLI.
 */
export function agentRequiresHostedBrain(
  agentId: string,
  registry: ReadonlyArray<RegistryHarnessFacts>,
): boolean {
  const entry = resolveGoverningEntry(agentId, registry);
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
 * @description The REMOTE-branch half of ADR-127: a dedicated-node dispatch for a CLI-harness bot
 * carries the caller's resolved brain. Unlike the inline branch (hosted rungs only — SEC-05
 * refuses every controller CLI unconditionally), a node dispatch walks the FULL user-brain
 * ladder: a `cli` result is STAMPED as the dispatch's authoritative provider (ADR-034) — the demo
 * operator's mounted login, which the node's own preflight re-enforces under the SAME carve — and
 * a `hosted` result rides as byoLlmConnection (guests and every non-carve caller). A
 * caller-threaded connection or provider stamp always wins untouched; identity-less dispatches
 * and hosted-harness nodes pass through unchanged. Ladder FAILURE (not "no brain") dispatches
 * unstamped — the node's registry default governs, the exact pre-feature behaviour.
 * @param pool - pg pool for the ladder's per-user reads.
 * @param agentId - The target bot's agent UUID.
 * @param request - The dispatch about to ride to the node; stamped in place.
 * @param overrides - Injectable seams for guard specs only.
 * @throws NoHostedBrainError when a CLI-harness node's non-carve caller has nothing on the
 *   ladder — the honest Settings answer, never the node's raw SEC-05 refusal.
 */
export async function stampRemoteBrain(
  pool: AppContext['pool'],
  agentId: string,
  request: BotNodeRequest,
  overrides?: HostedBrainResolutionOverrides,
): Promise<void> {
  if (request.byoLlmConnection || request.providerId) return; // the caller's explicit choice wins
  if (!request.userSub) return; // internal/swarm dispatches behave exactly as before
  const registry = overrides?.loadRegistry ? overrides.loadRegistry() : await defaultLoadSwarmRegistry();
  if (!agentRequiresHostedBrain(agentId, registry)) return; // hosted-harness nodes keep their own provider
  let brain: ResolvedBrain;
  try {
    brain = overrides?.resolveBrain
      ? await overrides.resolveBrain(pool, request.userSub)
      : await resolveUserBrain(pool, request.userSub);
  } catch (err) {
    logger.warn({ err, agentId }, 'remote-brain stamp: ladder failed — dispatching unstamped');
    return;
  }
  if (brain.kind === 'cli') {
    request.providerId = brain.providerId;
    if (brain.model) request.model = brain.model;
    request.providerConfigRequired = true;
    logger.info({ agentId, providerId: brain.providerId }, 'remote-brain stamp: CLI brain stamped as the authoritative dispatch provider');
    return;
  }
  if (brain.kind === 'bot-default') {
    const callerMayUseBotDefault = cliBrainAvailable(request.userSub);
    if (!callerMayUseBotDefault) {
      for (const field of ['providerId', 'model', 'configVersion', 'fallbackOrder', 'providerConfigRequired'] as const) {
        delete request[field];
      }
      const connection = overrides?.resolveConnection
        ? await overrides.resolveConnection(pool, request.userSub)
        : await resolveUserLlmConnection(pool, request.userSub);
      if (!connection) {
        logger.warn({ agentId }, 'remote-brain stamp: bot-default is unavailable to this caller and the hosted ladder is empty');
        throw new NoHostedBrainError();
      }
      request.byoLlmConnection = hostedBrainWire(connection);
      logger.info(
        { agentId, hostedModel: connection.model },
        'remote-brain stamp: bot-default is unavailable to this caller — using the hosted ladder',
      );
      return;
    }
    // A named preference is not the legacy push-on-dispatch best-effort path. Preserve an
    // operational resolver failure so the caller can retry it, and distinguish it from an
    // honest absent record, which can safely degrade to the user's hosted ladder.
    const configFields = await resolveRequiredDispatchConfigFields(overrides?.runtimeParamsResolver, agentId);
    for (const field of ['providerId', 'model', 'configVersion', 'fallbackOrder', 'providerConfigRequired'] as const) {
      delete request[field];
    }
    const canonicalProvider = configFields?.providerId?.trim();
    if (!canonicalProvider) {
      const connection = overrides?.resolveConnection
        ? await overrides.resolveConnection(pool, request.userSub)
        : await resolveUserLlmConnection(pool, request.userSub);
      if (!connection) {
        logger.warn(
          { agentId, providerId: canonicalProvider ?? null },
          'remote-brain stamp: bot-default is absent or unavailable to this caller and the hosted ladder is empty',
        );
        throw new NoHostedBrainError();
      }
      request.byoLlmConnection = hostedBrainWire(connection);
      logger.info(
        { agentId, providerId: canonicalProvider ?? null, hostedModel: connection.model },
        'remote-brain stamp: bot-default is absent or unavailable to this caller — using the hosted ladder',
      );
      return;
    }
    Object.assign(request, configFields);
    request.providerConfigRequired = true;
    logger.info(
      {
        agentId,
        providerId: request.providerId ?? null,
        model: request.model ?? null,
        configVersion: request.configVersion ?? null,
      },
      'remote-brain stamp: bot-default resolved as the authoritative admin/runtime record',
    );
    return;
  }
  if (brain.kind === 'hosted') {
    request.byoLlmConnection = hostedBrainWire(brain.connection as ByoLlmConnection);
    logger.info({ agentId, model: brain.connection.model }, 'remote-brain stamp: hosted brain rides as byoLlmConnection');
    return;
  }
  logger.warn({ agentId }, 'remote-brain stamp: nothing on the ladder — refusing with NO_HOSTED_BRAIN');
  throw new NoHostedBrainError();
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
  if (!shouldRetry) {
    // Every declined retry names its reason — a silent early return here cost the live
    // diagnosis of the same-lane trap (2026-08-11).
    logger.info({ agentId, failedModel: first.model }, 'hosted-brain retry: failure is not a provider wall (or the connection is caller-owned) — surfacing the original error');
    return null;
  }
  let second: ByoLlmConnection | undefined;
  try {
    second = await resolveHostedBrainMeta(pool, agentId, userSub, overrides);
  } catch {
    logger.info({ agentId, failedModel: first.model }, 'hosted-brain retry: the ladder is empty after cooling the lane — surfacing the original error');
    return null; // the ladder is now empty (NoHostedBrainError) — surface the ORIGINAL failure
  }
  if (!second || (second.baseUrl === first.baseUrl && second.model === first.model)) {
    logger.info(
      { agentId, failedModel: first.model, reResolvedModel: second?.model ?? null },
      'hosted-brain retry: re-resolution returned the same lane (or none) — a replay would reproduce the wall; surfacing the original error',
    );
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
 * @description True when the endpoint this turn runs on was EXPLICITLY chosen by the user — the
 * ladder's top rung, their own saved BYO row (`resolutionSource: 'explicit'`) — and nothing else.
 * Two carriers of that one fact: a caller that resolved the ladder itself and threaded the wire
 * trio says so with `byoLlmResolutionSource` on the request (jarvis-orchestrator); an entry point
 * that resolved the ladder here reads it off the resolved connection's metadata.
 *
 * A threaded connection with NO source is not explicit. The first build treated every threaded
 * connection as explicit, and jarvis-orchestrator threads free-tier, platform and operator-key
 * lanes the same way, so every Jarvis hosted turn — free-tier users included — paid three
 * attempts and a backoff before Jarvis's own rotation. A resolver-owned lane rotates; it does not
 * wait out a backoff on a lane already known to be walled.
 *
 * It is the condition for the bounded SAME-endpoint retry and for the operator's hot fallback.
 * Rotation for these turns stays refused by `reportResolvedLlmFailure`, which is the boundary.
 * @param request - The request facts: the threaded connection and the source its caller declared.
 * @param resolved - The ladder-resolved connection (with metadata), if this entry point resolved it.
 * @returns Whether this turn is running on an explicitly chosen endpoint.
 */
export function isExplicitByoTurn(
  request: Pick<BotNodeRequest, 'byoLlmConnection' | 'byoLlmResolutionSource'> | undefined,
  resolved: ByoLlmConnection | undefined,
): boolean {
  if (request?.byoLlmConnection) return request.byoLlmResolutionSource === 'explicit';
  return (resolved as ResolvedUserLlmConnection | undefined)?.resolutionSource === 'explicit';
}

/** The per-attempt options the shared inline turn body hands the entry point's runner. */
export interface InlineTurnOptions {
  /** Ask the orchestrator to replay a retryable wall against the same endpoint at the model call. */
  byoLlmRetry: boolean;
  /** The operator's READY hot-fallback rungs for this turn, if the fallback applies. */
  byoLlmFallback?: ByoHostedFallbackRung[];
}

/** What the shared inline turn body needs from an entry point. */
export interface InlineTurnRecoveryInput {
  pool: AppContext['pool'];
  agentId: string;
  userSub: string | undefined;
  /** The ladder-resolved connection WITH metadata (rotation needs it), when this entry point resolved one. */
  resolvedBrain: ByoLlmConnection | undefined;
  /** The wire trio the first attempt runs on (caller-threaded, or the ladder's pick stripped). */
  firstEndpoint: ByoLlmConnection | undefined;
  /** Whether that endpoint was explicitly chosen — the retry and the hot fallback key on this. */
  explicit: boolean;
  /** Runs one orchestrator turn on a connection with the given per-attempt options. */
  runTurn: (connection: ByoLlmConnection | undefined, turn: InlineTurnOptions) => Promise<ProcessResult>;
}

/**
 * @description The ONE inline turn body both conversational entry points ride (executeBotOrInline
 * and the inline half of /api/send-message), so the three decisions around a provider wall are
 * made once and all of them at the model call, inside ONE orchestrator turn: (1) the first attempt
 * runs with the same-endpoint replay when the endpoint was explicitly chosen (options.byoLlmRetry —
 * the provider call replays; the turn's persistence and broadcast do not); (2) for the deployment
 * operator only, the ready hosted rungs of the configured chain ride along as options.byoLlmFallback
 * (planInlineHotFallback gates, resolves and probes them BEFORE the turn) and the orchestrator's
 * chain provider switches to the first that answers once the endpoint is exhausted — one saved user
 * message, one broadcast, the marker on the result; (3) a resolver-owned lane that walled rotates
 * once to the next lane (retryHostedBrainTurn), which refuses an explicit endpoint. An explicit
 * endpoint whose fallback applied and still got no answer surfaces ByoFallbackUnavailableError,
 * naming every rung's reason; anyone else gets the original failure.
 * @param input - The turn facts and the runner.
 * @returns The result, and the fallback marker when a rung answered.
 * @throws The original failure when nothing may recover it; ByoFallbackUnavailableError when the
 *   operator's fallback applied and no rung could answer.
 */
export async function runInlineTurnWithRecovery(
  input: InlineTurnRecoveryInput,
): Promise<{ result: ProcessResult; fallback?: BrainFallbackMarker }> {
  const plan = await planInlineHotFallback({ agentId: input.agentId, userSub: input.userSub, explicit: input.explicit });
  const firstAttempt: InlineTurnOptions = {
    byoLlmRetry: input.explicit,
    ...(plan.rungs.length ? { byoLlmFallback: plan.rungs } : {}),
  };
  let result: ProcessResult;
  try {
    result = await input.runTurn(input.firstEndpoint, firstAttempt);
  } catch (turnError) {
    // Turn-time failover: a lane that passed its resolution probe can hit its quota mid-turn
    // (Gemini free tier = 20/day). Cool the lane and replay ONCE on the next vendor.
    const nextLane = await retryHostedBrainTurn(input.pool, input.agentId, input.userSub, input.resolvedBrain, turnError);
    if (nextLane) return { result: await input.runTurn(nextLane, { byoLlmRetry: false }) };
    const failure = turnError instanceof Error ? turnError : new Error(String(turnError));
    throw explainInlineFallbackMiss(plan, failure, input.firstEndpoint) ?? turnError;
  }
  if (result.brainFallback) return { result, fallback: result.brainFallback };
  // The agentic loop catches provider errors internally and resolves with a failed result —
  // the catch above never sees those. Same failover, keyed off the result shape instead.
  const swallowed = swallowedTurnFailure(result);
  if (!swallowed) return { result };
  const nextLane = await retryHostedBrainTurn(input.pool, input.agentId, input.userSub, input.resolvedBrain, swallowed);
  if (nextLane) return { result: await input.runTurn(nextLane, { byoLlmRetry: false }) };
  const miss = explainInlineFallbackMiss(plan, swallowed, input.firstEndpoint);
  if (miss) throw miss;
  return { result };
}

/**
 * @description Thrown when cost governance definitively refuses an invocation — a HARD
 * daily cap exceeded, or the runaway kill switch. Typed (rather than the bare Error this
 * used to be) so a route can answer `402 budget_cap_exceeded` instead of an anonymous 500:
 * "you are over your cap" and "the server broke" are different facts and the cockpit has to
 * be able to tell them apart. The message text is unchanged from the untyped throw.
 */
export class BudgetBlockedError extends Error {
  /** Machine code callers branch on and routes return. */
  readonly code = 'budget_cap_exceeded';

  /** HTTP status the chat routes map this to — Payment Required, the cap is the reason. */
  readonly statusCode = 402;

  constructor(readonly verdict: BudgetDecision) {
    super(
      `Budget governance blocked execution (${verdict.reason}): spend $${verdict.spend?.toFixed(2)} >= cap $${verdict.cap}`,
    );
    this.name = 'BudgetBlockedError';
  }
}

/**
 * @description The facts an admission decision reads off an invocation. Structural (not the
 * full {@link BotNodeRequest}) so a caller that does NOT build a bot-node request — the
 * inline half of the chat route, which hands the controller orchestrator its own options
 * object — can still be admitted by exactly this function instead of a second copy of the
 * policy that drifts from it.
 */
export interface BotInvocationFacts {
  /** The accountable spend owner; null/undefined is an unscoped (swarm) invocation. */
  userSub?: string | null;
  /** Connector credentials riding the request, if any. */
  creds?: Record<string, string>;
  /** A validated deterministic provider intent, if any. */
  providerIntent?: unknown;
}

/**
 * @description The admission gates EVERY bot invocation must clear, in one definition.
 *
 * `executeBotOrInline` below is the chokepoint by construction, but not every caller can
 * route through it: the inline half of `POST /api/send-message` carries a ticketContext and
 * an interactionMode the bot-node request shape has no room for, so it calls the controller
 * orchestrator itself. Before this function existed, that branch cleared NO gate at all —
 * a user sitting on a tripped HARD cap kept spending through the cockpit chat panel for as
 * long as the bot they were talking to was controller-inline, which is most of the concierge
 * fleet. Sharing the decision (not re-implementing it) is what keeps the two from drifting.
 *
 * Execute-time entitlement is deliberately NOT here: both callers already assert it against
 * the same pure `decideExecuteEntitlement`, and asserting twice would double the audit line.
 *
 * @param ctx - App context; only the pg pool is read (for cost governance).
 * @param agentId - The target bot's agent UUID.
 * @param request - The invocation facts (owner sub, credential carriers).
 * @param hasDedicatedEndpoint - Whether this agent resolves to its own bot node.
 * @returns Nothing; it either admits the invocation or throws.
 * @throws SpecialistContextError when an inline transport cannot carry the bounded package
 *   context the target bot requires.
 * @throws Error `UNSCOPED_CREDENTIAL_CARRIER` / `PROVIDER_INTENT_REQUIRES_BOT_NODE` when
 *   connector credentials are not inside an audited deterministic provider intent on a node.
 * @throws BudgetBlockedError (statusCode 402) when a HARD cap is definitively exceeded.
 *   Fail-OPEN on infra gaps, per BudgetService semantics: an unreadable budgets table or a
 *   DB hiccup never blocks a turn.
 */
export async function assertBotInvocationAdmissible(
  ctx: Pick<AppContext, 'pool'>,
  agentId: string,
  request: BotInvocationFacts,
  hasDedicatedEndpoint: boolean,
): Promise<void> {
  const carriesCreds = Boolean(request.creds && Object.keys(request.creds).length > 0);
  if (!hasDedicatedEndpoint && getSpecialistContextRegistry()?.requires(agentId)) {
    throw new SpecialistContextError('specialist_context_requires_bot_node');
  }
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
  if (!verdict.allowed) throw new BudgetBlockedError(verdict);
}

/** The CLI brains a concierge node runs for an inline app bot; any other brain keeps the inline path. */
const CONCIERGE_CLI_PROVIDERS: ReadonlySet<string> = new Set(['antigravity-cli']);
/** How long one concierge health answer stands before the next turn probes again. */
const CONCIERGE_HEALTH_TTL_MS = 15_000;
/** The probe's own bound, so an unreachable node costs a turn at most this long. */
const CONCIERGE_HEALTH_TIMEOUT_MS = 2_000;

/** Reads the configured concierge node URL per call; blank or unset turns the route off. */
const conciergeNodeUrl = (): string | undefined => process.env.OSHAL_CONCIERGE_NODE_URL;

/** The concierge node transport: it resolves an inline app bot only, and only while the URL is set. */
const conciergeClient = new BotNodeClient(createConciergeEndpointResolver(conciergeNodeUrl));

/** The last health answer per concierge base URL. */
const conciergeHealth = new Map<string, { healthy: boolean; checkedAt: number }>();

/**
 * @description The transport one bot turn takes, decided once per turn by {@link resolveBotDispatchRoute}.
 * `dedicated`: the bot's own node. `concierge`: the concierge node, carrying the brain already resolved
 * for the caller and the client that reaches it. `inline`: the controller orchestrator, noting when a
 * concierge turn was eligible but its node failed the health check.
 */
export type BotDispatchRoute =
  | { kind: 'dedicated' }
  | { kind: 'concierge'; brain: Extract<ResolvedBrain, { kind: 'cli' }>; client: BotNodeClient }
  | { kind: 'inline'; conciergeUnavailable?: boolean };

/** The request facts the route decision reads. Structural, so the chat route can pass what it has. */
export interface BotDispatchRouteFields {
  /** The accountable caller; absent means a system turn, which always stays where it is. */
  userSub?: string | null;
  /** True only for an interactive identity caller (seq-9 rule in message-routes, direct:true on node calls). */
  direct?: boolean;
  byoLlmConnection?: unknown;
  providerId?: string;
  creds?: Record<string, string>;
  providerIntent?: unknown;
}

const INLINE_ROUTE: BotDispatchRoute = Object.freeze({ kind: 'inline' as const });

/**
 * @description Decides which transport runs one bot turn. A bot with its own node keeps it. Every other
 * turn stays inline unless ALL of these hold, cheapest first: an interactive turn by a caller the
 * ADR-127 carve covers (synchronous, before any I/O); no caller-chosen BYO endpoint, provider stamp,
 * credential or provider intent; a concierge URL that resolves this bot (an inline app bot); a bot whose
 * governing harness needs a brain the controller cannot run; a resolved brain that is a CLI login the
 * concierge runs; and a concierge node that answers its health check (cached ~15 s). A failed check
 * keeps the turn inline and says so, so an empty hosted ladder can name the real cause.
 * @param ctx - App context; only the pool is read (the caller's brain preference).
 * @param botClient - The dedicated-node client of the calling route.
 * @param agentId - The target bot.
 * @param fields - The turn's caller and explicit-choice facts.
 * @param overrides - Registry and brain-ladder seams for guard specs only.
 * @returns The route; a ladder failure is logged and keeps the turn inline.
 */
export async function resolveBotDispatchRoute(
  ctx: Pick<AppContext, 'pool'>,
  botClient: BotNodeClient,
  agentId: string,
  fields: BotDispatchRouteFields,
  overrides?: Pick<HostedBrainResolutionOverrides, 'loadRegistry' | 'resolveBrain'>,
): Promise<BotDispatchRoute> {
  if (botClient.hasEndpoint(agentId)) return { kind: 'dedicated' };
  const userSub = fields.userSub;
  if (!userSub || fields.direct !== true || !cliBrainAvailable(userSub)) return INLINE_ROUTE;
  if (fields.byoLlmConnection != null || fields.providerId != null || fields.creds != null
    || fields.providerIntent != null) return INLINE_ROUTE;
  if (!conciergeClient.hasEndpoint(agentId)) return INLINE_ROUTE;
  const registry = overrides?.loadRegistry ? overrides.loadRegistry() : await defaultLoadSwarmRegistry();
  if (!agentRequiresHostedBrain(agentId, registry)) return INLINE_ROUTE;
  let brain: ResolvedBrain;
  try {
    brain = overrides?.resolveBrain ? await overrides.resolveBrain(ctx.pool, userSub) : await resolveUserBrain(ctx.pool, userSub);
  } catch (err) {
    logger.error({ err, agentId }, 'concierge route: brain resolution failed - the turn stays inline');
    return INLINE_ROUTE;
  }
  if (brain.kind !== 'cli' || !CONCIERGE_CLI_PROVIDERS.has(brain.providerId)) return INLINE_ROUTE;
  const base = normalizeConciergeNodeUrl(conciergeNodeUrl());
  if (!base || !(await conciergeNodeHealthy(base))) {
    logger.warn({ agentId }, 'concierge route: the concierge node is unavailable - the turn stays inline');
    return { kind: 'inline', conciergeUnavailable: true };
  }
  logger.info({ agentId, providerId: brain.providerId }, 'concierge route: inline app bot runs on the concierge node');
  return { kind: 'concierge', brain, client: conciergeClient };
}

/**
 * @description One bounded GET <base>/api/health, its answer cached for CONCIERGE_HEALTH_TTL_MS per
 * base URL so a burst of turns probes once. The node answers 503 there until its database has
 * answered, so a pool-less node is unhealthy here too.
 * @param base - The normalized concierge base URL.
 * @returns Whether the node answered 2xx within the probe's bound.
 */
async function conciergeNodeHealthy(base: string): Promise<boolean> {
  const cached = conciergeHealth.get(base);
  if (cached && Date.now() - cached.checkedAt < CONCIERGE_HEALTH_TTL_MS) return cached.healthy;
  let healthy = false;
  try {
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(CONCIERGE_HEALTH_TIMEOUT_MS) });
    healthy = response.ok;
    if (!healthy) logger.warn({ status: response.status }, 'concierge node health check answered non-2xx');
  } catch (err) {
    logger.error({ err }, 'concierge node health check failed');
  }
  conciergeHealth.set(base, { healthy, checkedAt: Date.now() });
  return healthy;
}

/**
 * @description The inline turn's hosted brain (resolveHostedBrainMeta), naming the concierge as the
 * cause when it is: a turn that was eligible for the concierge node but found it unhealthy, and then
 * found the hosted ladder empty too, refuses with detail `concierge_node_unavailable` so the 422 says
 * the node is down rather than only that no engine is connected.
 * @param pool - pg pool for the ladder's per-user reads.
 * @param agentId - The target bot.
 * @param userSub - The caller.
 * @param route - The turn's route, when one was decided.
 * @returns The full resolved connection, or undefined for no override.
 * @throws NoHostedBrainError, with the concierge detail when it applies.
 */
export async function resolveInlineHostedBrain(
  pool: AppContext['pool'],
  agentId: string,
  userSub: string | undefined,
  route?: BotDispatchRoute,
): Promise<ByoLlmConnection | undefined> {
  if (route?.kind !== 'inline' || route.conciergeUnavailable !== true) return resolveHostedBrainMeta(pool, agentId, userSub);
  try {
    return await resolveHostedBrainMeta(pool, agentId, userSub);
  } catch (err) {
    logger.error({ err, agentId }, 'inline hosted brain: no brain while the concierge node is unavailable');
    throw err instanceof NoHostedBrainError ? new NoHostedBrainError('concierge_node_unavailable') : err;
  }
}

/**
 * @description Executes a bot request on its remote any-bot node when one exists, on the concierge
 * node when {@link resolveBotDispatchRoute} sends an inline app bot there, and otherwise runs
 * controller-inline bots through the local orchestrator. Every path sits behind the cost-governance
 * budget gate: a HARD user-scope daily cap definitively exceeded throws before any LLM work starts
 * (fail-open on infra gaps — a missing budgets table or DB hiccup never blocks execution).
 * @param ctx - App context (pool + inline orchestrator).
 * @param botClient - Bot-node client used for remote any-bot execution.
 * @param agentId - The target bot's agent UUID.
 * @param request - The execution request (userSub is the accountable spend owner).
 * @param route - The route the caller already decided for this turn; resolved here when omitted.
 * @returns The bot-node response (remote or inline-normalized).
 * @throws CallerNotEntitledError (statusCode 403) in enforce mode when an interactive
 *   identity caller (userSub + direct:true) is not entitled to the target bot.
 */
export async function executeBotOrInline(
  ctx: AppContext,
  botClient: BotNodeClient,
  agentId: string,
  request: BotNodeRequest,
  route?: BotDispatchRoute,
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

  const hasDedicatedEndpoint = botClient.hasEndpoint(agentId);
  await assertBotInvocationAdmissible(ctx, agentId, request, hasDedicatedEndpoint);

  // ADR-090 skill-profile GENERAL carrier: resolve the calling app's domain profile for this
  // capability ONCE, controller-side (the bot holds no registry — ADR-036). Guarded on BOTH app +
  // capability, so every non-app call resolves to '' — an exact no-op. composeSkillProfilePrompt
  // returns '' when no app registered a profile for that capability. This generalizes email-routes'
  // hand-wired composition to ANY app's execute / inline-concierge path, keyed off the request.
  const skillPattern = request.app && request.capability
    ? composeSkillProfilePrompt('', request.capability, resolveSkillProfileByApp(request.app, request.capability))
    : '';

  const dispatch = route ?? await resolveBotDispatchRoute(ctx, botClient, agentId, request);
  if (dispatch.kind === 'concierge') return executeOnConcierge(ctx, agentId, request, skillPattern, dispatch);

  if (dispatch.kind === 'dedicated') {
    // Remote path: the resolved block rides to the bot node as request.pattern (→ envelope.payload).
    // The bot-node execution handler appends it to its assembled prompt in BOTH prompt branches —
    // the layered branch builds from persona layers + buildUserMessage, never from `text`, which is
    // exactly why weaving into `text` (as the inline path does) would never reach it there.
    if (skillPattern) request.pattern = skillPattern;
    // ADR-127 remote brain: stamp the caller's resolved brain on a CLI-harness node dispatch —
    // cli as the authoritative provider (the demo operator's mounted login), hosted riding as
    // byoLlmConnection. See stampRemoteBrain; explicit caller choices pass through untouched.
    await stampRemoteBrain(ctx.pool, agentId, request, {
      runtimeParamsResolver: ctx.swarm?.runtimeParamsResolver,
    });
    const remote = await executeRemoteWithRecovery(botClient, agentId, request);
    await settleBotNodeCostTask(ctx, agentId, request, remote);
    return remote;
  }

  return executeInlineBotWithRecovery(ctx, agentId, request, skillPattern, dispatch);
}

/**
 * @description Runs one turn of an inline app bot on the concierge node. Same shape as a dedicated-node
 * turn: the skill profile rides as request.pattern, the caller's brain is stamped as the authoritative
 * provider (stampRemoteBrain, handed the brain the route already resolved so the ladder is not walked
 * twice), and the node's cost task is joined to the thread's ticket. A protected bot is made
 * non-agentic because a protected node admits only direct configured reasoning; its persona rides
 * BotNodeClient's own signed botPersona carrier, so nothing here adds one.
 * @param ctx - App context.
 * @param agentId - The inline app bot.
 * @param request - The accountable request; stamped in place.
 * @param skillPattern - The calling application's resolved skill profile block, or ''.
 * @param route - The concierge route with its resolved brain and client.
 * @returns The node's response.
 */
async function executeOnConcierge(ctx: AppContext, agentId: string, request: BotNodeRequest, skillPattern: string,
  route: Extract<BotDispatchRoute, { kind: 'concierge' }>): Promise<BotNodeResponse> {
  if (skillPattern) request.pattern = skillPattern;
  if (await isApplicationExecutionProtected({ kind: 'bots', operation: agentId }) || await isProtectedAgent(agentId)) {
    request.agenticMode = false;
  }
  await stampRemoteBrain(ctx.pool, agentId, request, {
    resolveBrain: async () => route.brain,
    runtimeParamsResolver: ctx.swarm?.runtimeParamsResolver,
  });
  const remote = await executeRemoteWithRecovery(route.client, agentId, request);
  await settleBotNodeCostTask(ctx, agentId, request, remote);
  return remote;
}

/** @description Resolve the existing hosted lane and run one inline recovery turn under durable result authority.
 * @param ctx Controller stores/provider resolution. @param agentId Exact target. @param request Accountable request.
 * @param skillPattern Existing calling-application capability context.
 * @param route The decided route; an unavailable concierge names itself when the ladder is empty.
 * @returns Normalized completed bot response.
 */
async function executeInlineBotWithRecovery(ctx: AppContext, agentId: string, request: BotNodeRequest,
  skillPattern: string, route: BotDispatchRoute): Promise<BotNodeResponse> {
  const start = Date.now();
  const inlineText = skillPattern ? `${request.text}${skillPattern}` : request.text;
  // An explicit caller connection preserves its billing boundary; otherwise use the existing hosted ladder.
  const resolvedBrain = request.byoLlmConnection
    ? undefined
    : await resolveInlineHostedBrain(ctx.pool, agentId, request.userSub, route);
  const runTurn = (byoLlmConnection: typeof request.byoLlmConnection, turn: InlineTurnOptions) =>
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
      ...turn,
    } as any);
  const { result, fallback, applicationExecutionId } = await runProtectedInlineTurn(ctx, agentId,
    { taskId: request.taskId, workspaceId: request.workspaceFolderId, userSub: request.userSub }, () => runInlineTurnWithRecovery({
    pool: ctx.pool, agentId, userSub: request.userSub, resolvedBrain,
    firstEndpoint: request.byoLlmConnection ?? hostedBrainWire(resolvedBrain),
    explicit: isExplicitByoTurn(request, resolvedBrain),
    runTurn,
  }));

  if (!result.success) {
    throw new Error(`Inline bot execution failed: ${result.error || 'Unknown error'}`);
  }

  return inlineBotResponse(result, fallback, request, start, Boolean(request.byoLlmConnection || resolvedBrain), applicationExecutionId);
}

/** @description Retain the existing inline response, cost, model and fallback fields with trusted result lineage.
 * @param result Existing orchestrator result. @param fallback Hosted recovery marker. @param request Original request.
 * @param start Turn start time. @param hosted Whether the actual turn used a hosted lane.
 * @param applicationExecutionId Completed controller provenance. @returns Bot-node response shape.
 */
function inlineBotResponse(result: ProcessResult, fallback: BrainFallbackMarker | undefined, request: BotNodeRequest,
  start: number, hosted: boolean, applicationExecutionId?: string): BotNodeResponse {
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
    provider: fallback ? fallback.providerUsed : hosted ? 'byo-llm' : 'inline-orchestrator',
    durationMs: Date.now() - start,
    taskId: request.taskId,
    ...(applicationExecutionId ? { applicationExecutionId } : {}),
    ...(fallback ? { brainFallback: fallback } : {}),
  };
}

/**
 * @description The remote half of the same recovery: dispatch to the bot node, and when an
 * EXPLICITLY chosen endpoint the caller threaded refused with a capacity wall, re-dispatch once
 * per ready rung of the operator's configured chain with that rung stamped as the authoritative
 * provider (the node's own SEC-05 preflight re-enforces the demo+operator carve for a CLI rung;
 * a hosted rung runs there as the node's failover rung already does). The controller-side
 * `byoLlmResolutionSource` never travels to the node. Cost lands at the node under the rung, as
 * any turn on that rail would.
 *
 * The same-endpoint retry is NOT applied around the node call: the node runs its own provider
 * stack, and replaying the whole dispatch would re-run the node's turn — the exact "whole turn
 * per attempt" shape the inline path was reworked to avoid.
 * @param botClient - The node client.
 * @param agentId - The target bot.
 * @param request - The stamped dispatch.
 * @returns The node's response, with the fallback marker when a rung answered.
 */
async function executeRemoteWithRecovery(
  botClient: BotNodeClient,
  agentId: string,
  request: BotNodeRequest,
): Promise<BotNodeResponse> {
  const { byoLlmResolutionSource: _controllerOnly, ...wire } = request;
  try {
    return await botClient.execute(agentId, wire);
  } catch (dispatchError) {
    const failure = dispatchError instanceof Error ? dispatchError : new Error(String(dispatchError));
    const recovered = await recoverExplicitByoWall<BotNodeResponse>({
      agentId, userSub: request.userSub, explicit: isExplicitByoTurn(request, undefined),
      endpoint: request.byoLlmConnection, failure, botClient,
      executeRung: (rung) => botClient.execute(agentId, {
        ...wire, byoLlmConnection: undefined, providerId: rung.providerId, model: undefined,
      }),
    });
    if (!recovered) throw dispatchError;
    return { ...recovered.result, brainFallback: recovered.marker };
  }
}

/**
 * @description Joins the bot node's own cost task to the ticket the calling thread belongs to, and
 * stamps it terminal. CKR-19 part A.
 *
 * The bot node REWRITES the cost task id: it records every call under
 * `${canonicalBotWorkspaceId(workspaceFolderId)}::${agentId}`, while `ticket_task_links` holds the
 * THREAD's task id. Both rows are real - an `oshal_cost_events` row and a `chat_tasks` rollup are
 * written for every interactive call - but the trace join and the ticket/app budget joins both read
 * `ticket_task_links`, so neither could see the money. Measured on the box: 0 of 123 chat tickets
 * showed an llm-call span, and the ticket- and app-scoped spend caps were blind to interactive spend
 * entirely.
 *
 * The id is DERIVED here rather than read off the response, deliberately: `BotNodeResponse.taskId`
 * is whatever the node chose to echo, and trusting it would make a remote node the authority over
 * which ticket its spend lands on. The derivation mirrors bot-node-server.ts:369 (`workspaceTaskId =
 * canonicalBotWorkspaceId(body.workspaceFolderId)`) and the handler's `${workspaceFolderId}::${agentId}`.
 *
 * Two things it deliberately does NOT do. It never fails the execution - this is telemetry, and a
 * missing link must not lose a completed turn. And it links only to tickets the THREAD task already
 * belongs to, so it can add an attribution but never invent one.
 *
 * A PROTECTED application execution is the one case the derivation cannot cover: the handler uses
 * `protectedExecution.workspaceId` instead, which the controller does not hold here. Those calls are
 * left unlinked rather than linked to a guess.
 *
 * @param ctx - App context; only its pool is used.
 * @param agentId - Target bot, the second half of the sibling id.
 * @param request - The dispatched request; its taskId is the thread, its workspaceFolderId the scope.
 * @param response - The node's response, read only for the terminal status.
 * @returns Resolves when the link and status write have been attempted.
 */
async function settleBotNodeCostTask(
  ctx: AppContext,
  agentId: string,
  request: BotNodeRequest,
  response: BotNodeResponse,
): Promise<void> {
  if (!ctx.pool) return;
  let siblingTaskId: string;
  try {
    siblingTaskId = `${canonicalBotWorkspaceId(request.workspaceFolderId)}::${agentId}`;
  } catch {
    return; // an unusable workspace id is the node's problem to refuse, not ours to guess around
  }
  if (siblingTaskId === request.taskId) return; // nothing was rewritten; the existing link stands

  try {
    // One statement: for every ticket the thread's task is linked to, link the sibling too. The
    // chat_tasks EXISTS guard is load-bearing - task_id carries a foreign key, and the node writes
    // that row while it works, so a call that recorded no cost has no row to link.
    await ctx.pool.query(
      `INSERT INTO ticket_task_links (ticket_id, task_id, role)
       SELECT l.ticket_id, $2, 'swarm-execution'
         FROM ticket_task_links l
        WHERE l.task_id = $1
          AND EXISTS (SELECT 1 FROM chat_tasks c WHERE c.task_id = $2)
       ON CONFLICT DO NOTHING`,
      [request.taskId, siblingTaskId],
    );
    // persistCostEvent hard-codes 'processing' and nothing ever closed these, so they accumulated
    // as permanently in-progress tasks (683 of them before this landed, explicitly not backfilled).
    // Only a row still sitting in 'processing' is touched, so an operator or a later write wins.
    await ctx.pool.query(
      `UPDATE chat_tasks SET status = $2, updated_at = NOW()
        WHERE task_id = $1 AND status = 'processing'`,
      [siblingTaskId, response.success === false ? 'failed' : 'completed'],
    );
  } catch (error) {
    logger.warn(
      { err: error as Error, agentId, taskId: request.taskId, siblingTaskId },
      'Bot-node cost task could not be joined to its ticket - execution unaffected',
    );
  }
}

function firstUsageModel(usage?: TaskUsageSummary): string | null {
  const names = Object.keys(usage?.byModel ?? {});
  return names.length > 0 ? names[0] : null;
}
