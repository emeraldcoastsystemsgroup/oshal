/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Sat-Ops (ADR-102) forced-conjugate referee
 *                     |                             | gate: capture a live NASA 42 star-tracker/gyro stream
 *                     |                             | with its handshake frames, re-encode every fix into the
 *                     |                             | opposite wire convention, and replay either encoding
 *                     |                             | back through the REAL Nasa42SimAdapter over a local
 *                     |                             | socket. The comparison therefore exercises the shipped
 *                     |                             | decode + MEKF path, not a twin of it.
 */

import net from 'net';
import type { Quat } from '../model/sat-types';
import type { Vec3 } from '../model/sat-types';
import { quatConjugate, quatMultiply, quatNormalize } from './sat-math';
import {
  ACK,
  detectQuatConvention,
  groupVec3,
  IN_LAYOUT,
  layoutLength,
  parseAcArraySizes,
  parseAcBufLens,
  readLayout,
  scalarLastToQuat,
  solveOmegaFromGyros,
  TBL_LAYOUT,
  writeLayout,
  type AcArraySizes,
  type AcBufLens,
} from './nasa42-codec';
import { nasa42StarTrackerBodyBase, type Nasa42QuaternionConvention } from './nasa42-sim-adapter';

/**
 * One captured FSW cycle, holding only the fields the attitude estimate consumes: the star
 * tracker's validity flag and quaternion, and the gyro rates. Everything else in 42's In
 * message (magnetometers, CSS/FSS, GPS, wheel tachometers) is replayed as zeros — none of it
 * reaches the MEKF, so zeroing it cannot move an acceptance, rejection or reinitialization.
 */
export interface Nasa42CaptureCycle {
  /** 42's per-tracker validity longs (`stValid`), verbatim. */
  stValid: number[];
  /** 42's scalar-last tracker quaternion (`stQn`), verbatim. */
  stQn: number[];
  /** 42's per-gyro rate scalars (`gyroRate`), verbatim. */
  gyroRate: number[];
}

/** A captured NASA 42 run: the handshake frames plus every cycle's sensor fields. */
export interface Nasa42Capture {
  /** Where it came from — image tag, container, host:port. */
  source: string;
  /** ISO timestamp of the capture. */
  capturedAt: string;
  /** The 42 commit the container was built from (`FORTYTWO_REF`). */
  fortyTwoRef: string;
  /** Which encoding these wire fixes are in; `native` means "exactly what 42 sent". */
  wireConvention: Nasa42QuaternionConvention | 'native';
  /**
   * The convention the live run was force-locked to. It is 42's native encoding when the
   * mission it flew converged, and the mirrored one when it did not — which is a physical
   * fact about the run, not a self-report, and the referee replay proves the direction.
   */
  flownConvention: Nasa42QuaternionConvention;
  /** The residual voter's ballots over this same stream, recorded at capture time. */
  voterVotes: { conjugate: number; direct: number };
  /** Base64 of 42's 96-byte array-sizes frame. */
  sizesBase64: string;
  /** Base64 of 42's 24-byte buffer-lengths frame. */
  lensBase64: string;
  /** Base64 of 42's one-time table frame (mass properties, mounts, limits). */
  tblBase64: string;
  /** One entry per FSW cycle, in order, starting at the handshake's first In message. */
  cycles: Nasa42CaptureCycle[];
}

/**
 * A capture's wire content without the two facts recorded ABOUT the run. Everything that
 * decodes or re-encodes the stream needs only this, so a half-built capture can be voted on
 * while it is being assembled.
 */
export type Nasa42CaptureStream = Omit<Nasa42Capture, 'flownConvention' | 'voterVotes'>;

/** A running replay server: the port to connect to, and a way to shut it down. */
export interface Nasa42ReplayServer {
  /** Loopback port the server is listening on. */
  port: number;
  /** Close the listener and any live connection. */
  close: () => Promise<void>;
}

/**
 * @description Re-encode one NASA 42 star-tracker wire fix into the opposite quaternion
 * convention, preserving the physical attitude it describes. 42 builds the sample as
 * `q_meas = q_native ⊗ q_mount`; the two conventions differ by conjugating `q_native`, so the
 * twin is `conjugate(q_meas ⊗ q_mount*) ⊗ q_mount`. Decoding the twin under the opposite
 * convention yields the same body-to-inertial attitude as decoding the original under its own
 * — which is precisely the claim the referee gate has to test on real data.
 * @param stQn - Scalar-last wire quaternion `[x, y, z, w]` as 42 sent it.
 * @param stMount - Unit star-tracker-to-body mount quaternion from 42's table message.
 * @returns The scalar-last wire quaternion of the opposite-convention twin.
 */
export function conjugateWireFix(stQn: number[], stMount: Quat): number[] {
  const twinBase = quatConjugate(nasa42StarTrackerBodyBase(stQn, stMount));
  const qMeas = quatNormalize(quatMultiply(twinBase, stMount));
  return [qMeas.x, qMeas.y, qMeas.z, qMeas.w];
}

/**
 * @description Produce the opposite-convention twin of a whole capture. Invalid cycles are
 * copied untouched (42 leaves a stale quaternion behind an invalid flag and the adapter never
 * reads it), so the two streams go valid and invalid on exactly the same cycles.
 * @param capture - The captured run.
 * @param stMount - The star-tracker mount quaternion from the same run's table message.
 * @param wireConvention - The label to stamp on the twin.
 * @returns A new capture; the input is not mutated.
 */
export function conjugateCaptureWire(
  capture: Nasa42Capture,
  stMount: Quat,
  wireConvention: Nasa42QuaternionConvention,
): Nasa42Capture {
  return {
    ...capture,
    wireConvention,
    cycles: capture.cycles.map((cycle) => ({
      stValid: [...cycle.stValid],
      stQn: cycle.stValid[0] === 0 ? [...cycle.stQn] : conjugateWireFix(cycle.stQn, stMount),
      gyroRate: [...cycle.gyroRate],
    })),
  };
}

/** The three table facts a capture's own re-encoding and voter replay need. */
export interface Nasa42CaptureVehicle {
  /** 42's star-tracker mount quaternion (`ST.qb`). */
  stMount: Quat;
  /** 42's gyro sensing axes in the body frame. */
  gyroAxes: Vec3[];
  /** 42's FSW sample time, seconds. */
  dtSeconds: number;
}

/**
 * @description Read the mount, gyro axes and FSW step back out of a capture's own table
 * frame. The re-encoding and the voter replay must use 42's values, never re-derived ones.
 * @param capture - The captured run.
 * @returns The mount quaternion (identity when the run carried no tracker), gyro axes and step.
 */
export function captureVehicle(capture: Nasa42CaptureStream): Nasa42CaptureVehicle {
  const sizes = parseAcArraySizes(Buffer.from(capture.sizesBase64, 'base64'));
  const tbl = readLayout(Buffer.from(capture.tblBase64, 'base64'), TBL_LAYOUT, sizes);
  return {
    stMount: sizes.nst > 0 ? quatNormalize(scalarLastToQuat(tbl.stQb.slice(0, 4))) : { w: 1, x: 0, y: 0, z: 0 },
    gyroAxes: groupVec3(tbl.gyroAxis, sizes.ngyro),
    dtSeconds: tbl.dt[0],
  };
}

/**
 * @description Replay the adapter's residual voter over a captured stream to say which
 * encoding 42 was natively sending. A forced run bypasses the voter, so this is how the
 * referee evidence names the as-flown branch and the synthesized twin.
 * @param capture - The captured run, in 42's native encoding.
 * @returns The convention the voter elects and the ballots behind it.
 */
export function captureVoterVerdict(capture: Nasa42CaptureStream): {
  convention: Nasa42QuaternionConvention;
  votes: { conjugate: number; direct: number };
} {
  const { stMount, gyroAxes, dtSeconds } = captureVehicle(capture);
  const votes = { conjugate: 0, direct: 0 };
  let prev: Quat | null = null;
  for (const cycle of capture.cycles) {
    if (cycle.stValid[0] === 0) {
      prev = null;
      continue;
    }
    const base = nasa42StarTrackerBodyBase(cycle.stQn, stMount);
    if (prev) votes[detectQuatConvention(prev, base, solveOmegaFromGyros(gyroAxes, cycle.gyroRate), dtSeconds)]++;
    prev = base;
  }
  return { convention: votes.conjugate >= votes.direct ? 'conjugate' : 'direct', votes };
}

/**
 * @description The array sizes and buffer lengths a capture was recorded with, decoded from
 * 42's own handshake frames rather than re-derived.
 * @param capture - The captured run.
 * @returns 42's array sizes and its In/Out/Tbl message lengths.
 */
export function captureLayout(capture: Nasa42CaptureStream): { sizes: AcArraySizes; lens: AcBufLens } {
  return {
    sizes: parseAcArraySizes(Buffer.from(capture.sizesBase64, 'base64')),
    lens: parseAcBufLens(Buffer.from(capture.lensBase64, 'base64')),
  };
}

/** Serialize one captured cycle into a full In message (unreported fields zero-filled). */
function inMessage(cycle: Nasa42CaptureCycle, sizes: AcArraySizes): Buffer {
  return writeLayout(IN_LAYOUT, sizes, {
    stValid: cycle.stValid,
    stQn: cycle.stQn,
    gyroRate: cycle.gyroRate,
  });
}

/** Accumulating exact-length reader over one replay connection. */
class ReplayReader {
  private have: Buffer = Buffer.alloc(0);

  private waiter: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;

  private closed = false;

  constructor(socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.have = Buffer.concat([this.have, chunk]);
      this.pump();
    });
    socket.on('close', () => {
      this.closed = true;
      this.waiter?.reject(new Error('the replay peer closed mid-message'));
      this.waiter = null;
    });
  }

  private pump(): void {
    if (!this.waiter || this.have.length < this.waiter.n) return;
    const { n, resolve } = this.waiter;
    this.waiter = null;
    const out = Buffer.from(this.have.subarray(0, n));
    this.have = this.have.subarray(n);
    resolve(out);
  }

  /**
   * @description Resolve with exactly `n` bytes, or reject once the peer has gone.
   * @param n - Byte count.
   * @returns The bytes.
   */
  readExact(n: number): Promise<Buffer> {
    if (this.closed && this.have.length < n) return Promise.reject(new Error('the replay peer is closed'));
    return new Promise((resolve, reject) => {
      this.waiter = { n, resolve, reject };
      this.pump();
    });
  }
}

/** Drive one accepted connection through the captured handshake and every captured cycle. */
async function serveCapture(socket: net.Socket, capture: Nasa42Capture): Promise<void> {
  const reader = new ReplayReader(socket);
  const { sizes, lens } = captureLayout(capture);
  socket.write(Buffer.from(capture.sizesBase64, 'base64'));
  await reader.readExact(ACK.length);
  socket.write(Buffer.from(capture.lensBase64, 'base64'));
  await reader.readExact(ACK.length);
  socket.write(Buffer.from(capture.tblBase64, 'base64'));
  await reader.readExact(ACK.length);
  socket.write(inMessage(capture.cycles[0], sizes));
  await reader.readExact(ACK.length);
  for (let i = 1; i < capture.cycles.length; i++) {
    await reader.readExact(lens.outLen);
    socket.write(ACK);
    socket.write(inMessage(capture.cycles[i], sizes));
    await reader.readExact(ACK.length);
  }
  socket.end();
}

/**
 * @description Serve a captured NASA 42 run on a loopback port, speaking 42's own
 * standalone-AC handshake and cycle protocol. `Nasa42SimAdapter.connect` cannot tell it from
 * the container, which is the point: the referee comparison runs the shipped adapter.
 * @param capture - The run to replay.
 * @returns The listening port and a close function.
 */
export async function startNasa42ReplayServer(capture: Nasa42Capture): Promise<Nasa42ReplayServer> {
  if (capture.cycles.length < 1) throw new Error('cannot replay an empty NASA 42 capture');
  const { sizes, lens } = captureLayout(capture);
  const expected = layoutLength(IN_LAYOUT, sizes);
  if (expected !== lens.inLen) {
    throw new Error(`capture In length ${lens.inLen} does not match the codec's ${expected}`);
  }
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    void serveCapture(socket, capture).catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('replay server did not bind a TCP port');
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
