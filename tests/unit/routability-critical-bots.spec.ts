/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — anti-rot guard for the routing-liveness check. scripts/swarm-routability-check.sh probes a hardcoded list of routing-critical bots (scripts/routability-critical-bots.txt); this test is what stops that list from rotting the way scripts/verify-bot-health.sh did (it still checks long-dead swarm-* container names). It asserts every agentId in the list still exists in LOCAL_BOT_REGISTRY under the declared name, and that every bot flagged jarvisReachable is actually reachable by the 'jarvis' caller role (ADR-087) — so a rename, a removal, or an accidental accessRoles re-scope that would silently break Jarvis→specialist routing fails HERE, in CI, instead of at 2am as "routing broke again".
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCAL_BOT_REGISTRY } from '../../src/app/extensions/swarm/swarm-bot-registry-local';
import { isBotAccessibleTo } from '../../src/app/extensions/swarm/swarm-bot-registry';

interface CriticalBot {
  agentId: string;
  name: string;
  jarvisReachable: boolean;
  breaks: string;
}

/** Parse scripts/routability-critical-bots.txt the same way the bash guard does (pipe-delimited,
 *  skipping # comments and blank lines). Kept in lockstep with swarm-routability-check.sh. */
function loadCriticalBots(): CriticalBot[] {
  const file = path.resolve(process.cwd(), 'scripts/routability-critical-bots.txt');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const out: CriticalBot[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [agentId, name, reach, breaks] = line.split('|').map((s) => s.trim());
    out.push({
      agentId,
      name,
      jarvisReachable: (reach || '').toLowerCase() === 'yes',
      breaks: breaks || '',
    });
  }
  return out;
}

describe('routing-critical bots stay real (anti-rot guard for the liveness check)', () => {
  const critical = loadCriticalBots();
  const byId = new Map(LOCAL_BOT_REGISTRY.map((b) => [b.agentId, b]));

  it('parses a non-empty, well-formed list', () => {
    expect(critical.length).toBeGreaterThan(0);
    for (const b of critical) {
      expect(b.agentId, `agentId on line for "${b.name}"`).toMatch(/^[0-9a-f-]{36}$/i);
      expect(b.name, `name for ${b.agentId}`).not.toEqual('');
      expect(b.breaks, `"what breaks" note for ${b.name}`).not.toEqual('');
    }
  });

  it('every critical bot still exists in LOCAL_BOT_REGISTRY under the declared name', () => {
    for (const b of critical) {
      const def = byId.get(b.agentId);
      expect(def, `${b.name} (${b.agentId}) is in the routability list but NOT in LOCAL_BOT_REGISTRY — the list has rotted; fix scripts/routability-critical-bots.txt or the registry`).toBeDefined();
      expect(def!.name, `${b.agentId} is named "${def!.name}" in the registry but "${b.name}" in the routability list`).toEqual(b.name);
    }
  });

  it('every jarvisReachable bot is actually reachable by the jarvis caller role (ADR-087)', () => {
    for (const b of critical.filter((x) => x.jarvisReachable)) {
      expect(
        isBotAccessibleTo(b.agentId, 'jarvis'),
        `${b.name} is flagged jarvisReachable but its accessRoles exclude 'jarvis' — a Jarvis-filed task could NEVER route to it (it would silently fall to general-bot). Fix its accessRoles or the list flag.`,
      ).toBe(true);
    }
  });

  it('covers the daily-driver specialists that recur in routing complaints', () => {
    // A minimum floor so a well-meaning trim can't quietly drop the exact bots the recurring
    // "Jarvis can't answer / trading tickets don't reach the concierge" report is about.
    const names = new Set(critical.map((b) => b.name));
    for (const required of ['oshal-assistant', 'general-bot', 'trading-analyst']) {
      expect(names.has(required), `${required} must stay in the routing-liveness list`).toBe(true);
    }
  });
});
