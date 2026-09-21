/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guards for "export the view you are looking at": the browser export module against the committed-docs generator it has to match byte for byte, the erDiagram naming exactly the relations the view drew (and nothing the view did not), the owner flowchart, the scoped JSON, the standalone SVG document, filenames, and the refusals - an empty scope, a view that draws no diagram, and a malformed relation record.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | The byte-parity assertion below only ever caught drift AFTER it shipped, because the surface and the generator each carried their own renderer. They now share one - src/pages/data-model/js/er-diagram.mjs - and this guard is what holds that: the exported functions must be the SAME objects on both sides, and neither consumer may build an erDiagram block of its own again.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | The RLS classifier joined the renderer: the generator's copy is gone, so the fixture's `access` summary now comes through scripts/schema-docs/kernel.js from the data-model feature slice.
 */

import { describe, expect, it } from 'vitest';
/* eslint-disable @typescript-eslint/no-require-imports */
const docsRender = require('../../scripts/schema-docs/render.js');
const { mermaidDiagram } = docsRender;
const { summarizeRowAccess } = require('../../scripts/schema-docs/kernel.js');
/* eslint-enable @typescript-eslint/no-require-imports */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  drawnRelations, exportFilename, mermaidName, mermaidType, svgDocument, toErDiagram, toFlowchart, toMermaid, toScopedJson,
} from '../../src/pages/data-model/js/export-view.js';
import * as erDiagram from '../../src/pages/data-model/js/er-diagram.mjs';
import { CORE_OWNER, appGraph, indexSnapshot, tableGraph } from '../../src/pages/data-model/js/model-index.js';

type Rec = Record<string, unknown>;
const col = (name: string, type = 'text', nullable = true) => ({ name, type, nullable, default: null, comment: null });
const OWNER_POLICY = {
  name: 'owner_or_operator',
  command: 'ALL',
  using: "((user_sub = current_setting('oshal.current_sub'::text, true)) OR (current_setting('oshal.is_operator'::text, true) = 'on'::text))",
  check: null,
};

/**
 * A relation in the shape the snapshot serves it: the catalog record the generator folds, plus the
 * explorer's own owner/RLS summary. `access` is filled by the generator's classifier so the parity
 * assertion below compares rendering, not two different readings of the same policy.
 */
const rel = (name: string, columns: Rec[], extra: Rec = {}) => {
  const base = {
    name, kind: 'table', comment: null, rls: true, forced: true, policies: [OWNER_POLICY], columns,
    primaryKey: ['id'], foreignKeys: [], uniques: [], hypertable: null, materialized: false, source: 'catalog',
    database: 'oshal', owners: [CORE_OWNER], definers: {}, ...extra,
  };
  return { ...base, access: summarizeRowAccess(base) };
};

const tickets = rel('tickets', [col('id', 'uuid', false), col('user_sub'), col('title')]);
const workItems = rel('work_items', [col('id', 'uuid', false), col('user_sub'), col('ticket_id', 'uuid', false), col('parent_id', 'uuid'), col('note')], {
  foreignKeys: [
    { name: 'wi_ticket', columns: ['ticket_id'], refTable: 'tickets', refColumns: ['id'] },
    { name: 'wi_parent', columns: ['parent_id'], refTable: 'work_items', refColumns: ['id'] },
  ],
});
const shopItems = rel('shop_items', [col('id', 'uuid', false), col('sku_code'), col('ticket_id', 'uuid', false)], {
  owners: ['shop'], uniques: [['sku_code']],
  foreignKeys: [{ name: 'si_ticket', columns: ['ticket_id'], refTable: 'tickets', refColumns: ['id'] }],
});
const snap = {
  generatedAt: '2026-09-14T00:00:00.000Z',
  database: 'oshal',
  tables: [tickets, workItems, shopItems],
  views: [],
  apps: [
    { name: CORE_OWNER, displayName: 'oshal core', kind: 'core', tables: ['tickets', 'work_items'], views: [] },
    { name: 'shop', displayName: 'Shop', kind: 'app', tables: ['shop_items'], views: [] },
  ],
  integrations: [{ from: 'shop', to: CORE_OWNER, kind: 'foreign-key', label: 'shop_items "child" -> tickets' }],
  unowned: [], declaredAbsent: [], sqlite: [],
};
const index = indexSnapshot(snap);
const tablesState = { view: 'tables', app: CORE_OWNER, table: '', focus: '', depth: 1, q: '' };

describe('Mermaid export matches the committed pages', () => {
  it('renders the same erDiagram the schema-docs generator writes, byte for byte', () => {
    const relations = [tickets, workItems, shopItems];
    expect(toErDiagram(relations)).toBe(mermaidDiagram(relations));
  });

  it('reduces types and identifiers exactly as the generator does', () => {
    for (const t of ['timestamp with time zone', 'character varying(64)', 'text[]', 'numeric(18,6)', 'vector(384)']) {
      expect(mermaidType(t)).toBe(docsRender.mermaidType(t));
    }
    expect(mermaidName('public.jobs')).toBe('public_jobs');
    expect(mermaidName('2fa_codes')).toBe('_2fa_codes');
  });

  it('names exactly the relations the view drew, and nothing it did not', () => {
    const graph = tableGraph(index, { owner: CORE_OWNER });
    const drawn = drawnRelations(index, graph).map((r: Rec) => r.name);
    const out = toErDiagram(drawnRelations(index, graph));
    const entities = [...out.matchAll(/^ {2}(\S+) \{$/gm)].map((m) => m[1]);
    expect(entities.sort()).toEqual([...drawn].sort());
    expect(entities).toContain('tickets');
    expect(entities).not.toContain('shop_items');
    expect(out).toContain('uuid ticket_id FK');
    expect(out).toContain('text user_sub "owner"');
    expect(out).not.toContain(' note');
  });

  it('parses as an erDiagram: fenced, legal identifiers, legal cardinality on every relationship', () => {
    const out = toErDiagram([tickets, workItems]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('```mermaid');
    expect(lines[1]).toBe('erDiagram');
    expect(lines[lines.length - 1]).toBe('```');
    let open = 0;
    for (const line of lines.slice(2, -1)) {
      if (/^ {2}[A-Za-z_][A-Za-z0-9_-]* \{$/.test(line)) { open += 1; continue; }
      if (line === '  }') { open -= 1; continue; }
      if (open) { expect(line).toMatch(/^ {4}[A-Za-z_][A-Za-z0-9_]* [A-Za-z_][A-Za-z0-9_-]*( (PK|FK|UK)(, (PK|FK|UK))*)?( "owner")?$/); continue; }
      expect(line).toMatch(/^ {2}[A-Za-z_][A-Za-z0-9_-]* (\|\||\|o|\}o|\}\|)--(o\||o\{|\|\||\|\{) [A-Za-z_][A-Za-z0-9_-]* : "[^"]*"$/);
    }
    expect(open).toBe(0);
  });

  it('draws the owner graph as a flowchart when the nodes are applications, not tables', () => {
    const out = toMermaid(index, { ...tablesState, view: 'apps' }, appGraph(snap));
    expect(out.split('\n')[1]).toBe('flowchart LR');
    expect(out).toContain('_core["core"]');
    expect(out).toContain('shop -- "foreign-key: shop_items \'child\' -> tickets" --> _core');
    for (const line of out.split('\n').slice(2, -1)) {
      expect(line).toMatch(/^ {2}[A-Za-z_][A-Za-z0-9_-]*(\["[^"]*"\]| -- "[^"]*" --> [A-Za-z_][A-Za-z0-9_-]*)$/);
    }
  });
});

describe('JSON and SVG export', () => {
  it('carries the drawn relations, their foreign keys and the state that drew them', () => {
    const graph = tableGraph(index, { owner: CORE_OWNER });
    const out = toScopedJson(index, tablesState, graph) as Rec;
    expect(JSON.parse(JSON.stringify(out)).relations.map((r: Rec) => r.name).sort()).toEqual(['tickets', 'work_items']);
    expect(out.database).toBe('oshal');
    expect(out.generatedAt).toBe(snap.generatedAt);
    expect(out.scope).toEqual(tablesState);
    expect((out.foreignKeys as Rec[]).some((f) => f.table === 'work_items' && f.refTable === 'tickets')).toBe(true);
  });

  it('carries apps and integration edges on the owner views, and store cards on the stores view', () => {
    const apps = toScopedJson(index, { ...tablesState, view: 'apps' }, appGraph(snap)) as Rec;
    expect((apps.apps as Rec[]).map((a) => a.name).sort()).toEqual(['@core', 'shop']);
    expect((apps.integrations as Rec[])[0].kind).toBe('foreign-key');
    const stores = toScopedJson(index, { ...tablesState, view: 'stores' }, null, [{ store: 'cache', engine: 'Redis' }]) as Rec;
    expect((stores.stores as Rec[])[0].engine).toBe('Redis');
  });

  it('wraps drawn markup as a standalone SVG: own viewBox, opaque ground, inlined graph rules', () => {
    const doc = svgDocument({ viewBox: '-24 -12 400 300', width: 400, height: 300, title: 'oshal data model - tables', body: '<g class="node"/>' });
    expect(doc.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(doc).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(doc).toContain('viewBox="-24 -12 400 300"');
    expect(doc).toContain('<rect x="-24" y="-12" width="100%" height="100%" fill="#0f1420"/>');
    expect(doc).toContain('.edge--foreign-key');
    expect(doc).toContain('<g class="node"/>');
    expect(doc.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('names the file after the view and its scope', () => {
    const now = new Date('2026-09-14T05:00:00Z');
    expect(exportFilename(tablesState, 'json', now)).toBe('data-model-tables-core-2026-09-14.json');
    expect(exportFilename({ ...tablesState, app: 'career-hunter' }, 'svg', now)).toBe('data-model-tables-career-hunter-2026-09-14.svg');
    expect(exportFilename({ ...tablesState, view: 'apps' }, 'json', now)).toBe('data-model-apps-2026-09-14.json');
  });
});

describe('export refusals', () => {
  it('refuses an empty scope by name instead of writing an unusable file', () => {
    expect(() => toErDiagram([])).toThrow(/drew no tables/);
    expect(() => toFlowchart({ nodes: [], edges: [] })).toThrow(/drew no applications/);
    expect(() => toScopedJson(index, tablesState, { nodes: [], edges: [] })).toThrow(/drew nothing/);
    expect(() => toScopedJson(index, { ...tablesState, view: 'stores' }, null, [])).toThrow(/have not loaded/);
  });

  it('refuses a diagram for a view that draws none, and for an unknown view', () => {
    expect(() => toMermaid(index, { ...tablesState, view: 'stores' }, null)).toThrow(/stores view draws no diagram/);
    expect(() => toMermaid(index, { ...tablesState, view: 'nonsense' }, { nodes: [{ id: 'x' }], edges: [] })).toThrow(/draws no diagram/);
  });

  it('drops a drawn node the snapshot has no relation for, rather than inventing an entity', () => {
    const graph = { nodes: [{ id: 'tickets' }, { id: 'ghost_table' }], edges: [] };
    expect(drawnRelations(index, graph).map((r: Rec) => r.name)).toEqual(['tickets']);
    expect(toErDiagram(drawnRelations(index, graph))).not.toContain('ghost_table');
  });

  it('renders a malformed relation record without emitting a broken diagram', () => {
    const bare = { name: 'weird.name', columns: [], primaryKey: [], foreignKeys: [{ columns: ['a'], refTable: '' }], uniques: [] };
    const out = toErDiagram([bare as never]);
    expect(out).toContain('  weird_name {');
    expect(out).toContain('  }');
    expect(out.split('\n').filter((l) => l.includes('--')).length).toBe(0);
  });
});

describe('one erDiagram renderer, behind both the docs and the surface', () => {
  /** A file's code lines, with licence/JSDoc/line comments stripped so prose cannot satisfy a guard. */
  const codeLines = (path: string) => readFileSync(resolve(path), 'utf8').split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => !(l.startsWith('*') || l.startsWith('/*') || l.startsWith('*/') || l.startsWith('//')));

  it('hands the surface the renderer module itself, and renders the generator the same bytes', () => {
    expect(mermaidType).toBe(erDiagram.mermaidType);
    expect(mermaidName).toBe(erDiagram.mermaidName);
    expect(toErDiagram([tickets, workItems])).toBe(erDiagram.mermaidDiagram([tickets, workItems]));
    // docsRender reaches the same file through CommonJS, so identity cannot be asserted across the
    // two module graphs - what it must not have is a renderer of its own, which the next case pins.
    expect(mermaidDiagram([tickets, workItems])).toBe(erDiagram.mermaidDiagram([tickets, workItems]));
    expect(docsRender.mermaidType('character varying(64)')).toBe(erDiagram.mermaidType('character varying(64)'));
  });

  it('leaves neither consumer writing an erDiagram of its own: both load the one module', () => {
    expect(codeLines('src/pages/data-model/js/er-diagram.mjs').some((l) => l.includes("'erDiagram'"))).toBe(true);
    const loads: Record<string, string> = {
      'src/pages/data-model/js/export-view.js': "from './er-diagram.mjs'",
      'scripts/schema-docs/render.js': "require('../../src/pages/data-model/js/er-diagram.mjs')",
    };
    for (const [path, load] of Object.entries(loads)) {
      expect(codeLines(path).filter((l) => l.includes("'erDiagram'")), path).toEqual([]);
      expect(codeLines(path).some((l) => l.includes(load)), path).toBe(true);
    }
  });
});
