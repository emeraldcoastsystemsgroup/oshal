/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Personal knowledge graph schema: node + edge types (ADR-066)
 */

/**
 * @module features/personal-graph/graph-types
 * @description Typed schema for the user-owned personal knowledge graph (ADR-066).
 *
 * Bots "reverberate" over a user's own connected data (the ADR-065 connector runtime feeds
 * normalized JSON in) and project it into a small, stable graph of the things in the user's life:
 * the people, orgs, events, places, activities, documents, messages, transactions, repos, and media
 * they touch — and the relationships between them. The graph is the compounding moat versus
 * retrieval assistants (ChatGPT/Copilot) and enterprise graphs (Palantir/Glean): it is the user's,
 * built from the user's own sources, and it links the same entity across every source.
 *
 * Design constraints:
 *  - Stable, deterministic ids (e.g. `person:alice@example.com`, `event:google-calendar:abc`) so
 *    re-ingesting the same source item is idempotent (an upsert, never a duplicate).
 *  - Small field sets — just enough to be useful and to dedup; the raw item is kept under `source`.
 *  - Provider-agnostic node shapes so two sources can resolve to one node (cross-source merge).
 */

/** The kinds of entities the graph tracks. */
export type NodeType =
  | 'Person'
  | 'Org'
  | 'Event'
  | 'Place'
  | 'Activity'
  | 'Document'
  | 'Message'
  | 'Transaction'
  | 'Repo'
  | 'Media';

/** The kinds of relationships between entities. Directed: from `source` node to `target` node. */
export type EdgeType =
  | 'attended'        // Person -> Event
  | 'organized'       // Person -> Event
  | 'located-at'      // Event|Activity -> Place
  | 'authored'        // Person -> Message|Document|Repo
  | 'mentions'        // Message|Document -> Person|Org
  | 'related-to'      // any -> any (generic association / same-as hint)
  | 'owns'            // Person -> Repo|Media|Document
  | 'paid'            // Person -> Transaction
  | 'participated-in';// Person -> Activity

/** Where a node/edge was first observed. The provider matches an ADR-065 connector (e.g. "gmail"). */
export interface SourceRef {
  /** Connector/provider id, e.g. "google-calendar", "gmail", "github", "strava". */
  provider: string;
  /** The provider's native id for the underlying item (if any). */
  externalId?: string;
  /** ISO timestamp this projection was produced. */
  observedAt?: string;
}

/** Common shape shared by every node. */
export interface GraphNodeBase {
  /** Stable deterministic id: `<type-lower>:<natural-key>`. Re-ingest hits the same id. */
  id: string;
  type: NodeType;
  /** Human label for display (name / subject / title). */
  label: string;
  /** Sources this node has been seen in (merged across providers on dedup). */
  sources: SourceRef[];
  /** Type-specific fields (kept narrow; see per-type interfaces). */
  props: Record<string, unknown>;
}

export interface PersonNode extends GraphNodeBase {
  type: 'Person';
  props: {
    /** Lowercased primary email — the dedup key across sources when present. */
    email?: string;
    name?: string;
    handle?: string; // e.g. github login
  };
}

export interface OrgNode extends GraphNodeBase {
  type: 'Org';
  props: { domain?: string; name?: string };
}

export interface EventNode extends GraphNodeBase {
  type: 'Event';
  props: { start?: string; end?: string; title?: string; locationText?: string };
}

export interface PlaceNode extends GraphNodeBase {
  type: 'Place';
  props: { name?: string; lat?: number; lng?: number };
}

export interface ActivityNode extends GraphNodeBase {
  type: 'Activity';
  props: { kind?: string; start?: string; distanceMeters?: number; movingTimeSeconds?: number };
}

export interface DocumentNode extends GraphNodeBase {
  type: 'Document';
  props: { title?: string; mimeType?: string; url?: string };
}

export interface MessageNode extends GraphNodeBase {
  type: 'Message';
  props: { subject?: string; snippet?: string; sentAt?: string; threadId?: string };
}

export interface TransactionNode extends GraphNodeBase {
  type: 'Transaction';
  props: { amount?: number; currency?: string; description?: string; at?: string };
}

export interface RepoNode extends GraphNodeBase {
  type: 'Repo';
  props: { fullName?: string; private?: boolean; url?: string; language?: string };
}

export interface MediaNode extends GraphNodeBase {
  type: 'Media';
  props: { title?: string; mediaType?: string; url?: string };
}

/** Discriminated union of every concrete node. */
export type GraphNode =
  | PersonNode
  | OrgNode
  | EventNode
  | PlaceNode
  | ActivityNode
  | DocumentNode
  | MessageNode
  | TransactionNode
  | RepoNode
  | MediaNode;

/** A directed edge between two nodes. Identity = (type, from, to) so re-ingest is idempotent. */
export interface GraphEdge {
  /** Stable id: `<type>:<from>->-<to>`. */
  id: string;
  type: EdgeType;
  from: string; // node id
  to: string;   // node id
  sources: SourceRef[];
  props?: Record<string, unknown>;
}

/** The output every ingest mapper produces from one raw source item: pure, no I/O. */
export interface GraphFragment {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Build the stable edge id from its triple. */
export function edgeId(type: EdgeType, from: string, to: string): string {
  return `${type}:${from}->-${to}`;
}

/** Normalize an email for use as a dedup key (lowercased, trimmed). */
export function normalizeEmail(email: string | undefined | null): string | undefined {
  if (!email) return undefined;
  const e = String(email).trim().toLowerCase();
  return e.length > 0 ? e : undefined;
}
