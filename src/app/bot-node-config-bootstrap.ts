/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-034 boot bootstrap-pull (env-as-seed): on bot-node startup, pull this agent's authoritative provider/model record from the controller (GET /api/agents/:id/runtime) and apply it to the process env BEFORE the any-bot LLM stack is built, so FORCE_LLM_PROVIDER / CODEX_MODEL / CLAUDE_CODE_MODEL become first-boot seeds that defer to the pulled record. Fail-open by design: controller unreachable, no record (404), or malformed response → the legacy env self-resolve behavior is untouched (WARN/INFO logged). Kill switch OSHAL_BOT_CONFIG_BOOTSTRAP=off. The live mid-flight config-change envelope remains the other half of the backlog item.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Thundering-herd fix (BACKLOG 2026-07-19 "bot-recreate herd on /api/config/runtime"): on a mass cold-start (engine-restart auto-start, install.sh, unbatched deploys) ~35 bots pulled GET /api/agents/:id/runtime simultaneously, exceeding the api's 20-client pg pool and blowing its 10s connectionTimeoutMillis (bots then fell open to env self-resolve). runBootConfigBootstrap now sleeps a uniform-random jitter before the pull. Knob: OSHAL_BOT_CONFIG_BOOTSTRAP_JITTER_MS = the jitter WINDOW in ms (delay is uniform in [0, window)); default 12000 spreads 35 bots to ~3 pulls/sec; 0 disables (tests/CI). rng + sleep are injectable for tests. The jitter stays BEFORE the LLM stack build, so no request is ever served on stale config mid-boot, and the fail-open contract is untouched.
 */

/**
 * Bot-node boot config bootstrap-pull (ADR-034 "env-as-seed" follow-on).
 *
 * OSHAL owns the authoritative per-agent runtime record (`agent_config`, exposed by the
 * controller at `GET /api/agents/:agentId/runtime`). Historically a bot-node ignored it on
 * boot and self-resolved provider/model purely from its container env. This module closes
 * the BOOT half of that gap: pull the record once at startup and overlay it onto the env
 * seeds the existing resolution machinery already reads, so *every* downstream consumer
 * (resolveCurrentProvider, resolveModelName, CodexProvider's constructor model, the Cline
 * runtime selection) picks the pulled values up without new plumbing.
 *
 * Resolution order (guarded by tests/unit/bot-node-config-bootstrap.spec.ts):
 *   1. Pulled record wins — providerId → FORCE_LLM_PROVIDER; modelId → FORCE_LLM_MODEL
 *      (+ CODEX_MODEL / CLAUDE_CODE_MODEL when the pulled provider names that harness).
 *   2. Absent record / unreachable controller / disabled → legacy env self-resolve,
 *      completely untouched (fail-open).
 *
 * @module bot-node-config-bootstrap
 */

import { createChildLogger } from '@/shared/logger';
import { serviceSecretHeaders } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'bot-node-config-bootstrap' });

/** Default controller base URL inside the compose network (same fallback as registerBotUi). */
const DEFAULT_CONTROLLER_BASE = 'http://oshal-api:5000';
/** Default per-attempt pull timeout — keeps a controller outage from stalling bot boot. */
const DEFAULT_TIMEOUT_MS = 4000;
/**
 * Default boot-jitter window (ms). A mass cold-start (~35 bots) spread uniformly over 12s
 * lands ~3 pulls/sec on the controller's 20-client pg pool instead of all at once.
 */
const DEFAULT_BOOT_JITTER_WINDOW_MS = 12000;

/** @description The authoritative runtime fields a boot pull can apply (ADR-034 RuntimeParams). */
export interface PulledBotConfig {
  providerId: string | null;
  modelId: string | null;
  configVersion: number | null;
}

/** @description Options for {@link pullBotConfigFromController}; everything injectable for tests. */
export interface PullBotConfigOptions {
  agentId: string;
  controllerBaseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/**
 * @description Options for {@link runBootConfigBootstrap} — the pull options plus the
 * boot-jitter injection points (both only used by tests; production uses Math.random +
 * a real timer).
 */
export interface BootConfigBootstrapOptions extends Omit<PullBotConfigOptions, 'agentId'> {
  /** Uniform [0,1) source for the jitter draw (Math.random in production). */
  rng?: () => number;
  /** Awaitable delay (real setTimeout in production; a spy/no-op in tests). */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * @description Resolves the boot-jitter WINDOW in milliseconds from
 * OSHAL_BOT_CONFIG_BOOTSTRAP_JITTER_MS. The actual delay is uniform in [0, window).
 * Semantics: unset/blank → the default (herd protection is ON by default so every start
 * path — deploy script, engine-restart auto-start, install.sh — is covered); an explicit
 * 0 disables the jitter (kill switch, used by tests/CI); a negative or non-numeric value
 * falls back to the default (fail-safe toward protection, never toward the herd).
 * @param env - Environment map (process.env by default; injectable for tests).
 * @returns The jitter window in ms (0 = disabled).
 */
export function resolveBootConfigJitterWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OSHAL_BOT_CONFIG_BOOTSTRAP_JITTER_MS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_BOOT_JITTER_WINDOW_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_BOOT_JITTER_WINDOW_MS;
  return Math.floor(parsed);
}

/**
 * @description Whether the boot bootstrap-pull is enabled. Default ON; set
 * OSHAL_BOT_CONFIG_BOOTSTRAP=off|false|0 to disable (pure legacy self-resolve).
 * @param env - Environment map (process.env by default; injectable for tests).
 * @returns True when the boot pull should run.
 */
export function isBootstrapPullEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.OSHAL_BOT_CONFIG_BOOTSTRAP ?? '').trim().toLowerCase();
  return !(raw === 'off' || raw === 'false' || raw === '0');
}

/**
 * @description Pulls this agent's authoritative runtime record from the controller
 * (`GET /api/agents/:agentId/runtime`, authenticated with the swarm service secret).
 * Fail-open by contract: ANY failure — unreachable controller, timeout, 404 (no record
 * yet), non-2xx, malformed body — returns null so the caller keeps the legacy env
 * self-resolve behavior. A 404 is logged at INFO (expected before the first push);
 * everything else WARNs.
 * @param options - Agent id plus injectable base URL / timeout / fetch for tests.
 * @returns The pulled record, or null when there is nothing applicable.
 */
export async function pullBotConfigFromController(
  options: PullBotConfigOptions,
): Promise<PulledBotConfig | null> {
  const env = options.env ?? process.env;
  const base = (options.controllerBaseUrl ?? env.SWARM_CONTROLLER_URL ?? DEFAULT_CONTROLLER_BASE).replace(/\/$/, '');
  const timeoutMs = options.timeoutMs
    ?? Math.max(500, Number(env.OSHAL_BOT_CONFIG_BOOTSTRAP_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const url = `${base}/api/agents/${encodeURIComponent(options.agentId)}/runtime`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...serviceSecretHeaders() },
      signal: controller.signal,
    });
    if (response.status === 404) {
      logger.info({ agentId: options.agentId }, 'Boot config pull: no authoritative record yet — legacy env self-resolve');
      return null;
    }
    if (!response.ok) {
      logger.warn(
        { agentId: options.agentId, status: response.status },
        'Boot config pull: controller answered non-OK — falling back to legacy env self-resolve',
      );
      return null;
    }
    const body = await response.json() as {
      success?: boolean;
      runtime?: { providerId?: unknown; modelId?: unknown };
      configVersion?: unknown;
    };
    const runtime = body?.runtime;
    if (!body?.success || !runtime || typeof runtime !== 'object') {
      logger.warn({ agentId: options.agentId }, 'Boot config pull: malformed controller response — legacy env self-resolve');
      return null;
    }
    return {
      providerId: readNonEmptyString(runtime.providerId),
      modelId: readNonEmptyString(runtime.modelId),
      configVersion: typeof body.configVersion === 'number' && Number.isFinite(body.configVersion)
        ? body.configVersion
        : null,
    };
  } catch (err) {
    logger.warn(
      { err, agentId: options.agentId, url },
      'Boot config pull: controller unreachable — falling back to legacy env self-resolve',
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @description Applies a pulled authoritative record onto the env seeds the legacy
 * resolution machinery reads. This is the resolution-order contract: a pulled value WINS
 * over whatever the container env seeded; an absent pulled value leaves the env key
 * completely untouched (legacy self-resolve). Provider-specific model keys (CODEX_MODEL,
 * CLAUDE_CODE_MODEL) are only written when the pulled record itself names that provider —
 * a model pulled WITHOUT a provider only sets the generic FORCE_LLM_MODEL, so it can
 * never mislabel a different harness's model.
 * @param pulled - The pulled record (null → no-op).
 * @param env - Environment map to mutate (process.env in production; a plain object in tests).
 * @returns The env keys that were overwritten, for the caller's boot log.
 */
export function applyPulledBotConfigToEnv(
  pulled: PulledBotConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!pulled) return [];
  const applied: string[] = [];
  const provider = pulled.providerId;
  if (provider) {
    env.FORCE_LLM_PROVIDER = provider;
    applied.push('FORCE_LLM_PROVIDER');
  }
  if (pulled.modelId) {
    env.FORCE_LLM_MODEL = pulled.modelId;
    applied.push('FORCE_LLM_MODEL');
    const normalized = provider ? normalizePulledProviderName(provider) : null;
    if (normalized === 'openai-codex') {
      env.CODEX_MODEL = pulled.modelId;
      applied.push('CODEX_MODEL');
    } else if (normalized === 'claude-code') {
      env.CLAUDE_CODE_MODEL = pulled.modelId;
      applied.push('CLAUDE_CODE_MODEL');
    }
  }
  return applied;
}

/**
 * @description Runs the full boot bootstrap-pull: enabled-check → herd jitter → pull →
 * env overlay, with a loud INFO naming exactly which seeds the authoritative record
 * overwrote. The jitter (uniform in [0, OSHAL_BOT_CONFIG_BOOTSTRAP_JITTER_MS), default
 * 12s, 0 disables) spreads a mass cold-start's pulls so ~35 bots do not land on
 * GET /api/agents/:id/runtime simultaneously and exhaust the controller's pg pool.
 * Fail-open end-to-end; a bot with no reachable controller boots exactly as before.
 * @param agentId - This bot's runtime agent id.
 * @param options - Optional overrides (fetch/base/timeout/env/rng/sleep) for tests.
 * @returns The pulled record when one was applied, else null.
 */
export async function runBootConfigBootstrap(
  agentId: string,
  options: BootConfigBootstrapOptions = {},
): Promise<PulledBotConfig | null> {
  const env = options.env ?? process.env;
  if (!isBootstrapPullEnabled(env)) {
    logger.info('Boot config pull disabled (OSHAL_BOT_CONFIG_BOOTSTRAP=off) — legacy env self-resolve');
    return null;
  }
  const jitterWindowMs = resolveBootConfigJitterWindowMs(env);
  if (jitterWindowMs > 0) {
    const rng = options.rng ?? Math.random;
    const sleep = options.sleepImpl ?? defaultSleep;
    const delayMs = Math.floor(rng() * jitterWindowMs);
    logger.info(
      { agentId, delayMs, jitterWindowMs },
      'Boot config pull: herd jitter before pulling runtime config (OSHAL_BOT_CONFIG_BOOTSTRAP_JITTER_MS)',
    );
    if (delayMs > 0) await sleep(delayMs);
  }
  const pulled = await pullBotConfigFromController({ agentId, ...options });
  const applied = applyPulledBotConfigToEnv(pulled, env);
  if (pulled && applied.length > 0) {
    logger.info(
      { agentId, providerId: pulled.providerId, modelId: pulled.modelId, configVersion: pulled.configVersion, applied },
      'Boot config pull: authoritative controller record applied over env seeds (ADR-034 env-as-seed)',
    );
  }
  return pulled && applied.length > 0 ? pulled : null;
}

/**
 * @description Normalizes legacy provider aliases the same way the bot-node runtime does
 * (codex-cli → openai-codex, cline → cline-cli). Declared locally so this module stays
 * import-cycle-free with bot-node-runtime.ts (which imports this module at boot).
 * @param value - Raw pulled providerId.
 * @returns The normalized provider name.
 */
export function normalizePulledProviderName(value: string): string {
  if (value === 'codex-cli') return 'openai-codex';
  if (value === 'cline') return 'cline-cli';
  return value;
}

/** @description Real awaitable delay used for the boot herd jitter in production. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @description Narrows unknown JSON to a trimmed non-empty string, else null. */
function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
