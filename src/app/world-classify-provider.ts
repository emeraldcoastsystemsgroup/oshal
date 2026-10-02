/**
 * World classify on the swarm's accounted rail — the platform half of "the principle of one"
 * (operator decision 2026-09-21, BACKLOG "Seeding-repair hygiene tail" clause 3).
 *
 * The world index is a swarm service, so its classifier reasons the way every other swarm job does:
 * through `executeBotOrInline` to an accountable bot, on that bot's canonical provider record — the
 * swarm default when nothing names another one. The controller never builds a model provider of its
 * own for it. Before this module, news-fetcher.ts instantiated the Claude Code and Codex CLI providers
 * in the api process; SEC-05 refuses those unattended, so no item had been model-classified since
 * 2026-08-06 (every chunk fell back to lexicon and logged a warn, ~55 per pulse on 2026-10-02).
 *
 * WHOSE work it is (operator decision 2026-10-02). The world schedules are framework-scope and carry
 * no owner, and a bot node refuses an unbrokered CLI provider for a request with no owner — on
 * purpose (ADR-127: a DEMO deployment AND an operator-owned request). So every classify call carries
 * an accountable owner: `WORLD_CLASSIFY_OWNER_SUB`, defaulting on a DEMO box to the one configured
 * `OSHAL_OPERATOR_SUBS` entry. The signed bot-node hop also needs that owner's VERIFIED issuer (a
 * subject alone is not an identity: two providers can issue the same sub): `WORLD_CLASSIFY_OWNER_ISSUER`,
 * else the one active record the verified-principal directory holds for that subject — the issuer the
 * owner's own sign-in established. With no owner, or signing on and no verified issuer, nothing is
 * registered or dispatched: the world index classifies by lexicon and says so. No refusal is weakened.
 *
 * WHAT the turn may do. The classify prompt carries text fetched from the web, so the turn must hold no
 * tools. It is dispatched in the interactive shape (direct + agentic) that the node marks host-tools-only:
 * the CLI brain gets no native tools and the host loop brokers only the bot's granted tools. A CLI
 * provider with no tool-less mode is refused here before anything is sent. The classify instruction
 * rides the server-authored `pattern` channel; only the subject line and the contained items are `text`.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The world classify rail. resolveWorldClassifyOwner: the accountable owner and their verified issuer. createWorldClassifyProvider: one owned, direct, host-tools-only turn per chunk through executeBotOrInline to the classify bot (WORLD_CLASSIFY_BOT, default general-bot), stamped with that bot's canonical provider record (pushOnDispatchFields) unless WORLD_CLASSIFY_PROVIDER_ID / WORLD_CLASSIFY_MODEL name one, refused when the provider is a CLI with no tool-less mode, bounded by WORLD_CLASSIFY_CALL_TIMEOUT_MS. registerWorldClassifyRail / ensureWorldClassifyRail register it with news-fetcher, or leave the index on lexicon with one warning when there is no owner or no verified issuer for a signed hop.
 *
 * @module world-classify-provider
 */

import { randomUUID } from 'node:crypto';
import type { AppContext } from './composition-root';
import { BotNodeClient, createRegistryEndpointResolver, type BotNodeRequest } from '@/features/agent-management';
import { isUnbrokeredAutonomousProvider } from '@/features/llm-provider';
import { PrincipalDirectoryStore } from '@/features/principal-directory';
import { pushOnDispatchFields } from '@/features/swarm-orchestration';
import { configureWorldClassify, type ClassifyProvider } from '@/features/world-data';
import { demoModeEnabled, deploymentOperatorSubs } from '@/shared/deployment-mode';
import { createChildLogger } from '@/shared/logger';
import { normalizePrincipalIssuer } from '@/shared/middleware/principal-issuer';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { getActiveRegistry } from './extensions/swarm/swarm-bot-registry';
import { executeBotOrInline } from './routes/inline-bot-execution';

const logger = createChildLogger({ module: 'world-classify-provider' });
const defaultBotClient = new BotNodeClient(createRegistryEndpointResolver());

/** The kernel bot that classifies for the world index unless WORLD_CLASSIFY_BOT names another registered bot. */
export const WORLD_CLASSIFY_DEFAULT_BOT = 'general-bot';
/**
 * The unbrokered CLI providers that can run a turn with NO native tools (the node's host-tools-only
 * marker is honoured by the Antigravity provider alone). Any other unbrokered CLI is refused for
 * classification: fetched text is never handed to a CLI that holds tools of its own.
 */
export const WORLD_CLASSIFY_TOOLLESS_CLI_PROVIDERS: ReadonlySet<string> = new Set(['antigravity-cli']);
/** One chunk is a short JSON turn; a call that outlives this is abandoned (the chunk falls back to lexicon). */
const CALL_TIMEOUT_MS_DEFAULT = 120_000;
const CALL_TIMEOUT_MS_MIN = 10_000;
/** While the rail is not registered, how often a caller may re-check the owner and issuer. */
const ENSURE_RETRY_MS = 60_000;

/** @description The accountable owner of world classification and the issuer that verified them. */
export interface WorldClassifyOwner {
  /** The owner's exact subject. */
  sub: string;
  /** The verified issuer for that subject, or null when none is on record. */
  issuer: string | null;
}

/** @description What the operator may configure besides the owner: which bot, an explicit stamp, the call ceiling. */
export interface WorldClassifyOptions {
  /** Registered bot name that owns classification. */
  botName: string;
  /** Explicit provider the node reconciles onto; absent → the classify bot's canonical record (swarm default). */
  providerId?: string;
  /** Explicit model for that provider; absent → the provider's default. */
  model?: string;
  /** Per-call ceiling in milliseconds. */
  callTimeoutMs: number;
}

/** @description The provider fields a dispatch is stamped with. */
type ClassifyStamp = Pick<BotNodeRequest, 'providerId' | 'model' | 'configVersion' | 'providerConfigRequired'>;

/** @description Test seams. Runtime callers omit them. */
export interface WorldClassifyDeps {
  /** The chokepoint. */
  execute?: typeof executeBotOrInline;
  /** The active registry read. */
  registry?: typeof getActiveRegistry;
  /** The node client (endpoint lookup, signing posture, the signed hop). */
  botClient?: BotNodeClient;
  /** The classify bot's canonical provider record. */
  canonicalStamp?: (agentId: string) => Promise<ClassifyStamp>;
  /** The active verified issuers on record for a subject. */
  verifiedIssuers?: (sub: string) => Promise<string[]>;
}

const trimmed = (value: string | undefined): string => String(value || '').trim();

/**
 * @description The subject that owns world classification. An explicit `WORLD_CLASSIFY_OWNER_SUB`
 * wins. Otherwise, on a DEMO deployment with exactly ONE configured operator subject, that operator —
 * the person whose swarm this is; with none or several there is no unambiguous owner and none is guessed.
 * @param env - Environment to read.
 * @returns The owner's subject, or undefined when there is none.
 */
export function worldClassifyOwnerSub(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = trimmed(env.WORLD_CLASSIFY_OWNER_SUB);
  if (explicit) return explicit;
  if (!demoModeEnabled(env)) return undefined;
  const operators = deploymentOperatorSubs(env);
  return operators.length === 1 ? operators[0] : undefined;
}

/** The active verified issuers the principal directory holds for one subject (control-plane read). */
async function directoryIssuers(ctx: AppContext, sub: string): Promise<string[]> {
  const principals = await new PrincipalDirectoryStore(ctx.pool).list();
  return [...new Set(principals.filter((p) => p.sub === sub && p.status === 'active').map((p) => p.issuer))];
}

/**
 * @description Resolve the accountable owner AND the issuer that verified them. The issuer is
 * `WORLD_CLASSIFY_OWNER_ISSUER` when configured with the subject; otherwise the single active record
 * the verified-principal directory holds for that subject (what the owner's own sign-in established).
 * Several records, none, or an unreadable directory yield a null issuer — never a guessed one.
 * @param ctx - App context (control-plane pool for the directory read).
 * @param env - Environment to read.
 * @param deps - Test seam for the directory read.
 * @returns The owner, or undefined when no subject owns classification.
 */
export async function resolveWorldClassifyOwner(
  ctx: AppContext, env: NodeJS.ProcessEnv = process.env, deps: WorldClassifyDeps = {},
): Promise<WorldClassifyOwner | undefined> {
  const sub = worldClassifyOwnerSub(env);
  if (!sub) return undefined;
  const explicit = normalizePrincipalIssuer(env.WORLD_CLASSIFY_OWNER_ISSUER);
  if (explicit) return { sub, issuer: explicit };
  try {
    const issuers = await (deps.verifiedIssuers ?? ((s: string) => directoryIssuers(ctx, s)))(sub);
    return { sub, issuer: issuers.length === 1 ? issuers[0] : null };
  } catch (err) {
    logger.error({ err }, 'world classify: the verified-principal directory could not be read for the owner');
    return { sub, issuer: null };
  }
}

/**
 * @description Read the world classify configuration from the environment. `WORLD_CLASSIFY_PROVIDERS`
 * (the retired controller-CLI list) is deliberately not read here: an operator who still sets it is
 * told once by news-fetcher that it no longer selects anything.
 * @param env - Environment to read.
 * @returns The bot name (default general-bot), any explicit stamp and the call ceiling.
 */
export function worldClassifyOptions(env: NodeJS.ProcessEnv = process.env): WorldClassifyOptions {
  const providerId = trimmed(env.WORLD_CLASSIFY_PROVIDER_ID) || undefined;
  const model = trimmed(env.WORLD_CLASSIFY_MODEL) || undefined;
  const parsedTimeout = Number(env.WORLD_CLASSIFY_CALL_TIMEOUT_MS);
  const callTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout >= CALL_TIMEOUT_MS_MIN ? Math.floor(parsedTimeout) : CALL_TIMEOUT_MS_DEFAULT;
  return {
    botName: trimmed(env.WORLD_CLASSIFY_BOT) || WORLD_CLASSIFY_DEFAULT_BOT,
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
    callTimeoutMs,
  };
}

/** Reject after `ms` so one hung node call cannot hold a pulse; the abandoned call settles on its own. */
function withCallTimeout<T>(work: Promise<T>, ms: number, taskId: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`world classify: ${taskId} exceeded ${ms}ms`)), ms);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error as Error); });
  });
}

/**
 * The provider record this dispatch is stamped with: the operator's explicit choice, else the classify
 * bot's canonical record. Refused when it names no provider (the node could not be held to one) or a
 * CLI provider that has no tool-less mode.
 */
async function classifyStamp(
  ctx: AppContext, agentId: string, options: WorldClassifyOptions, deps: WorldClassifyDeps,
): Promise<ClassifyStamp> {
  const stamp: ClassifyStamp = options.providerId
    ? { providerId: options.providerId, ...(options.model ? { model: options.model } : {}) }
    : await (deps.canonicalStamp ?? ((id: string) => pushOnDispatchFields(ctx.swarm?.runtimeParamsResolver, id)))(agentId);
  const providerId = trimmed(stamp.providerId).toLowerCase();
  if (!providerId) throw new Error(`world classify: no provider record resolves for ${options.botName}; nothing is dispatched unstamped`);
  if (isUnbrokeredAutonomousProvider(providerId) && !WORLD_CLASSIFY_TOOLLESS_CLI_PROVIDERS.has(providerId)) {
    throw new Error(`world classify: ${providerId} has no tool-less mode; fetched text is never handed to a CLI that holds native tools`);
  }
  return stamp;
}

/**
 * @description Build the platform's classify backend. Every chunk is one turn to the classify bot
 * through the chokepoint every bot call uses: owned by `owner` (subject and verified issuer, under that
 * owner's request identity), in the interactive shape the node runs host-tools-only, stamped with the
 * bot's canonical provider record, with the instruction on the server-authored `pattern` channel when
 * the bot has its own node. A bot that is not in the active registry, a provider that cannot run
 * tool-less, a turn that does not complete or one that outlives the call ceiling throws — analyzeChunk
 * contains that per chunk (lexicon fallback).
 * @param ctx - App context (pool for the budget gate; swarm runtime for the canonical record).
 * @param owner - The accountable owner every call carries.
 * @param options - Bot name, optional stamp and call ceiling.
 * @param deps - Test seams.
 * @returns A ClassifyProvider named `swarm:<bot>`.
 */
export function createWorldClassifyProvider(
  ctx: AppContext,
  owner: WorldClassifyOwner,
  options: WorldClassifyOptions = worldClassifyOptions(),
  deps: WorldClassifyDeps = {},
): ClassifyProvider {
  const execute = deps.execute ?? executeBotOrInline;
  const registry = deps.registry ?? getActiveRegistry;
  const client = deps.botClient ?? defaultBotClient;
  return {
    name: `swarm:${options.botName}`,
    async complete(prompt: string, systemPrompt?: string): Promise<{ text: string }> {
      const bot = registry().find((b) => b.name === options.botName);
      if (!bot?.agentId) throw new Error(`world classify: bot "${options.botName}" is not in the active registry`);
      const agentId = bot.agentId;
      const stamp = await classifyStamp(ctx, agentId, options, deps);
      // A node takes the instruction as the trusted pattern block and wraps `text` as data; an inline
      // bot has no pattern channel, so there the instruction leads the text.
      const onNode = client.hasEndpoint(agentId);
      const taskId = `world-classify-${randomUUID()}`;
      const started = Date.now();
      const request: BotNodeRequest = {
        text: systemPrompt && !onNode ? `${systemPrompt}\n\n${prompt}` : prompt,
        ...(systemPrompt && onNode ? { pattern: systemPrompt } : {}),
        taskId,
        workspaceFolderId: taskId,
        agentId,
        agenticMode: true,
        direct: true,
        userSub: owner.sub,
        ...(owner.issuer ? { principalIssuer: owner.issuer } : {}),
        ...stamp,
      };
      const result = await runWithRequestIdentity(
        { sub: owner.sub, principalIssuer: owner.issuer, isOperator: false },
        () => withCallTimeout(execute(ctx, client, agentId, request), options.callTimeoutMs, taskId),
      );
      if (!result.success) throw new Error(`world classify: ${options.botName} did not complete the chunk`);
      logger.debug({ taskId, bot: options.botName, provider: result.provider, model: result.model, durationMs: Date.now() - started }, 'world classify chunk completed on the bot rail');
      return { text: String(result.response || '') };
    },
  };
}

/**
 * @description Register the platform backend with news-fetcher. Registered only when there is an
 * accountable owner and — when the bot-node hop is signed — a verified issuer for that owner. Otherwise
 * nothing is registered and the reason is returned: the world index then classifies by lexicon
 * (sentiment only, no entities or catalysts).
 * @param ctx - App context the provider dispatches with.
 * @param env - Environment to read.
 * @param deps - Test seams.
 * @returns `registered`, or the reason the rail was left unregistered.
 */
export async function registerWorldClassifyRail(
  ctx: AppContext, env: NodeJS.ProcessEnv = process.env, deps: WorldClassifyDeps = {},
): Promise<'registered' | 'no-owner' | 'no-verified-issuer'> {
  const options = worldClassifyOptions(env);
  const owner = await resolveWorldClassifyOwner(ctx, env, deps);
  if (!owner) {
    configureWorldClassify([]);
    return 'no-owner';
  }
  if ((deps.botClient ?? defaultBotClient).isDelegationEnforced() && !owner.issuer) {
    configureWorldClassify([]);
    return 'no-verified-issuer';
  }
  configureWorldClassify([createWorldClassifyProvider(ctx, owner, options, deps)]);
  logger.info({
    bot: options.botName, provider: options.providerId ?? 'bot canonical record (swarm default)', model: options.model ?? null,
    ownerIssuerVerified: Boolean(owner.issuer), callTimeoutMs: options.callTimeoutMs,
  }, 'world classify registered on the swarm bot rail');
  return 'registered';
}

const UNREGISTERED_REASON = {
  'no-owner': 'world classify has no accountable owner (set WORLD_CLASSIFY_OWNER_SUB; a DEMO box with exactly one OSHAL_OPERATOR_SUBS entry defaults to it) — the world index classifies by lexicon only',
  'no-verified-issuer': 'world classify: the bot-node hop is signed and no single verified issuer is on record for the owner (set WORLD_CLASSIFY_OWNER_ISSUER, or have the owner sign in once) — the world index classifies by lexicon only',
} as const;
let railRegistered = false;
let lastEnsureAt = 0;
let unregisteredWarned = false;

/**
 * @description Make sure the world classify rail is registered. Called at boot (so the World package's
 * own ingest routes classify on the rail from their first request) and by the world schedule dispatcher
 * on every fire. Once registered it is a no-op; while unregistered it re-checks at most once a minute
 * (an owner who signs in later is picked up without a restart) and warns once.
 * @param ctx - App context the provider dispatches with.
 * @returns Nothing; a failure to resolve the owner is logged and retried on a later call.
 */
export async function ensureWorldClassifyRail(ctx: AppContext): Promise<void> {
  if (railRegistered || Date.now() - lastEnsureAt < ENSURE_RETRY_MS) return;
  lastEnsureAt = Date.now();
  try {
    const outcome = await registerWorldClassifyRail(ctx);
    if (outcome === 'registered') {
      railRegistered = true;
    } else if (!unregisteredWarned) {
      unregisteredWarned = true;
      logger.warn({ reason: outcome }, UNREGISTERED_REASON[outcome]);
    }
  } catch (err) {
    logger.error({ err }, 'world classify rail could not be registered; a later call retries');
  }
}
