/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel for the personal knowledge graph foundation (ADR-066)
 */

/**
 * @module features/personal-graph
 * @description Foundation of OSHAL's user-owned personal knowledge graph (ADR-066). Additive and
 * off by default: this library is NOT wired into server.ts or any running path. It turns the
 * normalized output of ADR-065 connectors into a small, deduped graph of the user's world, then
 * "reverberates" to link the same entity across sources.
 *
 * Public surface:
 *  - types:  GraphNode / GraphEdge unions + per-type node interfaces (graph-types)
 *  - store:  GraphStore interface + InMemoryGraphStore + applyFragment (graph-store)
 *  - ingest: pure (rawItem) => GraphFragment mappers for 4 connectors (ingest/*)
 *  - reverberate: cross-source dedup + derived links over a store
 */

export * from './graph-types';
export * from './graph-store';
export * from './reverberate';

export { ingestGoogleCalendarEvent } from './ingest/google-calendar-ingest';
export type { GCalEvent, GCalAttendee } from './ingest/google-calendar-ingest';

export { ingestGmailMessage } from './ingest/gmail-ingest';
export type { GmailMessage, GmailHeader } from './ingest/gmail-ingest';

export { ingestGitHubRepo } from './ingest/github-ingest';
export type { GitHubRepo, GitHubRepoOwner } from './ingest/github-ingest';

export { ingestStravaActivity } from './ingest/strava-ingest';
export type { StravaActivity, StravaOwner } from './ingest/strava-ingest';

export { personId, scopedId, buildPerson } from './ingest/ingest-helpers';

// ADR-066 end-to-end: Postgres-backed store (async) + the pull->ingest->reverberate service.
export * from './pg-graph-store';
export * from './graph-ingest-service';
