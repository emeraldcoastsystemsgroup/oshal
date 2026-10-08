/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard ADR-171 cross-runtime structured logging and its actual module boundary.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Register admitted native diagnostic/config reads and their screen regressions without changing runtime levels.
 */

import type { Scenario, ScenarioRunContext, StepResult } from './test-lab-scenarios';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'test-lab-native-logging' });

/** @description Probe only fixed logging reads as the initiating caller; never alter verbosity.
 * @param {string} cookie The initiating session, forwarded without logging it.
 * @param {'config'|'records'} kind A fixed diagnostic route.
 * @param {ScenarioRunContext|undefined} runtime Server-derived loopback context.
 * @returns {Promise<StepResult>} Actual access and native-contract evidence.
 */
async function nativeLoggingRead(cookie: string, kind: 'config' | 'records', runtime?: ScenarioRunContext): Promise<StepResult> {
  const path = kind === 'config' ? '/api/admin/logging' : '/api/v1/logs/query?limit=1';
  const label = kind === 'config' ? 'Current administrator logging settings' : 'Bounded native records';
  const started = Date.now();
  logger.debug({ phase: kind }, 'Native logging read started');
  try {
    const base = runtime?.apiBaseUrl || `http://127.0.0.1:${process.env.PORT || '5000'}`;
    const response = await fetch(`${base}${path}`, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(8000) });
    logger.info({ phase: kind, status: response.status, durationMs: Date.now() - started }, 'Native logging read finished');
    if (!response.ok) {
      const state = response.status === 404 ? 'gap' : [401, 403, 503].includes(response.status) ? 'degraded' : 'fail';
      return { app: 'logging', label, state, status: response.status,
        detail: `Native logging read returned HTTP ${response.status}. Current administrator access is required.` };
    }
    const body = await response.json() as Record<string, any>;
    const valid = body.source === 'native-kernel-observer' && (kind === 'config'
      ? ['error', 'warn', 'info', 'debug', 'trace'].includes(body.level) && body.audit_always_enabled === true
      : Array.isArray(body.data) && body.data.length <= 1 && body.meta?.retention === 'memory-until-restart');
    return { app: 'logging', label, state: valid ? 'pass' : 'fail', status: response.status,
      detail: valid ? 'The native admitted read contract passed; no levels were changed.' : 'The response does not satisfy the native logging contract.' };
  } catch {
    logger.error({ err: new Error('Native logging read failed'), phase: kind, durationMs: Date.now() - started }, 'Native logging transport failed');
    return { app: 'logging', label, state: 'fail', detail: 'The logging read did not complete; no empty-history fallback was used.' };
  }
}

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
}, {
  id: 'native-runtime-logging',
  title: 'Native traces and administrator log levels',
  group: 'tool',
  explicitOnly: true,
  description: 'Read native recent records and effective administrator settings using your current session. No configuration is changed. Unit/browser tests cover trace filters, safe rendering and truthful failed updates; native backend tests cover authority, persistence and filtering.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/logging-native-screen.spec.ts' },
    { level: 'browser', path: 'tests/unit/logging-native-browser.spec.ts' },
  ],
  steps: [
    { id: 'settings', app: 'logging', label: 'Current administrator logging settings', run: (cookie, _prior, runtime) => nativeLoggingRead(cookie, 'config', runtime) },
    { id: 'records', app: 'logging', label: 'Bounded native records', run: (cookie, _prior, runtime) => nativeLoggingRead(cookie, 'records', runtime) },
  ],
}];
