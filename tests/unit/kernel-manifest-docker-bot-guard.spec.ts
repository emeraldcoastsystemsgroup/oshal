/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | K4 guard (BACKLOG kernel audit 2026-07-29): self-healing-bot mounts /var/run/docker.sock (root-equivalent on the host) and reaches every deployment through the kernel-resident swarm-apps/intelligent-processing.yaml — with NO accessRoles it was open to every caller under ADR-087's omitted=open rule. This spec walks EVERY kernel-resident manifest and asserts that any bot with host-privileged capabilities (docker / container-restart / infrastructure-remediation / self-healing) declares accessRoles that exclude user-facing delegation — verified through the REAL roleCanAccess + manifestBotDefinition functions, not string matching, so widening the roles or dropping the declaration goes red the same way the runtime would open up. Also pins the concrete case: the a…030 self-healing declaration denies the 'jarvis' caller.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | K4 STRICT form (unblocked by the K3 id split): the docker-socket bot is now OUT of the kernel-resident manifest set entirely — no swarm-apps/*.yaml declares ANY host-privileged bot, so a customer box loading the kernel manifests is never handed a root-equivalent identity at all. The seq-1 accessRoles assertion stays as defense-in-depth for the day one returns; the concrete-case test now proves the ABSENCE (intelligent-processing declares no bots; self-healing's new id a0…056 is not in the kernel identity set) instead of the old scoped-presence. Its container remains compose-side behind `profiles: incident, extras` (pinned by compose-tool-auth-defaults.spec.ts) under its own agentId (swarm-wiring-collision.spec.ts).
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { roleCanAccess, isSwarmAccessRole, type SwarmAccessRole } from '../../src/shared/types/access-roles';
import { kernelBotAgentIds } from '../../src/app/extensions/swarm/swarm-bot-registry';

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

  it('K4 STRICT: NO kernel-resident manifest declares a host-privileged bot at all', () => {
    // The strict done-when: the docker-socket bot is OUT of the kernel manifest set entirely —
    // a customer box loading swarm-apps/*.yaml must never be handed a root-equivalent identity.
    // (The scoped-accessRoles test above stays as defense-in-depth should one ever return.)
    const declared: string[] = [];
    for (const file of kernelManifestFiles()) {
      for (const bot of botsOf(file)) {
        if (isHostPrivileged(bot)) declared.push(`${path.basename(file)} → ${bot.name ?? bot.agentId ?? '?'}`);
      }
    }
    expect(
      declared,
      'a kernel-resident manifest declares a host-privileged (docker-capable) bot — the remediation '
        + 'leg belongs in an app-store package, not the kernel set (K4 strict, BACKLOG kernel audit)',
    ).toEqual([]);
  });

  it('pins the concrete K4/K3 outcome: intelligent-processing declares no bots; self-healing is outside the kernel identity set', () => {
    const file = kernelManifestFiles().find((f) => f.endsWith('intelligent-processing.yaml'));
    expect(file, 'intelligent-processing.yaml missing from swarm-apps/').toBeTruthy();
    expect(botsOf(file!), 'intelligent-processing must declare NO bots — its workflow references framework bots by name').toEqual([]);
    // The bot's own (post-K3) identity must not be kernel-resident either: kernel mode may
    // never serve the docker-socket identity, whatever id it carries.
    expect(kernelBotAgentIds().has('a0000000-0000-0000-0000-000000000056')).toBe(false);
    // And a0…030 (in the kernel set via codex-packer.yaml) belongs to the Bot Forge — its
    // kernel-resident declarations must never be host-privileged (covered by the walks above).
  });
});
