/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pure builders for ingesting a skill's bundled references/ into a RAG collection — the ADR-089 follow-up. Payloads only; the HTTP POST lives in the CLI.
 */

import type { RagIngestPayload } from '../types';

/** Extension → the `format` the /api/rag/ingest route records. Unknown extensions ingest as markdown. */
const FORMAT_BY_EXT: Record<string, string> = {
  md: 'md',
  markdown: 'md',
  txt: 'txt',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
};

/**
 * @description The RAG collection an imported skill's references land in. Derived from the slug so
 * two imported skills never share a corpus (and a re-import is idempotent into the same collection).
 * @param slug - the imported skill's slug
 * @returns the collection name, e.g. `changelog-writer-refs`
 */
export function ragCollectionFor(slug: string): string {
  return `${slug}-refs`;
}

/**
 * @description Resolves the ingest `format` from a reference filename's extension.
 * @param fileName - the reference file name (e.g. `keep-a-changelog.md`)
 * @returns the format string the ingest route records (defaults to 'md')
 */
export function formatForFile(fileName: string): string {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  return FORMAT_BY_EXT[ext] ?? 'md';
}

/**
 * @description Builds one `/api/rag/ingest` payload for a bundled reference doc, stamping provenance
 * so a citation is traceable back to the skill it came from. The `doc_id` uses a `skill:` prefix —
 * the same provenance discipline CLAUDE.md applies to `web:`-prefixed fetched content — so corpus
 * citations make clear the text came from an imported third-party skill, not a curated runbook.
 * Returns null for empty content (the ingest route rejects it), so callers can simply filter.
 * @param input - slug, collection, file name + content, plus optional skill provenance and a caller-supplied date
 * @returns the ingest payload, or null when the doc has no content
 */
export function buildRagIngestPayload(input: {
  slug: string;
  collection: string;
  fileName: string;
  content: string;
  sourceUrl?: string;
  license?: string;
  /** Caller-supplied (keeps this pure/deterministic — no Date.now() in the slice). */
  fetchedOn?: string;
}): RagIngestPayload | null {
  if (!input.content || !input.content.trim()) return null;

  const docId = `skill:${input.slug}/${input.fileName}`;
  const metadata: Record<string, string> = {
    doc_id: docId,
    provenance: 'skill-import',
    skill: input.slug,
    source: 'skill-import',
  };
  if (input.sourceUrl) metadata.source_url = input.sourceUrl;
  if (input.license) metadata.license = input.license;
  if (input.fetchedOn) metadata.fetched_on = input.fetchedOn;

  return {
    collection: input.collection,
    format: formatForFile(input.fileName),
    title: docId,
    content: input.content,
    metadata,
  };
}

/**
 * @description Builds the ingest payloads for a skill's whole `references/` set, dropping empty docs.
 * @param input - slug + collection + the reference docs (file name + content), plus optional provenance
 * @returns one payload per non-empty reference doc
 */
export function buildRagIngestPayloads(input: {
  slug: string;
  collection: string;
  docs: Array<{ fileName: string; content: string }>;
  sourceUrl?: string;
  license?: string;
  fetchedOn?: string;
}): RagIngestPayload[] {
  return input.docs
    .map((d) => buildRagIngestPayload({ ...input, fileName: d.fileName, content: d.content }))
    .filter((p): p is RagIngestPayload => p !== null);
}
