# Box-side ALL-NIGHT HIGH-QUALITY generator for one character's LoRA training pool.
# Goal = best training set, not speed. Each image: hires-fix (512 base -> latent upscale -> refine pass)
# at 768px, dpmpp_2m karras / 30 steps / quality tags, varying action x camera x expression x lighting
# for diversity (what makes a LoRA generalize). Identity is held by img2img off the locked hero.
# Loops until --max-hours, rewriting a curate/accept-reject gallery each cycle, into the character's
# own box directory. Log ~/overnight-<subject>.log
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                                    | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Generate for the character named on the command
#     line instead of the one character this script was written for: identity sentence, negative
#     prompt, hero, checkpoint, pool directory, file stems, captions, staged ComfyUI hero and log
#     are all keyed on the subject. A missing hero now refuses instead of regenerating a fixed
#     prompt that described a DIFFERENT creature from the identity sentence below it.
import urllib.request, json, time, os, subprocess, glob, shutil, argparse, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
from character_config import add_character_arguments, character_config  # noqa: E402

HOME = os.path.expanduser("~")
BASE = "http://127.0.0.1:8188"
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output")
INP = os.path.join(COMFY, "input")
W0, H0, W1, H1 = 512, 512, 768, 768
STEPS, SAMP, SCHED = 30, "dpmpp_2m", "karras"
FF = os.path.join(HOME, "ffmpeg", "ffmpeg.exe")
FF = FF if os.path.exists(FF) else "ffmpeg"

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

# Rebound by main() from the parsed character; declared here because the render/report helpers below
# read them. There is deliberately no character-shaped default.
CFG = None
DEST = ""
POOL = ""
LOG = os.path.join(HOME, "overnight.log")


def log(m):
    with open(LOG, "a") as f:
        f.write(time.strftime("[%H:%M:%S] ") + str(m) + "\n")


def run(wf):
    try:
        pid = json.loads(urllib.request.urlopen(urllib.request.Request(BASE + "/prompt", data=json.dumps({"prompt": wf}).encode(), headers={"Content-Type": "application/json"}), timeout=180).read())["prompt_id"]
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


def hires(src, scene, seed, pfx, den=0.5):
    """img2img off `src` (identity) at 512, latent-upscale to 768, refine pass -> detailed HQ image."""
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CFG.base_model}},
        "img": {"class_type": "LoadImage", "inputs": {"image": src}},
        "enc": {"class_type": "VAEEncode", "inputs": {"pixels": ["img", 0], "vae": ["ck", 2]}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": scene, "clip": ["ck", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": CFG.negative, "clip": ["ck", 1]}},
        "ks1": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": STEPS, "cfg": 7.0, "sampler_name": SAMP, "scheduler": SCHED, "denoise": den, "model": ["ck", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["enc", 0]}},
        "up": {"class_type": "LatentUpscale", "inputs": {"samples": ["ks1", 0], "upscale_method": "nearest-exact", "width": W1, "height": H1, "crop": "disabled"}},
        "ks2": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": STEPS, "cfg": 7.0, "sampler_name": SAMP, "scheduler": SCHED, "denoise": 0.45, "model": ["ck", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["up", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks2", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": pfx}},
    })


def txt2img(scene, seed, pfx):
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CFG.base_model}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": scene, "clip": ["ck", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": CFG.negative, "clip": ["ck", 1]}},
        "lat": {"class_type": "EmptyLatentImage", "inputs": {"width": W0, "height": H0, "batch_size": 1}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 26, "cfg": 7.5, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["lat", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": pfx}},
    })


def ensure_hero(cfg, hero_prompt):
    """
    @description Locate this character's locked hero, or mint one from an explicitly supplied
      prompt. There is no default prompt: generating a hero from a sentence that describes some
      other creature is how a pool ends up training the wrong identity.
    @param cfg - This character's resolved configuration.
    @param hero_prompt - Operator-supplied text-to-image prompt, or empty.
    @returns The hero's filename in ComfyUI's output/input, or None.
    """
    if cfg.hero_image_path(INP, OUT):
        return cfg.hero
    if not hero_prompt:
        return None
    o = txt2img(hero_prompt, 22, "hero_" + cfg.subject)
    return o["save"]["images"][0]["filename"] if o else None


def contact_sheet():
    """Rebuild this character's review contact sheet from its own pool."""
    fs = sorted(glob.glob(os.path.join(POOL, "*.png")))
    if not fs:
        return 0
    th, cols = 200, 6
    rows = (len(fs) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * th, rows * th), (24, 24, 24))
    for i, f in enumerate(fs):
        try:
            im = Image.open(f).convert("RGB").resize((th - 4, th - 4))
            sheet.paste(im, ((i % cols) * th + 2, (i // cols) * th + 2))
        except Exception:
            pass
    sheet.save(os.path.join(DEST, "pool-sheet.png"))
    return len(fs)


def write_gallery(meta):
    """Rewrite this character's keep/reject review gallery."""
    cards = []
    for m in meta:
        cards.append("<div class=c><img src='pool/%s' width=240><div class=m>%s<br><i>%s</i></div>"
                     "<div class=v>[ ] keep&nbsp;[ ] reject</div></div>" % (m["f"], m["f"], m["desc"]))
    html = ("<html><head><meta charset=utf-8><title>%s HQ pool</title><style>" % CFG.subject +
            "body{font:13px system-ui;background:#111;color:#eee;margin:18px}.c{display:inline-block;"
            "vertical-align:top;width:252px;margin:6px;background:#1b1b1b;border:1px solid #333;border-radius:8px;padding:6px}"
            ".m{font-size:11px;margin:4px 2px;color:#ccc}.v{font-family:monospace;color:#7c7;font-size:11px}"
            "h1{color:#f86}.lg{background:#1b1b1b;border:1px solid #333;padding:10px;border-radius:8px;margin:8px 0}</style></head><body>"
            "<h1>%s - HQ training pool (curate these)</h1><div class=lg>"
            "Hi-res candidates for this character's LoRA dataset, varied by action / camera / expression / lighting. "
            "Mark the good ones <b>keep</b> and the off-model/ugly ones <b>reject</b>; the kept set trains the LoRA. "
            "Total so far: <b>%d</b>.</div>%s</body></html>" % (CFG.subject, len(meta), "".join(cards)))
    open(os.path.join(DEST, "index.html"), "w", encoding="utf-8").write(html)


def build_parser():
    """
    @description The CLI. The character's identity comes from its `oshal_lora_characters` row.
    @returns The argparse parser.
    """
    ap = argparse.ArgumentParser(description="Build one character's high-quality LoRA training pool")
    add_character_arguments(ap)
    ap.add_argument("--max-hours", type=float, default=9.0)
    ap.add_argument("--hero-prompt", default="", help="text-to-image prompt used ONLY when this character has no hero yet")
    return ap


def generate_pool(cfg, staged_hero, max_hours):
    """
    @description Loop hires-fix renders off this character's staged hero into its own pool and
      dataset, captioned with its own trigger word.
    @param cfg - This character's resolved configuration.
    @param staged_hero - The ComfyUI input filename of the staged hero.
    @param max_hours - Wall-clock budget.
    @returns The gallery metadata rows.
    """
    t0 = time.time()
    meta = []
    i = 0
    while (time.time() - t0) < max_hours * 3600:
        desc = "%s, %s, %s, %s" % (ACTIONS[i % len(ACTIONS)],
                                   CAMERAS[(i // len(ACTIONS)) % len(CAMERAS)],
                                   EXPRESS[(i // 3) % len(EXPRESS)],
                                   LIGHTS[(i // 5) % len(LIGHTS)])
        o = hires(staged_hero, cfg.prompt(desc), 1000 + i, "hqset", den=0.55)
        if o:
            src = os.path.join(OUT, o["save"]["images"][0]["filename"])
            base = "hq_%04d" % i
            shutil.copy(src, os.path.join(POOL, base + ".png"))              # curation pool
            stem = cfg.pool_stem("h", i)
            shutil.copy(src, os.path.join(cfg.pool_dir, stem + ".png"))      # straight into dataset
            open(os.path.join(cfg.pool_dir, stem + ".txt"), "w").write(cfg.caption(desc))
            meta.append({"f": base + ".png", "desc": desc})
            log("img %d ok | %s" % (i, desc))
        else:
            log("img %d FAILED | %s" % (i, desc))
        i += 1
        if i % 6 == 0:
            contact_sheet(); write_gallery(meta)
    return meta


def main():
    """Build one character's HQ training pool inside that character's own box directory."""
    global CFG, DEST, POOL, LOG
    a = build_parser().parse_args()
    CFG = character_config(a)
    DEST = CFG.root
    POOL = os.path.join(CFG.root, "pool")
    LOG = os.path.join(HOME, "overnight-%s.log" % CFG.subject)
    for d in (DEST, POOL, CFG.pool_dir):
        os.makedirs(d, exist_ok=True)
    log("==== ALL-NIGHT HQ POOL START for %s (max %.1fh) ====" % (CFG.subject, a.max_hours))
    hero = ensure_hero(CFG, a.hero_prompt)
    if not hero:
        log("no hero for %s and no --hero-prompt given; abort" % CFG.subject); return
    staged = "hq_hero_%s.png" % CFG.subject
    source = CFG.hero_image_path(INP, OUT) or os.path.join(OUT, hero)
    shutil.copy(source, os.path.join(INP, staged))
    meta = generate_pool(CFG, staged, a.max_hours)
    contact_sheet(); write_gallery(meta)
    log("==== HQ POOL DONE: %d images ====" % len(meta))


if __name__ == "__main__":
    main()
