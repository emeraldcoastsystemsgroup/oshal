/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Mounts the two /api/agents provider surfaces in one place so the swarm extension index stays under its line budget: the ADR-034 per-agent runtime routes wired to the switch seams (resolver, catalog, post-write snapshot refresh) and the fleet-default switch routes over a ProviderSwitchStore on the GUC-wrapped pool. Both share the serviceSecretOr(requiresAuth) mount the bot-node boot pull relies on; each route file decides for itself what a service secret may do.
 */

import type { Application, RequestHandler } from 'express';
import type { Pool } from 'pg';
import type { ConfigSyncService } from '@/features/config-sync';
import { ProviderSwitchStore, type AgentConfigService } from '@/features/agent-management';
import {
  installedProviderSwitchCatalog,
  installedProviderSwitchSnapshot,
  resolveInstalledProviderSwitch,
} from '@/app/composition/provider-switch-runtime';
import { registryHarnessEntry } from '../swarm-bot-registry';
import { createConfigRuntimeRoutes } from './config-runtime-routes';
import { createProviderSwitchRoutes } from './provider-switch-routes';

/** What the mount needs from the extension bindings. */
export interface AgentProviderMountDeps {
  configSyncService?: ConfigSyncService;
  agentConfigService?: AgentConfigService;
  pool?: Pool;
}

/**
 * @description Mount the per-agent runtime routes and the fleet-default switch routes under
 * /api/agents behind the given auth handler.
 * @param app - The Express app.
 * @param auth - The mount-level auth (serviceSecretOr(requiresAuth) in production).
 * @param deps - Config sync, agent config store and the pool.
 * @returns void
 */
export function mountAgentProviderRoutes(app: Application, auth: RequestHandler, deps: AgentProviderMountDeps): void {
  const resolveSwitchFor = (agentId: string) => resolveInstalledProviderSwitch(agentId, registryHarnessEntry(agentId));
  app.use('/api/agents', auth, createConfigRuntimeRoutes(
    deps.configSyncService,
    deps.agentConfigService,
    {
      resolveSwitch: resolveSwitchFor,
      catalog: installedProviderSwitchCatalog,
      // The record this route writes is the per-bot switch row: re-read it now, not on the timer.
      onRuntimeChanged: async () => { await installedProviderSwitchSnapshot()?.refresh(); },
    },
  ));
  // The fleet-default switch (migration 146): one row, one write, resolved above the registry literal.
  app.use('/api/agents', auth, createProviderSwitchRoutes({
    store: deps.pool ? new ProviderSwitchStore(deps.pool) : undefined,
    snapshot: installedProviderSwitchSnapshot,
    catalog: installedProviderSwitchCatalog,
  }));
}
