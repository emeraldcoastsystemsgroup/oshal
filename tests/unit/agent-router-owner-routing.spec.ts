/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Tier-3 owner-routing guard. Crosses the REAL boundary the defect lived on: the REAL declared corpus (capabilities from LOCAL_BOT_REGISTRY, routing keywords read off the on-disk persona YAML the boot seeders read) -> the REAL tokenizer -> the REAL AgentRouter, with bids:[] and no llmRoutingFunction so Tiers 1-2 are absent by construction and only Tier 3 can answer. It pins the 2026-09-15 live misroute (a trading P&L question claimed by a communications owner because the declared phrase 'what did i miss' was shredded into the bare token 'did'), the email-shaped ask that must STILL reach the comms owner, once-per-phrase counting, and - the case that fails loudly if anyone later adds a minimum-claim threshold - the bots whose whole vocabulary is single words and therefore win Tier 3 on a single hit.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import * as yaml from 'js-yaml';
import { LOCAL_BOT_REGISTRY } from '../../src/app/extensions/swarm/swarm-bot-registry-local';
import { AgentRouter, type RouteCandidate, type RouteDecision } from '../../src/features/agent-management';

const REPO_ROOT = join(__dirname, '..', '..');
const PERSONA_DIR = join(REPO_ROOT, 'ai-lab', 'bot-personas');
const COMPOSE_FILE = join(REPO_ROOT, 'docker-compose.oshal-local.yml');

/** The comms owners. Both declare the phrase 'what did i miss'; both were claiming on 'did'. */
const COMMUNICATIONS_BOT = 'b0000000-0000-0000-0000-000000000001';
const FEEDS_CURATOR = 'fd000000-0000-0000-0000-000000000001';
const TRADING_ANALYST = 'a0000000-0000-0000-0000-000000000046';
const WEATHER_BOT = 'a0000000-0000-0000-0000-000000000036';
const SPOTIFY_CONCIERGE = 'b00a0000-0000-0000-0000-000000000001';
const MOVIES_CONCIERGE = 'b00b0000-0000-0000-0000-000000000001';

/**
 * Persona file per bot, resolved the way the runtime resolves it: a bot with its own
 * container is seeded from the compose service's BOT_PERSONA_FILE (agent-profile-boot-seeder),
 * an inline controller bot from ai-lab/bot-personas/<name>.yaml (inline-controller-bot-seeder).
 */
function personaFileByAgentId(): Map<string, string> {
  const map = new Map<string, string>();
  const compose = readFileSync(COMPOSE_FILE, 'utf8');
  let pendingAgentId: string | null = null;
  for (const line of compose.split(/\r?\n/)) {
    const agent = /^\s*AGENT_ID:\s*"?([0-9a-fA-F-]{36})"?\s*$/.exec(line);
    if (agent) {
      pendingAgentId = agent[1].toLowerCase();
      continue;
    }
    const persona = /^\s*BOT_PERSONA_FILE:\s*"?(\S+?)"?\s*$/.exec(line);
    if (persona && pendingAgentId) {
      map.set(pendingAgentId, basename(persona[1]));
      pendingAgentId = null;
    }
  }
  return map;
}

/** routing_keywords exactly as the seeders read them off the persona YAML. */
function declaredRoutingKeywords(personaFile: string): string[] {
  const personaPath = join(PERSONA_DIR, personaFile);
  if (!existsSync(personaPath)) return [];
  const parsed = yaml.load(readFileSync(personaPath, 'utf8')) as Record<string, unknown> | null;
  const raw = parsed?.routing_keywords ?? parsed?.routingKeywords;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((keyword): keyword is string => typeof keyword === 'string' && keyword.trim().length > 0)
    .map((keyword) => keyword.trim());
}

/**
 * The live routing corpus: one candidate per registered bot, carrying the two declarations the
 * boot seeders actually write into the agents table (base_capabilities, base_routing_keywords).
 * Every score is 0 so nothing but Tier 3 can decide the winner.
 */
function buildLiveCorpus(): RouteCandidate[] {
  const personaByAgentId = personaFileByAgentId();
  return LOCAL_BOT_REGISTRY.map((bot) => {
    const files = [personaByAgentId.get(bot.agentId.toLowerCase()), bot.name + '.yaml'];
    let routingKeywords: string[] = [];
    for (const file of files) {
      if (!file) continue;
      routingKeywords = declaredRoutingKeywords(file);
      if (routingKeywords.length > 0) break;
    }
    return {
      agentId: bot.agentId,
      name: bot.name,
      score: 0,
      reason: 'live registry + persona corpus',
      capabilities: [...bot.capabilities],
      routingKeywords,
    };
  });
}

const LIVE_CORPUS = buildLiveCorpus();

/** Routes one ask through the real router with Tiers 1-2 absent by construction. */
async function routeAsk(text: string, candidates: RouteCandidate[] = LIVE_CORPUS): Promise<RouteDecision> {
  return new AgentRouter().route(
    { taskId: 'guard-' + text.slice(0, 12), bids: [], ticketTitle: text, taskText: '' },
    candidates,
  );
}

const named = (decision: RouteDecision): string => decision.winner.name ?? decision.winner.agentId;

describe('Tier-3 owner routing: the corpus this guard is asserting against', () => {
  it('carries both declarations for the bots the cases name', () => {
    const byId = new Map(LIVE_CORPUS.map((candidate) => [candidate.agentId, candidate]));
    for (const agentId of [COMMUNICATIONS_BOT, FEEDS_CURATOR, TRADING_ANALYST, WEATHER_BOT, SPOTIFY_CONCIERGE, MOVIES_CONCIERGE]) {
      const candidate = byId.get(agentId);
      expect(candidate, agentId + ' is missing from LOCAL_BOT_REGISTRY').toBeDefined();
      expect((candidate!.routingKeywords ?? []).length, (candidate!.name ?? agentId) + ' declares no routing keywords').toBeGreaterThan(0);
    }
  });

  it('still contains the shredded phrase that caused the misroute (the guard rots if it is renamed)', () => {
    for (const agentId of [COMMUNICATIONS_BOT, FEEDS_CURATOR]) {
      const keywords = LIVE_CORPUS.find((candidate) => candidate.agentId === agentId)?.routingKeywords ?? [];
      expect(keywords.map((keyword) => keyword.toLowerCase())).toContain('what did i miss');
    }
  });
});

describe('Tier-3 owner routing: a trading P&L question never lands on a communications owner', () => {
  // The live text of ticket aaa86e48 plus the two 2026-09-15 titles. Before phrase matching all
  // three scored a point for the comms owners off the single token 'did', shredded out of the
  // declared phrase 'what did i miss'.
  const P_AND_L_ASKS = [
    'yes but how much did we make or loose',
    'How did we do in the stock market today?',
    'How much money did we make in the stock market today?',
  ];

  for (const ask of P_AND_L_ASKS) {
    it('does not route "' + ask + '" to a communications owner', async () => {
      const decision = await routeAsk(ask);
      expect(decision.winner.agentId, 'routed to ' + named(decision)).not.toBe(COMMUNICATIONS_BOT);
      expect(decision.winner.agentId, 'routed to ' + named(decision)).not.toBe(FEEDS_CURATOR);
    });
  }

  it('routes the two 2026-09-15 titles to the trading owner', async () => {
    for (const ask of P_AND_L_ASKS.slice(1)) {
      const decision = await routeAsk(ask);
      expect(decision.strategy).toBe('keyword');
      expect(decision.winner.agentId, ask + ' routed to ' + named(decision)).toBe(TRADING_ANALYST);
    }
  });
});

describe('Tier-3 owner routing: the email-shaped ask still reaches the email owner', () => {
  it('routes a plainly email-shaped ask to communications-bot', async () => {
    const decision = await routeAsk('summarize my inbox and what did i miss in email today');
    expect(decision.strategy).toBe('keyword');
    expect(decision.winner.agentId, 'routed to ' + named(decision)).toBe(COMMUNICATIONS_BOT);
  });
});

describe('Tier-3 owner routing: a phrase keyword counts once, not once per token', () => {
  const phraseOwner: RouteCandidate = {
    agentId: 'f0000000-0000-0000-0000-0000000000aa',
    name: 'phrase-owner',
    score: 0,
    reason: 'synthetic',
    capabilities: [],
    routingKeywords: ['profit and loss'],
  };

  it('loses to a bot that genuinely matches two separate single-word keywords', async () => {
    const twoWordOwner: RouteCandidate = {
      agentId: 'f0000000-0000-0000-0000-0000000000bb',
      name: 'two-word-owner',
      score: 0,
      reason: 'synthetic',
      capabilities: [],
      routingKeywords: ['profit', 'loss'],
    };
    // phraseOwner is FIRST, so it wins any tie: it can only lose if its one phrase scored 1
    // while twoWordOwner scored 2. Counting the phrase per constituent token would tie at 2.
    const decision = await routeAsk('quarterly profit and loss review', [phraseOwner, twoWordOwner]);
    expect(decision.strategy).toBe('keyword');
    expect(decision.winner.agentId, 'routed to ' + named(decision)).toBe(twoWordOwner.agentId);
  });

  it('still lets a phrase owner claim the ask when the phrase is actually present', async () => {
    const decision = await routeAsk('quarterly profit and loss review', [phraseOwner]);
    expect(decision.strategy).toBe('keyword');
    expect(decision.winner.agentId).toBe(phraseOwner.agentId);
  });
});

describe('Tier-3 owner routing: single-word corpora still win on one hit (no claim threshold)', () => {
  // These bots declare nothing but single words, so their best possible Tier-3 score is small.
  // A minimum-claim threshold would silently disown all of them; these cases go red if one lands.
  const SINGLE_WORD_OWNERS: ReadonlyArray<{ ask: string; agentId: string; owner: string }> = [
    { ask: "what's the weather tomorrow", agentId: WEATHER_BOT, owner: 'weather-bot' },
    { ask: 'play some music', agentId: SPOTIFY_CONCIERGE, owner: 'spotify-concierge' },
    { ask: 'what movie should i watch tonight', agentId: MOVIES_CONCIERGE, owner: 'movies-concierge' },
    { ask: "what's on my calendar tomorrow", agentId: COMMUNICATIONS_BOT, owner: 'communications-bot (calendar)' },
  ];

  for (const { ask, agentId, owner } of SINGLE_WORD_OWNERS) {
    it('routes "' + ask + '" to ' + owner, async () => {
      const decision = await routeAsk(ask);
      expect(decision.strategy).toBe('keyword');
      expect(decision.winner.agentId, 'routed to ' + named(decision)).toBe(agentId);
    });
  }
});
