/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | GraphStore interface + in-memory impl (ADR-066)
 */

/**
 * @module features/personal-graph/graph-store
 * @description Storage abstraction for the personal knowledge graph (ADR-066).
 *
 * `GraphStore` is the pluggable persistence seam: an in-memory implementation ships here for tests
 * and dev; a Postgres-backed implementation is future work behind the same interface (the user owns
 * their store — ADR-057). The contract that makes the graph trustworthy is the UPSERT semantics:
 *  - upserting a node with an existing id MERGES (does not duplicate); sources accumulate, props are
 *    shallow-merged with the new non-undefined values winning, and the newest non-empty label wins.
 *  - upserting an edge with an existing (type, from, to) MERGES its sources.
 * This is what makes re-ingesting the same source item idempotent.
 */

import type { GraphNode, GraphEdge, NodeType, SourceRef } from './graph-types';

/** A read/write store for the personal graph. Storage-engine agnostic. */
export interface GraphStore {
  /** Insert or merge a node by id. Returns the resulting (merged) node. */
  upsertNode(node: GraphNode): GraphNode;
  /** Insert or merge an edge by (type, from, to). Returns the resulting edge. */
  upsertEdge(edge: GraphEdge): GraphEdge;
  /** Fetch a node by id, or undefined. */
  getNode(id: string): GraphNode | undefined;
  /** All edges incident to a node (both directions by default). */
  neighbors(id: string, opts?: { direction?: 'out' | 'in' | 'both' }): GraphEdge[];
  /** All nodes of a given type. */
  nodesByType(type: NodeType): GraphNode[];
  /** All nodes. */
  allNodes(): GraphNode[];
  /** All edges. */
  allEdges(): GraphEdge[];
}

/** Merge two source lists, deduping by provider+externalId. */
function mergeSources(a: SourceRef[], b: SourceRef[]): SourceRef[] {
  const seen = new Map<string, SourceRef>();
  for (const s of [...a, ...b]) {
    seen.set(`${s.provider}|${s.externalId ?? ''}`, s);
  }
  return [...seen.values()];
}

/** Shallow-merge props: new non-undefined values win; existing values are kept otherwise. */
function mergeProps(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** In-memory GraphStore. Suitable for tests, dev, and single-process reverberation passes. */
export class InMemoryGraphStore implements GraphStore {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();

  upsertNode(node: GraphNode): GraphNode {
    const existing = this.nodes.get(node.id);
    if (!existing) {
      const copy = { ...node, sources: [...node.sources], props: { ...node.props } } as GraphNode;
      this.nodes.set(node.id, copy);
      return copy;
    }
    // Merge into the existing node. Type is stable for a given id.
    const merged = {
      ...existing,
      label: node.label && node.label.length > 0 ? node.label : existing.label,
      sources: mergeSources(existing.sources, node.sources),
      props: mergeProps(existing.props, node.props),
    } as GraphNode;
    this.nodes.set(node.id, merged);
    return merged;
  }

  upsertEdge(edge: GraphEdge): GraphEdge {
    const existing = this.edges.get(edge.id);
    if (!existing) {
      const copy: GraphEdge = {
        ...edge,
        sources: [...edge.sources],
        props: edge.props ? { ...edge.props } : undefined,
      };
      this.edges.set(edge.id, copy);
      return copy;
    }
    const merged: GraphEdge = {
      ...existing,
      sources: mergeSources(existing.sources, edge.sources),
      props: edge.props ? mergeProps(existing.props ?? {}, edge.props) : existing.props,
    };
    this.edges.set(edge.id, merged);
    return merged;
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  neighbors(id: string, opts?: { direction?: 'out' | 'in' | 'both' }): GraphEdge[] {
    const dir = opts?.direction ?? 'both';
    const out: GraphEdge[] = [];
    for (const e of this.edges.values()) {
      const matchOut = e.from === id;
      const matchIn = e.to === id;
      if (dir === 'out' && matchOut) out.push(e);
      else if (dir === 'in' && matchIn) out.push(e);
      else if (dir === 'both' && (matchOut || matchIn)) out.push(e);
    }
    return out;
  }

  nodesByType(type: NodeType): GraphNode[] {
    return [...this.nodes.values()].filter((n) => n.type === type);
  }

  allNodes(): GraphNode[] {
    return [...this.nodes.values()];
  }

  allEdges(): GraphEdge[] {
    return [...this.edges.values()];
  }
}

/** Convenience: ingest a fragment (nodes then edges) into a store. */
export function applyFragment(
  store: GraphStore,
  fragment: { nodes: GraphNode[]; edges: GraphEdge[] },
): void {
  for (const n of fragment.nodes) store.upsertNode(n);
  for (const e of fragment.edges) store.upsertEdge(e);
}
