/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Claim-rule semantics for the Operations Stream operator API: save-time validation (a rule that cannot match, a freshness clause hiding inside a matcher, a free-text or timestamp identity field, an unknown autonomy or intake value) and the predicate evaluator the rule tester and the replay claim pass both run. One definition of what a predicate MEANS, so a rule that tests green cannot behave differently when an event actually arrives.
 */

/**
 * Why validation happens at SAVE time rather than at match time.
 *
 * Every failure this module refuses is silent at runtime. A matcher carrying a freshness clause is
 * evaluated against the event's own timestamp and rejects an entire lane while the rule sits
 * visibly registered and enabled. An empty `alertname` array is an inert rule that looks configured.
 * A timestamp or an annotation used as an identity field mints a new identity per occurrence, so
 * consolidation stops consolidating and every refire opens another incident. None of these produce
 * an error anywhere — they produce an absence, and an absence is the one thing threshold alerting
 * can never notice.
 *
 * @module ops-pipeline-rule-validation
 */

import { createHash } from 'node:crypto';
import {
  DEFAULT_IDENTITY_FIELDS,
  MAX_TRAVERSAL_DEPTH,
  SEVERITY_RANK,
  type AutonomyLevel,
  type ClaimPredicate,
  type ClaimRuleRow,
} from '@/features/alert-pipeline';

/** @description The only keys a claim predicate may carry. Anything else is refused by name. */
export const PREDICATE_KEYS: readonly string[] = Object.freeze(['alertname', 'labels', 'severityMax']);

/** @description The intake values a rule may declare. */
export const INTAKE_VALUES: readonly string[] = Object.freeze(['auto', 'backlog', 'inherit']);

/** @description The autonomy levels a rule may declare. There is deliberately no `A3`. */
export const AUTONOMY_LEVELS: readonly string[] = Object.freeze(['A0', 'A1', 'A2']);

/**
 * @description Time-flavoured field names (normalized: lowercased, `_`/`-`/`.` stripped) that may
 * appear neither in a matcher nor in an identity field list. In a matcher they are a freshness
 * clause, which is evaluated against the event's own timestamp and silently empties a lane. In an
 * identity they change on every occurrence, so each refire mints a new incident.
 */
const TIME_FIELDS: ReadonlySet<string> = new Set([
  'startsat', 'endsat', 'firedat', 'firstseen', 'lastseen', 'timestamp', 'time', 'since', 'until',
  'before', 'after', 'age', 'duration', 'activeat', 'window', 'freshness', 'maxage', 'minage',
  'olderthan', 'newerthan', 'within', 'ttl', 'range', 'for', 'receivedat', 'processedat',
]);

/**
 * @description Free-text field names that may never be an identity field. Their content is
 * attacker-influenced prose that changes wording between firings of the same failure, so an
 * identity built on one is unstable by construction.
 */
const FREE_TEXT_FIELDS: ReadonlySet<string> = new Set([
  'summary', 'description', 'message', 'annotations', 'annotation', 'generatorurl', 'value',
]);

/** Lowest and highest severity ordinal a predicate ceiling can usefully name (1 = critical). */
const SEVERITY_NUM_MIN = Math.min(...Object.values(SEVERITY_RANK));
const SEVERITY_NUM_MAX = Math.max(...Object.values(SEVERITY_RANK));

/** Ceiling on a stored rule id, and the characters one may use — it is an index term and a log key. */
const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

/** Ceiling on a stored note, so free text on a configuration table stays bounded. */
const NOTES_MAX_LENGTH = 1000;

/** Ceiling on how many rules one reconcile may carry. */
export const MAX_CLAIM_RULES = 500;

/** @description One rejected rule, named precisely enough to fix without reading this file. */
export interface RuleValidationError {
  /** The rule that was refused; `<index N>` when the submitted entry had no usable id. */
  ruleId: string;
  /** The field that carries the problem. */
  field: string;
  /** What is wrong and why it matters. */
  reason: string;
}

/** @description A validated rule, in the exact shape the reconcile writes. */
export interface ClaimRuleDraft {
  ruleId: string;
  enabled: boolean;
  priority: number;
  matchPredicate: ClaimPredicate;
  identityFields: string[];
  dedupTtlSeconds: number | null;
  reopenWindowSeconds: number | null;
  intake: 'auto' | 'backlog' | 'inherit';
  autonomyLevel: AutonomyLevel;
  rootFilter: string[] | null;
  correlationDepth: number | null;
  predicateHash: string;
  notes: string | null;
}

/** @description The outcome of validating a whole submitted rule set. */
export interface RuleValidationResult {
  /** Every rule that validated. Meaningful only when `errors` is empty — the save is all-or-nothing. */
  rules: ClaimRuleDraft[];
  /** Every refusal, one entry per problem. */
  errors: RuleValidationError[];
}

/** @description The minimum an event must carry to be matched against a predicate. */
export interface MatchableEvent {
  alertname: string;
  target: string;
  severityNum: number;
  labels: Record<string, string>;
}

/** @description Which rules matched an event, and which one of them actually claims it. */
export interface ClaimSelection {
  /** Every enabled rule whose predicate matched, in evaluation order. */
  matched: string[];
  /** The rule that wins: the first match in evaluation order. */
  claimedBy: ClaimRuleRow | null;
}

/**
 * @description Normalizes a field name for the time/free-text checks: case, separators and a
 * `labels.` prefix are all cosmetic, and a denylist that any of them defeats is not a denylist.
 * @param name - Raw field name as submitted.
 * @returns The comparable leaf name.
 */
function normalizeFieldName(name: string): string {
  const spec = String(name ?? '').trim();
  const leaf = spec.includes('.') ? spec.slice(spec.indexOf('.') + 1) : spec;
  return leaf.toLowerCase().replace(/[_\-.]/g, '');
}

/**
 * @description Renders a value as canonical JSON — object keys sorted, `undefined` dropped — so
 * two predicates that differ only in key order hash identically and a re-save is recognisably a
 * no-op rather than a spurious change.
 * @param value - Any JSON-representable value.
 * @returns The canonical serialization.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * @description Fingerprints a predicate so a stored rule carries a stable identity for its matching
 * behaviour, independent of how the JSON was formatted when it was submitted.
 * @param predicate - The predicate to fingerprint.
 * @returns 32 hex characters of a SHA-256 over the canonical form.
 */
export function predicateHash(predicate: ClaimPredicate): string {
  return createHash('sha256').update(canonicalJson(predicate), 'utf8').digest('hex').slice(0, 32);
}

/**
 * @description Reads the string array a predicate or a rule field carries.
 * @param value - Candidate value.
 * @returns The trimmed non-empty strings, or null when the value is not an array of strings.
 */
function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((entry) => typeof entry === 'string')) return null;
  return value.map((entry) => (entry as string).trim());
}

/**
 * @description Validates one label matcher entry: the key may not be a freshness clause in
 * disguise, and the accepted-value list may not be empty.
 * @param ruleId - Owning rule, for the error.
 * @param key - Label key.
 * @param value - Accepted value or values.
 * @returns The rejection reason, or null when the entry is usable.
 */
function labelMatcherProblem(ruleId: string, key: string, value: unknown): string | null {
  if (TIME_FIELDS.has(normalizeFieldName(key))) {
    return `matches on the time-valued label '${key}' — a freshness clause inside a matcher is `
      + 'evaluated against the event\'s own timestamp and silently empties the whole lane';
  }
  if (typeof value === 'string') {
    return null;
  }
  const values = readStringArray(value);
  if (values === null) {
    return `label '${key}' must match a string or an array of strings`;
  }
  if (values.length === 0) {
    return `label '${key}' has an empty accepted-value list, so this rule can never match anything`;
  }
  return null;
}

/**
 * @description Validates a match predicate: no unknown keys, no time or range clause, no matcher
 * that can never be satisfied.
 * @param ruleId - Owning rule, for the errors.
 * @param raw - The submitted predicate.
 * @param errors - Accumulator the problems are appended to.
 * @returns The predicate to store; `{}` when it could not be read.
 */
function readPredicate(ruleId: string, raw: unknown, errors: RuleValidationError[]): ClaimPredicate {
  const field = 'matchPredicate';
  const push = (reason: string): void => void errors.push({ ruleId, field, reason });
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    push('match predicate must be an object');
    return {};
  }
  const source = raw as Record<string, unknown>;
  const predicate: ClaimPredicate = {};
  for (const key of Object.keys(source)) {
    if (PREDICATE_KEYS.includes(key)) continue;
    push(
      TIME_FIELDS.has(normalizeFieldName(key))
        ? `carries the time/range key '${key}' — freshness belongs to intake windows and TTLs, never to a claim`
        : `carries the unknown key '${key}' — a predicate may only use ${PREDICATE_KEYS.join(', ')}`,
    );
  }
  readAlertnameMatcher(source.alertname, predicate, push);
  readLabelMatcher(ruleId, source.labels, predicate, push);
  readSeverityCeiling(source.severityMax, predicate, push);
  return predicate;
}

/**
 * @description Reads the `alertname` matcher. An empty list is refused rather than treated as
 * "any": an inert rule that looks configured is the failure this whole surface exists to prevent.
 * @param raw - Submitted value.
 * @param predicate - Predicate under construction.
 * @param push - Error sink.
 * @returns Nothing.
 */
function readAlertnameMatcher(raw: unknown, predicate: ClaimPredicate, push: (reason: string) => void): void {
  if (raw === undefined || raw === null) return;
  const names = typeof raw === 'string' ? [raw.trim()] : readStringArray(raw);
  if (names === null) {
    push('alertname must be a string or an array of strings');
    return;
  }
  if (names.length === 0) {
    push('alertname is an empty list, so this rule can never match anything — omit the key to match every alert name');
    return;
  }
  predicate.alertname = names;
}

/**
 * @description Reads the `labels` matcher, refusing time-valued keys and empty value lists.
 * @param ruleId - Owning rule, for the errors.
 * @param raw - Submitted value.
 * @param predicate - Predicate under construction.
 * @param push - Error sink.
 * @returns Nothing.
 */
function readLabelMatcher(
  ruleId: string,
  raw: unknown,
  predicate: ClaimPredicate,
  push: (reason: string) => void,
): void {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    push('labels must be an object of label name to accepted value(s)');
    return;
  }
  const labels: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const problem = labelMatcherProblem(ruleId, key, value);
    if (problem) {
      push(problem);
      continue;
    }
    labels[key] = typeof value === 'string' ? value : (readStringArray(value) as string[]);
  }
  if (Object.keys(labels).length > 0) predicate.labels = labels;
}

/**
 * @description Reads the severity ceiling. The ordinal is inverted (1 = critical), so a ceiling
 * below the most severe rank admits nothing at all.
 * @param raw - Submitted value.
 * @param predicate - Predicate under construction.
 * @param push - Error sink.
 * @returns Nothing.
 */
function readSeverityCeiling(raw: unknown, predicate: ClaimPredicate, push: (reason: string) => void): void {
  if (raw === undefined || raw === null) return;
  const ceiling = Number(raw);
  if (!Number.isInteger(ceiling)) {
    push('severityMax must be an integer severity ordinal (1 = critical … 4 = info)');
    return;
  }
  if (ceiling < SEVERITY_NUM_MIN) {
    push(
      `severityMax ${ceiling} is below the most severe ordinal (${SEVERITY_NUM_MIN}), `
      + 'so this rule can never match anything — the ordinal is inverted, 1 is critical',
    );
    return;
  }
  predicate.severityMax = Math.min(ceiling, SEVERITY_NUM_MAX);
}

/**
 * @description Validates the identity field list: no free text, no timestamps, and never empty.
 * An empty list renders every event to the same identity string and collapses the whole estate
 * into one incident, so it is refused rather than quietly replaced by the default.
 * @param ruleId - Owning rule, for the errors.
 * @param raw - Submitted value.
 * @param errors - Accumulator.
 * @returns The fields to store, defaulting to target + alertname when the key is absent.
 */
function readIdentityFields(ruleId: string, raw: unknown, errors: RuleValidationError[]): string[] {
  const field = 'identityFields';
  if (raw === undefined || raw === null) return [...DEFAULT_IDENTITY_FIELDS];
  const fields = readStringArray(raw);
  if (fields === null) {
    errors.push({ ruleId, field, reason: 'identityFields must be an array of strings' });
    return [...DEFAULT_IDENTITY_FIELDS];
  }
  const usable = fields.filter((entry) => entry.length > 0);
  if (usable.length === 0) {
    errors.push({
      ruleId,
      field,
      reason: 'identityFields is empty — every event would render to the same identity and one incident would absorb the estate',
    });
    return [...DEFAULT_IDENTITY_FIELDS];
  }
  for (const entry of usable) {
    const leaf = normalizeFieldName(entry);
    if (FREE_TEXT_FIELDS.has(leaf) || leaf.startsWith('annotation')) {
      errors.push({ ruleId, field, reason: `'${entry}' is free text — its wording changes between firings of the same failure, so it cannot carry an identity` });
    } else if (TIME_FIELDS.has(leaf)) {
      errors.push({ ruleId, field, reason: `'${entry}' is a timestamp — a new value on every occurrence means every refire opens a new incident` });
    }
  }
  return usable;
}

/**
 * @description Reads one optional non-negative integer bound.
 * @param ruleId - Owning rule, for the error.
 * @param field - Field name, for the error.
 * @param raw - Submitted value.
 * @param max - Inclusive ceiling.
 * @param errors - Accumulator.
 * @returns The value, or null when absent.
 */
function readBound(
  ruleId: string,
  field: string,
  raw: unknown,
  max: number,
  errors: RuleValidationError[],
): number | null {
  if (raw === undefined || raw === null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > max) {
    errors.push({ ruleId, field, reason: `${field} must be an integer between 0 and ${max}` });
    return null;
  }
  return value;
}

/**
 * @description Reads the two enum fields, naming the accepted vocabulary on refusal.
 * @param ruleId - Owning rule, for the errors.
 * @param source - The submitted rule.
 * @param errors - Accumulator.
 * @returns The intake and autonomy values to store.
 */
function readEnums(
  ruleId: string,
  source: Record<string, unknown>,
  errors: RuleValidationError[],
): { intake: ClaimRuleDraft['intake']; autonomyLevel: AutonomyLevel } {
  const intakeRaw = source.intake === undefined || source.intake === null ? 'inherit' : String(source.intake);
  const autonomyRaw = source.autonomyLevel === undefined || source.autonomyLevel === null ? 'A0' : String(source.autonomyLevel);
  if (!INTAKE_VALUES.includes(intakeRaw)) {
    errors.push({ ruleId, field: 'intake', reason: `unknown intake '${intakeRaw}' — accepted: ${INTAKE_VALUES.join(', ')}` });
  }
  if (!AUTONOMY_LEVELS.includes(autonomyRaw)) {
    errors.push({
      ruleId,
      field: 'autonomyLevel',
      reason: `unknown autonomy level '${autonomyRaw}' — accepted: ${AUTONOMY_LEVELS.join(', ')} (there is no A3)`,
    });
  }
  return {
    intake: (INTAKE_VALUES.includes(intakeRaw) ? intakeRaw : 'inherit') as ClaimRuleDraft['intake'],
    autonomyLevel: (AUTONOMY_LEVELS.includes(autonomyRaw) ? autonomyRaw : 'A0') as AutonomyLevel,
  };
}

/**
 * @description Validates one submitted rule into its storable draft.
 * @param raw - The submitted entry.
 * @param index - Position in the submitted array, used when the entry has no usable id.
 * @param errors - Accumulator shared across the whole set.
 * @returns The draft; it is only written when the whole set validated.
 */
function readRule(raw: unknown, index: number, errors: RuleValidationError[]): ClaimRuleDraft {
  const source = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const submittedId = String(source.ruleId ?? '').trim();
  const ruleId = submittedId.length > 0 ? submittedId : `<index ${index}>`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ ruleId, field: 'rule', reason: 'rule must be an object' });
  } else if (!RULE_ID_PATTERN.test(submittedId)) {
    errors.push({ ruleId, field: 'ruleId', reason: 'ruleId must be 1-128 characters of letters, digits, dot, colon, dash or underscore' });
  }
  const priority = source.priority === undefined || source.priority === null ? 100 : Number(source.priority);
  if (!Number.isInteger(priority)) {
    errors.push({ ruleId, field: 'priority', reason: 'priority must be an integer (lower is evaluated first)' });
  }
  const notes = source.notes === undefined || source.notes === null ? null : String(source.notes).slice(0, NOTES_MAX_LENGTH);
  const matchPredicate = readPredicate(ruleId, source.matchPredicate, errors);
  const { intake, autonomyLevel } = readEnums(ruleId, source, errors);
  return {
    ruleId: submittedId,
    enabled: source.enabled === undefined ? true : source.enabled === true,
    priority: Number.isInteger(priority) ? priority : 100,
    matchPredicate,
    identityFields: readIdentityFields(ruleId, source.identityFields, errors),
    dedupTtlSeconds: readBound(ruleId, 'dedupTtlSeconds', source.dedupTtlSeconds, 30 * 24 * 3600, errors),
    reopenWindowSeconds: readBound(ruleId, 'reopenWindowSeconds', source.reopenWindowSeconds, 30 * 24 * 3600, errors),
    intake,
    autonomyLevel,
    rootFilter: readStringArray(source.rootFilter ?? null),
    correlationDepth: readBound(ruleId, 'correlationDepth', source.correlationDepth, MAX_TRAVERSAL_DEPTH, errors),
    predicateHash: predicateHash(matchPredicate),
    notes,
  };
}

/**
 * @description Validates a whole submitted rule set. Every problem in every rule is reported in one
 * pass — a surface that fixes one rejection only to hit the next is why operators stop using it —
 * and a duplicate id is refused because the reconcile would otherwise silently keep whichever copy
 * the upsert applied last.
 * @param input - The request body: `{ rules: [...] }`, or a bare array.
 * @returns The validated drafts and every refusal. The caller writes nothing while `errors` is non-empty.
 */
export function validateClaimRuleSet(input: unknown): RuleValidationResult {
  const container = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>).rules
    : input;
  if (!Array.isArray(container)) {
    return { rules: [], errors: [{ ruleId: '<body>', field: 'rules', reason: 'body must carry a rules array' }] };
  }
  if (container.length > MAX_CLAIM_RULES) {
    return {
      rules: [],
      errors: [{ ruleId: '<body>', field: 'rules', reason: `a reconcile may carry at most ${MAX_CLAIM_RULES} rules` }],
    };
  }
  const errors: RuleValidationError[] = [];
  const rules = container.map((raw, index) => readRule(raw, index, errors));
  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.ruleId.length === 0) continue;
    if (seen.has(rule.ruleId)) {
      errors.push({ ruleId: rule.ruleId, field: 'ruleId', reason: 'duplicate ruleId in the submitted set' });
    }
    seen.add(rule.ruleId);
  }
  return { rules, errors };
}

/**
 * @description Evaluates one predicate against one event. Every declared clause must hold; a
 * predicate with no clauses matches everything, which is what makes an empty rule table read as
 * UNCONFIGURED rather than as a working deny-all.
 *
 * Comparison is exact on the trimmed value. Case folding here would admit events the stored
 * matcher does not name, and a rule that matches more than it says is how an unrelated alert ends
 * up consolidated onto someone else's incident.
 * @param predicate - The rule's matcher.
 * @param event - The normalized event.
 * @returns True when the event satisfies every clause.
 */
export function matchesPredicate(predicate: ClaimPredicate, event: MatchableEvent): boolean {
  const names = predicate.alertname;
  if (Array.isArray(names) && names.length > 0 && !names.includes(event.alertname)) {
    return false;
  }
  if (typeof predicate.severityMax === 'number' && event.severityNum > predicate.severityMax) {
    return false;
  }
  for (const [key, expected] of Object.entries(predicate.labels ?? {})) {
    const actual = event.labels[key];
    if (typeof actual !== 'string') return false;
    const accepted = Array.isArray(expected) ? expected : [expected];
    if (!accepted.includes(actual)) return false;
  }
  return true;
}

/**
 * @description Runs an event past every rule and reports both which rules matched and which one
 * claims it. The two are reported separately on purpose: a single claimant is the healthy state,
 * and an operator needs to see the overlap BEFORE a second rule starts quietly losing every race.
 * @param rules - Rules in evaluation order (priority ascending, then rule id).
 * @param event - The normalized event to route.
 * @returns The matching rule ids and the winner.
 */
export function selectClaimingRules(rules: ClaimRuleRow[], event: MatchableEvent): ClaimSelection {
  const matches = rules.filter((rule) => rule.enabled && matchesPredicate(rule.matchPredicate ?? {}, event));
  return {
    matched: matches.map((rule) => rule.ruleId),
    claimedBy: matches.length > 0 ? matches[0] : null,
  };
}
