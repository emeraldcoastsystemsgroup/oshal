"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                        | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 box-side recon service — the HTTP surface the OSHAL EdgeReconstructionProvider drives over Tailscale. Stdlib only (no FastAPI/uvicorn) so it runs on the GPU box with zero Python deps beyond the CV toolchain and is smoke-testable anywhere. Speaks the EXACT provider protocol: GET /health; POST /reconstruct (octet-stream body + X-Scan-Id/X-Source-Name/X-Source-Kind headers) -> {jobId}; GET /jobs/:id -> {status,error?,gaussianCount?}; GET /jobs/:id/splat -> bytes. Each job runs pipeline.run on a worker thread; the provider polls us exactly as we would poll a job. Job ids are server-minted UUIDs and every read is pinned to the in-memory job table, so a path can never traverse outside a known job dir.
2 | maintainer@emeraldcoastsystemsgroup.com   | Audit fixes: (1) optional shared-secret auth — set RECON_TOKEN and every request must carry a matching X-Recon-Token (constant-time compare) or gets 401; without it anyone on the LAN could burn the GPU and fetch private home scans (Tailscale placement is a convention, not enforcement). (2) Terminal job dirs are now REAPED: a background thread deletes done/error jobs (work dir + table entry) after RECON_JOB_TTL_SECONDS (default 24h) — previously nothing ever cleaned up, so a few dozen scans filled the disk and every later job died mid-train.
"""

import hmac
import json
import os
import shutil
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

import pipeline

HOST = os.environ.get("RECON_HOST", "0.0.0.0")
PORT = int(os.environ.get("RECON_PORT", "8008"))
WORK_ROOT = os.environ.get("RECON_WORK_DIR", os.path.join(tempfile.gettempdir(), "oshal-recon"))
STUB = os.environ.get("RECON_STUB", "").lower() in ("1", "true", "yes")
TOKEN = os.environ.get("RECON_TOKEN", "")  # empty -> open (rely on network isolation); set -> enforced
MAX_UPLOAD = 400 * 1024 * 1024  # a room walkthrough clip, not a movie
JOB_TTL_SECONDS = int(os.environ.get("RECON_JOB_TTL_SECONDS", str(24 * 3600)))
REAP_INTERVAL_SECONDS = 600

_jobs = {}          # jobId -> dict(status, error, gaussianCount, splat_path, work_dir, finished_at)
_lock = threading.Lock()


def _ext(name: str) -> str:
    e = os.path.splitext(name)[1].lower()
    return e if e and len(e) <= 12 else ".mp4"


def _worker(job_id: str, source_path: str, source_kind: str) -> None:
    """Run the pipeline for one job, moving it running -> done|error."""
    with _lock:
        _jobs[job_id]["status"] = "running"
    try:
        splat_path, count = pipeline.run(_jobs[job_id]["work_dir"], source_path, source_kind, STUB)
        with _lock:
            _jobs[job_id].update(status="done", splat_path=splat_path, gaussianCount=count,
                                 finished_at=time.time())
    except Exception as err:  # noqa: BLE001 — report every failure to the client, never swallow
        with _lock:
            _jobs[job_id].update(status="error", error=str(err)[:500], finished_at=time.time())


def _reap_once(ttl_seconds: int) -> int:
    """Delete terminal jobs older than the TTL (work dir + table entry); returns the
    count reaped. A real job leaves multiple GB of COLMAP/train/export intermediates —
    unbounded accumulation fills the disk and kills every later train mid-run."""
    cutoff = time.time() - ttl_seconds
    with _lock:
        expired = [(jid, j["work_dir"]) for jid, j in _jobs.items()
                   if j["status"] in ("done", "error") and j.get("finished_at", 0) < cutoff]
        for jid, _ in expired:
            del _jobs[jid]
    for jid, work_dir in expired:  # rmtree OUTSIDE the lock — it can take a while
        shutil.rmtree(work_dir, ignore_errors=True)
        print(f"[reaper] removed expired job {jid}", flush=True)
    return len(expired)


def _reaper() -> None:
    while True:
        time.sleep(REAP_INTERVAL_SECONDS)
        _reap_once(JOB_TTL_SECONDS)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, obj) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self) -> bool:
        """Enforce the shared secret when RECON_TOKEN is configured (constant-time)."""
        if not TOKEN:
            return True
        if hmac.compare_digest(self.headers.get("X-Recon-Token", ""), TOKEN):
            return True
        self._send(401, {"error": "bad_token"})
        return False

    def do_GET(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler API
        if not self._authed():
            return
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if parts == ["health"]:
            self._send(200, {"ok": True, "stub": STUB})
        elif len(parts) == 2 and parts[0] == "jobs":
            self._job_status(parts[1])
        elif len(parts) == 3 and parts[0] == "jobs" and parts[2] == "splat":
            self._job_splat(parts[1])
        elif len(parts) == 3 and parts[0] == "jobs" and parts[2] == "poses":
            self._job_poses(parts[1])
        else:
            self._send(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler API
        if not self._authed():
            return
        if urlparse(self.path).path.rstrip("/") != "/reconstruct":
            self._send(404, {"error": "not_found"})
            return
        self._reconstruct()

    def _reconstruct(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_UPLOAD:
            self._send(400, {"error": "bad_or_oversize_body", "maxBytes": MAX_UPLOAD})
            return
        source_kind = self.headers.get("X-Source-Kind", "video")
        source_name = unquote(self.headers.get("X-Source-Name", "source"))
        job_id = uuid.uuid4().hex
        work_dir = os.path.join(WORK_ROOT, job_id)
        os.makedirs(work_dir, exist_ok=True)
        source_path = os.path.join(work_dir, f"source{_ext(source_name)}")
        with open(source_path, "wb") as f:
            self._stream_body(f, length)
        with _lock:
            _jobs[job_id] = {"status": "queued", "error": None, "gaussianCount": None,
                             "splat_path": None, "work_dir": work_dir}
        threading.Thread(target=_worker, args=(job_id, source_path, source_kind), daemon=True).start()
        self._send(200, {"jobId": job_id})

    def _stream_body(self, dest, length: int) -> None:
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            dest.write(chunk)
            remaining -= len(chunk)

    def _job_status(self, job_id: str) -> None:
        with _lock:
            job = _jobs.get(job_id)
        if not job:
            self._send(404, {"error": "unknown_job"})
            return
        out = {"status": job["status"]}
        if job["error"]:
            out["error"] = job["error"]
        if job["gaussianCount"] is not None:
            out["gaussianCount"] = job["gaussianCount"]
        self._send(200, out)

    def _job_splat(self, job_id: str) -> None:
        with _lock:
            job = _jobs.get(job_id)
        if not job or job["status"] != "done" or not job.get("splat_path"):
            self._send(404, {"error": "not_ready"})
            return
        with open(job["splat_path"], "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _job_poses(self, job_id: str) -> None:
        with _lock:
            job = _jobs.get(job_id)
        poses_path = os.path.join(job["work_dir"], "poses.json") if job else None
        if not poses_path or not os.path.exists(poses_path):
            self._send(404, {"error": "no_poses"})
            return
        with open(poses_path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args) -> None:  # noqa: N802 — quiet the default stderr spam
        return


def main() -> None:
    os.makedirs(WORK_ROOT, exist_ok=True)
    threading.Thread(target=_reaper, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    auth = "token-gated" if TOKEN else "OPEN (set RECON_TOKEN to require a shared secret)"
    print(f"spatial-recon-edge listening on {HOST}:{PORT} (stub={STUB}, work={WORK_ROOT}, auth={auth})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
