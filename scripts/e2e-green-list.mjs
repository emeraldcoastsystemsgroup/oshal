/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | New. The ONE parser for tests/e2e-green-suite.txt. The runner (scripts/e2e-green.mjs) and the registration guard (tests/unit/real-boundary-doctrine.spec.ts) used to carry two copies of the same three expressions, and the guard pinned the runner's copy by grepping its source - which a runner that kept the strings in a comment and ran a different list satisfied (PR #620 review). With one exported function there is no mirror to drift: both sides call this.
 */

import { readFileSync } from 'node:fs';

/**
 * @description Parses the curated green-suite list: one spec path per line, trimmed, with blank
 * lines and `#` comments dropped. CRLF and LF are both accepted because the file is edited on
 * Windows and committed LF.
 * @param text - The raw contents of tests/e2e-green-suite.txt.
 * @returns The spec paths in list order.
 */
export function parseGreenSuite(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * @description Reads and parses the green-suite list at the given path.
 * @param listPath - Absolute or cwd-relative path to tests/e2e-green-suite.txt.
 * @returns The spec paths the green gate runs, in list order.
 */
export function readGreenSuite(listPath) {
  return parseGreenSuite(readFileSync(listPath, 'utf8'));
}
