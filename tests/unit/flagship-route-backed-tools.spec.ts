import fs from 'fs';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

function toolNames(file: string): Set<string> {
  const manifest = yaml.load(fs.readFileSync(file, 'utf8')) as { tools?: Array<{ name?: string }> };
  return new Set((manifest.tools ?? []).map((tool) => String(tool.name || '')).filter(Boolean));
}

describe('flagship route-backed app tools', () => {
  it('declares the executable actions authorized by concierge personas', () => {
    const expected: Record<string, string[]> = {
      // (spotify / eats / rides / purchasing / travel removed: all carved to the app store,
      //  ADR-085 Waves 2-3 — their route-backed tool declarations moved into the package
      //  manifests (travel's seven-tool set incl. explain-travel-pick lives in the travel
      //  package, validated by `oshal-app validate`). The map is EMPTY until a core manifest
      //  declares route-backed concierge tools again; the global-uniqueness test below is the
      //  standing guard over swarm-apps/ and still runs against every core manifest.)
    };

    for (const [file, names] of Object.entries(expected)) {
      const declared = toolNames(file);
      for (const name of names) {
        expect(declared.has(name), `${file} missing ${name}`).toBe(true);
      }
    }
  });

  // The standing guard. Tool names are GLOBAL: the runtime executor upsert is
  // ON CONFLICT (tool_name) DO UPDATE (runtime-tool-registration-service.ts), so two manifests
  // declaring one name means whichever loads last silently owns the executor — and load order is
  // readdirSync, i.e. alphabetical. That is not a hypothetical: purchasing.yaml and travel.yaml
  // BOTH declared `explain-pick` with different endpoints, travel sorted last, and the shopping
  // concierge's explain-pick was live-routing to POST /api/travel/chat. The loader now fails closed
  // on a duplicate name (SwarmAppService.loadApp), but catching it here costs nothing and names the
  // two files, which a boot-time throw does not.
  it('never declares one tool name in two manifests (executors are ON CONFLICT last-write-wins)', () => {
    const owners = new Map<string, string[]>();

    for (const file of fs.readdirSync('swarm-apps').filter((f) => f.endsWith('.yaml'))) {
      const path = `swarm-apps/${file}`;
      for (const name of toolNames(path)) {
        owners.set(name, [...(owners.get(name) ?? []), path]);
      }
    }

    const collisions = [...owners.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([name, files]) => `${name} declared by ${files.join(' + ')}`);

    expect(collisions).toEqual([]);
  });
});
