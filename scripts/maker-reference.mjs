#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | One command for the open maker-reference library: `add` records a build from its URL plus a note (doc_id and reuse posture derived, never typed), `list` and `render` read the catalogue back, and `ingest` rebuilds the `maker-references` RAG collection from it. Rebuild-then-ingest is what makes a re-run an update: the generic ingest API mints timestamped chunk ids, so adding the same document twice would otherwise leave two copies and the bots would cite a stale one.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  MAKER_REFERENCE_COLLECTION,
  MAKER_REFERENCE_DIR,
  deriveDocId,
  loadReferenceRecords,
  normaliseReference,
  referenceMetadata,
  renderReferenceDocument,
  validateReference,
  writeReferenceRecord,
} from './lib/maker-reference-library.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Flag names accepted by `add`, mapped onto record fields. */
const ADD_FLAGS = Object.freeze({
  note: 'takeaway',
  title: 'title',
  what: 'whatItIs',
  mechanism: 'mechanism',
  actuators: 'actuators',
  controller: 'controller',
  licence: 'licence',
  license: 'licence',
  'licence-note': 'licenceNote',
  added: 'addedOn',
});

/**
 * @description Parses `--flag value` pairs and bare positionals. Unknown flags are an error, not
 * a silent no-op: a typo'd `--mechanism` would otherwise write a record missing a required field.
 * @param argv - Arguments after the sub-command.
 * @returns `{ positionals, flags }`.
 */
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const name = arg.slice(2);
    if (name === 'no-copy' || name === 'ingest' || name === 'dry-run') { flags[name] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    flags[name] = value;
    i++;
  }
  return { positionals, flags };
}

/** Where the records live for this invocation (overridable so a guard can drive a temp dir). */
function recordDir() {
  return process.env.MAKER_REFERENCE_DIR
    ? resolve(process.env.MAKER_REFERENCE_DIR)
    : resolve(REPO_ROOT, MAKER_REFERENCE_DIR);
}

/**
 * @description Records one build. The URL is the identity, so re-running against the same URL
 * rewrites the same file; everything the catalogue promises to hold must be supplied, and a
 * record missing any of it is refused rather than written half-formed.
 * @param argv - Arguments after `add`.
 * @returns Process exit code.
 */
function commandAdd(argv) {
  const { positionals, flags } = parseArgs(argv);
  const url = positionals[0];
  if (!url) { console.error('usage: maker-reference.mjs add <url> --note "<takeaway>" [--title ...]'); return 2; }
  const input = { sourceUrl: url, forceNoCopy: flags['no-copy'] === true, addedOn: new Date().toISOString().slice(0, 10) };
  for (const [flag, field] of Object.entries(ADD_FLAGS)) {
    if (flags[flag] !== undefined) input[field] = flags[flag];
  }
  const record = normaliseReference(input);
  const problems = validateReference(record);
  if (problems.length > 0) {
    console.error(`refused — the catalogue holds the same fields for every build:\n  ${problems.join('\n  ')}`);
    return 1;
  }
  const { path, created } = writeReferenceRecord(recordDir(), record);
  console.log(`${created ? 'added' : 'updated'} ${record.docId}`);
  console.log(`  ${path}`);
  console.log(`  reuse: ${record.reuse} (licence: ${record.licence})`);
  return 0;
}

/**
 * @description Prints the catalogue, one line per build, with the reuse posture visible.
 * @param argv - Arguments after `list` (unused).
 * @returns Process exit code — non-zero when any record is malformed.
 */
function commandList(argv) {
  const { records, problems } = loadReferenceRecords(recordDir());
  for (const record of records) {
    console.log(`${record.reuse === 'not-to-copy' ? '[no-copy]' : '[  ok   ]'} ${record.docId}`);
    console.log(`           ${record.title} — ${record.mechanism}`);
  }
  console.log(`${records.length} reference(s) in ${MAKER_REFERENCE_COLLECTION}`);
  if (problems.length > 0) { console.error(`problems:\n  ${problems.join('\n  ')}`); return 1; }
  return 0;
}

/**
 * @description Prints one reference's document body exactly as the collection holds it.
 * @param argv - Arguments after `render`; the first is a doc_id or URL.
 * @returns Process exit code.
 */
function commandRender(argv) {
  const { positionals } = parseArgs(argv);
  const wanted = positionals[0];
  if (!wanted) { console.error('usage: maker-reference.mjs render <doc_id|url>'); return 2; }
  const docId = wanted.startsWith('web:') ? wanted : deriveDocId(wanted);
  const { records } = loadReferenceRecords(recordDir());
  const record = records.find((r) => r.docId === docId);
  if (!record) { console.error(`no reference with doc_id ${docId}`); return 1; }
  process.stdout.write(renderReferenceDocument(record));
  return 0;
}

/** The API this command talks to, and the credential it carries if the operator supplied one. */
function apiTarget() {
  const base = (process.env.OSHAL_API || 'http://127.0.0.1:35457').replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.OSHAL_API_COOKIE) headers.Cookie = process.env.OSHAL_API_COOKIE;
  if (process.env.OSHAL_API_TOKEN) headers.Authorization = `Bearer ${process.env.OSHAL_API_TOKEN}`;
  return { base, headers };
}

/**
 * @description Rebuilds the collection from the catalogue: drop it, then ingest one document per
 * record. Dropping first is deliberate — the generic ingest API mints a timestamped chunk id per
 * chunk, so a second ingest of the same build would sit beside the first and a bot could cite
 * either. Rebuilding makes the collection a pure function of the records on disk.
 * @param argv - Arguments after `ingest`.
 * @returns Process exit code.
 */
async function commandIngest(argv) {
  const { flags } = parseArgs(argv);
  const { records, problems } = loadReferenceRecords(recordDir());
  if (problems.length > 0) { console.error(`refusing to ingest a malformed catalogue:\n  ${problems.join('\n  ')}`); return 1; }
  if (records.length === 0) { console.error(`no references in ${recordDir()}`); return 1; }
  if (flags['dry-run'] === true) {
    for (const record of records) console.log(`would ingest ${record.docId} (${renderReferenceDocument(record).length} chars)`);
    return 0;
  }
  const { base, headers } = apiTarget();
  const dropped = await fetch(`${base}/api/rag/collections/${MAKER_REFERENCE_COLLECTION}`, { method: 'DELETE', headers });
  if (!dropped.ok && dropped.status !== 404) {
    console.error(`could not drop ${MAKER_REFERENCE_COLLECTION}: HTTP ${dropped.status} ${await dropped.text()}`);
    return 1;
  }
  let ingested = 0;
  for (const record of records) {
    const res = await fetch(`${base}/api/rag/ingest`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        collection: MAKER_REFERENCE_COLLECTION,
        format: 'md',
        title: record.title,
        content: renderReferenceDocument(record),
        metadata: referenceMetadata(record),
      }),
    });
    if (!res.ok) { console.error(`  ${record.docId}: HTTP ${res.status} ${await res.text()}`); return 1; }
    console.log(`  ingested ${record.docId}`);
    ingested++;
  }
  console.log(`${MAKER_REFERENCE_COLLECTION}: ${ingested} document(s) — one per build, rebuilt from ${recordDir()}`);
  return 0;
}

/** Sub-command table. */
const COMMANDS = { add: commandAdd, list: commandList, render: commandRender, ingest: commandIngest };

/**
 * @description Entry point — dispatches the sub-command and returns its exit code.
 * @param argv - `process.argv.slice(2)`.
 * @returns Process exit code.
 */
export async function main(argv) {
  const command = COMMANDS[argv[0]];
  if (!command) {
    console.error('usage: maker-reference.mjs <add|list|render|ingest> [...]');
    console.error('  add <url> --note "<takeaway>" --title <t> --what <w> --mechanism <m> --actuators <a> --controller <c> --licence <l> [--no-copy]');
    console.error('  ingest [--dry-run]     rebuild the maker-references RAG collection from the catalogue');
    return 2;
  }
  return await command(argv.slice(1));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
