/**
 * Connector curation — category + plain-language description derived from the spec itself.
 *
 * The catalog was imported, not curated: category and description coverage sat at 17% while the
 * marketplace filled the gap with an `inferCategory` that returned 'General' for anything it did not
 * recognise. A silent catch-all category is worse than a blank one — it makes an uncurated shelf look
 * curated. So this module is the ONE derivation both the runtime catalog and the backfill CLI use,
 * and it has no catch-all: {@link deriveConnectorCategory} returns undefined when nothing in the spec
 * identifies the provider, and the callers are expected to fail loudly on that.
 *
 * Everything is derived from evidence the spec already carries. The precedence is explicit:
 * human-declared category, exact provider identity, a reviewed mapping of a trusted source catalog's
 * category vocabulary, then resource/tool signals. Unknown or newly ambiguous source-category
 * combinations stay unresolved so a catalog expansion cannot silently become a plausible catch-all.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ordered signal-rule category derivation with NO catch-all (undefined instead of 'General'/'other'), plus a description derived from the spec's own resources + auth lane, shared by ConnectorMarketplaceService and scripts/connectors/curate-catalog.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Preserve APIs.guru source-taxonomy evidence, map only reviewed single/combined source categories, expose category provenance, and keep unknown or ambiguous combinations unresolved.
 * -----------------------------------------------------------------------------
 *
 * @module connectors/runtime/curation
 */

import type { ConnectorSpec } from './spec';

/**
 * @description The setup lane a connector puts a user in, derived from its declared auth type. Same
 * three lanes the curation audit reports, named the same way.
 */
export type ConnectorSetupLane = 'no-auth' | 'bring-your-own-key' | 'needs-operator-oauth-app';

/**
 * Ordered category rules over the spec's own signal text. FIRST match wins, so specific provider
 * anchors precede generic keyword families. A category name here is a marketplace shelf label —
 * keep the set small enough to browse and reuse an existing label before inventing one.
 */
type CategoryRule = [category: string, pattern: RegExp];

/** The evidence lane that produced an effective marketplace category. */
export type ConnectorCategorySource = 'declared' | 'provider-rule' | 'source-taxonomy' | 'signal-rule';

/** A category plus the auditable evidence lane used to derive it. */
export interface ConnectorCategoryDecision {
  category: string;
  source: ConnectorCategorySource;
  evidence: string;
}

/**
 * APIs.guru entries with no source category, reviewed from their title, description, tags, host,
 * and operations. Exact provider keys prevent those signals from becoming broad keyword guesses.
 */
const REVIEWED_SOURCELESS_PROVIDER_CATEGORIES: Readonly<Record<string, string>> = {
  'arespass-net': 'Security',
  'bigoven-com': 'Commerce',
  'byautomata-io': 'Analytics',
  'contentgroove-com': 'Media',
  'dodo-ac': 'Games',
  'doqs-dev': 'E-signature & documents',
  'go-upc-com': 'Commerce',
  'google-com': 'Travel',
  'google-home': 'Operations',
  'googleapis-com-cloudprivatecatalog': 'Cloud infrastructure',
  'googleapis-com-cloudprivatecatalogproducer': 'Cloud infrastructure',
  'googleapis-com-mirror': 'Communications',
  'googleapis-com-servicebroker': 'Cloud infrastructure',
  'greip-io': 'Location & maps',
  'groundhog-day-com': 'Weather',
  'increase-com': 'Finance',
  'ipqualityscore-com': 'Security',
  'javatpoint-com': 'Communications',
  'json2video-com': 'Media',
  'kumpeapps-com': 'Security',
  'linqr-app': 'Media',
  'ljaero-com-dflight': 'Location & maps',
  'meilisearch-com': 'Knowledge',
};

const PROVIDER_CATEGORY_RULES: CategoryRule[] = [
  // ── Specific providers whose identity no keyword family would reach ───────────────────────────
  ['AI', /\b(anthropic|openai|cohere|huggingface|replicate|stability|stabilityai|elevenlabs|deepgram|assemblyai)\b/],
  ['Data infrastructure', /\b(pinecone|qdrant|cockroach|mongodbatlas|planetscale|supabase|turso|xata|upstash|neon|directus)\b/],
  ['Security', /\b(snyk|tenable|virustotal|sentinel|defender cloud|elastic security)\b/],
  ['Health', /\b(fitbit|oura|whoop|strava)\b/],
  ['Scheduling', /\b(calendly|google calendar)\b/],
  ['Sports', /\b(balldontlie|nhl|thesportsdb|pandascore)\b/],
  ['Games', /\b(boardgamegeek|giantbomb|mobygames|rawg|steam|opendota)\b/],
  ['Weather', /\b(openweathermap|weatherapi)\b/],
  ['Travel', /\b(amadeus)\b/],
  ['News', /\b(guardian|newsapi)\b/],
  ['Social', /\b(pinterest|reddit|twitter|tumblr|mastodon|deviantart)\b/],
  ['HR & recruiting', /\b(bamboohr|breezy|finch|greenhouse|gusto|jazzhr|resumator|lever|personio|recruitee|smartrecruiters|teamtailor|workable)\b/],
  ['E-signature & documents', /\b(docusign|dropboxsign|hellosign|signnow|docuseal|pandadoc|pdfmonkey)\b/],
  ['Forms', /\b(formstack|getform|jotform|typeform)\b/],
  ['Location & maps', /\b(geoapify|here|ipgeolocation|ipinfo|locationiq|mapbox|mapquest|opencage|positionstack|tomtom|transitland|opensky|aviationstack|abstractapi)\b/],
  ['Knowledge', /\b(notion|coda|raindrop|openlibrary|wikidata|wikipedia|datamuse|dictionary|dictionaryapi|wordnik|numbersapi|restcountries|nasa|discourse)\b/],
  ['Analytics', /\b(amplitude|mixpanel|posthog)\b/],
  ['Design', /\b(figma|miro)\b/],
  ['Support', /\b(zendesk|intercom|freshdesk|helpscout|helpcrunch|crisp|dixa|gorgias|kustomer|liveagent|reamaze|tidio|usersnap|frill|nolt|featurebase)\b/],
  ['CRM', /\b(hubspot|hubapi|pipedrive|salesforce|zoho crm)\b/],
  ['Marketing', /\b(activecampaign|klaviyo|customerio|customer\.io|convertkit|mailchimp|brevo|buttondown)\b/],
  ['Project management', /\b(asana|basecamp|clickup|jira|productboard|shortcut|teamwork|wrike|trello)\b/],
  ['Productivity', /\b(airtable|baserow|nocodb|smartsheet|todoist|clockify|toggl|harvest|expensify)\b/],
  ['Payments', /\b(stripe|square|braintree|chargebee|dwolla|gocardless|lemonsqueezy|paddle|razorpay|recurly|bill\.com|billcom)\b/],
  ['Finance', /\b(brex|coinbase|coincap|coingecko|coinmarketcap|coinpaprika|cryptocompare|blockchain|blockchaincom|blockcypher|etherscan|moralis|kraken|currencyapi|exchangerate|exchangeratehost|finnhub|freshbooks|lunchmoney|mercury|monzo|pocketsmith|quickbooks|intuit|ramp|splitwise|wise|transferwise|xero|ynab|zohobooks)\b/],
  ['Commerce', /\b(bigcommerce|ebay|etsy|faire|shopify|squarespace|woocommerce|prestashop|wix|webflow|printful|printify|shippo|goshippo|gumroad)\b/],
  ['Media', /\b(discogs|flickr|giphy|pexels|pixabay|unsplash|lastfm|audioscrobbler|soundcloud|spotify|tmdb|themoviedb|twitch|youtube|vimeo|wistia|vidyard|mux|dacast|apivideo|bunny|bunnynet|gumlet)\b/],
  ['Files', /\b(dropbox|google drive)\b/],
  ['Email', /\b(gmail|outlook|graph\.microsoft|mailgun|postmark|sendgrid|bouncer|debounce|emailable|kickbox|mailboxlayer|neverbounce|verifalia|zerobounce|hunter|abstractemail|emailvalidation)\b/],
  ['Communications', /\b(slack|discord|telegram|mattermost|rocketchat|zulip|twilio|telnyx|vonage|nexmo|sinch|plivo|messagebird|ringcentral|zoom|daily|agora|courier|ntfy|front|frontapp)\b/],
  ['Operations', /\b(betterstack|checkly|cronitor|datadog|dynatrace|grafana|healthchecks|honeycomb|instatus|loggly|logzio|newrelic|opsgenie|pagerduty|pingdom|site24x7|statuscake|statuspage|sumologic|servicenow|sentry|rollbar|bugsnag|cloudflare|fastly|digitalocean|hetzner|linode|scaleway|vultr|heroku|render)\b/],
  ['Developer tools', /\b(github|gitlab|bitbucket|gitea|circleci|dockerhub|jfrog|sonarcloud|vercel|netlify|wakatime|ably)\b/],
];

const SIGNAL_CATEGORY_RULES: CategoryRule[] = [
  // -- Generic keyword families: reached only by a connector no anchor above named. No TRAILING
  //    word boundary, so 'incidents'/'messages' match; the leading one still blocks mid-word hits.
  ['Email', /\b(mail|inbox|smtp|newsletter|subscriber)/],
  ['Payments', /\b(payment|checkout|invoice|charge|payout|subscription)/],
  ['Finance', /\b(bank|ledger|accounting|transaction|balance|portfolio|crypto|currency|exchange rate)/],
  ['Communications', /\b(sms|message|chat|call|voice|channel|conference|meeting)/],
  ['Developer tools', /\b(repo|repositor|commit|pull request|pipeline|build|artifact|registry|deploy)/],
  ['Operations', /\b(incident|alert|monitor|uptime|log|metric|trace|on-call|status page)/],
  ['Media', /\b(video|photo|image|audio|track|playlist|movie|episode)/],
  ['Security', /\b(vulnerabilit|threat|malware|scan|cve|compliance)/],
  ['Project management', /\b(task|issue|ticket|sprint|board|milestone|project)/],
  ['Knowledge', /\b(document|page|wiki|note|bookmark|article)/],
  ['Analytics', /\b(analytic|event stream|funnel|cohort|dashboard)/],
  ['Location & maps', /\b(geocod|geolocat|coordinate|route|address lookup)/],
];

/** APIs.guru's documented category vocabulary mapped to OSHAL shelves. Unknown values stay open. */
const APIS_GURU_CATEGORY_MAP: Readonly<Record<string, string>> = {
  analytics: 'Analytics',
  backend: 'Data infrastructure',
  cloud: 'Cloud infrastructure',
  collaboration: 'Communications',
  customer_relation: 'CRM',
  developer_tools: 'Developer tools',
  ecommerce: 'Commerce',
  education: 'Education',
  email: 'Email',
  entertainment: 'Media',
  financial: 'Finance',
  hosting: 'Cloud infrastructure',
  iot: 'Operations',
  location: 'Location & maps',
  machine_learning: 'AI',
  marketing: 'Marketing',
  media: 'Media',
  messaging: 'Communications',
  open_data: 'Open data',
  payment: 'Payments',
  search: 'Knowledge',
  security: 'Security',
  social: 'Social',
  storage: 'Files',
  telecom: 'Communications',
  text: 'Knowledge',
  tools: 'Developer tools',
  transport: 'Travel',
};

/** Reviewed resolutions only for source-taxonomy combinations that span different OSHAL shelves. */
const APIS_GURU_COMBINATION_MAP: Readonly<Record<string, string>> = {
  'analytics+location+media': 'Analytics',
  'analytics+media': 'Analytics',
  'analytics+tools': 'Analytics',
  'collaboration+media': 'Communications',
  'collaboration+open_data': 'Communications',
  'developer_tools+open_data': 'Developer tools',
  'ecommerce+telecom': 'Commerce',
  'location+telecom': 'Location & maps',
  'machine_learning+text': 'AI',
  'media+open_data': 'Media',
  'media+social': 'Social',
  'open_data+transport': 'Travel',
};

/**
 * The canonical shelf labels. A category outside this set is a taxonomy split, not a new shelf:
 * 'Communication' and 'Communications' render as two shelves holding the same kind of connector.
 * Derived values come from the rule table (always canonical); DECLARED values are mapped through
 * {@link CATEGORY_ALIASES} so an existing hand-written label lands on the same shelf.
 */
export const CANONICAL_CATEGORIES: readonly string[] = [
  'AI', 'Analytics', 'Cloud infrastructure', 'Commerce', 'Communications', 'CRM',
  'Data infrastructure', 'Design', 'Developer tools', 'E-signature & documents', 'Education',
  'Email', 'Files', 'Finance', 'Forms', 'Games', 'Health', 'HR & recruiting', 'Knowledge',
  'Location & maps', 'Marketing', 'Media', 'News', 'Open data', 'Operations', 'Payments',
  'Productivity', 'Project management', 'Scheduling', 'Security', 'Social', 'Sports', 'Support',
  'Travel', 'Weather',
];

/** Hand-written labels that mean an existing shelf. Keyed lowercase. */
const CATEGORY_ALIASES: Record<string, string> = {
  communication: 'Communications',
  'developer tools': 'Developer tools',
  general: '', // the retired catch-all: treat as NOT categorised so it fails loudly instead of shelving
  other: '',
};

/** Map a declared category onto the canonical shelf set; '' when it is a retired catch-all. */
function canonicalizeCategory(declared: string): string {
  const trimmed = declared.trim();
  const alias = CATEGORY_ALIASES[trimmed.toLowerCase()];
  if (alias !== undefined) return alias;
  const exact = CANONICAL_CATEGORIES.find((c) => c.toLowerCase() === trimmed.toLowerCase());
  return exact ?? trimmed;
}

/** Auth type → the setup lane it puts a user in. */
export function connectorSetupLane(spec: ConnectorSpec): ConnectorSetupLane {
  const type = String(spec.auth?.type ?? 'none').toLowerCase();
  if (!type || type === 'none') return 'no-auth';
  if (type.includes('oauth')) return 'needs-operator-oauth-app';
  return 'bring-your-own-key';
}

/** The lower-confidence signal text: names, OpenAPI tags/description, host, and operations. */
function signalText(spec: ConnectorSpec): string {
  let host = '';
  try { host = new URL(spec.baseUrl).host; } catch { host = ''; }
  const resources = (spec.resources ?? []).flatMap((r) => [r.name, r.tool ?? '', r.path ?? '']);
  const actions = (spec.actions ?? []).map((a) => a.name);
  const metadata = spec.metadata ?? {};
  return [
    spec.provider,
    spec.displayName ?? '',
    host,
    metadata.description ?? '',
    ...(metadata.tags ?? []),
    ...resources,
    ...actions,
  ]
    .join(' ').toLowerCase().replace(/[-_/{}]+/g, ' ');
}

/** Normalize source-taxonomy values without turning arbitrary prose into a category token. */
function normalizeSourceCategory(value: string): string | undefined {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return /^[a-z0-9_]+$/.test(normalized) ? normalized : undefined;
}

/** Resolve only a trusted, fully-known APIs.guru category set; novel combinations remain queued. */
function sourceTaxonomyDecision(spec: ConnectorSpec): ConnectorCategoryDecision | undefined {
  if (spec.metadata?.sourceCatalog?.toLowerCase() !== 'apis-guru') return undefined;
  const categories = Array.from(new Set(
    (spec.metadata.sourceCategories ?? []).map(normalizeSourceCategory).filter((item): item is string => Boolean(item)),
  )).sort();
  if (!categories.length || categories.some((category) => !APIS_GURU_CATEGORY_MAP[category])) return undefined;

  const mapped = Array.from(new Set(categories.map((category) => APIS_GURU_CATEGORY_MAP[category])));
  const key = categories.join('+');
  const category = mapped.length === 1 ? mapped[0] : APIS_GURU_COMBINATION_MAP[key];
  return category ? { category, source: 'source-taxonomy', evidence: `apis-guru:${key}` } : undefined;
}

/** Return the first category rule match with its evidence lane. */
function ruleDecision(
  rules: CategoryRule[],
  text: string,
  source: Extract<ConnectorCategorySource, 'provider-rule' | 'signal-rule'>,
  evidence: string,
): ConnectorCategoryDecision | undefined {
  for (const [category, pattern] of rules) {
    if (pattern.test(text)) return { category, source, evidence };
  }
  return undefined;
}

/**
 * Resolve the effective category and retain the evidence lane used for audits and catalog reports.
 * Unknown source values or cross-shelf combinations are not guessed.
 */
export function deriveConnectorCategoryDecision(spec: ConnectorSpec): ConnectorCategoryDecision | undefined {
  const declared = spec.metadata?.category;
  if (declared?.trim()) {
    const category = canonicalizeCategory(declared);
    if (category) return { category, source: 'declared', evidence: 'metadata.category' };
  }

  const reviewed = REVIEWED_SOURCELESS_PROVIDER_CATEGORIES[spec.provider];
  if (reviewed) {
    return { category: reviewed, source: 'provider-rule', evidence: `provider-review:${spec.provider}` };
  }
  const providerText = spec.provider.toLowerCase().replace(/[-_]+/g, ' ');
  return ruleDecision(PROVIDER_CATEGORY_RULES, providerText, 'provider-rule', `provider:${spec.provider}`)
    ?? sourceTaxonomyDecision(spec)
    ?? ruleDecision(SIGNAL_CATEGORY_RULES, signalText(spec), 'signal-rule', 'spec-signals');
}

/**
 * @description The connector's marketplace category, derived from its own spec. A declared
 * `metadata.category` always wins (human curation is never overwritten). Returns **undefined** when
 * no rule matches — deliberately NOT a catch-all: callers must treat an uncategorisable connector as
 * a failure to fix, not a shelf label to invent.
 * @param spec - the parsed connector spec
 * @returns the category, or undefined when the spec carries no identifying signal
 */
export function deriveConnectorCategory(spec: ConnectorSpec): string | undefined {
  return deriveConnectorCategoryDecision(spec)?.category;
}

/** 'channel-messages' → 'channel messages'; keeps a resource name readable in a sentence. */
function humanize(name: string): string {
  return name.replace(/[-_]+/g, ' ').trim();
}

/** The lane sentence — what the user actually has to do to connect this thing. */
function laneSentence(lane: ConnectorSetupLane): string {
  if (lane === 'no-auth') return 'No credential needed — a public API.';
  if (lane === 'needs-operator-oauth-app') {
    return 'OAuth: the operator registers the provider app once, then each user connects their own account.';
  }
  return 'Bring your own key: each user pastes their own token, held per-user in the encrypted connection store.';
}

/**
 * @description A plain-language description derived from the spec's own resources and auth, so it
 * cannot drift from what the connector actually does. A declared `metadata.description` always wins.
 * @param spec - the parsed connector spec
 * @returns one or two sentences naming the reads, any writes, and the setup lane
 */
export function deriveConnectorDescription(spec: ConnectorSpec): string {
  const declared = spec.metadata?.description;
  if (declared && declared.trim()) return declared.trim();
  const name = spec.displayName?.trim() || spec.provider;
  let host = '';
  try { host = new URL(spec.baseUrl).host; } catch { host = ''; }
  const isWrite = (r: { method?: string; safety?: { action?: string } }) =>
    r.safety?.action === 'write' || r.safety?.action === 'destructive'
    || ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(r.method ?? 'GET').toUpperCase());
  const reads = (spec.resources ?? []).filter((r) => !isWrite(r)).map((r) => humanize(r.name));
  const writes = (spec.resources ?? []).filter((r) => isWrite(r)).map((r) => humanize(r.name));
  const list = (items: string[], cap = 4): string => {
    const head = items.slice(0, cap).join(', ');
    const extra = items.length - cap;
    return extra > 0 ? `${head} and ${extra} more` : head;
  };
  const parts: string[] = [];
  if (reads.length) parts.push(`reads ${list(reads)}`);
  if (writes.length) parts.push(`writes ${list(writes, 3)}`);
  const what = parts.length ? parts.join('; ') : 'exposes no resources yet';
  const via = host ? ` via ${host}` : '';
  return `${name} — ${what}${via}. ${laneSentence(connectorSetupLane(spec))}`;
}
