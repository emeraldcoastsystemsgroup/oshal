/**
 * Haven connector-signal facts (ADR-079 "Deferred: connector-signal facts").
 *
 * The user model learns from CONVERSATION (extraction) and from the user TELLING it something
 * (teach). Neither notices that the Google token they linked in March expires on Thursday, or that
 * the Slack connection went to `error` last night. Those are facts about the user's own account
 * estate, and Haven should carry them into every turn the same way it carries a preference.
 *
 * This module derives `signal`-facet fact candidates from the caller's OWN `oshal_connections`
 * rows. Three hard rules, all of them load-bearing:
 *
 *  1. **Caller-scoped by construction.** {@link readConnectorSignalRows} is the ONLY read here and
 *     it is a parameterized `WHERE user_sub = $1`. There is no all-users variant, no optional
 *     filter, and no code path that returns a row for a sub other than the one passed in. The
 *     per-user connector-token isolation rules (ADR-042) apply to derived facts too — a signal fact
 *     is a statement about one person's accounts and must never cross subs.
 *  2. **No secret material, ever.** Tokens are never selected. Raw scope strings are never stored —
 *     they are mapped to a bounded set of human capability labels, so a provider that starts
 *     handing out opaque scope blobs cannot smuggle anything into a prompt.
 *  3. **Account identifiers stay out.** The fact says "google — send email, read calendar, expires
 *     in 4 days", not which mailbox. The ADR asks for token expiry and capability matches; the
 *     address adds nothing and would put an identifier in every turn's prompt preamble.
 *
 * Facts land through the ordinary merge path (`UserModelService.mergeFact`), so they decay,
 * supersede, and render in the hot core exactly like any other fact.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation: caller-scoped connector row read, scope→capability labelling, per-provider signal-fact derivation (health + capability + expiry countdown), stale-key computation for retiring disconnected providers, and the attention suggestions an expiring/broken connection raises.
 *
 * @module features/user-model/services/connector-signal-facts
 */

import type { FactCandidate } from './user-model-logic';

/** The minimal Postgres surface this module needs (structurally satisfied by `pg.Pool`). */
export interface ConnectorPgLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** One connected account, reduced to the fields a signal fact may be derived from. */
export interface ConnectorSignalRow {
  provider: string;
  /** `connected` | `error` | `revoked` | `expired` | … (whatever the connector wrote). */
  status: string;
  /** Raw OAuth scope string; mapped to labels, never stored verbatim. */
  scopes: string | null;
  /** Access/refresh expiry instant, when the provider supplies one. */
  expiry: string | Date | null;
}

/** Every signal fact this module owns is keyed `connector-<provider>` — the retire sweep keys off it. */
export const CONNECTOR_FACT_KEY_PREFIX = 'connector-';

/** Inside this many days an expiry becomes something Haven should mention. */
export const CONNECTOR_EXPIRY_WARNING_DAYS = 7;

/** Confidence for a derived signal: high (it is a database read), but below an explicit teach. */
const SIGNAL_CONFIDENCE = 0.9;

/** Hard cap on a rendered fact value (the model's own limit is 400; stay well inside it). */
const MAX_FACT_VALUE = 240;

/**
 * Scope-substring → capability label. Deliberately a fixed table: an unrecognised scope
 * contributes NOTHING rather than being echoed into a prompt.
 */
const CAPABILITY_LABELS: ReadonlyArray<{ readonly match: string; readonly label: string }> = [
  { match: 'gmail.send', label: 'send email' },
  { match: 'gmail.readonly', label: 'read email' },
  { match: 'gmail.modify', label: 'manage email' },
  { match: 'calendar', label: 'calendar' },
  { match: 'drive', label: 'files' },
  { match: 'contacts', label: 'contacts' },
  { match: 'photoslibrary', label: 'photos' },
  { match: 'spreadsheets', label: 'spreadsheets' },
  { match: 'youtube', label: 'youtube' },
  { match: 'channels:read', label: 'read channels' },
  { match: 'chat:write', label: 'post messages' },
  { match: 'repo', label: 'repositories' },
  { match: 'tweet.write', label: 'post updates' },
  { match: 'w_member_social', label: 'post updates' },
  { match: 'pages_manage_posts', label: 'manage pages' },
  { match: 'transactions', label: 'transactions' },
  { match: 'accounts', label: 'accounts' },
];

/** A connection in one of these states cannot be used until the owner reconnects it. */
const BROKEN_STATUSES = new Set(['error', 'revoked', 'expired', 'disconnected', 'invalid']);

/**
 * @description Read the caller's own connected accounts, reduced to the signal fields. The
 * `WHERE user_sub = $1` is the isolation boundary — there is intentionally no unscoped variant of
 * this function, and tokens are never selected. Never throws: a missing table or a degraded pool
 * yields an empty list so a Haven sweep can never be broken by the connector schema.
 * @param pool - Postgres pool (ConnectorPgLike).
 * @param userSub - The OIDC subject whose connections to read. Required; an empty value reads nothing.
 * @returns The caller's connector rows (possibly empty).
 */
export async function readConnectorSignalRows(
  pool: ConnectorPgLike,
  userSub: string,
): Promise<ConnectorSignalRow[]> {
  if (!userSub) return [];
  const result = await pool.query(
    `SELECT provider, status, scopes, expiry
       FROM oshal_connections
      WHERE user_sub = $1
      ORDER BY provider ASC`,
    [userSub],
  );
  return result.rows.map((row) => ({
    provider: String(row.provider || '').trim().toLowerCase(),
    status: String(row.status || '').trim().toLowerCase(),
    scopes: row.scopes == null ? null : String(row.scopes),
    expiry: (row.expiry as string | Date | null) ?? null,
  })).filter((row) => row.provider.length > 0 && row.provider.length <= 40);
}

/**
 * @description Map a raw OAuth scope string to bounded, human capability labels. Unrecognised
 * scopes contribute nothing — this is what keeps provider-controlled text out of the prompt.
 * @param scopes - The raw space/comma-separated scope string, or null.
 * @returns De-duplicated capability labels in table order (possibly empty).
 */
export function connectorCapabilityLabels(scopes: string | null | undefined): string[] {
  const haystack = String(scopes || '').toLowerCase();
  if (!haystack) return [];
  const out: string[] = [];
  for (const { match, label } of CAPABILITY_LABELS) {
    if (haystack.includes(match) && !out.includes(label)) out.push(label);
  }
  return out;
}

/** Whole days from `now` until `expiry`; null when there is no usable expiry. */
export function daysUntilExpiry(expiry: string | Date | null | undefined, now: Date): number | null {
  if (!expiry) return null;
  const at = expiry instanceof Date ? expiry.getTime() : Date.parse(String(expiry));
  if (!Number.isFinite(at)) return null;
  return Math.floor((at - now.getTime()) / 86_400_000);
}

/** One provider's rows folded into a single health/capability/expiry picture. */
interface ProviderState {
  provider: string;
  healthy: boolean;
  broken: boolean;
  capabilities: string[];
  soonestExpiryDays: number | null;
}

/** Fold every row for a provider into one state — a user may hold several accounts per provider. */
function foldByProvider(rows: ConnectorSignalRow[], now: Date): ProviderState[] {
  const byProvider = new Map<string, ProviderState>();
  for (const row of rows) {
    const state = byProvider.get(row.provider) ?? {
      provider: row.provider, healthy: false, broken: false, capabilities: [], soonestExpiryDays: null,
    };
    if (row.status === 'connected') state.healthy = true;
    if (BROKEN_STATUSES.has(row.status)) state.broken = true;
    for (const label of connectorCapabilityLabels(row.scopes)) {
      if (!state.capabilities.includes(label)) state.capabilities.push(label);
    }
    const days = daysUntilExpiry(row.expiry, now);
    // Only a HEALTHY row's expiry is worth counting down — a broken row's stale expiry is noise.
    if (days !== null && row.status === 'connected'
      && (state.soonestExpiryDays === null || days < state.soonestExpiryDays)) {
      state.soonestExpiryDays = days;
    }
    byProvider.set(row.provider, state);
  }
  return [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

/** Render one provider's state as the fact value Haven injects. Bounded, no identifiers. */
function renderFactValue(state: ProviderState): string {
  const parts: string[] = [];
  if (state.broken && !state.healthy) parts.push('needs reconnecting');
  else if (state.broken) parts.push('connected (one account needs reconnecting)');
  else parts.push('connected');
  if (state.capabilities.length) parts.push(`can ${state.capabilities.slice(0, 5).join(', ')}`);
  if (state.soonestExpiryDays !== null) {
    if (state.soonestExpiryDays < 0) parts.push('access expired');
    else if (state.soonestExpiryDays === 0) parts.push('access expires today');
    else if (state.soonestExpiryDays <= CONNECTOR_EXPIRY_WARNING_DAYS) {
      parts.push(`access expires in ${state.soonestExpiryDays} day${state.soonestExpiryDays === 1 ? '' : 's'}`);
    }
  }
  return parts.join('; ').slice(0, MAX_FACT_VALUE);
}

/**
 * @description Derive one `signal`-facet fact candidate per connected provider: what it is, what it
 * can do, and whether it needs the owner's attention. Pure and deterministic — the caller merges
 * these through the ordinary fact path so they decay and supersede like everything else.
 * @param rows - The caller's connector rows (from {@link readConnectorSignalRows}).
 * @param now - The evaluation instant (drives the expiry countdown).
 * @returns Fact candidates, one per distinct provider, provider-ordered.
 */
export function connectorSignalCandidates(rows: ConnectorSignalRow[], now: Date): FactCandidate[] {
  return foldByProvider(rows, now).map((state) => ({
    facet: 'signal' as const,
    factKey: `${CONNECTOR_FACT_KEY_PREFIX}${state.provider}`,
    factValue: renderFactValue(state),
    confidence: SIGNAL_CONFIDENCE,
    source: 'signal' as const,
    evidence: `Derived from the owner's ${state.provider} connection record.`,
  }));
}

/**
 * @description The fact keys the current connector estate justifies. The sweep deactivates any
 * `connector-*` signal fact NOT in this set, so disconnecting a provider stops Haven claiming it.
 * @param rows - The caller's connector rows.
 * @returns The live `connector-<provider>` fact keys.
 */
export function connectorSignalFactKeys(rows: ConnectorSignalRow[]): string[] {
  return [...new Set(rows.map((row) => `${CONNECTOR_FACT_KEY_PREFIX}${row.provider}`))].sort();
}

/**
 * @description The connections that warrant telling the owner something: broken ones, and healthy
 * ones inside the expiry warning window. Returns user-facing sentences for the suggestion inbox
 * (and, when the owner has opted in, the outward push). Purely derived — no side effects.
 * @param rows - The caller's connector rows.
 * @param now - The evaluation instant.
 * @returns One message per provider needing attention (possibly empty), provider-ordered.
 */
export function connectorAttentionMessages(rows: ConnectorSignalRow[], now: Date): string[] {
  const out: string[] = [];
  for (const state of foldByProvider(rows, now)) {
    if (state.broken && !state.healthy) {
      out.push(`Your ${state.provider} connection stopped working — reconnect it and I can use it again.`);
      continue;
    }
    if (state.soonestExpiryDays !== null && state.soonestExpiryDays <= CONNECTOR_EXPIRY_WARNING_DAYS) {
      const when = state.soonestExpiryDays < 0
        ? 'has expired'
        : state.soonestExpiryDays === 0
          ? 'expires today'
          : `expires in ${state.soonestExpiryDays} day${state.soonestExpiryDays === 1 ? '' : 's'}`;
      out.push(`Your ${state.provider} access ${when} — reconnect it before it interrupts anything.`);
    }
  }
  return out;
}
