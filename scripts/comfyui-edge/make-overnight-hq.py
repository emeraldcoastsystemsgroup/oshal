# Box-side ALL-NIGHT HIGH-QUALITY generator for the LoRA training pool (the cyclops, FIXED character).
# Goal = best training set, not speed. Each image: hires-fix (512 base -> latent upscale -> refine pass)
# at 768px, dpmpp_2m karras / 30 steps / quality tags, varying action x camera x expression x lighting
# for diversity (what makes a LoRA generalize). Identity is held by img2img off the locked hero.
# Loops until MAX_HOURS, rewriting a curate/accept-reject gallery each cycle. Out ~/overnight/, log ~/overnight.log
import urllib.request, json, time, os, subprocess, glob, shutil
from PIL import Image

HOME = os.path.expanduser("~")
BASE = "http://127.0.0.1:8188"
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output")
INP = os.path.join(COMFY, "input")
DEST = os.path.join(HOME, "overnight")
POOL = os.path.join(DEST, "pool")            # all HQ candidate images for curation
DATA = os.path.join(HOME, "lora-brainrot", "img")
LOG = os.path.join(HOME, "overnight.log")
W0, H0, W1, H1 = 512, 512, 768, 768
STEPS, SAMP, SCHED = 30, "dpmpp_2m", "karras"
MAX_HOURS = 9.0
HERO = "hero_brainrot_00002_.png"
HERO_PROMPT = ("an angry muscular cappuccino coffee cup creature with skinny chicken legs, big googly eyes, "
               "tiny white sneakers, surreal funny glossy 3d render, italian brainrot meme style, plain background, full body")
IDENT = "a one-eyed leathery orange-red screaming cyclops creature, big single eye, wide toothy mouth, stubby clawed legs, long thin arms, glossy 3d render, italian brainrot meme style"
QUAL = ", highly detailed, sharp focus, intricate, clean render, best quality"
NEG = "blurry, low quality, deformed, extra eyes, two eyes, text, watermark, multiple characters, jpeg artifacts, lowres"
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


def txt2img(scene, seed, pfx):
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "v1-5-pruned-emaonly-fp16.safetensors"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": scene, "clip": ["ck", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": NEG, "clip": ["ck", 1]}},
        "lat": {"class_type": "EmptyLatentImage", "inputs": {"width": W0, "height": H0, "batch_size": 1}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 26, "cfg": 7.5, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["lat", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": pfx}},
    })


def ensure_hero():
    if os.path.exists(os.path.join(OUT, HERO)):
        return HERO
    o = txt2img(HERO_PROMPT, 22, "hero_brainrot")
    return o["save"]["images"][0]["filename"] if o else None


def contact_sheet():
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
    cards = []
    for m in meta:
        cards.append("<div class=c><img src='pool/%s' width=240><div class=m>%s<br><i>%s</i></div>"
                     "<div class=v>[ ] keep&nbsp;[ ] reject</div></div>" % (m["f"], m["f"], m["desc"]))
    html = ("<html><head><meta charset=utf-8><title>oshbrainrot HQ pool</title><style>"
            "body{font:13px system-ui;background:#111;color:#eee;margin:18px}.c{display:inline-block;"
            "vertical-align:top;width:252px;margin:6px;background:#1b1b1b;border:1px solid #333;border-radius:8px;padding:6px}"
            ".m{font-size:11px;margin:4px 2px;color:#ccc}.v{font-family:monospace;color:#7c7;font-size:11px}"
            "h1{color:#f86}.lg{background:#1b1b1b;border:1px solid #333;padding:10px;border-radius:8px;margin:8px 0}</style></head><body>"
            "<h1>oshbrainrot - HQ training pool (curate these)</h1><div class=lg>Character is FIXED (the cyclops). "
            "These are hi-res candidates for the LoRA dataset, varied by action / camera / expression / lighting. "
            "Mark the good ones <b>keep</b> and the off-model/ugly ones <b>reject</b>; the kept set trains the LoRA. "
            "Total so far: <b>%d</b>.</div>%s</body></html>" % (len(meta), "".join(cards)))
    open(os.path.join(DEST, "index.html"), "w", encoding="utf-8").write(html)


def main():
    for d in (DEST, POOL, DATA):
        os.makedirs(d, exist_ok=True)
    log("==== ALL-NIGHT HQ POOL START (max %.1fh) ====" % MAX_HOURS)
    hero = ensure_hero()
    if not hero:
        log("hero regen failed; abort"); return
    shutil.copy(os.path.join(OUT, hero), os.path.join(INP, "hq_hero.png"))
    t0 = time.time()
    meta = []
    i = 0
    while (time.time() - t0) < MAX_HOURS * 3600:
        act = ACTIONS[i % len(ACTIONS)]
        cam = CAMERAS[(i // len(ACTIONS)) % len(CAMERAS)]
        exp = EXPRESS[(i // 3) % len(EXPRESS)]
        lit = LIGHTS[(i // 5) % len(LIGHTS)]
        desc = "%s, %s, %s, %s" % (act, cam, exp, lit)
        scene = "%s, %s" % (IDENT, desc)
        o = hires("hq_hero.png", scene, 1000 + i, "hqset", den=0.55)
        if o:
            src = os.path.join(OUT, o["save"]["images"][0]["filename"])
            base = "hq_%04d" % i
            shutil.copy(src, os.path.join(POOL, base + ".png"))         # curation pool
            shutil.copy(src, os.path.join(DATA, "oshbrainrot_h%04d.png" % i))  # straight into dataset
            open(os.path.join(DATA, "oshbrainrot_h%04d.txt" % i), "w").write("oshbrainrot, " + desc)
            meta.append({"f": base + ".png", "desc": desc})
            log("img %d ok | %s" % (i, desc))
        else:
            log("img %d FAILED | %s" % (i, desc))
        i += 1
        if i % 6 == 0:
            contact_sheet(); write_gallery(meta)
    contact_sheet(); write_gallery(meta)
    log("==== HQ POOL DONE: %d images ====" % len(meta))


main()
