/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Versioned producer evidence and pure scoped operation-token aggregation for ADR-170 P0; never infer feature, call count, completion or model compatibility.
 */

/** Trusted producer declaration, not browser input or a grant of access. One operation is one declared unit. */
export interface FeatureTokenEvidence {
  version: 1;
  producerId: string;
  applicationId: string;
  featureId: string;
  unit: string;
  workloadId: string;
  coreSha: string;
  storeSha: string;
  operationId: string;
  startedAt: string;
  memberId: string;
  memberIndex: number;
  tokenProvenance: 'provider-reported' | 'estimated' | 'unknown';
  /** Only the final member declares completion and the exact number of persisted members expected. */
  completion: { memberCount: number; completedAt: string } | null;
}

/** Ledger payload. Requests are copied from CostEvent, never inferred from member count. */
export interface StoredFeatureTokenEvidence extends FeatureTokenEvidence {
  requestCount: number | null;
}

/** Explicitly authorized input projection; the reducer performs no database reads or identity elevation. */
export interface FeatureTokenEvidenceRow {
  id: string;
  ts: string | Date;
  owner_sub: string | null;
  provider_id: string | null;
  model_id: string | null;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  feature_evidence: unknown;
}

/** The caller supplies scope after enforcing access; matching a string is not authorization. */
export interface FeatureTokenEvidenceScope {
  ownerSub: string | null;
  from: string;
  until: string;
}

/** Observed token distribution for completed single-unit operations under one workload/source/model set. */
export interface FeatureTokenProfile {
  producerId: string;
  applicationId: string;
  featureId: string;
  unit: string;
  workloadId: string;
  coreSha: string;
  storeSha: string;
  models: Array<{ providerId: string; modelId: string }>;
  operations: number;
  tokensPerOperation: { p50: number; p95: number };
  outputTokensPerOperation: { p50: number; p95: number };
  requestsPerOperation: { p50: number; p95: number; mean: number };
}

type Exclusion = 'incomplete' | 'duplicate' | 'binding_conflict' | 'unknown_usage' | 'out_of_window' | 'overflow';
/** Sample evidence only: a time range is not measured stack uptime or a compatibility verdict. */
export interface FeatureTokenReport {
  version: 1;
  coverage: 'recorded-samples-only';
  window: { from: string; until: string };
  inputRows: number;
  unattributedRows: number;
  excludedOperations: Record<Exclusion, number>;
  profiles: FeatureTokenProfile[];
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const KEYS = ['version', 'producerId', 'applicationId', 'featureId', 'unit', 'workloadId', 'coreSha',
  'storeSha', 'operationId', 'startedAt', 'memberId', 'memberIndex', 'tokenProvenance', 'completion'];
const MAX_MEMBERS = 10_000;
const MAX_ROWS = 100_000;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const label = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128
  && v.trim() === v && !/[\x00-\x1f\x7f]/.test(v);
const slug = (v: unknown): v is string => label(v) && SLUG.test(v);
const time = (v: unknown): v is string => typeof v === 'string' && v.length === 24
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

function parseEvidence(value: unknown, stored: boolean): StoredFeatureTokenEvidence | null {
  if (!record(value) || Object.keys(value).some(k => ![...KEYS, ...(stored ? ['requestCount'] : [])].includes(k))) return null;
  if (value.version !== 1 || !slug(value.producerId) || !slug(value.applicationId) || !slug(value.featureId)
    || !slug(value.workloadId) || !label(value.unit)) return null;
  if (typeof value.coreSha !== 'string' || !SHA.test(value.coreSha) || typeof value.storeSha !== 'string' || !SHA.test(value.storeSha)) return null;
  if (typeof value.operationId !== 'string' || !UUID.test(value.operationId) || typeof value.memberId !== 'string' || !UUID.test(value.memberId)) return null;
  if (!time(value.startedAt) || !count(value.memberIndex) || value.memberIndex < 1 || value.memberIndex > MAX_MEMBERS) return null;
  if (!['provider-reported', 'estimated', 'unknown'].includes(value.tokenProvenance as string)) return null;
  if (stored && value.requestCount !== null && !count(value.requestCount)) return null;
  const c = value.completion;
  if (c !== null && (!record(c) || Object.keys(c).some(k => !['memberCount', 'completedAt'].includes(k))
    || !count(c.memberCount) || c.memberCount !== value.memberIndex || !time(c.completedAt)
    || c.completedAt < value.startedAt)) return null;
  return Object.freeze({
    version: 1, producerId: value.producerId, applicationId: value.applicationId, featureId: value.featureId,
    unit: value.unit, workloadId: value.workloadId, coreSha: value.coreSha, storeSha: value.storeSha,
    operationId: value.operationId, startedAt: value.startedAt, memberId: value.memberId, memberIndex: value.memberIndex,
    tokenProvenance: value.tokenProvenance as FeatureTokenEvidence['tokenProvenance'],
    completion: c === null ? null : Object.freeze({ memberCount: c.memberCount as number, completedAt: c.completedAt as string }),
    requestCount: stored ? value.requestCount as number | null : null,
  });
}

/**
 * @description Snapshot optional trusted evidence before persistence awaits; invalid declarations remain unmeasured.
 * @param value - Producer evidence, never derived from task/agent identifiers.
 * @param metrics - Exact event metrics; missing request counts stay null and estimated tokens cannot become measured.
 * @returns Immutable stored payload or null when evidence is absent/invalid; ordinary accounting is unaffected.
 */
export function prepareFeatureTokenEvidence(value: unknown, metrics: {
  requestCount?: number; inputTokens: number; outputTokens: number; estimated?: boolean;
}): StoredFeatureTokenEvidence | null {
  const parsed = parseEvidence(value, false);
  if (!parsed) return null;
  const provenance = metrics.estimated === true ? 'estimated'
    : count(metrics.inputTokens) && count(metrics.outputTokens) ? parsed.tokenProvenance : 'unknown';
  return Object.freeze({ ...parsed, tokenProvenance: provenance, requestCount: count(metrics.requestCount) ? metrics.requestCount : null });
}

interface Member { row: FeatureTokenEvidenceRow; evidence: StoredFeatureTokenEvidence; timestamp: number }
interface Sample { profile: Omit<FeatureTokenProfile, 'operations' | 'tokensPerOperation' | 'outputTokensPerOperation' | 'requestsPerOperation'>;
  tokens: number; output: number; requests: number }
function fail(): never { throw new Error('invalid_feature_token_evidence'); }
const binding = (e: FeatureTokenEvidence) => JSON.stringify([e.producerId, e.applicationId, e.featureId, e.unit,
  e.workloadId, e.coreSha, e.storeSha, e.operationId, e.startedAt]);

function tokenCount(value: unknown): number | null {
  if (count(value)) return value;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const n = Number(value);
  return count(n) ? n : null;
}

function collectMembers(rows: readonly FeatureTokenEvidenceRow[], scope: FeatureTokenEvidenceScope) {
  const groups = new Map<string, Member[]>();
  const repeatedRows = new Set<string>();
  const rowIds = new Set<string>();
  let unattributedRows = 0;
  for (const row of rows) {
    if (!record(row) || row.owner_sub !== scope.ownerSub) throw new Error('feature_token_scope_mismatch');
    if (typeof row.id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(row.id)) fail();
    if (rowIds.has(row.id)) repeatedRows.add(row.id);
    rowIds.add(row.id);
    if (row.feature_evidence == null) { unattributedRows++; continue; }
    const evidence = parseEvidence(row.feature_evidence, true);
    const timestamp = row.ts instanceof Date ? row.ts.getTime() : time(row.ts) ? Date.parse(row.ts) : NaN;
    if (!evidence || !Number.isFinite(timestamp)) fail();
    const memberKey = `member:${evidence.memberId}`;
    if (rowIds.has(memberKey)) repeatedRows.add(memberKey);
    rowIds.add(memberKey);
    const members = groups.get(evidence.operationId) ?? [];
    members.push({ row, evidence, timestamp });
    groups.set(evidence.operationId, members);
  }
  return { groups, repeatedRows, unattributedRows };
}

function exclusion(members: Member[], repeated: Set<string>, from: number, until: number): Exclusion | null {
  if (members.some(m => repeated.has(m.row.id) || repeated.has(`member:${m.evidence.memberId}`)) || new Set(members.map(m => m.evidence.memberId)).size !== members.length
    || new Set(members.map(m => m.evidence.memberIndex)).size !== members.length) return 'duplicate';
  if (members.some(m => binding(m.evidence) !== binding(members[0].evidence))) return 'binding_conflict';
  const final = members.filter(m => m.evidence.completion !== null);
  if (final.length !== 1) return 'incomplete';
  const completion = final[0].evidence.completion!;
  if (Date.parse(completion.completedAt) > final[0].timestamp) return 'incomplete';
  if (completion.memberCount !== members.length || members.some(m => m.evidence.memberIndex > completion.memberCount)) return 'incomplete';
  if (Date.parse(members[0].evidence.startedAt) < from || Date.parse(completion.completedAt) >= until
    || members.some(m => m.timestamp < from || m.timestamp >= until || m.timestamp < Date.parse(m.evidence.startedAt))) return 'out_of_window';
  if (members.some(m => m.evidence.tokenProvenance !== 'provider-reported' || m.evidence.requestCount === null
    || m.evidence.requestCount === 0 || tokenCount(m.row.input_tokens) === null || tokenCount(m.row.output_tokens) === null
    || !label(m.row.provider_id) || !label(m.row.model_id) || ['unknown', 'n/a'].includes(m.row.model_id!)
    || ['unknown', 'n/a'].includes(m.row.provider_id!))) return 'unknown_usage';
  return null;
}

function sample(members: Member[]): Sample | null {
  const e = members[0].evidence;
  let input = 0; let output = 0; let requests = 0;
  const models = new Map<string, { providerId: string; modelId: string }>();
  for (const m of members) {
    input += tokenCount(m.row.input_tokens)!; output += tokenCount(m.row.output_tokens)!; requests += m.evidence.requestCount!;
    models.set(JSON.stringify([m.row.provider_id, m.row.model_id]), { providerId: m.row.provider_id!, modelId: m.row.model_id! });
  }
  if (![input, output, requests, input + output].every(count)) return null;
  return { profile: { producerId: e.producerId, applicationId: e.applicationId, featureId: e.featureId, unit: e.unit,
    workloadId: e.workloadId, coreSha: e.coreSha, storeSha: e.storeSha,
    models: [...models.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, m]) => m) },
  tokens: input + output, output, requests };
}

function distribution(values: number[]) {
  values.sort((a, b) => a - b);
  return { p50: values[Math.ceil(values.length * 0.5) - 1], p95: values[Math.ceil(values.length * 0.95) - 1] };
}

/** Exact integer accumulation avoids overflow and input-order-dependent rounding before the final mean. */
function requestMean(samples: Sample[]): number {
  const total = samples.reduce((sum, s) => sum + BigInt(s.requests), 0n);
  const length = BigInt(samples.length);
  return Number(total / length) + Number(total % length) / samples.length;
}

function profiles(samples: Sample[]): FeatureTokenProfile[] {
  const groups = new Map<string, Sample[]>();
  for (const s of samples) { const key = JSON.stringify(s.profile); const g = groups.get(key) ?? []; g.push(s); groups.set(key, g); }
  return [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, g]) => ({
    ...g[0].profile, operations: g.length, tokensPerOperation: distribution(g.map(s => s.tokens)),
    outputTokensPerOperation: distribution(g.map(s => s.output)),
    requestsPerOperation: { ...distribution(g.map(s => s.requests)), mean: requestMean(g) },
  }));
}

/**
 * @description Reduce explicitly scoped evidence into nearest-rank token distributions over complete single-unit operations.
 * @param rows - Authorized ledger projections, including all operation members; never combined with duplicate Token Chase totals.
 * @param scope - Explicit owner and half-open UTC evidence window; this is a consistency check, not permission to read rows.
 * @returns Sample-only profiles plus exclusions; neither runtime coverage, cadence/cost nor model compatibility is inferred.
 */
export function aggregateFeatureTokenEvidence(rows: readonly FeatureTokenEvidenceRow[], scope: FeatureTokenEvidenceScope): FeatureTokenReport {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS || !record(scope) || (scope.ownerSub !== null && !label(scope.ownerSub))
    || !time(scope.from) || !time(scope.until) || scope.from >= scope.until) fail();
  const { groups, repeatedRows, unattributedRows } = collectMembers(rows, scope);
  const excludedOperations: Record<Exclusion, number> = { incomplete: 0, duplicate: 0, binding_conflict: 0, unknown_usage: 0, out_of_window: 0, overflow: 0 };
  const samples: Sample[] = [];
  for (const members of groups.values()) {
    const reason = exclusion(members, repeatedRows, Date.parse(scope.from), Date.parse(scope.until));
    if (reason) { excludedOperations[reason]++; continue; }
    const measured = sample(members);
    if (measured) samples.push(measured); else excludedOperations.overflow++;
  }
  return { version: 1, coverage: 'recorded-samples-only', window: { from: scope.from, until: scope.until },
    inputRows: rows.length, unattributedRows, excludedOperations, profiles: profiles(samples) };
}
