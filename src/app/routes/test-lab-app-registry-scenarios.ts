/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register multi-store discovery and its isolated installation/browser regression suites in the existing AI Test Lab.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Register explicit focused-application entry and host-default regression coverage.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Attach the ADR-147 D10 fetch-fence suite to multi-store discovery: the hostname half of the fence is a registry-read behaviour, so it belongs to the scenario that reads registries rather than to a new live step - a Lab step that proved it would have to make the running swarm resolve a name into private space.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Register the catalog connector-readiness scenario. The applications page joins two token-free feeds - the bundle's declared providers from the app listing and the caller's own state from the connector broker - and a live step is the only place their AGREEMENT can be checked: a listing that predates the projection, or a broker that answers for nobody, both leave the catalog unable to tell connected from credential-needed. Read-only: it lists apps and reads the caller's own connector states, and never starts a consent flow or changes a connection.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Register the dependency-tier scenario: a read-only live step checks one install preview reports required/optional tiers with closed states and never offers an install the installer would refuse; its contract, installer and App Loader browser suites are attached.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Backlog #33: register the exact-SHA package-audit gate. Its live step runs the REAL installer in enforce mode for the first catalog package that carries an audited binding, into a disposable temporary directory (never deployed-apps, nothing loaded), and reports pass only for an exact audited pin; an attestation the configured store cannot serve or that no longer describes the catalog source reports a gap. The temporary directory is removed and its removal verified. The installer's real-Git evidence, stale-source and version suites are attached.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Scenario, StepResult } from './test-lab-scenarios';

/** GET a JSON API path with the initiating operator's cookie. */
function readerFor(cookie: string, timeoutMs = 30000) {
  const base = `http://127.0.0.1:${process.env.PORT || '5000'}`;
  return async (path: string) => {
    const response = await fetch(base + path, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(timeoutMs) });
    const body: unknown = await response.json();
    const json = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, any> : {};
    return { status: response.status, json };
  };
}

/** Read catalog metadata with the initiating operator's cookie; never install or change trust. */
async function registryDiscovery(cookie: string): Promise<StepResult> {
  const read = readerFor(cookie);
  const sources = await read('/api/swarm/registries');
  const result = (state: StepResult['state'], detail: string, status?: number): StepResult => ({ app: 'app-loader', label: 'Trusted store discovery', state, detail, ...(status ? { status } : {}) });
  if (sources.status !== 200) return result(sources.status === 404 ? 'gap' : [401, 403, 503].includes(sources.status) ? 'degraded' : 'fail', `Registry read returned HTTP ${sources.status}. Administrator access is required.`, sources.status);
  if (!Array.isArray(sources.json.registries)) return result('fail', 'Registry response is missing registries[].');
  const trusted = new Set(sources.json.registries.filter((registry: any) => registry.enabled && registry.trustState === 'trusted').map((registry: any) => registry.slug));
  const catalog = await read('/api/swarm/registries/catalog');
  if (catalog.status !== 200) return result([401, 403, 503].includes(catalog.status) ? 'degraded' : 'fail', `Catalog returned HTTP ${catalog.status}.`, catalog.status);
  if (!Array.isArray(catalog.json.apps) || !Array.isArray(catalog.json.sources)) return result('fail', 'Catalog response is missing apps[] or sources[].');
  const identities = new Set<string>();
  for (const app of catalog.json.apps) {
    const key = `${app.registry}/${app.name}`;
    if (!trusted.has(app.registry) || typeof app.name !== 'string' || identities.has(key)) return result('fail', 'Catalog has an untrusted source or duplicate registry/package identity.');
    identities.add(key);
  }
  if (catalog.json.sources.some((source: any) => !trusted.has(source.slug))) return result('fail', 'Catalog exposes a disabled or revoked source.');
  if (!trusted.size || catalog.json.sources.some((source: any) => !source.ok)) return result('degraded', 'No trusted store is configured, or one of the configured stores is unavailable.');
  return result('pass', 'Catalog preserves registry/package identities and includes only enabled trusted sources. Installation and trust changes are covered by isolated local regression suites.');
}

const DEPENDENCY_STATES = new Set(['installed', 'core', 'available', 'unavailable']);

/**
 * Read one package's install preview (a sparse read of its manifest — nothing installs) and check
 * the dependency-tier contract: both tiers present, every app state from the closed set, and no
 * Install offered when a required app cannot resolve or the block is invalid.
 */
async function dependencyTierPreview(cookie: string): Promise<StepResult> {
  const read = readerFor(cookie, 90000);
  const result = (state: StepResult['state'], detail: string, status?: number): StepResult => ({ app: 'app-loader', label: 'Dependency tiers in the install preview', state, detail, ...(status ? { status } : {}) });
  const catalog = await read('/api/swarm/registries/catalog');
  if (catalog.status !== 200) return result([401, 403, 503].includes(catalog.status) ? 'degraded' : 'fail', `Catalog returned HTTP ${catalog.status}.`, catalog.status);
  const candidate = (Array.isArray(catalog.json.apps) ? catalog.json.apps : []).find((app: any) => app.status === 'ready');
  if (!candidate) return result('degraded', 'No trusted store publishes an installable package to preview.');
  const preview = await read(`/api/swarm/registries/${encodeURIComponent(candidate.registry)}/preview/${encodeURIComponent(candidate.name)}`);
  if (preview.status !== 200) return result([401, 403, 503].includes(preview.status) ? 'degraded' : 'fail', `Preview returned HTTP ${preview.status}.`, preview.status);
  const deps = preview.json.impact?.dependencies;
  if (!deps || Array.isArray(deps)) return result('gap', 'The running API reports one flat dependency list — it predates required/optional tiers (needs a core deploy).');
  const apps = [...(deps.required?.apps ?? []), ...(deps.optional?.apps ?? [])];
  if (!deps.required || !deps.optional || apps.some((app: any) => !DEPENDENCY_STATES.has(app?.state))) return result('fail', 'Preview dependencies are missing a tier or carry an unknown app state.');
  const refusable = deps.required.apps.some((app: any) => app.state === 'unavailable') || (deps.problems ?? []).length > 0;
  if (refusable && preview.json.install?.allowed) return result('fail', `${candidate.registry}/${candidate.name}: the preview offers an install the installer would refuse.`);
  return result('pass', `${candidate.registry}/${candidate.name}: ${deps.required.apps.length} required and ${deps.optional.apps.length} optional app(s) resolved; nothing was installed. Installer and browser behaviour are covered by the attached local suites.`);
}

/**
 * @description Read the two token-free feeds the applications catalog joins — the app listing's
 * declared providers and the caller's own connector states — and check they can actually answer
 * the question the catalog asks. Strictly read-only: no consent flow, no install, no trust change.
 * @param cookie - The initiating operator's session cookie.
 * @returns The step result, degraded when either feed is unreadable on this box.
 */
async function catalogConnectorReadiness(cookie: string): Promise<StepResult> {
  const read = readerFor(cookie);
  const result = (state: StepResult['state'], detail: string, status?: number): StepResult => ({ app: 'applications', label: 'Bundle providers and their live state', state, detail, ...(status ? { status } : {}) });
  const apps = await read('/api/swarm/apps');
  if (apps.status !== 200) return result([401, 403, 503].includes(apps.status) ? 'degraded' : 'fail', `Application listing returned HTTP ${apps.status}.`, apps.status);
  const rows = Array.isArray(apps.json.apps) ? apps.json.apps : [];
  if (!rows.length) return result('degraded', 'No applications are loaded, so no bundle declares providers to check.');
  const projected = rows.filter((app: any) => Array.isArray(app?.connectors?.required) && Array.isArray(app?.connectors?.optional));
  if (projected.length !== rows.length) return result('gap', 'The running listing carries no connectors block — it predates the projection (needs a core deploy).');
  const connect = await read('/api/connect/list');
  if (connect.status !== 200) return result([401, 403, 503].includes(connect.status) ? 'degraded' : 'fail', `Connector list returned HTTP ${connect.status}.`, connect.status);
  const providers = Array.isArray(connect.json.providers) ? connect.json.providers : null;
  if (!providers) return result('fail', 'Connector list response is missing providers[].');
  const known = new Map(providers.filter((p: any) => typeof p?.id === 'string').map((p: any) => [p.id, p]));
  const declared = new Set<string>(projected.flatMap((app: any) => [...app.connectors.required, ...app.connectors.optional]));
  if (providers.some((p: any) => 'access_token' in p || 'refresh_token' in p)) return result('fail', 'The connector list carries a token field; the catalog must only ever read status.');
  const offered = [...declared].filter((id) => known.has(id));
  const bundles = projected.filter((app: any) => app.connectors.required.length + app.connectors.optional.length > 0).length;
  if (!declared.size) return result('degraded', `${rows.length} application(s) are loaded and none declares a connector, so no bundle has a connection state to report.`);
  return result('pass', `${bundles} bundle(s) declare ${declared.size} provider id(s); ${offered.length} are offered by this deployment's broker and the rest render as unavailable here. Nothing was connected or changed.`);
}

const UNAUDITED = '0'.repeat(40);
const AUDIT_LABEL = 'Exact-SHA install in enforce mode';

/** One catalog package, as the exact-SHA step needs it. */
export interface AuditedCatalogPackage {
  name: string;
  status: string;
  source: { url: string; ref: string } | null;
  audit: { sourceSha: string } | null;
}

/** What one disposable installer run produced. */
export interface AuditInstallRun {
  code: number;
  output: string;
  provenance: { sha?: string; audit?: { mode?: string; verified?: boolean; sourceSha?: string | null } } | null;
}

/**
 * @description Judge one disposable enforce-mode install. Pass only for an exact audited pin (the
 * installed commit IS the catalog's audited SHA); an attestation the store cannot serve or that
 * no longer matches the catalog source is a gap in the promoted catalog, not an installer defect.
 * @param pkg - The catalog package that was installed.
 * @param run - Installer exit code, combined output, and the provenance stamp when it installed.
 * @returns The step state and a one-sentence detail.
 */
export function packageAuditInstallVerdict(pkg: AuditedCatalogPackage, run: AuditInstallRun): Pick<StepResult, 'state' | 'detail'> {
  const expected = pkg.audit?.sourceSha;
  if (run.code === 0) {
    const pinned = run.provenance?.audit?.mode === 'enforce' && run.provenance.audit.verified === true
      && run.provenance.sha === expected && run.provenance.audit.sourceSha === expected;
    return pinned
      ? { state: 'pass', detail: `${pkg.name} installed from exactly its audited commit ${String(expected).slice(0, 12)} in enforce mode, into a temporary directory that was then removed.` }
      : { state: 'fail', detail: `${pkg.name} installed in enforce mode without an exact audited pin; the provenance does not name ${String(expected).slice(0, 12)}.` };
  }
  const reason = run.output.split('\n').map((line) => line.trim()).find((line) => /re-audit|cannot be read from this store|changed since the audit/.test(line));
  if (reason) return { state: 'gap', detail: `${pkg.name}: enforce mode refused it because the catalog's attestation is not bound to this store's source (${reason.slice(0, 240)}).` };
  if (/install failed:/.test(run.output)) return { state: 'degraded', detail: `${pkg.name}: the installer could not reach the store (${run.output.split('\n').find((line) => /install failed:/.test(line))?.trim().slice(0, 240)}).` };
  return { state: 'fail', detail: `${pkg.name}: enforce mode refused an attestation the catalog publishes as audited (${run.output.split('\n').find((line) => line.trim())?.trim().slice(0, 240) ?? 'no output'}).` };
}

/** Run the canonical installer CLI for one package into a disposable destination. */
async function runAuditedInstaller(pkg: AuditedCatalogPackage, destination: string): Promise<AuditInstallRun> {
  const { buildRemoteAppInstallerProcessEnv } = await import('./app-store-remote');
  const { resolveStoreToken } = await import('./update-check-cron');
  const args = [path.join(process.cwd(), 'scripts', 'oshal-app.js'), 'install', pkg.name,
    '--repo', pkg.source!.url, '--ref', pkg.source!.ref, '--dest', destination, '--audit-mode', 'enforce'];
  const env = { ...buildRemoteAppInstallerProcessEnv(resolveStoreToken()), OSHAL_PACKAGE_AUDIT_MODE: 'enforce' };
  const outcome = await new Promise<{ code: number; output: string }>((resolve) => {
    execFile(process.execPath, args, { cwd: process.cwd(), timeout: 180_000, maxBuffer: 1024 * 1024, env }, (err, stdout, stderr) => {
      const raw = err ? (err as NodeJS.ErrnoException).code : 0;
      resolve({ code: typeof raw === 'number' ? raw : (err ? 1 : 0), output: `${stdout}\n${stderr}` });
    });
  });
  const stamp = path.join(destination, pkg.name, '.oshal-install.json');
  const provenance = outcome.code === 0 && existsSync(stamp) ? JSON.parse(readFileSync(stamp, 'utf8')) : null;
  return { ...outcome, provenance };
}

/** Collaborators the exact-SHA step uses; tests replace them, the Lab uses the real ones. */
export interface PackageAuditStepDeps {
  catalog: () => Promise<{ available: boolean; reason?: string; apps: AuditedCatalogPackage[] }>;
  install: (pkg: AuditedCatalogPackage, destination: string) => Promise<AuditInstallRun>;
  tempRoot: string;
}

/** The real collaborators: the configured store catalog, the canonical installer, the OS temp dir. */
async function defaultPackageAuditDeps(): Promise<PackageAuditStepDeps> {
  const { fetchStoreCatalog } = await import('./app-store-remote');
  return { catalog: () => fetchStoreCatalog(true), install: runAuditedInstaller, tempRoot: os.tmpdir() };
}

/**
 * @description Install the first audited catalog package in enforce mode into a disposable
 * temporary directory, judge the pin, and remove the directory. Nothing is deployed or loaded;
 * incomplete cleanup fails the step.
 * @param deps - Injected collaborators (defaults to the real catalog, installer and temp dir).
 * @returns The step result.
 */
export async function exactShaEnforceInstall(deps?: PackageAuditStepDeps): Promise<StepResult> {
  const use = deps ?? await defaultPackageAuditDeps();
  const result = (state: StepResult['state'], detail: string): StepResult => ({ app: 'app-loader', label: AUDIT_LABEL, state, detail });
  const catalog = await use.catalog();
  if (!catalog.available) return result('degraded', `Store catalog unavailable: ${catalog.reason ?? 'unknown reason'}.`);
  const pkg = catalog.apps.find((app) => app.status === 'ready' && app.source && app.audit
    && /^[0-9a-f]{40}$/.test(app.audit.sourceSha) && app.audit.sourceSha !== UNAUDITED);
  if (!pkg) return result('gap', 'No installable package in the configured store catalog carries an audited binding yet, so enforce mode would refuse every install.');
  const destination = mkdtempSync(path.join(use.tempRoot, 'oshal-lab-package-audit-'));
  let verdict: Pick<StepResult, 'state' | 'detail'>;
  try {
    verdict = packageAuditInstallVerdict(pkg, await use.install(pkg, destination));
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
  if (existsSync(destination)) return result('fail', `Cleanup incomplete: ${destination} still exists after the disposable install.`);
  return result(verdict.state, verdict.detail);
}

export const APP_REGISTRY_SCENARIOS: Scenario[] = [{
  id: 'multi-store-discovery', title: 'Application stores and source selection', group: 'tool',
  description: 'Read trusted store discovery. Local regression suites prove source replacement confirmation, legacy install refusal, dependency preservation, browser trust controls and the fetch fence (a registry hostname that resolves into private space is refused, and the approved address is what the connection reaches) using disposable stores and a local DNS server.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/app-registries.spec.ts' },
    { level: 'unit', path: 'tests/unit/app-registry-dns-fence.spec.ts' },
    { level: 'integration', path: 'tests/unit/multi-store-installer.spec.ts' },
    { level: 'browser', path: 'tests/unit/multi-store-routes-browser.spec.ts' },
  ],
  steps: [{ id: 'catalog', app: 'app-loader', label: 'Trusted store discovery', run: registryDiscovery }],
}, {
  id: 'app-dependency-tiers', title: 'Required and optional app dependencies', group: 'tool',
  description: 'Read one install preview and check it reports required and optional dependency tiers without offering an install the installer would refuse. Local suites prove the contract, the installer (required fail-closed, optional only when chosen, uninstall blocked only by required dependents) and the App Loader checkboxes plus dependency hot-loading against a disposable store.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/app-dependencies-contract.spec.ts' },
    { level: 'integration', path: 'tests/unit/app-dependencies-installer.spec.ts' },
    { level: 'browser', path: 'tests/unit/app-dependencies-loader-browser.spec.ts' },
  ],
  steps: [{ id: 'preview', app: 'app-loader', label: 'Dependency tiers in the install preview', run: dependencyTierPreview }],
}, {
  id: 'app-catalog-connector-readiness', title: 'Bundle providers in the applications catalog', group: 'tool',
  description: 'Read the two token-free feeds the applications catalog joins and check they agree: every listed application carries its declared provider ids, and the connector broker answers with per-provider state and no token. Local suites prove the verdict itself (connected, credential-needed, unavailable here, and unknown when the broker cannot be read) and that the page renders each one in a real browser.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/app-catalog-connector-readiness.spec.ts' },
    { level: 'browser', path: 'tests/unit/app-catalog-connectors-browser.spec.ts' },
  ],
  steps: [{ id: 'readiness', app: 'applications', label: 'Bundle providers and their live state', run: catalogConnectorReadiness }],
}, {
  id: 'focused-application-entry', title: 'Focused application entry', group: 'tool',
  description: 'Explicit root application links retain the selected application through redirect. Bare-host defaults remain intact and malformed selectors cannot supply a redirect destination.',
  regressionTests: [{ level: 'unit', path: 'tests/unit/host-app-map.spec.ts' }],
  steps: [{ id: 'runner', app: 'app-loader', label: 'Focused entry regressions', run: async () => ({
    app: 'app-loader', label: 'Focused entry regressions', state: 'degraded',
    detail: 'Run npx vitest run tests/unit/host-app-map.spec.ts locally. This Lab step does not execute host commands or change application access.',
  }) }],
}, {
  id: 'package-audit-exact-sha', title: 'Exact-SHA package audit gate', group: 'tool',
  // It clones a package over the network and installs it (into a temporary directory), so it runs from its own card only.
  explicitOnly: true,
  description: 'Install the first store package that carries an audited binding with the real installer in enforce mode, into a disposable temporary directory that is removed afterwards; nothing is deployed or loaded. Pass means the installed commit is exactly the audited one. A gap means the catalog publishes an attestation this store cannot prove (its audited commit is not served here, or the package source changed after the audit). Local real-Git suites prove the evidence re-hash, the stale-source and version refusals, and the unpinned compatible fallback.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/package-audit-installer.spec.ts' },
    { level: 'unit', path: 'tests/unit/app-package-audit-boundaries.spec.ts' },
    { level: 'unit', path: 'tests/unit/test-lab-package-audit-registration.spec.ts' },
  ],
  steps: [{ id: 'enforce-install', app: 'app-loader', label: 'Exact-SHA install in enforce mode', run: () => exactShaEnforceInstall() }],
}];
