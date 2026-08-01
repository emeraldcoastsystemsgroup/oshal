/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the Jarvis media-input extensions (ADR-110 follow-ups). extraction-failure-degrades-honestly: extractDocText NEVER throws (structured { ok:false, reason }) and an unreadable doc attachment produces a NAMED "couldn't read" section in the prompt assembly — silent drops go red. image-descriptions-present-in-assembly: two image attachments yield two labeled sections carrying their own descriptions, and parseImageSections splits a marker-delimited multi-image describe (fail-open on marker miscount). Extractors are stubbed via the deps param — no live parser/binary/network calls.
 */
import { describe, expect, it, vi } from 'vitest';
import { docxXmlToText, detectDocFormat, extractDocText, type DocExtractDeps } from '@/features/doc-extract';
import { parseImageSections } from '@/features/vision-describe';
import { buildAttachmentEnrichment } from '@/app/routes/jarvis-attachments';

/** Stubbed extractor internals — the guards exercise contracts, not parsers. */
function deps(overrides: Partial<DocExtractDeps> = {}): DocExtractDeps {
  return {
    pdf: async () => 'pdf text',
    docxXml: async () => '<w:document><w:p><w:r><w:t>docx text</w:t></w:r></w:p></w:document>',
    ...overrides,
  };
}

describe('extraction-failure-degrades-honestly', () => {
  it('a throwing PDF parser becomes { ok:false, reason } — never a thrown error', async () => {
    const pdf = vi.fn(async () => { throw new Error('bad XRef entry'); });
    const result = await extractDocText({ name: 'report.pdf', buffer: Buffer.from('%PDF-1.4 garbage') }, deps({ pdf }));
    expect(pdf).toHaveBeenCalledTimes(1); // the real extractor path ran (not a bypass)
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.format).toBe('pdf');
      expect(result.reason).toMatch(/bad XRef entry/);
    }
  });

  it('a parser that yields no text is an honest failure, not an empty success', async () => {
    const result = await extractDocText({ name: 'scan.pdf', buffer: Buffer.from('%PDF-1.4') }, deps({ pdf: async () => '   ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no readable text/i);
  });

  it('an unreadable doc attachment produces a NAMED "couldn\'t read" section in the prompt', () => {
    const enrichment = buildAttachmentEnrichment([
      { kind: 'doc', name: 'q3-report.pdf', unreadable: true, reason: 'the file is password-protected' },
    ]);
    // The silent-drop regression this guard exists for: hasAny false / empty block.
    expect(enrichment.hasAny).toBe(true);
    expect(enrichment.docCount).toBe(1);
    expect(enrichment.promptBlock).toContain('q3-report.pdf');
    expect(enrichment.promptBlock).toMatch(/couldn't read this file/);
    expect(enrichment.promptBlock).toContain('the file is password-protected');
    expect(enrichment.turnNote).toContain('1 document');
  });

  it('a readable doc still lands verbatim (the failure path did not eat the success path)', () => {
    const enrichment = buildAttachmentEnrichment([
      { kind: 'doc', name: 'notes.txt', text: 'quarterly revenue was up' },
    ]);
    expect(enrichment.promptBlock).toContain('quarterly revenue was up');
    expect(enrichment.promptBlock).not.toMatch(/couldn't read/);
  });
});

describe('image-descriptions-present-in-assembly', () => {
  it('two image attachments produce two labeled sections, each carrying its own description', () => {
    const enrichment = buildAttachmentEnrichment([
      { kind: 'image', name: 'porch.jpg', description: 'a wooden porch with two chairs' },
      { kind: 'image', name: 'garden.jpg', description: 'a raised garden bed with tomatoes' },
    ]);
    expect(enrichment.imageCount).toBe(2);
    expect(enrichment.promptBlock).toContain('[Image 1 — porch.jpg]');
    expect(enrichment.promptBlock).toContain('a wooden porch with two chairs');
    expect(enrichment.promptBlock).toContain('[Image 2 — garden.jpg]');
    expect(enrichment.promptBlock).toContain('a raised garden bed with tomatoes');
    // Ordering matters — "the first photo" must be the first section.
    expect(enrichment.promptBlock.indexOf('porch.jpg')).toBeLessThan(enrichment.promptBlock.indexOf('garden.jpg'));
  });

  it('parseImageSections splits a marker-delimited two-image response in order', () => {
    const text = 'Overall intro.\n=== IMAGE 1 ===\nA porch.\n=== IMAGE 2 ===\nA garden.';
    expect(parseImageSections(text, 2)).toEqual(['A porch.', 'A garden.']);
  });

  it('parseImageSections is fail-open: miscounted or missing markers yield undefined', () => {
    expect(parseImageSections('no markers at all', 2)).toBeUndefined();
    expect(parseImageSections('=== IMAGE 1 ===\nonly one', 2)).toBeUndefined();
    expect(parseImageSections('=== IMAGE 2 ===\nwrong start\n=== IMAGE 1 ===\nswapped', 2)).toBeUndefined();
    expect(parseImageSections('=== IMAGE 1 ===\nsingle image never sections', 1)).toBeUndefined();
  });
});

describe('doc-extract format handling', () => {
  it('detects format by magic bytes over extension', () => {
    expect(detectDocFormat({ name: 'renamed.txt', buffer: Buffer.from('%PDF-1.7 rest') })).toBe('pdf');
    expect(detectDocFormat({ name: 'letter.docx', buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]) })).toBe('docx');
    expect(detectDocFormat({ name: 'plain.txt', buffer: Buffer.from('hello') })).toBe('text');
  });

  it('converts WordprocessingML to plain text (paragraphs, tabs, entities)', () => {
    const xml = '<w:p><w:r><w:t>Budget &amp; plan</w:t><w:tab/><w:t>Q3</w:t></w:r></w:p><w:p><w:r><w:t>Next line</w:t></w:r></w:p>';
    expect(docxXmlToText(xml)).toBe('Budget & plan\tQ3\nNext line\n');
  });

  it('caps extracted text and reports truncation', async () => {
    const big = 'x'.repeat(25000);
    const result = await extractDocText({ name: 'big.pdf', buffer: Buffer.from('%PDF-1.4') }, deps({ pdf: async () => big }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text.length).toBe(20000);
      expect(result.truncated).toBe(true);
    }
  });
});
