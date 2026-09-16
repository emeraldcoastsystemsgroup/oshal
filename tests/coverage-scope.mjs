/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | First coverage scope: the single
 *   source of truth for WHICH source files the coverage figure covers, WHICH specs
 *   produce it, and the threshold floors that fail the run when breached. Both
 *   vitest.coverage.config.ts and scripts/test-coverage.mjs read this file so the
 *   printed scope banner and the measured figure can never describe different sets.
 */

/**
 * @description Human-readable name of the scope the coverage figure covers. Printed
 * next to the figure so a number quoted from this command always carries its scope.
 */
export const COVERAGE_SCOPE_NAME = 'security decision paths (src/shared/security)';

/**
 * @description Source globs the coverage percentages are computed over. Every file
 * matching these globs is reported whether or not a spec imports it, so adding an
 * unspecced module to the scope lowers the figure rather than hiding from it.
 */
export const COVERAGE_SOURCE_GLOBS = ['src/shared/security/**/*.ts'];

/**
 * @description The specs executed to produce the figure. An explicit list, not a
 * glob: the figure is only meaningful if the set that produced it is stated.
 */
export const COVERAGE_SPEC_FILES = [
  'tests/unit/authorization-tool-policy.spec.ts',
  'tests/unit/bot-node-client-delegation.spec.ts',
  'tests/unit/delegation-replay-store.spec.ts',
  'tests/unit/delegation-request-binding.spec.ts',
  'tests/unit/delegation-token.spec.ts',
  'tests/unit/exact-subject-store.spec.ts',
  'tests/unit/owner-principal-issuer.spec.ts',
  'tests/unit/scoped-file-writer-hardening.spec.ts',
  'tests/unit/ssrf-guard.spec.ts',
];

/**
 * @description Threshold floors. vitest exits non-zero when a measured percentage
 * falls below its floor, so this is a gate rather than a decoration. Floors sit just
 * under the figure the command reported when they were set; raise them only with a
 * run that shows the headroom.
 */
export const COVERAGE_THRESHOLDS = {
  statements: 75,
  branches: 74,
  functions: 82,
  lines: 77,
};

/**
 * @description The floors vitest is actually configured with. Normally the committed
 * COVERAGE_THRESHOLDS exactly. `OSHAL_COVERAGE_FLOOR_OVERRIDE` (a JSON object of metric
 * to percentage) raises them for the gate's own regression guard, which has to watch a
 * breach travel the committed wiring - this module, into vitest.coverage.config.ts, out
 * as a non-zero exit - rather than a CLI flag that would bypass that wiring and prove
 * nothing about it. Nothing in normal operation sets the variable.
 * @returns {{ statements: number, branches: number, functions: number, lines: number }}
 *   The floors to enforce on this run.
 */
export function resolveCoverageThresholds() {
  const raw = process.env.OSHAL_COVERAGE_FLOOR_OVERRIDE;
  if (!raw) return COVERAGE_THRESHOLDS;
  return { ...COVERAGE_THRESHOLDS, ...JSON.parse(raw) };
}

/**
 * @description Directory the coverage reports are written to (gitignored).
 */
export const COVERAGE_REPORTS_DIRECTORY = 'coverage/security-decision-paths';
