# Box-side LoRA DATASET builder for the locked brainrot character (hero_brainrot_00002 = screaming cyclops).
# img2img off the ONE hero at moderate denoise -> the same creature in varied poses/expressions/crops, which
# is what a character LoRA needs (consistent identity, varied context). Writes images + kohya-style caption
# .txt files to ~/lora-brainrot/img/. Trigger word: oshbrainrot. Log ~/brdata.log
import urllib.request, json, time, os, glob, shutil

HOME = os.path.expanduser("~")
BASE = "http://127.0.0.1:8188"
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output")
INP = os.path.join(COMFY, "input")
DATA = os.path.join(HOME, "lora-brainrot", "img")
LOG = os.path.join(HOME, "brdata.log")
HERO = "hero_brainrot_00002_.png"
# Deterministic regen of the locked hero (same prompt + seed 22 reproduces the screaming cyclops exactly).
HERO_PROMPT = ("an angry muscular cappuccino coffee cup creature with skinny chicken legs, big googly eyes, "
               "tiny white sneakers, surreal funny glossy 3d render, italian brainrot meme style, plain background, full body")
HERO_SEED = 22
W, H = 512, 512
TRIG = "oshbrainrot"
IDENT = "a one-eyed leathery brown screaming cyclops creature, big single eye, wide open mouth, stubby arms and legs, glossy 3d render, italian brainrot meme style"
NEG = "blurry, low quality, deformed, extra eyes, text, watermark, multiple characters"
# (pose/context phrase, denoise, seed) -- caption = "oshbrainrot, <pose phrase>"
VARIANTS = [
    ("standing front view, plain grey background", 0.45, 101),
    ("arms raised up, plain background", 0.55, 102),
    ("running pose, motion", 0.6, 103),
    ("jumping in the air", 0.6, 104),
    ("angry close-up of the face", 0.5, 105),
    ("looking up, mouth open", 0.5, 106),
    ("crouching low", 0.58, 107),
    ("side three-quarter view", 0.6, 108),
    ("waving one arm", 0.55, 109),
    ("standing on a plain white background", 0.5, 110),
    ("full body, small in frame", 0.55, 111),
    ("leaning forward screaming", 0.5, 112),
    ("arms out wide", 0.57, 113),
    ("standing on coffee beans", 0.6, 114),
    ("dramatic low angle", 0.55, 115),
    ("happy smiling expression", 0.52, 116),
    ("walking to the side", 0.58, 117),
    ("surprised expression, wide eye", 0.5, 118),
    ("dancing pose", 0.6, 119),
    ("standing in a spotlight, dark background", 0.55, 120),
]


def log(m):
    with open(LOG, "a") as f:
        f.write(time.strftime("[%H:%M:%S] ") + str(m) + "\n")


def run(wf):
    pid = json.loads(urllib.request.urlopen(urllib.request.Request(BASE + "/prompt", data=json.dumps({"prompt": wf}).encode(), headers={"Content-Type": "application/json"}), timeout=180).read())["prompt_id"]
    for _ in range(120):
        time.sleep(3)
        try:
            h = json.loads(urllib.request.urlopen(BASE + "/history/" + pid, timeout=30).read())
        except Exception:
            continue
        if pid in h and h[pid].get("outputs"):
            return h[pid]["outputs"]
    return None


def txt2img(scene, seed, pfx):
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "v1-5-pruned-emaonly-fp16.safetensors"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": scene, "clip": ["ck", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": NEG, "clip": ["ck", 1]}},
        "lat": {"class_type": "EmptyLatentImage", "inputs": {"width": W, "height": H, "batch_size": 1}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 26, "cfg": 7.5, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["lat", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": pfx}},
    })


def img2img(src, scene, seed, denoise, pfx):
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "v1-5-pruned-emaonly-fp16.safetensors"}},
        "img": {"class_type": "LoadImage", "inputs": {"image": src}},
        "enc": {"class_type": "VAEEncode", "inputs": {"pixels": ["img", 0], "vae": ["ck", 2]}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": scene, "clip": ["ck", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": NEG, "clip": ["ck", 1]}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 26, "cfg": 7.0, "sampler_name": "euler", "scheduler": "normal", "denoise": denoise, "model": ["ck", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["enc", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": pfx}},
    })


def main():
    global HERO
    log("=== brainrot LoRA dataset: %d img2img variants off %s ===" % (len(VARIANTS), HERO))
    if not os.path.exists(os.path.join(OUT, HERO)):
        log("hero missing -> regenerating deterministically (seed %d)" % HERO_SEED)
        o = txt2img(HERO_PROMPT, HERO_SEED, "hero_brainrot")
        if not o:
            log("HERO REGEN FAILED"); return
        # SaveImage may name it hero_brainrot_00001_.png if output was cleared; use whatever it wrote.
        HERO = o["save"]["images"][0]["filename"]
        log("hero regenerated: " + HERO)
    os.makedirs(DATA, exist_ok=True)
    for f in glob.glob(os.path.join(DATA, "*")):
        try: os.remove(f)
        except Exception: pass
    shutil.copy(os.path.join(OUT, HERO), os.path.join(INP, "br_hero.png"))
    n = 0
    for i, (phrase, den, seed) in enumerate(VARIANTS):
        o = img2img("br_hero.png", IDENT + ", " + phrase, seed, den, "brset")
        if not o:
            log("variant %d FAILED" % i); continue
        src = os.path.join(OUT, o["save"]["images"][0]["filename"])
        base = "oshbrainrot_%03d" % i
        shutil.copy(src, os.path.join(DATA, base + ".png"))
        with open(os.path.join(DATA, base + ".txt"), "w") as f:
            f.write("%s, %s" % (TRIG, phrase))      # caption: trigger + variable context only
        n += 1
        log("variant %d ok (%s)" % (i, phrase))
    log("DONE dataset images=%d at %s" % (n, DATA))


main()
