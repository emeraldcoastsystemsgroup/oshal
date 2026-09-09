/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-145 the app summary contract — the guards. readManifest fails closed on a `summary:` that is off-mount, behind a service-only route, malformed, or declares neither pointer. coerceSummaryPayload bounds what a package answers (caps truncate rather than reject, an unknown tone degrades to neutral and NEVER escalates, a missing or wrong-typed pointer yields checked:false so the card says "can't check" instead of inventing a fact or a zero). buildHomePlan emits a group card that aggregates its members and never also lists a member loose.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readManifest,
  buildHomePlan,
  coerceSummaryPayload,
  coerceTone,
  MAX_SUMMARY_TILES,
  MAX_SUMMARY_ITEMS,
  type SwarmAppManifest,
} from '@/features/swarm-apps';

const tempDirs: string[] = [];
function writeManifest(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-summary-'));
  tempDirs.push(dir);
  const file = join(dir, 'oshal-app.yaml');
  writeFileSync(file, body, 'utf8');
  return file;
}
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

const APP_YAML = (auth = 'oidc', path = '/api/a1/summary', pointers = '  tilesPointer: /tiles\n  itemsPointer: /items') => [
  'name: a1',
  'displayName: App One',
  'suite: ai-productivity',
  'routes:',
  '  - module: routes/a1.js',
  '    factory: createA1Routes',
  '    mountPath: /api/a1',
  `    auth: ${auth}`,
  'summary:',
  `  path: ${path}`,
  pointers,
  '',
].join('\n');

describe('readManifest — summary: fails closed like readiness:', () => {
  it('accepts a summary below the package\'s own session-admitting route (sanity)', () => {
    expect(readManifest(writeManifest(APP_YAML())).summary?.path).toBe('/api/a1/summary');
  });

  it('rejects a path not owned by the package\'s own routes', () => {
    expect(() => readManifest(writeManifest(APP_YAML('oidc', '/api/other/summary'))))
      .toThrow(/not owned by a declared routes\[\]\.mountPath/);
  });

  it('rejects a probe behind a service-only route — a summary runs as the signed-in user', () => {
    expect(() => readManifest(writeManifest(APP_YAML('service'))))
      .toThrow(/must admit a browser session/);
  });

  it('rejects a non-canonical path', () => {
    expect(() => readManifest(writeManifest(APP_YAML('oidc', '/api/a1/../secrets'))))
      .toThrow(/canonical root-relative path/);
  });

  it('rejects a malformed pointer', () => {
    expect(() => readManifest(writeManifest(APP_YAML('oidc', '/api/a1/summary', '  tilesPointer: tiles'))))
      .toThrow(/tilesPointer, when present, must be a non-empty RFC 6901 pointer/);
  });

  it('rejects a summary that declares neither pointer — a field nothing can consume', () => {
    expect(() => readManifest(writeManifest(APP_YAML('oidc', '/api/a1/summary', '  # no pointers'))))
      .toThrow(/at least one of tilesPointer \/ itemsPointer/);
  });

  it('rejects an unknown field', () => {
    expect(() => readManifest(writeManifest(APP_YAML('oidc', '/api/a1/summary', '  tilesPointer: /tiles\n  refreshMs: 5000'))))
      .toThrow(/unknown field/);
  });
});

describe('coerceSummaryPayload — bounded, and never invents a fact', () => {
  const decl = { tilesPointer: '/tiles', itemsPointer: '/items' };

  it('keeps a well-formed payload and marks it checked', () => {
    const out = coerceSummaryPayload(
      { tiles: [{ label: 'Record', value: '116W-215L', tone: 'warn' }], items: [{ text: 'Both failing', tone: 'warn' }] },
      decl,
    );
    expect(out.checked).toBe(true);
    expect(out.tiles).toEqual([{ label: 'Record', value: '116W-215L', tone: 'warn' }]);
    expect(out.items[0].text).toBe('Both failing');
  });

  it('TRUNCATES over-cap rather than rejecting — a chatty app must not break the page', () => {
    const tiles = Array.from({ length: 9 }, (_, i) => ({ label: `t${i}`, value: `${i}` }));
    const items = Array.from({ length: 9 }, (_, i) => ({ text: `i${i}` }));
    const out = coerceSummaryPayload({ tiles, items }, decl);
    expect(out.tiles).toHaveLength(MAX_SUMMARY_TILES);
    expect(out.items).toHaveLength(MAX_SUMMARY_ITEMS);
  });

  it('degrades an unknown tone to neutral and NEVER escalates', () => {
    const out = coerceSummaryPayload(
      { tiles: [{ label: 'a', value: 'b', tone: 'critical' }], items: [{ text: 'x', tone: 'danger' }] },
      decl,
    );
    expect(out.tiles[0].tone).toBe('neutral');
    expect(out.items[0].tone).toBe('neutral');
    expect(coerceTone('warn')).toBe('warn');
    expect(coerceTone(undefined)).toBe('neutral');
  });

  it('a MISSING pointer location yields checked:false — "can\'t check", not zero', () => {
    const out = coerceSummaryPayload({ somethingElse: true }, decl);
    expect(out.checked).toBe(false);
    expect(out.tiles).toEqual([]);
    expect(out.items).toEqual([]);
  });

  it('a WRONG-TYPED pointer target yields checked:false', () => {
    expect(coerceSummaryPayload({ tiles: 'not-an-array', items: 42 }, decl).checked).toBe(false);
  });

  it('drops malformed entries but keeps the well-formed siblings', () => {
    const out = coerceSummaryPayload(
      { tiles: [{ label: 'ok', value: 'v' }, { label: 'no value' }, { value: 'no label' }, null] },
      { tilesPointer: '/tiles' },
    );
    expect(out.tiles).toEqual([{ label: 'ok', value: 'v', tone: 'neutral' }]);
  });

  it('a numeric value is DROPPED — value is a string by contract, core must not format it', () => {
    expect(coerceSummaryPayload({ tiles: [{ label: 'n', value: 42 }] }, { tilesPointer: '/tiles' }).tiles).toEqual([]);
  });
});

describe('buildHomePlan — a group stands for its members, which are never also listed loose', () => {
  const member = (name: string, withSummary: boolean): SwarmAppManifest => ({
    name,
    displayName: name.toUpperCase(),
    routes: [{ module: `routes/${name}.js`, factory: 'f', mountPath: `/api/${name}`, auth: 'oidc' }],
    readiness: [{ name: 'thing', path: `/api/${name}/state`, readyPointer: '/ready', detailPointer: '/detail' }],
    ...(withSummary ? { summary: { path: `/api/${name}/summary`, tilesPointer: '/tiles' } } : {}),
  } as unknown as SwarmAppManifest);

  const group: SwarmAppManifest = {
    name: 'g1',
    displayName: 'Group One',
    kind: 'group',
    dependencies: { apps: ['m1', 'm2'] },
    setup: [{ label: 'Do the m1 thing', app: 'm1', readiness: 'thing', fix: 'm1-home' }],
  } as unknown as SwarmAppManifest;

  it('emits the group first, aggregating every member probe', () => {
    const plan = buildHomePlan([member('m1', true), member('m2', false), group, member('solo', true)]);
    expect(plan[0].name).toBe('g1');
    expect(plan[0].kind).toBe('group');
    expect(plan[0].members).toEqual(['m1', 'm2']);
    expect(plan[0].summary.map((s) => s.app)).toEqual(['m1']);
    expect(plan[0].todos.map((t) => t.app)).toEqual(['m1', 'm2']);
  });

  it('borrows the group setup[] label and fix for a member readiness, humanising the rest', () => {
    const plan = buildHomePlan([member('m1', true), member('m2', false), group]);
    expect(plan[0].todos[0]).toMatchObject({ label: 'Do the m1 thing', fix: 'm1-home' });
    expect(plan[0].todos[1]).toMatchObject({ label: 'Thing' });
    expect(plan[0].todos[1].fix).toBeUndefined();
  });

  it('never lists a grouped member as its own card, but does list an ungrouped app', () => {
    const names = buildHomePlan([member('m1', true), member('m2', false), group, member('solo', true)]).map((e) => e.name);
    expect(names).toEqual(['g1', 'solo']);
  });

  it('an app that declares nothing still gets a card, with no probes', () => {
    const bare = { name: 'bare', displayName: 'Bare' } as unknown as SwarmAppManifest;
    const [entry] = buildHomePlan([bare]);
    expect(entry).toMatchObject({ name: 'bare', kind: 'app', members: ['bare'] });
    expect(entry.summary).toEqual([]);
    expect(entry.todos).toEqual([]);
  });

  it('skips a group member that is not among the active manifests', () => {
    const plan = buildHomePlan([member('m1', true), group]);
    expect(plan[0].members).toEqual(['m1']);
  });
});

// The Home view sections by ADR-097 suite — the operator's correction 2026-09-09: "you don't have
// to make new groups, the groups ARE the suites". Pure, so it is tested without a DOM.
describe('sectionBySuite — the sidebar shelves, as tiles', () => {
  const e = (name: string, suite?: string) => ({ name, displayName: name, suite } as any);

  it('emits shelves in the shared shelf order, skipping empty ones', async () => {
    const { sectionBySuite } = await import('@/pages/cockpit/js/views/AppsHomeView.js' as any);
    const shelves = sectionBySuite([e('a', 'ai-finance'), e('b', 'platform'), e('c', 'ai-finance')]);
    expect(shelves.map((s: any) => s.key)).toEqual(['platform', 'ai-finance']);
    expect(shelves[1].entries.map((x: any) => x.name)).toEqual(['a', 'c']);
  });

  it('never DROPS an app with a missing or unknown suite — it lands in Other', async () => {
    const { sectionBySuite } = await import('@/pages/cockpit/js/views/AppsHomeView.js' as any);
    const shelves = sectionBySuite([e('good', 'ai-home'), e('bare'), e('typo', 'ai-productivty')]);
    const other = shelves.find((s: any) => s.key === 'other');
    expect(other.entries.map((x: any) => x.name).sort()).toEqual(['bare', 'typo']);
    expect(shelves[shelves.length - 1].key).toBe('other');
  });

  it('returns nothing for an empty or non-array plan rather than throwing', async () => {
    const { sectionBySuite } = await import('@/pages/cockpit/js/views/AppsHomeView.js' as any);
    expect(sectionBySuite([])).toEqual([]);
    expect(sectionBySuite(undefined as any)).toEqual([]);
  });
});
