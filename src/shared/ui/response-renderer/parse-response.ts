/**
 * Response Renderer — the pure segmenter.
 *
 * `parseResponse(text)` splits a bot's markdown reply into an ordered list of {@link ResponseBlock}s
 * so a surface can render each with the right component. It extracts the blocks that need a SPECIAL
 * renderer — fenced code (highlighting), ```mermaid (diagram), ```oshal:<kind> (typed component) —
 * and leaves everything else as `markdown` runs the surface renders with its existing markdown
 * renderer. It does NOT reimplement a full markdown parser (headings/lists/tables/inline stay inside
 * `markdown` blocks); its job is choosing the component boundary, not re-rendering prose.
 *
 * Robustness: an unterminated fence is left as prose (never crashes); a malformed ```oshal:* body
 * (non-JSON) degrades to a `code` block rather than throwing, so a bad typed block renders visibly
 * instead of breaking the reply. Deterministic — same input → same blocks.
 *
 * Trust boundary: the parser NEVER emits an `artifact` block, and a fence named after a trusted
 * block (see trusted-provenance.ts) stays `code`. Provider-grounded content reaches a surface only
 * beside the text with a server provenance record.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — fenced-block segmentation into markdown/code/mermaid/oshal blocks + hasRichBlocks helper.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | A fence that impersonates a trusted block (`artifact:*`, `provider:*`, `trusted:*`, or a reserved `oshal:` kind) is demoted to an inert code block: model text can never mint a provider-grounded block.
 *
 * @module shared/ui/response-renderer/parse-response
 */

import { isReservedTrustedFence } from './trusted-provenance';
import type { ResponseBlock } from './types';

/** Matches a fenced block: ```<info>\n<body>\n``` (info string on the opening line, body lazy). */
const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;

/** Turn one fenced block's info string + body into the right block. */
function fenceToBlock(info: string, body: string): ResponseBlock {
  const lang = info.trim();
  const code = body.replace(/\n$/, ''); // drop the trailing newline before the closing fence

  // Checked first: a forged trusted fence is displayed as the text it is, never promoted.
  if (isReservedTrustedFence(lang)) {
    return { type: 'code', lang, code };
  }
  if (lang.toLowerCase() === 'mermaid') {
    return { type: 'mermaid', code };
  }
  if (lang.toLowerCase().startsWith('oshal:')) {
    const kind = lang.slice('oshal:'.length).trim();
    try {
      return { type: 'oshal', kind, data: JSON.parse(code) as unknown, raw: code };
    } catch {
      // Malformed typed block → render it visibly as code rather than dropping/throwing.
      return { type: 'code', lang, code };
    }
  }
  return { type: 'code', lang, code };
}

/** Push a prose run as a `markdown` block, trimming surrounding blank lines; skips empty runs. */
function pushProse(blocks: ResponseBlock[], text: string): void {
  const trimmed = text.replace(/^\s*\n/, '').replace(/\n\s*$/, '').trim();
  if (trimmed.length > 0) blocks.push({ type: 'markdown', text: trimmed });
}

/**
 * @description Segment a bot reply into ordered typed blocks. Prose between/around fenced blocks
 * becomes `markdown` blocks; fences become `code` / `mermaid` / `oshal` blocks.
 * @param text - The bot's raw markdown reply.
 * @returns The ordered blocks (empty array for empty/whitespace input).
 */
export function parseResponse(text: string): ResponseBlock[] {
  if (typeof text !== 'string' || text.trim().length === 0) return [];

  const blocks: ResponseBlock[] = [];
  let lastIndex = 0;
  FENCE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE.exec(text)) !== null) {
    if (m.index > lastIndex) pushProse(blocks, text.slice(lastIndex, m.index));
    blocks.push(fenceToBlock(m[1] ?? '', m[2] ?? ''));
    lastIndex = FENCE.lastIndex;
  }
  if (lastIndex < text.length) pushProse(blocks, text.slice(lastIndex));

  return blocks;
}

/** True when the reply contains any block a plain markdown renderer wouldn't specially handle
 *  (code/mermaid/oshal) — a surface uses this to decide whether the rich renderer is worth invoking. */
export function hasRichBlocks(blocks: ResponseBlock[]): boolean {
  return blocks.some((b) => b.type !== 'markdown');
}
