# Box-side TARGETED batch generator (LoRA Studio P4 - the "gets better" engine). Given the weak
# axis-values from a version's validation scorecard, it regenerates training images BIASED toward
# those weak cells (e.g. if "side profile view" + "screaming" scored low, it makes more of those),
# appends them to the dataset, and refreshes curated.zip. The next training version then learns the
# spots the previous one was weak at - directed active learning, not just "more random data".
#
# Reuses make-overnight-hq's identity-preserving hires() off the locked hero so the character never
# drifts. Weak values are passed as a '||'-separated list (the scorecard's weak_cells[].value).
#
#   python make-targeted-batch.py --character <subject> --trigger <word> --hero <hero.png> #       --ident "<look sentence>" --weak "side profile view||screaming wide open mouth" --count 60
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                                    | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Take the hero, identity sentence, trigger word,
#     negative prompt, base checkpoint and dataset directory from the character's own configuration
#     instead of the first character this script ever generated for. The pool glob, the written
#     file stems, the captions, the curated set and the ComfyUI hero input name are all keyed on
#     the subject, so a second character neither reads nor overwrites the first one's dataset.
import argparse, json, os, time, shutil, glob, random, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
from character_config import add_character_arguments, character_config  # noqa: E402
from curation_judge import curate, discover_candidates, load_json, measure_candidates  # noqa: E402

HOME = os.path.expanduser("~")
BASE = "http://127.0.0.1:8188"
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output")
INP = os.path.join(COMFY, "input")
STEPS, SAMP, SCHED, W1, H1 = 30, "dpmpp_2m", "karras", 768, 768
TARGET_CURATED = 120

ACTIONS = ["standing", "running", "jumping high", "sitting cross-legged", "wiggly dancing", "flexing muscles",
           "waving an arm", "pointing forward", "crouching low", "lying on its back", "doing a backflip",
           "tiptoeing sneakily", "shrugging", "arms crossed", "thinking hand on chin", "celebrating arms up",
           "kicking a leg out", "falling over", "marching", "stretching tall"]
CAMERAS = ["front view", "three-quarter view", "side profile view", "low angle looking up", "high angle looking down",
           "extreme close-up of the face", "full body wide shot", "from behind over the shoulder"]
EXPRESS = ["screaming wide open mouth", "angry scowl", "big happy grin", "shocked surprised", "scared trembling",
           "smug smirk", "laughing hard", "sleepy half-closed eye"]
LIGHTS = ["plain grey studio background", "white cyclorama studio", "neon city night background", "standing on coffee beans",
          "dramatic spotlight on dark background", "warm sunny outdoor", "moody rim lighting", "soft even studio light"]


def log(m):
    print(time.strftime("[%H:%M:%S] ") + str(m), flush=True)


def run(wf):
    try:
        pid = json.loads(urllib.request.urlopen(urllib.request.Request(
            BASE + "/prompt", data=json.dumps({"prompt": wf}).encode(),
            headers={"Content-Type": "application/json"}), timeout=180).read())["prompt_id"]
    except Exception as e:
        log("submit err " + repr(e)); return None
    for _ in range(240):
        time.sleep(4)
        try:
            h = json.loads(urllib.request.urlopen(BASE + "/history/" + pid, timeout=30).read())
        except Exception:
            continue
        if pid in h and h[pid].get("outputs"):
            return h[pid]["outputs"]
        if pid in h and h[pid].get("status", {}).get("status_str") == "error":
            return None
    return None


def hires(cfg, src, scene, seed, pfx, den=0.55):
    """Identity-preserving img2img off this character's locked hero, at this character's checkpoint."""
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": cfg.base_model}},
        "img": {"class_type": "LoadImage", "inputs": {"image": src}},
        "enc": {"class_type": "VAEEncode", "inputs": {"pixels": ["img", 0], "vae": ["ck", 2]}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": scene, "clip": ["ck", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": cfg.negative, "clip": ["ck", 1]}},
        "ks1": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": STEPS, "cfg": 7.0, "sampler_name": SAMP, "scheduler": SCHED, "denoise": den, "model": ["ck", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["enc", 0]}},
        "up": {"class_type": "LatentUpscale", "inputs": {"samples": ["ks1", 0], "upscale_method": "nearest-exact", "width": W1, "height": H1, "crop": "disabled"}},
        "ks2": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": STEPS, "cfg": 7.0, "sampler_name": SAMP, "scheduler": SCHED, "denoise": 0.45, "model": ["ck", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["up", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks2", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": pfx}},
    })


def biased_pick(axis_vals, weak):
    """70% of the time pick a weak value for this axis if any of its values are weak, else uniform."""
    weak_here = [v for v in axis_vals if v in weak]
    if weak_here and random.random() < 0.7:
        return random.choice(weak_here)
    return random.choice(axis_vals)


def recurate(cfg, measurements_path=None, overrides_path=None):
    """Even-sample the augmented dataset for DIVERSITY, then JUDGE it before it becomes the
    training set.

    This used to zip the even-sample straight into curated.zip with no judgement at all, which
    made the judge a make-curate-only feature: overnight-loop.py runs make-targeted-batch and then
    trains on ~/overnight/curated.zip, the exact path this function overwrites. So every autonomous
    improve round trained on unjudged data - off-identity, two-eyed and melted frames included -
    while the manual path rejected them. Even sampling is DIVERSITY, never judgement.

    FAIL-CLOSED, matching curation_judge: if the run cannot be measured, it raises rather than
    writing an unjudged training set. overnight-loop.py treats a non-zero exit as "targeted batch
    failed; stopping", which is the correct outcome - a stopped loop beats a loop that trains on
    whatever it rendered.

    @param cfg - This character's resolved configuration (pool, curated set, hero).
    @param measurements_path - Precomputed id -> measurements JSON, skipping the CLIP pass.
    @param overrides_path - Human override JSON; the human always wins, on this path too.
    @returns The number of candidates KEPT, which is the size of the training set.
    """
    os.makedirs(cfg.root, exist_ok=True)
    candidates = discover_candidates(cfg.pool_dir, cfg.pool_glob())
    if not candidates:
        return 0
    step = max(1, len(candidates) // TARGET_CURATED)
    sampled = candidates[::step][:TARGET_CURATED]

    hero_path = cfg.hero_image_path(INP, OUT)
    if measurements_path:
        measurements = load_json(measurements_path)
    elif hero_path:
        measurements = measure_candidates(sampled, hero_path, cfg.structural_prompts())
    else:
        raise SystemExit(
            "REFUSING to recurate unjudged: hero %s not found. Pass --hero or --measurements. "
            "overnight-loop.py trains on this zip, so writing it unjudged would train the next "
            "version on rejects." % cfg.hero
        )

    overrides = load_json(overrides_path) if overrides_path else {}
    zpath = cfg.curated_zip
    # dest_dir is the curated SUBdirectory, never the character root itself: curate() rebuilds its
    # destination from scratch, and the root is this character's whole working directory.
    report = curate(sampled, measurements, cfg.curated_dir, zpath, overrides=overrides)
    s = report["summary"]
    log("recurated -> %s (%d kept of %d sampled, %d rejected, %d overridden)"
        % (zpath, s["kept"], s["candidates"], s["rejected"], s["overridden"]))
    return s["kept"]


def build_parser():
    """
    @description The CLI. Identity comes from the character's own configuration (the controller
      fills it from `oshal_lora_characters`); this file holds no character constant.
    @returns The argparse parser.
    """
    ap = argparse.ArgumentParser(description="Regenerate training images biased to a character's weak cells")
    add_character_arguments(ap)
    ap.add_argument("--weak", default="", help="'||'-separated weak axis-values from the scorecard")
    ap.add_argument("--count", type=int, default=60)
    ap.add_argument("--seed-base", type=int, default=700000)
    # The judge options, mirroring make-curate.py so the two paths are configured the same way.
    ap.add_argument("--measurements", help="precomputed id -> measurements JSON (skips CLIP)")
    ap.add_argument("--overrides", help="human override JSON: id -> {decision, note}")
    return ap


def stage_hero(cfg):
    """
    @description Copy this character's locked hero into ComfyUI's input directory under a name of
      its own. The name is per character: a shared 'hq_hero.png' meant the second character to run
      generated every frame off the FIRST character's face.
    @param cfg - This character's resolved configuration.
    @returns The ComfyUI-visible input filename.
    """
    staged = "hq_hero_%s.png" % cfg.subject
    target = os.path.join(INP, staged)
    if not os.path.exists(target):
        src = os.path.join(INP, cfg.hero)
        src = src if os.path.exists(src) else os.path.join(OUT, cfg.hero)
        if os.path.exists(src):
            shutil.copy(src, target)
    return staged


def generate(cfg, a, weak):
    """
    @description Render the biased batch into this character's own pool directory, captioned with
      its own trigger word.
    @param cfg - This character's resolved configuration.
    @param a - Parsed arguments.
    @param weak - The weak axis-values to over-sample.
    @returns How many images were made.
    """
    staged_hero = stage_hero(cfg)
    # Continue the dataset index past whatever this character already has.
    start = len(glob.glob(os.path.join(cfg.pool_dir, cfg.pool_glob("t"))))
    made = 0
    for k in range(a.count):
        i = start + k
        desc = "%s, %s, %s, %s" % (biased_pick(ACTIONS, weak), biased_pick(CAMERAS, weak),
                                   biased_pick(EXPRESS, weak), random.choice(LIGHTS))
        o = hires(cfg, staged_hero, cfg.prompt(desc), a.seed_base + i, "tgt")
        if not o:
            log("img %d FAILED | %s" % (i, desc)); continue
        stem = cfg.pool_stem("t", i)
        shutil.copy(os.path.join(OUT, o["save"]["images"][0]["filename"]),
                    os.path.join(cfg.pool_dir, stem + ".png"))
        open(os.path.join(cfg.pool_dir, stem + ".txt"), "w").write(cfg.caption(desc))
        made += 1
        log("img %d ok | %s" % (i, desc))
    return made


def main():
    """Generate a weak-cell-biased batch for one character and rebuild its judged training set."""
    a = build_parser().parse_args()
    cfg = character_config(a)
    weak = set(v.strip() for v in a.weak.split("||") if v.strip())
    os.makedirs(cfg.pool_dir, exist_ok=True)
    random.seed(a.seed_base)
    log("targeted batch for %s: %d images biased to weak=%s" % (cfg.subject, a.count, sorted(weak) or "(none)"))
    made = generate(cfg, a, weak)
    n = recurate(cfg, measurements_path=a.measurements, overrides_path=a.overrides)
    log("==== TARGETED BATCH DONE: +%d images, curated set now %d ====" % (made, n))


if __name__ == "__main__":
    main()
