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
import argparse, json, os, time, shutil, glob, zipfile, random, urllib.request

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


def recurate():
    """Even-sample the (now-augmented) dataset to ~TARGET_CURATED and refresh curated.zip."""
    os.makedirs(DEST, exist_ok=True)
    imgs = sorted(glob.glob(os.path.join(DATA, "oshbrainrot_*.png")))
    if not imgs:
        return 0
    step = max(1, len(imgs) // TARGET_CURATED)
    sel = imgs[::step][:TARGET_CURATED]
    zpath = os.path.join(DEST, "curated.zip")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sel:
            base = os.path.splitext(os.path.basename(p))[0]
            txt = os.path.join(DATA, base + ".txt")
            z.write(p, os.path.basename(p))
            if os.path.exists(txt):
                z.write(txt, base + ".txt")
    log("recurated -> %s (%d images)" % (zpath, len(sel)))
    return len(sel)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--character", required=True)
    ap.add_argument("--weak", default="", help="'||'-separated weak axis-values from the scorecard")
    ap.add_argument("--count", type=int, default=60)
    ap.add_argument("--seed-base", type=int, default=700000)
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
    n = recurate()
    log("==== TARGETED BATCH DONE: +%d images, curated set now %d ====" % (made, n))


if __name__ == "__main__":
    main()
