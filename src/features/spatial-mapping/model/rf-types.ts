/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 increment B — RF/router coverage overlay types. A sample is one RSSI reading tied to a place in the scan (an explicit world position OR a keyframe index resolved against the persisted poses). The overlay LOCATES transmitters (path-loss multilateration) and paints a coverage volume on the map. RF is an OVERLAY on the video/LiDAR-built geometry, never a source of geometry (ADR-111) — the honesty note travels with the result.
 */

/**
 * @description One RSSI reading captured somewhere in the scan. Position comes
 * either directly (`position`) or by `keyframeIndex` resolved against poses.json.
 * Samples are grouped by `bssid` (one transmitter per group).
 */
export interface RfSample {
  bssid?: string;
  ssid?: string;
  rssiDbm: number;
  position?: [number, number, number];
  keyframeIndex?: number;
}

/** @description An estimated transmitter (router/beacon) location + fit quality. */
export interface TransmitterEstimate {
  bssid: string | null;
  ssid: string | null;
  position: [number, number, number];
  txPowerDbm: number;
  pathLossExp: number;
  sampleCount: number;
  rmseDb: number;
}

/** @description Coverage summary over the sampled points. */
export interface RfCoverageStats {
  minDbm: number;
  maxDbm: number;
  meanDbm: number;
  deadZoneFraction: number;
}

/** @description The full RF overlay result persisted + returned for a scan. */
export interface RfOverlayResult {
  scanId: string;
  transmitters: TransmitterEstimate[];
  coverage: RfCoverageStats;
  sampleCount: number;
  gaussianCount: number;
  note: string;
}
