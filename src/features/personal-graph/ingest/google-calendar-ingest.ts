/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Google Calendar event -> graph fragment mapper (ADR-066)
 */

/**
 * @module features/personal-graph/ingest/google-calendar-ingest
 * @description Pure mapper: one Google Calendar event (the raw item from the ADR-065
 * `gcal-list-events` resource) -> graph nodes + edges.
 *
 * Projection:
 *  - the event itself -> an Event node (event:google-calendar:<id>)
 *  - each attendee + the organizer -> Person nodes (deduped by email)
 *  - attendee -> Event  : `attended` edge
 *  - organizer -> Event : `organized` edge
 *  - if the event has a location string -> a Place node + Event `located-at` Place edge
 *
 * Mapper is deterministic and side-effect free, so re-ingesting the same event is idempotent.
 */

import { edgeId } from '../graph-types';
import type { GraphFragment, GraphNode, GraphEdge, SourceRef } from '../graph-types';
import { buildPerson, scopedId } from './ingest-helpers';

/** Minimal shape of a Google Calendar event (subset of the API object we use). */
export interface GCalAttendee {
  email?: string;
  displayName?: string;
  organizer?: boolean;
}
export interface GCalEvent {
  id: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string; displayName?: string };
  attendees?: GCalAttendee[];
}

const PROVIDER = 'google-calendar';

function whenOf(slot?: { dateTime?: string; date?: string }): string | undefined {
  return slot?.dateTime ?? slot?.date;
}

export function ingestGoogleCalendarEvent(event: GCalEvent, observedAt?: string): GraphFragment {
  const source: SourceRef = { provider: PROVIDER, externalId: event.id, observedAt };
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const eventNodeId = scopedId('event', PROVIDER, event.id);
  const eventNode: GraphNode = {
    id: eventNodeId,
    type: 'Event',
    label: event.summary?.trim() || `Event ${event.id}`,
    sources: [source],
    props: {
      title: event.summary,
      start: whenOf(event.start),
      end: whenOf(event.end),
      locationText: event.location,
    },
  };
  nodes.push(eventNode);

  // Organizer.
  if (event.organizer?.email) {
    const org = buildPerson({
      email: event.organizer.email,
      name: event.organizer.displayName,
      source,
    });
    nodes.push(org);
    edges.push({
      id: edgeId('organized', org.id, eventNodeId),
      type: 'organized',
      from: org.id,
      to: eventNodeId,
      sources: [source],
    });
  }

  // Attendees.
  for (const a of event.attendees ?? []) {
    if (!a.email) continue;
    const person = buildPerson({ email: a.email, name: a.displayName, source });
    nodes.push(person);
    edges.push({
      id: edgeId('attended', person.id, eventNodeId),
      type: 'attended',
      from: person.id,
      to: eventNodeId,
      sources: [source],
    });
  }

  // Location -> Place.
  if (event.location && event.location.trim().length > 0) {
    const placeId = `place:${PROVIDER}:${event.location.trim().toLowerCase()}`;
    nodes.push({
      id: placeId,
      type: 'Place',
      label: event.location.trim(),
      sources: [source],
      props: { name: event.location.trim() },
    });
    edges.push({
      id: edgeId('located-at', eventNodeId, placeId),
      type: 'located-at',
      from: eventNodeId,
      to: placeId,
      sources: [source],
    });
  }

  return { nodes, edges };
}
