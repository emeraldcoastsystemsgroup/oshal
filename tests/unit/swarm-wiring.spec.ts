/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for the fail-loud swarm-wiring audit (compiles-but-fails guard, ADR-061).
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, it, expect } from 'vitest';
import { findUnregisteredBots, type ManifestAppBots } from '../../src/app/extensions/swarm/validate-swarm-wiring';
import { getActiveRegistry } from '../../src/app/extensions/swarm/swarm-bot-registry';

const registered = new Set(['a-1', 'b-2', 'b00d0000-0000-0000-0000-000000000001']);

describe('findUnregisteredBots — the compiles-but-fails guard', () => {
  it('passes when every manifest bot has a registry entry', () => {
    const apps: ManifestAppBots[] = [{ appName: 'world', bots: [{ name: 'world-analyst', agentId: 'b00d0000-0000-0000-0000-000000000001' }] }];
    expect(findUnregisteredBots(apps, registered)).toEqual([]);
  });

  it('flags a declared bot missing from the registry (the exact bug this catches)', () => {
    const apps: ManifestAppBots[] = [{ appName: 'ghost', bots: [{ name: 'ghost-bot', agentId: 'zzz-9' }] }];
    const issues = findUnregisteredBots(apps, registered);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ appName: 'ghost', botName: 'ghost-bot', agentId: 'zzz-9', reason: 'no-registry-entry' });
  });

  it('ignores bots with no agentId (foundation/base personas)', () => {
    const apps: ManifestAppBots[] = [{ appName: 'base', bots: [{ name: 'foundation', agentId: '' }] }];
    expect(findUnregisteredBots(apps, registered)).toEqual([]);
  });

  it('reports only the unregistered ones across a mixed fleet', () => {
    const apps: ManifestAppBots[] = [
      { appName: 'ok', bots: [{ name: 'one', agentId: 'a-1' }, { name: 'two', agentId: 'b-2' }] },
      { appName: 'broken', bots: [{ name: 'three', agentId: 'missing-3' }] },
    ];
    const issues = findUnregisteredBots(apps, registered);
    expect(issues.map((i) => i.agentId)).toEqual(['missing-3']);
  });

  it('defaults source runs to the app-aware registry so real manifest bots resolve', () => {
    const previousRegistry = process.env.SWARM_REGISTRY;
    delete process.env.SWARM_REGISTRY;

    try {
      const registeredAgentIds = new Set(
        getActiveRegistry()
          .map((bot) => bot.agentId)
          .filter((agentId): agentId is string => typeof agentId === 'string' && agentId.length > 0),
      );
      const issues = findUnregisteredBots(readSwarmAppManifestBots(), registeredAgentIds);
      expect(issues).toEqual([]);
    } finally {
      if (previousRegistry === undefined) {
        delete process.env.SWARM_REGISTRY;
      } else {
        process.env.SWARM_REGISTRY = previousRegistry;
      }
    }
  });
});

function readSwarmAppManifestBots(): ManifestAppBots[] {
  const manifestRoot = path.join(process.cwd(), 'swarm-apps');
  return collectYamlFiles(manifestRoot).map((filePath) => {
    const manifest = yaml.load(fs.readFileSync(filePath, 'utf8')) as {
      name?: string;
      bots?: Array<{ name?: string; agentId?: string }>;
    };
    return {
      appName: manifest.name ?? path.basename(filePath, path.extname(filePath)),
      bots: (manifest.bots ?? []).map((bot) => ({
        name: bot.name ?? '',
        agentId: bot.agentId ?? '',
      })),
    };
  });
}

function collectYamlFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectYamlFiles(fullPath));
    } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files.sort();
}
