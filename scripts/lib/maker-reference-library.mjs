/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The maker-reference library's pure half: the fixed record shape every open build is recorded in, the deterministic `web:`-prefixed doc_id derived from the source URL (so re-adding a URL UPDATES one record instead of minting a second), the licence rule that decides not-to-copy rather than trusting a caller to declare it, and the markdown body the RAG collection actually holds. Kept free of I/O beyond the record directory so the guard can drive it without a network or a store.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

/** The RAG collection the engineering bots search before answering a mechanism question. */
export const MAKER_REFERENCE_COLLECTION = 'maker-references';

/** Where the reference records live, relative to the repository root. */
export const MAKER_REFERENCE_DIR = 'ai-lab/maker-references';

/**
 * Every field a reference carries, every time. A record missing one is refused rather than
 * ingested half-formed: a catalogue whose rows disagree about what they contain cannot be
 * diffed, and "what did this build use" is the question the bots ask of it.
 */
export const REQUIRED_REFERENCE_FIELDS = Object.freeze([
  'docId',
  'title',
  'whatItIs',
  'mechanism',
  'actuators',
  'controller',
  'licence',
  'reuse',
  'sourceUrl',
  'takeaway',
  'addedOn',
]);

/** The two reuse postures. `not-to-copy` is derived from the licence, never asserted by a caller. */
export const REUSE_ALLOWED = 'allowed';
/** Recorded as a reference, cited freely, but its code and geometry are never copied into the tree. */
export const REUSE_FORBIDDEN = 'not-to-copy';

/** The licence marker used when the source states none — treated exactly like a refusal. */
export const LICENCE_UNKNOWN = 'unknown';

/**
 * Licence shapes that forbid reuse in this codebase: non-commercial and no-derivatives Creative
 * Commons variants, "all rights reserved", anything self-describing as proprietary or
 * source-available, and the unknown marker. The catalogue must never silently launder code, so
 * the default for anything unrecognised is refusal, not permission.
 */
const FORBIDDEN_LICENCE_PATTERNS = Object.freeze([
  /non[-\s]?commercial/i,
  /\bcc[\s-]?by[\s-]?nc\b/i,
  /\bcc[\s-]?by[\s-]?nd\b/i,
  /no[-\s]?deriv/i,
  /all rights reserved/i,
  /proprietary/i,
  /source[-\s]?available/i,
  /\bunknown\b/i,
  /\bunstated\b/i,
]);

/**
 * @description Decides the reuse posture from the licence text alone. Derived rather than
 * declared: a caller that could mark a CC BY-NC build "allowed" is the exact failure the
 * catalogue exists to prevent.
 * @param licence - The licence as stated by the source, or the unknown marker.
 * @returns `not-to-copy` for an unknown, non-commercial, no-derivatives or proprietary licence; `allowed` otherwise.
 */
export function reusePostureForLicence(licence) {
  const text = typeof licence === 'string' ? licence.trim() : '';
  if (text.length === 0) return REUSE_FORBIDDEN;
  return FORBIDDEN_LICENCE_PATTERNS.some((re) => re.test(text)) ? REUSE_FORBIDDEN : REUSE_ALLOWED;
}

/**
 * @description Derives the citation identifier from the source URL. Provenance is web-fetched, so
 * the id carries the `web:` prefix the citation rule requires, and it is a pure function of the
 * URL so the same build added twice lands on one record instead of two.
 * @param url - The build's source URL (http or https).
 * @returns A `web:`-prefixed doc_id, e.g. `web:github.com/simplefoc/arduino-foc`.
 * @throws When the URL is absent or is not an http(s) URL.
 */
export function deriveDocId(url) {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (raw.length === 0) throw new Error('a reference needs a source URL');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`source URL is not a URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`source URL must be http(s): ${raw}`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
  return `web:${host}${path}`;
}

/**
 * @description Turns a doc_id into the record's filename stem. One file per doc_id is what makes
 * a re-add an update: the writer opens the same path it wrote last time.
 * @param docId - A `web:`-prefixed doc_id.
 * @returns A filesystem-safe slug.
 */
export function slugForDocId(docId) {
  return String(docId)
    .replace(/^web:/, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** Coerces a scalar-or-list field into a trimmed list of strings. */
function toList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0);
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
  }
  return [];
}

/**
 * @description Fills a raw record into the canonical shape: the doc_id comes from the URL, the
 * reuse posture comes from the licence, an absent licence becomes the explicit unknown marker,
 * and `--no-copy` may only tighten the posture, never loosen it.
 * @param input - Raw record fields, as typed on the command line or read from YAML.
 * @returns The normalised record. Validation is separate — this never throws on a missing field.
 */
export function normaliseReference(input) {
  const source = input ?? {};
  const sourceUrl = typeof source.sourceUrl === 'string' ? source.sourceUrl.trim() : '';
  const licence = typeof source.licence === 'string' && source.licence.trim().length > 0
    ? source.licence.trim()
    : LICENCE_UNKNOWN;
  const derived = reusePostureForLicence(licence);
  const record = {
    docId: sourceUrl.length > 0 ? deriveDocId(sourceUrl) : '',
    title: String(source.title ?? '').trim(),
    whatItIs: String(source.whatItIs ?? '').trim(),
    mechanism: String(source.mechanism ?? '').trim(),
    actuators: toList(source.actuators),
    controller: String(source.controller ?? '').trim(),
    licence,
    reuse: derived === REUSE_ALLOWED && source.forceNoCopy === true ? REUSE_FORBIDDEN : derived,
    sourceUrl,
    takeaway: String(source.takeaway ?? '').trim(),
    addedOn: String(source.addedOn ?? '').trim(),
  };
  if (typeof source.licenceNote === 'string' && source.licenceNote.trim().length > 0) {
    record.licenceNote = source.licenceNote.trim();
  }
  return record;
}

/** Fields whose value is a non-empty string. */
const STRING_FIELDS = ['docId', 'title', 'whatItIs', 'mechanism', 'controller', 'licence', 'sourceUrl', 'takeaway'];

/**
 * @description Checks one record against the fixed shape. Returns problems rather than throwing
 * so a bulk load can report every bad record at once.
 * @param record - A normalised record.
 * @returns Human-readable problems; empty when the record is well-formed.
 */
export function validateReference(record) {
  const problems = [];
  if (record === null || typeof record !== 'object') return ['reference is not an object'];
  for (const field of STRING_FIELDS) {
    if (typeof record[field] !== 'string' || record[field].trim().length === 0) {
      problems.push(`missing required field: ${field}`);
    }
  }
  if (!Array.isArray(record.actuators) || record.actuators.length === 0) {
    problems.push('missing required field: actuators');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(record.addedOn ?? ''))) {
    problems.push('missing required field: addedOn (YYYY-MM-DD)');
  }
  if (typeof record.docId === 'string' && record.docId.length > 0 && !record.docId.startsWith('web:')) {
    problems.push(`doc_id must carry the web: provenance prefix (got '${record.docId}')`);
  }
  if (record.reuse !== REUSE_ALLOWED && record.reuse !== REUSE_FORBIDDEN) {
    problems.push(`reuse must be '${REUSE_ALLOWED}' or '${REUSE_FORBIDDEN}' (got '${String(record.reuse)}')`);
  }
  const expected = reusePostureForLicence(record.licence);
  if (expected === REUSE_FORBIDDEN && record.reuse !== REUSE_FORBIDDEN) {
    problems.push(`licence '${record.licence}' forbids reuse — reuse must be '${REUSE_FORBIDDEN}'`);
  }
  return problems;
}

/**
 * @description Renders the document the collection actually holds. The body leads with the
 * doc_id so a bot quoting a chunk carries its own provenance, and a not-to-copy build says so in
 * the first line a reader sees rather than in a metadata field nobody renders.
 * @param record - A validated record.
 * @returns Markdown body for RAG ingestion.
 */
export function renderReferenceDocument(record) {
  const banner = record.reuse === REUSE_FORBIDDEN
    ? `> **NOT TO COPY** — licence: ${record.licence}. Cite this build and reason from it; never copy its code or geometry into the tree.`
    : `> Reuse: ${REUSE_ALLOWED} under ${record.licence} — honour its terms (attribution, and any copyleft it carries).`;
  const lines = [
    `# ${record.title}`,
    '',
    `doc_id: ${record.docId}`,
    `Source: ${record.sourceUrl}`,
    `Licence: ${record.licence}`,
    `Reuse: ${record.reuse}`,
    `Added: ${record.addedOn}`,
    '',
    banner,
    '',
    `## What it is`,
    record.whatItIs,
    '',
    `## Mechanism or subsystem`,
    record.mechanism,
    '',
    `## Actuators`,
    ...record.actuators.map((a) => `- ${a}`),
    '',
    `## Controller`,
    record.controller,
    '',
    `## What a reader takes from it`,
    record.takeaway,
  ];
  if (record.licenceNote) {
    lines.push('', '## Licence note', record.licenceNote);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @description Builds the flat metadata attached to every chunk, so a search hit can be rendered
 * as a citation without re-reading the record file.
 * @param record - A validated record.
 * @returns String-valued metadata for the RAG ingest API.
 */
export function referenceMetadata(record) {
  return {
    doc_id: record.docId,
    source_url: record.sourceUrl,
    provenance: 'fetched-from-web',
    license: record.licence,
    reuse: record.reuse,
    mechanism: record.mechanism,
    controller: record.controller,
    actuators: record.actuators.join(', '),
    fetched_on: record.addedOn,
    topic: 'maker-references',
  };
}

/**
 * @description Reads every record in a directory, normalises it and reports the bad ones. A
 * record that does not validate is never returned — a half-formed row must not reach the
 * collection just because it parsed as YAML.
 * @param dir - Directory holding `<slug>.yaml` records.
 * @returns `{ records, problems }` — validated records sorted by doc_id, and per-file problems.
 */
export function loadReferenceRecords(dir) {
  const records = [];
  const problems = [];
  if (!existsSync(dir)) return { records, problems };
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort();
  for (const file of files) {
    const path = join(dir, file);
    let parsed;
    try {
      parsed = yaml.load(readFileSync(path, 'utf8'));
    } catch (err) {
      problems.push(`${file}: not parseable YAML — ${err.message}`);
      continue;
    }
    const record = normaliseReference(parsed);
    const found = validateReference(record);
    if (found.length > 0) {
      problems.push(...found.map((p) => `${file}: ${p}`));
      continue;
    }
    if (slugForDocId(record.docId) !== file.replace(/\.yaml$/, '')) {
      problems.push(`${file}: filename does not match its doc_id (expected ${slugForDocId(record.docId)}.yaml)`);
      continue;
    }
    records.push(record);
  }
  records.sort((a, b) => a.docId.localeCompare(b.docId));
  return { records, problems };
}

/**
 * @description Writes one record to its doc_id-derived path, creating or overwriting. Because the
 * path is a pure function of the URL, adding the same build twice rewrites one file — which is
 * what makes re-running the command an update instead of a duplicate.
 * @param dir - Directory holding the records.
 * @param record - A validated record.
 * @returns `{ path, created }` — the file written, and whether it did not exist before.
 */
export function writeReferenceRecord(dir, record) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slugForDocId(record.docId)}.yaml`);
  const created = !existsSync(path);
  const header = [
    '# A build in the open maker-reference library. Recorded, cited, never vendored.',
    '# Written by `node scripts/maker-reference.mjs add` — doc_id and reuse are derived, not typed.',
    '',
  ].join('\n');
  writeFileSync(path, `${header}${yaml.dump(record, { lineWidth: 100, noRefs: true })}`, 'utf8');
  return { path, created };
}
