/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-063 — proves the heuristic
 *            | scorer now credits bare-`assert` / pytest tests (root cause of the 2026-06-21
 *            | FAIL) while a genuinely test-less solution still falls below threshold.
 */

import { test, expect } from '@playwright/test';
import { heuristicGrade, hasTestConstructs, type Golden } from '@/app/routes/test-lab-golden';

// The exact 2026-06-21 golden scenario (id g-phone-validator). passScore 70.
const PHONE_GOLDEN: Golden = {
  id: 'g-phone-validator',
  name: 'Python phone validator + tests',
  complexity: 'low',
  ticket: { title: 't', description: 'd' },
  expect: {
    mustComplete: true,
    requiredKeywords: ['def validate_us_phone', 'assert'],
    requiredArtifacts: 1,
    rubric: 'validate_us_phone with >=3 assert-based tests',
  },
  passScore: 70,
};

// A correct bare-`assert` solution — exactly the style the spec asked for (no unittest idiom).
const BARE_ASSERT_SOLUTION = `
import re

def validate_us_phone(s):
    digits = re.sub(r"[^0-9]", "", s)
    if digits.startswith("1"):
        digits = digits[1:]
    return len(digits) == 10

assert validate_us_phone("(555) 123-4567") is True
assert validate_us_phone("+1 555 123 4567") is True
assert validate_us_phone("123") is False
`;

// A genuinely test-less solution: same function, ZERO assertions / test constructs.
const NO_TESTS_SOLUTION = `
import re

def validate_us_phone(s):
    digits = re.sub(r"[^0-9]", "", s)
    if digits.startswith("1"):
        digits = digits[1:]
    return len(digits) == 10

print(validate_us_phone("(555) 123-4567"))
`;

test.describe('heuristic scorer — bare-assert recognition (2026-06-21 root cause)', () => {
  test('hasTestConstructs recognizes bare assert and pytest, not just unittest', () => {
    expect(hasTestConstructs('assert x == 1')).toBe(true);
    expect(hasTestConstructs('def test_foo():\n    pass')).toBe(true);
    expect(hasTestConstructs('import unittest\nclass T(unittest.TestCase): pass')).toBe(true);
    expect(hasTestConstructs("expect(result).toBe(2)")).toBe(true);
    // No assertion / test-runner construct present.
    expect(hasTestConstructs('print("hello")\nx = 2 + 2')).toBe(false);
  });

  test('bare-assert solution now scores >= threshold even when the ticket escalated', () => {
    // The 2026-06-21 reality: ticket ended 'escalated' (not 'complete'), 1 deliverable.
    const { score, reasons } = heuristicGrade(PHONE_GOLDEN, 'escalated', {
      text: BARE_ASSERT_SOLUTION,
      artifactCount: 1,
    });
    // 0 (escalated) + 20 (artifact) + 40 (both keywords) + 20 (test constructs) = 80.
    expect(score).toBeGreaterThanOrEqual(PHONE_GOLDEN.passScore);
    expect(score).toBe(80);
    // It should NOT complain about missing tests anymore.
    expect(reasons.join(' ')).not.toContain('no recognizable test constructs');
  });

  test('a completed bare-assert solution scores even higher', () => {
    const { score } = heuristicGrade(PHONE_GOLDEN, 'complete', {
      text: BARE_ASSERT_SOLUTION,
      artifactCount: 1,
    });
    // 20 (complete) + 20 + 40 + 20 = 100.
    expect(score).toBe(100);
  });

  test('a genuinely test-less solution still fails the threshold', () => {
    const { score, reasons } = heuristicGrade(PHONE_GOLDEN, 'escalated', {
      text: NO_TESTS_SOLUTION,
      artifactCount: 1,
    });
    // 0 (escalated) + 20 (artifact) + 20 (only the validate_us_phone keyword hit; 'assert' missing
    // because there is no assert) + 0 (no test constructs) = 40. Below 70.
    expect(score).toBeLessThan(PHONE_GOLDEN.passScore);
    expect(reasons.join(' ')).toContain('no recognizable test constructs');
  });
});
