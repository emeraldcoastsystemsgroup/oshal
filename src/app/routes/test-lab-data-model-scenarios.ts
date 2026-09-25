/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab registration for the data-model explorer. The live step reads GET /api/admin/data-model with the initiating operator's cookie and checks the snapshot's shape (core node present, every relation carries owners and a row-access state, integration edges name known owners). Read-only: it never rebuilds the cache or touches a store.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Carry the view-export guard in the card's regression set, so the Mermaid/SVG/JSON export is covered by the same suite the card names.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Carry the schema-drift guard in the card's regression set: the digest, the classifier that keeps a normal change quiet, and the refusals.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Register isolated internal-producer and real PostgreSQL policy-drop guards; the live snapshot step does not assert automatic alarm or ticket acceptance.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Register detector lifecycle and real policy-drop-to-ticket/browser acceptance; keep the live card read-only.
 */

import type { Scenario, StepResult } from './test-lab-scenarios';

const APP = 'data-model';
const LABEL = 'Data model snapshot';

/**
 * @description Check a snapshot body's structure and summarise it.
 * @param body - parsed JSON
 * @returns a failure reason, or null when the shape holds
 */
function shapeProblem(body: Record<string, any>): string | null {
  if (!Array.isArray(body.tables) || !Array.isArray(body.views) || !Array.isArray(body.apps) || !Array.isArray(body.integrations)) return 'Snapshot is missing tables[], views[], apps[] or integrations[].';
  if (!body.apps.some((a: any) => a.name === '@core')) return 'Snapshot has no @core node.';
  const owners = new Set(body.apps.map((a: any) => a.name));
  if (body.tables.some((t: any) => !Array.isArray(t.owners) || !t.access || typeof t.access.state !== 'string')) return 'A table is missing owners[] or its row-access state.';
  if (body.integrations.some((e: any) => !owners.has(e.from) || !owners.has(e.to))) return 'An integration edge names an owner that is not in apps[].';
  return null;
}

/**
 * @description Live step: read the operator-only snapshot and validate it.
 * @param cookie - the initiating operator's session cookie
 * @returns the step result
 */
async function snapshotStep(cookie: string): Promise<StepResult> {
  const result = (state: StepResult['state'], detail: string, status?: number): StepResult => ({ app: APP, label: LABEL, state, detail, ...(status ? { status } : {}) });
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}/api/admin/data-model`, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(60_000) });
  if (response.status === 401 || response.status === 403) return result('degraded', 'The data-model explorer is operator-only; run this card as an operator.', response.status);
  if (response.status === 503) return result('degraded', 'The platform database is not configured in this process.', response.status);
  if (response.status !== 200) return result('fail', `Snapshot returned HTTP ${response.status}.`, response.status);
  const body = await response.json() as Record<string, any>;
  const problem = shapeProblem(body);
  if (problem) return result('fail', problem);
  return result('pass', `${body.tables.length} tables, ${body.views.length} views, ${body.apps.length - 1} apps, ${body.integrations.length} integration links, ${body.unowned.length} unowned relations. Local suites cover ownership, the integration map, the RLS classifier, the real-database catalog read and the browser surface.`);
}

export const DATA_MODEL_SCENARIOS: Scenario[] = [{
  id: 'data-model-explorer', title: 'Data model explorer', group: 'tool',
  description: 'Operator reads every table and view with its owners, keys and row-level-security scope, the objects shared across apps, the app integration map and the non-Postgres store inventories. Read-only.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/data-model-catalog.spec.ts' },
    { level: 'unit', path: 'tests/unit/data-model-ownership.spec.ts' },
    { level: 'unit', path: 'tests/unit/data-model-integration-map.spec.ts' },
    { level: 'unit', path: 'tests/unit/data-model-service.spec.ts' },
    { level: 'unit', path: 'tests/unit/data-model-page-model.spec.ts' },
    { level: 'unit', path: 'tests/unit/data-model-export.spec.ts' },
    { level: 'unit', path: 'tests/unit/data-model-drift.spec.ts' },
    { level: 'unit', path: 'tests/unit/internal-alert-producer.spec.ts' },
    { level: 'unit', path: 'tests/unit/schema-drift-monitor.spec.ts' },
    { level: 'unit', path: 'tests/unit/data-model-test-lab-registration.spec.ts' },
    { level: 'integration', path: 'tests/unit/data-model-catalog-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/data-model-alert-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/data-model-routes.spec.ts' },
    { level: 'browser', path: 'tests/unit/data-model-explorer-browser.spec.ts' },
    { level: 'browser', path: 'tests/unit/schema-drift-runtime-browser.spec.ts' },
  ],
  steps: [{ id: 'snapshot', app: APP, label: LABEL, run: snapshotStep }],
}];
