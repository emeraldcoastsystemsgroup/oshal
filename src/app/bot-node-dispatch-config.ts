/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-034 push-on-dispatch (bot half): parseCarriedDispatchConfig reads the optional providerId/model/configVersion the controller stamped on /api/swarm-execute, and reconcileDispatchProviderConfig compares them against the live active provider — a divergent bot self-corrects via the gap-(a) setActiveProvider seam BEFORE executing, logging the correction. Absent fields = the runtime is never touched (byte-identical legacy dispatch); an unknown/unavailable carried provider FAILS OPEN to the bot's self-resolved provider (a bad record must never block execution).
 */

/**
 * ADR-034 push-on-dispatch enforcement (bot half).
 *
 * The controller stamps each `/api/swarm-execute` dispatch with the authoritative
 * provider/model record (`providerId` / `model` / `configVersion` on the request body —
 * populated by the dispatch chokepoints via
 * src/features/agent-management/services/dispatch-runtime-params.ts). This module is the
 * bot-node side: BEFORE the execution handler runs, the carried record is compared
 * against the runtime's live active provider/model, and a divergent bot SELF-CORRECTS
 * through the same validated `setActiveProvider` seam the PUT /api/llm-provider push-down
 * uses — so what runs on dispatch matches OSHAL's intent (ADR-034 §2) even when a
 * push-down was missed (bot restarted onto stale env, switch raced a dispatch, …).
 *
 * Contract, in order of importance:
 *  1. ABSENT fields → the runtime is not touched at all — byte-identical legacy dispatch
 *     (the dual dispatch path is load-bearing; enforcement is strictly opt-in per request).
 *  2. Divergence → self-correct via setActiveProvider and LOG the correction (WARN, with
 *     from/to and the carried configVersion) — drift is a fleet-visible signal, not noise.
 *  3. A carried provider the bot cannot switch to (unknown name, harness not initialized)
 *     FAILS OPEN: the divergence is logged and execution proceeds on the self-resolved
 *     provider. A bad record must never block real work (ADR-034 standalone semantics).
 *
 * @module bot-node-dispatch-config
 */

import { createChildLogger } from '@/shared/logger';
import { normalizePulledProviderName } from './bot-node-config-bootstrap';
import type { ActiveBotNodeProvider } from './bot-node-llm-provider-route';

const logger = createChildLogger({ module: 'bot-node-dispatch-config' });

/** @description The authoritative record a dispatch carried (ADR-034 §2 "On dispatch"). */
export interface CarriedDispatchConfig {
  providerId: string;
  model?: string;
  configVersion?: number;
}

/** @description The runtime seam the reconciliation drives (bot-node-runtime's live accessors). */
export interface DispatchConfigRuntime {
  getActiveProvider(): ActiveBotNodeProvider;
  setActiveProvider(provider: string, model?: string): ActiveBotNodeProvider;
}

/** @description Outcome of one dispatch-config reconciliation. */
export interface DispatchConfigReconciliation {
  /**
   * absent      — no record carried; runtime untouched (legacy dispatch).
   * match       — record carried and already matches the active provider/model.
   * corrected   — divergence detected and self-corrected via setActiveProvider.
   * failed-open — divergence detected but the switch failed; executing self-resolved.
   */
  action: 'absent' | 'match' | 'corrected' | 'failed-open';
  /** The provider/model the execution will actually run on (absent action carries none). */
  active?: ActiveBotNodeProvider;
}

/**
 * @description Parses the optional carried config off a /api/swarm-execute body. Strictly
 * opt-in: a missing/blank/non-string providerId yields null — the "absent" legacy path —
 * so a malformed stamp can never half-apply. Model must be a non-empty string and
 * configVersion a finite number to be carried; anything else is dropped field-wise.
 * @param body - The raw request-body slice ({ providerId?, model?, configVersion? }).
 * @returns The parsed record, or null when no actionable record was carried.
 */
export function parseCarriedDispatchConfig(
  body: { providerId?: unknown; model?: unknown; configVersion?: unknown } | undefined,
): CarriedDispatchConfig | null {
  const providerId = typeof body?.providerId === 'string' ? body.providerId.trim() : '';
  if (!providerId) return null;
  const model = typeof body?.model === 'string' && body.model.trim().length > 0 ? body.model.trim() : undefined;
  const rawVersion = body?.configVersion;
  const configVersion = typeof rawVersion === 'number' && Number.isFinite(rawVersion) ? rawVersion : undefined;
  return {
    providerId,
    ...(model !== undefined ? { model } : {}),
    ...(configVersion !== undefined ? { configVersion } : {}),
  };
}

/**
 * @description Reconciles a carried dispatch config against the bot's live active
 * provider/model, self-correcting via setActiveProvider BEFORE execution when they
 * diverge (ADR-034 §2). See the module contract: absent → untouched, divergent →
 * corrected + logged, un-switchable → fail-open + logged.
 * @param carried - The parsed record (null → legacy no-op).
 * @param runtime - The live provider accessors (bot-node-runtime seam).
 * @param context - Attribution for the correction log (taskId).
 * @param log - Injectable logger (tests); defaults to the module logger.
 * @returns The reconciliation outcome with the provider the execution will run on.
 */
export function reconcileDispatchProviderConfig(
  carried: CarriedDispatchConfig | null,
  runtime: DispatchConfigRuntime,
  context: { taskId?: string } = {},
  log: Pick<ReturnType<typeof createChildLogger>, 'warn' | 'debug'> = logger,
): DispatchConfigReconciliation {
  if (!carried) {
    // Byte-identical legacy dispatch: no record carried, runtime never touched.
    return { action: 'absent' };
  }

  const active = runtime.getActiveProvider();
  const normalizedCarried = normalizePulledProviderName(carried.providerId);
  const providerDiverges = normalizedCarried !== active.provider;
  const modelDiverges = carried.model !== undefined && carried.model !== active.model;
  if (!providerDiverges && !modelDiverges) {
    log.debug(
      { taskId: context.taskId, provider: active.provider, model: active.model, configVersion: carried.configVersion },
      'ADR-034: dispatched config matches active provider — no correction needed',
    );
    return { action: 'match', active };
  }

  try {
    const applied = runtime.setActiveProvider(carried.providerId, carried.model);
    log.warn(
      {
        taskId: context.taskId,
        fromProvider: active.provider,
        fromModel: active.model,
        toProvider: applied.provider,
        toModel: applied.model,
        configVersion: carried.configVersion ?? null,
      },
      'ADR-034: dispatch carried a divergent authoritative config — self-corrected active provider before executing',
    );
    return { action: 'corrected', active: applied };
  } catch (err) {
    // Fail OPEN: a carried provider this bot cannot run (unknown name, harness not
    // initialized at boot) must never block execution — run self-resolved and surface
    // the drift loudly so the controller-side record can be fixed.
    log.warn(
      {
        err,
        taskId: context.taskId,
        carriedProvider: carried.providerId,
        carriedModel: carried.model ?? null,
        configVersion: carried.configVersion ?? null,
        activeProvider: active.provider,
        activeModel: active.model,
      },
      'ADR-034: dispatched config diverges but the switch failed — executing on the self-resolved provider (fail-open)',
    );
    return { action: 'failed-open', active };
  }
}
