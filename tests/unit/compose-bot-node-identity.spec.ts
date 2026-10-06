/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the compose bot-node fleet's identity invariants. A new node service is always written by copying an existing one (sales-bot came from career-bot), and the copy-paste failure that survives review is a duplicated AGENT_ID: both containers heartbeat, both answer, and every cost row and audit stamp lands under one identity. Nothing else catches it — the id is a plain env string, the container starts fine, and the wrong-attribution only shows up later in someone's billing question.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Pin both Claude OAuth mounts on package-owned CLI nodes. The sales node originally mounted ~/.claude but omitted the sibling ~/.claude.json account metadata, so a recreate turned a working login into a failed refresh and an honest raw fallback.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | The Claude rule is now "whole or not at all", and scene-studio-bot joins the package-node checks. Requiring both halves on EVERY node made a credential-minimal node impossible and has failed on futures-research-worker since it landed without either half (30097d55); half a session (sales-bot's original ~/.claude without ~/.claude.json) is still red. Also pins scene-studio-bot to the Antigravity login alone (no Codex or Claude session, no config-seed), because that node runs store-package code with agy's sandboxed command grant.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | concierge-bot replaces scene-studio-bot: the package-node checks and the Antigravity-login-only pin now name it (agent d97fe8e7-d2d6-4b18-b8df-f15e15820d79), and a new case pins BOT_NODE_SERVES to exactly one service, concierge-bot. A second multi-agent node, or the key copied onto an ordinary node by the usual copy-paste, would let one container execute for other agents' identities; the served-agent policy limits what it may serve, and this pin limits where that policy can be switched on.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const COMPOSE = join(ROOT, 'docker-compose.oshal-local.yml');

interface BotService {
  name: string;
  agentId: string | null;
  personaFile: string | null;
  botName: string | null;
  profiles: string | null;
  serves: string | null;
  exposes5000: boolean;
  mountsClaudeAuthVolume: boolean;
  mountsClaudeAuthJson: boolean;
  mountsGeminiAuthVolume: boolean;
  mountsCodexAuthVolume: boolean;
  mountsConfigSeed: boolean;
}

/**
 * @description Parse the bot-node services out of the compose file by indentation, without a
 * YAML library: the file leans on merge keys and anchors (`<<: *bot-common`) that a plain
 * parser resolves away, and the anchor membership is exactly what identifies a bot node.
 * @returns One entry per service whose body merges the shared bot-common anchor.
 */
function botNodeServices(): BotService[] {
  const lines = readFileSync(COMPOSE, 'utf8').split('\n');
  const out: BotService[] = [];
  let current: { name: string; body: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const body = current.body.join('\n');
    if (/<<:\s*\*bot-common/.test(body)) {
      const pick = (re: RegExp) => {
        const m = body.match(re);
        return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
      };
      out.push({
        name: current.name,
        agentId: pick(/^\s*AGENT_ID:\s*(.+)$/m),
        personaFile: pick(/^\s*BOT_PERSONA_FILE:\s*(.+)$/m),
        botName: pick(/^\s*BOT_NAME:\s*(.+)$/m),
        profiles: pick(/^\s*profiles:\s*(.+)$/m),
        serves: pick(/^\s*BOT_NODE_SERVES:\s*(.+)$/m),
        exposes5000: /^\s*-\s*"?5000"?\s*$/m.test(body),
        mountsClaudeAuthVolume: /^\s*-\s*\*claude-auth-volume\s*$/m.test(body),
        mountsClaudeAuthJson: /^\s*-\s*\*claude-auth-json\s*$/m.test(body),
        mountsGeminiAuthVolume: /^\s*-\s*\*gemini-auth-volume\s*$/m.test(body),
        mountsCodexAuthVolume: /^\s*-\s*\*codex-auth-volume\s*$/m.test(body),
        mountsConfigSeed: /^\s*-\s*\.\/config-seed:/m.test(body),
      });
    }
    current = null;
  };

  for (const line of lines) {
    // A service key is exactly two spaces deep under the top-level `services:` map.
    const service = line.match(/^ {2}([a-z0-9][a-z0-9-]*):\s*$/);
    if (service) {
      flush();
      current = { name: service[1], body: [] };
      continue;
    }
    if (current) {
      if (/^\S/.test(line)) flush();
      else current.body.push(line);
    }
  }
  flush();
  return out;
}

describe('compose bot-node identity', () => {
  const services = botNodeServices();

  it('finds the bot-node fleet (the parser must not silently match nothing)', () => {
    expect(services.length).toBeGreaterThan(3);
    expect(services.map((s) => s.name)).toContain('career-bot');
    expect(services.map((s) => s.name)).toContain('sales-bot');
  });

  // THE copy-paste failure. Two services sharing an AGENT_ID both start, both heartbeat and
  // both answer — while cost rows and audit stamps for both land under one identity.
  it('never lets two bot-node services share an AGENT_ID', () => {
    const byId = new Map<string, string[]>();
    for (const s of services) {
      if (!s.agentId) continue;
      byId.set(s.agentId, [...(byId.get(s.agentId) || []), s.name]);
    }
    const duplicated = [...byId.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([id, names]) => `${id} shared by ${names.join(' + ')}`);

    expect(duplicated, `bot-node services share an AGENT_ID — cost and audit attribution `
      + `collapses onto one identity:\n  ${duplicated.join('\n  ')}`).toEqual([]);
  });

  it('gives every bot-node service a UUID AGENT_ID and a persona file', () => {
    const broken = services
      .filter((s) => !s.agentId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.agentId)
        || !s.personaFile)
      .map((s) => `${s.name}: agentId=${s.agentId ?? 'MISSING'} persona=${s.personaFile ?? 'MISSING'}`);

    expect(broken, `every bot node needs a UUID identity and a persona:\n  ${broken.join('\n  ')}`)
      .toEqual([]);
  });

  // Whole or not at all. Half the session (sales-bot's original ~/.claude without ~/.claude.json)
  // looks authenticated until the first recreation; a node with none of it never runs Claude Code.
  it('mounts the host Claude OAuth session whole or not at all on every bot node', () => {
    const broken = services
      .filter((s) => s.mountsClaudeAuthVolume !== s.mountsClaudeAuthJson)
      .map((s) => `${s.name}: directory=${s.mountsClaudeAuthVolume} metadata=${s.mountsClaudeAuthJson}`);

    expect(broken, `bot nodes must mount ~/.claude and ~/.claude.json together or not at all; a partial `
      + `session loses authentication after recreation:\n  ${broken.join('\n  ')}`).toEqual([]);
    // Not vacuous: most of the fleet carries the session, so a parser that saw no mounts fails here.
    expect(services.filter((s) => s.mountsClaudeAuthVolume && s.mountsClaudeAuthJson).length)
      .toBeGreaterThan(3);
  });

  // A package-owned node (ADR-093 Tier 2) must be opt-in, or every deployment pays its memory
  // whether or not it runs that package. career-bot established the contract; sales-bot and
  // concierge-bot (which runs installed packages' inline bots) follow.
  it('keeps package-owned nodes profile-gated and internal-only', () => {
    for (const name of ['career-bot', 'sales-bot', 'concierge-bot']) {
      const svc = services.find((s) => s.name === name);
      expect(svc, `${name} must exist as a bot-node service`).toBeDefined();
      expect(svc!.profiles, `${name} must be profile-gated (opt-in per deployment)`).toBeTruthy();
      expect(svc!.exposes5000, `${name} must expose 5000 internally for node dispatch`).toBe(true);
    }
  });

  // The concierge node runs installed packages' bots (the Scene Studio director among them) on the
  // operator's Antigravity login, so the node carries the one login it uses and nothing else.
  it('keeps the concierge node on the Antigravity login alone', () => {
    const svc = services.find((s) => s.name === 'concierge-bot');
    expect(svc, 'concierge-bot must exist as a bot-node service').toBeDefined();
    expect(svc!.agentId).toBe('d97fe8e7-d2d6-4b18-b8df-f15e15820d79');
    expect(svc!.profiles).toContain('concierge-node');
    expect(svc!.mountsGeminiAuthVolume, 'agy reads its login from the .gemini mount').toBe(true);
    expect({
      codex: svc!.mountsCodexAuthVolume,
      claude: svc!.mountsClaudeAuthVolume || svc!.mountsClaudeAuthJson,
      configSeed: svc!.mountsConfigSeed,
    }, 'concierge-bot carries a credential it never uses').toEqual({ codex: false, claude: false, configSeed: false });
    expect(services.map((s) => s.name), 'scene-studio-bot folded into concierge-bot').not.toContain('scene-studio-bot');
  });

  // Exactly one node may execute for other agents' identities, and only in the one mode the
  // served-agent policy accepts. A copied service carrying the key is the failure this catches.
  it('switches BOT_NODE_SERVES on for exactly one service, concierge-bot', () => {
    const serving = services.filter((s) => s.serves !== null).map((s) => `${s.name}=${s.serves}`);
    expect(serving).toEqual(['concierge-bot=inline-app-bots']);
    const raw = readFileSync(COMPOSE, 'utf8');
    expect(raw.match(/^\s*BOT_NODE_SERVES:/gm), 'BOT_NODE_SERVES appears outside the bot-node services').toHaveLength(1);
  });
});
