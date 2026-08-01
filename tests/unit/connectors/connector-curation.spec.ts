/**
 * Connector curation guards — every-connector-has-category-and-description, and it FAILS RED.
 *
 * WHY THIS EXISTS: the catalog's curation gap was invisible because the runtime papered over it. The
 * marketplace's `inferCategory` ended in `return 'General'`, so every one of 307 connectors had a
 * shelf label whether or not anyone had categorised it — while the 51 specs that DID declare
 * `metadata.category` were ignored entirely, because the entry builder only read `metadata.description`.
 * A measured 17% coverage and a 100%-looking shelf at the same time.
 *
 * These guards assert the two things that keep that from returning: the catalog on disk is fully
 * curated (this spec goes red on the first uncurated connector added), and the derivation has NO
 * catch-all — an unidentifiable spec resolves to the deliberately-wrong-looking 'Uncategorized' and
 * an ERROR log, never a plausible label.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — every-connector-has-category-and-description over the real catalog, no-catch-all-category, declared-category-wins-and-is-canonicalised, description-derived-from-the-spec, and the marketplace entry actually carrying both.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_CATEGORIES, connectorSetupLane, deriveConnectorCategory, deriveConnectorDescription,
} from '../../../src/app/connectors/runtime/curation';
import { loadConnectorSpec, type ConnectorSpec } from '../../../src/app/connectors/runtime/spec';
import { ConnectorMarketplaceService } from '../../../src/app/connectors/runtime/marketplace';
import { upsertMetadataKey } from '../../../scripts/connectors/curate-catalog';

const SPEC_DIR = path.join(process.cwd(), 'swarm-apps/connectors');

function catalogSpecs(): Array<{ file: string; spec: ConnectorSpec }> {
  return fs.readdirSync(SPEC_DIR)
    .filter((f) => /\.ya?ml$/i.test(f))
    .map((file) => ({ file, spec: loadConnectorSpec(path.join(SPEC_DIR, file)) }));
}

/** A minimal spec object — enough for the derivation, without a file on disk. */
function spec(over: Partial<ConnectorSpec> = {}): ConnectorSpec {
  return {
    provider: 'nothing-identifiable',
    displayName: 'Nothing Identifiable',
    baseUrl: 'https://api.example.test',
    auth: { type: 'apiKey', in: 'header', name: 'X-Key' },
    resources: [],
    ...over,
  } as ConnectorSpec;
}

describe('every-connector-has-category-and-description', () => {
  const specs = catalogSpecs();

  it('has connectors to check at all (an empty sweep is not a passing sweep)', () => {
    expect(specs.length).toBeGreaterThan(200);
  });

  it('declares a category on EVERY connector spec in the catalog', () => {
    const missing = specs.filter(({ spec: s }) => !s.metadata?.category?.trim()).map((s) => s.file);
    expect(missing, `specs with no metadata.category — run: npm run connectors:curate -- --write`).toEqual([]);
  });

  it('declares a description on EVERY connector spec in the catalog', () => {
    const missing = specs.filter(({ spec: s }) => !s.metadata?.description?.trim()).map((s) => s.file);
    expect(missing, `specs with no metadata.description — run: npm run connectors:curate -- --write`).toEqual([]);
  });

  it('uses only canonical shelf labels — no near-duplicate shelves', () => {
    const offenders = specs
      .map(({ file, spec: s }) => ({ file, category: deriveConnectorCategory(s) as string }))
      .filter(({ category }) => !CANONICAL_CATEGORIES.includes(category));
    expect(offenders).toEqual([]);
  });

  it('never resolves a catalog connector to the uncurated marker', () => {
    const uncategorised = specs.filter(({ spec: s }) => !deriveConnectorCategory(s)).map((s) => s.file);
    expect(uncategorised).toEqual([]);
  });
});

describe('the category derivation has no catch-all', () => {
  it('returns NOTHING for a spec that identifies no provider — instead of a plausible label', () => {
    const derived = deriveConnectorCategory(spec());
    expect(derived).toBeUndefined();
  });

  it('treats the retired catch-alls as NOT categorised even when a spec declares one', () => {
    expect(deriveConnectorCategory(spec({ metadata: { category: 'General' } }))).toBeUndefined();
    expect(deriveConnectorCategory(spec({ metadata: { category: 'other' } }))).toBeUndefined();
  });

  it('lets human curation win, canonicalising a near-duplicate shelf label', () => {
    expect(deriveConnectorCategory(spec({ metadata: { category: 'Design' } }))).toBe('Design');
    // 'Communication' and 'Communications' must not render as two shelves.
    expect(deriveConnectorCategory(spec({ metadata: { category: 'Communication' } }))).toBe('Communications');
  });

  it('derives from the spec signals, not just the provider slug', () => {
    const fromResources = spec({
      provider: 'acme-thing',
      resources: [{ name: 'list-incidents', method: 'GET', path: '/incidents' }] as ConnectorSpec['resources'],
    });
    expect(deriveConnectorCategory(fromResources)).toBe('Operations');
  });

  it('does not match a common-word provider anchor inside a resource path', () => {
    // 'here' is a maps provider AND an English word: a resource path must never trigger it.
    const notMaps = spec({
      provider: 'acme-notes',
      resources: [{ name: 'here', method: 'GET', path: '/here' }] as ConnectorSpec['resources'],
    });
    expect(deriveConnectorCategory(notMaps)).not.toBe('Location & maps');
  });
});

describe('the description is derived from the spec', () => {
  it('names the reads, the writes, the host and the setup lane', () => {
    const s = spec({
      displayName: 'Acme',
      baseUrl: 'https://api.acme.test',
      resources: [
        { name: 'list-things', method: 'GET', path: '/things' },
        { name: 'create-thing', method: 'POST', path: '/things' },
      ] as ConnectorSpec['resources'],
    });
    const text = deriveConnectorDescription(s);
    expect(text).toContain('Acme');
    expect(text).toContain('reads list things');
    expect(text).toContain('writes create thing');
    expect(text).toContain('api.acme.test');
    expect(text).toContain('Bring your own key');
  });

  it('states the right setup lane for each auth model', () => {
    expect(connectorSetupLane(spec({ auth: { type: 'none' } as ConnectorSpec['auth'] }))).toBe('no-auth');
    expect(connectorSetupLane(spec({ auth: { type: 'oauth2' } as ConnectorSpec['auth'] }))).toBe('needs-operator-oauth-app');
    expect(connectorSetupLane(spec())).toBe('bring-your-own-key');
    expect(deriveConnectorDescription(spec({ auth: { type: 'none' } as ConnectorSpec['auth'] }))).toContain('No credential needed');
    expect(deriveConnectorDescription(spec({ auth: { type: 'oauth2' } as ConnectorSpec['auth'] }))).toContain('the operator registers the provider app once');
  });

  it('keeps a hand-written description verbatim', () => {
    const s = spec({ metadata: { description: 'A sentence a human wrote.' } });
    expect(deriveConnectorDescription(s)).toBe('A sentence a human wrote.');
  });
});

describe('the marketplace entry carries the curated values', () => {
  it('publishes the declared category and description, not a re-derived guess', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-curation-'));
    const specDir = path.join(root, 'connectors');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'acme.yaml'), [
      'provider: acme',
      'displayName: Acme',
      'baseUrl: https://api.acme.test',
      'auth: { type: apiKey, in: header, name: X-Key }',
      'resources:',
      '  - { name: list-things, tool: acme-list-things, method: GET, path: /things }',
      'metadata:',
      '  category: "Design"',
      '  description: "Acme does a specific thing."',
    ].join('\n'));
    try {
      const service = new ConnectorMarketplaceService({ specDir, statePath: path.join(root, 'state.json') });
      const entry = service.list().entries.find((e) => e.id === 'acme');
      expect(entry?.category).toBe('Design');
      expect(entry?.description).toBe('Acme does a specific thing.');
      expect(entry?.tags).toContain('design');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('shelves an unidentifiable connector as Uncategorized rather than inventing a label', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-curation-none-'));
    const specDir = path.join(root, 'connectors');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'zzz.yaml'), [
      'provider: zzz',
      'displayName: Zzz',
      'baseUrl: https://api.zzz.test',
      'auth: { type: apiKey, in: header, name: X-Key }',
      'resources:',
      '  - { name: thing, tool: zzz-thing, method: GET, path: /thing }',
    ].join('\n'));
    try {
      const service = new ConnectorMarketplaceService({ specDir, statePath: path.join(root, 'state.json') });
      const entry = service.list().entries.find((e) => e.id === 'zzz');
      expect(entry?.category).toBe('Uncategorized');
      expect(CANONICAL_CATEGORIES).not.toContain('Uncategorized');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the backfill writer preserves the rest of the file', () => {
  it('inserts into an existing metadata block without touching other keys', () => {
    const before = ['provider: acme', 'metadata:', '  iconVerified: false', '  iconSource: favicon-fallback'].join('\n');
    const after = upsertMetadataKey(before, 'category', 'Design');
    expect(after).toContain('  category: "Design"');
    expect(after).toContain('  iconVerified: false');
    expect(after).toContain('  iconSource: favicon-fallback');
    expect(after.startsWith('provider: acme')).toBe(true);
  });

  it('replaces an existing key rather than duplicating it', () => {
    const before = ['provider: acme', 'metadata:', '  category: "Old"'].join('\n');
    const after = upsertMetadataKey(before, 'category', 'Design');
    expect(after).toContain('  category: "Design"');
    expect(after).not.toContain('Old');
    expect(after.match(/category:/g)).toHaveLength(1);
  });

  it('creates the block when a spec has no metadata at all, and escapes quotes', () => {
    const after = upsertMetadataKey('provider: acme\n', 'description', 'He said "hi".');
    expect(after).toContain('metadata:');
    expect(after).toContain('  description: "He said \\"hi\\"."');
  });
});
