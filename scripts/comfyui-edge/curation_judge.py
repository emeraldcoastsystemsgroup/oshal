# Box-side AUTOMATED CURATION JUDGE for a character LoRA training set (LoRA Studio, ADR-071 #4).
#
# The dataset builders (make-overnight-hq.py / make-targeted-batch.py) emit a POOL of candidate
# image+caption pairs. Training on an off-identity or deformed candidate teaches the LoRA the wrong
# thing, which is why ADR-071 makes REJECTION the first of the three improvement mechanisms. Until
# now the only pre-training filter was make-curate.py's even sampling - that is diversity, not
# judgement, and a two-eyed frame sampled evenly still reached curated.zip.
#
# This module reuses the SAME measurements validate-lora.py scores a TRAINED model with - CLIP-image
# cosine to the locked hero (identity), the CLIP good-vs-bad quality proxy, and the single-eye
# structural guard - and applies them BEFORE training, per candidate, to propose keep/reject. Two
# further structural checks come along for free from the same embedding: a multiple-characters
# margin and the pair's own caption agreement (a caption that does not describe its image teaches a
# wrong association).
#
# It is FAIL-CLOSED. A candidate with a missing or non-numeric measurement is rejected as
# `unmeasured` rather than admitted: validate-lora.py degrades identity to 0.5 when CLIP is absent,
# and a curation judge that degraded the same way would quietly pass the whole pool through.
#
# The human keeps the last word: --overrides takes a per-candidate {"decision": "keep"|"reject"}
# map that always wins, and the report records both the override and the verdict it replaced.
#
# Two entry points:
#   python curation_judge.py --source POOL --dest CURATED --zip curated.zip --hero HERO.png
#   python curation_judge.py --evaluate-fixture fixtures/curation-labels.json
# The second scores the decision core against a LABELLED fixture and reports the false-accept and
# false-reject rates, exiting non-zero when either exceeds the cap the fixture declares.
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                                    | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial automated curation judge: identity,
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Refuse a --dest that contains a candidate. curate() empties dest_dir first, and dest became operator-supplied alongside an independent --source, so --source X --dest X deleted the overnight pool and still reported success because the pool had already been read. Resolved-path comparison, so a different spelling of the same directory cannot slip past.
#     quality, single-eye, multiple-character and caption-agreement checks decide keep/reject before
#     training; rejected pairs never reach the curated folder or curated.zip; per-candidate human
#     override always wins; a labelled fixture measures false accept/reject rates.
# 3 | maintainer@emeraldcoastsystemsgroup.com   | Drop the structural probe pair from the neutral
#     defaults. It describes one character anatomy, so defaulting it meant every OTHER character
#     was measured against that anatomy and lost the margin on every candidate. A character that
#     declares no pair now reports a 0.0 margin (no violation) instead.
import argparse
import glob
import json
import os
import shutil
import sys
import zipfile

IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp")

# Decision boundary. Identity/quality/caption are 0..1 (a CLIP cosine mapped through (cos+1)/2 or
# the good-vs-bad proxy); the two margins are raw cosine differences where ANY positive value means
# the contrastive prompt won, i.e. the frame reads as two-eyed / as a crowd.
DEFAULT_THRESHOLDS = {
    "min_identity": 0.78,
    "min_quality": 0.45,
    "min_caption_agreement": 0.60,
    "max_two_eye_margin": 0.0,
    "max_multi_character_margin": 0.0,
}

# Contrastive probes. These are CHARACTER-NEUTRAL: quality and crowding mean the same thing for
# every character. The structural pair does not - it describes one character's anatomy - so it has
# no default here. A character declares its own pair (identity_structure / identity_violation) and
# a character that declares none is simply not structurally probed; scoring one character against
# another's anatomy is a defect, not a safety net.
DEFAULT_STRUCTURAL_PROMPTS = {
    "good": "a sharp, clean, highly detailed 3d render of a single character",
    "bad": "a blurry, deformed, low quality, messy image",
    "single_character": "a single character alone in the frame",
    "multiple_characters": "several different characters in the frame",
}

REQUIRED_MEASUREMENTS = ("identity", "quality", "caption_agreement",
                         "two_eye_margin", "multi_character_margin")


def _is_number(value):
    """True for a real numeric measurement; booleans are not measurements."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _clamp01(x):
    """Clamp to the 0..1 band the scores are declared in."""
    return max(0.0, min(1.0, x))


def _unit(cosine):
    """Map a -1..1 cosine onto 0..1, the same way validate-lora.py maps identity."""
    return _clamp01((cosine + 1.0) / 2.0)


def resolve_thresholds(*layers):
    """
    @description Merge threshold layers over the defaults, last layer winning. Unknown keys are
      rejected loudly so a typo cannot silently leave a check at its default.
    @param layers - Zero or more dicts (fixture-declared, file, CLI) applied in order.
    @returns The effective threshold dict.
    """
    out = dict(DEFAULT_THRESHOLDS)
    for layer in layers:
        if not layer:
            continue
        unknown = sorted(k for k in layer if k not in DEFAULT_THRESHOLDS)
        if unknown:
            raise ValueError("unknown threshold key(s): %s" % ", ".join(unknown))
        out.update({k: float(v) for k, v in layer.items()})
    return out


def judge_candidate(measurements, thresholds=None):
    """
    @description Decide keep/reject for ONE candidate from its measurements. Fail-closed: a missing
      or non-numeric measurement is a rejection, never an admission.
    @param measurements - Dict carrying the five REQUIRED_MEASUREMENTS.
    @param thresholds - Optional threshold overrides; defaults are used for the rest.
    @returns {"decision": "keep"|"reject", "reasons": [...]}.
    """
    t = resolve_thresholds(thresholds)
    m = measurements or {}
    missing = [k for k in REQUIRED_MEASUREMENTS if not _is_number(m.get(k))]
    if missing:
        return {"decision": "reject", "reasons": ["unmeasured:" + ",".join(sorted(missing))]}
    reasons = []
    if m["identity"] < t["min_identity"]:
        reasons.append("off-identity")
    if m["two_eye_margin"] > t["max_two_eye_margin"]:
        reasons.append("structural-identity-violation")
    if m["quality"] < t["min_quality"]:
        reasons.append("deformed-or-low-quality")
    if m["multi_character_margin"] > t["max_multi_character_margin"]:
        reasons.append("multiple-characters")
    if m["caption_agreement"] < t["min_caption_agreement"]:
        reasons.append("caption-mismatch")
    return {"decision": "reject" if reasons else "keep", "reasons": reasons}


def evaluate_fixture(fixture, thresholds=None):
    """
    @description Score the decision core against a LABELLED fixture and measure how often it is
      wrong in each direction. A fixture with no rejects (or no keeps) cannot measure the rate it
      claims to, so it is refused rather than reported as a perfect 0.
    @param fixture - Parsed fixture: {"thresholds": {...}, "candidates": [{"id","label","measurements"}]}.
    @param thresholds - Optional overrides applied after the fixture's own.
    @returns Rates, counts and the per-candidate disagreements.
    """
    rows = fixture.get("candidates") or []
    if not rows:
        raise ValueError("fixture declares no candidates")
    t = resolve_thresholds(fixture.get("thresholds"), thresholds)
    keeps = [r for r in rows if r.get("label") == "keep"]
    rejects = [r for r in rows if r.get("label") == "reject"]
    unlabelled = [r.get("id") for r in rows if r.get("label") not in ("keep", "reject")]
    if unlabelled:
        raise ValueError("fixture rows without a keep/reject label: %s" % ", ".join(map(str, unlabelled)))
    if not keeps or not rejects:
        raise ValueError("fixture needs both labels to measure a rate (keeps=%d rejects=%d)"
                         % (len(keeps), len(rejects)))
    false_accepts, false_rejects = [], []
    for row in rows:
        verdict = judge_candidate(row.get("measurements") or {}, t)
        if row["label"] == "reject" and verdict["decision"] == "keep":
            false_accepts.append({"id": row.get("id"), "failure": row.get("failure")})
        if row["label"] == "keep" and verdict["decision"] == "reject":
            false_rejects.append({"id": row.get("id"), "reasons": verdict["reasons"]})
    return {
        "thresholds": t,
        "labelled_keeps": len(keeps),
        "labelled_rejects": len(rejects),
        "false_accepts": false_accepts,
        "false_rejects": false_rejects,
        "false_accept_rate": round(len(false_accepts) / float(len(rejects)), 6),
        "false_reject_rate": round(len(false_rejects) / float(len(keeps)), 6),
    }


def discover_candidates(source_dir, pattern="*"):
    """
    @description Find candidate image/caption pairs in a pool directory.
    @param source_dir - Directory holding <name>.png and the matching <name>.txt caption.
    @param pattern - Optional glob restricting which images are candidates.
    @returns Sorted list of {"id", "image", "caption"} (caption None when the sidecar is absent).
    """
    found = []
    for path in sorted(glob.glob(os.path.join(source_dir, pattern))):
        if not path.lower().endswith(IMAGE_EXTENSIONS):
            continue
        name = os.path.splitext(os.path.basename(path))[0]
        caption = os.path.join(source_dir, name + ".txt")
        found.append({"id": name, "image": path,
                      "caption": caption if os.path.exists(caption) else None})
    return found


def _read_caption(path):
    """Read a caption sidecar, or None when there is not one."""
    if not path or not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        text = fh.read().strip()
    return text or None


def _refuse_destructive_dest(dest_dir, rows):
    """Refuse a destination that would delete the candidates being curated.

    @param dest_dir - The directory curate() is about to empty.
    @param rows - The judged candidates, whose source paths locate the pool.
    @returns None. Raises SystemExit when the destination contains a candidate.
    """
    dest = os.path.realpath(dest_dir)
    for row in rows:
        source = os.path.realpath(row["image"])
        if os.path.commonpath([dest, source]) == dest:
            raise SystemExit(
                "REFUSING: --dest %s contains the candidate %s, and curating empties --dest first. "
                "Point --dest at a directory outside the candidate pool." % (dest_dir, row["image"])
            )


def curate(candidates, measurements, dest_dir, zip_path, overrides=None,
           thresholds=None, report_path=None):
    """
    @description Apply the judge to every candidate and build the TRAINING SET from the survivors:
      the destination folder is rebuilt from scratch (a reject left over from a previous run must not
      survive into this one) and the zip is written fresh, so a rejected pair reaches neither.
    @param candidates - discover_candidates() output.
    @param measurements - id -> measurement dict.
    @param dest_dir - Curated folder to (re)build; anything already there is discarded.
    @param zip_path - curated.zip that train-lora.py consumes; None to skip zipping.
    @param overrides - id -> {"decision": "keep"|"reject", "note": str}; the human always wins.
    @param thresholds - Optional threshold overrides.
    @param report_path - Where to write curation.json; defaults to dest_dir/curation.json.
    @returns The report dict that was written.
    """
    t = resolve_thresholds(thresholds)
    rows = _verdicts(candidates, measurements or {}, overrides or {}, t)
    # The next line EMPTIES dest_dir. If dest is the candidate pool - the same directory by another
    # spelling, or a directory containing it - that deletes overnight render output which costs
    # another GPU night to replace, and the run still reports success because the pool was already
    # read. Compare resolved paths, and refuse rather than delete.
    _refuse_destructive_dest(dest_dir, rows)
    shutil.rmtree(dest_dir, ignore_errors=True)
    os.makedirs(dest_dir, exist_ok=True)
    for row in rows:
        if row["decision"] != "keep":
            continue
        shutil.copy(row["image"], os.path.join(dest_dir, os.path.basename(row["image"])))
        if row["caption"]:
            shutil.copy(row["caption"], os.path.join(dest_dir, os.path.basename(row["caption"])))
    report = {"kind": "curation", "thresholds": t, "summary": _summarize(rows), "candidates": rows}
    written = report_path or os.path.join(dest_dir, "curation.json")
    with open(written, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    if zip_path:
        _write_zip(dest_dir, zip_path, written)
    return report


def _verdicts(candidates, measurements, overrides, thresholds):
    """Judge every candidate, then let a per-candidate human override replace the verdict."""
    rows = []
    for c in candidates:
        verdict = judge_candidate(measurements.get(c["id"]), thresholds)
        row = {"id": c["id"], "image": c["image"], "caption": c.get("caption"),
               "measurements": measurements.get(c["id"]),
               "judge_decision": verdict["decision"], "reasons": verdict["reasons"],
               "decision": verdict["decision"], "override": False, "override_note": None}
        ov = overrides.get(c["id"])
        if isinstance(ov, dict) and ov.get("decision") in ("keep", "reject"):
            row["decision"] = ov["decision"]
            row["override"] = ov["decision"] != verdict["decision"]
            row["override_note"] = ov.get("note")
        rows.append(row)
    return rows


def _summarize(rows):
    """Roll the per-candidate verdicts into the counts the operator reads first."""
    reasons = {}
    for row in rows:
        if row["decision"] == "keep":
            continue
        for reason in (row["reasons"] or ["(overridden to reject)"]):
            key = reason.split(":")[0]
            reasons[key] = reasons.get(key, 0) + 1
    return {"candidates": len(rows),
            "kept": sum(1 for r in rows if r["decision"] == "keep"),
            "rejected": sum(1 for r in rows if r["decision"] != "keep"),
            "overridden": sum(1 for r in rows if r["override"]),
            "reject_reasons": reasons}


def _write_zip(dest_dir, zip_path, report_path):
    """Write curated.zip from the surviving pairs only; the report never enters the training set."""
    parent = os.path.dirname(os.path.abspath(zip_path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    skip = os.path.basename(report_path) if os.path.dirname(os.path.abspath(report_path)) == \
        os.path.abspath(dest_dir) else None
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(glob.glob(os.path.join(dest_dir, "*"))):
            if skip and os.path.basename(f) == skip:
                continue
            z.write(f, os.path.basename(f))


class ClipScorer:
    """
    @description Local CLIP encoder (free, $0) used to measure candidates on the box. Construction
      RAISES when neither backend is importable - the judge must never degrade to a neutral score,
      because a neutral score admits everything.
    """

    def __init__(self):
        import torch
        self.torch = torch
        self.dev = "cuda" if torch.cuda.is_available() else "cpu"
        try:
            import open_clip
            self.model, _, self.pp = open_clip.create_model_and_transforms(
                "ViT-B-32", pretrained="openai")
            self.tok = open_clip.get_tokenizer("ViT-B-32")
            self.model = self.model.to(self.dev).eval()
            self.kind = "open_clip"
        except ImportError:
            from transformers import CLIPModel, CLIPProcessor
            self.model = CLIPModel.from_pretrained("openai/clip-vit-base-patch32").to(self.dev).eval()
            self.proc = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
            self.kind = "transformers"

    def image(self, path):
        """Unit-normalised image embedding."""
        from PIL import Image
        im = Image.open(path).convert("RGB")
        with self.torch.no_grad():
            if self.kind == "open_clip":
                v = self.model.encode_image(self.pp(im).unsqueeze(0).to(self.dev))
            else:
                v = self.model.get_image_features(
                    **self.proc(images=im, return_tensors="pt").to(self.dev))
        return (v / v.norm(dim=-1, keepdim=True))[0]

    def text(self, value):
        """Unit-normalised text embedding."""
        with self.torch.no_grad():
            if self.kind == "open_clip":
                v = self.model.encode_text(self.tok([value]).to(self.dev))
            else:
                v = self.model.get_text_features(
                    **self.proc(text=[value], return_tensors="pt", padding=True).to(self.dev))
        return (v / v.norm(dim=-1, keepdim=True))[0]

    def cos(self, a, b):
        """Cosine similarity between two unit vectors."""
        return float((a * b).sum().item())


def measure_candidates(candidates, hero_path, prompts=None):
    """
    @description Measure every candidate against the locked hero and the contrastive probes, using
      the same CLIP scoring validate-lora.py applies to a trained model.
    @param candidates - discover_candidates() output.
    @param hero_path - The locked hero image the character's identity is defined by.
    @param prompts - This character's structural pair (identity_structure / identity_violation),
      plus any override of the neutral quality/crowding probes. Without the pair the structural
      margin is reported as 0.0 - no violation - rather than measured against another character.
    @returns id -> measurement dict (caption_agreement is None when the pair has no caption).
    """
    p = dict(DEFAULT_STRUCTURAL_PROMPTS)
    p.update(prompts or {})
    clip = ClipScorer()
    hero = clip.image(hero_path)
    good, bad = clip.text(p["good"]), clip.text(p["bad"])
    structural = None
    if p.get("identity_structure") and p.get("identity_violation"):
        structural = (clip.text(p["identity_structure"]), clip.text(p["identity_violation"]))
    single, many = clip.text(p["single_character"]), clip.text(p["multiple_characters"])
    out = {}
    for c in candidates:
        v = clip.image(c["image"])
        caption = _read_caption(c.get("caption"))
        out[c["id"]] = {
            "identity": round(_unit(clip.cos(v, hero)), 6),
            "quality": round(_clamp01(0.5 + 6.0 * (clip.cos(v, good) - clip.cos(v, bad))), 6),
            "caption_agreement": round(_unit(clip.cos(v, clip.text(caption))), 6) if caption else None,
            "two_eye_margin": round(clip.cos(v, structural[1]) - clip.cos(v, structural[0]), 6) if structural else 0.0,
            "multi_character_margin": round(clip.cos(v, many) - clip.cos(v, single), 6),
            "scorer": "clip-" + clip.kind,
        }
    return out


def load_json(path):
    """Read a JSON side input, naming the file when it cannot be parsed."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as exc:
        raise SystemExit("could not read %s: %r" % (path, exc))


def build_parser():
    """Build the CLI both entry points share."""
    ap = argparse.ArgumentParser(description="Automated curation judge for a character LoRA dataset")
    ap.add_argument("--evaluate-fixture", help="score the decision core against a labelled fixture")
    ap.add_argument("--source", help="candidate pool directory")
    ap.add_argument("--dest", help="curated output directory (rebuilt from scratch)")
    ap.add_argument("--zip", dest="zip_path", help="curated.zip the trainer consumes")
    ap.add_argument("--pattern", default="*", help="glob restricting which images are candidates")
    ap.add_argument("--hero", help="locked hero image; required when measuring with CLIP")
    ap.add_argument("--measurements", help="precomputed id -> measurements JSON (skips CLIP)")
    ap.add_argument("--overrides", help="human override JSON: id -> {decision, note}")
    ap.add_argument("--thresholds", help="threshold override JSON")
    ap.add_argument("--report", help="where to write curation.json")
    return ap


def run_fixture(args):
    """Fixture mode: measure the false accept/reject rates and enforce the declared caps."""
    fixture = load_json(args.evaluate_fixture)
    thresholds = load_json(args.thresholds) if args.thresholds else None
    try:
        result = evaluate_fixture(fixture, thresholds)
    except ValueError as exc:
        raise SystemExit("fixture cannot measure a rate: %s" % exc)
    caps = {"false_accept_rate": float(fixture.get("max_false_accept_rate", 0.0)),
            "false_reject_rate": float(fixture.get("max_false_reject_rate", 0.0))}
    breached = [k for k, cap in caps.items() if result[k] > cap]
    result["caps"] = caps
    result["breached"] = breached
    print(json.dumps(result, indent=2))
    return 1 if breached else 0


def run_curate(args):
    """Curation mode: judge the pool and build the training set from the survivors."""
    if not (args.source and args.dest):
        raise SystemExit("--source and --dest are required (or use --evaluate-fixture)")
    candidates = discover_candidates(args.source, args.pattern)
    if not candidates:
        raise SystemExit("no candidate images matched %s in %s" % (args.pattern, args.source))
    thresholds_file = load_json(args.thresholds) if args.thresholds else {}
    prompts = (thresholds_file or {}).pop("structural_prompts", None)
    if args.measurements:
        measurements = load_json(args.measurements)
    else:
        if not args.hero:
            raise SystemExit("--hero is required when measurements are not supplied")
        measurements = measure_candidates(candidates, args.hero, prompts)
    overrides = load_json(args.overrides) if args.overrides else {}
    report = curate(candidates, measurements, args.dest, args.zip_path,
                    overrides=overrides, thresholds=thresholds_file, report_path=args.report)
    s = report["summary"]
    print("curation: %d candidates -> %d kept, %d rejected (%d overridden); reasons %s"
          % (s["candidates"], s["kept"], s["rejected"], s["overridden"], json.dumps(s["reject_reasons"])))
    return 0


def main(argv=None):
    """Route to fixture evaluation or curation."""
    args = build_parser().parse_args(argv)
    return run_fixture(args) if args.evaluate_fixture else run_curate(args)


if __name__ == "__main__":
    sys.exit(main())
