/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial ConfigSyncService — bidirectional any-bot config sync (ADR-034): push-down via switchProvider, broadcast-up reconcile via the swarm.config-change mesh channel, with versioning + audit
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Audit writes to the EXISTING config_sync_log table (migration 001 / ADR-006) — resolve agent UUID for the FK, map direction to push/pull, record version before/after (docker smoke caught the table already existed)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Wrap the config-change mesh handler in runWithSystemIdentity: mesh poll callbacks carry no AsyncLocalStorage identity, so recordSyncLog's pool queries ran identity-less — under OSHAL_DB_GUC_STRICT=deny they would be stamped anonymous non-operator (denied/zero rows) the moment agents/config_sync_log gain RLS. Same shape as the remote task-result landing fix; the sentinel is the sanctioned trusted-background marker.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Preserve independent model changes without smuggling a disabled provider through the mutation. A model-only push resolves the live bot's current provider strictly as transport context, then persists only the requested model; inability to resolve that context refuses before the authoritative record advances.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: remove the optional raw credential carrier from config synchronization; push-down transports provider/model metadata only.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Close bot-node broadcast parity: accepted bot-local changes now re-apply to the registered endpoint by default so another replica converges without restart, while a transport-only apply seam prevents that confirmation push from recording or auditing a second authoritative version.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import {
  MESH_CHANNELS,
  type MeshCommunicationService,
  type MeshEnvelope,
  type BotNodeClient,
  type AgentConfigService,
} from '@/features/agent-management';

const logger = createChildLogger({ module: 'config-sync' });

/** Consumer id for the controller's config-change subscription. */
const CONTROLLER_CONSUMER_ID = 'config-sync-controller';
/** Config-value key under which the authoritative version counter is stored. */
const VERSION_KEY = 'configVersion';

/**
 * @description Authoritative runtime parameters OSHAL owns for an any-bot (ADR-034).
 * Credentials are intentionally excluded from this contract and transport.
 */
export interface RuntimeParams {
  providerId?: string;
  modelId?: string;
  mode?: string;
  requestTimeoutMs?: number;
}

/**
 * @description Payload of a bot -> controller config-change broadcast on the
 * MESH_CHANNELS.configChange channel.
 */
export interface ConfigChangePayload {
  agentId: string;
  params: RuntimeParams;
  /** Where the change originated: the bot's own UI/local change, or a sub-swarm it owns. */
  source: 'bot-local' | 'sub-swarm' | string;
  /** Version the bot believed it had when it changed (optional, for drift detection). */
  configVersion?: number;
}

/**
 * @description Outcome of a push-down to a live bot.
 */
export interface PushResult {
  pushed: boolean;
  reason?: string;
  newVersion?: number;
}

/** @description Internal outcome of applying config to a registered live-bot endpoint. */
interface LiveApplyResult {
  /** Whether a remote endpoint existed and a delivery was therefore required. */
  attempted: boolean;
  /** Whether the registered endpoint accepted the provider/model mutation. */
  applied: boolean;
  /** Stable diagnostic for a required delivery that did not apply. */
  reason?: string;
}

/**
 * @description Construction dependencies for ConfigSyncService.
 */
export interface ConfigSyncDeps {
  mesh: MeshCommunicationService;
  agentConfig: AgentConfigService;
  botNodeClient: BotNodeClient;
  /** Optional Postgres pool for the config_sync_log audit table (best-effort if absent). */
  pool?: Pool;
  /**
   * When true, after accepting a bot-reported change the controller applies the accepted
   * authoritative value to the registered endpoint so another replica converges. Defaults true;
   * false is reserved for standalone/test deployments that intentionally disable propagation.
   */
  rePushOnConflict?: boolean;
}

/**
 * @description Bidirectional any-bot configuration sync (ADR-034).
 *
 * OSHAL owns the authoritative per-agent runtime-param record (Postgres agent_config);
 * the any-bot owns the mechanics of applying it. This service implements both edges:
 *
 *  - push-down: {@link pushToBot} calls the bot's PUT /api/llm-provider (via
 *    BotNodeClient.switchProvider) when an OSHAL-side config change occurs, then records
 *    the new authoritative value + version.
 *  - broadcast-up: {@link start} subscribes to the swarm.config-change mesh channel; when a
 *    bot reports a locally-originated change, {@link reconcile} records it into the
 *    authoritative store, bumps the version, writes one audit row, and by default confirms the
 *    accepted value through the registered endpoint so another live replica converges.
 *
 * Secrets are never persisted to the record or logged.
 */
export class ConfigSyncService {
  private readonly mesh: MeshCommunicationService;
  private readonly agentConfig: AgentConfigService;
  private readonly botNodeClient: BotNodeClient;
  private readonly pool?: Pool;
  private readonly rePushOnConflict: boolean;
  private started = false;

  constructor(deps: ConfigSyncDeps) {
    this.mesh = deps.mesh;
    this.agentConfig = deps.agentConfig;
    this.botNodeClient = deps.botNodeClient;
    this.pool = deps.pool;
    this.rePushOnConflict = deps.rePushOnConflict ?? true;
  }

  /**
   * @description Starts the controller-side subscription to the config-change broadcast
   * channel. Idempotent — a second call is a no-op.
   * @returns void
   */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.mesh.subscribe(
      MESH_CHANNELS.configChange,
      CONTROLLER_CONSUMER_ID,
      async (envelope: MeshEnvelope) => {
        // Mesh poll callbacks have no request identity; mark this trusted background
        // work with the positive SYSTEM sentinel so its audit/config DB writes are
        // never the denied identity-less branch under OSHAL_DB_GUC_STRICT=deny.
        await runWithSystemIdentity(() => this.handleConfigChange(envelope));
      },
    );
    logger.info({ channel: MESH_CHANNELS.configChange }, 'Config-sync controller subscription started');
  }

  /**
   * @description Pushes an OSHAL-originated config change down to a live bot and records
   * the new authoritative value. Failures are surfaced (logged at ERROR and returned),
   * never silently swallowed — a swallowed failure would re-introduce the ownership fight.
   *
   * @param agentId - Target agent (UUID or bot name).
   * @param params - Runtime params OSHAL wants the bot to run with.
   * @returns Push result with the new authoritative version when applied.
   */
  async pushToBot(
    agentId: string,
    params: RuntimeParams,
  ): Promise<PushResult> {
    // A bot that is local to this process (e.g. the PM on the controller) has no remote
    // endpoint — record authoritatively without an HTTP push.
    const delivery = await this.applyToLiveBot(agentId, params);
    if (delivery.attempted && !delivery.applied) {
      logger.error(
        { agentId, providerId: params.providerId, model: params.modelId, reason: delivery.reason },
        'Config push-down to bot failed — authoritative record NOT advanced',
      );
      return { pushed: false, reason: delivery.reason };
    }

    const { before, after } = await this.recordAuthoritative(agentId, params, 'oshal-push');
    await this.writeAudit({
      agentId,
      direction: 'push-down',
      before,
      after,
      changes: stripUndefined(params),
      applied: delivery.applied,
    });
    logger.info(
      {
        agentId,
        providerId: params.providerId,
        model: params.modelId,
        newVersion: after,
        applied: delivery.applied,
      },
      'Config pushed down and recorded authoritatively',
    );
    return { pushed: delivery.applied, newVersion: after };
  }

  /**
   * @description Applies provider/model metadata to the registered live-bot endpoint without
   * mutating the authoritative store or audit log. Keeping transport separate is load-bearing:
   * reconciliation records a bot-local change exactly once, then uses this seam to make a peer
   * replica converge without producing a second configVersion or audit entry.
   * @param agentId - Logical agent whose registered endpoint should receive the value.
   * @param params - Accepted or requested runtime parameters.
   * @returns Whether delivery was required and whether it applied.
   */
  private async applyToLiveBot(
    agentId: string,
    params: RuntimeParams,
  ): Promise<LiveApplyResult> {
    if (!this.botNodeClient.hasEndpoint(agentId)) {
      return { attempted: false, applied: false };
    }

    const transportProvider = await this.resolveTransportProvider(agentId, params);
    if (!transportProvider) {
      return {
        attempted: true,
        applied: false,
        reason: 'Live bot provider could not be resolved for a model-only update',
      };
    }

    try {
      await this.botNodeClient.switchProvider(agentId, transportProvider, params.modelId);
      return { attempted: true, applied: true };
    } catch (err) {
      return {
        attempted: true,
        applied: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * @description Resolve the provider required by the bot-node switch transport. A provider
   * supplied by the caller is authoritative for this change. For a model-only mutation, read the
   * live provider without adding it to `params`, so the disabled/pinned value is never persisted
   * as though the caller changed it.
   * @param agentId - Target bot.
   * @param params - Requested authoritative mutation.
   * @returns Provider used only for the push transport, or undefined when it cannot be proven.
   */
  private async resolveTransportProvider(
    agentId: string,
    params: RuntimeParams,
  ): Promise<string | undefined> {
    const requested = params.providerId?.trim();
    if (requested) {
      return requested;
    }
    try {
      const active = await this.botNodeClient.getProvider(agentId);
      return active?.provider?.trim() || undefined;
    } catch (err) {
      logger.error({ err, agentId }, 'Failed to resolve live provider for model-only config push');
      return undefined;
    }
  }

  /**
   * @description Reconciles a bot-reported local config change into the authoritative
   * record. The controller stays system-of-record by accepting the bot's change once. By
   * default it then confirms that accepted value through the registered endpoint so another
   * replica converges; the confirmation is transport-only and cannot bump the version again.
   *
   * @param payload - The reported change.
   * @returns The new authoritative version recorded.
   */
  async reconcile(payload: ConfigChangePayload): Promise<number> {
    const { agentId, params, source } = payload;
    const { before, after } = await this.recordAuthoritative(agentId, params, source);
    await this.writeAudit({
      agentId,
      direction: 'broadcast-up',
      before,
      after,
      changes: stripUndefined(params),
      applied: true,
    });
    logger.info(
      { agentId, source, providerId: params.providerId, model: params.modelId, newVersion: after },
      'Reconciled bot-reported config change into authoritative record',
    );

    if (this.rePushOnConflict) {
      // Confirm the newly authoritative value through the registered endpoint. In a replicated
      // service this may land on a peer; X-Config-Source: oshal-push prevents a broadcast loop.
      const delivery = await this.applyToLiveBot(agentId, params);
      if (delivery.attempted && !delivery.applied) {
        logger.warn(
          { agentId, reason: delivery.reason },
          'Accepted config was recorded, but replica convergence push did not apply',
        );
      }
    }
    return after;
  }

  /**
   * @description Mesh subscription handler — validates the envelope and delegates to reconcile.
   * @param envelope - Raw mesh envelope from the config-change channel.
   * @returns void
   */
  private async handleConfigChange(envelope: MeshEnvelope): Promise<void> {
    const payload = envelope.payload as unknown as ConfigChangePayload;
    if (!payload || typeof payload.agentId !== 'string' || !payload.params) {
      logger.warn({ correlationId: envelope.correlationId }, 'Ignoring malformed config-change envelope');
      return;
    }
    await this.reconcile(payload);
  }

  /**
   * @description Persists params + a bumped version into the authoritative agent_config
   * record. Credentials are never written here.
   * @param agentId - Target agent.
   * @param params - Params to record.
   * @param source - Origin tag for the version bump.
   * @returns The version before and after the change.
   */
  private async recordAuthoritative(
    agentId: string,
    params: RuntimeParams,
    source: string,
  ): Promise<{ before: number; after: number }> {
    const current = await this.agentConfig.getConfig(agentId);
    const before = Number(current?.values?.[VERSION_KEY] ?? 0);
    const after = Number.isFinite(before) ? before + 1 : 1;
    await this.agentConfig.setConfigValues(agentId, {
      ...stripUndefined(params),
      [VERSION_KEY]: after,
      configUpdatedBy: source,
    });
    return { before, after };
  }

  /**
   * @description Best-effort audit row into the existing config_sync_log table (migration 001 /
   * ADR-006). The FK requires the canonical agent UUID, so the agent reference is resolved
   * first; direction maps to the table's push/pull enum (push-down -> push, broadcast-up ->
   * pull). Non-fatal: the sync already succeeded, so a failed audit is logged, never thrown.
   * @param entry - Audit fields (resolved agent ref, direction, before/after version, changes).
   * @returns void
   */
  private async writeAudit(entry: {
    agentId: string;
    direction: 'push-down' | 'broadcast-up';
    before: number;
    after: number;
    changes: Record<string, unknown>;
    applied: boolean;
  }): Promise<void> {
    if (!this.pool) {
      return;
    }
    try {
      const resolved = await this.pool.query<{ id: string }>(
        `SELECT agent_id::text AS id FROM agents
         WHERE agent_id::text = $1 OR lower(name) = lower($1) LIMIT 1`,
        [entry.agentId],
      );
      const agentUuid = resolved.rows[0]?.id;
      if (!agentUuid) {
        logger.warn({ agentId: entry.agentId }, 'Skipping config_sync_log audit — agent not found');
        return;
      }
      const direction = entry.direction === 'push-down' ? 'push' : 'pull';
      const status = entry.applied ? 'applied' : 'pending';
      await this.pool.query(
        `INSERT INTO config_sync_log
           (agent_id, direction, config_version_before, config_version_after, changes, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [agentUuid, direction, entry.before, entry.after, JSON.stringify(entry.changes), status],
      );
    } catch (err) {
      // Non-fatal: the sync itself succeeded; only the audit row failed.
      // Surface at ERROR per the no-empty-catch rule.
      logger.error({ err, agentId: entry.agentId, direction: entry.direction }, 'config_sync_log audit insert failed (non-fatal)');
    }
  }
}

/**
 * @description Removes undefined keys so a JSONB merge does not overwrite with nulls.
 * @param params - Partial runtime params.
 * @returns A record with only the defined keys.
 */
function stripUndefined(params: RuntimeParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}
