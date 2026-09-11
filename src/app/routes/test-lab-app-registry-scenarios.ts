/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register multi-store discovery and its isolated installation/browser regression suites in the existing AI Test Lab.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Register explicit focused-application entry and host-default regression coverage.
 */
import type { Scenario, StepResult } from './test-lab-scenarios';

/** Read catalog metadata with the initiating operator's cookie; never install or change trust. */
async function registryDiscovery(cookie: string): Promise<StepResult> {
  const base = `http://127.0.0.1:${process.env.PORT || '5000'}`;
  const read = async (path: string) => {
    const response = await fetch(base + path, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(30000) });
    const body: unknown = await response.json();
    const json = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    return { status: response.status, json };
  };
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
  id: 'focused-application-entry', title: 'Focused application entry', group: 'tool',
  description: 'Explicit root application links retain the selected application through redirect. Bare-host defaults remain intact and malformed selectors cannot supply a redirect destination.',
  regressionTests: [{ level: 'unit', path: 'tests/unit/host-app-map.spec.ts' }],
  steps: [{ id: 'runner', app: 'app-loader', label: 'Focused entry regressions', run: async () => ({
    app: 'app-loader', label: 'Focused entry regressions', state: 'degraded',
    detail: 'Run npx vitest run tests/unit/host-app-map.spec.ts locally. This Lab step does not execute host commands or change application access.',
  }) }],
}];
