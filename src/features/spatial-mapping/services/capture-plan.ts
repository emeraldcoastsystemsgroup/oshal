/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 Phase 2/3 first increments — the capture-plan engine. Human and drone are interchangeable CAPTURE ACTUATORS executing the same plan: generateCapturePlan() emits the step-by-step walk guidance a person follows while filming (research-grounded: slow orbits at two heights, loop closure, texture/parallax rules, ArUco fiducial for metric scale), and droneScanPattern() emits the same coverage intent as photo waypoints — orbit rings whose angular spacing is derived from the camera FOV + a photogrammetry overlap target (adjacent-shot baseline vs image footprint), ready to validate/fly as a MissionPlan. Pure and deterministic — no I/O, no LLM; the spaces-operator bot can later PERSONALIZE plans, but the engine is the honest always-available default (same pattern as the Sim providers).
 */

/** One instruction the capture actuator (human or drone) executes in order. */
export interface CapturePlanStep {
  /** Short imperative title ("Slow lap at chest height"). */
  title: string;
  /** The full instruction the surface reads out / displays. */
  instruction: string;
  /** Rough seconds this step should take (pacing hint, not a timer). */
  seconds: number;
  /** What the step is for — lets surfaces group/badge steps. */
  kind: 'prep' | 'scale' | 'capture' | 'closure';
}

/** A complete ordered capture plan for one target kind. */
export interface CapturePlan {
  target: CaptureTarget;
  steps: CapturePlanStep[];
  /** Always-on rules shown alongside every step. */
  tips: string[];
  /** Honest note about metric scale (fiducial at CAPTURE time or the scan stays unit-less). */
  scaleNote: string;
}

export type CaptureTarget = 'room' | 'large-room' | 'object' | 'facade';

const TIPS = [
  'Move SLOWLY — half your normal walking pace. Motion blur is the #1 reconstruction killer.',
  'Keep 60–80% of each view overlapping the previous one; never "teleport" the camera.',
  'Favor texture-rich framing; avoid filling the frame with bare walls, mirrors, windows or screens.',
  'Lock exposure/focus if your camera app allows it; turn every light on and keep it constant.',
];

const SCALE_NOTE =
  'For real-world measurements, place a printed ArUco marker (or any object of exactly known size) '
  + 'visibly in the FIRST seconds of capture — scale can NEVER be recovered after the fact.';

/**
 * @description Build the ordered step-by-step capture plan a human follows while
 * filming (the "tells you where to go" guidance). Deterministic per target.
 * @param target - What is being captured
 * @returns The full plan (steps + always-on tips + scale note)
 */
export function generateCapturePlan(target: CaptureTarget = 'room'): CapturePlan {
  const steps: CapturePlanStep[] = [
    {
      title: 'Prepare the space',
      instruction: 'Turn on every light. Open interior doors you want captured; close mirrors/TVs out of view where possible. Clear walkways so you can move without looking down.',
      seconds: 60, kind: 'prep',
    },
    {
      title: 'Place the scale marker',
      instruction: 'Put the printed ArUco marker (or a known-size object, e.g. an A4 sheet) flat and visible where you will START filming. Hold the first shot on it for ~3 seconds.',
      seconds: 20, kind: 'scale',
    },
  ];
  if (target === 'object') {
    steps.push(
      {
        title: 'High orbit',
        instruction: 'Circle the object once, camera angled slightly DOWN at it, about 1 m away. Full 360° — end where you started.',
        seconds: 45, kind: 'capture',
      },
      {
        title: 'Level orbit',
        instruction: 'Circle again at the object\'s mid-height, camera level. Keep the object filling ~2/3 of frame.',
        seconds: 45, kind: 'capture',
      },
      {
        title: 'Low orbit + top pass',
        instruction: 'A third circle from below angled UP, then one slow pass directly over the top.',
        seconds: 45, kind: 'capture',
      },
    );
  } else if (target === 'facade') {
    steps.push(
      {
        title: 'Wide establishing pass',
        instruction: 'Walk the full width of the facade at a distance where the whole face fits in frame, camera level.',
        seconds: 60, kind: 'capture',
      },
      {
        title: 'Close detail pass',
        instruction: 'Walk the width again at half the distance, overlapping strips: one pass at eye level, one angled up at the upper floor/roofline.',
        seconds: 90, kind: 'capture',
      },
      {
        title: 'Corner wraps',
        instruction: 'At each end, wrap around the corner a few meters so the sides tie in.',
        seconds: 40, kind: 'capture',
      },
    );
  } else {
    const big = target === 'large-room';
    steps.push(
      {
        title: 'Slow lap at chest height',
        instruction: 'Walk the room\'s perimeter ONCE, camera at chest height pointed at the opposite wall (across the room, not at the wall beside you). Pan gently — no whips.',
        seconds: big ? 120 : 75, kind: 'capture',
      },
      {
        title: 'Second lap at knee height',
        instruction: 'Same perimeter lap, camera lowered to knee height and angled slightly up. This fills in under-furniture and ceiling geometry the first lap missed.',
        seconds: big ? 120 : 75, kind: 'capture',
      },
      {
        title: 'Cross the middle',
        instruction: big
          ? 'Walk two crossing diagonals through the middle of the space, panning slowly left-right as you go.'
          : 'Walk one diagonal through the middle of the room, panning slowly left-right.',
        seconds: big ? 60 : 30, kind: 'capture',
      },
      {
        title: 'Detail the anchors',
        instruction: 'Slowly arc past 2–3 feature-rich anchors (bookshelf, desk, artwork) at ~1 m, letting each fill the frame from two angles.',
        seconds: 45, kind: 'capture',
      },
    );
  }
  steps.push({
    title: 'Close the loop',
    instruction: 'Finish by walking BACK to the exact spot you started and re-framing your first view (marker included). Loop closure is what locks the whole reconstruction together.',
    seconds: 20, kind: 'closure',
  });
  return { target, steps, tips: TIPS, scaleNote: SCALE_NOTE };
}

// ── Drone side: the same coverage intent as flyable photo waypoints ──────────

/** Options for a drone scan pattern. All distances meters, angles degrees. */
export interface DroneScanOptions {
  /** Orbit center + launch reference (WGS-84). */
  home: { lat: number; lon: number };
  /** Orbit radius from center. */
  radiusM: number;
  /** One orbit ring per altitude (AGL). */
  altitudesM: number[];
  /** Adjacent-photo overlap target, 0..0.9 (photogrammetry wants 0.7–0.8). */
  overlapPct: number;
  /** Camera horizontal field of view. */
  fovDeg: number;
}

/** A generated scan pattern: photo waypoints + the math that produced them. */
export interface DroneScanPattern {
  waypoints: Array<{
    lat: number; lon: number; alt: number; headingDeg: number;
    camera: { op: 'photo'; tiltDeg: number };
  }>;
  /** Photos per ring (= waypoints per ring). */
  perRing: number;
  /** Angular step between shots, degrees. */
  stepDeg: number;
  ringCount: number;
}

const EARTH_M_PER_DEG_LAT = 111_320;

/**
 * @description Generate an inward-facing orbit scan pattern with photogrammetry
 * overlap math: the image footprint at the orbit center is 2·r·tan(fov/2); the
 * baseline between adjacent shots is the orbit arc r·θ; requiring
 * baseline ≤ (1−overlap)·footprint gives θ = (1−overlap)·2·tan(fov/2).
 * Each waypoint faces the center and fires a photo; rings stack per altitude
 * (upper rings tilt the camera down toward the scene).
 * @param opts - Pattern options (center, radius, altitudes, overlap, FOV)
 * @returns The flyable waypoint list + derivation numbers
 */
export function droneScanPattern(opts: DroneScanOptions): DroneScanPattern {
  const overlap = Math.min(0.9, Math.max(0, opts.overlapPct));
  const fovRad = (Math.max(20, Math.min(140, opts.fovDeg)) * Math.PI) / 180;
  const thetaRad = (1 - overlap) * 2 * Math.tan(fovRad / 2);
  const perRing = Math.max(6, Math.ceil((2 * Math.PI) / thetaRad));
  const stepDeg = 360 / perRing;
  const mPerDegLon = EARTH_M_PER_DEG_LAT * Math.cos((opts.home.lat * Math.PI) / 180);
  const baseAlt = Math.min(...opts.altitudesM);
  const waypoints: DroneScanPattern['waypoints'] = [];
  for (const alt of opts.altitudesM) {
    // Higher rings look DOWN into the scene; the base ring shoots level.
    const tiltDeg = alt <= baseAlt ? 0 : -Math.min(45, Math.round(
      (Math.atan2(alt - baseAlt, opts.radiusM) * 180) / Math.PI,
    ));
    for (let i = 0; i < perRing; i++) {
      const a = (i / perRing) * 2 * Math.PI; // angle from center, 0 = east
      const east = opts.radiusM * Math.cos(a);
      const north = opts.radiusM * Math.sin(a);
      // Compass bearing from the waypoint toward the center (inward-facing).
      const headingDeg = ((Math.atan2(-east, -north) * 180) / Math.PI + 360) % 360;
      waypoints.push({
        lat: opts.home.lat + north / EARTH_M_PER_DEG_LAT,
        lon: opts.home.lon + east / mPerDegLon,
        alt,
        headingDeg: Math.round(headingDeg),
        camera: { op: 'photo', tiltDeg },
      });
    }
  }
  return { waypoints, perRing, stepDeg, ringCount: opts.altitudesM.length };
}
