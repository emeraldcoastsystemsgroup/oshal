# Box-side HERO CANDIDATE generator for two LoRA characters (pick the look before training).
# For each character it renders 4 seeds at 512x512 so the operator can choose the design to lock in.
# Output PNGs: hero_stick_*.png / hero_brainrot_*.png in ComfyUI/output. Log ~/heroes.log
import urllib.request, json, time, os, glob

HOME = os.path.expanduser("~")
BASE = "http://127.0.0.1:8188"
COMFY = os.path.join(HOME, "oshal-comfyui", "ComfyUI_windows_portable", "ComfyUI")
OUT = os.path.join(COMFY, "output")
LOG = os.path.join(HOME, "heroes.log")
W, H = 512, 512
NEG = "blurry, low quality, deformed, extra limbs, text, watermark, multiple characters, filled body, chibi, 3d render, color, shading, realistic"
CHARACTERS = {
    "stick": "a classic black line-art stick figure, thin black pen lines, round circle head, two dot eyes, "
             "simple smile, stick arms and stick legs, small red headband, plain white background, "
             "minimalist hand-drawn doodle, full body, centered",
}


def log(m):
    with open(LOG, "a") as f:
        f.write(time.strftime("[%H:%M:%S] ") + str(m) + "\n")


def run(wf):
    pid = json.loads(urllib.request.urlopen(urllib.request.Request(BASE + "/prompt", data=json.dumps({"prompt": wf}).encode(), headers={"Content-Type": "application/json"}), timeout=180).read())["prompt_id"]
    for _ in range(150):
        time.sleep(3)
        try:
            h = json.loads(urllib.request.urlopen(BASE + "/history/" + pid, timeout=30).read())
        except Exception:
            continue
        if pid in h and h[pid].get("outputs"):
            return True
    return False


def gen(scene, seed, pfx):
    return run({
        "ck": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "v1-5-pruned-emaonly-fp16.safetensors"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": scene, "clip": ["ck", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": NEG, "clip": ["ck", 1]}},
        "lat": {"class_type": "EmptyLatentImage", "inputs": {"width": W, "height": H, "batch_size": 1}},
        "ks": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 26, "cfg": 7.5, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["ck", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["lat", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ck", 2]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": pfx}},
    })


def main():
    log("=== hero candidates: 4 seeds x 2 characters ===")
    for c in ("stick", "brainrot"):
        for f in glob.glob(os.path.join(OUT, "hero_%s_*.png" % c)):
            try: os.remove(f)
            except Exception: pass
    for name, scene in CHARACTERS.items():
        for i, seed in enumerate((11, 22, 33, 44)):
            ok = gen(scene, seed, "hero_%s" % name)
            log("%s seed %d %s" % (name, seed, "ok" if ok else "FAIL"))
    log("DONE")


main()
