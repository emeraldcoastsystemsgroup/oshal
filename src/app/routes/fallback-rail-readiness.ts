/**
 * HOT means ready before it is needed: the readiness probe for the portal's fallback rail.
 *
 * The operator's hot fallback (byo-hot-fallback.ts) walks the CONFIGURED provider chain after an
 * explicitly chosen BYO endpoint has exhausted its same-endpoint retry. A rung is only worth
 * spending on if it can actually answer, and "can it answer" is knowable ahead of time for every
 * rung the chain may name:
 *   - a CLI login rung (`openai-codex`, `claude-code`) — the mounted login file is present and its
 *     token has not lapsed, and the bot node that would run it answers its health check;
 *   - a hosted rung (a Cline-backed vendor id such as `gemini` or `openrouter`) — the vendor key is
 *     present in this deployment's environment and the lane is not sitting out a failure cooldown.
 *
 * What the probe deliberately does NOT do: spawn a CLI (`claude auth status` opens a process; the
 * probe runs on an interval), refresh a token (scripts/claude-token-keepalive.ps1 owns that), or
 * spend a completion on a vendor (a probe that burns quota on a rung the operator may never take is
 * the free-tier lesson all over again). It reads files and env, and it pings a node's /api/health.
 * No token or key is ever held in the stored status, returned, or logged — only presence, expiry
 * and a sentence saying why.
 *
 * Readiness is what makes re-admitting `claude-code` to an automatic chain safe against the
 * 2026-08-13 concern that removed it (ADR-128 Amendment 1: "silent spend on a dying account"). A
 * dying account is one whose login has lapsed or been revoked; that reads here as not-ready, is
 * logged, and is skipped — never spent on. The operator's 2026-09-22 decision supersedes that
 * removal for THIS configurable, readiness-gated fallback only; DEMO_CLI_ORDER (the chat/user rung
 * in user-brain-resolution.ts) is untouched.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — per-rung readiness (CLI login present + unexpired + node reachable; hosted key present + not cooling), a token-free stored status refreshed on an interval and on demand, and the transport rule that a CLI rung can never serve a controller-inline turn (SEC-05 is not weakened here).
 *
 * @module fallback-rail-readiness
 */

import { createChildLogger } from '@/shared/logger';
import { classifyProviderId, type ClassifiedProviderId, type ProviderSwitchCatalog } from '@/shared/llm-runtime';
import { liveCodexAuthExpiry } from '@/features/llm-provider';
import { ClaudeCodeAuthService } from '@/features/claude-code-auth';
import { installedProviderSwitchCatalog } from '@/app/composition/provider-switch-runtime';
import { OPENAI_COMPAT_LANES, laneKeyFromEnv } from './openai-compat-lanes';
import { operatorKeyLaneCoolingUntil } from './free-tier-rotation';

const logger = createChildLogger({ module: 'fallback-rail-readiness' });

/** Where the turn that would take the rung executes. A CLI rung can serve only a node. */
export type FallbackTransport = 'node' | 'inline';

/** The kind of rail a rung is, decided from its classification — never from its spelling. */
export type FallbackRungKind = 'cli-login' | 'hosted-key' | 'unrunnable';

/** One rung's readiness, as stored and as shown. Never carries a token or a key. */
export interface RungReadiness {
  /** The provider id as configured on the chain. */
  providerId: string;
  kind: FallbackRungKind;
  /** True only when every check that applies to this rung and transport passed. */
  ready: boolean;
  /** One sentence a person can act on. */
  reason: string;
  /** Epoch ms of this probe. */
  checkedAt: number;
  /** When the login/key lapses, when the rail says so; null when unknown or not applicable. */
  expiresAt: number | null;
  /** Node health for a node transport; null when no node was probed (inline, or no agent). */
  reachable: boolean | null;
  /** Which transport this verdict is about. */
  transport: FallbackTransport;
}

/** What a probe needs to know. `botClient` + `agentId` enable the node health leg. */
export interface RungProbeInput {
  providerId: string;
  transport: FallbackTransport;
  agentId?: string;
  botClient?: { healthCheck(agentId: string): Promise<boolean> };
  /** The runnable catalog; defaults to the installed one. */
  catalog?: ProviderSwitchCatalog | null;
  /** Injectable clock (guards only). */
  now?: () => number;
}

/** The stored status: the last verdict per rung, so a surface reads without probing. */
const stored = new Map<string, RungReadiness>();
let lastRefreshAt: number | null = null;
let loop: NodeJS.Timeout | null = null;

/** Env name a Cline-backed vendor's key is expected under when no lane catalog entry names it. */
function conventionalKeyEnv(providerId: string): string[] {
  return [`${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`];
}

/** The catalog to classify against: injected, else the installed one, else an empty one. */
function catalogOf(input: RungProbeInput): ProviderSwitchCatalog {
  return input.catalog ?? installedProviderSwitchCatalog() ?? { harnessTypes: [], clineApiProviders: [] };
}

/** Readiness of the mounted Codex login: present and its JWT `exp` not passed. */
function probeCodexLogin(now: number): { ready: boolean; reason: string; expiresAt: number | null } {
  const login = liveCodexAuthExpiry();
  if (!login.present) return { ready: false, reason: 'no Codex login file (run `codex login` on the host, or import it under Settings → OpenAI Codex)', expiresAt: null };
  if (login.expiresAt !== null && login.expiresAt <= now) {
    return { ready: false, reason: `Codex login expired at ${new Date(login.expiresAt).toISOString()}`, expiresAt: login.expiresAt };
  }
  return { ready: true, reason: login.expiresAt ? `Codex login present, valid until ${new Date(login.expiresAt).toISOString()}` : 'Codex login present (no expiry claim)', expiresAt: login.expiresAt };
}

/** Readiness of the mounted Claude Code login: present and not expired. File read only. */
function probeClaudeLogin(now: number): { ready: boolean; reason: string; expiresAt: number | null } {
  const login = new ClaudeCodeAuthService().getPersistedLoginExpiry();
  if (!login.present) return { ready: false, reason: 'no Claude Code login file (sign in under Settings → Claude Code, or push one from a satellite)', expiresAt: null };
  if (login.expiresAt !== null && login.expiresAt <= now) {
    return { ready: false, reason: `Claude Code login expired at ${new Date(login.expiresAt).toISOString()}`, expiresAt: login.expiresAt };
  }
  return { ready: true, reason: login.expiresAt ? `Claude Code login present, valid until ${new Date(login.expiresAt).toISOString()}` : 'Claude Code login present (no expiry recorded)', expiresAt: login.expiresAt };
}

/** Readiness of a hosted vendor rung: a key in the environment and no failure cooldown. */
function probeHostedKey(clineApiProvider: string): { ready: boolean; reason: string; expiresAt: number | null; hasLane: boolean } {
  const laneId = clineApiProvider.toLowerCase();
  const lane = OPENAI_COMPAT_LANES[laneId];
  const envNames = lane?.envKeys ?? conventionalKeyEnv(laneId);
  const key = lane ? laneKeyFromEnv(lane) : envNames.map((name) => (process.env[name] || '').trim()).find(Boolean) ?? null;
  if (!key) return { ready: false, reason: `no ${envNames.join('/')} in this environment (the bot nodes share it)`, expiresAt: null, hasLane: Boolean(lane) };
  const coolingUntil = lane ? operatorKeyLaneCoolingUntil(laneId) : null;
  if (coolingUntil) {
    return { ready: false, reason: `${laneId} lane is cooling after a mid-turn failure until ${new Date(coolingUntil).toISOString()}`, expiresAt: coolingUntil, hasLane: true };
  }
  return { ready: true, reason: `${envNames.find((name) => (process.env[name] || '').trim()) ?? envNames[0]} present`, expiresAt: null, hasLane: Boolean(lane) };
}

/** The auth half of a probe, by rail kind. */
function probeAuth(classified: ClassifiedProviderId, transport: FallbackTransport, now: number): Omit<RungReadiness, 'providerId' | 'checkedAt' | 'reachable' | 'transport'> {
  if (classified.botNodeRuntime === 'openai-codex' || classified.botNodeRuntime === 'claude-code') {
    if (transport === 'inline') {
      // Not a weakening of anything: the controller refuses every unattended CLI (SEC-05), so a
      // login rung is simply not a rail an in-process turn can ride. Said plainly, not skipped silently.
      return { kind: 'cli-login', ready: false, reason: `${classified.providerId} is a CLI login; it can serve a turn only on a bot node, and this bot runs inline on the controller`, expiresAt: null };
    }
    const login = classified.botNodeRuntime === 'openai-codex' ? probeCodexLogin(now) : probeClaudeLogin(now);
    return { kind: 'cli-login', ...login };
  }
  if (classified.botNodeRuntime === 'cline-cli' && classified.clineApiProvider) {
    const hosted = probeHostedKey(classified.clineApiProvider);
    if (transport === 'inline' && !hosted.hasLane) {
      return { kind: 'hosted-key', ready: false, reason: `${classified.providerId} has no in-process hosted lane on the controller (openai-compat-lanes); it can serve a turn only on a bot node`, expiresAt: null };
    }
    return { kind: 'hosted-key', ready: hosted.ready, reason: hosted.reason, expiresAt: hosted.expiresAt };
  }
  return { kind: 'unrunnable', ready: false, reason: `${classified.providerId} has no bot-node runtime and no hosted lane — it cannot be a fallback rung`, expiresAt: null };
}

/**
 * @description Probe one rung for one transport and store the verdict. Cheap by construction:
 * file reads, env reads, and (node transport with an agent) one health ping. The stored status
 * is keyed by provider id so the Settings surface can show the fleet's rungs; the node leg is
 * recorded on that verdict when it was probed.
 * @param input - The rung, the transport, and optionally the node to ping.
 * @returns The verdict, never carrying a token.
 */
export async function probeRungReadiness(input: RungProbeInput): Promise<RungReadiness> {
  const now = (input.now ?? Date.now)();
  const classified = classifyProviderId(input.providerId, catalogOf(input));
  let verdict: RungReadiness;
  if (!classified.ok) {
    verdict = { providerId: input.providerId, kind: 'unrunnable', ready: false, reason: classified.reason, checkedAt: now, expiresAt: null, reachable: null, transport: input.transport };
  } else {
    const auth = probeAuth(classified, input.transport, now);
    let reachable: boolean | null = null;
    if (auth.ready && input.transport === 'node' && input.agentId && input.botClient) {
      reachable = await input.botClient.healthCheck(input.agentId).catch(() => false);
    }
    const ready = auth.ready && reachable !== false;
    const reason = reachable === false ? `${auth.reason}; but the bot node for this agent did not answer its health check` : auth.reason;
    verdict = { providerId: classified.providerId, ...auth, ready, reason, checkedAt: now, reachable, transport: input.transport };
  }
  stored.set(verdict.providerId.toLowerCase(), verdict);
  logger.debug({ providerId: verdict.providerId, transport: verdict.transport, ready: verdict.ready, reason: verdict.reason }, 'fallback rail readiness probed');
  return verdict;
}

/**
 * @description Refresh the stored status for a set of rungs (the fleet chain, typically) at the
 * auth level — no node is pinged, because the fleet-level view has no single node to ask.
 * @param providerIds - The rungs to probe.
 * @param catalog - The runnable catalog; defaults to the installed one.
 * @returns The verdicts, in the order asked.
 */
export async function refreshFallbackReadiness(
  providerIds: readonly string[],
  catalog?: ProviderSwitchCatalog | null,
): Promise<RungReadiness[]> {
  const verdicts: RungReadiness[] = [];
  for (const providerId of providerIds) {
    verdicts.push(await probeRungReadiness({ providerId, transport: 'node', catalog }));
  }
  lastRefreshAt = Date.now();
  return verdicts;
}

/**
 * @description The stored status, for a surface: the last verdict per rung and when the loop
 * last ran. Reading never probes, so a cockpit poll costs nothing.
 * @param providerIds - Which rungs to report, in order; a rung never probed reads as unknown.
 * @returns The verdicts and the last refresh instant.
 */
export function fallbackReadinessSnapshot(providerIds: readonly string[]): { rungs: RungReadiness[]; refreshedAt: number | null } {
  const rungs = providerIds.map((providerId) => stored.get(providerId.toLowerCase()) ?? {
    providerId, kind: 'unrunnable' as const, ready: false, reason: 'not probed yet', checkedAt: 0, expiresAt: null, reachable: null, transport: 'node' as const,
  });
  return { rungs, refreshedAt: lastRefreshAt };
}

/**
 * @description The probe loop period: `OSHAL_HOT_FALLBACK_PROBE_INTERVAL_MS`, default two
 * minutes, `0` disables the loop (the on-demand probe still runs before any rung is taken).
 * @param env - The environment to read (injectable for guards).
 * @returns The interval in ms.
 */
export function resolveFallbackProbeIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number((env.OSHAL_HOT_FALLBACK_PROBE_INTERVAL_MS ?? '').trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 120_000;
}

/**
 * @description Start the interval that keeps the stored status warm. Unref'd, so it never keeps
 * the process alive; a second start replaces the first. The rung list is resolved on every tick
 * so a chain the operator re-orders is probed as re-ordered, with no restart.
 * @param resolveRungs - Yields the rungs to probe (the fleet chain).
 * @param intervalMs - Period; 0 disables.
 * @returns void
 */
export function startFallbackReadinessLoop(
  resolveRungs: () => readonly string[],
  intervalMs: number = resolveFallbackProbeIntervalMs(),
): void {
  stopFallbackReadinessLoop();
  if (intervalMs <= 0) {
    logger.info('hot-fallback readiness loop disabled (OSHAL_HOT_FALLBACK_PROBE_INTERVAL_MS=0); on-demand probes still run');
    return;
  }
  const tick = (): void => {
    void refreshFallbackReadiness(resolveRungs()).catch((err) => {
      logger.error({ err }, 'hot-fallback readiness refresh failed');
    });
  };
  tick();
  loop = setInterval(tick, intervalMs);
  loop.unref();
  logger.info({ intervalMs }, 'hot-fallback readiness loop started');
}

/**
 * @description Stop the interval (tests, shutdown).
 * @returns void
 */
export function stopFallbackReadinessLoop(): void {
  if (loop) clearInterval(loop);
  loop = null;
}

/**
 * @description Test seam: forget every stored verdict.
 * @returns void
 */
export function resetFallbackReadinessForTesting(): void {
  stopFallbackReadinessLoop();
  stored.clear();
  lastRefreshAt = null;
}
