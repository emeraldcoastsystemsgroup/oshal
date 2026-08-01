/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P3 (ADR-119 Stage E, FR-E3): flap damping as pure state transitions over the incident record. Each refire observation rolls into a windowed history (pruned to ALERT_FLAP_WINDOW, capped at ALERT_FLAP_THRESHOLD entries); crossing the threshold TRIPS the `flapping` flag exactly once per episode, and a refire arriving after ALERT_FLAP_QUIET of silence ENDS the episode (flag cleared, history reset). The caller (consolidation) owns all IO: it demotes a not-yet-dispatched `approved` ticket on trip and restores a flap-parked backlog ticket on quiet — this module never touches a ticket. Flapping is surfaced as state, never silent suppression (the source platform only narrated flap patterns; nothing acted on them)
 */

import {
  flapQuietSeconds,
  flapThreshold,
  flapWindowSeconds,
} from './alert-triage-constants';
import type { IncidentRecord } from './incident-record';

/** @description The `flags[]` entry FR-E3 surfaces (spec §5). */
export const FLAPPING_FLAG = 'flapping';

/**
 * @description What one refire observation did to the incident's flap state.
 * `tripped` is true only on the below→above threshold TRANSITION — the caller demotes on
 * the transition, never on continued flapping, so an operator promote mid-episode is
 * respected ("until quiet or an operator promotes").
 */
export interface FlapVerdict {
  /** The incident is currently marked flapping (flag present after this observation). */
  flapping: boolean;
  /** This observation newly tripped the flapping flag. */
  tripped: boolean;
  /** This observation arrived after a full quiet period and ENDED a flap episode. */
  becameQuiet: boolean;
}

/** @description The no-op verdict (damping disabled / unusable timestamps). */
const NO_OP: FlapVerdict = { flapping: false, tripped: false, becameQuiet: false };

/**
 * @description Applies one refire observation to the incident's flap state (FR-E3).
 * MUST be called BEFORE the caller advances `incident.lastSeen` — the quiet check measures
 * the gap between this observation and the incident's previous activity. Timestamps come
 * from the alert's own `seenAt` (event time, the same convention Stage C uses), so guards
 * are deterministic and late webhook deliveries are judged by when they fired.
 * @param incident - The incident record (flags/flap mutated in place; persisted by caller).
 * @param seenAtIso - The refire's observation timestamp.
 * @returns The flap verdict for the caller's status decisions.
 */
export function observeRefireForFlap(incident: IncidentRecord, seenAtIso: string): FlapVerdict {
  const windowSeconds = flapWindowSeconds();
  if (windowSeconds <= 0) return NO_OP; // damping disabled; existing state left untouched
  const seenMs = Date.parse(seenAtIso);
  if (!Number.isFinite(seenMs)) return NO_OP; // an undatable refire can neither trip nor quiet

  const threshold = flapThreshold();
  const quietMs = flapQuietSeconds() * 1000;
  const flap = incident.flap ?? { recent: [] };
  const wasFlapping = incident.flags.includes(FLAPPING_FLAG);

  // Quiet check: a refire landing >= ALERT_FLAP_QUIET after the incident's last activity
  // ends the current episode before this observation starts a fresh history.
  const lastMs = Date.parse(incident.lastSeen);
  const becameQuiet =
    wasFlapping && Number.isFinite(lastMs) && seenMs - lastMs >= quietMs;
  if (becameQuiet) {
    incident.flags = incident.flags.filter((f) => f !== FLAPPING_FLAG);
    flap.recent = [];
  }

  flap.recent = pruneObservations([...flap.recent, seenAtIso], windowSeconds, threshold);
  incident.flap = flap;

  const nowFlapping = flap.recent.length >= threshold;
  if (nowFlapping && !incident.flags.includes(FLAPPING_FLAG)) {
    incident.flags.push(FLAPPING_FLAG);
  }
  const flapping = incident.flags.includes(FLAPPING_FLAG);
  return {
    flapping,
    tripped: nowFlapping && (becameQuiet || !wasFlapping),
    becameQuiet,
  };
}

/**
 * @description Prunes the observation history to entries inside the flap window (anchored
 * on the newest parseable observation) and caps it at `threshold` entries — the minimum
 * history that still proves "at least threshold refires inside the window". Unparseable
 * entries are dropped.
 * @param observations - Raw observation timestamps (unsorted).
 * @param windowSeconds - The flap window.
 * @param threshold - The flap threshold (history cap).
 * @returns The pruned, ascending-sorted history.
 */
function pruneObservations(observations: string[], windowSeconds: number, threshold: number): string[] {
  const parsed = observations
    .map((iso) => ({ iso, ms: Date.parse(iso) }))
    .filter((o) => Number.isFinite(o.ms))
    .sort((a, b) => a.ms - b.ms);
  if (parsed.length === 0) return [];
  const anchorMs = parsed[parsed.length - 1].ms;
  const inWindow = parsed.filter((o) => anchorMs - o.ms <= windowSeconds * 1000);
  return inWindow.slice(-threshold).map((o) => o.iso);
}
