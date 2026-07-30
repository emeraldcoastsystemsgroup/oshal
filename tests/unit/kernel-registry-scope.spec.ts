/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Anti-rot guard for SWARM_REGISTRY=kernel. The kernel identity set is Tier-0 baselines (swarm-store-migration-plan §2) plus the bots the ten kernel swarm-apps/ manifests declare (kernel-vs-app-packages §2e) — so it must equal {general-bot} u {every bots[].agentId in swarm-apps/*.yaml}. Recomputed here from the manifests on disk: add or carve a kernel manifest and this fails until the registry list is updated, which is how the routability-critical-bots list avoided rotting like verify-bot-health.sh did. Also pins that kernel is a strict subset of the default lineup and that app bots are actually excluded.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';

import { getActiveRegistry, kernelBotAgentIds } from '@/app/extensions/swarm/swarm-bot-registry';

/** general-bot is Tier-0 and declared by no manifest — the one identity that must be added by hand. */
const GENERAL_BOT = 'a0000000-0000-0000-0000-000000000099';

/** Recompute the kernel identity set from the manifests on disk. */
function agentIdsFromKernelManifests(): Set<string> {
  const dir = resolve(__dirname, '../../swarm-apps');
  const ids = new Set<string>([GENERAL_BOT]);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.yaml'))) {
    const m = yaml.load(readFileSync(resolve(dir, f), 'utf8')) as { bots?: Array<{ agentId?: string }> } | null;
    for (const b of m?.bots ?? []) if (b.agentId) ids.add(b.agentId);
  }
  return ids;
}

describe('SWARM_REGISTRY=kernel exposes the kernel line and nothing an app brought', () => {
  it('matches {general-bot} + every bot the kernel manifests declare', () => {
    const fromDisk = agentIdsFromKernelManifests();
    const declared = kernelBotAgentIds();
    // Sorted arrays so a drift reports WHICH id, not just "sets differ".
    expect([...declared].sort()).toEqual([...fromDisk].sort());
  });

  it('is a strict subset of the default lineup — kernel may never invent a bot', () => {
    const dflt = new Set(getActiveRegistry().map((b) => b.agentId));
    for (const id of kernelBotAgentIds()) expect(dflt.has(id)).toBe(true);
  });

  it('actually drops the app-bot catalog', () => {
    const before = process.env.SWARM_REGISTRY;
    try {
      process.env.SWARM_REGISTRY = 'kernel';
      const names = getActiveRegistry().map((b) => b.name);
      // Carved store apps (ADR-085) — a customer box running core + one app must not inherit these.
      for (const app of ['pumpkin-bot', 'eats-concierge', 'rides-concierge', 'spotify-concierge',
        'movies-concierge', 'travel-concierge', 'shopping-concierge', 'trading-analyst',
        'finance-analyst', 'drone-operator', 'camera-operator', 'sat-operator']) {
        expect(names).not.toContain(app);
      }
      // The routing/control identities that must survive, or the swarm cannot dispatch at all.
      for (const keep of ['general-bot', 'project-manager', 'queue-bot', 'oshal-assistant']) {
        expect(names).toContain(keep);
      }
    } finally {
      if (before === undefined) delete process.env.SWARM_REGISTRY; else process.env.SWARM_REGISTRY = before;
    }
  });

  it('leaves the default and full lineups untouched', () => {
    const before = process.env.SWARM_REGISTRY;
    try {
      delete process.env.SWARM_REGISTRY;
      const dflt = getActiveRegistry().length;
      process.env.SWARM_REGISTRY = 'kernel';
      const kernel = getActiveRegistry().length;
      expect(kernel).toBeLessThan(dflt);
      expect(kernel).toBe(kernelBotAgentIds().size);
    } finally {
      if (before === undefined) delete process.env.SWARM_REGISTRY; else process.env.SWARM_REGISTRY = before;
    }
  });
});
