/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-119 P4 (A2): the app-layer RemediationExecutor — the deterministic HTTP seam from the controller to the self-healing bot node's fail-closed /api/self-heal/apply endpoint (the ONE container holding the docker socket; the controller itself has none and never shells out). restartContainer = one apply POST; verifyHealthy = observation polling until the target reports running+healthy (or health-less running) inside the window — never "exit 0 means done". No LLM anywhere on this path (controller/LLM boundary). Every request carries X-Service-Secret; the node 401s without it, so an unset secret fails CLOSED end-to-end.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { createChildLogger } from '@/shared/logger';
import type { RemediationExecutor } from '@/features/alert-triage';
import { serviceSecretHeaders } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'self-heal-remediation-executor' });

/** @description Default node URL: the compose self-healing container's internal port. */
const DEFAULT_SELF_HEAL_NODE_URL = 'http://oshal-local-self-healing:5000';

/** @description Per-request ceiling for the apply POST (docker restart can take ~35s). */
const APPLY_REQUEST_TIMEOUT_MS = 60_000;

/** @description Per-request ceiling for one health-check POST. */
const CHECK_REQUEST_TIMEOUT_MS = 15_000;

/** @description Pause between verification observations. */
const VERIFY_POLL_INTERVAL_MS = 5_000;

/** @description Shape of the self-heal node's container inspection result. */
interface ApplyEndpointResult {
  success?: boolean;
  error?: string;
  status?: string;
  health?: string;
  after?: { status?: string; health?: string };
}

/**
 * @description POSTs one action to the self-healing node's apply endpoint with a bounded
 * timeout. Errors are returned, not thrown — the engine treats them as failed steps.
 * @param action - 'restart' | 'check'.
 * @param container - Target container name.
 * @param timeoutMs - Request ceiling.
 * @returns Parsed body, or an error-shaped result.
 */
async function postApply(action: 'restart' | 'check', container: string, timeoutMs: number): Promise<ApplyEndpointResult> {
  const base = (process.env.SELF_HEAL_NODE_URL || DEFAULT_SELF_HEAL_NODE_URL).replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/api/self-heal/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...serviceSecretHeaders() },
      body: JSON.stringify({ action, container }),
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as ApplyEndpointResult;
    if (!response.ok) {
      return { success: false, error: body.error || `self-heal node returned HTTP ${response.status}` };
    }
    return body;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @description Is this inspection an observed-healthy state? Running with a passing
 * healthcheck, or running with no healthcheck defined ('none'/'') — 'starting' and
 * 'unhealthy' are NOT healthy.
 * @param result - The check result.
 * @returns True when the container is observed healthy.
 */
function isObservedHealthy(result: ApplyEndpointResult): boolean {
  const status = (result.status ?? '').toLowerCase();
  const health = (result.health ?? '').toLowerCase();
  return status === 'running' && (health === 'healthy' || health === 'none' || health === '');
}

/**
 * @description Builds the ADR-119 A2 remediation executor over the self-healing bot
 * node's deterministic apply endpoint. The node re-checks its own whitelist and its
 * fail-closed service-secret gate; the container may legitimately be absent (it is
 * profile-gated in compose) — then every apply fails visibly and the engine escalates,
 * which is the correct posture for an unreachable remediation arm.
 * @returns The executor the auto-apply engine calls.
 */
export function createSelfHealRemediationExecutor(): RemediationExecutor {
  return {
    async restartContainer(target: string): Promise<{ ok: boolean; detail: string }> {
      const result = await postApply('restart', target, APPLY_REQUEST_TIMEOUT_MS);
      if (result.success !== true) {
        logger.error({ target, error: result.error ?? 'unknown' }, 'Self-heal apply POST failed');
        return { ok: false, detail: result.error ?? 'self-heal node reported failure' };
      }
      const after = result.after ?? {};
      logger.info({ target, after }, 'Self-heal restart applied via the self-healing node');
      return { ok: true, detail: `restarted; post-restart state ${after.status ?? 'unknown'}/${after.health ?? 'unknown'}` };
    },

    async verifyHealthy(target: string, timeoutMs: number): Promise<{ healthy: boolean; detail: string }> {
      const deadline = Date.now() + Math.max(1, timeoutMs);
      let lastDetail = 'no observation made';
      for (;;) {
        const result = await postApply('check', target, CHECK_REQUEST_TIMEOUT_MS);
        lastDetail = result.error
          ? `check failed: ${result.error}`
          : `observed ${result.status ?? 'unknown'}/${result.health ?? 'unknown'}`;
        if (result.success === true && isObservedHealthy(result)) {
          return { healthy: true, detail: lastDetail };
        }
        if (Date.now() + VERIFY_POLL_INTERVAL_MS > deadline) {
          logger.warn({ target, lastDetail }, 'Self-heal verification window elapsed without observed health');
          return { healthy: false, detail: `verification window elapsed; last ${lastDetail}` };
        }
        await delay(VERIFY_POLL_INTERVAL_MS);
      }
    },
  };
}
