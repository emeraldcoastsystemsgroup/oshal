/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | K7+K8 guard (BACKLOG kernel audit 2026-07-29). K7: the internal-machinery bots (build pipeline, QA, research, security triage, vault broker, remote-worker rail) shipped with NO accessRoles, and ADR-087's omitted=open made them live Jarvis / inbound-A2A call-out candidates with the shared workspace mounted rw — security-analyst's route was operator-gated while its IDENTITY was not, so a call-out reached it around the gate. This spec walks a NAMED machinery list and asserts, through the REAL roleCanAccess/isBotAccessibleTo functions, that every definition in BOTH registries declares valid roles that DENY the 'jarvis' caller — dropping a declaration or widening it goes red the same way the runtime would open up. The wave-2 CONSTRAINT is pinned as its own case: general-bot (the ADR-083 task-lane fallback) MUST keep 'jarvis' or every Jarvis task ticket strands. K8: the core-pinned remote-worker identities (apply-operator, linkedin-profile-operator — dispatched by browser-task-dispatch/profile-studio-dispatch) must exist in BOTH registries under one name, so a kernel filter or the default lineup can never silently drop an identity core code dispatches to.
 */

import { describe, expect, it } from 'vitest';
import { SWARM_BOT_REGISTRY, isBotAccessibleTo } from '../../src/app/extensions/swarm/swarm-bot-registry';
import { LOCAL_BOT_REGISTRY } from '../../src/app/extensions/swarm/swarm-bot-registry-local';
import { isSwarmAccessRole, roleCanAccess, type SwarmAccessRole } from '../../src/shared/types/access-roles';

/**
 * The bots the platform treats as INTERNAL MACHINERY (K7 + the wave-2 set): never a Jarvis
 * discovery/call-out target. Adding a bot here is a decision, not bookkeeping — see
 * docs/building-a-bot.md and ADR-087.
 */
const INTERNAL_MACHINERY = [
  // wave-2 / ADR-087 originals
  'project-manager', 'task-manager', 'queue-bot', 'agent-factory', 'oshal-developer', 'codex-packer',
  // K7 close-out
  'code-developer', 'code-reviewer', 'test-engineer', 'tester-bot', 'devops-bot', 'research-bot',
  'security-analyst', 'vault-bot',
  // K7/K8: desktop-driving remote-worker rail
  'apply-operator', 'linkedin-profile-operator',
] as const;

/** Core-code-pinned identities that MUST resolve identically in both registries (K8). */
const CORE_PINNED: ReadonlyArray<{ agentId: string; name: string; pinnedBy: string }> = [
  { agentId: 'cb000000-0000-0000-0000-000000000003', name: 'apply-operator', pinnedBy: 'browser-task-dispatch (apply rail)' },
  { agentId: 'cb000000-0000-0000-0000-000000000004', name: 'linkedin-profile-operator', pinnedBy: 'src/app/profile-studio-dispatch.ts' },
];

const allDefs = (name: string) =>
  [...LOCAL_BOT_REGISTRY, ...SWARM_BOT_REGISTRY].filter((b) => b.name === name);

describe('K7: internal machinery declares accessRoles that deny user-facing delegation', () => {
  it('every machinery bot exists in at least one registry (the list must not rot)', () => {
    for (const name of INTERNAL_MACHINERY) {
      expect(allDefs(name).length, `${name} is in the machinery list but in NEITHER registry`).toBeGreaterThan(0);
    }
  });

  it('every definition of every machinery bot declares valid, non-empty accessRoles', () => {
    const offenders: string[] = [];
    for (const name of INTERNAL_MACHINERY) {
      for (const def of allDefs(name)) {
        const roles = def.accessRoles;
        if (!Array.isArray(roles) || roles.length === 0 || !roles.every(isSwarmAccessRole)) {
          offenders.push(`${name} (${def.agentId ?? 'no-id'}): accessRoles ${JSON.stringify(roles)}`);
        }
      }
    }
    expect(
      offenders,
      'an internal-machinery bot ships UNSCOPED — ADR-087 omitted=open makes it a live Jarvis/'
        + 'inbound-A2A call-out candidate with the shared workspace mounted rw (K7)',
    ).toEqual([]);
  });

  it("every machinery definition DENIES the 'jarvis' caller — through the real access function", () => {
    const offenders: string[] = [];
    for (const name of INTERNAL_MACHINERY) {
      for (const def of allDefs(name)) {
        if (roleCanAccess(def.accessRoles, 'jarvis')) {
          offenders.push(`${name} (${def.agentId ?? 'no-id'}): ${JSON.stringify(def.accessRoles)}`);
        }
      }
    }
    expect(offenders, "machinery must exclude 'jarvis' — user delegation reaches it otherwise (ADR-087)").toEqual([]);
  });

  it("security-analyst's IDENTITY now matches its operator-gated route — the around-the-gate call-out is closed", () => {
    // The route (security-routes) was requiresOperator-gated but the identity was open, so a
    // call-out reached the bot around the gate. Asserted through the live active-registry check.
    expect(isBotAccessibleTo('a0000000-0000-0000-0000-000000000047', 'jarvis')).toBe(false);
    expect(isBotAccessibleTo('a0000000-0000-0000-0000-000000000047', 'swarm')).toBe(true);
  });
});

describe("K7 wave-2 constraint: general-bot KEEPS the 'jarvis' role", () => {
  it('general-bot is scoped in BOTH registries, and every definition admits jarvis + operator + swarm', () => {
    const defs = allDefs('general-bot');
    expect(defs.length, 'general-bot missing from a registry').toBeGreaterThanOrEqual(2);
    for (const def of defs) {
      expect(def.accessRoles, 'general-bot must be DELIBERATELY scoped (not omitted-open)').toBeDefined();
      for (const role of ['jarvis', 'operator', 'swarm'] as SwarmAccessRole[]) {
        expect(
          roleCanAccess(def.accessRoles, role),
          `general-bot denies '${role}' — it is the ADR-083 task-lane fallback; without 'jarvis' every `
            + 'Jarvis-sourced task ticket strands with no owner (wave-2 constraint)',
        ).toBe(true);
      }
    }
    // And through the live most-restrictive-wins path (a second colliding definition can only narrow).
    expect(isBotAccessibleTo('a0000000-0000-0000-0000-000000000099', 'jarvis')).toBe(true);
  });
});

describe('K8: core-pinned identities exist in BOTH registries under ONE name', () => {
  it.each(CORE_PINNED)('$name ($pinnedBy) resolves identically in local and full lineups', ({ agentId, name }) => {
    const inLocal = LOCAL_BOT_REGISTRY.find((b) => b.agentId === agentId);
    const inFull = SWARM_BOT_REGISTRY.find((b) => b.agentId === agentId);
    expect(inLocal, `${name} missing from LOCAL_BOT_REGISTRY — the DEFAULT lineup serves this core-pinned identity as unknown (=open, unattributable)`).toBeTruthy();
    expect(inFull, `${name} missing from SWARM_BOT_REGISTRY — SWARM_REGISTRY=full drops a core-pinned identity`).toBeTruthy();
    expect(inLocal!.name).toBe(name);
    expect(inFull!.name).toBe(name);
  });
});
