/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel export for test helper utilities
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the shared origin helpers (baseOrigin/apiOrigin & co.) so specs stop hardcoding localhost:3456/35457 and follow PLAYWRIGHT_PORT like the harness does
 */

export {
  createReportBuilder,
  type PhaseSnapshot,
  type ValidationReport,
  type ReportBuilder,
} from './swarm-validation-report';

export {
  basePort,
  baseHost,
  baseOrigin,
  apiPort,
  apiHost,
  apiOrigin,
  escapeForRegExp,
} from './test-origins';