/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | K2 guard (BACKLOG kernel audit 2026-07-29): a0…0018 carried THREE names — 'system-architect' (local registry, persona, compose), 'architect-bot' (full registry + oshal-engineering manifest) — while dispatch-routing resolved the built-in build workflow BY NAME on 'system-architect'. In full-registry mode the build workflow's worker did not exist under the name dispatch asked for, and the manifest registered the variant nobody resolved. This spec makes the split class structurally impossible: one name per agentId across BOTH registries, kernel manifests agree with the registries, and every built-in WORKFLOW_PIPELINES workerBot name resolves in BOTH lineups. Renaming any side goes red.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { SWARM_BOT_REGISTRY } from '../../src/app/extensions/swarm/swarm-bot-registry';
import { LOCAL_BOT_REGISTRY } from '../../src/app/extensions/swarm/swarm-bot-registry-local';
import { WORKFLOW_PIPELINES } from '../../src/features/swarm-orchestration/services/dispatch-routing';

interface ManifestBot { agentId?: string; name?: string }

function kernelManifests(): Array<{ file: string; bots: ManifestBot[]; workerBot?: string }> {
  const dir = path.resolve(process.cwd(), 'swarm-apps');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => {
    const doc = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8')) as
      { bots?: ManifestBot[]; workflow?: { workerBot?: string } } | null;
    return { file: f, bots: doc?.bots ?? [], workerBot: doc?.workflow?.workerBot };
  });
}

const byId = (defs: ReadonlyArray<{ agentId?: string; name: string }>) => {
  const m = new Map<string, string>();
  for (const d of defs) if (d.agentId) m.set(d.agentId, d.name);
  return m;
};

const localById = byId(LOCAL_BOT_REGISTRY);
const fullById = byId(SWARM_BOT_REGISTRY);

describe('K2: one name per agentId — registries, manifests, and dispatch agree', () => {
  it('every agentId present in BOTH registries carries the SAME name', () => {
    const drifts: string[] = [];
    for (const [id, localName] of localById) {
      const fullName = fullById.get(id);
      if (fullName !== undefined && fullName !== localName) {
        drifts.push(`${id}: local='${localName}' vs full='${fullName}'`);
      }
    }
    expect(
      drifts,
      'one UUID, two names across the registries — dispatch resolves BY NAME per mode, so this '
        + 'is live breakage in whichever mode carries the name nobody asks for (the K2 architect-bot split)',
    ).toEqual([]);
  });

  it('every kernel-manifest bot name matches the registry name for its agentId', () => {
    const drifts: string[] = [];
    for (const m of kernelManifests()) {
      for (const bot of m.bots) {
        if (!bot.agentId || !bot.name) continue;
        for (const [regName, reg] of [['local', localById], ['full', fullById]] as const) {
          const registered = reg.get(bot.agentId);
          if (registered !== undefined && registered !== bot.name) {
            drifts.push(`${m.file} → ${bot.agentId}: manifest='${bot.name}' vs ${regName} registry='${registered}'`);
          }
        }
      }
    }
    expect(drifts, 'a manifest registers a name the registry does not carry for that id (K2)').toEqual([]);
  });

  it('every built-in WORKFLOW_PIPELINES workerBot resolves BY NAME in BOTH registries', () => {
    const localNames = new Set(LOCAL_BOT_REGISTRY.map((b) => b.name));
    const fullNames = new Set(SWARM_BOT_REGISTRY.map((b) => b.name));
    for (const wf of WORKFLOW_PIPELINES) {
      if (!wf.workerBot) continue;
      expect(localNames.has(wf.workerBot), `built-in '${wf.ticketType}' workerBot '${wf.workerBot}' missing from LOCAL_BOT_REGISTRY`).toBe(true);
      expect(fullNames.has(wf.workerBot), `built-in '${wf.ticketType}' workerBot '${wf.workerBot}' missing from SWARM_BOT_REGISTRY — SWARM_REGISTRY=full cannot dispatch this pipeline`).toBe(true);
    }
  });

  it('pins the healed K2 case: a0…0018 is system-architect EVERYWHERE', () => {
    const id = 'a0000000-0000-0000-0000-000000000018';
    expect(localById.get(id)).toBe('system-architect');
    expect(fullById.get(id)).toBe('system-architect');
    const eng = kernelManifests().find((m) => m.file === 'oshal-engineering.yaml');
    expect(eng, 'oshal-engineering.yaml missing').toBeTruthy();
    expect(eng!.bots.find((b) => b.agentId === id)?.name).toBe('system-architect');
    expect(eng!.workerBot, 'the manifest build workflow must name the same worker dispatch-routing resolves').toBe('system-architect');
  });
});
