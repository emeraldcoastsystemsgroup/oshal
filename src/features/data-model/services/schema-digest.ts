/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Schema drift as a comparable artefact: reduce an explorer snapshot to a structure-only digest (owners, RLS state, policy names, key columns, foreign-key targets - never a value, a default or a policy expression, because a digest is persisted and inherits the explorer's operator sensitivity), and diff two digests into a report that says WHY the shape moved. The classification is the anti-cry-wolf half: a first run has nothing to compare, an identical fingerprint is silence, a run that crossed a migration is explained, a baseline younger than the quiet window is still settling, and only an UNEXPLAINED, settled difference is drift. A partial catalog read is refused outright rather than reported as "every table removed".
 */

import { createHash } from 'crypto';
import type { DataModelSnapshot, ModelRelation } from '../types';

/** Digest schema version. A digest written by an older shape is never diffed against a newer one. */
export const DIGEST_VERSION = 1;

/**
 * @description How long a baseline must have stood before a difference against it is called
 * drift. A deploy rewrites the schema and then settles; comparing against a baseline captured
 * minutes ago reports the deploy itself. Fifteen minutes is longer than the migration runner
 * takes on this stack and short enough that a real change is named within the hour.
 */
export const QUIET_WINDOW_MS = 15 * 60_000;

/**
 * @description The floor under "the catalog read succeeded". A snapshot that lost most of its
 * relations is a failed read, not a dropped schema - raising on it is the cry-wolf case the
 * backlog entry names, so it is refused instead of diffed.
 */
export const PARTIAL_READ_RATIO = 0.5;

/** Error code thrown when a snapshot or digest cannot be trusted enough to compare. */
export const SCHEMA_DIGEST_INVALID = 'SCHEMA_DIGEST_INVALID';

/** Error code thrown when the current read holds far fewer relations than the baseline. */
export const SCHEMA_DIGEST_PARTIAL = 'SCHEMA_DIGEST_PARTIAL';

/**
 * @description Build the error a digest operation throws when its input cannot be compared.
 * @param code - SCHEMA_DIGEST_INVALID or SCHEMA_DIGEST_PARTIAL
 * @param message - what was wrong, named
 * @returns an Error carrying `code`
 */
export function digestError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** One relation reduced to the structure drift is judged on. Deliberately carries no data. */
export interface RelationDigest {
  relation: string;
  kind: 'table' | 'view';
  owners: string[];
  rls: 'forced' | 'enabled' | 'off' | 'n/a';
  policies: string[];
  keyColumns: string[];
  foreignKeys: string[];
}

/** A whole schema reduced to its comparable shape, plus what explains a change since last time. */
export interface SchemaDigest {
  digestVersion: number;
  capturedAt: string;
  database: string;
  /** Rows in app_migrations when the digest was taken; a change here EXPLAINS a shape change. */
  migrationCount: number | null;
  relations: RelationDigest[];
  unowned: string[];
  fingerprint: string;
}

/** How a relation's shape moved. Each kind is one line in the report and one line in the page. */
export type DriftKind =
  | 'relation-added' | 'relation-removed' | 'rls-changed' | 'policies-changed'
  | 'owners-changed' | 'keys-changed' | 'foreign-keys-changed';

/** One named difference, with the state it left and the state it reached. */
export interface DriftChange {
  kind: DriftKind;
  relation: string;
  before: string;
  after: string;
}

/**
 * How the run is classified. Only `drift` is an alarm: `first-run` has nothing to compare
 * against, `unchanged` means identical fingerprints, `explained` means the migration ledger
 * advanced, and `settling` means the baseline is still inside the quiet window.
 */
export type DriftState = 'first-run' | 'unchanged' | 'explained' | 'settling' | 'drift';

/** The comparison of one digest against its baseline. */
export interface DriftReport {
  state: DriftState;
  /** True only for `drift` - the single field an alarm producer reads. */
  alarm: boolean;
  from: string | null;
  to: string;
  /** Why the state is not `drift`, in one sentence. Empty for `drift`. */
  reason: string;
  changes: DriftChange[];
}

/**
 * @description The key columns worth remembering: the primary key plus every foreign-key column,
 * de-duplicated and sorted. Non-key columns are excluded on purpose - the digest is a persisted
 * artefact and a full column list is closer to the schema than drift detection needs.
 * @param relation - a placed relation from the snapshot
 * @returns sorted key column names
 */
function keyColumnsOf(relation: ModelRelation): string[] {
  const names = new Set<string>(relation.primaryKey ?? []);
  for (const fk of relation.foreignKeys ?? []) for (const col of fk.columns) names.add(col);
  return [...names].sort();
}

/**
 * @description Reduce one placed relation to its digest row.
 * @param relation - a table or view from the snapshot
 * @returns the digest row
 */
function digestRelation(relation: ModelRelation): RelationDigest {
  return {
    relation: `${relation.database}.${relation.name}`,
    kind: relation.kind,
    owners: [...(relation.owners ?? [])].sort(),
    rls: relation.access?.state ?? 'n/a',
    policies: (relation.policies ?? []).map((p) => p.name).sort(),
    keyColumns: keyColumnsOf(relation),
    foreignKeys: (relation.foreignKeys ?? []).map((fk) => `${fk.columns.join(',')}->${fk.refTable}`).sort(),
  };
}

/**
 * @description A stable fingerprint over the digest's rows, so "did anything move" is one string
 * comparison and a stored digest can be matched without re-diffing it.
 * @param relations - digest rows, already sorted
 * @param unowned - unowned relation names, already sorted
 * @returns a hex sha256
 */
function fingerprintOf(relations: RelationDigest[], unowned: string[]): string {
  const canonical = JSON.stringify({ v: DIGEST_VERSION, relations, unowned });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * @description Reduce an explorer snapshot to a persistable, comparable digest.
 * @param snapshot - the explorer snapshot
 * @param migrationCount - rows in app_migrations at capture time, or null when unknown
 * @returns the digest
 */
export function buildDigest(snapshot: DataModelSnapshot, migrationCount: number | null = null): SchemaDigest {
  if (!snapshot || typeof snapshot.database !== 'string' || !Array.isArray(snapshot.tables) || !Array.isArray(snapshot.views)) {
    throw digestError(SCHEMA_DIGEST_INVALID, 'The snapshot is missing database, tables[] or views[]; it cannot be digested.');
  }
  const relations = [...snapshot.tables, ...snapshot.views].map(digestRelation)
    .sort((a, b) => a.relation.localeCompare(b.relation));
  const unowned = [...(snapshot.unowned ?? [])].sort();
  return {
    digestVersion: DIGEST_VERSION,
    capturedAt: snapshot.generatedAt ?? new Date().toISOString(),
    database: snapshot.database,
    migrationCount,
    relations,
    unowned,
    fingerprint: fingerprintOf(relations, unowned),
  };
}

/**
 * @description Refuse a digest this code cannot compare, rather than reporting its every row as a
 * change. A partial or foreign-versioned digest reaching the differ is how a monitor learns to be
 * ignored.
 * @param digest - the candidate
 * @param label - which side it is, for the message
 * @returns nothing; throws SCHEMA_DIGEST_INVALID when unusable
 */
function assertUsable(digest: SchemaDigest, label: string): void {
  if (!digest || typeof digest !== 'object') throw digestError(SCHEMA_DIGEST_INVALID, `The ${label} digest is missing.`);
  if (digest.digestVersion !== DIGEST_VERSION) throw digestError(SCHEMA_DIGEST_INVALID, `The ${label} digest is version ${String(digest.digestVersion)}; this build compares version ${DIGEST_VERSION}.`);
  if (!Array.isArray(digest.relations) || typeof digest.fingerprint !== 'string' || !digest.fingerprint) {
    throw digestError(SCHEMA_DIGEST_INVALID, `The ${label} digest has no relations[] or no fingerprint.`);
  }
}

/**
 * @description Append the per-field differences for a relation present on both sides.
 * @param before - the baseline row
 * @param after - the current row
 * @param out - the change list to append to
 * @returns nothing; mutates `out`
 */
function compareRelation(before: RelationDigest, after: RelationDigest, out: DriftChange[]): void {
  const fields: Array<[DriftKind, keyof RelationDigest]> = [
    ['rls-changed', 'rls'], ['policies-changed', 'policies'], ['owners-changed', 'owners'],
    ['keys-changed', 'keyColumns'], ['foreign-keys-changed', 'foreignKeys'],
  ];
  for (const [kind, field] of fields) {
    const a = before[field];
    const b = after[field];
    const left = Array.isArray(a) ? a.join(', ') : String(a);
    const right = Array.isArray(b) ? b.join(', ') : String(b);
    if (left !== right) out.push({ kind, relation: after.relation, before: left || 'none', after: right || 'none' });
  }
}

/**
 * @description Every structural difference between two digests, relation by relation.
 * @param previous - the baseline digest
 * @param current - the digest just taken
 * @returns the changes, ordered by relation then kind
 */
export function digestChanges(previous: SchemaDigest, current: SchemaDigest): DriftChange[] {
  const before = new Map(previous.relations.map((r) => [r.relation, r]));
  const after = new Map(current.relations.map((r) => [r.relation, r]));
  const changes: DriftChange[] = [];
  for (const [name, row] of after) {
    const old = before.get(name);
    if (!old) changes.push({ kind: 'relation-added', relation: name, before: 'absent', after: `${row.kind}, rls ${row.rls}` });
    else compareRelation(old, row, changes);
  }
  for (const [name, row] of before) {
    if (!after.has(name)) changes.push({ kind: 'relation-removed', relation: name, before: `${row.kind}, rls ${row.rls}`, after: 'absent' });
  }
  return changes.sort((a, b) => a.relation.localeCompare(b.relation) || a.kind.localeCompare(b.kind));
}

/**
 * @description Decide why the shape moved, so a normal change stays quiet and only an unexplained,
 * settled one alarms.
 * @param previous - the baseline digest
 * @param current - the digest just taken
 * @param nowMs - clock, for the quiet window
 * @param quietWindowMs - how long a baseline must stand before it can be drifted against
 * @returns the state and the sentence explaining it
 */
function classify(previous: SchemaDigest, current: SchemaDigest, nowMs: number, quietWindowMs: number): { state: DriftState; reason: string } {
  if (previous.migrationCount !== null && current.migrationCount !== null && current.migrationCount !== previous.migrationCount) {
    return { state: 'explained', reason: `The migration ledger moved from ${previous.migrationCount} to ${current.migrationCount} applied files between the two readings, so this change was migrated, not unexplained.` };
  }
  const baselineAge = nowMs - Date.parse(previous.capturedAt);
  if (Number.isFinite(baselineAge) && baselineAge < quietWindowMs) {
    return { state: 'settling', reason: `The baseline is ${Math.max(0, Math.round(baselineAge / 60_000))} minutes old, inside the ${Math.round(quietWindowMs / 60_000)}-minute quiet window; the shape is still moving, so this reading waits for it to hold.` };
  }
  return { state: 'drift', reason: '' };
}

/**
 * @description Compare a digest against its baseline and classify the result. This is the whole
 * alarm decision: `alarm` is true only for an unexplained difference against a settled baseline.
 * @param previous - the stored baseline, or null on a first run
 * @param current - the digest just taken
 * @param opts - clock and quiet window (tests inject both)
 * @returns the drift report
 */
export function diffDigests(
  previous: SchemaDigest | null,
  current: SchemaDigest,
  opts: { nowMs?: number; quietWindowMs?: number } = {},
): DriftReport {
  assertUsable(current, 'current');
  const to = current.capturedAt;
  if (!previous) {
    return { state: 'first-run', alarm: false, from: null, to, reason: 'No digest has been recorded for this database yet; this reading becomes the baseline.', changes: [] };
  }
  assertUsable(previous, 'baseline');
  if (previous.relations.length > 0 && current.relations.length < previous.relations.length * PARTIAL_READ_RATIO) {
    throw digestError(SCHEMA_DIGEST_PARTIAL, `The current reading holds ${current.relations.length} relations against a baseline of ${previous.relations.length}; that is a failed catalog read, not a dropped schema.`);
  }
  if (previous.fingerprint === current.fingerprint) {
    return { state: 'unchanged', alarm: false, from: previous.capturedAt, to, reason: 'The schema fingerprint is identical to the baseline.', changes: [] };
  }
  const changes = digestChanges(previous, current);
  const { state, reason } = classify(previous, current, opts.nowMs ?? Date.now(), opts.quietWindowMs ?? QUIET_WINDOW_MS);
  return { state, alarm: state === 'drift', from: previous.capturedAt, to, reason, changes };
}
