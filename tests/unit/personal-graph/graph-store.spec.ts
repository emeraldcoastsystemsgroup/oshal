/**
 * Personal graph store contract (ADR-066): upsert is idempotent + merges sources/props.
 * @module tests/unit/personal-graph/graph-store
 */
import { describe, it, expect } from 'vitest';
import { InMemoryGraphStore } from '@/features/personal-graph/graph-store';
import type { PersonNode, GraphEdge } from '@/features/personal-graph/graph-types';

function person(id: string, props: PersonNode['props'], provider: string): PersonNode {
  return { id, type: 'Person', label: props.name ?? id, sources: [{ provider }], props };
}

describe('InMemoryGraphStore', () => {
  it('upserts a node and re-upsert does NOT duplicate (idempotent by id)', () => {
    const store = new InMemoryGraphStore();
    const n = person('person:a@x.com', { email: 'a@x.com', name: 'A' }, 'gmail');
    store.upsertNode(n);
    store.upsertNode(n);
    expect(store.nodesByType('Person')).toHaveLength(1);
    expect(store.allNodes()).toHaveLength(1);
  });

  it('merges sources and props across upserts; newest non-undefined prop wins', () => {
    const store = new InMemoryGraphStore();
    store.upsertNode(person('person:a@x.com', { email: 'a@x.com' }, 'google-calendar'));
    const merged = store.upsertNode(person('person:a@x.com', { email: 'a@x.com', name: 'Alice' }, 'gmail'));
    expect(merged.sources.map((s) => s.provider).sort()).toEqual(['gmail', 'google-calendar']);
    expect(merged.props.name).toBe('Alice');
  });

  it('upserts edges idempotently by (type,from,to) and merges sources', () => {
    const store = new InMemoryGraphStore();
    const e: GraphEdge = {
      id: 'attended:person:a->-event:1',
      type: 'attended',
      from: 'person:a',
      to: 'event:1',
      sources: [{ provider: 'google-calendar' }],
    };
    store.upsertEdge(e);
    store.upsertEdge({ ...e, sources: [{ provider: 'google-calendar', externalId: 'x' }] });
    expect(store.allEdges()).toHaveLength(1);
  });

  it('returns neighbors by direction', () => {
    const store = new InMemoryGraphStore();
    store.upsertEdge({ id: 'a', type: 'attended', from: 'p', to: 'e', sources: [] });
    store.upsertEdge({ id: 'b', type: 'authored', from: 'p', to: 'm', sources: [] });
    store.upsertEdge({ id: 'c', type: 'mentions', from: 'm', to: 'p', sources: [] });
    expect(store.neighbors('p', { direction: 'out' })).toHaveLength(2);
    expect(store.neighbors('p', { direction: 'in' })).toHaveLength(1);
    expect(store.neighbors('p', { direction: 'both' })).toHaveLength(3);
  });
});
