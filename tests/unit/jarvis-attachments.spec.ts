/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for buildAttachmentEnrichment — the pure folder of attached media (image descriptions + doc text) into the authoritative-context prompt block + history note: happy paths, counts/turnNote, doc truncation, malformed/empty dropping, the MAX_ATTACHMENTS cap, and filename sanitization.
 */

import { describe, expect, it } from 'vitest';
import { buildAttachmentEnrichment } from '@/app/routes/jarvis-attachments';

describe('buildAttachmentEnrichment', () => {
  it('returns an empty, no-op result for undefined / non-array / empty input', () => {
    for (const raw of [undefined, null, {}, 'x', []]) {
      const r = buildAttachmentEnrichment(raw as unknown);
      expect(r.hasAny).toBe(false);
      expect(r.promptBlock).toBe('');
      expect(r.imageCount).toBe(0);
      expect(r.docCount).toBe(0);
      expect(r.turnNote).toBe('');
    }
  });

  it('folds one image description into an authoritative-context block', () => {
    const r = buildAttachmentEnrichment([{ kind: 'image', name: 'beach.jpg', description: 'A sunny beach with two chairs.' }]);
    expect(r.hasAny).toBe(true);
    expect(r.imageCount).toBe(1);
    expect(r.docCount).toBe(0);
    expect(r.promptBlock).toContain('[Image 1 — beach.jpg]');
    expect(r.promptBlock).toContain('A sunny beach with two chairs.');
    expect(r.promptBlock).toContain('authoritative');
    expect(r.promptBlock.trimEnd().endsWith('---')).toBe(true);
    expect(r.turnNote).toBe(' 📎 1 photo');
  });

  it('folds one document with its verbatim text', () => {
    const r = buildAttachmentEnrichment([{ kind: 'doc', name: 'notes.txt', text: 'line one\nline two' }]);
    expect(r.docCount).toBe(1);
    expect(r.imageCount).toBe(0);
    expect(r.promptBlock).toContain('[Document 1 — notes.txt]');
    expect(r.promptBlock).toContain('line one');
    expect(r.turnNote).toBe(' 📎 1 document');
  });

  it('counts images + docs together and pluralizes the note', () => {
    const r = buildAttachmentEnrichment([
      { kind: 'image', description: 'a' },
      { kind: 'image', description: 'b' },
      { kind: 'doc', name: 'd1', text: 'x' },
    ]);
    expect(r.imageCount).toBe(2);
    expect(r.docCount).toBe(1);
    expect(r.turnNote).toBe(' 📎 2 photos, 1 document');
    expect(r.promptBlock).toContain('[Image 1');
    expect(r.promptBlock).toContain('[Image 2');
    expect(r.promptBlock).toContain('[Document 1');
  });

  it('truncates oversized document text and marks it', () => {
    const big = 'z'.repeat(20000);
    const r = buildAttachmentEnrichment([{ kind: 'doc', name: 'big.txt', text: big }]);
    expect(r.promptBlock).toContain('…(truncated)');
    // The doc body must be bounded (12000 cap) — far below the raw 20000.
    expect(r.promptBlock.length).toBeLessThan(13000);
  });

  it('drops malformed / empty entries and keeps the good ones', () => {
    const r = buildAttachmentEnrichment([
      { kind: 'image' },                       // no description → dropped
      { kind: 'doc', text: '   ' },            // blank text → dropped
      { kind: 'bogus', description: 'x' },     // bad kind → dropped
      42,                                      // not an object → dropped
      { kind: 'image', description: 'kept' },  // valid
    ] as unknown);
    expect(r.imageCount).toBe(1);
    expect(r.docCount).toBe(0);
    expect(r.promptBlock).toContain('kept');
  });

  it('caps the number of attachments folded in', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ kind: 'doc', name: `d${i}`, text: `t${i}` }));
    const r = buildAttachmentEnrichment(many);
    expect(r.docCount).toBeLessThanOrEqual(6);
  });

  it('sanitizes raw tab / CR out of the filename header', () => {
    const r = buildAttachmentEnrichment([{ kind: 'image', name: 'a\nb\tname', description: 'x' }]);
    // Line-splitting already proves no \n survived; assert the tab/CR are gone too.
    const headerLine = r.promptBlock.split('\n').find((l) => l.startsWith('[Image 1'))!;
    expect(headerLine).not.toMatch(/[\r\t]/);
    expect(headerLine).toContain('a b name');
  });
});
