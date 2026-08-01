/**
 * Jarvis attachment enrichment — turns the media a user attaches to a Jarvis prompt into a
 * text block the Codex-CLI Jarvis brain can reason over.
 *
 * By the time an attachment reaches POST /api/jarvis/ask it is ALREADY text:
 *   - image → a factual description produced by /api/vision/describe (the visual analog of the
 *     voice transcript: the browser describes the photo first, exactly as it transcribes speech
 *     before sending), so the size-capped /ask body never carries base64 pixels.
 *   - doc   → the file's extracted text (text-based files read client-side; PDF/Word binaries
 *     extracted server-side via POST /api/vision/read-doc — an extraction FAILURE arrives as an
 *     `unreadable` attachment and is rendered honestly below, never silently dropped).
 *
 * This module only assembles + bounds that text; it makes no network/LLM/DB calls. Keeping it a
 * pure function keeps the /ask handler small and keeps the heavy logic out of the near-cap route file.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — buildAttachmentEnrichment(): bounds + formats attached image descriptions and doc text into an authoritative-context block prepended to the Jarvis bot prompt, plus a short note for the persisted user turn so history/replay shows the attachment happened.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Honest extraction failures (ADR-110 follow-up / G-series honesty rule): a doc attachment marked `unreadable` (server-side PDF/DOCX extraction failed) now produces a named "couldn't read this file" section in the prompt block instead of being silently dropped — Jarvis tells the user the file was received but unreadable rather than answering as if it never existed. Unreadable docs count toward hasAny/turnNote.
 *
 * @module jarvis-attachments
 */

/** One attachment as it arrives in the /ask body — already reduced to text upstream. */
export interface JarvisAttachment {
  kind: 'image' | 'doc';
  /** Original filename (or a friendly label), shown in the context block header. */
  name?: string;
  /** Image only: the /api/vision/describe output. */
  description?: string;
  /** Doc only: the file's extracted text. */
  text?: string;
  /** Doc only: extraction failed server-side — render an honest "couldn't read" section. */
  unreadable?: boolean;
  /** Doc only: short human reason why extraction failed (bounded upstream). */
  reason?: string;
}

/** The result of folding attachments into prompt + history material. */
export interface AttachmentEnrichment {
  /** Authoritative-context block to prepend to the bot prompt; '' when nothing usable. */
  promptBlock: string;
  /** Usable image attachments after validation. */
  imageCount: number;
  /** Usable doc attachments after validation. */
  docCount: number;
  /** True when at least one image or doc survived — the /ask flow skips its deterministic
   *  provider/recall guards in this case and goes straight to an enriched Jarvis turn. */
  hasAny: boolean;
  /** Short suffix appended to the persisted user turn (e.g. " 📎 1 photo, 1 document"). */
  turnNote: string;
}

/** Bounds so one turn can't flood the prompt (and stays well under the /ask body cap). */
const MAX_ATTACHMENTS = 6;
const MAX_DOC_CHARS = 12000;
const MAX_IMAGE_DESC_CHARS = 6000;

/**
 * @description Fold a raw `attachments` array into a bounded, authoritative-context prompt block
 * plus a short history note. Silently drops malformed/empty entries; never throws.
 * @param raw - The `attachments` value from the /ask body (untrusted).
 * @returns The prompt block, per-kind counts, a hasAny flag, and the persisted-turn note.
 */
export function buildAttachmentEnrichment(raw: unknown): AttachmentEnrichment {
  const list = normalize(raw);
  const imageParts: string[] = [];
  const docParts: string[] = [];

  for (const att of list) {
    if (att.kind === 'image') {
      const desc = clip(att.description, MAX_IMAGE_DESC_CHARS);
      if (desc) imageParts.push(section(`Image ${imageParts.length + 1}`, att.name, desc));
    } else if (att.kind === 'doc') {
      if (att.unreadable) {
        // Honest degrade: the user attached a real file we could not extract. Name it and say
        // so in the prompt — never silently pretend it wasn't attached.
        const reason = clip(att.reason, 200);
        docParts.push(section(`Document ${docParts.length + 1}`, att.name,
          `(couldn't read this file${reason ? ` — ${reason}` : ''}. Tell the user you received it but could not read its contents; do not guess at them.)`));
        continue;
      }
      const { text, truncated } = clipDoc(att.text);
      if (text) docParts.push(section(`Document ${docParts.length + 1}`, att.name, text + (truncated ? '\n…(truncated)' : '')));
    }
  }

  const imageCount = imageParts.length;
  const docCount = docParts.length;
  const hasAny = imageCount + docCount > 0;
  if (!hasAny) return { promptBlock: '', imageCount: 0, docCount: 0, hasAny: false, turnNote: '' };

  const header = 'The user attached media with this message. Treat the following as authoritative '
    + 'context — the image description(s) come from a vision model that looked at the actual photo(s), '
    + 'and the document text is verbatim. Answer using it; do not claim you cannot see images.';
  const promptBlock = [header, ...imageParts, ...docParts].join('\n\n') + '\n\n---';
  return { promptBlock, imageCount, docCount, hasAny, turnNote: turnNote(imageCount, docCount) };
}

/** Coerce the untrusted value into a bounded list of well-typed attachments. */
function normalize(raw: unknown): JarvisAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: JarvisAttachment[] = [];
  for (const item of raw.slice(0, MAX_ATTACHMENTS)) {
    if (!item || typeof item !== 'object') continue;
    const kind = (item as { kind?: unknown }).kind;
    if (kind !== 'image' && kind !== 'doc') continue;
    out.push({
      kind,
      name: strOrUndef((item as { name?: unknown }).name),
      description: strOrUndef((item as { description?: unknown }).description),
      text: strOrUndef((item as { text?: unknown }).text),
      unreadable: (item as { unreadable?: unknown }).unreadable === true,
      reason: strOrUndef((item as { reason?: unknown }).reason),
    });
  }
  return out;
}

/** Render one titled section with an optional filename in the header. */
function section(title: string, name: string | undefined, body: string): string {
  const label = name ? `${title} — ${sanitizeName(name)}` : title;
  return `[${label}]\n${body}`;
}

/** Build the short history suffix ("📎 1 photo, 2 documents"). */
function turnNote(images: number, docs: number): string {
  const bits: string[] = [];
  if (images) bits.push(`${images} photo${images === 1 ? '' : 's'}`);
  if (docs) bits.push(`${docs} document${docs === 1 ? '' : 's'}`);
  return bits.length ? ` 📎 ${bits.join(', ')}` : '';
}

/** Trim + hard-cap an image description string. */
function clip(value: string | undefined, max: number): string {
  const v = (value || '').trim();
  return v.length > max ? v.slice(0, max) : v;
}

/** Trim + hard-cap doc text, reporting whether it was cut. */
function clipDoc(value: string | undefined): { text: string; truncated: boolean } {
  const v = (value || '').trim();
  return v.length > MAX_DOC_CHARS ? { text: v.slice(0, MAX_DOC_CHARS), truncated: true } : { text: v, truncated: false };
}

/** Keep filenames short + free of newlines/control chars in the prompt header. */
function sanitizeName(name: string): string {
  return name.replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 120) || 'file';
}

/** Return a trimmed string or undefined (never a non-string). */
function strOrUndef(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return v.length ? v : undefined;
}
