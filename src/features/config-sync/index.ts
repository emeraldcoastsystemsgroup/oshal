/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial placeholder barrel for config sync feature
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Implemented ConfigSyncService — bidirectional any-bot config ownership/sync (ADR-034)
 */

/**
 * @description Barrel export for the config-sync feature — the bidirectional
 * configuration ownership/sync engine described in ADR-006 and made concrete in ADR-034.
 * OSHAL owns the authoritative per-agent runtime-param record; the any-bot owns the
 * mechanics. Push-down via switchProvider, broadcast-up via the swarm.config-change mesh
 * channel, central-wins reconciliation with versioning + audit.
 */
export {
  ConfigSyncService,
  type ConfigSyncDeps,
  type ConfigChangePayload,
  type RuntimeParams,
  type PushResult,
} from './services/config-sync-service';
