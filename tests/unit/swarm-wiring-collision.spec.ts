/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | K3 guard (BACKLOG kernel audit 2026-07-29): a0…030 was a THREE-WAY collision — codex-packer.yaml and intelligent-processing.yaml both declared it (different bots!) and the compose self-healing-bot service heartbeated as it — while validate-swarm-wiring matched by agentId only and reported OK. This spec proves the new findAgentIdCollisions detector red on the collision shape (pure + through the real audit under STRICT_SWARM_WIRING), asserts the shipped manifests are collision-free, and pins the healed identities: the compose self-healing service and its persona both carry a0…056, and NO compose AGENT_ID uses codex-packer's a0…030 again. A UUID cannot be safely re-pointed once tickets/chat_tasks/heartbeats reference it — migration 100 documents the existing-row story.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  auditSwarmBotWiring,
  findAgentIdCollisions,
  type ManifestAppBots,
} from '../../src/app/extensions/swarm/validate-swarm-wiring';

const CODEX_PACKER_ID = 'a0000000-0000-0000-0000-000000000030';
const SELF_HEALING_ID = 'a0000000-0000-0000-0000-000000000056';

describe('K3: one agentId under two names is detected, and the shipped identities are healed', () => {
  it('flags an agentId two manifests claim under DIFFERENT names (the codex-packer/self-healing shape)', () => {
    const apps: ManifestAppBots[] = [
      { appName: 'codex-packer', bots: [{ name: 'codex-packer', agentId: CODEX_PACKER_ID }] },
      { appName: 'intelligent-processing', bots: [{ name: 'self-healing-bot', agentId: CODEX_PACKER_ID }] },
    ];
    const collisions = findAgentIdCollisions(apps);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.agentId).toBe(CODEX_PACKER_ID);
    expect(collisions[0]!.claims.map((c) => c.botName).sort()).toEqual(['codex-packer', 'self-healing-bot']);
  });

  it('does NOT flag the same name re-declared by several manifests (shared framework bots are legal)', () => {
    const apps: ManifestAppBots[] = [
      { appName: 'a', bots: [{ name: 'project-manager', agentId: 'a0000000-0000-0000-0000-000000000001' }] },
      { appName: 'b', bots: [{ name: 'project-manager', agentId: 'a0000000-0000-0000-0000-000000000001' }] },
    ];
    expect(findAgentIdCollisions(apps)).toEqual([]);
  });

  const strictBefore = process.env.STRICT_SWARM_WIRING;
  afterEach(() => {
    if (strictBefore === undefined) delete process.env.STRICT_SWARM_WIRING;
    else process.env.STRICT_SWARM_WIRING = strictBefore;
  });

  it('the REAL boot audit throws under STRICT_SWARM_WIRING when manifests collide', async () => {
    process.env.STRICT_SWARM_WIRING = 'true';
    const fakeService = {
      listApps: async () => [{ name: 'x' }, { name: 'y' }],
      getApp: async (name: string) => ({
        name,
        manifest: {
          bots: [{ name: name === 'x' ? 'bot-one' : 'bot-two', agentId: 'aa000000-0000-0000-0000-00000000c011' }],
        },
      }),
    };
    await expect(auditSwarmBotWiring(fakeService as never)).rejects.toThrow(/collision/i);
  });

  it('the shipped kernel manifests are collision-free (this was RED before the K3 fix)', () => {
    const dir = path.resolve(process.cwd(), 'swarm-apps');
    const apps: ManifestAppBots[] = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => {
      const doc = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8')) as
        { bots?: Array<{ agentId?: string; name?: string }> } | null;
      return {
        appName: f,
        bots: (doc?.bots ?? [])
          .filter((b): b is { agentId: string; name: string } => Boolean(b.agentId && b.name))
          .map((b) => ({ agentId: b.agentId, name: b.name })),
      };
    });
    expect(findAgentIdCollisions(apps)).toEqual([]);
  });

  it('pins the healed identities: compose + persona carry a0…056; nothing in compose heartbeats as a0…030', () => {
    const compose = fs.readFileSync(path.resolve(process.cwd(), 'docker-compose.oshal-local.yml'), 'utf8');
    // The self-healing service announces its OWN id...
    expect(compose).toMatch(new RegExp(`AGENT_ID: ${SELF_HEALING_ID}`));
    // ...and codex-packer's id is never assigned to ANY compose service again (the Forge runs
    // inline on the api — a compose AGENT_ID on 030 recreates the ambiguous-heartbeat defect).
    expect(compose).not.toMatch(new RegExp(`AGENT_ID: ${CODEX_PACKER_ID}`));
    const persona = fs.readFileSync(path.resolve(process.cwd(), 'ai-lab/bot-personas/self-healing-bot.yaml'), 'utf8');
    expect(persona).toMatch(new RegExp(`^agent_id: ${SELF_HEALING_ID}$`, 'm'));
  });
});
