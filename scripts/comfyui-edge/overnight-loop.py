# Box-side AUTONOMOUS improve-overnight loop (LoRA Studio P5, opt-in). Runs the full improvement
# cycle unattended until the score plateaus or MAX_HOURS elapses, then parks an approval_required
# "morning review" ticket on the controller (it never silently promotes - the human keeps-best at the
# gate). Each round: targeted-regenerate the weak cells -> train v+1 -> validate v+1 -> compare. If the
# gain over the previous version is below --plateau (or time's up), stop. This reuses train-lora.py,
# validate-lora.py and make-targeted-batch.py (each already POSTs its result to /api/lora/ingest, so
# the controller DB stays current round by round).
#
#   python overnight-loop.py --character oshbrainrot --start-version 1 --max-hours 9 --plateau 0.005 \
#       --controller http://100.64.0.1:35457 --secret $SWARM_SERVICE_SECRET
import argparse, json, os, subprocess, sys, time, glob, urllib.request

HOME = os.path.expanduser("~")
HERE = os.path.dirname(os.path.abspath(__file__))
VAL_DIR = os.path.join(HOME, "lora-validate")
PY = sys.executable


def log(m):
    print(time.strftime("[%H:%M:%S] ") + str(m), flush=True)


def sh(script, args):
    """Run a sibling box script to completion, streaming output. Returns the exit code."""
    cmd = [PY, os.path.join(HERE, script)] + args
    log("RUN " + " ".join(cmd))
    return subprocess.call(cmd)


def scorecard(character, version):
    p = os.path.join(VAL_DIR, "scorecard_v%d.json" % version)
    if os.path.exists(p):
        try:
            return json.load(open(p))
        except Exception:
            return None
    return None


def weak_values(sc):
    return [w.get("value", "") for w in (sc or {}).get("weak_cells", []) if w.get("value")]


def post(controller, secret, payload):
    try:
        req = urllib.request.Request(controller.rstrip("/") + "/api/lora/ingest",
                                     data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json", "x-service-secret": secret})
        urllib.request.urlopen(req, timeout=30).read()
    except Exception as e:
        log("post failed: %r" % e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--character", required=True)
    ap.add_argument("--start-version", type=int, required=True)
    ap.add_argument("--max-hours", type=float, default=9.0)
    ap.add_argument("--plateau", type=float, default=0.005)
    ap.add_argument("--dataset", default=os.path.join(HOME, "overnight", "curated.zip"))
    ap.add_argument("--controller", default=os.environ.get("OSHAL_CONTROLLER", ""))
    ap.add_argument("--secret", default=os.environ.get("SWARM_SERVICE_SECRET", ""))
    a = ap.parse_args()
    tail = ["--controller", a.controller, "--secret", a.secret] if a.controller and a.secret else []
    t0 = time.time()

    cur = a.start_version
    # Make sure the starting version has a score to compare against.
    if scorecard(a.character, cur) is None:
        sh("validate-lora.py", ["--character", a.character, "--version", str(cur),
                                "--lora-name", "%s_v%d.safetensors" % (a.character, cur)] + tail)
    best = cur
    best_score = (scorecard(a.character, cur) or {}).get("overall", 0.0)
    log("==== OVERNIGHT START: %s from v%d (score %.3f), max %.1fh, plateau %.4f ===="
        % (a.character, cur, best_score, a.max_hours, a.plateau))

    while (time.time() - t0) < a.max_hours * 3600:
        weak = weak_values(scorecard(a.character, cur))
        nxt = cur + 1
        log("round -> v%d (improving v%d; weak=%s)" % (nxt, cur, weak or "(none)"))
        if sh("make-targeted-batch.py", ["--character", a.character, "--weak", "||".join(weak), "--count", "60"]) != 0:
            log("targeted batch failed; stopping"); break
        if sh("train-lora.py", ["--character", a.character, "--version", str(nxt),
                                "--dataset", a.dataset, "--parent-version", str(cur)] + tail) != 0:
            log("train failed; stopping"); break
        if sh("validate-lora.py", ["--character", a.character, "--version", str(nxt),
                                   "--lora-name", "%s_v%d.safetensors" % (a.character, nxt)] + tail) != 0:
            log("validate failed; stopping"); break

        sc = scorecard(a.character, nxt)
        score = (sc or {}).get("overall", 0.0)
        gain = score - best_score
        log("v%d scored %.3f (best %.3f, gain %+.4f)" % (nxt, score, best_score, gain))
        if score > best_score:
            best, best_score = nxt, score
        cur = nxt
        if gain < a.plateau:
            log("plateau reached (gain %.4f < %.4f); stopping" % (gain, a.plateau)); break

    summary = ("Overnight improve finished: best v%d at score %.3f after %d versions (%.1fh)."
               % (best, best_score, cur - a.start_version + 1, (time.time() - t0) / 3600))
    log("==== " + summary + " ====")
    if a.controller and a.secret:
        post(a.controller, a.secret, {"kind": "review", "character": a.character,
                                      "best_version": best, "overall": best_score, "summary": summary})


if __name__ == "__main__":
    main()
