/**
 * Document text extraction — turns a PDF / Word (.docx) / plain-text binary into bounded
 * plain text so a text-only reasoning brain can answer questions about an attached file.
 * This closes the ADR-110 follow-up: slice 1 read only text files client-side; binaries
 * (PDF/Office) had no extractor anywhere in the repo.
 *
 * Design rules:
 *  - NEVER throws to the caller — every failure returns a structured `{ ok: false, reason }`
 *    so the surface can degrade honestly ("couldn't read <file>") instead of silently
 *    dropping the attachment.
 *  - Extractors are injectable (deps param) so unit guards exercise the failure contract
 *    without live parser/binary fixtures.
 *  - Output is hard-capped: one attachment can't flood a prompt.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — extractDocText(): format sniffing (magic bytes > extension > mime), PDF via the already-shipped pdf-parse dependency (lib entry, bypassing its debug-mode index), DOCX via the already-shipped yauzl (word/document.xml → text, no new dependency), UTF-8 fallback for text formats, bounded output, structured never-throw failures.
 *
 * @module doc-extract-service
 */

import * as yauzl from 'yauzl';
// The package's index.js runs debug code when it believes it is the entry module; the lib
// entry is the parser itself and is the documented way to consume it programmatically.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'doc-extract-service' });

/** Hard cap on extracted text returned to callers (the prompt assembler clips further). */
const MAX_TEXT_CHARS = 20000;
/** Hard cap on input size — mirrors the vision route's body ceiling. */
const MAX_INPUT_BYTES = 10 * 1024 * 1024;

/** The document formats the extractor understands. */
export type DocFormat = 'pdf' | 'docx' | 'text';

/** Input to an extraction: the raw bytes plus the hints the browser sent. */
export interface DocExtractInput {
  /** Original filename (extension is a format hint). */
  name?: string;
  /** Raw file bytes. */
  buffer: Buffer;
  /** MIME type as reported by the uploader (a hint, never trusted alone). */
  mime?: string;
}

/** Successful extraction: bounded plain text plus what it was parsed as. */
export interface DocExtractSuccess {
  ok: true;
  format: DocFormat;
  text: string;
  truncated: boolean;
}

/** Failed extraction: the caller renders this honestly, never silently drops it. */
export interface DocExtractFailure {
  ok: false;
  format: DocFormat;
  reason: string;
}

/** Union result — check `ok`. */
export type DocExtractResult = DocExtractSuccess | DocExtractFailure;

/** Injectable extractor internals (stubbed in unit guards — no binary fixtures needed). */
export interface DocExtractDeps {
  /** buffer → the PDF's text (throws on a corrupt/unparseable file). */
  pdf: (buffer: Buffer) => Promise<string>;
  /** buffer → the DOCX main document XML (throws when not a readable docx zip). */
  docxXml: (buffer: Buffer) => Promise<string>;
}

/**
 * @description Sniff the document format: magic bytes first (a .docx renamed .pdf must not
 * hit the PDF parser), then filename extension, then MIME. Anything unrecognized is treated
 * as text — the UTF-8 fallback either yields readable text or an honest failure.
 * @param input - Bytes + name/mime hints.
 * @returns The format the extractor will attempt.
 */
export function detectDocFormat(input: DocExtractInput): DocFormat {
  const buf = input.buffer;
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  const isZip = buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  const name = (input.name || '').toLowerCase();
  const mime = (input.mime || '').toLowerCase();
  if (isZip && (name.endsWith('.docx') || mime.includes('wordprocessingml'))) return 'docx';
  if (name.endsWith('.pdf') || mime === 'application/pdf') return 'pdf';
  if (name.endsWith('.docx') || mime.includes('wordprocessingml')) return 'docx';
  return 'text';
}

/**
 * @description Extract bounded plain text from a document buffer. Never throws: corrupt,
 * oversized, empty or password-protected files come back as `{ ok: false, reason }` so the
 * surface can tell the user the file couldn't be read (honest degrade, ADR-110 follow-up).
 * @param input - Bytes + name/mime hints.
 * @param deps - Extractor internals (defaulted; injectable for unit guards).
 * @returns Structured success (text + truncation flag) or failure (reason).
 */
export async function extractDocText(
  input: DocExtractInput,
  deps: DocExtractDeps = defaultDeps,
): Promise<DocExtractResult> {
  const format = detectDocFormat(input);
  if (!Buffer.isBuffer(input.buffer) || input.buffer.length === 0) {
    return { ok: false, format, reason: 'the file is empty' };
  }
  if (input.buffer.length > MAX_INPUT_BYTES) {
    return { ok: false, format, reason: 'the file exceeds the 10MB extraction limit' };
  }
  try {
    const raw = format === 'pdf' ? await deps.pdf(input.buffer)
      : format === 'docx' ? docxXmlToText(await deps.docxXml(input.buffer))
      : decodeUtf8Text(input.buffer);
    const text = raw.replace(/\u0000/g, '').trim();
    if (!text) return { ok: false, format, reason: 'no readable text found in the file (it may be scanned images or empty)' };
    const truncated = text.length > MAX_TEXT_CHARS;
    return { ok: true, format, text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text, truncated };
  } catch (err) {
    const reason = (err as Error)?.message || 'unreadable file';
    logger.warn({ err, name: input.name, format }, 'document extraction failed — returning honest failure');
    return { ok: false, format, reason: boundReason(reason) };
  }
}

/** Default production extractors (pdf-parse + yauzl — both already shipped dependencies). */
const defaultDeps: DocExtractDeps = {
  pdf: async (buffer: Buffer) => {
    const parsed = await pdfParse(buffer);
    return String(parsed?.text || '');
  },
  docxXml: (buffer: Buffer) => readDocxDocumentXml(buffer),
};

/**
 * @description Convert WordprocessingML (word/document.xml) into plain text: paragraphs and
 * line breaks become newlines, tabs become tabs, tags are stripped, entities decoded.
 * Exported for direct unit coverage — it is pure string work.
 * @param xml - The main document part XML.
 * @returns Plain text (unbounded — the caller caps).
 */
export function docxXmlToText(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\b[^>]*\/?>/g, '\t')
      .replace(/<w:(?:br|cr)\b[^>]*\/?>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  ).replace(/\n{3,}/g, '\n\n');
}

/** Read word/document.xml out of a .docx zip buffer via yauzl (streamed, bounded). */
function readDocxDocumentXml(buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) { reject(err || new Error('not a readable .docx (zip) file')); return; }
      let found = false;
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== 'word/document.xml') { zip.readEntry(); return; }
        found = true;
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) { reject(streamErr || new Error('could not read word/document.xml')); return; }
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('error', reject);
          stream.on('end', () => { zip.close(); resolve(Buffer.concat(chunks).toString('utf-8')); });
        });
      });
      zip.on('end', () => { if (!found) reject(new Error('no word/document.xml inside — not a Word .docx file')); });
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

/** UTF-8 text fallback; rejects content that decodes to mostly replacement/control garbage. */
function decodeUtf8Text(buffer: Buffer): string {
  const text = buffer.toString('utf-8');
  const sample = text.slice(0, 2000);
  const garbage = (sample.match(/[\uFFFD\u0000-\u0008]/g) || []).length;
  if (sample.length > 0 && garbage / sample.length > 0.1) {
    throw new Error('binary content is not readable as text');
  }
  return text;
}

/** Decode the XML entities WordprocessingML actually emits. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Keep provider/parser error text short + single-line for prompt/UI use. */
function boundReason(reason: string): string {
  return reason.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200) || 'unreadable file';
}
