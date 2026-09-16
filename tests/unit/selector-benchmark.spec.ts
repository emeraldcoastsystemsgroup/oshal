/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the selection benchmark. It measures, end to end through the REAL AgentRouter, how often the right owner wins an ask phrased the way a person types it. Candidates are built the way boot builds them (capabilities from LOCAL_BOT_REGISTRY, routing keywords read off the on-disk persona YAML the seeders read, minus the four bots the ADR-083 call-out never lets win); every candidate's Tier-1 bid is computed with the REAL exported computeBidConfidence and passed in, so the bid auction is genuinely exercised instead of skipped with bids:[]. The corpus covers every registered bot that declares a domain, several asks each, and pins the phrasings that have already misrouted in production.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import * as yaml from 'js-yaml';
import { LOCAL_BOT_REGISTRY } from '../../src/app/extensions/swarm/swarm-bot-registry-local';
import { AgentRouter, type AgentBid, type RouteCandidate, type RoutingStrategy } from '../../src/features/agent-management';
import { computeBidConfidence } from '../../src/features/agent-management/services/mesh-bid-responder';

const REPO_ROOT = join(__dirname, '..', '..');
const PERSONA_DIR = join(REPO_ROOT, 'ai-lab', 'bot-personas');
const COMPOSE_FILE = join(REPO_ROOT, 'docker-compose.oshal-local.yml');

/**
 * The four agents task-call-out.ts removes from every generic call-out (CALL_OUT_EXCLUDED_AGENT_IDS):
 * the PM, the Jarvis brain, the privileged platform developer and the queue reviewer. They are
 * mirrored here rather than imported because that constant is module-private; a corpus guard below
 * asserts each id is still registered, so the mirror cannot rot silently.
 */
const CALL_OUT_EXCLUDED_AGENT_IDS: ReadonlySet<string> = new Set([
  'a0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000050',
  'de000000-0000-0000-0000-000000000001',
  'f0000000-0000-0000-0000-000000000001',
]);

/** MeshBidBroadcaster drops a response below this before the router ever sees it. */
const MIN_CLAIM_CONFIDENCE = 0.3;
/** createMeshBidResponder stays silent below this — a bot with no evidence never answers. */
const RESPONDER_SILENCE_FLOOR = 0.05;

/**
 * @description Persona file per bot, resolved the way the runtime resolves it: a bot with its own
 * container is seeded from its compose service's BOT_PERSONA_FILE (agent-profile-boot-seeder), an
 * inline controller bot from ai-lab/bot-personas/<name>.yaml (inline-controller-bot-seeder).
 * @returns Lowercased agentId to persona file basename.
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

/**
 * @description Reads routing_keywords off a persona YAML exactly as the boot seeders and the mesh
 * bid responder read them.
 * @param personaFile - Persona file basename under ai-lab/bot-personas.
 * @returns Declared routing keywords, trimmed; empty when the persona declares none.
 */
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
 * @description The live routing corpus: one candidate per registered bot the call-out can actually
 * award, carrying the two declarations the boot seeders write into the agents table. Every score is
 * 0, so Tier 4 can only ever return the first candidate — a win has to come from Tier 1 or Tier 3.
 * @returns Candidates in registry order.
 */
function buildLiveCorpus(): RouteCandidate[] {
  const personaByAgentId = personaFileByAgentId();
  return LOCAL_BOT_REGISTRY
    .filter((bot) => !CALL_OUT_EXCLUDED_AGENT_IDS.has(bot.agentId))
    .map((bot) => {
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
const NAME_BY_ID = new Map(LIVE_CORPUS.map((candidate) => [candidate.agentId, candidate.name ?? candidate.agentId]));

/**
 * @description Every candidate's Tier-1 self-score for one ask, through the REAL exported
 * computeBidConfidence, then through the same two floors the live rail applies: the responder stays
 * silent below 0.05, and MeshBidBroadcaster.toBids drops anything below 0.3.
 * @param ask - The ticket title, as a person typed it.
 * @returns The bids the router actually receives.
 */
function bidsFor(ask: string): AgentBid[] {
  return LIVE_CORPUS
    .map((candidate) => ({
      agentId: candidate.agentId,
      confidence: computeBidConfidence(
        { title: ask, description: '', requiredCapabilities: [] },
        {
          agentName: candidate.name ?? '',
          capabilities: candidate.capabilities ?? [],
          routingKeywords: candidate.routingKeywords ?? [],
        },
      ),
      estimatedCost: 0,
      estimatedLatencyMs: 0,
    }))
    .filter((bid) => bid.confidence >= RESPONDER_SILENCE_FLOOR && bid.confidence >= MIN_CLAIM_CONFIDENCE);
}

/** One measured routing outcome. */
interface BenchOutcome {
  ask: string;
  expected: readonly string[];
  winner: string;
  strategy: RoutingStrategy;
  topBid: number;
  correct: boolean;
}

/**
 * @description Routes one ask through the real cascade with real bids.
 * @param ask - The ticket title.
 * @param expected - Accepted owner names (more than one only where two bots genuinely share a declared vocabulary).
 * @returns What happened, for both the assertions and the report.
 */
async function routeAsk(ask: string, expected: readonly string[] = []): Promise<BenchOutcome> {
  const bids = bidsFor(ask);
  const decision = await new AgentRouter().route(
    { taskId: 'bench', ticketTitle: ask, taskText: '', requiredCapabilities: [], bids },
    LIVE_CORPUS,
  );
  const winner = NAME_BY_ID.get(decision.winner.agentId) ?? decision.winner.agentId;
  return {
    ask,
    expected,
    winner,
    strategy: decision.strategy,
    topBid: bids.reduce((top, bid) => Math.max(top, bid.confidence), 0),
    correct: expected.includes(winner),
  };
}

/** One ask and the bot (or genuinely-overlapping pair of bots) that owns its subject. */
interface BenchCase { readonly ask: string; readonly owners: readonly string[] }

/**
 * The corpus. Every ask is phrased the way a person types it, never as the declared keyword string.
 * `owners` holds more than one name ONLY where two registered bots declare a genuinely overlapping
 * vocabulary (the QA pair, the two video owners); everywhere else exactly one bot owns the subject.
 */
const BENCH: readonly BenchCase[] = [
  { ask: "we're out of milk again, add it to the grocery list", owners: ['shopping-concierge'] },
  { ask: 'find a cheaper price on a robot vacuum at walmart', owners: ['shopping-concierge'] },
  { ask: 'reorder the coffee pods i bought last month', owners: ['shopping-concierge'] },
  { ask: "i'm hungry, order pizza for dinner tonight", owners: ['eats-concierge'] },
  { ask: 'what restaurants near me deliver tacos', owners: ['eats-concierge'] },
  { ask: 'get me to the airport by six in the morning', owners: ['rides-concierge'] },
  { ask: 'how much is an uber to downtown right now', owners: ['rides-concierge'] },
  { ask: 'catch me up on the hot channels in slack', owners: ['feeds-curator'] },
  { ask: 'summarize slack, what is trending in my channels', owners: ['feeds-curator'] },
  { ask: 'book a flight to denver next friday', owners: ['travel-concierge'] },
  { ask: 'find a cheap hotel near the conference downtown', owners: ['travel-concierge'] },
  { ask: 'i need a rental car for the trip', owners: ['travel-concierge'] },
  { ask: 'does this deliverable pass the quality gate, approve or reject it', owners: ['task-manager'] },
  { ask: 'implement the new export button and fix the bug in the parser', owners: ['code-developer'] },
  { ask: 'refactor this module so the feature actually works', owners: ['code-developer'] },
  { ask: 'the deploy pipeline is broken, check the docker container', owners: ['devops-bot'] },
  { ask: 'set up a cicd pipeline for this kubernetes cluster', owners: ['devops-bot'] },
  { ask: 'review this pull request for security issues and lint problems', owners: ['code-reviewer'] },
  { ask: 'audit the code quality and best practices in this module', owners: ['code-reviewer'] },
  { ask: 'write a readme and an adr for this feature', owners: ['documentation-writer'] },
  { ask: 'update the user guide and the technical docs', owners: ['documentation-writer'] },
  { ask: "find the root cause of last night's outage", owners: ['rca-specialist'] },
  { ask: 'investigate why the service crashed, i need a root cause analysis', owners: ['rca-specialist'] },
  { ask: 'we have an outage, start incident triage and page the escalation list', owners: ['incident-response-bot'] },
  { ask: 'follow the runbook for this production outage', owners: ['incident-response-bot'] },
  { ask: 'summarize my inbox and what did i miss in email today', owners: ['communications-bot'] },
  { ask: "what's on my calendar tomorrow, draft a reply to the meeting invite", owners: ['communications-bot'] },
  { ask: 'send a text message to my wife', owners: ['communications-bot'] },
  { ask: "what's the forecast for tomorrow, will it rain", owners: ['weather-bot'] },
  { ask: 'what are the weather conditions this weekend', owners: ['weather-bot'] },
  { ask: 'author a new bot persona and emit the manifest for it', owners: ['codex-packer'] },
  { ask: 'gather the requirements from the discovery transcript and do a gap analysis', owners: ['delivery-analyst'] },
  { ask: 'define the scope and write the user stories from the baseline', owners: ['delivery-analyst'] },
  { ask: 'project the capacity and throughput for this growth curve', owners: ['delivery-sizer'] },
  { ask: 'run explain analyze on that query and benchmark the connection pool', owners: ['delivery-sizer'] },
  { ask: 'draw up the reference architecture with a hosting cost comparison', owners: ['delivery-architect'] },
  { ask: "what's our disaster recovery and high availability plan", owners: ['delivery-architect'] },
  { ask: 'verify the deployed parity and package the handover artifact', owners: ['delivery-verifier'] },
  { ask: 'add a regression guard and a browser test as proof', owners: ['delivery-verifier'] },
  { ask: 'draft a linkedin post about our launch with a strong hook', owners: ['social-writer'] },
  { ask: 'rewrite my tweet thread so it has a better cta', owners: ['social-writer'] },
  { ask: 'where are my files, show me the folder on dropbox', owners: ['storage-assistant'] },
  { ask: 'create a github repo and back it up to google drive', owners: ['storage-assistant'] },
  { ask: 'build me a slide deck for the investor pitch', owners: ['deck-builder'] },
  { ask: 'make me an excel spreadsheet of the numbers', owners: ['deck-builder'] },
  { ask: 'i need a storyboard for a short tiktok reel', owners: ['video-director'] },
  { ask: 'give me a video idea for youtube shorts', owners: ['video-director', 'vids-operator'] },
  { ask: 'generate a video with veo for the b-roll', owners: ['vids-operator'] },
  { ask: 'open vids and plan the shot list', owners: ['vids-operator'] },
  { ask: 'write the next episode script with dialogue for the kids show', owners: ['screenplay-writer'] },
  { ask: 'draft a series bible for my cartoon screenplay', owners: ['screenplay-writer'] },
  { ask: 'grade this output against the rubric and give it a score', owners: ['quality-judge'] },
  { ask: 'judge the quality of these two answers and give a verdict', owners: ['quality-judge'] },
  { ask: 'talk to me in the spooky jack-o-lantern voice for halloween', owners: ['pumpkin-bot'] },
  { ask: 'set up the pumpkin prop projector for trick or treat night', owners: ['pumpkin-bot'] },
  { ask: 'enrich the person model from this ambient transcript', owners: ['ambient-analyst'] },
  { ask: 'infer the tone and intent from what they said', owners: ['ambient-analyst'] },
  { ask: 'what is my net worth across my bank accounts', owners: ['finance-analyst'] },
  { ask: 'show me my spending and cash flow for the month', owners: ['finance-analyst'] },
  { ask: 'How did we do in the stock market today?', owners: ['trading-analyst'] },
  { ask: 'How much money did we make in the stock market today?', owners: ['trading-analyst'] },
  { ask: 'what is my portfolio worth and what were the fills today', owners: ['trading-analyst'] },
  { ask: 'did the autopilot open any positions this morning', owners: ['trading-analyst'] },
  { ask: 'sell my alpaca position in nvidia', owners: ['trading-analyst'] },
  { ask: 'review this false positive alert', owners: ['security-analyst'] },
  { ask: 'assess the threat from this security finding', owners: ['security-analyst'] },
  { ask: 'what is the press saying about the fed decision', owners: ['world-analyst'] },
  { ask: 'give me the headlines and the media bias from that outlet', owners: ['world-analyst'] },
  { ask: 'run a survey flight pattern over the north field', owners: ['drone-operator'] },
  { ask: 'plan the drone waypoints and set a geofence before takeoff', owners: ['drone-operator'] },
  { ask: 'start recording on the gopro and take a photo', owners: ['camera-operator'] },
  { ask: 'show me the webcam preview', owners: ['camera-operator'] },
  { ask: 'draft the command for the satellite on the next pass window', owners: ['sat-operator'] },
  { ask: 'scan my room and build a gaussian splat of it', owners: ['spaces-operator'] },
  { ask: 'check the wifi coverage from the lidar scan', owners: ['spaces-operator'] },
  { ask: 'which of my connected accounts have an expired login', owners: ['identity-advisor'] },
  { ask: 'show me duplicate accounts and unused connections', owners: ['identity-advisor'] },
  { ask: 'design a workflow for this approval process end to end', owners: ['workflow-assistant'] },
  { ask: 'build the orchestration pipeline for these steps', owners: ['workflow-assistant'] },
  { ask: 'turn off the kitchen plug', owners: ['home-bot'] },
  { ask: 'dim the living room lights and lock the front door', owners: ['home-bot'] },
  { ask: 'find idle gce instances and shut them down', owners: ['cloud-ops-bot'] },
  { ask: 'check my storage buckets for a missing owner label', owners: ['cloud-ops-bot'] },
  { ask: 'what is my gcp billing this month, can i rightsize the vms', owners: ['cloud-ops-bot'] },
  { ask: 'research the competitive landscape and write me a report', owners: ['research-bot'] },
  { ask: 'study the options and evaluate which one wins', owners: ['research-bot'] },
  { ask: 'write the unit tests and check regression coverage', owners: ['test-engineer', 'tester-bot'] },
  { ask: 'run the e2e suite and verify the acceptance criteria', owners: ['test-engineer', 'tester-bot'] },
  { ask: 'write the architecture for the new integration', owners: ['system-architect'] },
  { ask: 'produce a technical specification and a decomposition plan', owners: ['system-architect'] },
  { ask: 'draft a fix plan and a rollback for this mitigation', owners: ['incident-remediation-bot'] },
  { ask: 'play some music from my workout playlist', owners: ['spotify-concierge'] },
  { ask: 'make me a playlist of chill tracks by that artist', owners: ['spotify-concierge'] },
  { ask: 'what movie should i watch tonight', owners: ['movies-concierge'] },
  { ask: 'where can i stream that new series, is it on netflix', owners: ['movies-concierge'] },
  { ask: 'triage this sources sought solicitation on sam.gov', owners: ['capture-specialist'] },
  { ask: 'what is the win theme and the pricing for this rfp', owners: ['capture-specialist'] },
  { ask: 'prioritize the crm pipeline and advance the next action on the board', owners: ['capture-coordinator'] },
  { ask: 'broker a short lived credential for this privileged job', owners: ['vault-bot'] },
  { ask: 'submit my application on greenhouse and autofill the ats form', owners: ['apply-operator'] },
  { ask: 'apply to that job on workday for me', owners: ['apply-operator'] },
  { ask: 'update my linkedin headline', owners: ['linkedin-profile-operator'] },
  { ask: 'change my linkedin background banner and featured resume', owners: ['linkedin-profile-operator'] },
  { ask: 'how big is the market impact of this event', owners: ['trading-research-analyst'] },
  { ask: 'how does this disaster drive demand for supplies', owners: ['weather-analyst'] },
];

/**
 * HELD-OUT corpus. Written AFTER the self-score was locked and measured exactly once, so the main
 * corpus above cannot be the only thing the formula was shaped against. These are deliberately
 * loose: several use none of the owner's declared words, and a few are genuinely ambiguous between
 * two owners. Its floor is the number it actually scored, not a number anyone aimed at.
 */
const HELD_OUT: readonly BenchCase[] = [
  { ask: 'did anything important land in my email overnight', owners: ['communications-bot'] },
  { ask: 'cancel the 3pm meeting and let them know', owners: ['communications-bot'] },
  { ask: 'is it going to snow this week', owners: ['weather-bot'] },
  { ask: 'how are my holdings doing this quarter', owners: ['finance-analyst'] },
  { ask: 'my alpaca account shows a weird fill', owners: ['trading-analyst'] },
  { ask: 'i want to watch something funny tonight on netflix', owners: ['movies-concierge'] },
  { ask: 'put on my morning playlist', owners: ['spotify-concierge'] },
  { ask: 'the front door lock is stuck, can you unlock the garage instead', owners: ['home-bot'] },
  { ask: 'spin up a new kubernetes namespace for staging', owners: ['devops-bot'] },
  { ask: 'our gcp bill jumped, find what changed', owners: ['cloud-ops-bot'] },
  { ask: 'somebody flagged a finding, is it a real threat', owners: ['security-analyst'] },
  { ask: 'we need a runbook for the database failover', owners: ['incident-response-bot', 'incident-remediation-bot'] },
  { ask: "put together slides for monday's board meeting", owners: ['deck-builder'] },
  { ask: 'draft a post for linkedin about the release', owners: ['social-writer'] },
  { ask: 'i need my resume banner refreshed on my profile', owners: ['linkedin-profile-operator'] },
  { ask: 'set a geofence before you fly', owners: ['drone-operator'] },
  { ask: 'order dinner from the thai place', owners: ['eats-concierge'] },
  { ask: 'i need a lyft to the train station', owners: ['rides-concierge'] },
  { ask: 'what airfare can you find to seattle', owners: ['travel-concierge'] },
  { ask: 'add paper towels to my list', owners: ['shopping-concierge'] },
  { ask: 'scan the garage so i can print a model of it', owners: ['spaces-operator'] },
  { ask: "what's everyone saying about the new tariffs", owners: ['world-analyst'] },
  { ask: 'give the last two answers a grade', owners: ['quality-judge'] },
  { ask: "walk me through the capacity we'll need at 10x traffic", owners: ['delivery-sizer'] },
  { ask: 'check if any of my logins expired', owners: ['identity-advisor'] },
  { ask: 'record a clip with the gopro', owners: ['camera-operator', 'vids-operator'] },
];

/** The phrasings that have already misrouted in production — each one is pinned individually. */
const BURNED: readonly BenchCase[] = [
  { ask: 'How did we do in the stock market today?', owners: ['trading-analyst'] },
  { ask: 'How much money did we make in the stock market today?', owners: ['trading-analyst'] },
  { ask: 'summarize my inbox and what did i miss in email today', owners: ['communications-bot'] },
  { ask: 'find idle gce instances and shut them down', owners: ['cloud-ops-bot'] },
  { ask: 'turn off the kitchen plug', owners: ['home-bot'] },
  { ask: 'update my linkedin headline', owners: ['linkedin-profile-operator'] },
  { ask: 'run a survey flight pattern over the north field', owners: ['drone-operator'] },
  { ask: 'review this false positive alert', owners: ['security-analyst'] },
];

/**
 * TODAY'S MEASUREMENT (2026-09-15) — the floor this benchmark must never fall below. Every number
 * below was taken by running THIS file against the live registry and the on-disk personas.
 *
 *   before (origin/main 33eefac4, min(1, hits/3) self-score over raw substrings):
 *       103/105 correct (98.1%), Tier 1 decided 78/105 (74.3%), Tier 3 decided 27; held-out 23/26
 *   after  (evidence self-score + no tied award):
 *       105/105 correct (100%),  Tier 1 decided 102/105 (97.1%), Tier 3 decided 3;  held-out 23/26
 *
 * No case that worked before is broken: the two "before" misses are both fixed (an uber question
 * that reached eats-concierge, and a regression-guard ask that reached test-engineer), and the
 * three held-out misses are the SAME three in both runs.
 *
 * The lever sweep behind the formula, all measured here, corpus accuracy / Tier-1 share:
 *   new matching, old min(1, hits/3) normalization ... 104/105,  91   (so the curve is worth +1/+11)
 *   min(1, ev/1) instead of the curve ................ 101/105,  67   REJECTED (saturates into ties)
 *   half-weight K = 0.4 / 0.6 / 0.8 / 1.0 ............ 105 / 105 / 105 / 104, 102/102/102/98
 *   capability words not counted as evidence ......... 101/105, 100   REJECTED (costs 4 owners)
 *   unmatched phrases lend no words .................. 101/105, 101   REJECTED (costs 4 owners)
 *   phrase weight 1 / 2 / 3 .......................... 105 / 105 / 105, 102/102/101
 *   specificity weighting, 1/df ...................... 102/105, 102   REJECTED (and −1 held-out)
 *   specificity weighting, 1/sqrt(df) ................ 102/105, 103   REJECTED (and −1 held-out)
 *   BID_CONFIDENCE_THRESHOLD 0.45 / 0.5 / 0.6 ........ 105 / 105 / 104, 102/102/98
 *   Tier-1 tie awarded instead of handed down ........ 104/105, 105   REJECTED (costs 1 owner)
 *
 * The three asks that still reach Tier 3 are decided there correctly; a tie at the Tier-1 lead is
 * deliberately handed down rather than awarded arbitrarily.
 */
const MIN_ACCURACY = 1;
const MIN_BID_TIER_SHARE = 102 / 105;
/** Held-out floor — what the held-out corpus actually scored, recorded rather than targeted. */
const MIN_HELD_OUT_CORRECT = 23;


const OUTCOMES: BenchOutcome[] = [];
const HELD_OUT_OUTCOMES: BenchOutcome[] = [];

describe('selection benchmark: the corpus this measurement runs against', () => {
  it('carries a declaration for every bot the corpus names as an owner', () => {
    const declaredOwners = new Set(BENCH.flatMap((benchCase) => benchCase.owners));
    for (const owner of declaredOwners) {
      const candidate = LIVE_CORPUS.find((entry) => entry.name === owner);
      expect(candidate, owner + ' is not a registered, call-out-eligible bot').toBeDefined();
      const declarations = (candidate!.routingKeywords ?? []).length + (candidate!.capabilities ?? []).length;
      expect(declarations, owner + ' declares neither routing keywords nor capabilities').toBeGreaterThan(0);
    }
  });

  it('still excludes exactly the four agents the call-out never awards', () => {
    for (const agentId of CALL_OUT_EXCLUDED_AGENT_IDS) {
      expect(
        LOCAL_BOT_REGISTRY.some((bot) => bot.agentId === agentId),
        agentId + ' left the registry — the mirrored exclusion list is stale',
      ).toBe(true);
      expect(LIVE_CORPUS.some((candidate) => candidate.agentId === agentId)).toBe(false);
    }
  });

  it('covers every registered bot that declares routing keywords', () => {
    const covered = new Set(BENCH.flatMap((benchCase) => benchCase.owners));
    const uncovered = LIVE_CORPUS
      .filter((candidate) => (candidate.routingKeywords ?? []).length > 0)
      .map((candidate) => candidate.name ?? candidate.agentId)
      .filter((name) => !covered.has(name));
    expect(uncovered, 'these bots declare a domain but no ask in the corpus asks for it').toEqual([]);
  });
});

describe('selection benchmark: end-to-end owner accuracy through the real cascade', () => {
  it('measures the whole corpus and holds the recorded accuracy floor', async () => {
    for (const benchCase of BENCH) {
      OUTCOMES.push(await routeAsk(benchCase.ask, benchCase.owners));
    }
    const correct = OUTCOMES.filter((outcome) => outcome.correct).length;
    const missed = OUTCOMES.filter((outcome) => !outcome.correct)
      .map((outcome) => '  "' + outcome.ask + '" -> ' + outcome.winner + ' (' + outcome.strategy + '), wanted ' + outcome.expected.join('|'))
      .join('\n');
    expect(
      correct / OUTCOMES.length,
      correct + '/' + OUTCOMES.length + ' correct. Misses:\n' + missed,
    ).toBeGreaterThanOrEqual(MIN_ACCURACY);
  });

  it('holds the recorded share of asks decided by the Tier-1 bid auction', () => {
    const bidDecided = OUTCOMES.filter((outcome) => outcome.strategy === 'bid').length;
    expect(
      bidDecided / OUTCOMES.length,
      bidDecided + '/' + OUTCOMES.length + ' asks were decided by the bid auction',
    ).toBeGreaterThanOrEqual(MIN_BID_TIER_SHARE);
  });
});

describe('selection benchmark: the phrasings that have already misrouted', () => {
  for (const { ask, owners } of BURNED) {
    it('routes "' + ask + '" to ' + owners.join(' or '), async () => {
      const outcome = await routeAsk(ask, owners);
      expect(owners, ask + ' -> ' + outcome.winner + ' via ' + outcome.strategy).toContain(outcome.winner);
    });
  }
});

describe('selection benchmark: the held-out corpus', () => {
  it('holds the number it actually scored the first time it was run', async () => {
    const outcomes: BenchOutcome[] = [];
    for (const benchCase of HELD_OUT) {
      outcomes.push(await routeAsk(benchCase.ask, benchCase.owners));
    }
    HELD_OUT_OUTCOMES.push(...outcomes);
    const correct = outcomes.filter((outcome) => outcome.correct).length;
    const missed = outcomes.filter((outcome) => !outcome.correct)
      .map((outcome) => '  "' + outcome.ask + '" -> ' + outcome.winner + ' (' + outcome.strategy + '), wanted ' + outcome.expected.join('|'))
      .join('\n');
    expect(correct, correct + '/' + outcomes.length + ' correct. Misses:\n' + missed).toBeGreaterThanOrEqual(MIN_HELD_OUT_CORRECT);
  });
});

describe('selection benchmark: Tier 1 only awards an auction it actually decided', () => {
  const owner = (suffix: string, name: string): RouteCandidate => ({
    agentId: 'f0000000-0000-0000-0000-0000000000' + suffix,
    name,
    score: 0,
    reason: 'synthetic',
    capabilities: [],
    routingKeywords: [],
  });
  const first = owner('a1', 'first-owner');
  const second = owner('a2', 'second-owner');

  it('awards the auction when exactly one bot leads it', async () => {
    const decision = await new AgentRouter().route(
      {
        taskId: 'tie',
        ticketTitle: 'nothing here matches any declared keyword',
        bids: [
          { agentId: first.agentId, confidence: 0.6, estimatedCost: 0, estimatedLatencyMs: 0 },
          { agentId: second.agentId, confidence: 0.9, estimatedCost: 0, estimatedLatencyMs: 0 },
        ],
      },
      [first, second],
    );
    expect(decision.strategy).toBe('bid');
    expect(decision.winner.agentId).toBe(second.agentId);
  });

  it('refuses to award a tie at the lead and falls through instead', async () => {
    // Every mesh BID_RESPONSE reports estimatedCost 0 and estimatedLatencyMs 0, so chooseWinner
    // cannot separate these two and would hand the ticket to whichever reply arrived first.
    const decision = await new AgentRouter().route(
      {
        taskId: 'tie',
        ticketTitle: 'nothing here matches any declared keyword',
        bids: [
          { agentId: first.agentId, confidence: 0.9, estimatedCost: 0, estimatedLatencyMs: 0 },
          { agentId: second.agentId, confidence: 0.9, estimatedCost: 0, estimatedLatencyMs: 0 },
        ],
      },
      [first, second],
    );
    expect(decision.strategy, 'a tied auction was awarded to ' + (decision.winner.name ?? '')).not.toBe('bid');
  });

  it('still awards when the tie is below the threshold and one qualified bid stands alone', async () => {
    const decision = await new AgentRouter().route(
      {
        taskId: 'tie',
        ticketTitle: 'nothing here matches any declared keyword',
        bids: [
          { agentId: first.agentId, confidence: 0.4, estimatedCost: 0, estimatedLatencyMs: 0 },
          { agentId: second.agentId, confidence: 0.4, estimatedCost: 0, estimatedLatencyMs: 0 },
          { agentId: first.agentId, confidence: 0.7, estimatedCost: 0, estimatedLatencyMs: 0 },
        ],
      },
      [first, second],
    );
    expect(decision.strategy).toBe('bid');
    expect(decision.winner.agentId).toBe(first.agentId);
  });
});

afterAll(() => {
  if (OUTCOMES.length === 0) return;
  const tiers = new Map<string, number>();
  for (const outcome of OUTCOMES) tiers.set(outcome.strategy, (tiers.get(outcome.strategy) ?? 0) + 1);
  const rows = OUTCOMES.map((outcome) => (outcome.correct ? '  ok  ' : ' MISS ')
    + outcome.strategy.padEnd(9) + 'bid=' + outcome.topBid.toFixed(2) + '  '
    + outcome.winner.padEnd(26) + ' <- ' + outcome.ask);
  const correct = OUTCOMES.filter((outcome) => outcome.correct).length;
  const heldCorrect = HELD_OUT_OUTCOMES.filter((outcome) => outcome.correct).length;
  const heldRows = HELD_OUT_OUTCOMES.map((outcome) => (outcome.correct ? '  ok  ' : ' MISS ')
    + outcome.strategy.padEnd(9) + 'bid=' + outcome.topBid.toFixed(2) + '  '
    + outcome.winner.padEnd(26) + ' <- ' + outcome.ask);
  // eslint-disable-next-line no-console
  console.log([
    '',
    '=== SELECTION BENCHMARK ===',
    ...rows,
    '---',
    'accuracy ' + correct + '/' + OUTCOMES.length + ' = ' + (100 * correct / OUTCOMES.length).toFixed(1) + '%',
    'tiers ' + [...tiers.entries()].map(([tier, count]) => tier + '=' + count).join(' '),
    '--- held out ---',
    ...heldRows,
    'held-out accuracy ' + heldCorrect + '/' + HELD_OUT_OUTCOMES.length,
  ].join('\n'));
});
