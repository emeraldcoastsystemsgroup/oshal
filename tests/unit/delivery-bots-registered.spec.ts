/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard: the four delivery-* personas must be reachable bots, not orphan YAML
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import { SWARM_BOT_REGISTRY } from '@/app/extensions/swarm/swarm-bot-registry';
import { LOCAL_BOT_REGISTRY } from '@/app/extensions/swarm/swarm-bot-registry-local';

/**
 * A persona YAML on disk is a file, not a bot. `seedInlineControllerBotProfiles`
 * only ever loads a persona for a name already in `getActiveRegistry()`, so a
 * persona that is not registered is unreachable — it would look shipped and do
 * nothing, which is exactly the failure mode delivery-verifier exists to catch.
 *
 * These four run the engagement method in docs/delivery/ENGAGEMENT-METHOD.md.
 */
const DELIVERY_BOTS = [
  { name: 'delivery-analyst', agentId: 'a0000000-0000-0000-0000-000000000063' },
  { name: 'delivery-sizer', agentId: 'a0000000-0000-0000-0000-000000000062' },
  { name: 'delivery-architect', agentId: 'a0000000-0000-0000-0000-000000000061' },
  { name: 'delivery-verifier', agentId: 'a0000000-0000-0000-0000-000000000064' },
] as const;

const PERSONA_DIR = path.resolve(__dirname, '..', '..', 'ai-lab', 'bot-personas');

interface PersonaShape {
  name?: string;
  agent_id?: string;
  perspective?: string;
  capabilities?: string[];
  selector_descriptor?: string;
  routing_keywords?: string[];
}

function loadPersona(name: string): PersonaShape {
  const file = path.join(PERSONA_DIR, `${name}.yaml`);
  expect(existsSync(file)).toBe(true);
  return yaml.load(readFileSync(file, 'utf8')) as PersonaShape;
}

describe('delivery-* bots are reachable, not orphan personas', () => {
  it.each(DELIVERY_BOTS)('$name is registered in BOTH registries with the persona agent_id', ({ name, agentId }) => {
    for (const [label, registry] of [
      ['swarm-bot-registry', SWARM_BOT_REGISTRY],
      ['swarm-bot-registry-local', LOCAL_BOT_REGISTRY],
    ] as const) {
      const entry = registry.find((bot) => bot.name === name);
      expect(entry, `${name} missing from ${label}`).toBeDefined();
      // The seeder upserts on agentId; a mismatch silently seeds a second row.
      expect(entry?.agentId, `${name} agentId drifted in ${label}`).toBe(agentId);
      // Inline on the api — these reason over a repo, they do not need their own node.
      expect(entry?.container, `${name} should be inline in ${label}`).toBe('oshal-api');
    }
  });

  it.each(DELIVERY_BOTS)('$name persona matches its registry entry', ({ name, agentId }) => {
    const persona = loadPersona(name);
    expect(persona.name).toBe(name);
    expect(persona.agent_id).toBe(agentId);

    // buildInlineControllerBotProfileSeed reads these three off the persona; an empty
    // one seeds a bot the selector can never route to.
    expect(persona.perspective && persona.perspective.length).toBeGreaterThan(500);
    expect(persona.selector_descriptor && persona.selector_descriptor.length).toBeGreaterThan(80);
    expect(Array.isArray(persona.routing_keywords) && persona.routing_keywords.length).toBeGreaterThan(2);

    // Capabilities must agree, or the registry advertises work the persona never took on.
    const registered = SWARM_BOT_REGISTRY.find((bot) => bot.name === name);
    expect([...(persona.capabilities ?? [])].sort()).toEqual([...(registered?.capabilities ?? [])].sort());
  });

  it.each(DELIVERY_BOTS)('$name carries a quality gate in its perspective', ({ name }) => {
    // The gate is the whole point of these personas — an artifact set without one is
    // a template. Written as "Quality gate — do not report done until".
    expect(loadPersona(name).perspective).toMatch(/quality gate/i);
  });

  it('the method the bots run is documented and indexed', () => {
    const root = path.resolve(__dirname, '..', '..');
    const method = path.join(root, 'docs', 'delivery', 'ENGAGEMENT-METHOD.md');
    expect(existsSync(method)).toBe(true);

    // Every bot is named in the method doc, so the doc and the fleet cannot drift apart.
    const text = readFileSync(method, 'utf8');
    for (const { name } of DELIVERY_BOTS) expect(text).toContain(name);

    // docs/README.md is the index every topic folder must appear in (CLAUDE.md).
    expect(readFileSync(path.join(root, 'docs', 'README.md'), 'utf8')).toContain('delivery/');
  });
});
