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
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Register roster imports, delegated management roles and external business memberships with their isolated browser/database proofs.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Register the authorization schema-readiness recovery proof: a bootstrap that loses the pool acquire at boot must be retried by the next operation rather than refusing for the life of the process.
 * 8 | maintainer@emeraldcoastsystemsgroup.com | Register the joined access review - the one surface that answers "what am I allowed to do" across swarm role, governance permissions and per-application assignments - with a read-only self probe.
 * 9 | maintainer@emeraldcoastsystemsgroup.com | Register the package grant plan guards with the access-administration scenario: the resolver runs against the real PostgreSQL policy store and its HTTP adapter against the real routes, so the Lab lists them beside the rest of this feature. Also restores authorization-readiness-consumers.spec.ts to the test:authorization command - it was registered here but missing from the command, which had left this scenario's own registration assertion red on main.
 * 10 | maintainer@emeraldcoastsystemsgroup.com | Attach the principal-qualified app-access proofs beside package-plan and readiness regressions.
 * 11 | maintainer@emeraldcoastsystemsgroup.com | Register issuer pool reset, lifecycle authority and reviewed package assignment browser regressions.
 * 12 | maintainer@emeraldcoastsystemsgroup.com | Register the bot-role grant fail-loud proof beside the least-privilege shape guard: migration 099 wrapped every GRANT in an exception handler that degraded to a NOTICE, so the file recorded as applied whether or not the privileges landed. The new spec applies the real migration to a real disposable PostgreSQL as a real under-privileged login.
 * 13 | maintainer@emeraldcoastsystemsgroup.com | Register the bot statement privilege contract: the guard that provisions a real oshal_bot from the shipped grant text and runs every statement a bot container issues, which is what caught three open grant gaps that every existing guard over this contract was blind to.
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

/** @description Read the CALLER's own joined access review. Reads three authorities and changes none. */
async function accessReview(cookie: string): Promise<StepResult> {
  const label = 'Joined access review (self)';
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}/api/access-review`, {
    headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(20000), redirect: 'manual',
  });
  if (response.status !== 200) return {
    app: 'authorization', label, status: response.status,
    state: [401, 403, 503].includes(response.status) ? 'degraded' : response.status === 404 ? 'gap' : 'fail',
    detail: `Access review returned HTTP ${response.status}; a verified identity is required. It is a read-only view and attempted no change.`,
  };
  const data = await response.json() as Record<string, unknown>;
  const swarm = (data.swarm ?? {}) as Record<string, unknown>;
  const named = ['swarm-role', 'idp-claim', 'break-glass', 'none'].includes(String(swarm.source));
  const joined = named && Array.isArray(swarm.sources) && Array.isArray(data.permissions)
    && Array.isArray(data.apps) && typeof data.appsAvailable === 'boolean'
    && (data.apps as unknown[]).every(row => {
      const app = row as Record<string, unknown>;
      return typeof app.app === 'string' && typeof app.denied === 'boolean'
        && ['app-assignment', 'app-default', 'none'].includes(String(app.source));
    });
  return { app: 'authorization', label, state: joined ? 'pass' : 'fail',
    detail: joined ? `Swarm role ${String(swarm.role)} from ${String(swarm.source)}, ${(data.permissions as unknown[]).length} governance permissions and ${(data.apps as unknown[]).length} application rows, each naming its own grant source.`
      : 'The access review did not name the source of every grant it reported.' };
}

export const AUTHORIZATION_SCENARIOS: Scenario[] = [{
  id: 'authorization-management', title: 'Application access administration', group: 'tool',
  description: 'Read the current caller-visible authorization catalog. Isolated HTTP and browser suites prove identity, scope, CSRF, preview/apply and revocation behavior.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/authorization-management-roles.spec.ts' },
    { level: 'integration', path: 'tests/unit/authorization-management-roles-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/principal-registration.spec.ts' },
    { level: 'integration', path: 'tests/unit/external-tenant-memberships.spec.ts' },
    { level: 'unit', path: 'tests/unit/authorization-policy.spec.ts' },
    { level: 'unit', path: 'tests/unit/bot-db-least-privilege.spec.ts' },
    { level: 'integration', path: 'tests/unit/bot-role-grant-fail-loud-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/bot-statement-privilege-contract.spec.ts' },
    { level: 'integration', path: 'tests/unit/local-postgres-provisioning.spec.ts' },
    { level: 'unit', path: 'tests/unit/authorization-contract-files.spec.ts' },
    { level: 'integration', path: 'tests/unit/authorization-postgres-integration.spec.ts' },
    { level: 'integration', path: 'tests/unit/authorization-schema-recovery.spec.ts' },
    { level: 'integration', path: 'tests/unit/authorization-readiness-consumers.spec.ts' },
    { level: 'integration', path: 'tests/unit/authorization-runtime.spec.ts' },
    { level: 'integration', path: 'tests/unit/swarm-app-access-routes.spec.ts' },
    { level: 'integration', path: 'tests/unit/swarm-app-lifecycle-authorization.spec.ts' },
    { level: 'unit', path: 'tests/unit/guc-pool.spec.ts' },
    { level: 'unit', path: 'tests/unit/guc-pool-strict-identity.spec.ts' },
    { level: 'unit', path: 'tests/unit/app-access-tier.spec.ts' },
    { level: 'integration', path: 'tests/authorization-issuer-tier-live.spec.ts' },
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
    { level: 'integration', path: 'tests/unit/package-grant-plan-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/package-grant-plan-routes.spec.ts' },
    { level: 'browser', path: 'tests/unit/package-grant-browser.spec.ts' },
  ],
  steps: [{ id: 'catalog', app: 'authorization', label: 'Caller-visible access catalog', run: authorizationCatalog }],
}, {
  id: 'authorization-localhost-live', title: 'Localhost Users and Access acceptance', group: 'tool',
  description: 'Existing authenticated operator browser on an explicitly selected localhost or canonical HTTPS origin: deployed build, Users, Access, effective rights, audit and catalog probe. Run through the no-prune CDP harness with the expected commit; no account or grant changes.',
  regressionTests: [{ level: 'browser', path: 'tests/live/authorization-management.live.spec.ts' }],
  steps: [{ id: 'external-browser', app: 'authorization', label: 'Authenticated localhost browser required', run: async () => ({
    app: 'authorization', label: 'Authenticated localhost browser required', state: 'degraded',
    detail: 'Pending: run tests/live/authorization-management.live.spec.ts with playwright.live.config.ts, OSHAL_E2E_BASE_URL=http://localhost:35457 and an existing authenticated CDP browser. No browser tests ran from this Lab request.',
  }) }],
}, {
  id: 'access-review', title: 'What am I allowed to do', group: 'tool',
  description: 'Read the joined answer over the three authorization axes for the calling identity: swarm role and where it came from, governance permissions, and per-application assignments. Read-only; the route has no write member.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/access-review.spec.ts' },
    { level: 'browser', path: 'tests/unit/access-review-browser.spec.ts' },
  ],
  steps: [{ id: 'self', app: 'authorization', label: 'Joined access review (self)', run: accessReview }],
}];
