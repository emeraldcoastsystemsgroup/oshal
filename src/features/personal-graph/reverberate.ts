/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Cross-source reverberation pass: dedup people + derive links (ADR-066)
 */

/**
 * @module features/personal-graph/reverberate
 * @description The "connect things" pass over the personal graph (ADR-066).
 *
 * Ingest mappers each project ONE source item in isolation. The compounding value comes after:
 * reverberation walks the whole store and links entities discovered in one source to the same entity
 * in another. This is the moat — a person you met on a calendar invite and who emailed you becomes a
 * single node carrying edges from both sources.
 *
 * Two derivations ship here:
 *  1. Merge people across sources by email. Email-keyed person ids (`person:<email>`) are already
 *     unified by the store's upsert. This pass additionally folds handle-keyed people
 *     (`person:<provider>:<handle>`) into an email-keyed person when one of their sources later
 *     learned the email (props.email set), re-pointing their edges and leaving a `related-to`
 *     breadcrumb so the merge is auditable.
 *  2. Tighten Person<->Org via email domain (a person `related-to` the Org of their email domain),
 *     creating the Org node if absent. This seeds the org layer of the graph from people we know.
 *
 * The pass is idempotent: running it twice produces the same graph (merges are keyed, edges upserted).
 */

import { edgeId, normalizeEmail } from './graph-types';
import type { GraphStore } from './graph-store';
import type { GraphEdge, GraphNode, OrgNode, PersonNode, SourceRef } from './graph-types';

export interface ReverberateResult {
  /** Number of handle-keyed people merged into an email-keyed canonical person. */
  peopleMerged: number;
  /** Number of Person->Org `related-to` edges created (orgs derived from email domains). */
  orgLinks: number;
  /** Org nodes created in this pass. */
  orgsCreated: number;
}

/** Re-point an edge's endpoint id from `oldId` to `newId`, returning a new edge with a fresh id. */
function repoint(edge: GraphEdge, oldId: string, newId: string): GraphEdge {
  const from = edge.from === oldId ? newId : edge.from;
  const to = edge.to === oldId ? newId : edge.to;
  return { ...edge, id: edgeId(edge.type, from, to), from, to };
}

/**
 * Run the reverberation pass over a store, mutating it in place.
 * Returns a summary of what was derived.
 */
export function reverberate(store: GraphStore): ReverberateResult {
  let peopleMerged = 0;
  let orgLinks = 0;
  let orgsCreated = 0;

  // ---- 1. Merge handle-keyed people into email-keyed canonical people. ----
  // Two routes to a canonical email-keyed person:
  //   a) the handle-keyed person itself learned an email (props.email set), or
  //   b) some OTHER (email-keyed) person carries the same provider handle, so they are the same
  //      human seen once by email and once by handle. Build that handle -> email bridge first.
  const people = store.nodesByType('Person') as PersonNode[];
  const handleToCanonical = new Map<string, string>();
  for (const p of people) {
    const email = normalizeEmail(p.props.email);
    const handle = p.props.handle ? String(p.props.handle).toLowerCase() : undefined;
    if (email && handle) handleToCanonical.set(handle, `person:${email}`);
  }

  for (const p of people) {
    // A handle-keyed person id looks like `person:<provider>:<handle>`;
    // an email-keyed id looks like `person:<email>` (the email contains '@').
    const isEmailKeyed = p.id.startsWith('person:') && p.id.includes('@');
    if (isEmailKeyed) continue;

    // Resolve a canonical email id either from this node's own email or via the handle bridge.
    const ownEmail = normalizeEmail(p.props.email);
    const handle = p.props.handle ? String(p.props.handle).toLowerCase() : undefined;
    const canonicalId =
      (ownEmail ? `person:${ownEmail}` : undefined) ??
      (handle ? handleToCanonical.get(handle) : undefined);
    if (!canonicalId) continue; // no email learned anywhere for this handle person
    const email = canonicalId.slice('person:'.length);
    if (canonicalId === p.id) continue;

    // Ensure the canonical person exists (carry over name/handle/sources).
    const canonical: PersonNode = {
      id: canonicalId,
      type: 'Person',
      label: p.label,
      sources: p.sources,
      props: { ...p.props, email },
    };
    store.upsertNode(canonical);

    // Re-point every edge incident to the handle person onto the canonical person.
    for (const e of store.neighbors(p.id)) {
      store.upsertEdge(repoint(e, p.id, canonicalId));
    }
    // Leave an auditable breadcrumb linking the old identity to the canonical one.
    const breadcrumb: SourceRef = { provider: 'reverberate', externalId: `${p.id}=>${canonicalId}` };
    store.upsertEdge({
      id: edgeId('related-to', p.id, canonicalId),
      type: 'related-to',
      from: p.id,
      to: canonicalId,
      sources: [breadcrumb],
      props: { reason: 'same-person-merge' },
    });
    peopleMerged += 1;
  }

  // ---- 2. Derive Person -> Org links from email domains. ----
  for (const node of store.nodesByType('Person') as PersonNode[]) {
    const email = normalizeEmail(node.props.email);
    if (!email) continue;
    const domain = email.split('@')[1];
    if (!domain || isConsumerDomain(domain)) continue;

    const orgId = `org:${domain}`;
    const existingOrg = store.getNode(orgId) as OrgNode | undefined;
    if (!existingOrg) {
      const org: OrgNode = {
        id: orgId,
        type: 'Org',
        label: domain,
        sources: [{ provider: 'reverberate', externalId: domain }],
        props: { domain },
      };
      store.upsertNode(org);
      orgsCreated += 1;
    }
    const before = store.neighbors(node.id, { direction: 'out' }).length;
    store.upsertEdge({
      id: edgeId('related-to', node.id, orgId),
      type: 'related-to',
      from: node.id,
      to: orgId,
      sources: [{ provider: 'reverberate', externalId: `${email}@org` }],
      props: { reason: 'email-domain' },
    });
    const after = store.neighbors(node.id, { direction: 'out' }).length;
    if (after > before) orgLinks += 1;
  }

  return { peopleMerged, orgLinks, orgsCreated };
}

/** Personal email providers are not organizations worth linking people to. */
function isConsumerDomain(domain: string): boolean {
  const consumer = new Set([
    'gmail.com',
    'googlemail.com',
    'yahoo.com',
    'outlook.com',
    'hotmail.com',
    'live.com',
    'icloud.com',
    'me.com',
    'aol.com',
    'proton.me',
    'protonmail.com',
  ]);
  return consumer.has(domain.toLowerCase());
}

/** Re-export for callers that want the node union here. */
export type { GraphNode };
