/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard ADR-171 cross-runtime structured logging and its actual module boundary.
 */

import type { Scenario } from './test-lab-scenarios';

/**
 * @description Register source/real-module logging proofs without presenting an HTTP card as Docker stdout evidence.
 * @returns Explicit-only checklist; the documented host/container runner supplies the actual receipts.
 */
export const LOGGING_SCENARIOS: Scenario[] = [{
  id: 'javascript-structured-logging',
  title: 'One structured log format across runtimes',
  group: 'tool',
  explicitOnly: true,
  description: 'ADR-171 D1: the real JavaScript logger, shared Pino contract, correlation, errors, redaction and console/Winston guard. Local module/relocated-package tests are separate from the required built bot-container stdout proof.',
  regressionTests: [
    { level: 'integration', path: 'tests/logging/javascript-structured-logging.test.cjs' },
    { level: 'unit', path: 'tests/logging/javascript-logging-guard.test.cjs' },
    { level: 'unit', path: 'tests/unit/logger-redaction.spec.ts' },
  ],
  steps: [{
    id: 'container-receipt-required',
    app: 'logging',
    label: 'Built bot-container stdout evidence',
    run: async () => ({
      app: 'logging',
      label: 'Built bot-container stdout evidence',
      state: 'gap',
      detail: 'Run docs/runbooks/javascript-structured-logging.md against the exact built image in an authorized resource window. This browser step cannot observe container stdout and does not manufacture a pass from the catalog or API log file.',
    }),
  }],
}];
