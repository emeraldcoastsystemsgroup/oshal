/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Response-renderer segmenter: proves parseResponse splits a bot reply into ordered markdown/code/mermaid/oshal blocks, extracts + JSON-parses oshal:<kind> typed blocks, degrades a malformed typed block to a visible code block (never throws), leaves prose (headings/tables/lists) inside markdown blocks, and hasRichBlocks flags non-prose content.
 */

import { describe, expect, it } from 'vitest';
import { parseResponse, hasRichBlocks } from '../../src/shared/ui/response-renderer';

// Fenced blocks are built with single-quoted strings so the literal backticks don't terminate them.
const FENCE = '```';

describe('parseResponse — segmentation', () => {
  it('returns [] for empty/whitespace input', () => {
    expect(parseResponse('')).toEqual([]);
    expect(parseResponse('   \n  ')).toEqual([]);
    expect(parseResponse(null as unknown as string)).toEqual([]);
  });

  it('keeps a plain prose reply as one markdown block (headings/tables/lists stay inline)', () => {
    const md = '# Title\n\nSome **prose** and a list:\n- a\n- b\n\n| h |\n|---|\n| x |';
    const blocks = parseResponse(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: 'markdown', text: md });
    expect(hasRichBlocks(blocks)).toBe(false);
  });

  it('splits prose + a fenced code block into ordered blocks with the language', () => {
    const text = `Here is the fix:\n\n${FENCE}python\ndef f():\n    return 1\n${FENCE}\n\nDone.`;
    const blocks = parseResponse(text);
    expect(blocks.map((b) => b.type)).toEqual(['markdown', 'code', 'markdown']);
    expect(blocks[1]).toEqual({ type: 'code', lang: 'python', code: 'def f():\n    return 1' });
    expect(blocks[0]).toMatchObject({ type: 'markdown', text: 'Here is the fix:' });
    expect(blocks[2]).toMatchObject({ type: 'markdown', text: 'Done.' });
    expect(hasRichBlocks(blocks)).toBe(true);
  });

  it('recognizes a mermaid block', () => {
    const text = `Flow:\n\n${FENCE}mermaid\ngraph TD; A-->B\n${FENCE}`;
    const blocks = parseResponse(text);
    expect(blocks.map((b) => b.type)).toEqual(['markdown', 'mermaid']);
    expect(blocks[1]).toEqual({ type: 'mermaid', code: 'graph TD; A-->B' });
  });

  it('extracts + JSON-parses an oshal:<kind> typed block', () => {
    const text = `Your route:\n\n${FENCE}oshal:map\n{"center":[30.4,-87.2],"zoom":11}\n${FENCE}`;
    const blocks = parseResponse(text);
    expect(blocks[1]).toEqual({
      type: 'oshal', kind: 'map',
      data: { center: [30.4, -87.2], zoom: 11 },
      raw: '{"center":[30.4,-87.2],"zoom":11}',
    });
  });

  it('degrades a malformed oshal block to a visible code block (never throws)', () => {
    const text = `${FENCE}oshal:chart\n{not valid json}\n${FENCE}`;
    const blocks = parseResponse(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: 'code', lang: 'oshal:chart', code: '{not valid json}' });
  });

  it('handles multiple adjacent fenced blocks', () => {
    const text = `${FENCE}js\na\n${FENCE}\n${FENCE}mermaid\nb\n${FENCE}`;
    const blocks = parseResponse(text);
    expect(blocks.map((b) => b.type)).toEqual(['code', 'mermaid']);
  });

  it('leaves an UNTERMINATED fence as prose (no crash)', () => {
    const text = `start\n\n${FENCE}python\ndef f(): pass\n(no closing fence)`;
    const blocks = parseResponse(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('markdown');
    expect(hasRichBlocks(blocks)).toBe(false);
  });

  it('is deterministic (same input → same output across calls)', () => {
    const text = `p\n${FENCE}go\nx\n${FENCE}\nq`;
    expect(parseResponse(text)).toEqual(parseResponse(text));
  });

  it('does not treat inline `code` (single backticks) as a fence', () => {
    const blocks = parseResponse('use the `foo` helper');
    expect(blocks).toEqual([{ type: 'markdown', text: 'use the `foo` helper' }]);
  });
});
