"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                        | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 box-side recon service guard — verifies what CAN be verified without a GPU: the .ply->.splat converter (a point cloud AND a trained-3DGS .ply each pack to a valid 32-byte-stride splat) and the FULL HTTP protocol the OSHAL EdgeReconstructionProvider drives (POST /reconstruct octet-stream -> poll GET /jobs/:id -> GET /jobs/:id/splat) against the stub pipeline. The COLMAP/nerfstudio CV pipeline itself is NOT exercised here (no GPU/tools) — that is the deploy-time end-to-end. Run: `python test_recon.py`.
2 | maintainer@emeraldcoastsystemsgroup.com   | Audit-fix guards: (1) transforms_to_poses applies the dataparser transform+scale (the confirmed frame-divergence fix) — verified against a hand-computed rotation+translation+scale; (2) RECON_TOKEN gate — no/wrong token -> 401, matching token -> 200; (3) _reap_once removes expired terminal jobs and leaves fresh ones.
"""

import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["RECON_STUB"] = "1"
os.environ["RECON_WORK_DIR"] = os.path.join(tempfile.gettempdir(), "oshal-recon-test")

from ply_to_splat import convert_ply_to_splat, gaussian_count  # noqa: E402
from poses import transforms_to_poses  # noqa: E402
import server  # noqa: E402

STRIDE = 32
_failures = []


def check(name: str, cond: bool) -> None:
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}")
    if not cond:
        _failures.append(name)


ASCII_POINTS = "\n".join([
    "ply", "format ascii 1.0", "element vertex 3",
    "property float x", "property float y", "property float z",
    "property uchar red", "property uchar green", "property uchar blue", "end_header",
    "0 0 0 255 0 0", "1 0 0 0 255 0", "0 1 0 0 0 255", "",
]).encode("ascii")

ASCII_3DGS = "\n".join([
    "ply", "format ascii 1.0", "element vertex 1",
    "property float x", "property float y", "property float z",
    "property float f_dc_0", "property float f_dc_1", "property float f_dc_2", "property float opacity",
    "property float scale_0", "property float scale_1", "property float scale_2",
    "property float rot_0", "property float rot_1", "property float rot_2", "property float rot_3", "end_header",
    "0.5 0.5 0.5 1.0 0.0 -1.0 2.0 -3.0 -3.0 -3.0 1 0 0 0", "",
]).encode("ascii")


def test_converter() -> None:
    print("converter:")
    pc = convert_ply_to_splat(ASCII_POINTS)
    check("point cloud -> 3 records", gaussian_count(pc) == 3 and len(pc) == 3 * STRIDE)
    check("point cloud keeps first red byte", pc[24] == 255)
    dgs = convert_ply_to_splat(ASCII_3DGS)
    check("3dgs -> 1 record", gaussian_count(dgs) == 1 and len(dgs) == STRIDE)
    check("3dgs R brighter than B (f_dc 1 vs -1)", dgs[24] > dgs[26])
    check("3dgs identity-ish quat w byte = 255", dgs[28] == 255)
    try:
        convert_ply_to_splat(b"not a ply")
        check("non-PLY rejected", False)
    except ValueError:
        check("non-PLY rejected", True)


def test_poses() -> None:
    print("poses (transforms.json -> poses.json):")
    transforms = {
        "fl_x": 1000.0, "fl_y": 1000.0, "cx": 960.0, "cy": 540.0, "w": 1920, "h": 1080,
        "frames": [
            {"file_path": "images/frame_00001.png",
             "transform_matrix": [[1, 0, 0, 1.5], [0, 1, 0, 2.5], [0, 0, 1, 3.5], [0, 0, 0, 1]]},
            {"file_path": "images/frame_00002.png",
             "transform_matrix": [[1, 0, 0, 4.0], [0, 1, 0, 0.0], [0, 0, 1, 0.0], [0, 0, 0, 1]]},
        ],
    }
    p = transforms_to_poses(transforms, "scan-x")
    k = p["keyframes"]
    check("two keyframes", len(k) == 2)
    check("camera-to-world center is the matrix translation", k[0]["center"] == [1.5, 2.5, 3.5])
    check("identity rotation -> identity quat", [round(v, 3) for v in k[0]["quat"]] == [1.0, 0.0, 0.0, 0.0])
    check("intrinsics carried", k[0]["fx"] == 1000.0 and k[0]["width"] == 1920)
    check("frame is opengl + honest non-metric", p["frame"]["convention"] == "opengl" and p["frame"]["metric"] is False)

    # Dataparser reconciliation (the confirmed frame-divergence fix): identity
    # dataparser leaves poses untouched; a rotation+translation+scale dataparser
    # re-expresses them exactly as nerfstudio does (rows = T @ M, translation x scale).
    ident = {"transform": [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]], "scale": 1.0}
    p_id = transforms_to_poses(transforms, "scan-x", ident)
    check("identity dataparser leaves center unchanged", p_id["keyframes"][0]["center"] == [1.5, 2.5, 3.5])
    dp = {"transform": [[0, 0, 1, 1], [1, 0, 0, 2], [0, 1, 0, 3]], "scale": 2.0}
    p_dp = transforms_to_poses(transforms, "scan-x", dp)
    # Hand-computed: T@M translation = [3.5+1, 1.5+2, 2.5+3] = [4.5, 3.5, 5.5]; x2 scale.
    check("dataparser transform+scale applied to center",
          [round(v, 6) for v in p_dp["keyframes"][0]["center"]] == [9.0, 7.0, 11.0])
    q = p_dp["keyframes"][0]["quat"]
    check("rotated pose quat stays unit-norm", abs(sum(v * v for v in q) - 1.0) < 1e-6)


def _http(method: str, url: str, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status, r.read()


def test_protocol() -> None:
    print("protocol (stub pipeline):")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    try:
        st, body = _http("GET", f"{base}/health")
        check("GET /health 200", st == 200 and json.loads(body).get("ok") is True)

        st, body = _http("POST", f"{base}/reconstruct", data=b"pretend-video-bytes",
                         headers={"Content-Type": "application/octet-stream",
                                  "X-Scan-Id": "s1", "X-Source-Name": "living%20room.mp4", "X-Source-Kind": "video"})
        job_id = json.loads(body).get("jobId")
        check("POST /reconstruct -> jobId", st == 200 and bool(job_id))

        status, count = None, None
        for _ in range(100):
            _, b = _http("GET", f"{base}/jobs/{job_id}")
            j = json.loads(b)
            status, count = j.get("status"), j.get("gaussianCount")
            if status in ("done", "error"):
                break
            time.sleep(0.05)
        check("job reaches done", status == "done")
        check("done reports a gaussianCount", isinstance(count, int) and count > 0)

        st, splat = _http("GET", f"{base}/jobs/{job_id}/splat")
        check("GET /jobs/:id/splat 200", st == 200)
        check("splat is a non-zero multiple of 32", len(splat) > 0 and len(splat) % STRIDE == 0)
        check("splat count matches status", len(splat) // STRIDE == count)

        st, pjson = _http("GET", f"{base}/jobs/{job_id}/poses")
        poses = json.loads(pjson)
        check("GET /jobs/:id/poses 200 with keyframes", st == 200 and len(poses.get("keyframes", [])) > 0)
        check("keyframe carries center + quat + intrinsics",
              all(key in poses["keyframes"][0] for key in ("center", "quat", "fx", "width")))

        try:
            _http("GET", f"{base}/jobs/does-not-exist")
            check("unknown job -> 404", False)  # unreached; urlopen raises on 4xx
        except urllib.error.HTTPError as e:
            check("unknown job -> 404", e.code == 404)
    finally:
        httpd.shutdown()


def test_auth() -> None:
    print("auth (RECON_TOKEN gate):")
    server.TOKEN = "sekrit"
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    try:
        try:
            _http("GET", f"{base}/health")
            check("no token -> 401", False)  # unreached; urlopen raises on 4xx
        except urllib.error.HTTPError as e:
            check("no token -> 401", e.code == 401)
        try:
            _http("GET", f"{base}/health", headers={"X-Recon-Token": "wrong"})
            check("wrong token -> 401", False)
        except urllib.error.HTTPError as e:
            check("wrong token -> 401", e.code == 401)
        st, body = _http("GET", f"{base}/health", headers={"X-Recon-Token": "sekrit"})
        check("matching token -> 200", st == 200 and json.loads(body).get("ok") is True)
    finally:
        server.TOKEN = ""
        httpd.shutdown()


def test_reaper() -> None:
    print("reaper (_reap_once):")
    old = os.path.join(server.WORK_ROOT, "reap-old")
    fresh = os.path.join(server.WORK_ROOT, "reap-fresh")
    os.makedirs(old, exist_ok=True)
    os.makedirs(fresh, exist_ok=True)
    with server._lock:
        server._jobs["reap-old"] = {"status": "done", "error": None, "gaussianCount": 1,
                                    "splat_path": None, "work_dir": old, "finished_at": time.time() - 999}
        server._jobs["reap-fresh"] = {"status": "done", "error": None, "gaussianCount": 1,
                                      "splat_path": None, "work_dir": fresh, "finished_at": time.time()}
    reaped = server._reap_once(ttl_seconds=500)
    check("expired terminal job reaped", reaped == 1 and "reap-old" not in server._jobs)
    check("expired work dir removed", not os.path.exists(old))
    check("fresh job survives", "reap-fresh" in server._jobs and os.path.exists(fresh))
    with server._lock:
        server._jobs.pop("reap-fresh", None)


if __name__ == "__main__":
    test_converter()
    test_poses()
    test_protocol()
    test_auth()
    test_reaper()
    print(f"\n{'ALL PASS' if not _failures else 'FAILURES: ' + ', '.join(_failures)}")
    sys.exit(1 if _failures else 0)
