/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W3:
 *                     |                             | orbit-visualization + conjunction-screening types for
 *                     |                             | the fleet plane. Tracks carry BOTH the TEME/ECI vector
 *                     |                             | (3D console) and the geodetic point (ground-track map)
 *                     |                             | per sample so one propagation serves both views.
 */

/** One sampled point of an orbit track — ECI position (km, TEME) + geodetic subpoint. */
export interface OrbitTrackPoint {
  /** UTC epoch of this sample (ms). */
  tUtcMs: number;
  /** TEME/ECI position, km — the 3D console's frame. */
  eciKm: { x: number; y: number; z: number };
  /** Geodetic subpoint for the ground-track map. */
  latDeg: number;
  lonDeg: number;
  altKm: number;
}

/** Options for {@link computeOrbitTrack}. `startUtcMs` is required — services never read the clock. */
export interface OrbitTrackOptions {
  startUtcMs: number;
  /** Track length in minutes (default one nodal-ish period ≈ 95, max 24 h). */
  durationMinutes?: number;
  /** Sample cadence in seconds (default 30). */
  stepSeconds?: number;
}

/** A computed orbit track for one element set. */
export interface OrbitTrack {
  satnum: number;
  satName: string | null;
  startUtcMs: number;
  durationMinutes: number;
  stepSeconds: number;
  points: OrbitTrackPoint[];
}

/** One close-approach event between two catalog entries. */
export interface ConjunctionEvent {
  aId: string;
  bId: string;
  /** Time of closest approach (UTC ms), refined below the coarse step. */
  tcaUtcMs: number;
  /** Miss distance at TCA, km. */
  missKm: number;
  /** Relative speed at TCA, km/s (finite-difference). */
  relSpeedKmS: number;
}

/** Options for {@link screenConjunctions}. `startUtcMs` is required. */
export interface ConjunctionOptions {
  startUtcMs: number;
  /** Screening horizon in hours (default 24, max 72). */
  horizonHours?: number;
  /** Coarse sample cadence in seconds (default 60). */
  stepSeconds?: number;
  /** Report events with refined miss distance at or below this (default 25 km). */
  thresholdKm?: number;
}

/** The full screening report over a catalog set. */
export interface ConjunctionReport {
  startUtcMs: number;
  horizonHours: number;
  stepSeconds: number;
  thresholdKm: number;
  screenedIds: string[];
  /** Events sorted ascending by miss distance. */
  events: ConjunctionEvent[];
}

/** One TLE catalog row — orbit identity for a fleet sat (attitude nodes stay decoupled). */
export interface TleCatalogEntry {
  satId: string;
  name: string | null;
  satnum: number;
  tleRaw: string;
  /** When the entry was registered (UTC ms) — set by the route, the impure boundary. */
  updatedUtcMs: number;
}
