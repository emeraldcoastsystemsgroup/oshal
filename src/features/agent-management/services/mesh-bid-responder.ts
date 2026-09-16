/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the shared BID_REQUEST responder every swarm participant wires as its SwarmAgentWorker directHandler. Closes the ADR-083 Tier-1 gap: bot-node-server built its worker with NO directHandler, so nodes received call-outs over Redis and dropped them (responded: 0 on every broadcast). The self-score is a TRUE self-assessment: the bot scores the ticket text against its OWN declared routing keywords (persona) and required-capability overlap — no free confidence baseline, so a bot with zero domain signal cannot clear the auction threshold on luck.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Rebuilt the Tier-1 self-score around EVIDENCE instead of a count of declared keywords, because the count could not express ownership. min(1, hits/3) put ONE domain word at 0.30 - below the 0.5 auction threshold - so a bot could not claim its own subject unless the caller happened to use two or three of its words: measured, 'How did we do in the stock market today?' had trading-analyst bidding 0.30 on 'stock' and the ticket fell through to the cruder tiers. The match test was also a raw substring over the declared string, so a hyphenated declaration ('regression-guard') and an inflected word ('fill' against 'fills') were unmatchable, and a phrase-only vocabulary could not bid on any rephrasing - the same defect PR #531 fixed at Tier 3 and left standing here. Now: a declared PHRASE matched verbatim is worth 2, a declared single word (stem-matched, so 'fill' reaches 'fills') is worth 1, an UNMATCHED phrase still lends its constituent words at 0.5 each, and a declared capability lends its words at 0.5 - and each word of the ask counts ONCE, so twenty declarations cannot out-bid four on the same sentence. Evidence becomes confidence through ev/(ev+0.6) rather than a fixed /3: one specific declared word now clears the threshold, more evidence always ranks higher, and nothing saturates at a tie the 0.05 name tie-breaker then decides. Measured on tests/unit/selector-benchmark.spec.ts: 103/105 -> 105/105 correct owners, with the Tier-1 auction deciding 102/105 asks instead of 78. Every lever was measured on that benchmark, not guessed. KEPT: the saturating normalization (the same new matching under the old min(1, hits/3) reaches only 104/105 with the auction deciding 91); capability words as evidence (worth 4 owners - rca-specialist, sat-operator, vault-bot and codex-packer declare no routing keywords at all, so without it they can never bid); lending an unmatched phrase's words (worth 4 owners, the rephrasing class); the phrase weight of 2 (neutral on the corpus at 1, but at 1 an exact 'profit and loss' is worth less than the same two words declared loosely, and 2 is the Tier-3 constant). REJECTED with numbers: weighting a keyword by how SPECIFIC it is - 1/df costs 3 corpus owners and 1 held-out (102/105, 22/26) and 1/sqrt(df) costs the same, because a single bot's whole vocabulary can be common words ('root cause' is declared by three owners and is still the RCA specialist's subject), and it is not computable where the score runs anyway: computeBidConfidence executes inside a bot node that knows ONLY its own persona. Also rejected: min(1, ev/1) (101/105, auction 67 - everything saturates at 1.0 and the ties fall through), and half-weight K=1.0 (104/105, auction 98). K=0.6 is the midpoint of the interval the design intent pins: one declared word must clear 0.5 (K <= 0.8) and one borrowed word must not (K > 0.4); 0.4, 0.6 and 0.8 all measure 105/105, so the midpoint is the safe one. The 0.5 threshold is UNCHANGED - 0.45 measured identical (105/105, auction 102) and 0.6 cost a case and 4 auction decisions, so the formula was wrong, not the threshold.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | A declared phrase made only of function words scores no phrase evidence: 'to-be' normalizes to the bare auxiliary 'to be' and was winning the auction outright (0.692) over a true owner's real declared word (0.5625), so its declarer claimed any sentence containing those two words.
 */

import { createChildLogger } from '@/shared/logger';
import type { MeshTransport, MeshEnvelope } from './mesh-communication-service';
import { MESH_CHANNELS } from './mesh-communication-service';
import { normalizeRoutingSeparators, normalizeRoutingToken, routingStemSet, tokenizeRoutingText } from './routing-text';

const logger = createChildLogger({ module: 'mesh-bid-responder' });

/**
 * @description What a swarm participant needs to answer a BID_REQUEST: its identity,
 * its declared capabilities, and (optionally) its persona file for routing keywords.
 */
export interface MeshBidResponderOptions {
  meshTransport: MeshTransport;
  agentId: string;
  agentName: string;
  capabilities: string[];
  /** Persona YAML path (BOT_PERSONA_FILE) — routing_keywords are read from it once at
   *  construction. Absent/unreadable persona degrades to capability-only scoring. */
  personaPath?: string;
}

/** Load routing keywords from the persona YAML (best-effort, once). */
function loadRoutingKeywords(personaPath?: string): string[] {
  if (!personaPath) return [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    if (!fs.existsSync(personaPath)) return [];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yaml = require('js-yaml');
    const parsed = yaml.load(fs.readFileSync(personaPath, 'utf-8')) as Record<string, unknown> | null;
    const raw = parsed?.routing_keywords ?? parsed?.routingKeywords;
    if (!Array.isArray(raw)) return [];
    return raw.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).map((k) => k.trim());
  } catch (err) {
    logger.warn({ err, personaPath }, 'Persona routing_keywords unreadable — capability-only bidding');
    return [];
  }
}

/**
 * @description Evidence one exact PHRASE hit is worth. A declared multi-word keyword appearing
 * verbatim is the strongest ownership signal a persona can give, so it outweighs a loose word —
 * the same ratio Tier 3 uses (agent-router's PHRASE_MATCH_WEIGHT).
 */
const PHRASE_EVIDENCE = 2;

/** Evidence one declared single-word keyword is worth when the ask contains that word. */
const KEYWORD_EVIDENCE = 1;

/**
 * @description Evidence a constituent word of an UNMATCHED declared phrase is worth. A phrase that
 * does not appear verbatim must still lend its words, or a phrase-only persona is unreachable on
 * any rephrasing; it is worth less than a whole declaration so a rephrasing never out-ranks the
 * exact words the persona actually declared.
 */
const PHRASE_WORD_EVIDENCE = 0.5;

/**
 * @description Evidence a word of a declared CAPABILITY is worth. Capabilities are the only
 * declaration EIGHT call-out-eligible bots have — rca-specialist, codex-packer,
 * trading-research-analyst, weather-analyst, sat-operator and vault-bot declare no routing
 * keywords at all, as do the general-bot fallback and the a2a sample — so without this they can
 * never bid. Measured on the benchmark corpus, removing it costs four owners their own ask
 * (rca-specialist twice, codex-packer, vault-bot): 105/105 -> 101/105.
 */
const CAPABILITY_WORD_EVIDENCE = 0.5;

/**
 * @description Half-weight constant of the saturating curve ev/(ev+K) that turns evidence into a
 * 0..1 domain score. Chosen so ONE declared single word clears the 0.5 auction threshold
 * (1/(1+0.6) * 0.9 = 0.5625) while a lone borrowed word — a phrase fragment or a capability word,
 * worth 0.5 — does NOT (0.5/1.1 * 0.9 = 0.41). Unlike the old min(1, hits/3) this never flattens:
 * more evidence always ranks strictly higher, so two owners cannot saturate together and leave the
 * 0.05 name tie-breaker to pick between them.
 */
const EVIDENCE_HALF_WEIGHT = 0.6;

/**
 * @description Splits a bot's declared routing keywords into verbatim-testable phrases and single
 * words, both separator-normalized so a hyphenated declaration is testable against typed words.
 * @param routingKeywords - The persona's declared routing_keywords.
 * @returns De-duplicated normalized phrases and single words.
 */
function splitDeclaredKeywords(routingKeywords: string[]): { phrases: string[]; singles: string[] } {
  const phrases = new Set<string>();
  const singles = new Set<string>();
  for (const keyword of routingKeywords) {
    const normalized = normalizeRoutingSeparators(keyword);
    if (normalized.length === 0) continue;
    (/\s/.test(normalized) ? phrases : singles).add(normalized);
  }
  return { phrases: [...phrases], singles: [...singles] };
}

/**
 * @description Tests a declared phrase against the ticket text on word boundaries, so 'buy' cannot
 * fire on 'buyer' and 'vm' cannot fire on 'vmware'.
 * @param text - Separator-normalized lowercased ticket text.
 * @param phrase - Separator-normalized declared phrase.
 * @returns True when the phrase appears as whole words.
 */
function containsPhrase(text: string, phrase: string): boolean {
  const escaped = phrase.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9])' + escaped + '($|[^a-z0-9])').test(text);
}

/**
 * @description How much of the ask this bot's OWN declarations actually account for. Every word of
 * the ask is credited at most ONCE, strongest declaration first: an exact phrase, then a declared
 * single word, then a word borrowed from an unmatched phrase, then a word of a declared capability.
 * Crediting per ask-word rather than per declaration is what keeps bids comparable — a persona with
 * twenty keywords and one with four score the same on a sentence that contains one of each.
 * @param input - The BID_REQUEST title and description.
 * @param self - This bot's declared capabilities and routing keywords.
 * @returns Total evidence, in the units the weights above are expressed in.
 */
function collectDomainEvidence(
  input: { title: string; description: string },
  self: { capabilities: string[]; routingKeywords: string[] },
): number {
  const raw = `${input.title}\n${input.description}`;
  const text = normalizeRoutingSeparators(raw);
  const askStems = routingStemSet(raw);
  const routableStems = new Set(tokenizeRoutingText(raw));
  const credited = new Set<string>();
  const { phrases, singles } = splitDeclaredKeywords(self.routingKeywords);

  let evidence = 0;
  const unmatchedPhrases: string[] = [];
  for (const phrase of phrases) {
    // A phrase with no routable word in it is not evidence of a domain: 'to-be' normalizes to the
    // bare auxiliary 'to be', which appears in ordinary English ("my flight is going to be late").
    // Scored as a full phrase it reached 0.692 and out-bid a true owner holding one real declared
    // word at 0.5625, so its declarer claimed any sentence containing those two words.
    if (tokenizeRoutingText(phrase).length === 0) continue;
    if (!containsPhrase(text, phrase)) {
      unmatchedPhrases.push(phrase);
      continue;
    }
    evidence += PHRASE_EVIDENCE;
    for (const word of phrase.split(' ')) credited.add(normalizeRoutingToken(word));
  }
  for (const single of singles) {
    const stem = normalizeRoutingToken(single);
    if (credited.has(stem) || !askStems.has(stem)) continue;
    credited.add(stem);
    evidence += KEYWORD_EVIDENCE;
  }
  const borrow = (source: string, weight: number): void => {
    for (const word of normalizeRoutingSeparators(source).split(' ')) {
      const stem = normalizeRoutingToken(word);
      if (credited.has(stem) || !routableStems.has(stem)) continue;
      credited.add(stem);
      evidence += weight;
    }
  };
  for (const phrase of unmatchedPhrases) borrow(phrase, PHRASE_WORD_EVIDENCE);
  for (const capability of self.capabilities) borrow(capability, CAPABILITY_WORD_EVIDENCE);
  return evidence;
}

/**
 * @description Computes this bot's self-scored confidence for one BID_REQUEST (exported for unit
 * coverage). The score is evidence-based with NO free baseline:
 *  - domain evidence: how much of the ask this bot's OWN declared keywords and capabilities account
 *    for (see collectDomainEvidence), turned into 0..1 by the saturating ev/(ev+K) curve — one
 *    specific declared word is enough to claim, a single borrowed word is not;
 *  - capability score: overlap with the request's required capabilities, when the caller supplied
 *    them (the build pipeline does; the ADR-083 task call-out sends none);
 *  - name-token match adds only a 0.05 tie-breaker (a ticket merely CONTAINING a bot's name token
 *    must never out-bid the true owner — the misrouting class ADR-083 killed).
 * A bot with zero domain evidence scores 0 and cannot clear the 0.5 auction threshold.
 * @param input - The broadcast ticket title, description and required capabilities.
 * @param self - This bot's own name, capabilities and persona routing keywords.
 * @returns Confidence in 0..1 for this bot's BID_RESPONSE.
 */
export function computeBidConfidence(
  input: { title: string; description: string; requiredCapabilities: string[] },
  self: { agentName: string; capabilities: string[]; routingKeywords: string[] },
): number {
  const evidence = collectDomainEvidence(input, self);
  const kwScore = evidence > 0 ? evidence / (evidence + EVIDENCE_HALF_WEIGHT) : 0;

  const required = input.requiredCapabilities;
  const capMatched = required.filter((c) => self.capabilities.includes(c)).length;
  const capScore = required.length > 0 ? capMatched / required.length : 0;

  const domainScore = Math.max(kwScore, capScore);

  const text = `${input.title}\n${input.description}`.toLowerCase();
  const nameTokens = self.agentName.toLowerCase().split(/[-_\s]+/);
  const nameHit = nameTokens.some((t) => t.length > 2 && text.includes(t));
  const nameBoost = nameHit ? 0.05 : 0;

  return Math.min(1, domainScore * 0.9 + nameBoost);
}

/**
 * @description Builds the directHandler a SwarmAgentWorker wires so this participant
 * ANSWERS call-outs: on a BID_REQUEST envelope, self-score and publish a BID_RESPONSE
 * back to the requester's direct channel (correlationId preserved for request/reply).
 * Sub-0.05 confidence stays silent — no point flooding the window with zero-claims.
 * @param options - Identity + declarations of this participant.
 * @returns An async (envelope, entryId) handler; non-bid envelopes are ignored.
 */
export function createMeshBidResponder(
  options: MeshBidResponderOptions,
): (envelope: MeshEnvelope, entryId: string) => Promise<void> {
  const routingKeywords = loadRoutingKeywords(options.personaPath);
  logger.info(
    { agentId: options.agentId, agentName: options.agentName, keywordCount: routingKeywords.length, capabilityCount: options.capabilities.length },
    'Mesh bid responder armed',
  );

  return async (envelope: MeshEnvelope, _entryId: string): Promise<void> => {
    const payload = envelope.payload as Record<string, unknown> | undefined;
    if (payload?.signalType !== 'BID_REQUEST') return;

    const confidence = computeBidConfidence(
      {
        title: String(payload.ticketTitle || ''),
        description: String(payload.ticketDescription || ''),
        requiredCapabilities: Array.isArray(payload.capabilities) ? (payload.capabilities as string[]) : [],
      },
      { agentName: options.agentName, capabilities: options.capabilities, routingKeywords },
    );
    if (confidence < 0.05) return;

    try {
      await options.meshTransport.publish({
        correlationId: envelope.correlationId,
        fromAgentId: options.agentId,
        toAgentId: envelope.fromAgentId,
        channel: MESH_CHANNELS.agentDirect(envelope.fromAgentId),
        payload: {
          signalType: 'BID_RESPONSE',
          agentId: options.agentId,
          confidence,
          capabilities: options.capabilities,
          signalId: payload.signalId,
        },
        messageType: 'reply',
      });
      logger.info(
        { signalId: payload.signalId, confidence: Number(confidence.toFixed(2)), agentId: options.agentId },
        'Responded to BID_REQUEST',
      );
    } catch (err) {
      logger.warn({ err, signalId: payload.signalId }, 'Failed to respond to BID_REQUEST');
    }
  };
}
