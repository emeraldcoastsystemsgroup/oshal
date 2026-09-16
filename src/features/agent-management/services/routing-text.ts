/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted verbatim from agent-router.ts so BOTH selection tiers share ONE routing vocabulary. Tier 3 (the router) and Tier 1 (a bot's own BID_RESPONSE self-score in mesh-bid-responder) were normalizing the ticket text differently, so a bot could be reachable by keyword and unreachable by bid on the same sentence. The tokenizer, the stemmer and the stop list are unchanged from the agent-router copy they came from - this file is a move, not a rewrite - plus two additions the bid self-score needs: separator normalization (a declared 'regression-guard' has to be testable against the typed words 'regression guard') and a stem set that keeps SHORT declared terms such as 'vm' and 'qa', which the routable-token filter drops.
 */

/**
 * @description Tokenizes freeform routing text into normalized comparison terms.
 * @param value - Source text from title, labels, descriptions, or capability phrases.
 * @returns Normalized tokens with stop-words removed.
 */
export function tokenizeRoutingText(value: string): string[] {
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
export function normalizeRoutingToken(token: string): string {
  const trimmed = token.replaceAll(/[^a-z0-9]+/g, '');
  if (trimmed.endsWith('ation')) return trimmed.slice(0, -5);
  if (trimmed.endsWith('ing')) return trimmed.slice(0, -3);
  if (trimmed.endsWith('ed')) return trimmed.slice(0, -2);
  if (trimmed.endsWith('es')) return trimmed.slice(0, -2);
  if (trimmed.endsWith('s')) return trimmed.slice(0, -1);
  return trimmed;
}

export const ROUTING_STOP_WORDS: ReadonlySet<string> = new Set([
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

/**
 * @description Normalizes the separators inside freeform text so a declared keyword written with
 * hyphens, underscores or slashes can be tested against the words a person actually typed. A
 * persona declaring 'regression-guard' and a caller typing 'regression guard' mean the same thing;
 * without this the declaration is unmatchable and its owner cannot bid on its own subject.
 * @param value - Source text, either a declared keyword or the ticket text.
 * @returns Lowercased text with every separator collapsed to a single space.
 */
export function normalizeRoutingSeparators(value: string): string {
  return value.toLowerCase().replaceAll(/[-_/.]+/g, ' ').replaceAll(/\s+/g, ' ').trim();
}

/**
 * @description Every stem in a piece of text, INCLUDING the short ones the routable-token filter
 * drops. Declared vocabulary is deliberate, so a two-character declaration ('vm', 'qa') must still
 * be matchable; the length filter exists to keep junk out of FREEFORM text, not to disown a
 * persona's own words.
 * @param value - Source text.
 * @returns The set of normalized stems present in the text.
 */
export function routingStemSet(value: string): ReadonlySet<string> {
  const stems = new Set<string>();
  for (const token of value.toLowerCase().split(/[\s\-_/.,;:()"'?!]+/)) {
    const stem = normalizeRoutingToken(token);
    if (stem.length > 0) stems.add(stem);
  }
  return stems;
}
