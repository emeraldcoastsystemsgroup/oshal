/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ArangoDB person-graph data-lifecycle exporter (closes the arangodb_person_graph KNOWN_EXPORT_GAPS entry): the ADR-045 per-person graph is an isolated database named ONLY from the sub (personDbName — the graph-keys isolation boundary), reached exclusively through GraphConnector so no raw engine creds ever enter this slice. Export dumps the nodes+edges collections via the GraphHandle rawQuery escape hatch; delete drops the person's whole database (GraphConnector.dropPersonGraph). Absent engine (no ARANGO_URL → createGraphConnector() null) and never-provisioned graphs (personGraphExists false — checked WITHOUT provisioning, so the pass never creates an empty DB as a side effect) are clean, logged no-ops declared in the store's manifest describe line, never failures.
 */

/**
 * @description Per-person graph exporter. User scoping is structural: the connector derives
 * the database name only from the caller's sub, so this exporter can only ever read or drop
 * the exporting user's own graph — there is no query filter to get wrong. Tenant-shared
 * graphs are deliberately untouched (shared, not per-user).
 *
 * @module features/data-lifecycle/services/arango-person-graph-exporter
 */

import { createChildLogger } from '@/shared/logger';
import { createGraphConnector, NODES, EDGES } from '@/features/graph';
import type { DataExporter } from './exporter-registry';

const logger = createChildLogger({ module: 'data-lifecycle:arango-person-graph' });

/** The slice of GraphHandle this exporter needs (kept minimal so tests fake it trivially). */
export interface PersonGraphHandleLike {
  rawQuery(query: string, bindVars?: Record<string, unknown>): Promise<unknown[]>;
}

/** The slice of GraphConnector this exporter needs — structurally satisfied by the real one. */
export interface PersonGraphConnectorLike {
  personGraphExists(sub: string): Promise<boolean>;
  getPersonGraph(sub: string): Promise<PersonGraphHandleLike>;
  dropPersonGraph(sub: string): Promise<boolean>;
}

/**
 * @description Build the person-graph DataExporter. Export = every node + edge of the
 * caller's isolated graph database; delete = drop that whole database. Both are no-ops when
 * the graph engine is not configured (ARANGO_URL unset) or the caller never had a graph.
 * @param connectorFactory - Returns the graph connector, or null when no engine is configured.
 *   Defaults to the env factory (createGraphConnector); tests inject a fake.
 * @returns The person-graph DataExporter.
 */
export function buildArangoPersonGraphExporter(
  connectorFactory: () => PersonGraphConnectorLike | null = createGraphConnector,
): DataExporter {
  /** Resolve the connector + whether this user's graph exists; null = nothing to do (no-op). */
  const resolve = async (userSub: string, op: string): Promise<PersonGraphConnectorLike | null> => {
    if (!userSub || !userSub.trim()) throw new Error('person-graph exporter requires a non-empty user sub');
    const connector = connectorFactory();
    if (!connector) {
      logger.info({ userSub, op }, 'person-graph: no graph engine configured (ARANGO_URL unset) — no-op');
      return null;
    }
    if (!(await connector.personGraphExists(userSub))) {
      logger.info({ userSub, op }, 'person-graph: no graph database ever provisioned for this user — no-op');
      return null;
    }
    return connector;
  };

  return {
    store: 'arangodb_person_graph',
    describe:
      'Your ADR-045 per-person knowledge graph — every node and edge of your isolated graph database (the database name derives only from your sub; tenant-shared graphs are not touched). Deleting drops the entire database. Empty when the graph engine is not configured (ARANGO_URL unset) or you never had a person graph.',
    deletable: true,
    async exportRows(userSub: string): Promise<unknown[]> {
      const connector = await resolve(userSub, 'export');
      if (!connector) return [];
      const handle = await connector.getPersonGraph(userSub);
      const [nodes, edges] = await Promise.all([
        handle.rawQuery(`FOR n IN ${NODES} RETURN { id: n.id, labels: n.labels, props: n.props }`),
        handle.rawQuery(`FOR e IN ${EDGES} RETURN { from: e._from, to: e._to, type: e.type, props: e.props }`),
      ]);
      return [
        ...nodes.map((n) => ({ kind: 'node', ...(n as Record<string, unknown>) })),
        ...edges.map((e) => ({ kind: 'edge', ...(e as Record<string, unknown>) })),
      ];
    },
    async deleteRows(userSub: string): Promise<number> {
      const connector = await resolve(userSub, 'delete');
      if (!connector) return 0;
      // Count documents BEFORE the drop so the outcome reports how many records went away,
      // not just "1 database".
      const handle = await connector.getPersonGraph(userSub);
      const counted = await handle.rawQuery(`RETURN LENGTH(${NODES}) + LENGTH(${EDGES})`);
      const total = typeof counted[0] === 'number' ? (counted[0] as number) : 0;
      const dropped = await connector.dropPersonGraph(userSub);
      logger.info({ userSub, dropped, records: total }, 'person-graph delete: database dropped');
      return dropped ? total : 0;
    },
  };
}
