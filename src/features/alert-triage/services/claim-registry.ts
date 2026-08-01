/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P3 (ADR-119 Stage B, FR-B1..B4): the claim registry — declarative rules {match, incidentKey?, intake?, bundleHints?} loaded from ALERT_CLAIMS_FILE plus ALERT_APPROVED_NAMES as a pure-claim shorthand, rebuilt on load (never a persisted store to orphan — spec §9.2). First match wins (FR-B4 — ONE queue, fan-out would recreate the duplicate-ticket problem). Load-time validation enforces the inherited traps: no time predicates in matchers (FR-B3 / spec guard 9 / source ADR-026 — a freshness clause silently kills all matching), a multi-alertname rule MUST carry {alertname} in its key template and free-text/timestamp fields are forbidden in templates (FR-C1 / spec guard 10 / source ADR-031 — the deferred half P1 annotated), and a placeholder-less template is rejected outright (a constant key = silent mass suppression). Invalid RULES are rejected loudly and skipped; a malformed FILE fails open to the shorthand/dev default — a typo must not go dark on monitoring. Unclaimed policy per FR-B2: drop (counted noise, default) | backlog (park unclaimed as backlog tickets)
 */

import { readFileSync } from 'node:fs';
import { createChildLogger } from '@/shared/logger';
import type { CanonicalAlert } from './canonical-alert';

const logger = createChildLogger({ module: 'alert-claim-registry' });

/**
 * @description A claim rule's matcher (FR-B1): an exact alertname (or set of names) and/or
 * exact label matchers. Matchers answer "is this mine", never "is this recent" (FR-B3) —
 * validation rejects every time-flavored field.
 */
export interface ClaimMatch {
  alertname?: string | string[];
  labels?: Record<string, string>;
}

/** @description Per-rule bundling declarations (FR-D4 step 1: the ordered root filter). */
export interface ClaimBundleHints {
  rootFilter?: string[];
}

/**
 * @description One claim rule (FR-B1). `incidentKey` is a template over
 * {alertname}/{target}/{severity}/{labels.<key>} (default `{alertname}::{target}`);
 * `intake` overrides the route default (per-alert labels still win — the SRE who writes
 * the alert rule owns its routing); `bundleHints.rootFilter` feeds the FR-D4 ordered
 * root-candidate policy for incidents this rule opens.
 */
export interface ClaimRule {
  match: ClaimMatch;
  incidentKey?: string;
  intake?: 'approved' | 'backlog';
  bundleHints?: ClaimBundleHints;
}

/** @description A successful claim: the winning rule plus its rendered consequences. */
export interface ClaimResolution {
  rule: ClaimRule;
  incidentKey: string;
  usedFingerprintFallback: boolean;
  intake?: 'approved' | 'backlog';
  rootFilter: readonly string[];
}

/** @description FR-B2 unclaimed handling: drop (counted noise) or park as backlog. */
export type UnclaimedPolicy = 'drop' | 'backlog';

/** @description The FR-C1 default incident-key template. */
export const DEFAULT_INCIDENT_KEY_TEMPLATE = '{alertname}::{target}';

/**
 * @description Time-flavored field names (normalized: lowercased, `_`/`-` stripped) that a
 * matcher or key template may never reference. Matchers: FR-B3 (source ADR-026 — a time
 * predicate inside a matcher silently rejected everything). Templates: a timestamp in an
 * incident key makes every refire a distinct incident, defeating consolidation the same
 * way an empty key defeats distinctness.
 */
const TIME_PREDICATE_FIELDS: ReadonlySet<string> = new Set([
  'startsat', 'endsat', 'firedat', 'firstseen', 'lastseen', 'timestamp', 'time',
  'since', 'until', 'before', 'after', 'age', 'duration', 'activeat',
]);

/** @description Free-text field names forbidden in key templates (FR-C1 / source ADR-031). */
const FREE_TEXT_FIELDS: ReadonlySet<string> = new Set(['summary', 'description', 'message']);

/** @description Non-label placeholder names a key template may use. */
const TEMPLATE_IDENTITY_FIELDS: ReadonlySet<string> = new Set(['alertname', 'target', 'severity']);

const TEMPLATE_PLACEHOLDER = /\{([A-Za-z0-9_.-]+)\}/g;

/** @description Result of validating one raw rule. */
export type ClaimRuleValidation =
  | { ok: true; rule: ClaimRule }
  | { ok: false; reason: string };

/**
 * @description Normalizes a field name for the time-predicate check.
 * @param name - Raw field name.
 * @returns Lowercased name with `_`/`-` stripped.
 */
function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, '');
}

/**
 * @description Whether this matcher can claim more than one alertname (P7 discipline):
 * no alertname constraint (labels-only or catch-all) or a multi-name set.
 * @param match - The rule's matcher.
 * @returns True for multi-alertname rules.
 */
function isMultiAlertname(match: ClaimMatch): boolean {
  if (typeof match.alertname === 'string') return false;
  if (Array.isArray(match.alertname)) return match.alertname.length !== 1;
  return true;
}

/**
 * @description Extracts the placeholder names of a key template.
 * @param template - The template string.
 * @returns Placeholder names in order of appearance.
 */
function templatePlaceholders(template: string): string[] {
  return [...template.matchAll(TEMPLATE_PLACEHOLDER)].map((m) => m[1]);
}

/**
 * @description Validates a key template against the FR-C1 hygiene rules (see the
 * change-log header). Returns null when valid, else the rejection reason.
 * @param template - The template to validate.
 * @param multiAlertname - Whether the owning rule can claim multiple alertnames.
 * @returns Rejection reason or null.
 */
function validateKeyTemplate(template: string, multiAlertname: boolean): string | null {
  const placeholders = templatePlaceholders(template);
  if (placeholders.length === 0) {
    return 'incidentKey template has no placeholders — a constant key merges every alert into one incident (silent mass suppression)';
  }
  for (const name of placeholders) {
    const labelKey = name.startsWith('labels.') ? name.slice('labels.'.length) : null;
    const bareName = labelKey ?? name;
    const normalized = normalizeFieldName(bareName);
    if (FREE_TEXT_FIELDS.has(normalized) || normalized.startsWith('annotation')) {
      return `incidentKey template references free-text field '{${name}}' — forbidden in keys (FR-C1)`;
    }
    if (TIME_PREDICATE_FIELDS.has(normalized)) {
      return `incidentKey template references time field '{${name}}' — a timestamped key defeats consolidation (FR-C1)`;
    }
    if (labelKey === null && !TEMPLATE_IDENTITY_FIELDS.has(name)) {
      return `incidentKey template references unknown field '{${name}}' — allowed: {alertname} {target} {severity} {labels.<key>}`;
    }
    if (labelKey !== null && labelKey.length === 0) {
      return 'incidentKey template has an empty {labels.} reference';
    }
  }
  if (multiAlertname && !placeholders.includes('alertname')) {
    return 'a rule that can claim more than one alertname MUST include {alertname} in its incidentKey template (spec guard 10 / source ADR-031)';
  }
  return null;
}

/**
 * @description Validates one raw rule into a ClaimRule (FR-B1/B3 + key hygiene). Rejection
 * reasons are precise so a rejected rule is tunable from the log line alone.
 * @param raw - The raw rule value from the claims file.
 * @returns ok+rule, or ok:false+reason.
 */
export function validateClaimRule(raw: unknown): ClaimRuleValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'rule is not an object' };
  const rule = raw as Record<string, unknown>;
  const match = rule.match;
  if (!match || typeof match !== 'object' || Array.isArray(match)) return { ok: false, reason: 'rule has no match object' };

  const matchRecord = match as Record<string, unknown>;
  for (const key of Object.keys(matchRecord)) {
    if (key !== 'alertname' && key !== 'labels') {
      // The whole class of "clever" predicates (since/until/newer_than/...) arrives as an
      // unknown matcher field — rejected as such, with the time-predicate trap named when
      // it applies (FR-B3, spec guard 9).
      const suffix = TIME_PREDICATE_FIELDS.has(normalizeFieldName(key))
        ? ' — time predicates are not claims; freshness belongs to TTLs and windows (FR-B3)'
        : '';
      return { ok: false, reason: `unknown matcher field '${key}'${suffix}` };
    }
  }

  const alertname = matchRecord.alertname;
  if (alertname !== undefined) {
    const names = Array.isArray(alertname) ? alertname : [alertname];
    if (names.length === 0 || !names.every((n) => typeof n === 'string' && n.trim().length > 0)) {
      return { ok: false, reason: 'match.alertname must be a non-empty string or array of non-empty strings' };
    }
  }

  const labels = matchRecord.labels;
  if (labels !== undefined) {
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) {
      return { ok: false, reason: 'match.labels must be an object of exact label matchers' };
    }
    for (const [key, value] of Object.entries(labels as Record<string, unknown>)) {
      if (TIME_PREDICATE_FIELDS.has(normalizeFieldName(key))) {
        return { ok: false, reason: `match.labels['${key}'] is a time predicate — matchers answer "is this mine", never "is this recent" (FR-B3)` };
      }
      if (typeof value !== 'string') {
        return { ok: false, reason: `match.labels['${key}'] must be a string` };
      }
    }
  }

  const intake = rule.intake;
  if (intake !== undefined && intake !== 'approved' && intake !== 'backlog') {
    return { ok: false, reason: "intake must be 'approved' or 'backlog'" };
  }

  const incidentKey = rule.incidentKey;
  if (incidentKey !== undefined && typeof incidentKey !== 'string') {
    return { ok: false, reason: 'incidentKey must be a string template' };
  }
  const parsedMatch: ClaimMatch = {
    ...(alertname !== undefined ? { alertname: alertname as string | string[] } : {}),
    ...(labels !== undefined ? { labels: labels as Record<string, string> } : {}),
  };
  const templateError = validateKeyTemplate(
    (incidentKey as string | undefined) ?? DEFAULT_INCIDENT_KEY_TEMPLATE,
    isMultiAlertname(parsedMatch),
  );
  if (templateError) return { ok: false, reason: templateError };

  const bundleHints = rule.bundleHints;
  let parsedHints: ClaimBundleHints | undefined;
  if (bundleHints !== undefined) {
    if (!bundleHints || typeof bundleHints !== 'object' || Array.isArray(bundleHints)) {
      return { ok: false, reason: 'bundleHints must be an object' };
    }
    const rootFilter = (bundleHints as Record<string, unknown>).rootFilter;
    if (rootFilter !== undefined) {
      if (!Array.isArray(rootFilter) || !rootFilter.every((t) => typeof t === 'string' && t.trim().length > 0)) {
        return { ok: false, reason: 'bundleHints.rootFilter must be an array of non-empty target names' };
      }
      parsedHints = { rootFilter: rootFilter as string[] };
    } else {
      parsedHints = {};
    }
  }

  return {
    ok: true,
    rule: {
      match: parsedMatch,
      ...(incidentKey !== undefined ? { incidentKey: incidentKey as string } : {}),
      ...(intake !== undefined ? { intake } : {}),
      ...(parsedHints !== undefined ? { bundleHints: parsedHints } : {}),
    },
  };
}

/**
 * @description Renders a rule's incident-key template for an alert, with the same key
 * hygiene P1 shipped (spec guard 10 first half): when every placeholder substitutes empty
 * the key carries no identity, so it falls back to the alert fingerprint with a warning —
 * distinct alerts never silently share an "empty" key.
 * @param template - The rule's template (or the default).
 * @param alert - The canonical alert.
 * @returns The rendered key and whether the fingerprint fallback fired.
 */
export function renderClaimIncidentKey(
  template: string,
  alert: CanonicalAlert,
): { key: string; usedFingerprintFallback: boolean } {
  let substitutedIdentity = false;
  const key = template.replace(TEMPLATE_PLACEHOLDER, (_whole, name: string) => {
    const value = lookupTemplateField(name, alert);
    if (value.trim().length > 0) substitutedIdentity = true;
    return value;
  });
  if (substitutedIdentity) return { key, usedFingerprintFallback: false };
  const fallback = alert.fingerprint.trim() || 'unidentified-incident';
  logger.warn(
    { template, fingerprint: fallback },
    'Claim incident key rendered empty — falling back to the alert fingerprint (FR-C1 key hygiene)',
  );
  return { key: fallback, usedFingerprintFallback: true };
}

/**
 * @description Resolves one template placeholder against the canonical alert.
 * @param name - Placeholder name (validated at load).
 * @param alert - The canonical alert.
 * @returns The field value ('' when absent).
 */
function lookupTemplateField(name: string, alert: CanonicalAlert): string {
  if (name === 'alertname') return alert.alertname;
  if (name === 'target') return alert.target;
  if (name === 'severity') return alert.severity;
  if (name.startsWith('labels.')) return alert.labels[name.slice('labels.'.length)] ?? '';
  return '';
}

/**
 * @description Resolves the FR-B2 unclaimed policy from `ALERT_UNCLAIMED_POLICY`:
 * `backlog` parks unclaimed alerts as backlog tickets (the cautious migration setting);
 * anything else — including unset — is `drop` (counted noise).
 * @returns The unclaimed policy.
 */
export function unclaimedPolicy(): UnclaimedPolicy {
  return (process.env.ALERT_UNCLAIMED_POLICY ?? '').trim().toLowerCase() === 'backlog' ? 'backlog' : 'drop';
}

/**
 * @description Stage B claim registry (FR-B1..B4). Declarative and rebuilt on load —
 * there is no persisted rule store to orphan (spec §9.2). With zero rules the registry is
 * UNCONFIGURED and the intake keeps the accept-all dev default (FR-B2 compatibility).
 */
export class AlertClaimRegistry {
  /**
   * @param rules - Validated rules in declared order (first match wins, FR-B4).
   */
  constructor(private readonly rules: readonly ClaimRule[]) {}

  /** @description True when at least one rule is registered (the FR-B2 gate switch). */
  get configured(): boolean {
    return this.rules.length > 0;
  }

  /**
   * @description Evaluates the rules in declared order and returns the first claim, with
   * the rule's incident key rendered and its intake/rootFilter declarations attached.
   * One claim per alert — deliberately no fan-out (FR-B4).
   * @param alert - The canonical alert.
   * @returns The claim resolution, or null when no rule claims the alert (noise).
   */
  claim(alert: CanonicalAlert): ClaimResolution | null {
    for (const rule of this.rules) {
      if (!matchesRule(rule.match, alert)) continue;
      const { key, usedFingerprintFallback } = renderClaimIncidentKey(
        rule.incidentKey ?? DEFAULT_INCIDENT_KEY_TEMPLATE,
        alert,
      );
      return {
        rule,
        incidentKey: key,
        usedFingerprintFallback,
        ...(rule.intake !== undefined ? { intake: rule.intake } : {}),
        rootFilter: rule.bundleHints?.rootFilter ?? [],
      };
    }
    return null;
  }

  /**
   * @description Builds the registry from the environment: validated rules from the
   * ALERT_CLAIMS_FILE JSON (`{ "rules": [...] }`) in declared order, then every
   * ALERT_APPROVED_NAMES entry as a pure-claim shorthand rule (FR-B1 — the allowlist
   * remains valid, now as claims). Invalid RULES are rejected loudly and skipped (their
   * alerts become counted noise — visible in intake-stats, tunable from evidence); a
   * malformed FILE fails open to whatever else is configured, because a claims-file typo
   * that silently dropped every alert would blind the swarm to its own outages.
   * @returns The registry (possibly unconfigured → accept-all dev default).
   */
  static fromEnvironment(): AlertClaimRegistry {
    const rules: ClaimRule[] = [];
    const file = (process.env.ALERT_CLAIMS_FILE ?? '').trim();
    if (file) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { rules?: unknown };
        if (!Array.isArray(parsed?.rules)) {
          throw new Error('expected shape { "rules": [ { "match": ... }, ... ] }');
        }
        parsed.rules.forEach((raw, index) => {
          const result = validateClaimRule(raw);
          if (result.ok) {
            rules.push(result.rule);
          } else {
            logger.error({ file, index, reason: result.reason }, 'Claim rule REJECTED at registry load (spec guards 9/10) — rule skipped');
          }
        });
        logger.info({ file, loaded: rules.length }, 'Loaded alert claim rules from ALERT_CLAIMS_FILE');
      } catch (err) {
        logger.error({ err, file }, 'Failed to load ALERT_CLAIMS_FILE — continuing without its rules (fail-open to shorthand/dev default)');
      }
    }
    const approvedRaw = (process.env.ALERT_APPROVED_NAMES ?? '').trim();
    if (approvedRaw) {
      for (const name of approvedRaw.split(',').map((s) => s.trim()).filter(Boolean)) {
        rules.push({ match: { alertname: name } });
      }
    }
    return new AlertClaimRegistry(rules);
  }
}

/**
 * @description Does this matcher claim this alert? Exact alertname (or membership in the
 * name set) AND every label matcher equal — "is this mine", nothing temporal (FR-B3).
 * @param match - The rule's matcher.
 * @param alert - The canonical alert.
 * @returns True on a claim.
 */
function matchesRule(match: ClaimMatch, alert: CanonicalAlert): boolean {
  if (typeof match.alertname === 'string' && match.alertname !== alert.alertname) return false;
  if (Array.isArray(match.alertname) && !match.alertname.includes(alert.alertname)) return false;
  if (match.labels) {
    for (const [key, value] of Object.entries(match.labels)) {
      if (alert.labels[key] !== value) return false;
    }
  }
  return true;
}
