/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Fail-loud swarm-wiring audit: a manifest bot with no endpoint-registry entry compiles green but throws at runtime (the build-your-own-swarm-app "compiles-but-fails" trap). Catch it at boot.
 */

/**
 * Boot-time guard for the build-your-own-swarm-app "compiles-but-fails checklist": a manifest can declare
 * a bot, register its tools, and seed its authorizations — yet if that bot has NO entry in
 * swarm-bot-registry-local.ts, `BotNodeClient` can't resolve it and ANY execution throws at runtime,
 * green build and all. This audit cross-checks every ACTIVE manifest's bots against the endpoint registry
 * and logs loudly. Opt-in hard fail via STRICT_SWARM_WIRING=true (for CI). See ADR-061.
 */
import { createChildLogger } from '@/shared/logger';
import { getActiveRegistry } from './swarm-bot-registry';
import type { SwarmAppService } from '@/features/swarm-apps';

const logger = createChildLogger({ module: 'validate-swarm-wiring' });

export interface ManifestAppBots { appName: string; bots: Array<{ name: string; agentId: string }>; }
export interface WiringIssue { appName: string; botName: string; agentId: string; reason: 'no-registry-entry'; }

/**
 * PURE: return one issue per active-manifest bot whose agentId is absent from the endpoint registry.
 * Decoupled from SwarmAppService/the registry module so it unit-tests on plain data.
 */
export function findUnregisteredBots(apps: ManifestAppBots[], registeredAgentIds: Set<string>): WiringIssue[] {
  const issues: WiringIssue[] = [];
  for (const app of apps) {
    for (const bot of app.bots) {
      if (!bot.agentId) continue; // foundation/base personas have no agentId — nothing to resolve
      if (!registeredAgentIds.has(bot.agentId)) {
        issues.push({ appName: app.appName, botName: bot.name, agentId: bot.agentId, reason: 'no-registry-entry' });
      }
    }
  }
  return issues;
}

/**
 * Cross-check every ACTIVE swarm app's declared bots against the endpoint registry and log loudly.
 * Non-fatal by default (a bad manifest shouldn't brick boot); set STRICT_SWARM_WIRING=true to throw.
 */
export async function auditSwarmBotWiring(swarmAppService: SwarmAppService): Promise<WiringIssue[]> {
  let apps: ManifestAppBots[] = [];
  try {
    const summaries = await swarmAppService.listApps('active');
    const records = await Promise.all(summaries.map((s) => swarmAppService.getApp(s.name)));
    apps = records
      .filter((r): r is NonNullable<typeof r> => Boolean(r))
      .map((r) => ({
        appName: r.name,
        bots: (r.manifest.bots ?? [])
          .filter((b): b is typeof b & { agentId: string } => typeof b.agentId === 'string' && b.agentId.length > 0)
          .map((b) => ({ name: b.name, agentId: b.agentId })),
      }));
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Swarm-wiring audit could not read loaded apps (non-fatal)');
    return [];
  }

  const registered = new Set(
    getActiveRegistry().map((b) => b.agentId).filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  const issues = findUnregisteredBots(apps, registered);

  if (issues.length === 0) {
    logger.info({ apps: apps.length }, 'Swarm-wiring audit OK — every active manifest bot resolves in the endpoint registry');
    return issues;
  }

  for (const i of issues) {
    logger.error(
      { appName: i.appName, botName: i.botName, agentId: i.agentId },
      `SWARM WIRING GAP: app "${i.appName}" declares bot "${i.botName}" (${i.agentId}) but it is NOT in `
      + `swarm-bot-registry-local.ts — it will FAIL at execute time (compiles-but-fails). Add a registry entry `
      + `(inline reason+tool bots use port:3010, container:'oshal-api', harnessType:'claude-code').`,
    );
  }
  logger.error({ count: issues.length }, `Swarm-wiring audit FAILED — ${issues.length} bot(s) declared but not registered`);

  if (process.env.STRICT_SWARM_WIRING === 'true') {
    throw new Error(`Swarm-wiring audit failed: ${issues.length} manifest bot(s) missing a registry entry`);
  }
  return issues;
}
