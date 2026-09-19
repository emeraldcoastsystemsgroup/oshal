# Box-side TARGETED batch generator (LoRA Studio P4 - the "gets better" engine). Given the weak
# axis-values from a version's validation scorecard, it regenerates training images BIASED toward
# those weak cells (e.g. if "side profile view" + "screaming" scored low, it makes more of those),
# appends them to the dataset, and refreshes curated.zip. The next training version then learns the
# spots the previous one was weak at - directed active learning, not just "more random data".
#
# Reuses make-overnight-hq's identity-preserving hires() off the locked hero so the character never
# drifts. Weak values are passed as a '||'-separated list (the scorecard's weak_cells[].value).
#
#   python make-targeted-batch.py --character oshbrainrot --weak "side profile view||screaming wide open mouth" --count 60
import argparse, json, os, time, shutil, glob, random, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
from curation_judge import curate, discover_candidates, load_json, measure_candidates  # noqa: E402

HOME = os.path.expanduser("~")
BASE = "http://127.0.0.1:8188"
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output")
INP = os.path.join(COMFY, "input")
DATA = os.path.join(HOME, "lora-brainrot", "img")
DEST = os.path.join(HOME, "overnight")
HERO = "hero_brainrot_00002_.png"
IDENT = "a one-eyed leathery orange-red screaming cyclops creature, big single eye, wide toothy mouth, stubby clawed legs, long thin arms, glossy 3d render, italian brainrot meme style"
QUAL = ", highly detailed, sharp focus, intricate, clean render, best quality"
NEG = "blurry, low quality, deformed, extra eyes, two eyes, text, watermark, multiple characters, jpeg artifacts, lowres"
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


def hires(src, scene, seed, pfx, den=0.55):
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "v1-5-pruned-emaonly-fp16.safetensors"}},
        "img": {"class_type": "LoadImage", "inputs": {"image": src}},
        "enc": {"class_type": "VAEEncode", "inputs": {"pixels": ["img", 0], "vae": ["ck", 2]}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": scene + QUAL, "clip": ["ck", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": NEG, "clip": ["ck", 1]}},
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


def recurate(hero=None, measurements_path=None, overrides_path=None):
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

    @param hero - Locked hero image the identity check measures against.
    @param measurements_path - Precomputed id -> measurements JSON, skipping the CLIP pass.
    @param overrides_path - Human override JSON; the human always wins, on this path too.
    @returns The number of candidates KEPT, which is the size of the training set.
    """
    os.makedirs(DEST, exist_ok=True)
    candidates = discover_candidates(DATA, "oshbrainrot_*.png")
    if not candidates:
        return 0
    step = max(1, len(candidates) // TARGET_CURATED)
    sampled = candidates[::step][:TARGET_CURATED]

    hero_path = hero or os.path.join(INP, HERO)
    if measurements_path:
        measurements = load_json(measurements_path)
    elif os.path.exists(hero_path):
        measurements = measure_candidates(sampled, hero_path)
    else:
        raise SystemExit(
            "REFUSING to recurate unjudged: hero %s not found. Pass --hero or --measurements. "
            "overnight-loop.py trains on this zip, so writing it unjudged would train the next "
            "version on rejects." % hero_path
        )

    overrides = load_json(overrides_path) if overrides_path else {}
    zpath = os.path.join(DEST, "curated.zip")
    # dest_dir is the curated SUBdirectory, never DEST itself: curate() rebuilds its destination
    # from scratch, and DEST is ~/overnight - the loop's own working directory.
    report = curate(sampled, measurements, os.path.join(DEST, "curated"), zpath, overrides=overrides)
    s = report["summary"]
    log("recurated -> %s (%d kept of %d sampled, %d rejected, %d overridden)"
        % (zpath, s["kept"], s["candidates"], s["rejected"], s["overridden"]))
    return s["kept"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--character", required=True)
    ap.add_argument("--weak", default="", help="'||'-separated weak axis-values from the scorecard")
    ap.add_argument("--count", type=int, default=60)
    ap.add_argument("--seed-base", type=int, default=700000)
    # The judge options, mirroring make-curate.py so the two paths are configured the same way.
    ap.add_argument("--hero", help="locked hero image the identity check measures against")
    ap.add_argument("--measurements", help="precomputed id -> measurements JSON (skips CLIP)")
    ap.add_argument("--overrides", help="human override JSON: id -> {decision, note}")
    a = ap.parse_args()
    weak = set(v.strip() for v in a.weak.split("||") if v.strip())
    os.makedirs(DATA, exist_ok=True)
    random.seed(a.seed_base)

    # Ensure the hero is available as a ComfyUI input for img2img identity.
    hero_in = os.path.join(INP, "hq_hero.png")
    if not os.path.exists(hero_in):
        src = os.path.join(INP, HERO)
        src = src if os.path.exists(src) else os.path.join(OUT, HERO)
        if os.path.exists(src):
            shutil.copy(src, hero_in)
    log("targeted batch: %d images biased to weak=%s" % (a.count, sorted(weak) or "(none)"))

    # Continue the dataset index past whatever's already there.
    existing = glob.glob(os.path.join(DATA, "oshbrainrot_t*.png"))
    start = len(existing)
    made = 0
    for k in range(a.count):
        i = start + k
        act = biased_pick(ACTIONS, weak)
        cam = biased_pick(CAMERAS, weak)
        exp = biased_pick(EXPRESS, weak)
        lit = random.choice(LIGHTS)
        desc = "%s, %s, %s, %s" % (act, cam, exp, lit)
        o = hires("hq_hero.png", "%s, %s" % (IDENT, desc), a.seed_base + i, "tgt")
        if not o:
            log("img %d FAILED | %s" % (i, desc)); continue
        src = os.path.join(OUT, o["save"]["images"][0]["filename"])
        shutil.copy(src, os.path.join(DATA, "oshbrainrot_t%04d.png" % i))
        open(os.path.join(DATA, "oshbrainrot_t%04d.txt" % i), "w").write("oshbrainrot, " + desc)
        made += 1
        log("img %d ok | %s" % (i, desc))
    n = recurate(hero=a.hero, measurements_path=a.measurements, overrides_path=a.overrides)
    log("==== TARGETED BATCH DONE: +%d images, curated set now %d ====" % (made, n))


if __name__ == "__main__":
    main()
