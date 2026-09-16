/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added extension-layer agent router scaffold for selection and delegation logic
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Wired SelectionBidService into routing decision flow for bid-aware winner selection
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Upgraded to 4-tier routing cascade: bid auction → LLM fallback → keyword match → catch-all (legacy parity)
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added taskText tokenization so routing can use work-unit descriptions and acceptance criteria, not just ticket titles
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Replaced fuzzy phrase substring matching with normalized token overlap so QA phrases stop overmatching build tickets
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Tier 3 matches MULTI-WORD routing keywords as phrases instead of shredding them into tokens. A declared phrase such as 'what did i miss' was flattened to the routable token 'did' (3 chars, absent from ROUTING_STOP_WORDS), so the comms owners claimed any ticket merely containing that word - the reason a trading P&L question routed to the email bot. Phrases are now tested with includes() against the lowercased title+taskText, exactly as the Tier-1 self-score does, and are counted ONCE; single-word keywords and all capabilities keep token matching. Deliberately NO minimum-claim threshold: swept against the registry+persona corpus a threshold silently disowns every bot whose vocabulary is single words (weather, music, movies, calendar).
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Made phrase matching ADDITIVE instead of a replacement, and moved the 'did' class into the stop list. Entry 7 removed a phrase's constituent tokens from the candidate's token bag, so a bot whose vocabulary is mostly phrases lost it whenever the caller rephrased: 'find idle gce instances' no longer reached cloud-ops-bot (declares 'gce instance'), 'run a survey flight pattern' no longer reached drone-operator (declares 'survey pattern'), and five more owners were measured losing their ticket. Now an EXACT phrase hit scores PHRASE_MATCH_WEIGHT (worth more than one token), while an unmatched phrase still contributes its tokens, so nothing is taken away. The actual cause of the email misroute - the bare auxiliary 'did' being routable at all - is fixed where it belongs: ROUTING_STOP_WORDS gains the auxiliaries and interrogatives, measured against the real corpus as costing one declared keyword versus 31 for the minimum-token-length lever, which is why that lever was rejected. Tier 3 also no longer bails on an empty token bag alone, or an ask made entirely of stop words would skip phrase matching it can still answer. Still NO minimum-claim threshold - it disowns every single-word corpus (weather, career, spotify, calendar, movies).
 */

import { createChildLogger } from '@/shared/logger';
import type { AgentBid } from './selection-bid-service';
import { SelectionBidService } from './selection-bid-service';

const logger = createChildLogger({ module: 'agent-router' });

/**
 * @description Well-known project-manager agent ID used as the catch-all fallback.
 */
const PROJECT_MANAGER_AGENT_ID = 'a0000000-0000-0000-0000-000000000001';

/**
 * @description Minimum bid confidence threshold. Bids below this are not considered.
 */
const BID_CONFIDENCE_THRESHOLD = 0.5;

/**
 * @description Score a declared multi-word routing keyword earns when it appears VERBATIM in the
 * ticket text. It is deliberately greater than a single token hit (1): an exact phrase is stronger
 * evidence of ownership than one loose word. It is deliberately LESS than the phrase's word count,
 * so a long declared phrase can never out-score a bot that matched that many independent keywords.
 */
const PHRASE_MATCH_WEIGHT = 2;

/**
 * @description Route context assembled from task, tenant, and workspace state.
 */
export interface RouteContext {
  taskId: string;
  tenantId?: string;
  workspaceRole?: string;
  requiredCapabilities?: string[];
  bids?: AgentBid[];
  ticketTitle?: string;
  ticketLabels?: string[];
  taskText?: string;
}

/**
 * @description Candidate agent for routing decisions.
 */
export interface RouteCandidate {
  agentId: string;
  name?: string;
  score: number;
  reason: string;
  capabilities?: string[];
  routingKeywords?: string[];
  selectorDescriptor?: string;
}

/**
 * @description Routing strategy indicating which tier produced the decision.
 */
export type RoutingStrategy = 'bid' | 'llm' | 'keyword' | 'score' | 'catch-all';

/**
 * @description Router output with deterministic winner and ranked alternatives.
 */
export interface RouteDecision {
  winner: RouteCandidate;
  ranked: RouteCandidate[];
  strategy: RoutingStrategy;
}

/**
 * @description Optional LLM-based routing function. When provided, the router calls
 * this as Tier 2 after bid auction fails. The function receives the task context and
 * candidates and returns the chosen agent ID, or null to fall through to Tier 3.
 */
export type LLMRoutingFunction = (
  context: RouteContext,
  candidates: RouteCandidate[],
) => Promise<string | null>;

/**
 * @description 4-tier routing cascade modeled after the legacy implementation's MeshBroadcastNetwork + LLMAgentRouter + CapabilityMatcher.
 *
 * Tier 1: Mesh Bid Auction — agents self-evaluate and submit confidence bids.
 *         Highest bid above threshold wins. (oshal: MeshBroadcastNetwork.js)
 * Tier 2: LLM-Based Routing — centralized LLM picks the best agent from candidates.
 *         Optional; falls through if no LLM function is configured. (oshal: LLMAgentRouter.js)
 * Tier 3: Capability Keyword Matching — matches required capabilities and ticket keywords
 *         against agent capability lists and routing keywords. (oshal: CapabilityMatcher.js)
 * Tier 4: Catch-All — project-manager handles the ticket directly. (oshal: QueueManagerService.js)
 */
export class AgentRouter {
  constructor(
    private readonly selectionBidService: SelectionBidService = new SelectionBidService(),
    private readonly llmRoutingFunction?: LLMRoutingFunction,
  ) {}

  /**
   * @description Routes a task to the best-fit agent using the 4-tier cascade.
   * @param context - Task and workspace context
   * @param candidates - Available agent candidates
   * @returns Route decision with winner, ranked list, and strategy used
   */
  async route(context: RouteContext, candidates: RouteCandidate[]): Promise<RouteDecision> {
    if (candidates.length === 0) {
      return this.catchAllFallback(context, candidates);
    }

    const ranked = [...candidates].sort((a, b) => b.score - a.score);

    // Tier 1: Bid Auction
    const bidResult = this.tryBidAuction(context, ranked);
    if (bidResult) return bidResult;

    // Tier 2: LLM-Based Routing
    const llmResult = await this.tryLLMRouting(context, ranked);
    if (llmResult) return llmResult;

    // Tier 3: Capability Keyword Matching
    const keywordResult = this.tryKeywordMatching(context, ranked);
    if (keywordResult) return keywordResult;

    // Tier 4: Score-based fallback (use pre-ranked candidates)
    if (ranked.length > 0) {
      logger.info(
        { taskId: context.taskId, strategy: 'score', winnerAgentId: ranked[0].agentId, candidateCount: ranked.length },
        'Tier 4: Resolved via score ranking',
      );
      return { winner: ranked[0], ranked, strategy: 'score' };
    }

    // Ultimate fallback: project-manager catch-all
    return this.catchAllFallback(context, ranked);
  }

  /**
   * @description Tier 1: Bid auction — highest confidence bid above threshold wins.
   */
  private tryBidAuction(context: RouteContext, ranked: RouteCandidate[]): RouteDecision | null {
    if (!context.bids || context.bids.length === 0) return null;

    const qualifiedBids = context.bids.filter((b) => b.confidence >= BID_CONFIDENCE_THRESHOLD);
    if (qualifiedBids.length === 0) {
      logger.info({ taskId: context.taskId, bidCount: context.bids.length }, 'Tier 1: All bids below confidence threshold — falling through');
      return null;
    }

    const winningBid = this.selectionBidService.chooseWinner(qualifiedBids);
    const bidWinner = ranked.find((c) => c.agentId === winningBid.agentId);

    if (bidWinner) {
      logger.info(
        { taskId: context.taskId, strategy: 'bid', bidWinnerAgentId: bidWinner.agentId, confidence: winningBid.confidence, bidCount: qualifiedBids.length },
        'Tier 1: Resolved via bid auction',
      );
      return { winner: bidWinner, ranked, strategy: 'bid' };
    }

    logger.warn(
      { taskId: context.taskId, bidWinnerAgentId: winningBid.agentId },
      'Tier 1: Bid winner not in candidate set — falling through',
    );
    return null;
  }

  /**
   * @description Tier 2: LLM-based routing — asks an LLM to pick the best agent.
   */
  private async tryLLMRouting(context: RouteContext, ranked: RouteCandidate[]): Promise<RouteDecision | null> {
    if (!this.llmRoutingFunction) return null;

    try {
      const chosenAgentId = await this.llmRoutingFunction(context, ranked);
      if (!chosenAgentId) {
        logger.info({ taskId: context.taskId }, 'Tier 2: LLM routing returned no selection — falling through');
        return null;
      }

      const llmWinner = ranked.find((c) => c.agentId === chosenAgentId);
      if (llmWinner) {
        logger.info(
          { taskId: context.taskId, strategy: 'llm', winnerAgentId: llmWinner.agentId },
          'Tier 2: Resolved via LLM routing',
        );
        return { winner: llmWinner, ranked, strategy: 'llm' };
      }

      logger.warn(
        { taskId: context.taskId, chosenAgentId },
        'Tier 2: LLM-chosen agent not in candidate set — falling through',
      );
    } catch (error) {
      logger.warn({ err: error, taskId: context.taskId }, 'Tier 2: LLM routing failed — falling through');
    }

    return null;
  }

  /**
   * @description Tier 3: Capability keyword matching — scores candidates based on
   * overlap between required capabilities / ticket keywords and agent capabilities / routing keywords.
   */
  private tryKeywordMatching(context: RouteContext, ranked: RouteCandidate[]): RouteDecision | null {
    const searchTerms = buildSearchTerms(context);
    const phraseText = buildPhraseMatchText(context);
    // An all-stop-word ask ('get me to ...') still has phrases to match, so this tier may only
    // bail when there is NOTHING to compare against - bailing on empty tokens alone would
    // silently disown every keyword a bot declares purely as a phrase of common words.
    if (searchTerms.length === 0 && phraseText.trim().length === 0) return null;
    const scored = ranked
      .map((candidate) => ({
        candidate,
        keywordScore: computeKeywordScore(candidate, searchTerms, phraseText),
      }))
      .filter((s) => s.keywordScore > 0)
      .sort((a, b) => b.keywordScore - a.keywordScore);

    if (scored.length === 0) {
      logger.info({ taskId: context.taskId, searchTermCount: searchTerms.length }, 'Tier 3: No keyword matches — falling through');
      return null;
    }

    const winner = scored[0].candidate;
    logger.info(
      { taskId: context.taskId, strategy: 'keyword', winnerAgentId: winner.agentId, keywordScore: scored[0].keywordScore, matchCount: scored.length },
      'Tier 3: Resolved via keyword matching',
    );
    return { winner, ranked, strategy: 'keyword' };
  }

  /**
   * @description Ultimate catch-all — creates or finds project-manager as the fallback agent.
   */
  private catchAllFallback(context: RouteContext, ranked: RouteCandidate[]): RouteDecision {
    const pmCandidate = ranked.find((c) => c.agentId === PROJECT_MANAGER_AGENT_ID)
      ?? { agentId: PROJECT_MANAGER_AGENT_ID, score: 0, reason: 'catch-all fallback to project-manager' };

    logger.info(
      { taskId: context.taskId, strategy: 'catch-all', winnerAgentId: pmCandidate.agentId },
      'Tier 4: Catch-all fallback to project-manager',
    );
    return { winner: pmCandidate, ranked: ranked.length > 0 ? ranked : [pmCandidate], strategy: 'catch-all' };
  }
}

/**
 * @description Builds search terms from context: required capabilities + ticket title/label tokens.
 */
function buildSearchTerms(context: RouteContext): string[] {
  const terms: string[] = [];

  if (context.requiredCapabilities) {
    for (const capability of context.requiredCapabilities) {
      terms.push(...tokenizeRoutingText(capability));
    }
  }

  if (context.ticketTitle) {
    terms.push(...tokenizeRoutingText(context.ticketTitle));
  }

  if (context.ticketLabels) {
    for (const label of context.ticketLabels) {
      terms.push(...tokenizeRoutingText(label));
    }
  }

  if (context.taskText) {
    terms.push(...tokenizeRoutingText(context.taskText));
  }

  return [...new Set(terms)];
}

/**
 * @description Builds the raw lowercased text a multi-word routing keyword is tested against.
 * Phrases must be matched against the ORIGINAL text, not the token bag: tokenizing them is
 * exactly what loses the phrase. Mirrors the Tier-1 self-score text in mesh-bid-responder so a
 * bot is matched here on the same string it bids on there.
 * @param context - Route context carrying the ticket title and the work-unit text.
 * @returns Lowercased ticket title joined to the task text.
 */
function buildPhraseMatchText(context: RouteContext): string {
  return `${context.ticketTitle ?? ''}\n${context.taskText ?? ''}`.toLowerCase();
}

/**
 * @description Splits declared routing keywords into multi-word PHRASES and single words, so the
 * scorer can test a phrase verbatim first. This split does NOT cost a phrase its tokens — an
 * unmatched phrase is handed back to token matching by computeKeywordScore. Phrases are
 * de-duplicated so a repeated declaration cannot inflate a score.
 * @param values - The candidate's declared routing keywords (persona routing_keywords).
 * @returns Lowercased unique phrases and the untouched single-word keywords.
 */
function splitRoutingKeywords(values: string[] | undefined): { phrases: string[]; singles: string[] } {
  const phrases = new Set<string>();
  const singles: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    if (/\s/.test(trimmed)) {
      phrases.add(trimmed.toLowerCase());
    } else {
      singles.push(trimmed);
    }
  }
  return { phrases: [...phrases], singles };
}

/**
 * @description Scores a candidate on its overlap with the ticket, phrase-aware and ADDITIVE.
 * A declared multi-word keyword is first tested VERBATIM against the ticket text — the same string
 * Tier 1 self-scores against in mesh-bid-responder.computeBidConfidence — and an exact hit is worth
 * PHRASE_MATCH_WEIGHT, more than any single loose word. A phrase that does NOT appear verbatim is not
 * discarded: its constituent tokens rejoin the candidate's token bag, so a caller who rephrases
 * ('find idle gce instances' against the declared 'gce instance') still reaches the owner. Phrase
 * matching therefore only ever ADDS evidence; it never removes vocabulary a bot already had.
 * Capabilities and single-word routing keywords are token-matched exactly as before.
 * @param candidate - The agent candidate carrying its declared capabilities and routing keywords.
 * @param searchTerms - Normalized tokens drawn from the ticket title, labels and task text.
 * @param phraseText - The raw lowercased ticket text a phrase is tested against verbatim.
 * @returns The candidate's Tier-3 score: one point per distinct token hit plus PHRASE_MATCH_WEIGHT per exact phrase hit.
 */
function computeKeywordScore(candidate: RouteCandidate, searchTerms: string[], phraseText: string): number {
  const { phrases, singles } = splitRoutingKeywords(candidate.routingKeywords);
  const matchedPhrases: string[] = [];
  const unmatchedPhrases: string[] = [];
  for (const phrase of phrases) {
    (phraseText.includes(phrase) ? matchedPhrases : unmatchedPhrases).push(phrase);
  }
  const candidateTerms = new Set([
    ...flattenRoutingTerms(candidate.capabilities),
    ...flattenRoutingTerms(singles),
    ...flattenRoutingTerms(unmatchedPhrases),
  ]);
  const tokenScore = searchTerms.reduce((score, term) => score + (candidateTerms.has(term) ? 1 : 0), 0);
  return tokenScore + matchedPhrases.length * PHRASE_MATCH_WEIGHT;
}

/**
 * @description Flattens freeform routing phrases into normalized keyword tokens.
 * @param values - Candidate capability or routing-keyword phrases.
 * @returns Normalized routing tokens.
 */
function flattenRoutingTerms(values: string[] | undefined): string[] {
  if (!values) {
    return [];
  }
  return values.flatMap((value) => tokenizeRoutingText(value));
}

/**
 * @description Tokenizes freeform routing text into normalized comparison terms.
 * @param value - Source text from title, labels, descriptions, or capability phrases.
 * @returns Normalized tokens with stop-words removed.
 */
function tokenizeRoutingText(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[\s\-_/.,;:()]+/)
    .map((token) => normalizeRoutingToken(token))
    .filter((token) => token.length > 2 && !ROUTING_STOP_WORDS.has(token));
}

/**
 * @description Normalizes a routing token to reduce inflection noise in keyword matching.
 * @param token - Raw token.
 * @returns Normalized token stem.
 */
function normalizeRoutingToken(token: string): string {
  const trimmed = token.replaceAll(/[^a-z0-9]+/g, '');
  if (trimmed.endsWith('ation')) return trimmed.slice(0, -5);
  if (trimmed.endsWith('ing')) return trimmed.slice(0, -3);
  if (trimmed.endsWith('ed')) return trimmed.slice(0, -2);
  if (trimmed.endsWith('es')) return trimmed.slice(0, -2);
  if (trimmed.endsWith('s')) return trimmed.slice(0, -1);
  return trimmed;
}

const ROUTING_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'inside',
  'your',
  'their',
  'then',
  'than',
  'when',
  'where',
  'while',
  'must',
  'should',
  // Auxiliaries and interrogatives. These carry no domain signal, yet they are long enough to
  // survive the length filter, so ANY bot that declares a conversational phrase containing one
  // ('what did i miss') used to claim every ticket merely containing that word - the token 'did'
  // sent a trading P&L question to the email bot, and the token 'what' sent 'what's the weather
  // tomorrow' to a feed curator. Measured against the registry+persona corpus this costs ONE
  // declared keyword ('get me to'), which phrase matching recovers verbatim. The alternative
  // lever - raising the minimum routable token length to 4 - was measured and rejected: it
  // silently disowns 31 declared keywords, among them 'gcp', 'rtl' and 'dim'.
  // Words that cannot survive normalizeRoutingToken ('does'/'do', 'was', 'has', 'made') are not
  // listed: they are already dropped by the length filter and an entry for them would be dead.
  'did',
  'were',
  'have',
  'had',
  'will',
  'can',
  'get',
  'got',
  'make',
  'what',
  'how',
  'who',
  'whom',
  'whose',
  'which',
  'why',
]);
