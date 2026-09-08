/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guest-seed orchestrator (guest-seed contract). On guest-start, core fans out to every installed, active app that declares `guestSeed:` and POSTs its hook over the loopback service rail AS the fresh guest (x-service-secret + x-oshal-user-sub = the guest sub) — the same idiom as artifact-exchange/redeem.ts. Guest-mode DATA seeding is the app developer's job; core only marries the fresh guest identity to each app's own seed. Best-effort and per-app fenced: a missing secret/port or one app's failure never blocks login or the other apps, and nothing here ever throws.
 */

import { createChildLogger } from '@/shared/logger';
import type { SwarmAppManifest } from '@/features/swarm-apps';

const logger = createChildLogger({ module: 'guest-seed-orchestrator' });

/** Per-hook timeout — a slow app seed must never hold the guest at the door. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** One app's declared guest-seed hook, reduced to what the fan-out needs. */
export interface GuestSeedTarget {
  /** Manifest name, for logging. */
  name: string;
  /** POST path below the app's own mount (validated at manifest load). */
  path: string;
}

/** Outcome of one app's seed call — returned for logging and tests, never thrown. */
export interface GuestSeedResult {
  name: string;
  path: string;
  ok: boolean;
  httpStatus?: number;
  error?: string;
}

/** Minimal fetch seam — the real runtime passes global fetch; tests pass a double. */
export type GuestSeedFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number }>;

/**
 * @description Reduce active manifests to the guest-seed hooks that will actually be called. Pure —
 * an app with no `guestSeed:` contributes nothing (guests just get its empty/default state).
 * @param manifests - Active app manifests.
 * @returns The declared guest-seed targets, in manifest order.
 */
export function guestSeedTargets(manifests: readonly SwarmAppManifest[]): GuestSeedTarget[] {
  const targets: GuestSeedTarget[] = [];
  for (const m of manifests) {
    if (m.guestSeed?.path) targets.push({ name: m.name, path: m.guestSeed.path });
  }
  return targets;
}

/**
 * @description Call one app's guest-seed hook over the loopback service rail AS the guest. Bounded,
 * fenced, and never throwing — the returned result carries the outcome for the caller to log.
 * @param base - Loopback origin (http://127.0.0.1:<port>).
 * @param target - The app's seed hook.
 * @param headers - Service secret + x-oshal-user-sub, pre-built once for the whole fan-out.
 * @param timeoutMs - Per-hook ceiling.
 * @param fetchImpl - Injected fetch.
 * @returns The seed outcome.
 */
async function callOne(
  base: string,
  target: GuestSeedTarget,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchImpl: GuestSeedFetch,
): Promise<GuestSeedResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}${target.path}`, { method: 'POST', headers, signal: controller.signal });
    const ok = res.status >= 200 && res.status < 300;
    return { name: target.name, path: target.path, ok, httpStatus: res.status };
  } catch (err) {
    return { name: target.name, path: target.path, ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @description Fan out to every declared guest-seed hook for a fresh guest sub. Reads the service
 * secret from the environment (never a caller header) and posts to each app on the loopback origin.
 * Best-effort: no secret or no port → a logged no-op returning []; each hook is fenced so one app's
 * failure cannot abort the others or the guest login. This function never throws.
 * @param opts - guestSub, loopback port, active manifests, and optional secret/timeout/fetch seam.
 * @returns One result per declared hook (empty when seeding is unavailable or no app declares one).
 */
export async function runGuestSeeds(opts: {
  guestSub: string;
  port: number | undefined;
  manifests: readonly SwarmAppManifest[];
  serviceSecret?: string;
  timeoutMs?: number;
  fetchImpl?: GuestSeedFetch;
}): Promise<GuestSeedResult[]> {
  const targets = guestSeedTargets(opts.manifests);
  if (targets.length === 0) return [];
  const secret = (opts.serviceSecret ?? process.env.SWARM_SERVICE_SECRET ?? '').trim();
  if (!secret) {
    logger.info({ guestSub: opts.guestSub, targets: targets.length }, 'Guest seed skipped — SWARM_SERVICE_SECRET unconfigured');
    return [];
  }
  if (!opts.port) {
    logger.info({ guestSub: opts.guestSub, targets: targets.length }, 'Guest seed skipped — loopback port unavailable');
    return [];
  }
  const base = `http://127.0.0.1:${opts.port}`;
  const headers = { 'x-service-secret': secret, 'x-oshal-user-sub': opts.guestSub, 'content-type': 'application/json' };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as GuestSeedFetch);
  const results = await Promise.all(targets.map((t) => callOne(base, t, headers, timeoutMs, fetchImpl)));
  const failed = results.filter((r) => !r.ok);
  logger.info(
    { guestSub: opts.guestSub, seeded: results.length - failed.length, failed: failed.map((f) => `${f.name}(${f.httpStatus ?? f.error})`) },
    'Guest seed fan-out complete',
  );
  return results;
}
