/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Skill-import RAG-ingest builder tests: /api/rag/ingest payload shape, skill: doc_id provenance, format-by-extension, empty docs dropped, deterministic (no Date in the slice).
 */

import { describe, expect, it } from 'vitest';
import {
  ragCollectionFor,
  formatForFile,
  buildRagIngestPayload,
  buildRagIngestPayloads,
} from '../../src/features/skill-import';

describe('ragCollectionFor', () => {
  it('derives a per-skill collection so imported skills never share a corpus', () => {
    expect(ragCollectionFor('changelog-writer')).toBe('changelog-writer-refs');
    expect(ragCollectionFor('a')).not.toBe(ragCollectionFor('b'));
  });
});

describe('formatForFile', () => {
  it('maps known extensions', () => {
    expect(formatForFile('x.md')).toBe('md');
    expect(formatForFile('x.markdown')).toBe('md');
    expect(formatForFile('x.txt')).toBe('txt');
    expect(formatForFile('x.yml')).toBe('yaml');
    expect(formatForFile('x.json')).toBe('json');
  });
  it('defaults an unknown/absent extension to md', () => {
    expect(formatForFile('README')).toBe('md');
    expect(formatForFile('x.weird')).toBe('md');
  });
});

describe('buildRagIngestPayload', () => {
  const base = { slug: 'changelog-writer', collection: 'changelog-writer-refs', fileName: 'keep.md', content: '# Keep\nbody' };

  it('produces the exact shape /api/rag/ingest requires (format + non-empty content + collection)', () => {
    const p = buildRagIngestPayload(base)!;
    expect(p.collection).toBe('changelog-writer-refs');
    expect(p.format).toBe('md');
    expect(p.content).toBe('# Keep\nbody');
    expect(p.content.trim().length).toBeGreaterThan(0); // route rejects empty
  });

  it('stamps a skill: doc_id so a citation is traceable to the imported skill', () => {
    const p = buildRagIngestPayload(base)!;
    expect(p.metadata.doc_id).toBe('skill:changelog-writer/keep.md');
    expect(p.metadata.provenance).toBe('skill-import');
    expect(p.metadata.skill).toBe('changelog-writer');
    expect(p.title).toBe('skill:changelog-writer/keep.md');
  });

  it('carries optional source/license/date provenance when supplied', () => {
    const p = buildRagIngestPayload({ ...base, sourceUrl: 'https://x.test/s', license: 'MIT', fetchedOn: '2026-07-12' })!;
    expect(p.metadata.source_url).toBe('https://x.test/s');
    expect(p.metadata.license).toBe('MIT');
    expect(p.metadata.fetched_on).toBe('2026-07-12');
  });

  it('omits provenance keys that were not supplied (no undefined leakage)', () => {
    const p = buildRagIngestPayload(base)!;
    expect(p.metadata.source_url).toBeUndefined();
    expect(p.metadata.license).toBeUndefined();
    expect(Object.values(p.metadata).every((v) => typeof v === 'string')).toBe(true);
  });

  it('returns null for empty/whitespace content (the ingest route rejects it)', () => {
    expect(buildRagIngestPayload({ ...base, content: '' })).toBeNull();
    expect(buildRagIngestPayload({ ...base, content: '   \n ' })).toBeNull();
  });

  it('is deterministic — same input, identical payload', () => {
    expect(buildRagIngestPayload(base)).toEqual(buildRagIngestPayload(base));
  });
});

describe('buildRagIngestPayloads', () => {
  it('builds one payload per non-empty doc and drops the empties', () => {
    const payloads = buildRagIngestPayloads({
      slug: 's',
      collection: 's-refs',
      docs: [
        { fileName: 'a.md', content: 'alpha' },
        { fileName: 'empty.md', content: '   ' },
        { fileName: 'b.txt', content: 'beta' },
      ],
    });
    expect(payloads).toHaveLength(2);
    expect(payloads.map((p) => p.metadata.doc_id)).toEqual(['skill:s/a.md', 'skill:s/b.txt']);
    expect(payloads[1].format).toBe('txt');
  });

  it('returns [] when the skill bundles no references', () => {
    expect(buildRagIngestPayloads({ slug: 's', collection: 's-refs', docs: [] })).toEqual([]);
  });
});
