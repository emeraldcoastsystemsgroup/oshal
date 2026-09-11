/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register authorization boundary, shared-service and browser regression tests with a read-only live catalog probe.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Register verified Google/Microsoft/local principal adoption and account continuity coverage.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Register existing-account administration, root credential protection and browser controls.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Register real authenticated localhost browser acceptance separately from the fixed isolated regression runner.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Register disposable PostgreSQL role provisioning and repeat-bootstrap integration coverage.
 */
import type { Scenario, StepResult } from './test-lab-scenarios';

/** @description Validate only the current caller's visible metadata; never create a preview or change a grant. */
async function authorizationCatalog(cookie: string): Promise<StepResult> {
  const label = 'Access Administration catalog';
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}/api/authorization/catalog`, {
    headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(20000), redirect: 'manual',
  });
  if (response.status !== 200) return {
    app: 'authorization', label, status: response.status,
    state: [401, 403, 503].includes(response.status) ? 'degraded' : response.status === 404 ? 'gap' : 'fail',
    detail: `Access catalog returned HTTP ${response.status}; a verified identity with administration read scope is required. No access changes were attempted.`,
  };
  const data = await response.json() as Record<string, unknown>;
  const valid = Number.isSafeInteger(data.revision) && Number(data.revision) >= 0 && Array.isArray(data.apps)
    && data.apps.every((app: unknown) => {
      if (!app || typeof app !== 'object') return false;
      const entry = app as Record<string, unknown>;
      return typeof entry.app === 'string' && typeof entry.source === 'string'
        && typeof entry.catalogRevision === 'string' && typeof entry.version === 'string'
        && ['catalog', 'admin-required', 'legacy'].includes(String(entry.status));
    });
  return { app: 'authorization', label, state: valid ? 'pass' : 'fail',
    detail: valid ? 'Caller-visible app metadata, source and policy revision verified. No grants, previews or business data were accessed.'
      : 'Access catalog is missing application provenance or policy revision metadata.' };
}

export const AUTHORIZATION_SCENARIOS: Scenario[] = [{
  id: 'authorization-management', title: 'Application access administration', group: 'tool',
  description: 'Read the current caller-visible authorization catalog. Isolated HTTP and browser suites prove identity, scope, CSRF, preview/apply and revocation behavior.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/authorization-policy.spec.ts' },
    { level: 'unit', path: 'tests/unit/bot-db-least-privilege.spec.ts' },
    { level: 'integration', path: 'tests/unit/local-postgres-provisioning.spec.ts' },
    { level: 'unit', path: 'tests/unit/authorization-contract-files.spec.ts' },
    { level: 'integration', path: 'tests/unit/authorization-postgres-integration.spec.ts' },
    { level: 'integration', path: 'tests/unit/authorization-runtime.spec.ts' },
    { level: 'integration', path: 'tests/unit/swarm-app-access-routes.spec.ts' },
    { level: 'unit', path: 'tests/unit/kernel-skills.spec.ts' },
    { level: 'integration', path: 'tests/unit/authorization-execution-boundary.spec.ts' },
    { level: 'integration', path: 'tests/unit/installer-root-bootstrap.spec.ts' },
    { level: 'integration', path: 'tests/unit/local-auth-routes.spec.ts' },
    { level: 'integration', path: 'tests/unit/authorization-tool.spec.ts' },
    { level: 'unit', path: 'tests/unit/authorization-tool-policy.spec.ts' },
    { level: 'integration', path: 'tests/unit/authorization-routes.spec.ts' },
    { level: 'browser', path: 'tests/unit/authorization-admin-browser.spec.ts' },
    { level: 'integration', path: 'tests/unit/authorization-identity-integration.spec.ts' },
    { level: 'unit', path: 'tests/unit/authorization-principal.spec.ts' },
    { level: 'integration', path: 'tests/unit/principal-directory.spec.ts' },
    { level: 'integration', path: 'tests/unit/local-account-administration.spec.ts' },
    { level: 'browser', path: 'tests/unit/users-administration-browser.spec.ts' },
    { level: 'integration', path: 'tests/unit/local-auth-forgot-password.spec.ts' },
    { level: 'integration', path: 'tests/unit/authorization-audit.spec.ts' },
    { level: 'browser', path: 'tests/unit/authorization-audit-browser.spec.ts' },
  ],
  steps: [{ id: 'catalog', app: 'authorization', label: 'Caller-visible access catalog', run: authorizationCatalog }],
}, {
  id: 'authorization-localhost-live', title: 'Localhost Users and Access acceptance', group: 'tool',
  description: 'Existing authenticated operator browser on localhost:35457: deployed build, Users, Access, effective rights, audit and catalog probe. Run explicitly through the no-prune CDP harness; no account or grant changes.',
  regressionTests: [{ level: 'browser', path: 'tests/live/authorization-management.live.spec.ts' }],
  steps: [{ id: 'external-browser', app: 'authorization', label: 'Authenticated localhost browser required', run: async () => ({
    app: 'authorization', label: 'Authenticated localhost browser required', state: 'degraded',
    detail: 'Pending: run tests/live/authorization-management.live.spec.ts with playwright.live.config.ts, OSHAL_E2E_BASE_URL=http://localhost:35457 and an existing authenticated CDP browser. No browser tests ran from this Lab request.',
  }) }],
}];
