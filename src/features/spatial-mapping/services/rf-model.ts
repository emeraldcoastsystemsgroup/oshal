/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 increment B — the RF math core (pure, no I/O). Log-distance path loss rssi = A - 10*n*log10(d); Levenberg-Marquardt multilateration to recover a transmitter's position + reference power A from {position -> rssi} samples with n fixed (small rooms defeat empirical PLE fitting — research verdict, use n=2.0); inverse-distance-weighted coverage interpolation; and a synthetic-sample generator so the whole overlay is exercisable with no radio hardware. Numbers are room-level, not centimeter — the honest RSSI ceiling.
 */

/** Default path-loss exponent (free space ~2; rises with obstacles). */
export const DEFAULT_PATH_LOSS_EXP = 2.0;
/** RSSI at/below this (dBm) counts as a dead zone. */
export const DEAD_ZONE_DBM = -75;

type Vec3 = [number, number, number];

const LN10 = Math.LN10;
const dist = (a: Vec3, b: Vec3): number =>
  Math.max(0.1, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));

/**
 * @description Expected RSSI at a distance under the log-distance model.
 * @param txPower - Reference power A (RSSI at 1 m, dBm)
 * @param n - Path-loss exponent
 * @param d - Distance (m)
 * @returns Modelled RSSI (dBm)
 */
export function expectedRssi(txPower: number, n: number, d: number): number {
  return txPower - 10 * n * Math.log10(Math.max(0.1, d));
}

/** Solve a 4x4 linear system A x = b via Gaussian elimination (partial pivot). */
function solve4(A: number[][], b: number[]): number[] | null {
  const m = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 4; c++) {
    let piv = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-12) return null;
    [m[c], m[piv]] = [m[piv], m[c]];
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [m[0][4] / m[0][0], m[1][4] / m[1][1], m[2][4] / m[2][2], m[3][4] / m[3][3]];
}

/** RSSI-power-weighted centroid — the multilateration starting point. */
function weightedCentroid(pos: Vec3[], rssi: number[]): Vec3 {
  let wx = 0, wy = 0, wz = 0, wsum = 0;
  for (let i = 0; i < pos.length; i++) {
    const w = Math.pow(10, rssi[i] / 10); // linear power
    wx += w * pos[i][0]; wy += w * pos[i][1]; wz += w * pos[i][2]; wsum += w;
  }
  return wsum > 0 ? [wx / wsum, wy / wsum, wz / wsum] : [0, 0, 0];
}

/** @description A multilateration fit: transmitter position, power, and residual. */
export interface TransmitterFit {
  position: Vec3;
  txPowerDbm: number;
  rmseDb: number;
}

/**
 * @description Estimate a transmitter's position + reference power from RSSI
 * samples at known positions, via Levenberg-Marquardt on the log-distance model
 * (path-loss exponent fixed). Solves FOUR unknowns (x, y, z, txPower) — needs
 * >= 4 well-spread samples to be determined; with fewer it still returns a fit,
 * but the position is an arbitrary point on a solution manifold and the near-zero
 * RMSE is false confidence (callers gate on sample count, see RfOverlayService).
 * @param pos - Sample world positions
 * @param rssi - RSSI (dBm) at each position (same order)
 * @param n - Path-loss exponent (default 2.0)
 * @returns The fit (position, txPower, RMSE)
 */
export function estimateTransmitter(pos: Vec3[], rssi: number[], n: number = DEFAULT_PATH_LOSS_EXP): TransmitterFit {
  let X = weightedCentroid(pos, rssi);
  let A = Math.max(...rssi) + 10 * n * Math.log10(2); // ~power one "unit" from the strongest sample
  let lambda = 1e-2;
  const k = (10 * n) / LN10;
  for (let iter = 0; iter < 60; iter++) {
    const JtJ = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const Jtr = [0, 0, 0, 0];
    let sse = 0;
    for (let i = 0; i < pos.length; i++) {
      const d = dist(X, pos[i]);
      const r = rssi[i] - (A - 10 * n * Math.log10(d));
      const g = [k * (X[0] - pos[i][0]) / (d * d), k * (X[1] - pos[i][1]) / (d * d), k * (X[2] - pos[i][2]) / (d * d), -1];
      for (let a = 0; a < 4; a++) {
        Jtr[a] += g[a] * r;
        for (let b = 0; b < 4; b++) JtJ[a][b] += g[a] * g[b];
      }
      sse += r * r;
    }
    for (let a = 0; a < 4; a++) JtJ[a][a] += lambda * JtJ[a][a] + 1e-9;
    const delta = solve4(JtJ, Jtr.map((v) => -v));
    if (!delta) break;
    const nX: Vec3 = [X[0] + delta[0], X[1] + delta[1], X[2] + delta[2]];
    const nA = A + delta[3];
    let nsse = 0;
    for (let i = 0; i < pos.length; i++) nsse += Math.pow(rssi[i] - expectedRssi(nA, n, dist(nX, pos[i])), 2);
    if (nsse < sse) { X = nX; A = nA; lambda = Math.max(lambda * 0.5, 1e-6); } else { lambda = Math.min(lambda * 4, 1e6); }
  }
  let sse = 0;
  for (let i = 0; i < pos.length; i++) sse += Math.pow(rssi[i] - expectedRssi(A, n, dist(X, pos[i])), 2);
  return { position: X, txPowerDbm: A, rmseDb: Math.sqrt(sse / pos.length) };
}

/**
 * @description Inverse-distance-weighted RSSI at a query point from samples.
 * @param pos - Sample positions
 * @param rssi - RSSI at each sample
 * @param q - Query position
 * @param power - IDW power (2 = classic)
 * @returns Interpolated RSSI (dBm)
 */
export function idwRssi(pos: Vec3[], rssi: number[], q: Vec3, power = 2): number {
  let num = 0, den = 0;
  for (let i = 0; i < pos.length; i++) {
    const d = dist(q, pos[i]);
    if (d <= 0.11) return rssi[i];
    const w = 1 / Math.pow(d, power);
    num += w * rssi[i]; den += w;
  }
  return den > 0 ? num / den : DEAD_ZONE_DBM;
}

/**
 * @description Generate synthetic RSSI samples at given positions from a placed
 * transmitter — the no-hardware demo path (deterministic given a seeded jitter).
 * @param pos - Positions to sample at (e.g. keyframe centers)
 * @param tx - Transmitter position
 * @param txPower - Reference power A (dBm)
 * @param n - Path-loss exponent
 * @param jitter - Per-sample index -> noise (dB); pass () => 0 for clean
 * @returns RSSI (dBm) at each position
 */
export function syntheticRssi(pos: Vec3[], tx: Vec3, txPower: number, n: number, jitter: (i: number) => number): number[] {
  return pos.map((p, i) => expectedRssi(txPower, n, dist(tx, p)) + jitter(i));
}
