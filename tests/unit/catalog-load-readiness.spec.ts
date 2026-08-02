/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Named guards for BACKLOG "The api can boot healthy with ZERO connector tools (ENOMEM)". Live 2026-08-01: the api booted with `ENOMEM: not enough memory, scandir '/app/swarm-apps/connectors'`, registered zero connector tools, and served /api/health AND /api/readiness as fine. Guards: catalog-read-retries-transient (an ENOMEM that clears on the second attempt no longer costs the box a whole capability), catalog-read-fails-loud (exhausted retries record `unreadable`, which is degraded), catalog-absent-is-not-a-failure (a box with no connector directory stays ready), catalog-read-does-not-retry-standing-errors (EACCES fails on attempt 1 — a retry loop that cannot help is just a slower boot), readiness-catalogs-leg-fails-on-degraded (`ready:false` + the reason on the line) and readiness-catalogs-leg-ok-when-loaded. The connector-loader legs run against a REAL temp directory through the REAL loadConnectorSpecs — the seam that broke was fs + the loader, so nothing here stubs either.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  degradedCatalogs,
  listCatalogLoads,
  readCatalogDir,
  recordCatalogLoad,
  resetCatalogLoads,
} from '../../src/shared/observability';
import { CONNECTOR_SPEC_CATALOG, loadConnectorSpecs } from '../../src/app/connectors/runtime/spec-tools';
import { buildReadinessReport, type ReadinessDeps } from '../../src/app/routes/readiness-routes';

/** A ReadinessDeps whose every other leg is deliberately green, so `catalogs` is the variable. */
function greenDeps(overrides: Partial<ReadinessDeps> = {}): ReadinessDeps {
  return {
    activeProvider: () => 'claude-code',
    forcedProvider: () => null,
    noAiDeclared: () => false,
    criticalBots: () => [],
    onlineAgentIds: async () => [],
    credentialPresent: () => true,
    defaultHarness: () => 'claude-code',
    voiceStatus: async () => null,
    dbOk: async () => true,
    catalogLoads: listCatalogLoads,
    degradedCatalogLoads: degradedCatalogs,
    ...overrides,
  };
}

/** Builds an ErrnoException the way node throws one out of readdirSync. */
function posixError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

const tempDirs: string[] = [];

function makeSpecDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'oshal-catalog-guard-'));
  tempDirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body, 'utf8');
  return dir;
}

beforeEach(() => resetCatalogLoads());

afterEach(() => {
  resetCatalogLoads();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('ENOMEM blind spot — the catalog directory read', () => {
  it('catalog-read-retries-transient: an ENOMEM that clears on the next attempt does NOT cost the capability', () => {
    let calls = 0;
    const read = readCatalogDir('/app/swarm-apps/connectors', {
      catalog: 'connector-specs',
      attempts: 3,
      backoffMs: 0,
      sleep: () => undefined,
      exists: () => true,
      readdir: () => {
        calls += 1;
        if (calls === 1) throw posixError('ENOMEM', "ENOMEM: not enough memory, scandir '/app/swarm-apps/connectors'");
        return ['github.yaml', 'slack.yaml'];
      },
    });
    expect(read.state).toBe('ok');
    expect(read.attempts).toBe(2);
    expect(read.entries).toEqual(['github.yaml', 'slack.yaml']);
    expect(degradedCatalogs()).toEqual([]);
  });

  it('catalog-read-fails-loud: exhausted retries record `unreadable`, which readiness treats as degraded', () => {
    const read = readCatalogDir('/app/swarm-apps/connectors', {
      catalog: 'connector-specs',
      attempts: 3,
      backoffMs: 0,
      sleep: () => undefined,
      exists: () => true,
      readdir: () => {
        throw posixError('ENOMEM', "ENOMEM: not enough memory, scandir '/app/swarm-apps/connectors'");
      },
    });
    expect(read.state).toBe('unreadable');
    expect(read.attempts).toBe(3);
    const degraded = degradedCatalogs();
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.catalog).toBe('connector-specs');
    expect(degraded[0]!.detail).toContain('ENOMEM');
  });

  it('catalog-absent-is-not-a-failure: a box with no connector directory stays READY', async () => {
    const read = readCatalogDir('/app/swarm-apps/connectors', {
      catalog: 'connector-specs',
      exists: () => false,
      readdir: () => {
        throw posixError('ENOENT', "ENOENT: no such file or directory, scandir '/app/swarm-apps/connectors'");
      },
    });
    expect(read.state).toBe('absent');
    expect(degradedCatalogs()).toEqual([]);
    const report = await buildReadinessReport(greenDeps());
    expect(report.legs.catalogs.state).toBe('off');
    expect(report.ready).toBe(true);
  });

  it('catalog-read-does-not-retry-standing-errors: EACCES fails on attempt 1 (a retry loop that cannot help is just a slower boot)', () => {
    let calls = 0;
    const read = readCatalogDir('/app/swarm-apps/connectors', {
      catalog: 'connector-specs',
      attempts: 3,
      backoffMs: 0,
      sleep: () => undefined,
      exists: () => true,
      readdir: () => {
        calls += 1;
        throw posixError('EACCES', 'EACCES: permission denied');
      },
    });
    expect(read.state).toBe('unreadable');
    expect(calls).toBe(1);
  });
});

describe('ENOMEM blind spot — /api/readiness must not call a catalog-less box ready', () => {
  it('readiness-catalogs-leg-fails-on-degraded: an unreadable connector catalog is ready:false with the reason', async () => {
    recordCatalogLoad({
      catalog: 'connector-specs',
      source: '/app/swarm-apps/connectors',
      state: 'unreadable',
      discovered: 0,
      loaded: 0,
      attempts: 3,
      detail: "ENOMEM: not enough memory, scandir '/app/swarm-apps/connectors'",
    });
    const report = await buildReadinessReport(greenDeps());
    expect(report.legs.catalogs.state).toBe('fail');
    expect(report.ready).toBe(false);
    expect(report.summary).toContain('catalogs=fail');
    expect(report.problems.join(' ')).toContain('ENOMEM');
  });

  it('readiness-catalogs-leg-fails-on-empty: entries offered and NONE loaded is advertised-and-dead', async () => {
    recordCatalogLoad({
      catalog: 'connector-specs',
      source: '/app/swarm-apps/connectors',
      state: 'empty',
      discovered: 306,
      loaded: 0,
      attempts: 1,
    });
    const report = await buildReadinessReport(greenDeps());
    expect(report.legs.catalogs.state).toBe('fail');
    expect(report.ready).toBe(false);
    expect(report.legs.catalogs.detail).toContain('306 entries offered, 0 loaded');
  });

  it('readiness-catalogs-leg-off-before-anything-loads: no record at all is `off`, never a false green or a false red', async () => {
    const report = await buildReadinessReport(greenDeps());
    expect(report.legs.catalogs.state).toBe('off');
    expect(report.ready).toBe(true);
  });
});

describe('ENOMEM blind spot — the REAL connector-spec loader against a REAL directory', () => {
  it('readiness-catalogs-leg-ok-when-loaded: a real spec dir loads and readiness reports ok', async () => {
    const dir = makeSpecDir({
      'guardhub.yaml': [
        'provider: guardhub',
        'baseUrl: https://example.invalid',
        'auth:',
        '  type: apiKeyHeader',
        '  header: X-Api-Key',
        'resources:',
        '  - name: ping',
        '    method: GET',
        '    path: /ping',
        '    tool: guardhub_ping',
      ].join('\n'),
    });
    const specs = loadConnectorSpecs(dir);
    expect(specs.map((s) => s.provider)).toEqual(['guardhub']);
    const record = listCatalogLoads().find((r) => r.catalog === CONNECTOR_SPEC_CATALOG);
    expect(record).toMatchObject({ state: 'ok', discovered: 1, loaded: 1 });
    const report = await buildReadinessReport(greenDeps());
    expect(report.legs.catalogs.state).toBe('ok');
    expect(report.ready).toBe(true);
  });

  it('loader-records-empty-when-every-spec-is-unparseable: 3 offered, 0 loaded => ready:false', async () => {
    const dir = makeSpecDir({
      'a.yaml': ': not a connector spec at all',
      'b.yaml': ': also broken',
      'c.yaml': ': broken too',
    });
    expect(loadConnectorSpecs(dir)).toEqual([]);
    const record = listCatalogLoads().find((r) => r.catalog === CONNECTOR_SPEC_CATALOG);
    expect(record).toMatchObject({ state: 'empty', discovered: 3, loaded: 0 });
    const report = await buildReadinessReport(greenDeps());
    expect(report.legs.catalogs.state).toBe('fail');
    expect(report.ready).toBe(false);
  });

  it('provider-filtered-reads-are-never-reported-empty: asking for one provider is not a broken catalog', () => {
    const dir = makeSpecDir({
      'guardhub.yaml': 'provider: guardhub\nbaseUrl: https://example.invalid\nauth:\n  type: apiKeyHeader\n  header: X-Api-Key\nresources: []\n',
    });
    expect(loadConnectorSpecs(dir, new Set(['not-present']))).toEqual([]);
    const record = listCatalogLoads().find((r) => r.catalog === CONNECTOR_SPEC_CATALOG);
    expect(record!.state).toBe('ok');
    expect(degradedCatalogs()).toEqual([]);
  });

  it('the-real-shipped-connector-directory-loads: the tree this repo ships is not itself an empty catalog', () => {
    const shipped = path.resolve(__dirname, '..', '..', 'swarm-apps', 'connectors');
    const specs = loadConnectorSpecs(shipped);
    expect(specs.length).toBeGreaterThan(0);
    const record = listCatalogLoads().find((r) => r.source === shipped);
    expect(record!.state).toBe('ok');
    expect(record!.loaded).toBe(specs.length);
  });
});

// Empty-dir sanity: a directory that exists but offers nothing is `ok` with 0 loaded, not
// `empty`. "Nothing to load" and "could not load what was there" are different answers and
// only the second may fail readiness.
describe('ENOMEM blind spot — the empty-but-present directory', () => {
  it('an existing directory with no specs is ok, not degraded', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oshal-catalog-empty-'));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, 'nested'), { recursive: true });
    expect(loadConnectorSpecs(dir)).toEqual([]);
    expect(degradedCatalogs()).toEqual([]);
    const report = await buildReadinessReport(greenDeps());
    expect(report.legs.catalogs.state).toBe('ok');
  });
});
