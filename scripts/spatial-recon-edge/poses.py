"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                        | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 pose persistence (increment A), box-side — export the per-frame camera poses the pipeline already solves. Source is nerfstudio's proc/transforms.json (written by ns-process-data), whose transform_matrix is camera-to-world OpenGL. Emits the ScanPoses shape the TS pose-types.ts consumes. stub_poses() feeds the server's stub mode so /jobs/:id/poses is testable with no GPU.
2 | maintainer@emeraldcoastsystemsgroup.com   | Audit fix (CONFIRMED frame-divergence defect): the earlier entry claimed transforms.json was "the SAME frame the splat is trained in" — WRONG on the shipped toolchain. Splatfacto's NerfstudioDataParser defaults auto-orient ("up"), center, and auto-scale the input poses (recorded in the run's dataparser_transforms.json), and ns-export gaussian-splat exports model.means WITHOUT undoing that — so the splat lives in the TRAINING frame, not the transforms.json frame. transforms_to_poses now takes the dataparser dict and pre-multiplies every pose (rotation+translation by `transform`, then translation x `scale`), exactly mirroring nerfstudio's own pose pipeline, so poses.json lands in the same frame as scene.splat.
"""

import math
import os
from typing import Dict, List, Optional

# The frame nerfstudio transforms.json (and thus the trained splat) lives in.
_OPENGL_FRAME = {
    "convention": "opengl",
    "metric": False,          # COLMAP/nerfstudio scale is arbitrary until anchored (fiducial/device)
    "scaleSource": "none",
    "scale": 1.0,
    "gravityAligned": False,
    "upAxis": "y",
}


def _mat_to_quat(m: List[List[float]]) -> List[float]:
    """3x3 rotation matrix -> (w, x, y, z) quaternion."""
    t = m[0][0] + m[1][1] + m[2][2]
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        return [0.25 * s, (m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s]
    if m[0][0] > m[1][1] and m[0][0] > m[2][2]:
        s = math.sqrt(1.0 + m[0][0] - m[1][1] - m[2][2]) * 2
        return [(m[2][1] - m[1][2]) / s, 0.25 * s, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s]
    if m[1][1] > m[2][2]:
        s = math.sqrt(1.0 + m[1][1] - m[0][0] - m[2][2]) * 2
        return [(m[0][2] - m[2][0]) / s, (m[0][1] + m[1][0]) / s, 0.25 * s, (m[1][2] + m[2][1]) / s]
    s = math.sqrt(1.0 + m[2][2] - m[0][0] - m[1][1]) * 2
    return [(m[1][0] - m[0][1]) / s, (m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, 0.25 * s]


def _intrinsics(transforms: Dict, frame: Dict) -> Dict[str, float]:
    """Per-frame intrinsics, falling back to the transforms-level globals."""
    def g(key: str, default: float) -> float:
        return float(frame.get(key, transforms.get(key, default)))
    return {"fx": g("fl_x", 0.0), "fy": g("fl_y", 0.0), "cx": g("cx", 0.0),
            "cy": g("cy", 0.0), "width": int(g("w", 0)), "height": int(g("h", 0))}


def _apply_dataparser(m: List[List[float]], dp: Dict) -> List[List[float]]:
    """
    Re-express one camera-to-world matrix in the TRAINING frame: rows = T @ M
    (T = the 3x4 `transform` from dataparser_transforms.json; M padded with
    [0,0,0,1]), then translation x `scale` — exactly what the NerfstudioDataParser
    did to the poses the splat was trained (and exported) in.
    """
    t = dp["transform"]
    scale = float(dp.get("scale", 1.0))
    out = []
    for r in range(3):
        row = []
        for c in range(4):
            v = sum(float(t[r][k]) * float(m[k][c]) for k in range(3))
            if c == 3:
                v += float(t[r][3])
            row.append(v)
        out.append(row)
    for r in range(3):
        out[r][3] *= scale
    return out


def transforms_to_poses(transforms: Dict, scan_id: str, dataparser: Optional[Dict] = None) -> Dict:
    """
    Convert a nerfstudio transforms.json dict to the ScanPoses shape. When the
    training run's dataparser dict (dataparser_transforms.json) is given, every
    pose is re-expressed in the training frame so it lines up with the exported
    splat; without it the poses stay in the raw transforms.json frame — which on
    the shipped toolchain does NOT match the export (caller must handle that).
    """
    keyframes = []
    for i, fr in enumerate(transforms.get("frames", [])):
        m = fr.get("transform_matrix")
        if not m or len(m) < 3:
            continue
        if dataparser is not None:
            m = _apply_dataparser(m, dataparser)
        rot = [[m[r][c] for c in range(3)] for r in range(3)]
        intr = _intrinsics(transforms, fr)
        keyframes.append({
            "index": i,
            "imageRef": os.path.basename(fr.get("file_path", "")) or None,
            "center": [float(m[0][3]), float(m[1][3]), float(m[2][3])],
            "quat": _mat_to_quat(rot),
            **intr,
        })
    return {"scanId": scan_id, "frame": dict(_OPENGL_FRAME), "keyframes": keyframes}


def stub_poses(scan_id: str) -> Dict:
    """A small synthetic orbit of keyframes — self-test only (no GPU)."""
    keyframes = []
    for i in range(8):
        a = i / 8 * 2 * math.pi
        keyframes.append({
            "index": i, "imageRef": f"frame_{i:03d}.jpg",
            "center": [2.0 * math.cos(a), 1.5, 2.0 * math.sin(a)],
            "quat": [math.cos(a / 2), 0.0, math.sin(a / 2), 0.0],
            "fx": 1000.0, "fy": 1000.0, "cx": 960.0, "cy": 540.0, "width": 1920, "height": 1080,
        })
    return {"scanId": scan_id, "frame": dict(_OPENGL_FRAME), "keyframes": keyframes}
