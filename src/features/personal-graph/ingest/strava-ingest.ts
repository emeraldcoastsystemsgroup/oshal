/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Strava activity -> graph fragment mapper (ADR-066)
 */

/**
 * @module features/personal-graph/ingest/strava-ingest
 * @description Pure mapper: one Strava activity (the raw item from the ADR-065 `strava-activities`
 * resource) -> graph nodes + edges.
 *
 * Projection:
 *  - the activity -> an Activity node (activity:strava:<id>)
 *  - if the activity has start coordinates -> a Place node + Activity `located-at` Place edge
 *  - the athlete (when an owner identity is supplied) -> a Person node with `participated-in`.
 *
 * The athlete id alone (strava only returns `athlete.id`) keys the person as `person:strava:<id>`;
 * an explicit owner email/name (e.g. from the swarm user record) keys by email for cross-source merge.
 */

import { edgeId } from '../graph-types';
import type { GraphFragment, GraphNode, GraphEdge, SourceRef } from '../graph-types';
import { buildPerson } from './ingest-helpers';

/** Minimal shape of a Strava activity (subset we use). */
export interface StravaActivity {
  id: number;
  name?: string;
  type?: string; // Run, Ride, ...
  start_date?: string;
  distance?: number; // meters
  moving_time?: number; // seconds
  start_latlng?: [number, number] | null;
  location_city?: string;
  athlete?: { id?: number };
}

/** Optional owner identity, supplied by the caller (the connected user), for cross-source dedup. */
export interface StravaOwner {
  email?: string;
  name?: string;
}

const PROVIDER = 'strava';

export function ingestStravaActivity(
  activity: StravaActivity,
  observedAt?: string,
  owner?: StravaOwner,
): GraphFragment {
  const source: SourceRef = { provider: PROVIDER, externalId: String(activity.id), observedAt };
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const activityNodeId = `activity:${PROVIDER}:${activity.id}`;
  nodes.push({
    id: activityNodeId,
    type: 'Activity',
    label: activity.name?.trim() || `${activity.type ?? 'Activity'} ${activity.id}`,
    sources: [source],
    props: {
      kind: activity.type,
      start: activity.start_date,
      distanceMeters: activity.distance,
      movingTimeSeconds: activity.moving_time,
    },
  });

  // Location -> Place (prefer coords; fall back to city name).
  const hasCoords =
    Array.isArray(activity.start_latlng) && activity.start_latlng.length === 2;
  if (hasCoords || activity.location_city) {
    const [lat, lng] = hasCoords ? (activity.start_latlng as [number, number]) : [undefined, undefined];
    const key = hasCoords ? `${lat},${lng}` : activity.location_city!.toLowerCase();
    const placeId = `place:${PROVIDER}:${key}`;
    nodes.push({
      id: placeId,
      type: 'Place',
      label: activity.location_city?.trim() || (hasCoords ? `${lat}, ${lng}` : 'Unknown'),
      sources: [source],
      props: {
        name: activity.location_city,
        lat: hasCoords ? lat : undefined,
        lng: hasCoords ? lng : undefined,
      },
    });
    edges.push({
      id: edgeId('located-at', activityNodeId, placeId),
      type: 'located-at',
      from: activityNodeId,
      to: placeId,
      sources: [source],
    });
  }

  // Athlete -> participated-in.
  const handle = activity.athlete?.id != null ? String(activity.athlete.id) : undefined;
  if (owner?.email || handle) {
    const person = buildPerson({
      email: owner?.email,
      name: owner?.name,
      handle,
      source,
    });
    nodes.push(person);
    edges.push({
      id: edgeId('participated-in', person.id, activityNodeId),
      type: 'participated-in',
      from: person.id,
      to: activityNodeId,
      sources: [source],
    });
  }

  return { nodes, edges };
}
