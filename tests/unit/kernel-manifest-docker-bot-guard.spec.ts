/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | K4 guard (BACKLOG kernel audit 2026-07-29): self-healing-bot mounts /var/run/docker.sock (root-equivalent on the host) and reaches every deployment through the kernel-resident swarm-apps/intelligent-processing.yaml — with NO accessRoles it was open to every caller under ADR-087's omitted=open rule. This spec walks EVERY kernel-resident manifest and asserts that any bot with host-privileged capabilities (docker / container-restart / infrastructure-remediation / self-healing) declares accessRoles that exclude user-facing delegation — verified through the REAL roleCanAccess + manifestBotDefinition functions, not string matching, so widening the roles or dropping the declaration goes red the same way the runtime would open up. Also pins the concrete case: the a…030 self-healing declaration denies the 'jarvis' caller.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { roleCanAccess, isSwarmAccessRole, type SwarmAccessRole } from '../../src/shared/types/access-roles';
import { manifestBotDefinition } from '../../src/app/extensions/swarm/manifest-bot-definition';

/**
 * Capabilities that mean "this bot can act on the HOST / the container runtime". A bot
 * declaring any of these from a kernel-resident manifest must be scoped away from
 * user-facing delegation — the docker socket is root-equivalent on the host.
 */
const HOST_PRIVILEGED_CAPABILITIES = new Set([
  'docker',
  'container-restart',
  'infrastructure-remediation',
  'self-healing',
]);

interface ManifestBot {
  agentId?: string;
  name?: string;
  capabilities?: string[];
  accessRoles?: string[];
}

function kernelManifestFiles(): string[] {
  const dir = path.resolve(__dirname, '../../swarm-apps');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => path.join(dir, f));
}

function botsOf(file: string): ManifestBot[] {
  const doc = yaml.load(fs.readFileSync(file, 'utf8')) as { bots?: ManifestBot[] } | null;
  return Array.isArray(doc?.bots) ? doc!.bots! : [];
}

function isHostPrivileged(bot: ManifestBot): boolean {
  return (bot.capabilities ?? []).some((c) => HOST_PRIVILEGED_CAPABILITIES.has(String(c)));
}

describe('kernel-resident manifests: docker-socket / host-privileged bots are caller-scoped (K4)', () => {
  it('finds the kernel manifest set (the guard is meaningless against an empty directory)', () => {
    expect(kernelManifestFiles().length).toBeGreaterThan(0);
  });

  it('every host-privileged bot in a kernel manifest declares accessRoles that DENY user-facing delegation', () => {
    const offenders: string[] = [];
    for (const file of kernelManifestFiles()) {
      for (const bot of botsOf(file)) {
        if (!isHostPrivileged(bot)) continue;
        const roles = bot.accessRoles;
        const name = `${path.basename(file)} → ${bot.name ?? bot.agentId ?? '?'}`;
        // Undeclared/empty = open to EVERY caller (ADR-087) — exactly the K4 defect.
        if (!Array.isArray(roles) || roles.length === 0 || !roles.every(isSwarmAccessRole)) {
          offenders.push(`${name}: accessRoles missing/empty/unknown (${JSON.stringify(roles)})`);
          continue;
        }
        // Assert through the REAL access function: the user-facing 'jarvis' caller must be
        // denied. This is the same check isBotAccessibleTo/most-restrictive-wins runs.
        if (roleCanAccess(roles as SwarmAccessRole[], 'jarvis')) {
          offenders.push(`${name}: accessRoles ${JSON.stringify(roles)} still admit the 'jarvis' caller`);
        }
      }
    }
    expect(
      offenders,
      'a kernel-resident manifest declares a host-privileged (docker-capable) bot reachable by user delegation — '
        + 'scope it accessRoles [operator, swarm] or move it out of swarm-apps/ (K4, BACKLOG kernel audit)',
    ).toEqual([]);
  });

  it('the self-healing-bot declaration itself resolves to a registry definition that denies jarvis', () => {
    const file = kernelManifestFiles().find((f) => f.endsWith('intelligent-processing.yaml'));
    expect(file, 'intelligent-processing.yaml missing from swarm-apps/').toBeTruthy();
    const bot = botsOf(file!).find((b) => b.name === 'self-healing-bot');
    expect(bot, 'self-healing-bot no longer declared — update this guard alongside the manifest move').toBeTruthy();
    // Through the REAL manifest→registry mapping: the definition the loader would register
    // must carry the restriction (a mapper that dropped accessRoles would silently re-open it).
    const def = manifestBotDefinition({
      agentId: String(bot!.agentId),
      name: String(bot!.name),
      capabilities: bot!.capabilities,
      accessRoles: bot!.accessRoles as SwarmAccessRole[],
    } as never);
    expect(def.accessRoles).toBeDefined();
    expect(roleCanAccess(def.accessRoles, 'jarvis')).toBe(false);
    expect(roleCanAccess(def.accessRoles, 'operator')).toBe(true);
    expect(roleCanAccess(def.accessRoles, 'swarm')).toBe(true);
  });
});
