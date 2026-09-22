# Box-side PRE-CURATION: the HQ pool grew to ~1200 (matrix repeats); a LoRA wants ~60-100, not 1000.
# Sample an even, diverse subset of the HIGH-QUALITY (h-prefixed) images, JUDGE each sampled pair with
# curation_judge.py, copy only the survivors' png+caption into a curated folder, and build the
# ready-to-train zip plus two review contact-sheets (kept, rejected). Out ~/overnight/curated/,
# curated.zip, curated-sheet.png, rejected-sheet.png, curated/curation.json.
#
# Even sampling is DIVERSITY, not judgement: it happily sampled a two-eyed or melted frame straight
# into curated.zip, which is what train-lora.py consumes. The judge is the rejection half of
# ADR-071 #4 - off-identity/deformed/crowded/mis-captioned candidates never reach the training set -
# and it is fail-closed, so an unmeasured candidate is rejected rather than admitted. The human still
# yanks (or reinstates) anything via --overrides, which always wins over the judge.
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                                    | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Even-sampling pre-curation of the HQ pool into a
#     curated folder, contact sheet and ready-to-train zip.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Route the sampled set through curation_judge before
#     it becomes the training set, take the paths/target/measurements/overrides as arguments instead
#     of hard-coding them, add a rejected-candidate review sheet for the human override, and degrade
#     the sheets (never the zip) when PIL is absent.
# 3 | maintainer@emeraldcoastsystemsgroup.com   | Derive every remaining default from --character
#     instead of the first character this script ever curated: the pool, curated set, zip, sheets,
#     glob patterns, hero and structural judge prompts all come from that character own
#     configuration, and without --character the paths must be given explicitly rather than
#     defaulting to another character dataset.
import argparse
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
from character_config import add_character_arguments, character_config  # noqa: E402
from curation_judge import curate, discover_candidates, load_json, measure_candidates  # noqa: E402

HOME = os.path.expanduser("~")
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output")
INP = os.path.join(COMFY, "input")
TARGET = 90        # aim for ~90 curated images


def sample_even(candidates, target):
    """
    @description Take an even, diverse slice of the pool so the judge scores a spread of the matrix
      rather than a contiguous block of near-duplicates.
    @param candidates - discover_candidates() output, already sorted.
    @param target - How many candidates to sample.
    @returns The sampled subset.
    """
    step = max(1, len(candidates) // max(1, target))
    return candidates[::step][:target]


def contact_sheet(rows, path, thumb=220, cols=9):
    """
    @description Write a review contact sheet. The sheet is a review aid, so a missing PIL degrades
      it with a printed reason; the zip that trains the model is never degraded.
    @param rows - Curation report rows to render.
    @param path - PNG to write.
    @param thumb - Thumbnail edge in pixels.
    @param cols - Thumbnails per row.
    @returns Nothing.
    """
    if not rows:
        return
    try:
        from PIL import Image
    except ImportError as exc:
        print("PIL unavailable (%r) - skipping contact sheet %s" % (exc, path))
        return
    sheet = Image.new("RGB", (cols * thumb, math.ceil(len(rows) / cols) * thumb), (24, 24, 24))
    for i, row in enumerate(rows):
        try:
            im = Image.open(row["image"]).convert("RGB").resize((thumb - 4, thumb - 4))
            sheet.paste(im, ((i % cols) * thumb + 2, (i // cols) * thumb + 2))
        except Exception as exc:
            print("sheet: could not render %s (%r)" % (row["id"], exc))
    sheet.save(path)


def build_parser():
    """
    @description Build the CLI. Paths default from the --character configuration; with no
      --character there are no defaults, because the only defaults this script could offer would
      be another character dataset.
    @returns The argparse parser.
    """
    ap = argparse.ArgumentParser(description="Sample, judge and package a LoRA training set")
    add_character_arguments(ap, required=False)
    ap.add_argument("--source", default="", help="candidate pool directory")
    ap.add_argument("--dest", default="", help="curated output directory")
    ap.add_argument("--zip", dest="zip_path", default="")
    ap.add_argument("--sheet", default="")
    ap.add_argument("--rejected-sheet", default="")
    ap.add_argument("--target", type=int, default=TARGET)
    ap.add_argument("--pattern", default="")
    ap.add_argument("--fallback-pattern", default=None)
    ap.add_argument("--measurements", help="precomputed id -> measurements JSON (skips CLIP)")
    ap.add_argument("--overrides", help="human override JSON: id -> {decision, note}")
    ap.add_argument("--thresholds", help="threshold override JSON")
    return ap


def resolve_paths(args):
    """
    @description Fill the unset paths and patterns from the --character configuration, and refuse
      when neither a character nor an explicit pool was given.
    @param args - Parsed arguments, mutated in place.
    @returns The CharacterConfig when one was given, else None.
    @raises SystemExit - when nothing identifies the pool to curate.
    """
    cfg = character_config(args) if args.character else None
    if cfg:
        args.source = args.source or cfg.pool_dir
        args.dest = args.dest or cfg.curated_dir
        args.zip_path = args.zip_path or cfg.curated_zip
        args.sheet = args.sheet or os.path.join(cfg.root, "curated-sheet.png")
        args.rejected_sheet = args.rejected_sheet or os.path.join(cfg.root, "rejected-sheet.png")
        args.pattern = args.pattern or cfg.pool_glob("h")
        if args.fallback_pattern is None:
            args.fallback_pattern = cfg.pool_glob()
        args.hero = cfg.hero_image_path(INP, OUT) or ""
    if not args.source:
        raise SystemExit("no pool to curate: pass --character, or --source explicitly")
    args.zip_path = args.zip_path or os.path.join(OUT, "curated.zip")
    args.dest = args.dest or os.path.join(OUT, "curated")
    args.fallback_pattern = args.fallback_pattern or ""
    return cfg


def collect(args):
    """Discover the pool with the preferred pattern, falling back when it matches nothing."""
    pool = discover_candidates(args.source, args.pattern)
    if not pool and args.fallback_pattern:
        pool = discover_candidates(args.source, args.fallback_pattern)
    if not pool:
        raise SystemExit("no candidate images in %s (patterns %s, %s)"
                         % (args.source, args.pattern, args.fallback_pattern))
    return pool


def main(argv=None):
    """Sample the pool, judge it, and build the training set from the survivors."""
    args = build_parser().parse_args(argv)
    cfg = resolve_paths(args)
    pool = collect(args)
    sampled = sample_even(pool, args.target)
    thresholds = load_json(args.thresholds) if args.thresholds else {}
    prompts = thresholds.pop("structural_prompts", None) if thresholds else None
    if prompts is None and cfg:
        prompts = cfg.structural_prompts()
    if args.measurements:
        measurements = load_json(args.measurements)
    else:
        if not args.hero or not os.path.exists(args.hero):
            raise SystemExit("hero %s not found - pass --hero or --measurements" % (args.hero or "(unset)"))
        measurements = measure_candidates(sampled, args.hero, prompts)
    overrides = load_json(args.overrides) if args.overrides else {}
    report = curate(sampled, measurements, args.dest, args.zip_path,
                    overrides=overrides, thresholds=thresholds)
    kept = [r for r in report["candidates"] if r["decision"] == "keep"]
    rejected = [r for r in report["candidates"] if r["decision"] != "keep"]
    contact_sheet(kept, args.sheet)
    contact_sheet(rejected, args.rejected_sheet)
    s = report["summary"]
    print("curated %d of %d sampled (pool %d): %d kept, %d rejected, %d overridden; zip=%d bytes"
          % (s["kept"], s["candidates"], len(pool), s["kept"], s["rejected"], s["overridden"],
             os.path.getsize(args.zip_path) if os.path.exists(args.zip_path) else 0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
