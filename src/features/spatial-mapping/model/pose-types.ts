/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 pose persistence (increment A) — the per-keyframe camera poses the reconstruction already solves, persisted so the RF/router coverage overlay (increment B) and drone relocalization can place things in the scene. Shape matches the box-side poses.json (scripts/spatial-recon-edge/poses.py) byte-for-byte so the EdgeReconstructionProvider parses the box response straight into ScanPoses. See docs/architecture/spatial-mapping-pose-persistence.md for the frame gotchas this encodes (camera-to-world center, OpenCV<->OpenGL convention).
 */

/**
 * @description The coordinate frame the poses + splat share. Named explicitly so
 * downstream (overlay, relocalization) never guesses. `convention` MUST match what
 * the viewer renders; `metric` is false until a fiducial/device anchor sets the scale.
 */
export interface WorldFrame {
  convention: 'opencv' | 'opengl';
  metric: boolean;
  scaleSource: 'none' | 'fiducial' | 'arkit' | 'realsense' | 'device-poses' | 'manual';
  scale: number;
  gravityAligned: boolean;
  upAxis: 'x' | 'y' | 'z';
}

/**
 * @description One keyframe's camera pose (camera-to-world) + pinhole intrinsics,
 * expressed in the scan's {@link WorldFrame}.
 */
export interface KeyframePose {
  index: number;
  imageRef: string | null;
  center: [number, number, number];
  quat: [number, number, number, number];
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

/** @description The full pose set for one scan: its frame + every keyframe pose. */
export interface ScanPoses {
  scanId: string;
  frame: WorldFrame;
  keyframes: KeyframePose[];
}
