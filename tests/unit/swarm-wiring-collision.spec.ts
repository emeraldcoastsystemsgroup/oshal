/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | K3 guard (BACKLOG kernel audit 2026-07-29): a0…030 was a THREE-WAY collision — codex-packer.yaml and intelligent-processing.yaml both declared it (different bots!) and the compose self-healing-bot service heartbeated as it — while validate-swarm-wiring matched by agentId only and reported OK. This spec proves the new findAgentIdCollisions detector red on the collision shape (pure + through the real audit under STRICT_SWARM_WIRING), asserts the shipped manifests are collision-free, and pins the healed identities: the compose self-healing service and its persona both carry a0…056, and NO compose AGENT_ID uses codex-packer's a0…030 again. A UUID cannot be safely re-pointed once tickets/chat_tasks/heartbeats reference it — migration 100 documents the existing-row story.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Second collision, same shape, found by the detector this file guards: a0…049 was declared by BOTH `intelligent-trades:trading-research-analyst` and `lora:lora-director` — an ERROR on EVERY api boot since the ADR-085 carve, because the LoRA Studio package kept the id the kernel registry already owned. The kernel keeps 049 (registered to trading-research-analyst since ADR-054, and swarm-bot-registry.ts removed lora-director BY NAME with a comment saying exactly that); the STORE package moves to a0…065. These guards pin the core half — one name on 049 across both registries and the persona, migration 111 restoring a mis-named row to trading's name and never to lora's, and 065 unclaimed in core so the store's new id cannot collide back.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  auditSwarmBotWiring,
  findAgentIdCollisions,
  findUnregisteredBots,
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

const TRADING_RESEARCH_ID = 'a0000000-0000-0000-0000-000000000049';
const LORA_DIRECTOR_ID = 'a0000000-0000-0000-0000-000000000065';

describe('a0…049: the kernel keeps it for trading-research-analyst; lora-director moved to a0…065', () => {
  it('detects the EXACT pair the live boot log reported (intelligent-trades vs lora)', () => {
    const apps: ManifestAppBots[] = [
      { appName: 'intelligent-trades', bots: [{ name: 'trading-research-analyst', agentId: TRADING_RESEARCH_ID }] },
      { appName: 'lora', bots: [{ name: 'lora-director', agentId: TRADING_RESEARCH_ID }] },
    ];
    const collisions = findAgentIdCollisions(apps);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.claims.map((c) => c.botName).sort()).toEqual(['lora-director', 'trading-research-analyst']);
  });

  it('is resolved once the store package moves: the same two bots on DIFFERENT ids are clean', () => {
    const apps: ManifestAppBots[] = [
      { appName: 'intelligent-trades', bots: [{ name: 'trading-research-analyst', agentId: TRADING_RESEARCH_ID }] },
      { appName: 'lora', bots: [{ name: 'lora-director', agentId: LORA_DIRECTOR_ID }] },
    ];
    expect(findAgentIdCollisions(apps)).toEqual([]);
  });

  it('the core tree claims a0…049 under exactly ONE name, and never lora-director', () => {
    const files = [
      'src/app/extensions/swarm/swarm-bot-registry-local.ts',
      'src/app/extensions/swarm/swarm-bot-registry.ts',
      'ai-lab/bot-personas/trading-research-analyst.yaml',
    ];
    const names = new Set<string>();
    for (const rel of files) {
      const text = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
      // Registry entries put `name:` on the line after `agentId:`; personas put agent_id
      // under `name:`. Both shapes are covered by scanning a small window either side.
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!line.includes(TRADING_RESEARCH_ID)) return;
        for (const near of lines.slice(Math.max(0, i - 4), i + 5)) {
          const match = near.match(/^\s*name:\s*'?"?([a-z0-9-]+)'?"?\s*,?\s*$/i);
          if (match) names.add(match[1]);
        }
      });
    }
    expect(names.has('lora-director')).toBe(false);
    expect(Array.from(names)).toEqual(['trading-research-analyst']);
  });

  it('a0…065 is unclaimed in the core tree, so the store package cannot collide back onto the kernel', () => {
    const roots = ['src', 'ai-lab/bot-personas', 'swarm-apps', 'docker-compose.oshal-local.yml'];
    const hits: string[] = [];
    const scan = (target: string): void => {
      const abs = path.resolve(process.cwd(), target);
      if (!fs.existsSync(abs)) return;
      if (fs.statSync(abs).isDirectory()) {
        for (const child of fs.readdirSync(abs)) scan(path.join(target, child));
        return;
      }
      if (!/\.(ts|js|ya?ml|yml|sql)$/i.test(abs)) return;
      if (fs.readFileSync(abs, 'utf8').includes(LORA_DIRECTOR_ID)) hits.push(target);
    };
    for (const root of roots) scan(root);
    expect(hits).toEqual([]);
  });

  it('migration 111 restores a mis-named a0…049 row to trading-research-analyst, never to lora-director', () => {
    const sql = fs.readFileSync(path.resolve(process.cwd(), 'scripts/migrations/111-lora-director-agent-id.sql'), 'utf8');
    // The UPDATE must set trading's name where the row currently reads lora-director —
    // the reverse direction would hand the kernel's id to the app that just gave it up.
    expect(sql).toMatch(/SET name = 'trading-research-analyst'[\s\S]{0,200}WHERE agent_id = 'a0000000-0000-0000-0000-000000000049'[\s\S]{0,120}AND name = 'lora-director'/);
    expect(sql).not.toMatch(/SET name = 'lora-director'/);
    // No INSERT: lora is a STORE package (ADR-085) and the kernel never seeds an app's bot.
    expect(sql).not.toMatch(/INSERT\s+INTO\s+agents/i);
  });
});

const CODEX_PACKER_CANONICAL = 'a0000000-0000-0000-0000-000000000030';

describe('the MIRROR defect: a manifest declaring an agentId nothing registers', () => {
  /** Every bot every shipped kernel manifest declares, in the audit's own input shape. */
  function shippedManifestBots(): ManifestAppBots[] {
    const dir = path.resolve(process.cwd(), 'swarm-apps');
    return fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => {
      const doc = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8')) as
        { name?: string; bots?: Array<{ agentId?: string; name?: string }> } | null;
      return {
        appName: doc?.name ?? f,
        bots: (doc?.bots ?? [])
          .filter((b): b is { agentId: string; name: string } => Boolean(b.agentId && b.name))
          .map((b) => ({ agentId: b.agentId, name: b.name })),
      };
    });
  }

  it('detects declared-but-unregistered — the shape that made oshal-up.sh fail on codex-packer', () => {
    const issues = findUnregisteredBots(
      [{ appName: 'codex-packer', bots: [{ name: 'codex-packer', agentId: CODEX_PACKER_CANONICAL }] }],
      new Set(['a0000000-0000-0000-0000-000000000056']),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ appName: 'codex-packer', agentId: CODEX_PACKER_CANONICAL, reason: 'no-registry-entry' });
  });

  it('every bot the shipped kernel manifests declare resolves in an endpoint registry', () => {
    // Both variants: a deployment runs one or the other (SWARM_REGISTRY=full|local), and a bot
    // present in only one is still resolvable on the box that runs it. An id in NEITHER is the
    // compiles-but-fails trap. Read as data so this needs no live stack.
    const registrySources = ['swarm-bot-registry.ts', 'swarm-bot-registry-local.ts']
      .map((f) => fs.readFileSync(path.resolve(process.cwd(), 'src/app/extensions/swarm', f), 'utf8'))
      .join('\n');
    const registered = new Set(registrySources.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi) ?? []);
    const issues = findUnregisteredBots(shippedManifestBots(), registered);
    expect(issues.map((i) => `${i.appName}:${i.botName} (${i.agentId})`)).toEqual([]);
  });

  it('codex-packer declares the canonical id in the manifest AND both registries', () => {
    const manifest = fs.readFileSync(path.resolve(process.cwd(), 'swarm-apps/codex-packer.yaml'), 'utf8');
    expect(manifest).toContain(CODEX_PACKER_CANONICAL);
    for (const f of ['swarm-bot-registry.ts', 'swarm-bot-registry-local.ts']) {
      const src = fs.readFileSync(path.resolve(process.cwd(), 'src/app/extensions/swarm', f), 'utf8');
      expect(src.includes(CODEX_PACKER_CANONICAL)).toBe(true);
    }
  });

  it('migration 112 moves the DRIFTED row onto the canonical id and never the reverse', () => {
    const sql = fs.readFileSync(path.resolve(process.cwd(), 'scripts/migrations/112-codex-packer-agent-id-canon.sql'), 'utf8');
    // The code's id wins. Selecting the drifted row BY NAME (not by a hardcoded UUID) is what
    // makes this work on a box whose generated uuid differs from the reference box's.
    expect(sql).toContain(`canonical CONSTANT uuid := '${CODEX_PACKER_CANONICAL}'`);
    expect(sql).toMatch(/WHERE name = 'codex-packer' AND agent_id <> canonical/);
    expect(sql).toMatch(/UPDATE agents SET agent_id = canonical/);
    // Idempotent: a box already carrying the canonical row must be left alone.
    expect(sql).toMatch(/IF EXISTS \(SELECT 1 FROM agents WHERE agent_id = canonical\)[\s\S]{0,200}RETURN;/);
    // The FK fallback must still END with a usable canonical row, not a swallowed error.
    expect(sql).toMatch(/EXCEPTION WHEN foreign_key_violation THEN[\s\S]{0,900}INSERT INTO agents/);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+agents/i);
  });
});
