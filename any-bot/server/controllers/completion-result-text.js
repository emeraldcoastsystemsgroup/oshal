/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the text of a completion is the literal result the model wrote, always a string. Fixes the 2026-09-29 live defect (live case jarvis-cache, 3 of 3 answers lost): ToolUseParser converts a numeric or true/false parameter into a Number or Boolean, which is right for a real tool parameter, but AgenticController stored that converted value as the completion_result message text. "What is 2 plus 3? Reply with just the number." therefore saved the number 5, and the bot-node handler threw "m.text.trim is not a function" reading it back, so the answer was never delivered. The same expression fell through to the raw XML reply for 0 and false, because both are falsy. Kept beside the controller as its own module so the rule is directly testable (tests/unit/completion-result-text.spec.ts).
 */

/** The parameter pattern ToolUseParser.extractParameters applies to the inside of a tool tag. */
const PARAMETER_PATTERN = /<(\w+)>([\s\S]*?)<\/\1>/g;
/** One whole tool call, as ToolUseParser.parseToolUse reports it in rawMatch. */
const TOOL_CALL_PATTERN = /^<([\w-]+)>([\s\S]*)<\/\1>$/;

/**
 * @description Reads one parameter of an XML tool call as the text the model wrote, before any
 * type conversion. When the parameter appears more than once the last one wins, which is the
 * value ToolUseParser keeps.
 * @param {unknown} rawMatch - the tool call text (toolUse.rawMatch); absent for a native tool block.
 * @param {string} name - the parameter to read.
 * @returns {string|null} the trimmed literal text, or null when the call carries no such parameter.
 */
function literalParameter(rawMatch, name) {
  if (typeof rawMatch !== 'string') return null;
  const call = rawMatch.trim().match(TOOL_CALL_PATTERN);
  if (!call) return null;
  let literal = null;
  for (const [, parameterName, parameterValue] of call[2].matchAll(PARAMETER_PATTERN)) {
    if (parameterName === name) literal = parameterValue.trim();
  }
  return literal;
}

/**
 * @description Renders a typed result as text. Only a native tool block reaches this: it carries
 * a JSON value and no XML literal to read.
 * @param {unknown} value - the typed result parameter.
 * @returns {string} the value as text; empty when there is nothing to render.
 */
function typedResultText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value && typeof value === 'object') return JSON.stringify(value);
  return '';
}

/**
 * @description Decides the text of an attempt_completion. Why it is not simply toolInput.result:
 * that value has been through the parser's type conversion, so an answer of 5 is a Number and an
 * answer of true is a Boolean, and the original text (5.0, 007) is gone. Every reader of a
 * completion_result message treats its text as a string, so this returns the literal result
 * the model wrote, and falls back to the whole reply only when the call carries no result.
 * @param {{input?: {result?: unknown}, rawMatch?: unknown}|null|undefined} toolUse - the parsed call.
 * @param {unknown} responseText - the full reply of the model for this turn.
 * @returns {string} the completion text; never a non-string value.
 */
function completionResultText(toolUse, responseText) {
  const literal = literalParameter(toolUse && toolUse.rawMatch, 'result');
  if (literal) return literal;
  const typed = typedResultText(toolUse && toolUse.input ? toolUse.input.result : undefined);
  if (typed.trim()) return typed;
  return typeof responseText === 'string' ? responseText : '';
}

module.exports = { completionResultText, literalParameter };
