"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                        | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 box-side recon service — the real video->3D pipeline the GPU box runs: ns-process-data (ffmpeg frame extraction + COLMAP structure-from-motion) -> ns-train splatfacto (3D gaussian-splat training) -> ns-export gaussian-splat (.ply) -> ply_to_splat (-> .splat). Each stage is a checked subprocess; a non-zero exit raises RuntimeError with the stderr tail so the server marks the job 'error' (never a swallowed failure). A stub mode (RECON_STUB=1) skips the CV toolchain and emits a small valid synthetic .splat so the HTTP protocol is testable on a box with no GPU/COLMAP/nerfstudio installed — it is NOT the product path, only the self-test.
2 | maintainer@emeraldcoastsystemsgroup.com   | Audit fix (CONFIRMED frame-divergence defect): poses were written from raw transforms.json BEFORE training, but splatfacto's dataparser auto-orients/centers/scales the frame and ns-export does NOT undo it — poses.json and scene.splat were in frames differing by a rigid transform + uniform scale on every real scan (RF overlay + relocalization would land in the wrong place). Poses are now written AFTER training with the run's dataparser_transforms.json applied; if that file is missing, poses are SKIPPED (a pose-less scan degrades gracefully in OSHAL — wrong-frame poses would not).
"""

import glob
import json
import math
import os
import struct
import subprocess
from typing import List, Optional, Tuple

from ply_to_splat import convert_ply_to_splat, gaussian_count
from poses import stub_poses, transforms_to_poses

# Tunables (env-overridable) — bounded for an 8GB-VRAM room-scale scene.
MAX_ITERS = os.environ.get("RECON_MAX_ITERS", "7000")
NUM_FRAMES = os.environ.get("RECON_NUM_FRAMES", "300")


def _run(cmd: List[str], cwd: str) -> None:
    """Run a pipeline stage, raising RuntimeError with the stderr tail on failure."""
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-800:]
        raise RuntimeError(f"stage failed ({' '.join(cmd[:2])} rc={proc.returncode}): {tail}")


def _find_one(pattern: str) -> str:
    """Return the single newest path matching a glob, or raise if none."""
    hits = sorted(glob.glob(pattern, recursive=True), key=os.path.getmtime)
    if not hits:
        raise RuntimeError(f"expected output not found: {pattern}")
    return hits[-1]


def run(work_dir: str, source_path: str, source_kind: str, stub: bool) -> Tuple[str, int]:
    """
    Reconstruct a .splat from the source capture. Returns (splat_path, gaussian_count).
    Raises RuntimeError on any stage failure (the server marks the job 'error').
    """
    out_splat = os.path.join(work_dir, "scene.splat")
    if stub:
        data = _stub_splat()
        with open(out_splat, "wb") as f:
            f.write(data)
        _write_poses(work_dir, None, True)
        return out_splat, gaussian_count(data)

    proc_dir = os.path.join(work_dir, "proc")
    train_dir = os.path.join(work_dir, "train")
    export_dir = os.path.join(work_dir, "export")

    # 1. Frames + camera poses: ns-process-data wraps ffmpeg extraction + COLMAP SfM.
    mode = "images" if source_kind == "images" else "video"
    _run(["ns-process-data", mode, "--data", source_path, "--output-dir", proc_dir,
          "--num-frames-target", NUM_FRAMES], work_dir)

    # 2. Train the 3D gaussian splat (GPU). Quit the viewer when training completes.
    _run(["ns-train", "splatfacto", "--data", proc_dir, "--output-dir", train_dir,
          "--max-num-iterations", MAX_ITERS, "--viewer.quit-on-train-completion", "True"], work_dir)

    # Poses (increment A) are written AFTER training on purpose: the dataparser
    # auto-orients/centers/scales the input frame (dataparser_transforms.json) and
    # ns-export does NOT undo it, so poses must be re-expressed in the training
    # frame or they silently float off the splat.
    config = _find_one(os.path.join(train_dir, "**", "config.yml"))
    dp_path = os.path.join(os.path.dirname(config), "dataparser_transforms.json")
    _write_poses(work_dir, proc_dir, False, dp_path)

    # 3. Export the trained model to a gaussian-splat .ply.
    _run(["ns-export", "gaussian-splat", "--load-config", config, "--output-dir", export_dir], work_dir)

    # 4. Convert the exported .ply to the viewer's .splat.
    ply = _find_one(os.path.join(export_dir, "**", "*.ply"))
    with open(ply, "rb") as f:
        splat = convert_ply_to_splat(f.read())
    with open(out_splat, "wb") as f:
        f.write(splat)
    return out_splat, gaussian_count(splat)


def _write_poses(work_dir: str, proc_dir: Optional[str], stub: bool,
                 dataparser_path: Optional[str] = None) -> None:
    """Write poses.json next to the splat (increment A). Best-effort: no transforms -> skip."""
    seed = os.path.basename(work_dir.rstrip("/\\")) or "scan"
    if stub:
        poses = stub_poses(seed)
    else:
        tf = os.path.join(proc_dir or "", "transforms.json")
        if not os.path.exists(tf):
            return
        if not dataparser_path or not os.path.exists(dataparser_path):
            # Without the dataparser transform the poses would be in the WRONG frame
            # relative to the exported splat — worse than no poses at all (the RF
            # overlay/relocalization would be silently misplaced). A pose-less job
            # degrades gracefully on the OSHAL side, so skip loudly.
            print(f"[pipeline] dataparser_transforms.json not found at {dataparser_path} — "
                  "skipping poses (would be frame-divergent)", flush=True)
            return
        with open(dataparser_path) as f:
            dp = json.load(f)
        with open(tf) as f:
            poses = transforms_to_poses(json.load(f), seed, dp)
    with open(os.path.join(work_dir, "poses.json"), "w") as f:
        json.dump(poses, f)


def _stub_splat() -> bytes:
    """A small deterministic synthetic room (~1800 gaussians) — self-test only, not the product."""
    recs = []
    n = 30
    for i in range(n):
        for j in range(n):
            u, v = i / (n - 1), j / (n - 1)
            for face in ((u, 0.0, v, 150, 130, 110), (u, 1.0, v, 210, 210, 214)):
                x, y, z, r, g, b = face
                recs.append(struct.pack("<3f3f4B4B", x, y, z, 0.05, 0.01, 0.05, r, g, b, 255, 255, 128, 128, 128))
    return b"".join(recs)
