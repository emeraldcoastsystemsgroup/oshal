/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Mounts the two /api/agents provider surfaces in one place so the swarm extension index stays under its line budget: the ADR-034 per-agent runtime routes wired to the switch seams (resolver, catalog, post-write snapshot refresh) and the fleet-default switch routes over a ProviderSwitchStore on the GUC-wrapped pool. Both share the serviceSecretOr(requiresAuth) mount the bot-node boot pull relies on; each route file decides for itself what a service secret may do.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | One ProviderSwitchStore serves both routers, and the runtime routes get its upsert as writeBotSwitch: a provider pick through PUT /:agentId/runtime now writes the bot's own row in oshal_bot_provider_switch (the only per-bot record that beats the fleet default) under the caller's identity, so the table's operator-only policy — not this file — decides who may. The agent_config record the same PUT persists is the ADR-034 dispatch artefact beneath the fleet row, never a switch.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Supplies resolveFallbackChain from the installed snapshot, so the runtime read carries the administrator's ordered chain to the bot node alongside the provider.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | source 'none' now travels as null, not as []. resolveFallbackChain ended in `?? []`, which told every booting node that the administrator had deliberately chosen no failover whenever nothing was configured - and the node then blanked its own OSHAL_PROVIDER_FALLBACK_ORDER on the strength of it. Absence and a deliberate empty chain are different answers and must stay different on the wire.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | The mount applies serviceSecretOr(requiresAuth) itself instead of trusting a caller-supplied `auth` handler. The posture was correct only because the single caller passed the right guard; it is now fixed at the mount, visible to the controller route inventory and the Security Center scan, and a caller can no longer hand in a weaker one. Behavior is identical.
 */

import type { Application, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { serviceSecretOr } from '@/shared/middleware/authz';
import type { ConfigSyncService } from '@/features/config-sync';
import { ProviderSwitchStore, type AgentConfigService } from '@/features/agent-management';
import {
  installedProviderSwitchCatalog,
  installedProviderSwitchSnapshot,
  resolveInstalledProviderFallbackOrder,
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
 * /api/agents behind serviceSecretOr(requiresAuth): a bot node pulls its own record on boot with
 * X-Service-Secret, everyone else needs an OIDC session. The guard is applied HERE, at the mount,
 * so the posture does not depend on what a caller passes in.
 * @param app - The Express app.
 * @param requiresAuth - The OIDC session guard the service-secret alternative falls back to.
 * @param deps - Config sync, agent config store and the pool.
 * @returns void
 */
export function mountAgentProviderRoutes(app: Application, requiresAuth: RequestHandler, deps: AgentProviderMountDeps): void {
  const resolveSwitchFor = (agentId: string) => resolveInstalledProviderSwitch(agentId, registryHarnessEntry(agentId));
  const store = deps.pool ? new ProviderSwitchStore(deps.pool) : undefined;
  app.use('/api/agents', serviceSecretOr(requiresAuth), createConfigRuntimeRoutes(
    deps.configSyncService,
    deps.agentConfigService,
    {
      resolveSwitch: resolveSwitchFor,
      catalog: installedProviderSwitchCatalog,
      // source 'none' means no row and no environment override named a chain. That is NOT an
      // empty chain: returning [] here told every booting node "the administrator chose no
      // failover", which blanked OSHAL_PROVIDER_FALLBACK_ORDER on each pull in the default
      // configuration. Only a real answer travels; absence stays absent.
      resolveFallbackChain: resolveInstalledProviderFallbackOrder,
      // A provider pick is the bot's own switch row (migration 147, scope = agent id), written under
      // the request identity so the table's operator-only policy is the enforcement.
      ...(store ? { writeBotSwitch: async (agentId, providerId, modelId, updatedBy) => { await store.upsert(agentId, providerId, modelId, updatedBy); } } : {}),
      // The row this route writes must be read now, not on the timer.
      onRuntimeChanged: async () => { await installedProviderSwitchSnapshot()?.refresh(); },
    },
  ));
  // The fleet-default switch (migration 147): one row, one write, resolved above the registry literal;
  // DELETE /provider-switch/:agentId releases a bot's own row back to it.
  app.use('/api/agents', serviceSecretOr(requiresAuth), createProviderSwitchRoutes({
    store,
    snapshot: installedProviderSwitchSnapshot,
    catalog: installedProviderSwitchCatalog,
  }));
}
