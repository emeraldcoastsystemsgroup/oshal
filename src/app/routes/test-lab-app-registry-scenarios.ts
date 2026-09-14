/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register multi-store discovery and its isolated installation/browser regression suites in the existing AI Test Lab.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Register explicit focused-application entry and host-default regression coverage.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Register the dependency-tier scenario: a read-only live step checks one install preview reports required/optional tiers with closed states and never offers an install the installer would refuse; its contract, installer and App Loader browser suites are attached.
 */
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

export const APP_REGISTRY_SCENARIOS: Scenario[] = [{
  id: 'multi-store-discovery', title: 'Application stores and source selection', group: 'tool',
  description: 'Read trusted store discovery. Local regression suites prove source replacement confirmation, legacy install refusal, dependency preservation and browser trust controls using disposable stores.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/app-registries.spec.ts' },
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
  id: 'focused-application-entry', title: 'Focused application entry', group: 'tool',
  description: 'Explicit root application links retain the selected application through redirect. Bare-host defaults remain intact and malformed selectors cannot supply a redirect destination.',
  regressionTests: [{ level: 'unit', path: 'tests/unit/host-app-map.spec.ts' }],
  steps: [{ id: 'runner', app: 'app-loader', label: 'Focused entry regressions', run: async () => ({
    app: 'app-loader', label: 'Focused entry regressions', state: 'degraded',
    detail: 'Run npx vitest run tests/unit/host-app-map.spec.ts locally. This Lab step does not execute host commands or change application access.',
  }) }],
}];
