/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Expression evaluator for logic-gate nodes — safe, deterministic, no eval()
 */

const COMPLEXITY_ORDER: Record<string, number> = { low: 1, medium: 2, high: 3 };

/**
 * Evaluates a logic-gate expression against the current engine variable context.
 *
 * Supports a small set of safe patterns — NOT a general-purpose expression engine.
 * Patterns:
 *   "variableName === true"
 *   "variableName === false"
 *   "variableName === 'stringValue'"
 *   "complexity_gte('low'|'medium'|'high')"
 *   "complexity_lt('low'|'medium'|'high')"
 */
export function evaluateExpression(expression: string, variables: Record<string, unknown>): boolean {
  const trimmed = expression.trim();

  // Built-in: complexity_gte('threshold')
  const gteMatch = trimmed.match(/^complexity_gte\(['"](\w+)['"]\)$/);
  if (gteMatch) {
    const threshold = gteMatch[1];
    const actual = String(variables.complexity ?? 'low');
    return (COMPLEXITY_ORDER[actual] ?? 0) >= (COMPLEXITY_ORDER[threshold] ?? 0);
  }

  // Built-in: complexity_lt('threshold')
  const ltMatch = trimmed.match(/^complexity_lt\(['"](\w+)['"]\)$/);
  if (ltMatch) {
    const threshold = ltMatch[1];
    const actual = String(variables.complexity ?? 'low');
    return (COMPLEXITY_ORDER[actual] ?? 0) < (COMPLEXITY_ORDER[threshold] ?? 0);
  }

  // Pattern: "variableName === true"
  const boolTrueMatch = trimmed.match(/^(\w+)\s*===?\s*true$/);
  if (boolTrueMatch) {
    return variables[boolTrueMatch[1]] === true;
  }

  // Pattern: "variableName === false"
  const boolFalseMatch = trimmed.match(/^(\w+)\s*===?\s*false$/);
  if (boolFalseMatch) {
    return variables[boolFalseMatch[1]] === false;
  }

  // Pattern: "variableName === 'stringValue'"
  const strMatch = trimmed.match(/^(\w+)\s*===?\s*['"]([^'"]+)['"]$/);
  if (strMatch) {
    return String(variables[strMatch[1]] ?? '') === strMatch[2];
  }

  // Pattern: "variableName !== true" (negation)
  const negBoolMatch = trimmed.match(/^(\w+)\s*!==?\s*true$/);
  if (negBoolMatch) {
    return variables[negBoolMatch[1]] !== true;
  }

  // Operator-based evaluation for logic-gate operands
  // "all" operator: all operands must be truthy
  // "any" operator: at least one operand truthy
  // "none" operator: no operands truthy
  // These are handled by evaluateLogicGate(), not here.

  // Unrecognized expression — default to false (safe)
  return false;
}

/**
 * Evaluates a logic-gate node's operator and operands against the variable context.
 * Used for 'all', 'any', 'none' operators. The 'expression' operator delegates to evaluateExpression().
 */
export function evaluateLogicGate(
  operator: string,
  operands: string[],
  expression: string | undefined,
  variables: Record<string, unknown>,
): boolean {
  if (operator === 'expression' && expression) {
    return evaluateExpression(expression, variables);
  }

  const values = operands.map((op) => Boolean(variables[op]));

  switch (operator) {
    case 'all':
      return values.length > 0 && values.every(Boolean);
    case 'any':
      return values.some(Boolean);
    case 'none':
      return values.length === 0 || values.every((v) => !v);
    default:
      return false;
  }
}
