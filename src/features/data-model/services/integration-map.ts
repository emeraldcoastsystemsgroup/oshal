/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | App integration map for the data-model explorer: one node per installed app (plus `@core`) and the edges between them, read from what manifests DECLARE - integration offers (versioned context exchanges), artifact Send-to flows matched by MIME type (ADR-139), app dependencies (ADR-085), application-group members (ADR-141) - joined with the database-level links (shared tables, cross-owner foreign keys). Nothing is inferred from names.
 */

import { CORE_OWNER, type AppNode, type AppRecordLite, type IntegrationEdge } from '../types';
import type { OwnershipResult } from './ownership';

type Obj = Record<string, unknown>;
const MAX_LABELS = 12;

const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === 'string');

/**
 * @description Whether two MIME patterns can describe the same artifact (`*` matches any part).
 * @param a - e.g. `image/png` or `image/*`
 * @param b - e.g. `image/*` or `*\/*`
 * @returns true when every part is equal or a wildcard on either side
 */
export function mimeOverlap(a: string, b: string): boolean {
  const [at, as = '*'] = a.toLowerCase().split('/');
  const [bt, bs = '*'] = b.toLowerCase().split('/');
  const part = (x: string, y: string) => x === '*' || y === '*' || x === y;
  return part(at, bt) && part(as, bs);
}

/**
 * @description Build the node for one installed app from its manifest and the ownership result.
 * @param rec - app record
 * @param own - ownership result
 * @returns the app node
 */
function appNode(rec: AppRecordLite, own: OwnershipResult): AppNode {
  const m = rec.manifest;
  const mine = (owners: string[]) => owners.includes(rec.name);
  return {
    name: rec.name, displayName: rec.displayName || rec.name, version: rec.version, status: rec.status,
    kind: m.kind === 'group' ? 'group' : 'app', suite: typeof m.suite === 'string' ? m.suite : null,
    tables: own.tables.filter((t) => mine(t.owners)).map((t) => t.name),
    views: own.views.filter((v) => mine(v.owners)).map((v) => v.name),
    sqliteTables: own.sqlite.filter((t) => t.owner === rec.name).map((t) => t.name),
    uses: strs(m.uses), ragCollections: strs(m.ragCollections), migrations: strs(m.migrations).length,
    routes: list(m.routes).map((r) => String(obj(r).mountPath ?? obj(r).path ?? '')).filter(Boolean),
  };
}

/**
 * @description The `@core` node: everything core declares.
 * @param own - ownership result
 * @returns the core node
 */
function coreNode(own: OwnershipResult): AppNode {
  const mine = (owners: string[]) => owners.includes(CORE_OWNER);
  return {
    name: CORE_OWNER, displayName: 'oshal core', version: '', status: 'active', kind: 'core', suite: 'platform',
    tables: own.tables.filter((t) => mine(t.owners)).map((t) => t.name),
    views: own.views.filter((v) => mine(v.owners)).map((v) => v.name),
    sqliteTables: own.sqlite.filter((t) => t.owner === CORE_OWNER).map((t) => t.name),
    uses: [], ragCollections: [], migrations: 0, routes: [],
  };
}

/**
 * @description Manifest-declared edges out of one app: integration offers, dependencies, group members.
 * @param rec - app record
 * @returns raw edges
 */
function declaredEdges(rec: AppRecordLite): IntegrationEdge[] {
  const m = rec.manifest;
  const edges: IntegrationEdge[] = [];
  for (const offer of list(obj(m.integrations).offers).map(obj)) {
    if (typeof offer.targetApp === 'string') edges.push({ from: rec.name, to: offer.targetApp, kind: 'context-offer', label: String(offer.label ?? offer.contextType ?? offer.id ?? 'offer') });
  }
  for (const dep of strs(obj(m.dependencies).apps)) edges.push({ from: rec.name, to: dep, kind: 'dependency', label: 'depends on' });
  if (m.kind === 'group') {
    const members = new Set([...list(m.toolbar), ...list(m.setup)].map((e) => obj(e).app).filter((a): a is string => typeof a === 'string'));
    for (const member of members) if (member !== rec.name) edges.push({ from: rec.name, to: member, kind: 'group-member', label: 'member' });
  }
  return edges;
}

/**
 * @description Artifact Send-to flows: provider app -> accepting app wherever a provided MIME type
 * overlaps an accepted pattern.
 * @param recs - app records
 * @returns raw edges, one per (provider, acceptor, type)
 */
function artifactEdges(recs: AppRecordLite[]): IntegrationEdge[] {
  const provides = recs.map((r) => ({ app: r.name, types: list(obj(r.manifest.artifacts).provides).flatMap((p) => strs(obj(p).types)) }));
  const accepts = recs.map((r) => ({ app: r.name, types: list(obj(r.manifest.artifacts).accepts).flatMap((a) => strs(obj(a).types)) }));
  const edges: IntegrationEdge[] = [];
  for (const p of provides) {
    for (const a of accepts) {
      if (p.app === a.app) continue;
      for (const type of p.types) if (a.types.some((pattern) => mimeOverlap(type, pattern))) edges.push({ from: p.app, to: a.app, kind: 'artifact', label: type });
    }
  }
  return edges;
}

/**
 * @description Merge raw edges that share (from, to, kind) into one edge with a combined label.
 * @param edges - raw edges
 * @returns aggregated, sorted edges
 */
export function aggregateEdges(edges: IntegrationEdge[]): IntegrationEdge[] {
  const groups = new Map<string, { edge: IntegrationEdge; labels: Set<string> }>();
  for (const e of edges) {
    const key = `${e.from}|${e.to}|${e.kind}`; // app names are kebab-case, so | cannot collide
    if (!groups.has(key)) groups.set(key, { edge: { ...e }, labels: new Set() });
    (groups.get(key) as { labels: Set<string> }).labels.add(e.label);
  }
  return [...groups.values()].map(({ edge, labels }) => {
    const sorted = [...labels].sort();
    const more = sorted.length > MAX_LABELS ? ` (+${sorted.length - MAX_LABELS} more)` : '';
    return { ...edge, label: sorted.slice(0, MAX_LABELS).join(', ') + more };
  }).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind));
}

/**
 * @description Build the app nodes and every integration edge between owners.
 * @param recs - installed app records
 * @param own - ownership result
 * @param dbEdges - database-level links from ownership.databaseLinks
 * @returns nodes (core first) and aggregated edges
 */
export function buildIntegrationMap(recs: AppRecordLite[], own: OwnershipResult, dbEdges: IntegrationEdge[]): { apps: AppNode[]; integrations: IntegrationEdge[] } {
  const apps = [coreNode(own), ...recs.map((r) => appNode(r, own)).sort((a, b) => a.name.localeCompare(b.name))];
  const known = new Set(apps.map((a) => a.name));
  const raw = [...recs.flatMap(declaredEdges), ...artifactEdges(recs), ...dbEdges];
  return { apps, integrations: aggregateEdges(raw.filter((e) => e.from !== e.to && known.has(e.from) && known.has(e.to))) };
}
