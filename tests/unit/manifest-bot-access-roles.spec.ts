/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D3 / ADR-087 parity: a PACKAGED bot can now be scoped to caller roles like a core bot. Before this the registrar silently DROPPED accessRoles, so a manifest bot was open to every caller — Jarvis included — whatever its manifest said. These tests pin the three things that make the field real: fail-closed validation, most-restrictive-wins across duplicate registry definitions (a package must only ever NARROW access, never widen it), and the enforcement point itself.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readManifest } from '../../src/features/swarm-apps';
import { SWARM_ACCESS_ROLES, isSwarmAccessRole, roleCanAccess } from '../../src/shared/types/access-roles';
import {
  isBotAccessibleTo,
  registerAppBots,
  unregisterAppBots,
} from '../../src/app/extensions/swarm/swarm-bot-registry';

/**
 * @description Write a manifest and read it through the real readManifest.
 * @param body - YAML appended to the required name/displayName.
 * @returns The parsed manifest.
 */
function read(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-roles-'));
  const file = join(dir, 'oshal-app.yaml');
  writeFileSync(file, `name: t\ndisplayName: T\n${body}`, 'utf8');
  try {
    return readManifest(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const bot = (extra = '') =>
  `bots:\n  - agentId: aa000000-0000-0000-0000-000000000001\n    name: b1\n${extra}`;

describe('access-role model (ADR-087)', () => {
  it('exposes the roles as data, and narrows only real ones', () => {
    expect([...SWARM_ACCESS_ROLES]).toEqual(['operator', 'swarm', 'jarvis']);
    expect(isSwarmAccessRole('jarvis')).toBe(true);
    expect(isSwarmAccessRole('jarvis ')).toBe(false);
    expect(isSwarmAccessRole('admin')).toBe(false);
  });

  it('an absent declaration is open to every caller (the backward-compat contract)', () => {
    for (const r of SWARM_ACCESS_ROLES) expect(roleCanAccess(undefined, r)).toBe(true);
  });
});

describe('readManifest — bots[].accessRoles fail closed (ADR-085 D3)', () => {
  it('accepts a declared subset of roles', () => {
    expect(read(bot('    accessRoles: [operator, swarm]\n')).bots?.[0].accessRoles).toEqual([
      'operator',
      'swarm',
    ]);
  });

  it('accepts a bot with no accessRoles (open to every caller)', () => {
    expect(read(bot()).bots?.[0].accessRoles).toBeUndefined();
  });

  it('REJECTS an unknown role', () => {
    expect(() => read(bot('    accessRoles: [operator, admin]\n'))).toThrow(/unknown caller role\(s\): admin/);
  });

  // `accessRoles:` with no values parses to NULL in YAML. It is the likeliest author typo, and the
  // one that reads as "no restrictions" — the opposite of what the author meant.
  it('REJECTS an empty/null accessRoles rather than reading it as unrestricted', () => {
    expect(() => read(bot('    accessRoles:\n'))).toThrow(/NON-EMPTY array/);
    expect(() => read(bot('    accessRoles: []\n'))).toThrow(/NON-EMPTY array/);
  });
});

describe('isBotAccessibleTo — enforcement (ADR-085 D3)', () => {
  const APP = 'roles-test-app';
  const ID = 'cc000000-0000-0000-0000-0000000000ff';

  afterEach(() => unregisterAppBots(APP));

  /** @description Register one dynamic app bot with the given roles. @param accessRoles - Roles or undefined. */
  function registerWith(accessRoles?: Array<'operator' | 'swarm' | 'jarvis'>): void {
    registerAppBots(APP, [
      {
        agentId: ID,
        name: 'scoped-bot',
        port: 3010,
        container: 'oshal-api',
        role: '',
        capabilities: [],
        harnessType: 'claude-code',
        apiType: 'claude-code',
        ...(accessRoles ? { accessRoles } : {}),
      } as never,
    ]);
  }

  it('an unknown agentId is open (ADR-087: scoping is a deliberate opt-in)', () => {
    expect(isBotAccessibleTo('99999999-0000-0000-0000-000000000000', 'jarvis')).toBe(true);
  });

  it('a packaged bot with no accessRoles is open to every caller', () => {
    registerWith();
    for (const r of SWARM_ACCESS_ROLES) expect(isBotAccessibleTo(ID, r)).toBe(true);
  });

  // THE parity gap. The registrar used to drop accessRoles entirely, so this was impossible: a
  // packaged bot could not be scoped away from Jarvis no matter what its manifest declared.
  it('a packaged bot scoped to [operator, swarm] is HIDDEN from jarvis but visible to them', () => {
    registerWith(['operator', 'swarm']);
    expect(isBotAccessibleTo(ID, 'jarvis')).toBe(false);
    expect(isBotAccessibleTo(ID, 'operator')).toBe(true);
    expect(isBotAccessibleTo(ID, 'swarm')).toBe(true);
  });

  it('a packaged bot scoped to [jarvis] is reachable by jarvis only', () => {
    registerWith(['jarvis']);
    expect(isBotAccessibleTo(ID, 'jarvis')).toBe(true);
    expect(isBotAccessibleTo(ID, 'operator')).toBe(false);
  });

  // Most-restrictive-wins. getActiveRegistry() concatenates statics with dynamic app bots, so one
  // agentId can carry TWO definitions; the old find() took the first (statics) and ignored the
  // other. That let a package WIDEN a core bot's reach by re-declaring its agentId with no roles.
  // Every matching definition must now permit the caller.
  it('two definitions for one agentId: the RESTRICTION wins — a package cannot widen access', () => {
    // Two dynamic registrations under different app names, same agentId: one open, one scoped.
    registerAppBots('app-open', [
      { agentId: ID, name: 'open', port: 3010, container: 'oshal-api', role: '', capabilities: [], harnessType: 'claude-code', apiType: 'claude-code' } as never,
    ]);
    registerAppBots('app-scoped', [
      { agentId: ID, name: 'scoped', port: 3010, container: 'oshal-api', role: '', capabilities: [], harnessType: 'claude-code', apiType: 'claude-code', accessRoles: ['operator'] } as never,
    ]);
    try {
      // The open declaration must NOT be able to unlock jarvis access.
      expect(isBotAccessibleTo(ID, 'jarvis')).toBe(false);
      expect(isBotAccessibleTo(ID, 'operator')).toBe(true);
    } finally {
      unregisterAppBots('app-open');
      unregisterAppBots('app-scoped');
    }
  });
});
