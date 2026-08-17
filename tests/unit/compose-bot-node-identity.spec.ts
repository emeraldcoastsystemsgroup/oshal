/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the compose bot-node fleet's identity invariants. A new node service is always written by copying an existing one (sales-bot came from career-bot), and the copy-paste failure that survives review is a duplicated AGENT_ID: both containers heartbeat, both answer, and every cost row and audit stamp lands under one identity. Nothing else catches it — the id is a plain env string, the container starts fine, and the wrong-attribution only shows up later in someone's billing question.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Pin both Claude OAuth mounts on package-owned CLI nodes. The sales node originally mounted ~/.claude but omitted the sibling ~/.claude.json account metadata, so a recreate turned a working login into a failed refresh and an honest raw fallback.
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
  exposes5000: boolean;
  mountsClaudeAuthVolume: boolean;
  mountsClaudeAuthJson: boolean;
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
        exposes5000: /^\s*-\s*"?5000"?\s*$/m.test(body),
        mountsClaudeAuthVolume: /^\s*-\s*\*claude-auth-volume\s*$/m.test(body),
        mountsClaudeAuthJson: /^\s*-\s*\*claude-auth-json\s*$/m.test(body),
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

  it('mounts both halves of the host Claude OAuth session on every bot node', () => {
    const broken = services
      .filter((s) => !s.mountsClaudeAuthVolume || !s.mountsClaudeAuthJson)
      .map((s) => `${s.name}: directory=${s.mountsClaudeAuthVolume} metadata=${s.mountsClaudeAuthJson}`);

    expect(broken, `bot nodes must mount ~/.claude and ~/.claude.json together; a partial `
      + `session loses authentication after recreation:\n  ${broken.join('\n  ')}`).toEqual([]);
  });

  // A package-owned node (ADR-093 Tier 2) must be opt-in, or every deployment pays its memory
  // whether or not it runs that package. career-bot established the contract; sales-bot follows.
  it('keeps package-owned nodes profile-gated and internal-only', () => {
    for (const name of ['career-bot', 'sales-bot']) {
      const svc = services.find((s) => s.name === name);
      expect(svc, `${name} must exist as a bot-node service`).toBeDefined();
      expect(svc!.profiles, `${name} must be profile-gated (opt-in per deployment)`).toBeTruthy();
      expect(svc!.exposes5000, `${name} must expose 5000 internally for node dispatch`).toBe(true);
    }
  });
});
