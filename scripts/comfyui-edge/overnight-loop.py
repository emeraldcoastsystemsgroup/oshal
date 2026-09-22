# Box-side AUTONOMOUS improve-overnight loop (LoRA Studio P5, opt-in). Runs the full improvement
# cycle unattended until the score plateaus or MAX_HOURS elapses, then parks an approval_required
# "morning review" ticket on the controller (it never silently promotes - the human keeps-best at the
# gate). Each round: targeted-regenerate the weak cells -> train v+1 -> validate v+1 -> compare. If the
# gain over the previous version is below --plateau (or time's up), stop. This reuses train-lora.py,
# validate-lora.py and make-targeted-batch.py (each already POSTs its result to /api/lora/ingest, so
# the controller DB stays current round by round).
#
#   python overnight-loop.py --character <subject> --trigger <word> --hero <hero.png> \
#       --ident "<look sentence>" --start-version 1 --max-hours 9 --plateau 0.005 \
#       --controller http://100.64.0.1:35457 --owner-sub-b64 <subject>
# 2026-08-06 | maintainer@emeraldcoastsystemsgroup.com | Carry the initiating owner through every
# nested train/validate callback and the final review callback using the canonical encoded header.
# 2026-08-06 | maintainer@emeraldcoastsystemsgroup.com | Keep the fleet secret solely in the edge
# process environment; nested scripts inherit it without exposing it in argv or task journals.
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                                    | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Carry the character's whole identity into every
#     nested step instead of only its subject. Passing --character alone let each nested script
#     fall back to its own defaults, so an unattended round regenerated, curated and validated
#     against the first character the studio ever trained. Scorecards and the training set are now
#     read from and written to this character's own box directory.
import argparse, json, os, subprocess, sys, time, glob, urllib.request

HOME = os.path.expanduser("~")
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
from character_config import (add_character_arguments, character_config,  # noqa: E402
                             forwardable_arguments)

PY = sys.executable


def log(m):
    print(time.strftime("[%H:%M:%S] ") + str(m), flush=True)


def sh(script, args):
    """Run a sibling box script to completion, streaming output. Returns the exit code."""
    cmd = [PY, os.path.join(HERE, script)] + args
    log("RUN " + " ".join(cmd))
    return subprocess.call(cmd)


def scorecard(cfg, version):
    """Read one version's scorecard out of THIS character's own validate directory."""
    p = os.path.join(cfg.validate_dir, "scorecard_v%d.json" % version)
    if os.path.exists(p):
        try:
            return json.load(open(p))
        except Exception:
            return None
    return None


def weak_values(sc):
    return [w.get("value", "") for w in (sc or {}).get("weak_cells", []) if w.get("value")]


def post(controller, secret, owner_sub_b64, payload):
    try:
        req = urllib.request.Request(
            controller.rstrip("/") + "/api/lora/ingest",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "x-service-secret": secret,
                     "x-oshal-user-sub-b64": owner_sub_b64})
        urllib.request.urlopen(req, timeout=30).read()
    except Exception as e:
        log("post failed: %r" % e)


def build_parser():
    """
    @description The CLI. The character's identity comes from its `oshal_lora_characters` row and
      is forwarded verbatim to every nested step.
    @returns The argparse parser.
    """
    ap = argparse.ArgumentParser(description="Improve one character unattended until it plateaus")
    add_character_arguments(ap)
    ap.add_argument("--start-version", type=int, required=True)
    ap.add_argument("--max-hours", type=float, default=9.0)
    ap.add_argument("--plateau", type=float, default=0.005)
    ap.add_argument("--dataset", default="", help="training set (default: this character's curated set)")
    ap.add_argument("--controller", default=os.environ.get("OSHAL_CONTROLLER", ""))
    ap.add_argument("--owner-sub-b64", default=os.environ.get("OSHAL_USER_SUB_B64", ""))
    return ap


def improve_round(cfg, ident, a, tail, cur, nxt, weak):
    """
    @description Run one improve round for this character: targeted batch, train, validate. Every
      nested step receives this character's full identity, never just its subject.
    @param cfg - The resolved CharacterConfig.
    @param ident - forwardable_arguments(cfg), the identity argv.
    @param a - Parsed arguments.
    @param tail - Controller/owner callback argv (empty when unbound).
    @param cur - The version being improved from.
    @param nxt - The version being produced.
    @param weak - Weak axis-values from cur's scorecard.
    @returns True when the round completed.
    """
    if sh("make-targeted-batch.py", ident + ["--weak", "||".join(weak), "--count", "60"]) != 0:
        log("targeted batch failed; stopping"); return False
    dataset = a.dataset or cfg.curated_dir
    if sh("train-lora.py", ["--character", cfg.subject, "--version", str(nxt), "--base", cfg.base_model,
                            "--dataset", dataset, "--parent-version", str(cur)] + tail) != 0:
        log("train failed; stopping"); return False
    if sh("validate-lora.py", ident + ["--version", str(nxt),
                                       "--lora-name", "%s_v%d.safetensors" % (cfg.subject, nxt)] + tail) != 0:
        log("validate failed; stopping"); return False
    return True


def main():
    """Improve one character unattended, then park a morning-review callback."""
    a = build_parser().parse_args()
    cfg = character_config(a)
    ident = forwardable_arguments(cfg)
    secret = os.environ.get("SWARM_SERVICE_SECRET", "")
    tail = (["--controller", a.controller, "--owner-sub-b64", a.owner_sub_b64]
            if a.controller and secret and a.owner_sub_b64 else [])
    t0 = time.time()

    cur = a.start_version
    # Make sure the starting version has a score to compare against.
    if scorecard(cfg, cur) is None:
        sh("validate-lora.py", ident + ["--version", str(cur),
                                        "--lora-name", "%s_v%d.safetensors" % (cfg.subject, cur)] + tail)
    best = cur
    best_score = (scorecard(cfg, cur) or {}).get("overall", 0.0)
    log("==== OVERNIGHT START: %s from v%d (score %.3f), max %.1fh, plateau %.4f ===="
        % (cfg.subject, cur, best_score, a.max_hours, a.plateau))

    while (time.time() - t0) < a.max_hours * 3600:
        weak = weak_values(scorecard(cfg, cur))
        nxt = cur + 1
        log("round -> v%d (improving v%d; weak=%s)" % (nxt, cur, weak or "(none)"))
        if not improve_round(cfg, ident, a, tail, cur, nxt, weak):
            break
        score = (scorecard(cfg, nxt) or {}).get("overall", 0.0)
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
    if a.controller and secret and a.owner_sub_b64:
        post(a.controller, secret, a.owner_sub_b64,
             {"kind": "review", "character": cfg.subject,
              "best_version": best, "overall": best_score, "summary": summary})


if __name__ == "__main__":
    main()
