/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The regression guard for the applications page as a swarm CATALOG. The page could separate installed from available from source-unavailable and nothing else: it never read the connector broker, so "connected" and "credential-needed" were states it could not express. These cases run the REAL projections end to end - a real manifest through the real toSummary, a real marketplace.json document through the real parseCatalog, and real connector rows through the real buildConnectorListResponse that GET /api/connect/list serializes - into the REAL page decision. A projection that stops emitting `connectors`, a broker key that gets renamed, or a verdict that starts guessing turns this red. The honesty case is the one that matters most: when the broker cannot be read the verdict must be `unknown`, never `credential-needed`, because a page that turns an outage into "you have not connected anything" is worse than one that admits it does not know.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { readManifest } from '../../src/features/swarm-apps';
import { declaredConnectors, toSummary } from '../../src/features/swarm-apps/services/swarm-app-record-view';
import { parseCatalog } from '../../src/app/routes/app-store-remote';
import { buildConnectorListResponse } from '../../src/app/routes/connector-response-helpers';
import type { ConnectionRow } from '../../src/app/routes/connector-tenancy';
import {
  bundleConnectors, bundleReadiness, connectorState, indexProviders, readinessRank,
} from '../../src/pages/applications/js/app-connector-readiness.js';
import type { SwarmAppManifest, SwarmApplicationRecord, SwarmApplicationSummary } from '../../src/features/swarm-apps/types';

const REPO_ROOT = join(__dirname, '..', '..');
const PAGE = join(REPO_ROOT, 'src', 'pages', 'applications', 'index.html');

/**
 * @description Project a manifest through the REAL listing projection, so a summary that stops
 * carrying `connectors` fails here rather than silently rendering every row without providers.
 * @param manifest - A manifest (real file, or a declaration under test).
 * @returns The summary entry GET /api/swarm/apps serializes.
 */
function summaryFor(manifest: SwarmAppManifest): SwarmApplicationSummary {
  const record = {
    name: manifest.name, displayName: manifest.displayName, description: manifest.description ?? '',
    version: manifest.version ?? '1.0.0', status: 'active', agentIds: [], toolNames: [], manifest,
    manifestPath: join(REPO_ROOT, 'swarm-apps', `${manifest.name}.yaml`),
    loadedAt: new Date(0), updatedAt: new Date(0), scope: 'public', ownerSub: null, tenantId: null,
  } as unknown as SwarmApplicationRecord;
  return toSummary(record, null);
}

/**
 * @description A manifest declaring connectors in the TIERED form every current store package uses.
 * @param required - Provider ids the bundle cannot do its job without.
 * @param optional - Provider ids it works without.
 * @returns A manifest for {@link summaryFor}.
 */
function tiered(required: string[], optional: string[]): SwarmAppManifest {
  return {
    name: 'fixture-bundle', displayName: 'Fixture bundle', version: '1.0.0',
    uses: ['app-dependencies'],
    dependencies: { required: { apps: [], tools: [], connectors: required }, optional: { apps: [], tools: [], connectors: optional } },
  } as unknown as SwarmAppManifest;
}

/**
 * @description One stored connector row, as the broker's accessibleConnections query returns it.
 * @param provider - Provider id.
 * @param expiry - Token expiry; a past date with no refresh token is what makes a row expired.
 * @returns The row buildConnectorListResponse projects.
 */
function row(provider: string, expiry: Date | null = null): ConnectionRow {
  return {
    connection_id: `${provider}-1`, user_sub: 'user-1', connected_by_sub: 'user-1', tenant_id: null,
    provider, label: null, account_key: 'a', is_default: true, account_email: 'person@example.test',
    // Deliberately null: the /list projection never reads a token, and a fixture carrying one
    // would be a credential-shaped literal in a tracked file for no behavioural gain.
    account_id: 'a', scopes: null, access_token: null, refresh_token: null,
    expiry, created_at: new Date(0),
  };
}

/**
 * @description Build the page's provider index from the REAL /api/connect/list projection, so the
 * guard consumes exactly the body the route serializes (`res.json({ providers: ... })`).
 * @param rows - The caller's accessible connector rows.
 * @returns The index the page decision reads.
 */
function brokerIndex(rows: ConnectionRow[]) {
  return indexProviders({ providers: buildConnectorListResponse(rows) });
}

/** A marketplace.json document in the exact DUAL shape the store generator emits today: the
 *  tiered block plus a flat compatibility copy of it. Only the shared contract knows which wins. */
const STORE_DOC = JSON.stringify({
  apps: [
    {
      name: 'fixture-home', displayName: 'Fixture Home', description: 'Home control', suite: 'ai-home',
      version: '1.0.0', status: 'ready',
      dependencies: {
        apps: [], tools: [], connectors: ['smartthings', 'google-home'],
        required: { apps: [], tools: [], connectors: [] },
        optional: { apps: [], tools: [], connectors: ['smartthings', 'google-home'] },
      },
      source: { type: 'git-subdir', url: 'https://github.com/example/store', path: 'fixture-home', ref: 'main' },
      audit: { record: 'audits/fixture-home.json', sourceSha: '0'.repeat(40) },
    },
    {
      // A pre-tiers entry: the legacy FLAT form alone, which the contract reads as all-required.
      name: 'fixture-movies', displayName: 'Fixture Movies', description: 'Catalog', suite: 'ai-creative',
      version: '2.0.0', status: 'ready',
      dependencies: { apps: [], tools: [], connectors: ['tmdb'] },
      source: { type: 'git-subdir', url: 'https://github.com/example/store', path: 'fixture-movies', ref: 'main' },
      audit: { record: 'audits/fixture-movies.json', sourceSha: '0'.repeat(40) },
    },
    { name: 'fixture-bare', displayName: 'Fixture Bare', description: 'No providers', suite: 'platform', version: '1.0.0', status: 'ready' },
  ],
});

beforeEach(() => {
  vi.unstubAllEnvs();
  // A deployment that HAS registered a SmartThings OAuth client and a shared TMDB catalog key,
  // and has NOT registered a Google Home Device Access client. Those three postures are exactly
  // what separates "credential needed" from "connected" from "unavailable here".
  vi.stubEnv('SMARTTHINGS_CLIENT_ID', 'fixture-client');
  vi.stubEnv('SMARTTHINGS_CLIENT_SECRET', 'fixture-secret');
  vi.stubEnv('TMDB_API_KEY', 'fixture-shared-key');
  vi.stubEnv('GOOGLE_HOME_CLIENT_ID', '');
  vi.stubEnv('GOOGLE_HOME_CLIENT_SECRET', '');
});

describe('the listing summary carries what a bundle plugs into', () => {
  it('projects both dependency tiers onto every real core manifest, never undefined', () => {
    const manifests = ['jarvis.yaml', 'intelligent-operations.yaml', 'intelligent-processing.yaml', 'devops.yaml']
      .map((file) => readManifest(join(REPO_ROOT, 'swarm-apps', file)));
    expect(manifests.length).toBeGreaterThan(0);
    for (const manifest of manifests) {
      const summary = summaryFor(manifest);
      expect(Array.isArray(summary.connectors.required)).toBe(true);
      expect(Array.isArray(summary.connectors.optional)).toBe(true);
    }
  });

  it('reads the tiered form and the legacy flat form through the one shared contract', () => {
    expect(summaryFor(tiered(['smartthings'], ['google-home'])).connectors)
      .toEqual({ required: ['smartthings'], optional: ['google-home'] });
    const legacy = { name: 'legacy', displayName: 'Legacy', dependencies: { apps: [], tools: [], connectors: ['tmdb'] } };
    // The flat form is all-required — that is the contract's rule, and a second reader of the raw
    // keys would have to re-invent it and would eventually disagree with the installer.
    expect(declaredConnectors(legacy as unknown as SwarmAppManifest)).toEqual({ required: ['tmdb'], optional: [] });
  });

  it('never lists a provider in both tiers, and survives a malformed block instead of throwing', () => {
    expect(declaredConnectors(tiered(['smartthings'], ['smartthings', 'google-home'])))
      .toEqual({ required: ['smartthings'], optional: ['google-home'] });
    const broken = { name: 'broken', displayName: 'Broken', dependencies: 'not-a-mapping' };
    expect(declaredConnectors(broken as unknown as SwarmAppManifest)).toEqual({ required: [], optional: [] });
    expect(declaredConnectors(undefined)).toEqual({ required: [], optional: [] });
  });

  it('gives a store catalog entry the same shape as an installed one, from the real parser', () => {
    const catalog = parseCatalog(STORE_DOC);
    const home = catalog.find((entry) => entry.name === 'fixture-home')!;
    const movies = catalog.find((entry) => entry.name === 'fixture-movies')!;
    const bare = catalog.find((entry) => entry.name === 'fixture-bare')!;
    // The dual block: tiered wins, so these are OPTIONAL — not required, which the flat copy says.
    expect(home.connectors).toEqual({ required: [], optional: ['smartthings', 'google-home'] });
    expect(movies.connectors).toEqual({ required: ['tmdb'], optional: [] });
    expect(bare.connectors).toEqual({ required: [], optional: [] });
    expect(bundleConnectors(home)).toEqual([
      { id: 'smartthings', tier: 'optional' }, { id: 'google-home', tier: 'optional' },
    ]);
  });
});

describe('provider state comes from the broker, through the response the route really sends', () => {
  it('reports a live connection as connected and an expired-only one as needing reconnect', () => {
    const live = brokerIndex([row('smartthings')]);
    expect(connectorState('smartthings', live)).toBe('connected');
    const dead = brokerIndex([row('smartthings', new Date(Date.now() - 60_000))]);
    expect(connectorState('smartthings', dead)).toBe('expired');
  });

  it('separates a connector this deployment can offer from one it cannot', () => {
    const index = brokerIndex([]);
    expect(connectorState('smartthings', index)).toBe('needs-credential'); // client registered, nobody connected
    expect(connectorState('google-home', index)).toBe('unavailable');      // no OAuth client on this box
    expect(connectorState('tmdb', index)).toBe('platform');                // shared catalog key, no login needed
    expect(connectorState('not-a-real-provider', index)).toBe('unavailable');
  });

  it('says unknown — never "not connected" — when the broker could not be read', () => {
    expect(indexProviders(null)).toBeNull();
    expect(indexProviders({})).toBeNull();
    expect(indexProviders({ providers: 'nope' } as unknown as { providers: [] })).toBeNull();
    expect(connectorState('smartthings', null)).toBe('unknown');
  });
});

describe('the catalog verdict a row renders', () => {
  it('distinguishes connected, credential-needed and unavailable from the same declaration', () => {
    const bundle = summaryFor(tiered(['smartthings'], []));
    expect(bundleReadiness(bundle, brokerIndex([row('smartthings')])).state).toBe('connected');
    expect(bundleReadiness(bundle, brokerIndex([])).state).toBe('credential-needed');
    expect(bundleReadiness(bundle, brokerIndex([row('smartthings', new Date(Date.now() - 60_000))])).state)
      .toBe('credential-needed');
    expect(bundleReadiness(summaryFor(tiered(['google-home'], [])), brokerIndex([])).state).toBe('unavailable');
  });

  it('names the providers behind the verdict instead of asserting a bare state', () => {
    const waiting = bundleReadiness(summaryFor(tiered(['smartthings'], [])), brokerIndex([]));
    expect(waiting.badge).toEqual({ label: 'credential needed', tone: 'warn' });
    expect(waiting.title).toContain('SmartThings');
    const blocked = bundleReadiness(summaryFor(tiered(['google-home'], [])), brokerIndex([]));
    expect(blocked.badge?.label).toBe('unavailable here');
    // The broker's own label, not the manifest id: an operator searches for what the Connectors
    // screen calls it, and the page must not invent a friendlier name for a provider.
    expect(blocked.title).toContain('Google Nest (Home)');
  });

  it('does not let an OPTIONAL provider this box cannot offer condemn a working bundle', () => {
    // The shipped shape of the home package: both providers optional, one of them unregistered here.
    const home = summaryFor(tiered([], ['smartthings', 'google-home']));
    expect(bundleReadiness(home, brokerIndex([row('smartthings')])).state).toBe('connected');
    const states = bundleReadiness(home, brokerIndex([row('smartthings')])).providers.map((p) => p.state);
    expect(states).toEqual(['connected', 'unavailable']);
  });

  it('treats a shared platform key as connected, because nothing is left for the user to do', () => {
    const movies = summaryFor(tiered(['tmdb'], []));
    expect(bundleReadiness(movies, brokerIndex([])).state).toBe('connected');
    vi.stubEnv('TMDB_API_KEY', '');
    vi.stubEnv('THEMOVIEDB_API_READ_ACCESS_TOKEN', '');
    vi.stubEnv('THEMOVIEDB_API_KEY', '');
    expect(bundleReadiness(movies, brokerIndex([])).state).toBe('credential-needed');
  });

  it('stays silent for a bundle that plugs into nothing', () => {
    const bare = bundleReadiness(summaryFor(tiered([], [])), brokerIndex([]));
    expect(bare.state).toBe('none');
    expect(bare.badge).toBeNull();
    expect(bare.title).toBe('');
    expect(bare.providers).toEqual([]);
  });

  // THE HONESTY CASE. An unreadable broker used to be indistinguishable from "connected nothing".
  it('never claims connected or credential-needed when the broker is unreadable', () => {
    for (const bundle of [tiered(['smartthings'], []), tiered([], ['google-home']), tiered(['tmdb'], [])]) {
      const readiness = bundleReadiness(summaryFor(bundle), indexProviders(null));
      expect(readiness.state).toBe('unknown');
      expect(readiness.badge?.label).toBe('connections unknown');
      expect(readiness.title).not.toMatch(/connected|waiting on/i);
      expect(readiness.providers.every((p) => p.state === 'unknown')).toBe(true);
    }
  });

  it('ranks the verdicts so a surface can order rows without re-stating the precedence', () => {
    expect(readinessRank('unknown')).toBeLessThan(readinessRank('unavailable'));
    expect(readinessRank('unavailable')).toBeLessThan(readinessRank('credential-needed'));
    expect(readinessRank('credential-needed')).toBeLessThan(readinessRank('connected'));
    expect(readinessRank('connected')).toBeLessThan(readinessRank('none'));
  });
});

describe('the catalog page reads the shared decision rather than deciding inline', () => {
  const script = readFileSync(PAGE, 'utf8').replace(/<!--[\s\S]*?-->/g, '');

  it('imports the readiness module, which exists on disk', () => {
    expect(script).toMatch(/import\s*\{[^}]*bundleReadiness[^}]*\}\s*from\s*'\/applications\/js\/app-connector-readiness\.js'/);
    expect(existsSync(join(REPO_ROOT, 'src', 'pages', 'applications', 'js', 'app-connector-readiness.js'))).toBe(true);
  });

  it('asks the broker for live state instead of inferring it from the manifest alone', () => {
    expect(script).toMatch(/\/api\/connect\/list/);
    // Both shelves render the same way: an installed row and a store row each get the badge and
    // the provider chips, or the Discover half silently loses the feature it was built for.
    expect((script.match(/readinessBadge\(a\)/g) || []).length).toBe(2);
    expect((script.match(/connectorChips\(a\)/g) || []).length).toBe(2);
  });

  it('keeps no provider list of its own — the bundle declares it, the broker labels it', () => {
    for (const id of ['smartthings', 'google-home', 'tmdb', 'dropbox', 'schwab']) {
      expect(script).not.toMatch(new RegExp(`'${id}'`));
    }
  });
});
