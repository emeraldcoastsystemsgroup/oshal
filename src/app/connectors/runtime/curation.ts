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
 * Everything is derived from signals the spec already carries — provider slug, display name, base-URL
 * host, and the resource/tool names — matched against an ORDERED rule table. Order is the whole
 * design: `snyk` matches both /snyk/ (Security) and the generic developer-tooling words, so the
 * specific rule sits above the generic one. Adding a connector usually needs no rule at all; adding
 * an unrecognisable one needs one line, and the guard tells you so.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ordered signal-rule category derivation with NO catch-all (undefined instead of 'General'/'other'), plus a description derived from the spec's own resources + auth lane, shared by ConnectorMarketplaceService and scripts/connectors/curate-catalog.ts.
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
type CategoryRule = [category: string, pattern: RegExp, scope?: 'provider'];

const CATEGORY_RULES: CategoryRule[] = [
  // ── Specific providers whose identity no keyword family would reach ───────────────────────────
  ['AI', /\b(anthropic|openai|cohere|huggingface|replicate|stability|stabilityai|elevenlabs|deepgram|assemblyai)\b/, 'provider'],
  ['Data infrastructure', /\b(pinecone|qdrant|cockroach|mongodbatlas|planetscale|supabase|turso|xata|upstash|neon|directus)\b/, 'provider'],
  ['Security', /\b(snyk|tenable|virustotal|sentinel|defender cloud|elastic security)\b/, 'provider'],
  ['Health', /\b(fitbit|oura|whoop|strava)\b/, 'provider'],
  ['Scheduling', /\b(calendly|google calendar)\b/, 'provider'],
  ['Sports', /\b(balldontlie|nhl|thesportsdb|pandascore)\b/, 'provider'],
  ['Games', /\b(boardgamegeek|giantbomb|mobygames|rawg|steam|opendota)\b/, 'provider'],
  ['Weather', /\b(openweathermap|weatherapi)\b/, 'provider'],
  ['Travel', /\b(amadeus)\b/, 'provider'],
  ['News', /\b(guardian|newsapi)\b/, 'provider'],
  ['Social', /\b(pinterest|reddit|twitter|tumblr|mastodon|deviantart)\b/, 'provider'],
  ['HR & recruiting', /\b(bamboohr|breezy|finch|greenhouse|gusto|jazzhr|resumator|lever|personio|recruitee|smartrecruiters|teamtailor|workable)\b/, 'provider'],
  ['E-signature & documents', /\b(docusign|dropboxsign|hellosign|signnow|docuseal|pandadoc|pdfmonkey)\b/, 'provider'],
  ['Forms', /\b(formstack|getform|jotform|typeform)\b/, 'provider'],
  ['Location & maps', /\b(geoapify|here|ipgeolocation|ipinfo|locationiq|mapbox|mapquest|opencage|positionstack|tomtom|transitland|opensky|aviationstack|abstractapi)\b/, 'provider'],
  ['Knowledge', /\b(notion|coda|raindrop|openlibrary|wikidata|wikipedia|datamuse|dictionary|dictionaryapi|wordnik|numbersapi|restcountries|nasa|discourse)\b/, 'provider'],
  ['Analytics', /\b(amplitude|mixpanel|posthog)\b/, 'provider'],
  ['Design', /\b(figma|miro)\b/, 'provider'],
  ['Support', /\b(zendesk|intercom|freshdesk|helpscout|helpcrunch|crisp|dixa|gorgias|kustomer|liveagent|reamaze|tidio|usersnap|frill|nolt|featurebase)\b/, 'provider'],
  ['CRM', /\b(hubspot|hubapi|pipedrive|salesforce|zoho crm)\b/, 'provider'],
  ['Marketing', /\b(activecampaign|klaviyo|customerio|customer\.io|convertkit|mailchimp|brevo|buttondown)\b/, 'provider'],
  ['Project management', /\b(asana|basecamp|clickup|jira|productboard|shortcut|teamwork|wrike|trello)\b/, 'provider'],
  ['Productivity', /\b(airtable|baserow|nocodb|smartsheet|todoist|clockify|toggl|harvest|expensify)\b/, 'provider'],
  ['Payments', /\b(stripe|square|braintree|chargebee|dwolla|gocardless|lemonsqueezy|paddle|razorpay|recurly|bill\.com|billcom)\b/, 'provider'],
  ['Finance', /\b(brex|coinbase|coincap|coingecko|coinmarketcap|coinpaprika|cryptocompare|blockchain|blockchaincom|blockcypher|etherscan|moralis|kraken|currencyapi|exchangerate|exchangeratehost|finnhub|freshbooks|lunchmoney|mercury|monzo|pocketsmith|quickbooks|intuit|ramp|splitwise|wise|transferwise|xero|ynab|zohobooks)\b/, 'provider'],
  ['Commerce', /\b(bigcommerce|ebay|etsy|faire|shopify|squarespace|woocommerce|prestashop|wix|webflow|printful|printify|shippo|goshippo|gumroad)\b/, 'provider'],
  ['Media', /\b(discogs|flickr|giphy|pexels|pixabay|unsplash|lastfm|audioscrobbler|soundcloud|spotify|tmdb|themoviedb|twitch|youtube|vimeo|wistia|vidyard|mux|dacast|apivideo|bunny|bunnynet|gumlet)\b/, 'provider'],
  ['Files', /\b(dropbox|google drive)\b/, 'provider'],
  ['Email', /\b(gmail|outlook|graph\.microsoft|mailgun|postmark|sendgrid|bouncer|debounce|emailable|kickbox|mailboxlayer|neverbounce|verifalia|zerobounce|hunter|abstractemail|emailvalidation)\b/, 'provider'],
  ['Communications', /\b(slack|discord|telegram|mattermost|rocketchat|zulip|twilio|telnyx|vonage|nexmo|sinch|plivo|messagebird|ringcentral|zoom|daily|agora|courier|ntfy|front|frontapp)\b/, 'provider'],
  ['Operations', /\b(betterstack|checkly|cronitor|datadog|dynatrace|grafana|healthchecks|honeycomb|instatus|loggly|logzio|newrelic|opsgenie|pagerduty|pingdom|site24x7|statuscake|statuspage|sumologic|servicenow|sentry|rollbar|bugsnag|cloudflare|fastly|digitalocean|hetzner|linode|scaleway|vultr|heroku|render)\b/, 'provider'],
  ['Developer tools', /\b(github|gitlab|bitbucket|gitea|circleci|dockerhub|jfrog|sonarcloud|vercel|netlify|wakatime|ably)\b/, 'provider'],
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

/**
 * The canonical shelf labels. A category outside this set is a taxonomy split, not a new shelf:
 * 'Communication' and 'Communications' render as two shelves holding the same kind of connector.
 * Derived values come from the rule table (always canonical); DECLARED values are mapped through
 * {@link CATEGORY_ALIASES} so an existing hand-written label lands on the same shelf.
 */
export const CANONICAL_CATEGORIES: readonly string[] = [
  'AI', 'Analytics', 'Commerce', 'Communications', 'CRM', 'Data infrastructure', 'Design',
  'Developer tools', 'E-signature & documents', 'Email', 'Files', 'Finance', 'Forms', 'Games',
  'Health', 'HR & recruiting', 'Knowledge', 'Location & maps', 'Marketing', 'Media', 'News',
  'Operations', 'Payments', 'Productivity', 'Project management', 'Scheduling', 'Security',
  'Social', 'Sports', 'Support', 'Travel', 'Weather',
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

/** The signal text a category rule matches: everything about the spec that names what it is. */
function signalText(spec: ConnectorSpec): string {
  let host = '';
  try { host = new URL(spec.baseUrl).host; } catch { host = ''; }
  const resources = (spec.resources ?? []).flatMap((r) => [r.name, r.tool ?? '', r.path ?? '']);
  const actions = (spec.actions ?? []).map((a) => a.name);
  return [spec.provider, spec.displayName ?? '', host, ...resources, ...actions]
    .join(' ').toLowerCase().replace(/[-_/{}]+/g, ' ');
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
  const declared = spec.metadata?.category;
  if (declared && declared.trim()) {
    const canonical = canonicalizeCategory(declared);
    if (canonical) return canonical;
  }
  const text = signalText(spec);
  const providerText = spec.provider.toLowerCase().replace(/[-_]+/g, ' ');
  for (const [category, rule, scope] of CATEGORY_RULES) {
    if (rule.test(scope === 'provider' ? providerText : text)) return category;
  }
  return undefined;
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
