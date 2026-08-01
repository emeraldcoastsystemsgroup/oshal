/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Fail-loud swarm-wiring audit: a manifest bot with no endpoint-registry entry compiles green but throws at runtime (the build-your-own-swarm-app "compiles-but-fails" trap). Catch it at boot.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | K3 (BACKLOG kernel audit): the audit matched by agentId ONLY, so one id declared by TWO manifests under DIFFERENT names (codex-packer.yaml + intelligent-processing.yaml both claiming a0…030) reported OK while heartbeats, cost rows and dispatch attribution were ambiguous. findAgentIdCollisions now flags any agentId carrying more than one bot NAME across active manifests — logged as ERROR, thrown under STRICT_SWARM_WIRING=true. Guard: tests/unit/swarm-wiring-collision.spec.ts.
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
/** @description One agentId claimed under more than one bot NAME across active manifests (K3). */
export interface AgentIdCollision { agentId: string; claims: Array<{ appName: string; botName: string }>; }

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
 * PURE: return one collision per agentId that active manifests claim under MORE THAN ONE bot name
 * (K3 — the codex-packer/self-healing-bot shape: a UUID cannot be safely re-pointed once tickets,
 * chat_tasks and Redis heartbeats reference it, so two names on one id is always a defect).
 * Multiple manifests re-declaring the SAME name on one id stay legal (shared framework bots).
 *
 * @param apps - Active manifests' declared bots.
 * @returns One entry per ambiguous agentId, with every claiming app+name.
 */
export function findAgentIdCollisions(apps: ManifestAppBots[]): AgentIdCollision[] {
  const byId = new Map<string, Array<{ appName: string; botName: string }>>();
  for (const app of apps) {
    for (const bot of app.bots) {
      if (!bot.agentId) continue;
      const claims = byId.get(bot.agentId) ?? [];
      claims.push({ appName: app.appName, botName: bot.name });
      byId.set(bot.agentId, claims);
    }
  }
  const collisions: AgentIdCollision[] = [];
  for (const [agentId, claims] of byId.entries()) {
    if (new Set(claims.map((c) => c.botName)).size > 1) {
      collisions.push({ agentId, claims });
    }
  }
  return collisions;
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

  // K3: one agentId under two names is invisible to the id-only check above — it "resolves",
  // to whichever definition wins, and every downstream attribution is ambiguous. Fail loud.
  const collisions = findAgentIdCollisions(apps);
  for (const c of collisions) {
    logger.error(
      { agentId: c.agentId, claims: c.claims },
      `SWARM WIRING COLLISION: agentId ${c.agentId} is declared under ${new Set(c.claims.map((x) => x.botName)).size} different names `
      + `(${c.claims.map((x) => `${x.appName}:${x.botName}`).join(', ')}). One UUID = one bot — give each bot its own agentId `
      + `(a UUID cannot be safely re-pointed once tickets/chat_tasks/heartbeats reference it; see migration 100 for the K3 precedent).`,
    );
  }
  if (collisions.length > 0 && process.env.STRICT_SWARM_WIRING === 'true') {
    throw new Error(`Swarm-wiring audit failed: ${collisions.length} agentId collision(s) across active manifests`);
  }

  if (issues.length === 0) {
    if (collisions.length === 0) {
      logger.info({ apps: apps.length }, 'Swarm-wiring audit OK — every active manifest bot resolves in the endpoint registry');
    }
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
