/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pins the rule behind the 2026-09-29 live defect (a Jarvis answer of 5 was lost): the text of a completion is the literal result the model wrote, always a string. Every case runs the REAL ToolUseParser over a model reply and hands its parsed call to completionResultText, so the guard sees the same converted value the agentic loop sees. Covered: bare numbers and booleans, the falsy values 0 and false that used to fall through to the raw XML reply, literals the conversion rewrites (5.0, 007, 1e3), ordinary prose, a native tool block that carries a typed JSON value and no XML, and the fallback to the whole reply. The last block proves the conversion for real tool parameters is untouched. The delivery path through the bot-node handler is guarded in tests/unit/antigravity-host-tool-loop.spec.ts.
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const requireModule = createRequire(import.meta.url);
const ToolUseParser = requireModule('../../any-bot/server/services/llm/ToolUseParser.js') as {
  parseToolUse(text: string): { name: string; input: Record<string, unknown>; rawMatch: string } | null;
};
const { completionResultText, literalParameter } = requireModule('../../any-bot/server/controllers/completion-result-text.js') as {
  completionResultText(toolUse: unknown, responseText: unknown): string;
  literalParameter(rawMatch: unknown, name: string): string | null;
};

/** The reply a model gives when it completes with one result parameter. */
function completionReply(result: string): string {
  return `<attempt_completion><result>${result}</result></attempt_completion>`;
}

/** What the agentic loop stores for a reply: the real parse, then the completion text rule. */
function storedText(reply: string): string {
  return completionResultText(ToolUseParser.parseToolUse(reply), reply);
}

describe('the completion text is the literal result the model wrote', () => {
  it.each(['5', '3.14', '-2', 'true', 'false', '0', '0.0'])('keeps the bare value %s as a string', (value) => {
    const parsed = ToolUseParser.parseToolUse(completionReply(value));
    // The premise of the defect: the parser has converted this value, so it is not a string.
    expect(typeof parsed?.input.result).not.toBe('string');
    expect(storedText(completionReply(value))).toBe(value);
  });

  it.each(['5.0', '007', '1e3', '0x10', 'Infinity'])('keeps %s as written, not as the converted number renders', (value) => {
    expect(storedText(completionReply(value))).toBe(value);
  });

  it.each([
    'ready',
    'The codeword is TESTLAB-RECALL-5D0C1E77.',
    'Line one.\nLine two with <b>markup</b> inside.',
  ])('returns ordinary text exactly as the parser read it: %j', (value) => {
    const reply = completionReply(value);
    expect(storedText(reply)).toBe(value);
    expect(storedText(reply)).toBe(ToolUseParser.parseToolUse(reply)?.input.result);
  });

  it('trims the whitespace around a result and reads it across lines', () => {
    expect(storedText('<attempt_completion>\n<result>\n  5\n</result>\n</attempt_completion>')).toBe('5');
  });

  it('reads the result beside another parameter and keeps the last result when it repeats', () => {
    expect(storedText('<attempt_completion><result>5</result><command>echo 7</command></attempt_completion>')).toBe('5');
    expect(storedText('<attempt_completion><result>4</result><result>5</result></attempt_completion>')).toBe('5');
  });

  it('ignores the thinking text a model writes before the call', () => {
    expect(storedText(`Two plus three is five.\n${completionReply('5')}`)).toBe('5');
  });
});

describe('a completion with no XML literal to read', () => {
  it.each([
    [5, '5'], [0, '0'], [3.14, '3.14'], [true, 'true'], [false, 'false'], ['ready', 'ready'],
  ])('renders the typed value %j of a native tool block as %j', (result, text) => {
    expect(completionResultText({ name: 'attempt_completion', input: { result }, id: 'tool_use_1' }, 'whole reply')).toBe(text);
  });

  it('renders a structured value of a native tool block as JSON text', () => {
    expect(completionResultText({ name: 'attempt_completion', input: { result: { total: 5 } } }, 'whole reply'))
      .toBe('{"total":5}');
  });

  it.each([
    ['an empty result', '<attempt_completion><result></result></attempt_completion>'],
    ['a blank result', '<attempt_completion><result>   </result></attempt_completion>'],
    ['no result parameter', '<attempt_completion><command>echo 5</command></attempt_completion>'],
  ])('falls back to the whole reply for %s', (_label, reply) => {
    expect(storedText(reply)).toBe(reply);
  });

  it('returns an empty string, never a non-string, when there is no call and no reply text', () => {
    expect(completionResultText(null, undefined)).toBe('');
    expect(completionResultText(undefined, 5)).toBe('');
    expect(completionResultText({ input: {} }, null)).toBe('');
  });

  it('reads no parameter from text that is not one whole tool call', () => {
    expect(literalParameter(undefined, 'result')).toBeNull();
    expect(literalParameter('<result>5</result> trailing text', 'result')).toBeNull();
    expect(literalParameter('<attempt_completion><command>ls</command></attempt_completion>', 'result')).toBeNull();
  });
});

describe('real tool parameters keep the conversion the parser applies', () => {
  it('still hands a tool its typed parameters', () => {
    const parsed = ToolUseParser.parseToolUse(
      '<read_file><path>notes/plan.md</path><limit>20</limit><recursive>true</recursive></read_file>');
    expect(parsed?.input).toEqual({ path: 'notes/plan.md', limit: 20, recursive: true });
  });
});
